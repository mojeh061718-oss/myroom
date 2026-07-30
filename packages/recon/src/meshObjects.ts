import type { ScanParse } from "@myroom/schema";

import { verticalCoverage, type Triangle } from "./mesh.js";

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
  /*
   * 0.28 here erased most of a real room: fridges, consoles, shelves and
   * kitchen nooks stand AGAINST walls, and the reference scan came back with
   * its entire left-wall run, right-wall run and kitchen unboxed. The margin
   * is now a *zone*, not a verdict: inside it, geometry is dropped only when
   * it belongs to a wall-height vertical surface (the wall itself); furniture
   * standing in the zone survives.
   */
  wallMarginMetres: 0.25,
  minExtentMetres: 0.15,
  minAreaSqMetres: 0.25,
  floorClearanceMetres: 0.06,
};

/**
 * Split a merged cluster at the density valleys of its own footprint.
 *
 * 26-connected voxel flooding at 12 cm merges anything closer than ~17 cm —
 * in a lived-in room that is the couch with its side table, the shelf run
 * with the next shelf, occasionally half the wall line. The reference scan's
 * review listed a 6'×5'×6'4" "object". Real adjacent objects still show a
 * thin waist in plan view; cutting at the thinnest interior column of the
 * footprint, recursively, turns one blob into the objects it was.
 */
function splitAtValleys<T extends { u: number; v: number }>(members: T[], depth = 0): T[][] {
  const BIN = 0.1;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const occupied = new Set<string>();
  for (const m of members) {
    minU = Math.min(minU, m.u);
    maxU = Math.max(maxU, m.u);
    minV = Math.min(minV, m.v);
    maxV = Math.max(maxV, m.v);
    occupied.add(`${Math.round(m.u / BIN)},${Math.round(m.v / BIN)}`);
  }
  if (depth >= 5 || (maxU - minU < 1.4 && maxV - minV < 1.4) || members.length < 32) return [members];

  // Occupied-cell count per 0.1 m column, along each axis in turn.
  const profile = (axis: "u" | "v") => {
    const counts = new Map<number, number>();
    for (const key of occupied) {
      const [cu, cv] = key.split(",").map(Number) as [number, number];
      const bin = axis === "u" ? cu : cv;
      counts.set(bin, (counts.get(bin) ?? 0) + 1);
    }
    return counts;
  };

  let best: { axis: "u" | "v"; at: number; score: number } | null = null;
  for (const axis of ["u", "v"] as const) {
    const lo = axis === "u" ? minU : minV;
    const hi = axis === "u" ? maxU : maxV;
    if (hi - lo < 0.9) continue; // nothing worth splitting along this axis
    const counts = profile(axis);
    let peak = 0;
    for (const c of counts.values()) peak = Math.max(peak, c);
    const from = Math.round((lo + 0.3) / BIN);
    const to = Math.round((hi - 0.3) / BIN);
    for (let bin = from; bin <= to; bin++) {
      const crossing = counts.get(bin) ?? 0;
      const score = crossing / Math.max(1, peak);
      if (score <= 0.45 && (!best || score < best.score)) best = { axis, at: (bin + 0.5) * BIN, score };
    }
  }
  // No waist, but too long to be one object: a continuous 17-foot run along
  // a wall is shelving and clutter, not a thing anyone can tick in a review.
  // Bisect the long axis so each box sits over the stuff it contains.
  if (!best) {
    const spanU = maxU - minU;
    const spanV = maxV - minV;
    if (Math.max(spanU, spanV) <= 2.8) return [members];
    best =
      spanU >= spanV
        ? { axis: "u", at: (minU + maxU) / 2, score: 1 }
        : { axis: "v", at: (minV + maxV) / 2, score: 1 };
  }

  const side = best;
  const left = members.filter((m) => (side.axis === "u" ? m.u : m.v) <= side.at);
  const right = members.filter((m) => (side.axis === "u" ? m.u : m.v) > side.at);
  if (left.length < 8 || right.length < 8) return [members];
  return [...splitAtValleys(left, depth + 1), ...splitAtValleys(right, depth + 1)];
}

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

  // Wall-height vertical surface per room-frame cell: inside the wall margin
  // this is what separates the wall itself (drop) from the fridge standing
  // against it (keep). Distance alone erased a room's worth of against-wall
  // furniture; height alone would erase the fridge too — the pair works.
  const coverage = verticalCoverage(facets, { floorY, ceilingY, floorArea: 0, ceilingArea: 0 }, angle);
  const wallHeight = 0.6;

  // Scanned clutter beyond the walls is not furniture in this room. The
  // chamfered outlines made this real: geometry past a diagonal boundary
  // used to end up inside a box that straddled the wall.
  const loop = walls.map((w) => w.start);
  const insideRoom = (x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i]!;
      const b = loop[j]!;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

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
    if (!insideRoom(planX, planY)) continue;
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
    const u = t.cx * cos - t.cz * sin;
    const v = t.cx * sin + t.cz * cos;
    if (nearWall) {
      const tall = coverage.get(`${Math.round(u / 0.15)},${Math.round(v / 0.15)}`) ?? 0;
      if (tall >= wallHeight) continue; // the wall's own surface
    }

    samples.push({ u, y: t.cy, v, area: t.area });
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

    // A component is not yet an object: adjacent furniture flood-fills into
    // one blob. Cut at footprint valleys first, box the pieces.
    for (const piece of splitAtValleys(members)) {
      /*
       * Measure the dense core, not the extremes. A couch drags along a halo
       * — a toy leaning on it, a blanket corner, a wisp of merged clutter —
       * and boxing the min/max (or even a global percentile) of all of that
       * produced couches four feet deep and six feet tall. Real objects are
       * where the surface is DENSE: the footprint comes from columns holding
       * enough geometry, and the height from what most of those columns top
       * out at — a lamp poking up behind the couch is a few columns, and the
       * 80th-percentile column top ignores it.
       */
      const COL = 0.1;
      const columns = new Map<string, { count: number; top: number }>();
      for (const m of piece) {
        const key = `${Math.round(m.u / COL)},${Math.round(m.v / COL)}`;
        const col = columns.get(key);
        if (col) {
          col.count++;
          col.top = Math.max(col.top, m.y);
        } else {
          columns.set(key, { count: 1, top: m.y });
        }
      }
      const dense: { cu: number; cv: number; top: number }[] = [];
      for (const [key, col] of columns) {
        if (col.count < 3) continue;
        const [cu, cv] = key.split(",").map(Number) as [number, number];
        dense.push({ cu, cv, top: col.top });
      }
      if (dense.length < 4) continue;
      const pick = (sorted: number[], q: number) =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
      const cus = dense.map((d) => d.cu).sort((a, b) => a - b);
      const cvs = dense.map((d) => d.cv).sort((a, b) => a - b);
      const tops = dense.map((d) => d.top).sort((a, b) => a - b);
      const ys = piece.map((m) => m.y).sort((a, b) => a - b);
      const minU = (pick(cus, 0.02) - 0.5) * COL;
      const maxU = (pick(cus, 0.98) + 0.5) * COL;
      const minV = (pick(cvs, 0.02) - 0.5) * COL;
      const maxV = (pick(cvs, 0.98) + 0.5) * COL;
      const minY = pick(ys, 0.02);
      const maxY = Math.max(minY + 0.1, pick(tops, 0.8));
      let area = 0;
      for (const m of piece) area += m.area;

      const width = maxU - minU;
      const depth = maxV - minV;
      const height = maxY - minY;
      if (area < minAreaSqMetres) continue;
      if (width < minExtentMetres || depth < minExtentMetres || height < minExtentMetres) continue;
      // A piece spanning most of the room is scanner drift, not furniture —
      // the trace already told us how big the room is.
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
        // Objects in a room overwhelmingly align with it, and nothing in a
        // raw cluster distinguishes a sofa's front from its back — so inherit
        // the room's angle rather than invent one from noise.
        rotationY: angle,
      });
    }
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
  const candidates = categories.filter(
    (c) =>
      // Dimensions alone may only propose ordinary household things. A
      // cluttered 6'×5'×2'9" island IS piano-proportioned — priors, not
      // proportions, are what rule the piano out, so rare categories need
      // the photo pass or the user's own word.
      guessableFromSizeAlone(c.id) &&
      (onFloor ? c.support === "floor" : c.support === "wall" || c.support === "surface"),
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
   * Two gates. With 112 floor categories, *something* is always within a
   * loose radius of any box, and an early loose threshold labelled a
   * sectional sofa a "grand-piano" — the kind of output that makes a user
   * stop believing anything the app says.
   *
   *   ABSOLUTE — the match must actually be close. 0.4 total across three
   *   axes is roughly 14% out on each.
   *   MARGIN — it must beat the next candidate clearly, UNLESS they are the
   *   same kind of thing. A dead heat between a sofa and a loveseat is safe
   *   to call (either name puts the right shape in the room and the review
   *   catches the rest); a dead heat between a sofa and a piano is not.
   *
   * A declined name still leaves a correctly-sized box in the right place,
   * which is the useful part: the user can say what it is, and the swap sheet
   * needs something to swap.
   */
  // Loosening the absolute gate to 0.4 was tried and immediately relabelled
  // the reference scan's kitchen island a grand piano. 0.32 it stays; the
  // review screen's own name picker and the photo-informed AI pass are the
  // honest ways to name what dimensions alone cannot.
  if (best.s > 0.32) return { category: null, confidence: 0 };
  if (runnerUp && runnerUp.s - best.s < 0.12 && familyOf(runnerUp.c.id) !== familyOf(best.c.id)) {
    return { category: null, confidence: 0 };
  }
  return { category: best.c.id, confidence: Math.max(0.2, 1 - best.s) };
}

const GUESSABLE_EXTRAS = new Set(["coat-rack", "trash-can", "tv", "mirror", "rug", "runner-rug", "potted-plant"]);

/** Ordinary household categories — everything `familyOf` groups, plus a few singles. */
function guessableFromSizeAlone(id: string): boolean {
  return familyOf(id) !== id || GUESSABLE_EXTRAS.has(id);
}

/**
 * Coarse shape family, for the margin gate above: confusing two kinds of
 * seating is a harmless naming quibble; confusing furniture kinds is the
 * grand-piano incident.
 */
function familyOf(id: string): string {
  if (/(sofa|sectional|loveseat|armchair|chair|stool|bench|ottoman|pouf|beanbag|recliner|chaise|daybed)/.test(id)) return "seating";
  if (/(table|desk|island|nightstand|bar-cart|counter|workbench)/.test(id)) return "table";
  if (/(shelf|shelving|bookcase|bookshelf|cabinet|dresser|wardrobe|armoire|hutch|credenza|sideboard|storage|trunk|cubby|locker)/.test(id)) {
    return "storage";
  }
  if (/(bed|mattress|crib|cot)/.test(id)) return "bed";
  if (/(lamp|lantern|sconce|light|chandelier|fan)/.test(id)) return "light";
  if (/(fridge|refrigerator|freezer|range|oven|stove|dishwasher|washer|dryer|microwave|kettle|toaster)/.test(id)) {
    return "appliance";
  }
  return id;
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
