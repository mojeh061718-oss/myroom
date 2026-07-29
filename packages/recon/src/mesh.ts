import type { ScanParse } from "@myroom/schema";

import { clustersToSeedBoxes, extractObjectClusters, type SizedCategory } from "./meshObjects.js";
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
  const { trim, cellMetres } = { ...DEFAULTS, ...options };
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  const us: number[] = [];
  const vs: number[] = [];
  const occupancy = new Set<string>();

  const ceiling = planes.ceilingY ?? planes.floorY + 2.6;
  for (const t of facets) {
    // Structure only: the band above furniture and below the ceiling.
    const isWallBand = t.cy > planes.floorY + 0.8 && t.cy < ceiling - 0.3;
    // Interior evidence is EVERYTHING below the ceiling, not just visible
    // floor. A sofa against a wall hides the floor behind it entirely — no
    // amount of hole-closing recovers a bay that touches the boundary — but
    // the sofa itself proves that volume is inside the room. Walls mark the
    // rim, furniture fills its own shadow, and the outline lands where the
    // space actually stops. (Ceiling facets say nothing about the floor and
    // fray past the walls, so they stay out.)
    const isInterior = t.cy > planes.floorY - 0.05 && t.cy < ceiling - 0.25;
    if (!isWallBand && !isInterior) continue;

    const u = t.cx * cos - t.cz * sin;
    const v = t.cx * sin + t.cz * cos;
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;

    if (isWallBand) {
      us.push(u);
      vs.push(v);
    }
    if (isInterior) {
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
 * Vertical-surface coverage per occupancy cell: how many metres of the
 * wall band (floor+0.35 … ceiling−0.25) have vertical geometry in this cell.
 * A painted wall covers most of the band; open floor covers none; a sofa
 * back covers half a metre. This is the evidence "a wall stands here",
 * independent of what the floor fill believes.
 */
export function verticalCoverage(
  facets: readonly Triangle[],
  planes: HorizontalPlanes,
  angle: number,
  cellMetres = 0.15,
): Map<string, number> {
  const low = planes.floorY + 0.35;
  const high = (planes.ceilingY ?? planes.floorY + 2.6) - 0.25;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const slabs = new Map<string, Set<number>>();
  for (const t of facets) {
    if (Math.abs(t.ny) > 0.35) continue;
    if (t.cy < low || t.cy > high) continue;
    const u = t.cx * cos - t.cz * sin;
    const v = t.cx * sin + t.cz * cos;
    const key = `${Math.round(u / cellMetres)},${Math.round(v / cellMetres)}`;
    let set = slabs.get(key);
    if (!set) slabs.set(key, (set = new Set()));
    set.add(Math.round(t.cy / 0.05));
  }
  const out = new Map<string, number>();
  for (const [key, set] of slabs) out.set(key, set.size * 0.05);
  return out;
}

/**
 * Cut corners that a real barrier visibly cuts.
 *
 * The reference scan's owner drew the correction themselves: the outline's
 * top corner is not square — a wall-height line runs diagonally across it,
 * plain as day in the wall-band render, with a strip of scanned clutter
 * beyond it that the occupancy fill dutifully included. Occupancy cannot see
 * this (there is geometry on both sides); the wall band can.
 *
 * For every convex corner, search chords from one adjacent wall to the other
 * for a line with continuous wall-height support — and require the corner
 * being cut off to have essentially NO real floor behind the line. That last
 * test is the owner's own rule ("you can see where the space stops") and it
 * is what tells a boundary from tall furniture standing in the room: beyond
 * a true boundary there is no floor; behind a wardrobe or a curtain there is
 * a floor's worth of floor, and the corner must stay.
 */
type Pt2 = { x: number; y: number };

export function chamferCorners(
  ring: Pt2[],
  coverage: Map<string, number>,
  floorCells: ReadonlySet<string>,
  cellMetres = 0.15,
): Pt2[] {
  if (ring.length < 4) return ring;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  const orientation = Math.sign(area) || 1;

  /** Fraction of the cut triangle {E1, V, E2} that is real, visible floor. */
  const floorFraction = (e1: Pt2, corner: Pt2, e2: Pt2): number => {
    const minU = Math.min(e1.x, corner.x, e2.x);
    const maxU = Math.max(e1.x, corner.x, e2.x);
    const minV = Math.min(e1.y, corner.y, e2.y);
    const maxV = Math.max(e1.y, corner.y, e2.y);
    const side = (p: Pt2, a: Pt2, b: Pt2) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    let total = 0;
    let floor = 0;
    for (let cu = Math.round(minU / cellMetres); cu <= Math.round(maxU / cellMetres); cu++) {
      for (let cv = Math.round(minV / cellMetres); cv <= Math.round(maxV / cellMetres); cv++) {
        const p = { x: cu * cellMetres, y: cv * cellMetres };
        const d1 = side(p, e1, corner);
        const d2 = side(p, corner, e2);
        const d3 = side(p, e2, e1);
        const inside = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
        if (!inside) continue;
        total++;
        if (floorCells.has(`${cu},${cv}`)) floor++;
      }
    }
    return total === 0 ? 1 : floor / total;
  };

  const out = ring.map((p) => ({ ...p }));
  for (let i = 0; i < out.length; i++) {
    const n = out.length;
    const P = out[(i - 1 + n) % n]!;
    const V = out[i]!;
    const Q = out[(i + 1) % n]!;
    const inLen = Math.hypot(V.x - P.x, V.y - P.y);
    const outLen = Math.hypot(Q.x - V.x, Q.y - V.y);
    if (inLen < 1e-9 || outLen < 1e-9) continue;
    const inDir = { x: (V.x - P.x) / inLen, y: (V.y - P.y) / inLen };
    const outDir = { x: (Q.x - V.x) / outLen, y: (Q.y - V.y) / outLen };
    // Convex, axis-aligned corners only — a chamfer at a reflex corner would
    // grow the room, and this must only ever cut.
    if (Math.abs(inDir.x) > 1e-9 && Math.abs(inDir.y) > 1e-9) continue;
    if (Math.abs(outDir.x) > 1e-9 && Math.abs(outDir.y) > 1e-9) continue;
    const cross = inDir.x * outDir.y - inDir.y * outDir.x;
    if (cross * orientation <= 0) continue;

    const maxA = Math.min(2.7, inLen - 0.45);
    const maxB = Math.min(2.7, outLen - 0.45);
    if (maxA < 0.45 || maxB < 0.45) continue;

    /*
     * Fit the barrier, then place the chamfer where the fit says — rather
     * than searching chord endpoints and scoring them, which kept finding
     * chords certified by the walls' own coverage smeared sideways, or
     * qualifying cuts far longer than the barrier. Candidate cells are the
     * tall ones inside this corner's pocket, clear of both wall lines so the
     * walls themselves can't vote.
     */
    const A0 = { x: V.x - inDir.x * maxA, y: V.y - inDir.y * maxA };
    const B0 = { x: V.x + outDir.x * maxB, y: V.y + outDir.y * maxB };
    const lowU = Math.min(A0.x, V.x, B0.x);
    const highU = Math.max(A0.x, V.x, B0.x);
    const lowV = Math.min(A0.y, V.y, B0.y);
    const highV = Math.max(A0.y, V.y, B0.y);
    const pts: Pt2[] = [];
    for (const [key, tall] of coverage) {
      if (tall < 0.25) continue;
      const [cu, cv] = key.split(",").map(Number) as [number, number];
      const x = cu * cellMetres;
      const y = cv * cellMetres;
      if (x < lowU || x > highU || y < lowV || y > highV) continue;
      const dIn = Math.abs(inDir.x !== 0 ? y - V.y : x - V.x);
      const dOut = Math.abs(outDir.x !== 0 ? y - V.y : x - V.x);
      if (Math.min(dIn, dOut) < 0.3) continue;
      pts.push({ x, y });
    }
    if (pts.length < 5) continue;

    // Deterministic pairwise line search (a pocket holds at most a few
    // hundred cells). Axis-parallel hypotheses are wall fringe, not a
    // barrier crossing the corner, so only genuinely diagonal pairs count.
    // Every hypothesis is kept, ranked by support: the single best-supported
    // line is not always a valid cut — on the reference scan it merges a
    // knee-high play fence with the real wall behind it into one long line
    // that would consume the whole top wall — so the gates below pick the
    // strongest hypothesis that IS a valid corner cut.
    const stride = pts.length > 140 ? Math.ceil(pts.length / 140) : 1;
    const hypotheses = new Map<string, { nx: number; ny: number; d: number; count: number }>();
    for (let p1 = 0; p1 < pts.length; p1 += stride) {
      for (let p2 = p1 + 1; p2 < pts.length; p2++) {
        const dx = pts[p2]!.x - pts[p1]!.x;
        const dy = pts[p2]!.y - pts[p1]!.y;
        const span = Math.hypot(dx, dy);
        if (span < 0.6 || Math.abs(dx) < 0.3 || Math.abs(dy) < 0.3) continue;
        let nx = -dy / span;
        let ny = dx / span;
        let d = nx * pts[p1]!.x + ny * pts[p1]!.y;
        if (d < 0) {
          nx = -nx;
          ny = -ny;
          d = -d;
        }
        let count = 0;
        for (const p of pts) if (Math.abs(nx * p.x + ny * p.y - d) <= 0.18) count++;
        if (count < 5) continue;
        const key = `${Math.round(nx * 8)},${Math.round(ny * 8)},${Math.round(d * 3)}`;
        const seen = hypotheses.get(key);
        if (!seen || count > seen.count) hypotheses.set(key, { nx, ny, d, count });
      }
    }

    const ranked = [...hypotheses.values()].sort((a, b) => b.count - a.count).slice(0, 40);
    for (const hypothesis of ranked) {
      // Refit on the inliers (principal direction), then the chamfer
      // endpoints are where the fitted line meets the two walls.
      const inliers = pts.filter((p) => Math.abs(hypothesis.nx * p.x + hypothesis.ny * p.y - hypothesis.d) <= 0.18);
      let mx = 0;
      let my = 0;
      for (const p of inliers) {
        mx += p.x;
        my += p.y;
      }
      mx /= inliers.length;
      my /= inliers.length;
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (const p of inliers) {
        sxx += (p.x - mx) * (p.x - mx);
        sxy += (p.x - mx) * (p.y - my);
        syy += (p.y - my) * (p.y - my);
      }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const dir = { x: Math.cos(theta), y: Math.sin(theta) };
      const normal = { x: -dir.y, y: dir.x };
      const dist = normal.x * mx + normal.y * my;

      const nDotIn = normal.x * inDir.x + normal.y * inDir.y;
      const nDotOut = normal.x * outDir.x + normal.y * outDir.y;
      // Nearly parallel to a wall means fringe again, and an intersection
      // shooting far away — the exact failure the old finisher had.
      if (Math.abs(nDotIn) < 0.25 || Math.abs(nDotOut) < 0.25) continue;
      // Clamp, don't reject, when the barrier runs past the pocket: the
      // reference scan's boundary complex crosses its whole corner region, so
      // its line meets the walls beyond what a corner cut can consume. The
      // clamped chord approximates the barrier and the floor veto below still
      // protects any real room the flatter cut would swallow.
      const a = Math.min(maxA, (normal.x * V.x + normal.y * V.y - dist) / nDotIn);
      const b = Math.min(maxB, -(normal.x * V.x + normal.y * V.y - dist) / nDotOut);
      if (a < 0.45 || b < 0.45) continue;
      const E1 = { x: V.x - inDir.x * a, y: V.y - inDir.y * a };
      const E2 = { x: V.x + outDir.x * b, y: V.y + outDir.y * b };

      // The barrier must support most of the chamfer it implies — an inlier
      // run much shorter than the cut means the line was extrapolated. The
      // candidate cells were kept 0.3 m clear of both walls, so the visible
      // run can never reach the chord's ends; compare against the part of
      // the chord that cells were allowed to occupy.
      let tLo = Infinity;
      let tHi = -Infinity;
      for (const p of inliers) {
        const t = dir.x * p.x + dir.y * p.y;
        tLo = Math.min(tLo, t);
        tHi = Math.max(tHi, t);
      }
      const chordLen = Math.hypot(E2.x - E1.x, E2.y - E1.y);
      if (tHi - tLo < 0.6 * Math.max(0.5, chordLen - 0.9)) continue;

      // The owner's rule: beyond a real boundary there is no floor. A tall
      // wardrobe or curtain face has wall-height coverage; the floor behind
      // it is what proves the room continues and the corner must stay.
      if (floorFraction(E1, V, E2) > 0.25) continue;

      out.splice(i, 1, E1, E2);
      i++; // skip past the pair we just inserted
      break;
    }
  }
  return out;
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
  options: MeshScanOptions & {
    /**
     * The taxonomy, so clusters can be given a name from their dimensions.
     * Omit it and the boxes still come back, unnamed — a correctly-sized box
     * the user can identify beats an empty room.
     */
    categories?: readonly SizedCategory[];
  } = {},
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
  const toPlan = (p: { x: number; y: number }) => {
    const x = p.x * cos - p.y * sin;
    const z = p.x * sin + p.y * cos;
    return { x, y: -z };
  };
  const provisional =
    traced && traced.length >= 4
      ? traced.map(toPlan)
      : [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
  const provisionalWalls = provisional.map((start, i) => ({
    start,
    end: provisional[(i + 1) % provisional.length]!,
    height: ceilingHeight,
  }));

  // The furniture, clustered out of what is left once the floor, ceiling and
  // walls are accounted for — needed BEFORE the corners are final, because the
  // chamfer pass below must know which wall-height surfaces are furniture.
  const clusters = extractObjectClusters(facets, {
    floorY: planes.floorY,
    ceilingY: planes.ceilingY,
    walls: provisionalWalls,
    angle,
  });

  // Where a boundary visibly cuts a corner, follow it (the room-frame ring is
  // chamfered, then everything maps to plan coordinates together).
  let corners = provisional;
  if (traced && traced.length >= 4) {
    const { cellMetres, horizontalMin } = { ...DEFAULTS, ...options };
    // Real, visible floor per room-frame cell — the "does the room continue
    // past this line?" evidence the chamfer's floor test reads.
    const floorCells = new Set<string>();
    for (const t of facets) {
      if (Math.abs(t.ny) < horizontalMin || t.cy >= planes.floorY + 0.3) continue;
      const u = t.cx * cos + t.cz * sin;
      const v = -t.cx * sin + t.cz * cos;
      floorCells.add(`${Math.round(u / cellMetres)},${Math.round(v / cellMetres)}`);
    }
    corners = chamferCorners(traced, verticalCoverage(facets, planes, angle, cellMetres), floorCells, cellMetres).map(toPlan);
  }
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
    // Seed boxes used to be [] on the reasoning that an unlabelled mesh cannot
    // say *what* occupies a volume — but that means someone scans their room
    // and gets an empty one, which is the outcome they scanned to avoid. Names
    // are a separate, weak, clearly-declined-when-unsure guess; the box is the
    // useful part.
    seedBoxes: clustersToSeedBoxes(clusters, options.categories ?? [], planes.floorY),
    disagreements: [],
    silhouette: footprint.cells.map(([u, v]) => {
      const x = u * cos - v * sin;
      const z = u * sin + v * cos;
      return [x, -z] as [number, number];
    }),
  };
}
