import { type Vec2, sub, dist, pointSegmentClosest } from "./vec.js";

/**
 * Constraint-based placement (docs/06 §3): "All manipulation is
 * constraint-based, not free-floating — this is what makes editing feel
 * effortless instead of fiddly."
 *
 * Works in the world XZ plane (metres). Pure, so the snapping rules are
 * testable without a renderer.
 */

export const PARALLEL_TOLERANCE_RAD = (8 * Math.PI) / 180; // docs/06 §3
export const AGAINST_WALL_M = 0.12; // docs/06 §3
export const CENTER_GUIDE_M = 0.1;

export interface SnapWall {
  wallId: string;
  /** world XZ endpoints of the wall centreline */
  start: [number, number];
  end: [number, number];
  /** unit XZ normal pointing into the room */
  inwardNormal: [number, number];
  thickness: number;
}

export interface ObjectSnapInput {
  position: { x: number; z: number };
  rotationY: number;
  /** footprint before rotation */
  size: { w: number; d: number };
  walls: readonly SnapWall[];
  roomCenter: [number, number];
  /** rugs and wall items don't snap flush (docs/06 §3) */
  exempt?: boolean;
}

export interface ObjectSnapResult {
  position: { x: number; z: number };
  rotationY: number;
  parallelToWall: string | null;
  againstWall: string | null;
  centeredOn: "x" | "z" | null;
}

const TWO_PI = Math.PI * 2;

/** Smallest signed difference between two angles, in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/**
 * The rotationY at which an object faces into the room off this wall — i.e.
 * its local +Z points along the wall's inward normal. Objects are placed
 * facing the room, so this, not the wall's heading, is the base angle.
 */
function wallAngle(wall: SnapWall): number {
  return Math.atan2(wall.inwardNormal[0], wall.inwardNormal[1]);
}

/**
 * Snap an object being dragged on the floor:
 *  1. rotation locks parallel to the nearest wall within 8°
 *  2. the object slides flush against that wall within 12 cm
 *  3. otherwise it snaps to the room's centre lines within 10 cm
 */
export function snapObject(input: ObjectSnapInput): ObjectSnapResult {
  const { position, size, walls, roomCenter } = input;
  let rotationY = input.rotationY;
  const result: ObjectSnapResult = {
    position: { ...position },
    rotationY,
    parallelToWall: null,
    againstWall: null,
    centeredOn: null,
  };
  if (input.exempt || walls.length === 0) {
    return snapToCenter(result, roomCenter);
  }

  // Nearest wall by distance from the object's centre to the wall segment.
  let nearest: { wall: SnapWall; distance: number } | null = null;
  const p: Vec2 = { x: position.x, y: position.z };
  for (const wall of walls) {
    const a: Vec2 = { x: wall.start[0], y: wall.start[1] };
    const b: Vec2 = { x: wall.end[0], y: wall.end[1] };
    const { distance } = pointSegmentClosest(p, a, b);
    if (!nearest || distance < nearest.distance) nearest = { wall, distance };
  }
  if (!nearest) return snapToCenter(result, roomCenter);

  const { wall } = nearest;
  const base = wallAngle(wall);

  // Parallel within 8°, in whichever of the four quarter turns is closest.
  let bestDelta = Infinity;
  let bestAngle = rotationY;
  for (let k = 0; k < 4; k++) {
    const candidate = base + (k * Math.PI) / 2;
    const delta = Math.abs(angleDelta(rotationY, candidate));
    if (delta < bestDelta) {
      bestDelta = delta;
      bestAngle = candidate;
    }
  }
  if (bestDelta <= PARALLEL_TOLERANCE_RAD) {
    rotationY = bestAngle;
    result.rotationY = rotationY;
    result.parallelToWall = wall.wallId;
  }

  // Flush against the wall: how deep is the object along the wall's normal?
  const facing = Math.abs(angleDelta(rotationY, base)) < Math.PI / 4 ||
    Math.abs(angleDelta(rotationY, base + Math.PI)) < Math.PI / 4;
  const halfDepth = (facing ? size.d : size.w) / 2;
  // Depth is handled separately here, via `halfDepth` on the line below — do
  // not fold it into faceOffset as well, or it is counted twice.
  const faceOffset = wall.thickness / 2;

  // Signed distance from the wall's centreline to the object centre, along the
  // inward normal. Positive means inside the room.
  const toObject = sub(p, { x: wall.start[0], y: wall.start[1] });
  const along = toObject.x * wall.inwardNormal[0] + toObject.y * wall.inwardNormal[1];
  const gap = along - faceOffset - halfDepth;

  if (result.parallelToWall && gap > -AGAINST_WALL_M && gap < AGAINST_WALL_M) {
    result.position = {
      x: position.x - wall.inwardNormal[0] * gap,
      z: position.z - wall.inwardNormal[1] * gap,
    };
    result.againstWall = wall.wallId;
    return result;
  }

  return snapToCenter(result, roomCenter);
}

function snapToCenter(result: ObjectSnapResult, center: [number, number]): ObjectSnapResult {
  if (Math.abs(result.position.x - center[0]) <= CENTER_GUIDE_M) {
    result.position = { ...result.position, x: center[0] };
    result.centeredOn = "x";
  } else if (Math.abs(result.position.z - center[1]) <= CENTER_GUIDE_M) {
    result.position = { ...result.position, z: center[1] };
    result.centeredOn = "z";
  }
  return result;
}

/**
 * Slide a wall-mounted object along its wall, hopping to the adjacent wall when
 * dragged past a corner (docs/06 §3: "dragging past a corner hops to the
 * adjacent wall with a haptic tick. Never detaches into space.")
 */
export function snapToWallRun(
  point: { x: number; z: number },
  walls: readonly SnapWall[],
  width: number,
  /**
   * The object's depth. Required to sit it *against* the wall rather than
   * *inside* it: the returned position is the object's centre, so it has to
   * clear the wall face by half its own depth.
   *
   * Defaulting to 0 reproduces the old behaviour, where a wall cabinet's
   * centre landed exactly on the plaster and half of it was buried — at the
   * shipped 0.115 m wall thickness a 0.35 m cabinet's back face ended up
   * 11.8 cm *outside* the building, visible from the dollhouse view. Seven of
   * the 28 wall-support categories are deeper than 0.15 m.
   */
  depth = 0,
): { wallId: string; position: { x: number; z: number }; rotationY: number } | null {
  if (walls.length === 0) return null;
  let best: { wall: SnapWall; t: number; distance: number } | null = null;
  for (const wall of walls) {
    const a: Vec2 = { x: wall.start[0], y: wall.start[1] };
    const b: Vec2 = { x: wall.end[0], y: wall.end[1] };
    const { t, distance } = pointSegmentClosest({ x: point.x, y: point.z }, a, b);
    if (!best || distance < best.distance) best = { wall, t, distance };
  }
  if (!best) return null;

  const { wall } = best;
  const length = dist(
    { x: wall.start[0], y: wall.start[1] },
    { x: wall.end[0], y: wall.end[1] },
  );
  // Keep the whole object on the wall run.
  const half = Math.min(width / 2, length / 2);
  const clamped = Math.min(Math.max(best.t * length, half), length - half);
  const ux = (wall.end[0] - wall.start[0]) / (length || 1);
  const uz = (wall.end[1] - wall.start[1]) / (length || 1);
  const faceOffset = wall.thickness / 2 + depth / 2;

  return {
    wallId: wall.wallId,
    position: {
      x: wall.start[0] + ux * clamped + wall.inwardNormal[0] * faceOffset,
      z: wall.start[1] + uz * clamped + wall.inwardNormal[1] * faceOffset,
    },
    // Face into the room.
    rotationY: Math.atan2(wall.inwardNormal[0], wall.inwardNormal[1]),
  };
}

/** Axis-aligned footprint half-extents after a Y rotation. */
export function rotatedFootprint(size: { w: number; d: number }, rotationY: number): { hw: number; hd: number } {
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  return {
    hw: (size.w * c + size.d * s) / 2,
    hd: (size.w * s + size.d * c) / 2,
  };
}

/** Soft collision (docs/06 §3): overlapping footprints tint, they don't block. */
export function footprintsOverlap(
  a: { position: { x: number; z: number }; size: { w: number; d: number }; rotationY: number },
  b: { position: { x: number; z: number }; size: { w: number; d: number }; rotationY: number },
): boolean {
  const fa = rotatedFootprint(a.size, a.rotationY);
  const fb = rotatedFootprint(b.size, b.rotationY);
  return (
    Math.abs(a.position.x - b.position.x) < fa.hw + fb.hw - 1e-6 &&
    Math.abs(a.position.z - b.position.z) < fa.hd + fb.hd - 1e-6
  );
}

/** Distances from an object centre to each wall, nearest first (docs/06 §3). */
export function distancesToWalls(
  position: { x: number; z: number },
  walls: readonly SnapWall[],
): { wallId: string; distance: number; point: { x: number; z: number } }[] {
  return walls
    .map((wall) => {
      const { point, distance } = pointSegmentClosest(
        { x: position.x, y: position.z },
        { x: wall.start[0], y: wall.start[1] },
        { x: wall.end[0], y: wall.end[1] },
      );
      return { wallId: wall.wallId, distance, point: { x: point.x, z: point.y } };
    })
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Where to drop a newly added object (docs/06 §5: "placement drops it at the
 * tapped spot already snapped and wall-aligned").
 *
 * Without a tapped spot, walk candidate positions flush along each wall and
 * take the first whose footprint is clear, so adding several pieces in a row
 * furnishes the room instead of stacking everything on the centre point.
 */
export function findFreeSpot(
  walls: readonly SnapWall[],
  existing: readonly {
    position: { x: number; z: number };
    size: { w: number; d: number };
    rotationY: number;
    collisionExempt?: boolean;
  }[],
  size: { w: number; d: number },
  roomCenter: [number, number],
): { x: number; z: number; rotationY: number } {
  const blockers = existing.filter((o) => !o.collisionExempt);
  const fits = (x: number, z: number, rotationY: number) =>
    !blockers.some((other) =>
      footprintsOverlap(
        { position: { x, z }, size, rotationY },
        { position: other.position, size: other.size, rotationY: other.rotationY },
      ),
    );

  for (const wall of walls) {
    const length = dist(
      { x: wall.start[0], y: wall.start[1] },
      { x: wall.end[0], y: wall.end[1] },
    );
    if (length < size.w) continue;
    const ux = (wall.end[0] - wall.start[0]) / length;
    const uz = (wall.end[1] - wall.start[1]) / length;
    const rotationY = Math.atan2(wall.inwardNormal[0], wall.inwardNormal[1]);
    const inset = wall.thickness / 2 + size.d / 2;

    // Try the middle first, then quarter points, then eighths.
    for (const frac of [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875]) {
      const along = Math.min(Math.max(frac * length, size.w / 2), length - size.w / 2);
      const x = wall.start[0] + ux * along + wall.inwardNormal[0] * inset;
      const z = wall.start[1] + uz * along + wall.inwardNormal[1] * inset;
      if (fits(x, z, rotationY)) return { x, z, rotationY };
    }
  }

  // Everything is taken — fall back to the centre and let soft collision show.
  return { x: roomCenter[0], z: roomCenter[1], rotationY: 0 };
}
