import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { USDZLoader } from "three/examples/jsm/loaders/USDZLoader.js";
import { unzipSync, strFromU8 } from "three/examples/jsm/libs/fflate.module.js";
import { decodeScanMesh, parseLas, sniffScanFormat, type ScanFormat } from "@myroom/recon";

/**
 * Decode any accepted scan file into geometry the recon parsers can read
 * (docs/05 §2) — on the device, offline.
 *
 * packages/recon's decodeScanMesh stays dependency-free (it runs in Node and
 * in tests); this module is the web-side front door that adds what needs a
 * browser or three.js:
 *
 *  - **Draco GLB** — Scaniverse and Polycam compress their GLB exports by
 *    default. The decoder WASM is vendored at public/draco/ (the catalog
 *    models already use it), so refusing Draco here was refusing real scans
 *    for a constraint that had already been solved.
 *  - **USDZ** — unzipped with the fflate build three ships. A RoomPlan `.json`
 *    inside is the gold input; a USDA-based USDZ parses via three's
 *    USDZLoader; an embedded GLB/PLY is decoded like a bare one. Binary USDC
 *    with none of those gets an honest, actionable message.
 *  - **LAS** — parsed by packages/recon/las.ts; LAZ is declined with the
 *    export switch to flip.
 *  - **Point-cloud PLY / GLB** — no longer an error: geometry with no faces
 *    routes to the point-cloud parser instead of being told to re-export.
 */

export type ScanGeometry =
  | { kind: "mesh"; format: ScanFormat; positions: Float32Array; indices: Uint32Array }
  | { kind: "points"; format: ScanFormat; positions: Float32Array }
  | { kind: "roomplan-json"; text: string }
  | { kind: "error"; format: ScanFormat | null; reason: string };

/** Triangle count below which geometry is treated as a point cloud. */
const MIN_MESH_INDICES = 300;

let dracoLoader: DRACOLoader | null = null;

function gltfLoader(): GLTFLoader {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  }
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  return loader;
}

/** Flatten every mesh in a three scene into world-space positions + indices. */
function flattenObject(root: THREE.Object3D): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const attr = geometry.getAttribute("position");
    if (!attr) return;
    const base = positions.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < attr.count; i++) indices.push(base + i);
    }
  });
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function meshOrPoints(format: ScanFormat, positions: Float32Array, indices: Uint32Array): ScanGeometry {
  if (positions.length < 9) {
    return { kind: "error", format, reason: "that scan has no geometry in it" };
  }
  return indices.length >= MIN_MESH_INDICES
    ? { kind: "mesh", format, positions, indices }
    : { kind: "points", format, positions };
}

async function decodeGlbWithThree(bytes: Uint8Array): Promise<ScanGeometry> {
  const buffer = bytes.slice().buffer;
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    gltfLoader().parse(buffer, "", resolve, (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  const { positions, indices } = flattenObject(gltf.scene);
  return meshOrPoints("glb", positions, indices);
}

function glbNeedsDraco(bytes: Uint8Array): boolean {
  // Peek at the JSON chunk for extensionsRequired without a full parse.
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) return false;
    const length = view.getUint32(12, true);
    const type = view.getUint32(16, true);
    if (type !== 0x4e4f534a) return false; // first chunk should be JSON
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as {
      extensionsRequired?: string[];
    };
    return (json.extensionsRequired ?? []).includes("KHR_draco_mesh_compression");
  } catch {
    return false;
  }
}

function looksLikeRoomPlanJson(text: string): boolean {
  try {
    const doc = JSON.parse(text) as { walls?: unknown };
    return typeof doc === "object" && doc !== null && Array.isArray(doc.walls);
  } catch {
    return false;
  }
}

async function decodeUsdz(bytes: Uint8Array): Promise<ScanGeometry> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { kind: "error", format: "usdz", reason: "that USDZ couldn't be opened — export the scan as GLB or PLY instead" };
  }

  // 1. A RoomPlan JSON inside the archive is the best input we can get.
  for (const [name, data] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const text = strFromU8(data);
    if (looksLikeRoomPlanJson(text)) return { kind: "roomplan-json", text };
  }

  // 2. Some apps pack a mesh alongside the USD.
  for (const [name, data] of Object.entries(entries)) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".glb")) return decodeGlbWithThree(data);
    if (lower.endsWith(".ply")) {
      const decoded = decodeScanMesh(data, "ply");
      if (decoded.ok) return meshOrPoints("usdz", decoded.positions, decoded.indices);
    }
  }

  // 3. An ASCII USDA parses with three's USDZLoader. (Binary USDC — what
  //    RoomPlan itself exports — has no JS parser; that's what the message
  //    below is for.)
  try {
    const group = new USDZLoader().parse(bytes.slice().buffer) as THREE.Group;
    const { positions, indices } = flattenObject(group);
    if (positions.length >= 9) return meshOrPoints("usdz", positions, indices);
  } catch {
    // fall through to the honest message
  }

  return {
    kind: "error",
    format: "usdz",
    reason:
      "we can't read the binary USD inside that archive on the device — export the scan as GLB or PLY (both keep the room's shape), or attach the RoomPlan .json",
  };
}

/** Decode a scan file into parser-ready geometry. Never throws. */
export async function decodeScanFile(blob: Blob): Promise<ScanGeometry> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const format = sniffScanFormat(bytes.subarray(0, 64));

  try {
    switch (format) {
      case "roomplan-json":
        return { kind: "roomplan-json", text: new TextDecoder().decode(bytes) };
      case "glb": {
        if (glbNeedsDraco(bytes)) return await decodeGlbWithThree(bytes);
        const decoded = decodeScanMesh(bytes, "glb");
        if (!decoded.ok) return { kind: "error", format, reason: decoded.reason };
        return meshOrPoints(format, decoded.positions, decoded.indices);
      }
      case "ply": {
        const decoded = decodeScanMesh(bytes, "ply");
        if (!decoded.ok) return { kind: "error", format, reason: decoded.reason };
        return meshOrPoints(format, decoded.positions, decoded.indices);
      }
      case "las": {
        const result = parseLas(bytes);
        if (!result.ok) return { kind: "error", format, reason: result.reason };
        return { kind: "points", format, positions: result.positions };
      }
      case "usdz":
        return await decodeUsdz(bytes);
      case "e57":
        return {
          kind: "error",
          format,
          reason: "E57 can't be read on the device — export the scan as PLY or LAS and we'll measure the room from it",
        };
      default:
        return { kind: "error", format: null, reason: "that file doesn't look like a 3D scan inside" };
    }
  } catch (error) {
    return { kind: "error", format, reason: (error as Error).message };
  }
}
