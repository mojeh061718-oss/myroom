import type { ScanParse } from "@myroom/schema";

import type { Triangle } from "./mesh.js";

/**
 * Pull the furniture out of a mesh scan (docs/05 §5).
 *
 * `parseMeshScan` originally returned no seed boxes at all, reasoning that an
 * unlabelled mesh cannot say *what* occupies a volume, and that an anonymous
 * box is worse than nothing. That was too cautious. The scan holds the sofa,
 * the shelving and the ottoman as geometry; refusing to place them means the
 * user scans their room and gets an empty one, which is the outcome they were
 * trying to avoid by scanning.
 *
 * So: cluster what is left after the floor, the ceiling and the walls are
 * accounted for, and hand back a box per cluster. Naming is a separate,
 * clearly-labelled guess (see `guessCategory`) — a box in the right place at
 * the right size is useful even when the label is wrong, because the user can
 * swap it, and a swap sheet needs something to swap.
 */

export interface ObjectCluster {
  /** Centre in world metres. */
  cx: number;
  cy: number;
  cz: number;
  /** Extents in the room's own frame. */
  width: number;
  depth: number;
  height: number;
  /** Distance from the floor to the cluster's underside. */
  baseY: number;
  /** Total surface area of the triangles in it — a confidence proxy. */
  area: number;
  rotationY: number;
}

export interface ExtractOptions {
  /** Voxel size for connected-component clustering. */
  voxelMetres?: number;
  /** Ignore geometry within this distance of a wall plane — that is the wall. */
  wallMarginMetres?: number;
  /** Ignore anything thinner than this in every axis: scanner confetti. */
  minExtentMetres?: number;
  /** Ignore clusters smaller than this surface area. */
  minAreaSqMetres?: number;
  /** Skirting height: geometry below this is floor texture, not an object. */
  floorClearanceMetres?: number;
}

const DEFAULTS: Required<ExtractOptions> = {
  voxelMetres: 0.12,
  wallMarginMetres: 0.28,
  minExtentMetres: 0.18,
  minAreaSqMetres: 0.35,
  floorClearanceMetres: 0.06,
};

/** Perpendicular distance from a point to a 2D segment. */
function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared < 1e-12) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Cluster the non-structural geometry into object-sized boxes.
 *
 * `walls` are the traced outline in plan coordinates, used only to reject
 * geometry that *is* the wall. `angle` is the room's principal direction, so
 * extents come out along the room's own axes rather than the scanner's — a
 * sofa against a wall should read 2.1 m wide, not 2.1 m of diagonal.
 */
export function extractObjectClusters(
  facets: readonly Triangle[],
  options: {
    floorY: number;
    ceilingY: number | null;
    walls: ScanParse["walls"];
    angle: number;
  } & ExtractOptions,
): ObjectCluster[] {
  const { voxelMetres, wallMarginMetres, minExtentMetres, minAreaSqMetres, floorClearanceMetres } = {
    ...DEFAULTS,
    ...options,
  };
  const { floorY, ceilingY, walls, angle } = options;
  const ceiling = ceilingY ?? floorY + 2.6;

  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  // Candidate facets: above the skirting, below the ceiling, away from walls.
  interface Sample {
    u: number;
    y: number;
    v: number;
    area: number;
  }
  const samples: Sample[] = [];
  for (const t of facets) {
    if (t.cy < floorY + floorClearanceMetres) continue;
    if (t.cy > ceiling - 0.2) continue;

    // Plan coordinates use +Y north, so world −z maps to plan +y.
    const planX = t.cx;
    const planY = -t.cz;
    let nearWall = false;
    for (const wall of walls) {
      if (
        distanceToSegment(planX, planY, wall.start.x, wall.start.y, wall.end.x, wall.end.y) <
        wallMarginMetres
      ) {
        nearWall = true;
        break;
      }
    }
    if (nearWall) continue;

    samples.push({
      u: t.cx * cos - t.cz * sin,
      y: t.cy,
      v: t.cx * sin + t.cz * cos,
      area: t.area,
    });
  }
  if (samples.length < 20) return [];

  // Connected components over a voxel grid.
  const key = (a: number, b: number, c: number) => `${a},${b},${c}`;
  const buckets = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = key(
      Math.round(s.u / voxelMetres),
      Math.round(s.y / voxelMetres),
      Math.round(s.v / voxelMetres),
    );
    const list = buckets.get(k);
    if (list) list.push(s);
    else buckets.set(k, [s]);
  }

  const seen = new Set<string>();
  const clusters: ObjectCluster[] = [];
  for (const start of buckets.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    const members: Sample[] = [];
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const found = buckets.get(cell);
      if (found) members.push(...found);
      const [a, b, c] = cell.split(",").map(Number) as [number, number, number];
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (da === 0 && db === 0 && dc === 0) continue;
            const next = key(a + da, b + db, c + dc);
            if (buckets.has(next) && !seen.has(next)) {
              seen.add(next);
              stack.push(next);
            }
          }
        }
      }
    }
    if (members.length < 8) continue;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let area = 0;
    for (const m of members) {
      if (m.u < minU) minU = m.u;
      if (m.u > maxU) maxU = m.u;
      if (m.v < minV) minV = m.v;
      if (m.v > maxV) maxV = m.v;
      if (m.y < minY) minY = m.y;
      if (m.y > maxY) maxY = m.y;
      area += m.area;
    }

    const width = maxU - minU;
    const depth = maxV - minV;
    const height = maxY - minY;
    if (area < minAreaSqMetres) continue;
    if (width < minExtentMetres || depth < minExtentMetres || height < minExtentMetres) continue;
    // A cluster spanning most of the room is scanner drift, not a piece of
    // furniture — the trace already told us how big the room is.
    if (width > 6 || depth > 6 || height > 2.6) continue;

    // Back into world coordinates.
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    const backCos = Math.cos(angle);
    const backSin = Math.sin(angle);
    clusters.push({
      cx: midU * backCos - midV * backSin,
      cy: (minY + maxY) / 2,
      cz: midU * backSin + midV * backCos,
      width,
      depth,
      height,
      baseY: minY - floorY,
      area,
      // Objects in a room overwhelmingly align with it, and nothing in a raw
      // cluster distinguishes a sofa's front from its back — so inherit the
      // room's angle rather than invent one from noise.
      rotationY: angle,
    });
  }

  // Largest first: if anything downstream truncates, it should keep the sofa.
  return clusters.sort((a, b) => b.width * b.depth * b.height - a.width * a.depth * a.height);
}

export interface CategoryGuess {
  category: string | null;
  /** 0–1. Low means "a box this size, we are not sure what of". */
  confidence: number;
}

export interface SizedCategory {
  id: string;
  support: string;
  defaultSize: { w: number; d: number; h: number };
}

/**
 * Guess what a cluster is from its dimensions alone.
 *
 * This is a weak signal and is treated as one: the score is a log-ratio
 * distance against each category's nominal size, and anything past a generous
 * threshold returns null rather than a wrong name. A null category still
 * places a correctly-sized box the user can identify themselves, which is the
 * point — a swap sheet needs something to swap.
 *
 * Height off the floor does most of the discriminating work: a 0.5 m box on
 * the floor and the same box at 1.4 m are a footstool and a wall cabinet.
 */
export function guessCategory(
  cluster: ObjectCluster,
  categories: readonly SizedCategory[],
): CategoryGuess {
  const onFloor = cluster.baseY < 0.25;
  const candidates = categories.filter((c) =>
    onFloor ? c.support === "floor" : c.support === "wall" || c.support === "surface",
  );
  if (candidates.length === 0) return { category: null, confidence: 0 };

  // Compare against both orientations: a cluster's u/v axes carry no sense of
  // which way the object faces.
  const score = (c: SizedCategory) => {
    const ratio = (a: number, b: number) => Math.abs(Math.log(Math.max(a, 1e-3) / Math.max(b, 1e-3)));
    const asIs =
      ratio(cluster.width, c.defaultSize.w) +
      ratio(cluster.depth, c.defaultSize.d) +
      ratio(cluster.height, c.defaultSize.h);
    const turned =
      ratio(cluster.width, c.defaultSize.d) +
      ratio(cluster.depth, c.defaultSize.w) +
      ratio(cluster.height, c.defaultSize.h);
    return Math.min(asIs, turned);
  };

  const ranked = candidates
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => a.s - b.s);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best) return { category: null, confidence: 0 };

  /*
   * Two gates, and most clusters fail both. That is the intended outcome.
   *
   * With 112 floor categories, *something* is always within a loose radius of
   * any box. On the reference scan a generous threshold labelled a sectional
   * sofa a "grand-piano" and a shelving unit a "bunk-bed" — a grand piano in a
   * child's play area is not a small error, it is the kind of output that makes
   * a user stop believing anything the app says.
   *
   *   ABSOLUTE — the match must actually be close. 0.35 total across three
   *   axes is roughly 12% out on each.
   *   MARGIN — it must also be clearly better than the next candidate. Boxes
   *   that sit between two categories get no name rather than a coin toss.
   *
   * A declined name still leaves a correctly-sized box in the right place,
   * which is the useful part: the user can say what it is, and the swap sheet
   * needs something to swap.
   */
  if (best.s > 0.35) return { category: null, confidence: 0 };
  if (runnerUp && runnerUp.s - best.s < 0.12) return { category: null, confidence: 0 };
  return { category: best.c.id, confidence: Math.max(0.2, 1 - best.s) };
}

/** Clusters → the seed boxes Stage 3 fuses (docs/05 §5). */
export function clustersToSeedBoxes(
  clusters: readonly ObjectCluster[],
  categories: readonly SizedCategory[],
  floorY: number,
): ScanParse["seedBoxes"] {
  return clusters.map((cluster) => {
    const { category } = guessCategory(cluster, categories);
    return {
      category,
      // position.y is a BASE elevation everywhere in this codebase, not a
      // centre (packages/recon/src/assemble.ts).
      position: { x: cluster.cx, y: Math.max(0, cluster.cy - cluster.height / 2 - floorY), z: cluster.cz },
      rotationY: cluster.rotationY,
      size: { w: cluster.width, d: cluster.depth, h: cluster.height },
    };
  });
}
