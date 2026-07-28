import { getCategory } from "@myroom/catalog";
import type { MeasuredObject } from "@myroom/schema";
import type { ScanSeedObject } from "./scan.js";

/**
 * Seed-box fusion (docs/05 §5): "Merge with LiDAR seed boxes when present
 * (LiDAR box wins size; photo wins category/appearance)."
 *
 * A scan that also names its objects — a RoomPlan export does — can furnish a
 * room on its own, with no vision tier at all. That is not a fallback: it is
 * measured data about the user's actual room, and it is *better* than anything
 * a photo-only pipeline would produce.
 */

/** How far apart two boxes can be and still describe the same object. */
export const FUSE_RADIUS_M = 0.6;

export interface FuseOptions {
  newId: () => string;
  /** confidence attached to objects the scan found but no photo did */
  scanConfidence?: number;
}

export interface FuseResult {
  measured: MeasuredObject[];
  /** how many photo-measured objects took the scan's geometry */
  corrected: number;
  /** how many objects came from the scan alone */
  added: number;
}

const footprintDistance = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

export function fuseSeedBoxes(
  measured: readonly MeasuredObject[],
  seeds: readonly ScanSeedObject[],
  options: FuseOptions,
): FuseResult {
  const scanConfidence = options.scanConfidence ?? 0.9;
  const out = measured.map((m) => ({ ...m, size: { ...m.size }, position: { ...m.position } }));
  const claimed = new Set<number>();
  let corrected = 0;

  for (const object of out) {
    let best: { index: number; distance: number } | null = null;
    seeds.forEach((seed, index) => {
      if (claimed.has(index)) return;
      // A named seed of a different class is a different object; an unnamed one
      // is just a box, and may be this object seen by the scanner.
      if (seed.category !== null && seed.category !== object.category) return;
      const distance = footprintDistance(object.position, seed.position);
      if (distance <= FUSE_RADIUS_M && (best === null || distance < best.distance)) {
        best = { index, distance };
      }
    });
    if (best === null) continue;
    const match = best as { index: number; distance: number };
    const seed = seeds[match.index]!;
    claimed.add(match.index);
    // The scan wins geometry; the photo keeps the class it recognized and the
    // colours it sampled.
    object.position = { ...seed.position };
    object.rotationY = seed.rotationY;
    object.size = { ...seed.size };
    object.lowConfidence = false;
    object.confidence = Math.max(object.confidence, scanConfidence);
    corrected++;
  }

  let added = 0;
  seeds.forEach((seed, index) => {
    if (claimed.has(index) || seed.category === null) return;
    out.push({
      id: options.newId(),
      category: seed.category,
      position: { ...seed.position },
      rotationY: seed.rotationY,
      size: { ...seed.size },
      // How a thing is held in the room is a property of what it is, not of
      // where the scanner happened to see it.
      support: getCategory(seed.category)?.support ?? "floor",
      confidence: scanConfidence,
      sourcePhotoIds: ["scan"],
      lowConfidence: false,
      palette: [],
      faceTextureRef: null,
    });
    added++;
  });

  return { measured: out, corrected, added };
}
