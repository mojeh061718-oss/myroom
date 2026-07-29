import type { ScanParse } from "@myroom/schema";

/**
 * Client-side scan sniffing and RoomPlan parsing (docs/01 §7).
 *
 * The S5 upload screen validates the file and draws a parsed preview *before*
 * anything is uploaded — "a parsed preview (point-cloud silhouette over the
 * drawn plan) confirms the scan matches the room before processing". That has
 * to happen on the device, in front of the user, which is why a RoomPlan parser
 * exists here as well as in the worker: the worker's parse is authoritative and
 * feeds the pipeline; this one exists to answer "is this the right room?" in
 * the moment, offline.
 */

export type ScanFormat = ScanParse["format"];

const MAGIC: [number[], ScanFormat | "zip"][] = [
  [[0x70, 0x6c, 0x79], "ply"], // "ply"
  [[0x67, 0x6c, 0x54, 0x46], "glb"], // "glTF"
  [[0x41, 0x53, 0x54, 0x4d, 0x2d, 0x45, 0x35, 0x37], "e57"], // "ASTM-E57"
  [[0x4c, 0x41, 0x53, 0x46], "las"], // "LASF"
  [[0x50, 0x4b, 0x03, 0x04], "zip"], // .usdz is an uncompressed zip
];

export const SCAN_EXTENSIONS = [".usdz", ".json", ".ply", ".glb", ".e57", ".las", ".laz"] as const;
export const MAX_SCAN_BYTES = 500 * 1024 * 1024;

/** What the bytes actually are, independent of what the file is called. */
export function sniffScanFormat(bytes: Uint8Array): ScanFormat | null {
  for (const [signature, format] of MAGIC) {
    if (signature.every((b, i) => bytes[i] === b)) {
      return format === "zip" ? "usdz" : format;
    }
  }
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i]!)) i++;
  if (bytes[i] === 0x7b) return "roomplan-json";
  return null;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export interface ScanCheck {
  ok: boolean;
  format: ScanFormat | null;
  reason: string | null;
}

export function checkScanFile(filename: string, size: number, head: Uint8Array): ScanCheck {
  const ext = extensionOf(filename);
  if (!(SCAN_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      ok: false,
      format: null,
      reason: `We can read .usdz, .json, .ply, .glb, .e57 and .las scans — not ${ext || "that file"}.`,
    };
  }
  if (size > MAX_SCAN_BYTES) {
    return { ok: false, format: null, reason: `That scan is ${(size / 1024 / 1024).toFixed(0)} MB; the limit is 500 MB.` };
  }
  const format = sniffScanFormat(head);
  if (!format) {
    return { ok: false, format: null, reason: "That file doesn't look like a 3D scan inside." };
  }
  return { ok: true, format, reason: null };
}

/**
 * RoomPlan's object classes → our taxonomy ids. An unmapped class keeps its
 * box but no name: "something this size is here" is true, and a guessed
 * category would not be. Mirrors `CATEGORY_MAP` in the worker's roomplan.py.
 */
export const ROOMPLAN_CATEGORIES: Record<string, string> = {
  bathtub: "bathtub",
  bed: "bed",
  chair: "dining-chair",
  dishwasher: "dishwasher",
  fireplace: "fireplace",
  oven: "oven",
  refrigerator: "refrigerator",
  sink: "kitchen-sink",
  sofa: "sofa",
  storage: "cabinet",
  stove: "range",
  table: "dining-table",
  television: "tv",
  toilet: "toilet",
  washerDryer: "washing-machine",
};

export interface ScanSeedObject {
  /** null when RoomPlan named a class we don't have a category for */
  category: string | null;
  /** world metres, Y-up; y is the box's base */
  position: { x: number; y: number; z: number };
  rotationY: number;
  size: { w: number; d: number; h: number };
}

export interface RoomPlanPreview {
  /** wall segments in plan coordinates, metres */
  walls: { start: [number, number]; end: [number, number] }[];
  ceilingHeight: number | null;
  objectCount: number;
  /** the furniture the scan itself found, already metric and categorized */
  objects: ScanSeedObject[];
}

/**
 * Parse an Apple RoomPlan `CapturedRoom` JSON export into plan-space walls.
 * RoomPlan is Y-up metres; our plan frame is `(x, −z)`.
 */
export function parseRoomPlanJson(text: string): RoomPlanPreview | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const walls = (doc as { walls?: unknown }).walls;
  if (!Array.isArray(walls)) return null;

  const out: RoomPlanPreview = { walls: [], ceilingHeight: null, objectCount: 0, objects: [] };
  let tallest = 0;

  for (const wall of walls) {
    if (typeof wall !== "object" || wall === null) continue;
    const matrix = flat16((wall as { transform?: unknown }).transform);
    const dims = flat3((wall as { dimensions?: unknown }).dimensions);
    if (!matrix || !dims) continue;
    const [width, height] = [dims[0]!, dims[1]!];
    if (width <= 0) continue;
    // Column-major simd_float4x4: column 0 is the local +X axis, column 3 the
    // translation.
    const alongX = matrix[0]!;
    const alongZ = matrix[2]!;
    const length = Math.hypot(alongX, alongZ);
    if (length < 1e-9) continue;
    const cx = matrix[12]!;
    const cz = matrix[14]!;
    const halfX = (alongX / length) * (width / 2);
    const halfZ = (alongZ / length) * (width / 2);
    out.walls.push({
      start: [cx - halfX, -(cz - halfZ)],
      end: [cx + halfX, -(cz + halfZ)],
    });
    tallest = Math.max(tallest, height);
  }

  const objects = (doc as { objects?: unknown }).objects;
  out.objectCount = Array.isArray(objects) ? objects.length : 0;
  for (const object of Array.isArray(objects) ? objects : []) {
    if (typeof object !== "object" || object === null) continue;
    const matrix = flat16((object as { transform?: unknown }).transform);
    const dims = flat3((object as { dimensions?: unknown }).dimensions);
    if (!matrix || !dims) continue;
    const [w, h, d] = [dims[0]!, dims[1]!, dims[2]!];
    if (w <= 0 || h <= 0 || d <= 0) continue;
    let raw = (object as { category?: unknown }).category;
    // Some exporters wrap the enum: {"storage": {…}}.
    if (raw && typeof raw === "object") raw = Object.keys(raw as object)[0];
    out.objects.push({
      category: ROOMPLAN_CATEGORIES[String(raw)] ?? null,
      // RoomPlan reports the box centre; our objects sit on their base.
      position: { x: matrix[12]!, y: matrix[13]! - h / 2, z: matrix[14]! },
      // Yaw comes off column 2 (the object's local +Z), not column 0. For a
      // rotation of θ about Y, column 0 is (cos θ, 0, −sin θ) and column 2 is
      // (sin θ, 0, cos θ), so atan2(m[0], m[2]) returns θ + π/2 — every scanned
      // object arrived a quarter-turn out, and the near-wall snap in
      // assemble.ts then treated its width as its depth. Walls above read
      // column 0 deliberately: a wall's length runs along its own local +X.
      rotationY: Math.atan2(matrix[8]!, matrix[10]!),
      size: { w, d, h },
    });
  }
  out.ceilingHeight = tallest > 0 ? tallest : null;
  return out.walls.length > 0 ? out : null;
}

function flat16(raw: unknown): number[] | null {
  const values = flatten(raw);
  return values && values.length === 16 ? values : null;
}

function flat3(raw: unknown): number[] | null {
  const values = flatten(raw);
  return values && values.length >= 3 ? values : null;
}

function flatten(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry)) out.push(...entry.map(Number));
    else out.push(Number(entry));
  }
  return out.every((n) => Number.isFinite(n)) ? out : null;
}
