/**
 * Decode a scan file into the triangles `parseMeshScan` reads (docs/05 §2).
 *
 * Dependency-free on purpose. The obvious alternative is three.js's GLTFLoader
 * plus DRACOLoader, but DRACOLoader fetches its WASM decoder from a CDN at
 * runtime, which breaks the offline-first promise (docs/03 §6) and would not
 * survive the service worker's precache. Everything here is a few hundred lines
 * of container parsing over an ArrayBuffer, runs in a worker, and is testable
 * in Node against a real scanner export.
 *
 * Two formats, because Scaniverse offers both and they trade off differently:
 *
 *   GLB  — carries triangles, so `parseMeshScan` can weight facets by AREA.
 *          That is what stops a shelf of toys (thousands of tiny triangles)
 *          outvoting a wall (a few big ones). Preferred.
 *   PLY  — a point cloud, so there are no faces and no area weighting. Still
 *          gives the height histogram and floor occupancy, which is most of
 *          what Stage 0 needs. A reliable fallback with no container to get
 *          wrong.
 *
 * FBX, OBJ and STL are deliberately unsupported: they are not in
 * SCAN_EXTENSIONS, and FBX in particular is a proprietary binary format whose
 * parser would dwarf this file.
 */

export interface DecodedMesh {
  positions: Float32Array;
  /** Empty when the source had no faces (a point cloud). */
  indices: Uint32Array;
}

export interface DecodeFailure {
  ok: false;
  /** Shown to the user, so it must say what to do next. */
  reason: string;
}

export type DecodeResult = ({ ok: true } & DecodedMesh) | DecodeFailure;

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** glTF accessor component types → typed-array constructors. */
const COMPONENT = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

const COMPONENT_COUNT: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

function readAccessor(
  json: Record<string, unknown>,
  bin: Uint8Array,
  index: number,
): Float64Array | null {
  const accessors = json.accessors as Record<string, unknown>[] | undefined;
  const views = json.bufferViews as Record<string, unknown>[] | undefined;
  const accessor = accessors?.[index];
  if (!accessor) return null;

  const Ctor = COMPONENT[accessor.componentType as keyof typeof COMPONENT];
  const per = COMPONENT_COUNT[String(accessor.type)] ?? 0;
  const count = Number(accessor.count ?? 0);
  if (!Ctor || per === 0 || count === 0) return null;

  const view = views?.[Number(accessor.bufferView ?? -1)];
  if (!view) return null;

  const viewOffset = Number(view.byteOffset ?? 0);
  const accessorOffset = Number(accessor.byteOffset ?? 0);
  const start = viewOffset + accessorOffset;
  const stride = Number(view.byteStride ?? 0);
  const elementBytes = Ctor.BYTES_PER_ELEMENT;

  const out = new Float64Array(count * per);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const readOne = (offset: number): number => {
    switch (Ctor) {
      case Float32Array:
        return dv.getFloat32(offset, true);
      case Uint32Array:
        return dv.getUint32(offset, true);
      case Uint16Array:
        return dv.getUint16(offset, true);
      case Int16Array:
        return dv.getInt16(offset, true);
      case Uint8Array:
        return dv.getUint8(offset);
      default:
        return dv.getInt8(offset);
    }
  };

  for (let i = 0; i < count; i++) {
    // A non-zero byteStride means the attribute is interleaved with others.
    const base = start + (stride > 0 ? i * stride : i * per * elementBytes);
    for (let c = 0; c < per; c++) {
      const at = base + c * elementBytes;
      if (at + elementBytes > bin.byteLength) return null;
      out[i * per + c] = readOne(at);
    }
  }
  return out;
}

/** Compose a node's local transform: matrix, or TRS. Returns a 4×4 row-major. */
function nodeMatrix(node: Record<string, unknown>): number[] {
  const m = node.matrix as number[] | undefined;
  if (Array.isArray(m) && m.length === 16) {
    // glTF matrices are column-major; transpose into row-major for readability.
    return [
      m[0]!, m[4]!, m[8]!, m[12]!,
      m[1]!, m[5]!, m[9]!, m[13]!,
      m[2]!, m[6]!, m[10]!, m[14]!,
      m[3]!, m[7]!, m[11]!, m[15]!,
    ];
  }
  const t = (node.translation as number[] | undefined) ?? [0, 0, 0];
  const r = (node.rotation as number[] | undefined) ?? [0, 0, 0, 1];
  const s = (node.scale as number[] | undefined) ?? [1, 1, 1];
  const [x, y, z, w] = r as [number, number, number, number];
  const rot = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  return [
    rot[0]! * s[0]!, rot[1]! * s[1]!, rot[2]! * s[2]!, t[0]!,
    rot[3]! * s[0]!, rot[4]! * s[1]!, rot[5]! * s[2]!, t[1]!,
    rot[6]! * s[0]!, rot[7]! * s[1]!, rot[8]! * s[2]!, t[2]!,
    0, 0, 0, 1,
  ];
}

const multiply = (a: number[], b: number[]): number[] => {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k]! * b[k * 4 + c]!;
      out[r * 4 + c] = sum;
    }
  }
  return out;
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Decode a binary glTF into world-space triangles.
 *
 * Node transforms are applied, because a scanner is free to export its room
 * under a scaled or rotated node and every measurement downstream is in metres.
 */
export function decodeGlb(bytes: Uint8Array): DecodeResult {
  if (bytes.byteLength < 20) return { ok: false, reason: "that file is too small to be a scan" };
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (head.getUint32(0, true) !== GLB_MAGIC) {
    return { ok: false, reason: "that doesn't look like a GLB file" };
  }

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const length = head.getUint32(offset, true);
    const type = head.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) break;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length)));
    } else if (type === CHUNK_BIN) {
      bin = bytes.subarray(start, start + length);
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) return { ok: false, reason: "that GLB has no scene description in it" };

  const used = (json.extensionsRequired as string[] | undefined) ?? [];
  if (used.includes("KHR_draco_mesh_compression")) {
    // Decoding Draco needs a WASM module we deliberately do not ship (see the
    // module docstring). Say what to do instead rather than failing blankly.
    return {
      ok: false,
      reason: "that GLB is Draco-compressed — export it as PLY instead, or turn compression off",
    };
  }
  if (!bin) return { ok: false, reason: "that GLB has no geometry data in it" };

  const meshes = (json.meshes as Record<string, unknown>[] | undefined) ?? [];
  const nodes = (json.nodes as Record<string, unknown>[] | undefined) ?? [];

  const positions: number[] = [];
  const indices: number[] = [];

  const emit = (meshIndex: number, world: number[]) => {
    const mesh = meshes[meshIndex];
    if (!mesh) return;
    for (const primitive of (mesh.primitives as Record<string, unknown>[] | undefined) ?? []) {
      // Mode 4 is TRIANGLES; anything else is not a surface we can measure.
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      const attributes = primitive.attributes as Record<string, number> | undefined;
      if (attributes?.POSITION === undefined) continue;
      const pos = readAccessor(json!, bin!, attributes.POSITION);
      if (!pos) continue;

      const base = positions.length / 3;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i]!;
        const y = pos[i + 1]!;
        const z = pos[i + 2]!;
        positions.push(
          world[0]! * x + world[1]! * y + world[2]! * z + world[3]!,
          world[4]! * x + world[5]! * y + world[6]! * z + world[7]!,
          world[8]! * x + world[9]! * y + world[10]! * z + world[11]!,
        );
      }

      if (primitive.indices !== undefined) {
        const idx = readAccessor(json!, bin!, Number(primitive.indices));
        if (idx) for (const v of idx) indices.push(base + v);
      } else {
        const count = pos.length / 3;
        for (let i = 0; i < count; i++) indices.push(base + i);
      }
    }
  };

  const walk = (nodeIndex: number, parent: number[]) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emit(Number(node.mesh), world);
    for (const child of (node.children as number[] | undefined) ?? []) walk(child, world);
  };

  const scenes = (json.scenes as Record<string, unknown>[] | undefined) ?? [];
  const scene = scenes[Number(json.scene ?? 0)];
  const roots = (scene?.nodes as number[] | undefined) ?? nodes.map((_, i) => i);
  for (const root of roots) walk(root, IDENTITY);

  if (positions.length === 0) {
    return { ok: false, reason: "we couldn't find any surfaces in that scan" };
  }
  return { ok: true, positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Decode a PLY point cloud or mesh.
 *
 * Handles `binary_little_endian` and `ascii`. Scaniverse exports a point cloud,
 * so `indices` usually comes back empty — the height histogram and the floor
 * occupancy grid work on points, only the area weighting is lost.
 */
export function decodePly(bytes: Uint8Array): DecodeResult {
  const headerText = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 65536)),
  );
  const endIndex = headerText.indexOf("end_header");
  if (!headerText.startsWith("ply") || endIndex === -1) {
    return { ok: false, reason: "that doesn't look like a PLY file" };
  }
  const headerEnd = headerText.indexOf("\n", endIndex) + 1;
  const lines = headerText.slice(0, endIndex).split(/\r?\n/);

  let format: "ascii" | "binary_little_endian" | null = null;
  interface Prop {
    type: string;
    name: string;
  }
  const elements: { name: string; count: number; props: Prop[]; listProp?: { countType: string; itemType: string } }[] = [];

  for (const raw of lines) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] === "format") {
      if (parts[1] === "ascii") format = "ascii";
      else if (parts[1] === "binary_little_endian") format = "binary_little_endian";
      else return { ok: false, reason: `that PLY uses ${parts[1]}, which we can't read` };
    } else if (parts[0] === "element") {
      elements.push({ name: parts[1]!, count: Number(parts[2]), props: [] });
    } else if (parts[0] === "property" && elements.length > 0) {
      const element = elements[elements.length - 1]!;
      if (parts[1] === "list") {
        element.listProp = { countType: parts[2]!, itemType: parts[3]! };
      } else {
        element.props.push({ type: parts[1]!, name: parts[2]! });
      }
    }
  }
  if (!format) return { ok: false, reason: "that PLY doesn't say what format it is" };

  const vertexElement = elements.find((e) => e.name === "vertex");
  if (!vertexElement) return { ok: false, reason: "that PLY has no vertices in it" };

  const SIZES: Record<string, number> = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
    double: 8, float64: 8,
  };
  const positions = new Float32Array(vertexElement.count * 3);
  const indices: number[] = [];

  if (format === "ascii") {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd)).split(/\r?\n/);
    const xi = vertexElement.props.findIndex((p) => p.name === "x");
    let line = 0;
    for (let i = 0; i < vertexElement.count && line < body.length; i++, line++) {
      const values = body[line]!.trim().split(/\s+/).map(Number);
      positions[i * 3] = values[xi]!;
      positions[i * 3 + 1] = values[xi + 1]!;
      positions[i * 3 + 2] = values[xi + 2]!;
    }
    const faceElement = elements.find((e) => e.name === "face");
    if (faceElement) {
      for (let f = 0; f < faceElement.count && line < body.length; f++, line++) {
        const values = body[line]!.trim().split(/\s+/).map(Number);
        for (let k = 2; k + 1 < values.length; k++) {
          indices.push(values[1]!, values[k]!, values[k + 1]!);
        }
      }
    }
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read = (type: string, at: number): number => {
      switch (type) {
        case "float": case "float32": return dv.getFloat32(at, true);
        case "double": case "float64": return dv.getFloat64(at, true);
        case "int": case "int32": return dv.getInt32(at, true);
        case "uint": case "uint32": return dv.getUint32(at, true);
        case "short": case "int16": return dv.getInt16(at, true);
        case "ushort": case "uint16": return dv.getUint16(at, true);
        case "char": case "int8": return dv.getInt8(at);
        default: return dv.getUint8(at);
      }
    };
    const rowBytes = vertexElement.props.reduce((sum, p) => sum + (SIZES[p.type] ?? 0), 0);
    const offsets: Record<string, { at: number; type: string }> = {};
    let running = 0;
    for (const p of vertexElement.props) {
      offsets[p.name] = { at: running, type: p.type };
      running += SIZES[p.type] ?? 0;
    }
    if (!offsets.x || !offsets.y || !offsets.z) {
      return { ok: false, reason: "that PLY's vertices have no x/y/z in them" };
    }
    for (let i = 0; i < vertexElement.count; i++) {
      const row = headerEnd + i * rowBytes;
      if (row + rowBytes > bytes.byteLength) break;
      positions[i * 3] = read(offsets.x.type, row + offsets.x.at);
      positions[i * 3 + 1] = read(offsets.y.type, row + offsets.y.at);
      positions[i * 3 + 2] = read(offsets.z.type, row + offsets.z.at);
    }
    // Faces, when present, follow the vertex block.
    const faceElement = elements.find((e) => e.name === "face");
    if (faceElement?.listProp) {
      let at = headerEnd + vertexElement.count * rowBytes;
      const countBytes = SIZES[faceElement.listProp.countType] ?? 1;
      const itemBytes = SIZES[faceElement.listProp.itemType] ?? 4;
      for (let f = 0; f < faceElement.count; f++) {
        if (at + countBytes > bytes.byteLength) break;
        const n = read(faceElement.listProp.countType, at);
        at += countBytes;
        const corners: number[] = [];
        for (let k = 0; k < n; k++) {
          if (at + itemBytes > bytes.byteLength) break;
          corners.push(read(faceElement.listProp.itemType, at));
          at += itemBytes;
        }
        for (let k = 1; k + 1 < corners.length; k++) {
          indices.push(corners[0]!, corners[k]!, corners[k + 1]!);
        }
      }
    }
  }

  return { ok: true, positions, indices: new Uint32Array(indices) };
}

/** Decode by sniffed format, so callers do not branch on file extensions. */
export function decodeScanMesh(bytes: Uint8Array, format: "glb" | "ply"): DecodeResult {
  return format === "glb" ? decodeGlb(bytes) : decodePly(bytes);
}
