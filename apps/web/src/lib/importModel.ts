import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { USDZLoader } from "three/examples/jsm/loaders/USDZLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { putAsset, type LocalAsset } from "./db.js";
import { uuidv7 } from "./uuid.js";

/**
 * User model import (docs/06 §5): bring any common 3D file into the sandbox
 * as a first-class, movable object.
 *
 * Every format three ships a loader for is accepted — GLB/GLTF (+.bin,
 * Draco included), OBJ, STL, FBX, USDZ — and whatever arrives is normalized
 * once at import time: transforms resolved, model centred and grounded at
 * y = 0, a unit heuristic applied (a chair exported in millimetres should
 * not arrive 850 m tall), then re-exported to GLB and stored in IndexedDB.
 * One stored format means one render path, and the asset survives reload
 * without keeping the original file around.
 */

export const IMPORT_ACCEPT = ".glb,.gltf,.bin,.obj,.stl,.fbx,.usdz";

/** Past this the sandbox's whole triangle budget (docs/06 §8) is at risk. */
export const REFUSE_TRIANGLES = 500_000;
export const WARN_TRIANGLES = 150_000;

export interface LoadedModel {
  object: THREE.Group;
  /** real-world size after the unit heuristic, meters */
  nativeSize: { w: number; d: number; h: number };
  triangles: number;
  name: string;
  /** e.g. "scaled from centimetres", "very heavy mesh" */
  notes: string[];
}

const ext = (name: string): string => name.slice(name.lastIndexOf(".")).toLowerCase();

let draco: DRACOLoader | null = null;
function withDraco(loader: GLTFLoader): GLTFLoader {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  }
  loader.setDRACOLoader(draco);
  return loader;
}

/**
 * A LoadingManager that resolves relative URIs (a .gltf's .bin, textures)
 * against the sibling files the user selected, instead of the network.
 */
function managerFor(files: File[]): { manager: THREE.LoadingManager; revoke: () => void } {
  const urls = new Map<string, string>();
  for (const file of files) urls.set(file.name.toLowerCase(), URL.createObjectURL(file));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split("/").pop() ?? url).toLowerCase();
    return urls.get(base) ?? url;
  });
  return { manager, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

function countTriangles(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const index = geometry.getIndex();
    triangles += Math.floor((index ? index.count : geometry.getAttribute("position")?.count ?? 0) / 3);
  });
  return triangles;
}

/**
 * Pick the scale that lands the model at a believable real-world size.
 * Preference order: metres as-is, then centimetres, millimetres, inches.
 * When nothing lands in range, normalize the longest side to 1.5 m — the
 * confirm sheet lets the user type the real size either way.
 */
export function unitScaleFor(maxDimension: number): { scale: number; note: string | null } {
  if (!(maxDimension > 0)) return { scale: 1, note: null };
  const candidates: { scale: number; note: string | null }[] = [
    { scale: 1, note: null },
    { scale: 0.01, note: "read as centimetres" },
    { scale: 0.001, note: "read as millimetres" },
    { scale: 0.0254, note: "read as inches" },
  ];
  for (const candidate of candidates) {
    const size = maxDimension * candidate.scale;
    if (size >= 0.05 && size <= 5) return candidate;
  }
  return { scale: 1.5 / maxDimension, note: "scaled to fit a room — check the size" };
}

/** Load user-selected files into a normalized, grounded three group. */
export async function loadModelFiles(files: File[]): Promise<LoadedModel> {
  const primary = files.find((f) => [".glb", ".gltf", ".obj", ".stl", ".fbx", ".usdz"].includes(ext(f.name)));
  if (!primary) {
    throw new Error("Pick a 3D model file — .glb, .gltf, .obj, .stl, .fbx or .usdz.");
  }
  const kind = ext(primary.name);
  const notes: string[] = [];

  const { manager, revoke } = managerFor(files);
  let object: THREE.Object3D;
  try {
    if (kind === ".glb" || kind === ".gltf") {
      const loader = withDraco(new GLTFLoader(manager));
      const data = kind === ".glb" ? await primary.arrayBuffer() : await primary.text();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
        loader.parse(data as ArrayBuffer & string, "", resolve, (e) => reject(asError(e))),
      );
      object = gltf.scene;
    } else if (kind === ".obj") {
      object = new OBJLoader(manager).parse(await primary.text());
      applyDefaultMaterial(object);
    } else if (kind === ".stl") {
      const geometry = new STLLoader(manager).parse(await primary.arrayBuffer());
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, defaultMaterial());
      const group = new THREE.Group();
      group.add(mesh);
      object = group;
    } else if (kind === ".fbx") {
      object = new FBXLoader(manager).parse(await primary.arrayBuffer(), "");
    } else {
      // .usdz — three reads the USDA subset; binary USDC throws and lands in
      // the friendly message below.
      object = new USDZLoader(manager).parse(await primary.arrayBuffer()) as THREE.Group;
    }
  } catch (error) {
    throw new Error(friendlyLoadError(kind, error));
  } finally {
    revoke();
  }

  const triangles = countTriangles(object);
  if (triangles === 0) {
    throw new Error("That file loaded, but there's no visible mesh inside it.");
  }
  if (triangles > REFUSE_TRIANGLES) {
    throw new Error(
      `That model has ${(triangles / 1000).toFixed(0)}k triangles — too heavy for the room (limit ${REFUSE_TRIANGLES / 1000}k). Export a decimated version and try again.`,
    );
  }
  if (triangles > WARN_TRIANGLES) {
    notes.push(`Heavy mesh (${(triangles / 1000).toFixed(0)}k triangles) — the room may slow down on phones.`);
  }

  // Normalize: real-world scale, centred on the floor at the origin.
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error("That file loaded, but its geometry has no size.");
  const rawSize = new THREE.Vector3();
  box.getSize(rawSize);
  const { scale, note } = unitScaleFor(Math.max(rawSize.x, rawSize.y, rawSize.z));
  if (note) notes.push(`Its coordinates were ${note}.`);

  const wrapper = new THREE.Group();
  wrapper.add(object);
  object.position.set(
    -((box.min.x + box.max.x) / 2),
    -box.min.y,
    -((box.min.z + box.max.z) / 2),
  );
  wrapper.scale.setScalar(scale);
  wrapper.updateWorldMatrix(true, true);

  const nativeSize = {
    w: Math.max(0.01, rawSize.x * scale),
    d: Math.max(0.01, rawSize.z * scale),
    h: Math.max(0.01, rawSize.y * scale),
  };

  const name = primary.name.replace(/\.[^.]+$/, "");
  return { object: wrapper, nativeSize, triangles, name, notes };
}

/** Re-export the normalized model to GLB and store it for this project. */
export async function storeModel(model: LoadedModel, projectId: string, size?: LoadedModel["nativeSize"]): Promise<LocalAsset> {
  const finalSize = size ?? model.nativeSize;
  // A user-corrected size is baked into the geometry, so the stored GLB's
  // real-world dimensions always equal the asset's recorded nativeSize — the
  // renderer's `object.size / nativeSize` scaling depends on that.
  if (finalSize !== model.nativeSize && model.nativeSize.h > 0) {
    model.object.scale.multiplyScalar(finalSize.h / model.nativeSize.h);
    model.object.updateWorldMatrix(true, true);
  }
  const exporter = new GLTFExporter();
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      model.object,
      (result) => resolve(result as ArrayBuffer),
      (error) => reject(asError(error)),
      { binary: true },
    );
  });
  const asset: LocalAsset = {
    id: uuidv7(),
    projectId,
    name: model.name,
    blob: new Blob([glb], { type: "model/gltf-binary" }),
    nativeSize: finalSize,
    triangles: model.triangles,
    createdAt: new Date().toISOString(),
  };
  await putAsset(asset);
  return asset;
}

function defaultMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xb8bdc7, roughness: 0.8, metalness: 0.05 });
}

function applyDefaultMaterial(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.Material | THREE.Material[];
    const isBasic = (m: THREE.Material) => (m as THREE.MeshBasicMaterial).isMeshBasicMaterial;
    if (Array.isArray(material) ? material.every(isBasic) : isBasic(material)) {
      mesh.material = defaultMaterial();
    }
  });
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function friendlyLoadError(kind: string, error: unknown): string {
  const detail = asError(error).message;
  if (kind === ".usdz" && /crate|usdc/i.test(detail)) {
    return "That USDZ holds binary USD, which can't be read on the device — export the model as GLB or OBJ instead.";
  }
  return `We couldn't read that ${kind} file (${detail}).`;
}
