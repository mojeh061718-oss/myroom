import type { ScanParse } from "@myroom/schema";

import { traceFloorOutline } from "./outline.js";

/**
 * Stage 0 for mesh scans — Scaniverse, Polycam, RoomPlan USDZ, anything that
 * exports `.glb` or `.ply` (docs/05 §2).
 *
 * The pipeline used to accept these files, sniff them correctly, and then drop
 * them: the only client parser was for RoomPlan JSON and every other format was
 * deferred to a worker tier that is not deployed. Someone who scanned their
 * living room got a room built from their sketch and a note about a server they
 * cannot reach.
 *
 * Nothing Stage 0 needs from a mesh requires that server. This module is pure
 * geometry over triangles, so it has no three.js dependency, runs in a worker,
 * and is testable in Node against a real scan.
 *
 * Three decisions carry the accuracy, and each was made because the naive
 * version measured a real scan wrong:
 *
 *  1. **Triangles, weighted by area — not vertices.** A wall is a handful of
 *     large triangles; a shelf of toys is thousands of tiny ones. Counting
 *     vertices lets clutter outvote structure. On the reference scan, area
 *     weighting separates cleanly: 50.2 m² of wall, 20.2 of floor, 20.1 of
 *     ceiling, 18.0 of everything else.
 *
 *  2. **The room's own rotation is measured, not assumed.** The reference scan's
 *     walls run at 30° and 120° — square to each other, 30° off the scanner's
 *     axes. An axis-aligned bounding box around that rectangle reported
 *     18'7" × 25'11½" (482 sq ft) for a room of about 246 sq ft. Fitting the
 *     box to the walls' own frame is the difference between a measurement and
 *     a number.
 *
 *  3. **Floor area comes from the floor, by occupancy.** An open-plan space —
 *     a play area that runs into a kitchen — is rarely a rectangle, and the
 *     rectangle's missing corner is not floor. Rasterising the floor triangles
 *     answers "how much floor is there" without assuming a shape.
 */

export interface MeshScanOptions {
  /** Height histogram resolution. Finer than any real floor is flat. */
  binMetres?: number;
  /** Occupancy cell size for floor-area measurement. */
  cellMetres?: number;
  /** |n·y| above this is horizontal; below `verticalMax` is vertical. */
  horizontalMin?: number;
  verticalMax?: number;
  /** Wall-orientation histogram resolution, degrees. */
  angleStepDegrees?: number;
  /** Ignore this fraction at each end when measuring extents — mesh scans fray. */
  trim?: number;
}

const DEFAULTS: Required<MeshScanOptions> = {
  binMetres: 0.02,
  cellMetres: 0.15,
  horizontalMin: 0.9,
  verticalMax: 0.3,
  angleStepDegrees: 5,
  trim: 0.02,
};

export interface Triangle {
  /** Centroid. */
  cx: number;
  cy: number;
  cz: number;
  /** Unit normal. */
  nx: number;
  ny: number;
  nz: number;
  area: number;
  /** The three corners, needed to rasterise the triangle rather than sample
   *  it at one point — see `markOccupancy`. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  gx: number;
  gz: number;
}

/** Per-triangle centroid, unit normal and area. Degenerate faces are dropped. */
export function triangleFacets(positions: Float32Array, indices: Uint32Array): Triangle[] {
  const out: Triangle[] = [];
  for (let f = 0; f + 2 < indices.length; f += 3) {
    const a = indices[f]! * 3;
    const b = indices[f + 1]! * 3;
    const c = indices[f + 2]! * 3;
    const ax = positions[a]!;
    const ay = positions[a + 1]!;
    const az = positions[a + 2]!;
    const ux = positions[b]! - ax;
    const uy = positions[b + 1]! - ay;
    const uz = positions[b + 2]! - az;
    const vx = positions[c]! - ax;
    const vy = positions[c + 1]! - ay;
    const vz = positions[c + 2]! - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-12)) continue;
    nx /= length;
    ny /= length;
    nz /= length;
    out.push({
      cx: (ax + positions[b]! + positions[c]!) / 3,
      cy: (ay + positions[b + 1]! + positions[c + 1]!) / 3,
      cz: (az + positions[b + 2]! + positions[c + 2]!) / 3,
      nx,
      ny,
      nz,
      area: length / 2,
      ax,
      az,
      bx: positions[b]!,
      bz: positions[b + 2]!,
      gx: positions[c]!,
      gz: positions[c + 2]!,
    });
  }
  return out;
}

export interface HorizontalPlanes {
  floorY: number;
  ceilingY: number | null;
  /** Supporting area in m², so a sliver of ceiling can be told from a real one. */
  floorArea: number;
  ceilingArea: number;
}

/**
 * Floor and ceiling, by area-weighted height histogram over horizontal facets.
 *
 * The densest plane overall is not necessarily the floor — in a cluttered room
 * it can be a bed or a run of countertop. Splitting into lower and upper halves
 * encodes the one thing always true of a room: the floor is at the bottom.
 */
export function findHorizontalPlanes(
  facets: readonly Triangle[],
  options: MeshScanOptions = {},
): HorizontalPlanes | null {
  const { binMetres, horizontalMin } = { ...DEFAULTS, ...options };
  const histogram = new Map<number, number>();
  let lowest = Infinity;
  let highest = -Infinity;
  let total = 0;

  for (const t of facets) {
    if (Math.abs(t.ny) < horizontalMin) continue;
    if (!Number.isFinite(t.cy)) continue;
    const bin = Math.round(t.cy / binMetres);
    histogram.set(bin, (histogram.get(bin) ?? 0) + t.area);
    total += t.area;
    if (t.cy < lowest) lowest = t.cy;
    if (t.cy > highest) highest = t.cy;
  }
  if (total < 1 || !Number.isFinite(lowest) || highest - lowest < 1.2) return null;

  const middle = (lowest + highest) / 2;
  const entries = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  const floor = entries.find(([bin]) => bin * binMetres < middle);
  const ceiling = entries.find(([bin]) => bin * binMetres >= middle);
  if (!floor) return null;

  return {
    floorY: floor[0] * binMetres,
    floorArea: floor[1],
    // A scan taken looking downward has no ceiling. That is a missing
    // measurement, not a failed parse — the plan's own height stands.
    ceilingY: ceiling && ceiling[1] > 0.5 ? ceiling[0] * binMetres : null,
    ceilingArea: ceiling?.[1] ?? 0,
  };
}

/**
 * The angle the room's walls run at, in radians, in [0, π/2).
 *
 * Vertical facets vote for their normal's compass direction, weighted by area.
 * Walls come in perpendicular pairs, so folding the histogram modulo 90° makes
 * both directions of a rectangular room reinforce the same bin instead of
 * splitting the vote.
 */
export function findPrincipalAngle(
  facets: readonly Triangle[],
  options: MeshScanOptions = {},
): number | null {
  const { verticalMax, angleStepDegrees } = { ...DEFAULTS, ...options };
  const bins = new Map<number, number>();
  let total = 0;
  for (const t of facets) {
    if (Math.abs(t.ny) > verticalMax) continue;
    const degrees = (((Math.atan2(t.nz, t.nx) * 180) / Math.PI) % 90 + 90) % 90;
    const bin = Math.round(degrees / angleStepDegrees) * angleStepDegrees;
    bins.set(bin % 90, (bins.get(bin % 90) ?? 0) + t.area);
    total += t.area;
  }
  if (total < 1) return null;

  const best = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;

  // Refine by the area-weighted mean within the winning bin's neighbourhood,
  // so the answer is not quantised to the histogram step.
  const centre = best[0];
  let weighted = 0;
  let weight = 0;
  for (const t of facets) {
    if (Math.abs(t.ny) > verticalMax) continue;
    const degrees = (((Math.atan2(t.nz, t.nx) * 180) / Math.PI) % 90 + 90) % 90;
    let delta = degrees - centre;
    if (delta > 45) delta -= 90;
    if (delta < -45) delta += 90;
    if (Math.abs(delta) > angleStepDegrees) continue;
    weighted += (centre + delta) * t.area;
    weight += t.area;
  }
  const degrees = weight > 0 ? weighted / weight : centre;
  return (degrees * Math.PI) / 180;
}

export interface Footprint {
  /** Half-extents and centre in the room's own frame. */
  width: number;
  depth: number;
  centreX: number;
  centreZ: number;
  /** Rotation of the room's frame relative to world, radians. */
  angle: number;
  /** Floor area by occupancy — independent of the rectangle, so an L-shaped
   *  open plan reports the floor it has rather than the box around it. */
  occupiedArea: number;
  cells: [number, number][];
}

/**
 * Mark every occupancy cell a triangle actually covers.
 *
 * Sampling at the centroid alone under-measures whenever a triangle is bigger
 * than a cell: one large floor triangle marks a single cell and the floor comes
 * out a third of its true size. Real scans are finely tessellated so it rarely
 * bites there, but "rarely" is not a property to depend on — a decimated or
 * hand-authored mesh has exactly that shape.
 *
 * Barycentric sampling at a density derived from the triangle's own area keeps
 * this proportional: small triangles cost one sample, large ones cost enough to
 * cover themselves, and the grid deduplicates overlapping geometry the way a
 * plain area sum would not.
 */
function markOccupancy(triangle: Triangle, cell: number, into: Set<string>, project: (x: number, z: number) => [number, number]): void {
  const samples = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(triangle.area) / cell) + 1));
  for (let i = 0; i <= samples; i++) {
    for (let j = 0; i + j <= samples; j++) {
      const u = i / samples;
      const v = j / samples;
      const w = 1 - u - v;
      const x = triangle.ax * w + triangle.bx * u + triangle.gx * v;
      const z = triangle.az * w + triangle.bz * u + triangle.gz * v;
      const [pu, pv] = project(x, z);
      into.add(`${Math.round(pu / cell)},${Math.round(pv / cell)}`);
    }
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i]!;
}

/**
 * Measure the room in its own rotated frame, and its floor by occupancy.
 *
 * Extents are percentiles, not min/max: a mesh scan's edges are torn fragments
 * hanging in space, and taking them literally adds a foot to every room.
 */
export function measureFootprint(
  facets: readonly Triangle[],
  planes: HorizontalPlanes,
  angle: number,
  options: MeshScanOptions = {},
): Footprint {
  const { trim, cellMetres, horizontalMin } = { ...DEFAULTS, ...options };
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  const us: number[] = [];
  const vs: number[] = [];
  const occupancy = new Set<string>();

  const ceiling = planes.ceilingY ?? planes.floorY + 2.6;
  for (const t of facets) {
    // Structure only: the band above furniture and below the ceiling.
    const isWallBand = t.cy > planes.floorY + 0.8 && t.cy < ceiling - 0.3;
    const isFloor = Math.abs(t.ny) >= horizontalMin && t.cy < planes.floorY + 0.35;
    if (!isWallBand && !isFloor) continue;

    const u = t.cx * cos - t.cz * sin;
    const v = t.cx * sin + t.cz * cos;
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;

    if (isWallBand) {
      us.push(u);
      vs.push(v);
    }
    if (isFloor) {
      markOccupancy(t, cellMetres, occupancy, (x, z) => [x * cos - z * sin, x * sin + z * cos]);
    }
  }

  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const u0 = percentile(us, trim);
  const u1 = percentile(us, 1 - trim);
  const v0 = percentile(vs, trim);
  const v1 = percentile(vs, 1 - trim);

  return {
    width: u1 - u0,
    depth: v1 - v0,
    centreX: (u0 + u1) / 2,
    centreZ: (v0 + v1) / 2,
    angle,
    occupiedArea: occupancy.size * cellMetres * cellMetres,
    cells: [...occupancy].map((key) => {
      const [cu, cv] = key.split(",");
      return [Number(cu) * cellMetres, Number(cv) * cellMetres] as [number, number];
    }),
  };
}

/**
 * Parse a mesh scan into the Stage 0 artifact.
 *
 * `positions` is interleaved xyz in metres, Y-up (the glTF convention every
 * scanner app exports); `indices` are triangle vertex indices. Plan coordinates
 * are (x, y) with +Y north, so world −Z maps to plan +Y (docs/07 §5) — that
 * mapping happens here so no caller has to remember it.
 */
export function parseMeshScan(
  positions: Float32Array,
  indices: Uint32Array,
  format: ScanParse["format"],
  options: MeshScanOptions = {},
): ScanParse {
  const empty: ScanParse = {
    format,
    parsed: false,
    failure: null,
    walls: [],
    ceilingHeight: null,
    seedBoxes: [],
    disagreements: [],
    silhouette: [],
  };

  if (positions.length < 300 || indices.length < 300) {
    return { ...empty, failure: "that scan doesn't have enough geometry to read" };
  }

  const facets = triangleFacets(positions, indices);
  if (facets.length < 100) {
    return { ...empty, failure: "that scan doesn't have enough surfaces to read" };
  }

  const planes = findHorizontalPlanes(facets, options);
  if (!planes) {
    return { ...empty, failure: "we couldn't find a floor and a ceiling in that scan" };
  }

  const angle = findPrincipalAngle(facets, options) ?? 0;
  const footprint = measureFootprint(facets, planes, angle, options);
  if (!(footprint.width > 0.5) || !(footprint.depth > 0.5)) {
    return { ...empty, failure: "that scan is too small to be a room" };
  }

  const ceilingHeight = planes.ceilingY === null ? null : planes.ceilingY - planes.floorY;

  // Corners of the fitted rectangle, rotated back into world, then into plan
  // coordinates. Anticlockwise so the loop's signed area is positive.
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfW = footprint.width / 2;
  const halfD = footprint.depth / 2;
  const corner = (du: number, dv: number) => {
    const u = footprint.centreX + du * halfW;
    const v = footprint.centreZ + dv * halfD;
    const x = u * cos - v * sin;
    const z = u * sin + v * cos;
    return { x, y: -z };
  };
  // Trace the floor's actual outline, and keep the fitted rectangle only as the
  // fallback for when there is not enough floor to trace.
  //
  // Returning the rectangle unconditionally — which this did until an audit
  // caught it — makes `traceFloorOutline` dead code and reintroduces the exact
  // failure it exists to prevent: an open-plan space that runs from a play area
  // into a kitchen is not a rectangle, and the rectangle's missing corner is
  // not floor. `footprint.cells` are already in the room's own frame, so the
  // trace runs at angle 0 and the corners are rotated back with everything else.
  const traced = traceFloorOutline(footprint.cells, 0);
  const corners =
    traced && traced.length >= 4
      ? traced.map((p) => {
          const x = p.x * cos - p.y * sin;
          const z = p.x * sin + p.y * cos;
          return { x, y: -z };
        })
      : [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
  const walls = corners.map((start, i) => ({
    start,
    end: corners[(i + 1) % corners.length]!,
    height: ceilingHeight,
  }));

  return {
    format,
    parsed: true,
    failure: null,
    walls,
    ceilingHeight: ceilingHeight !== null && ceilingHeight > 1.5 ? ceilingHeight : null,
    // Naming an object needs a classifier. A seed box without a category tells
    // assembly that a volume is occupied but not by what, and docs/05 §6 would
    // place an anonymous parametric blank. Reporting nothing is more honest
    // than furnishing someone's room with grey boxes.
    seedBoxes: [],
    disagreements: [],
    silhouette: footprint.cells.map(([u, v]) => {
      const x = u * cos - v * sin;
      const z = u * sin + v * cos;
      return [x, -z] as [number, number];
    }),
  };
}
