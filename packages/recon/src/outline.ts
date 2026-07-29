import { isSimplePolygon, type Vec2 } from "@myroom/geometry";

/**
 * Floor occupancy → a room outline you can hand to the drawing board.
 *
 * This is what lets a scan *build* the room instead of correcting one someone
 * drew by hand. Drawing a room on a phone is the fiddliest thing the app asks
 * for, and a scan is a measurement — so the scan should produce the plan and
 * the person should tidy it, not the other way round.
 *
 * It also removes two problems rather than solving them. There is no scan-to-
 * plan registration step, because the scan *is* the plan. And there is no
 * rectangle to force: an open-plan play area that runs into a kitchen traces as
 * the L it actually is, which is the case that defeats every bounding box.
 *
 * The pipeline is five steps, and each exists because of a specific way real
 * scan data misbehaves:
 *
 *   1. **Close** — furniture hides the floor beneath it, so raw occupancy is a
 *      sheet of holes. Dilate then erode to bridge them.
 *   2. **Largest component** — a scan catches slivers of the hallway through a
 *      doorway. Keep the room, drop the offcuts.
 *   3. **Fill** — anything enclosed by floor is floor, whatever the sofa hid.
 *   4. **Trace** — walk the boundary to get a closed ring of cell corners.
 *   5. **Regularise** — snap to the room's own axes and simplify. A traced ring
 *      is a staircase of 15 cm steps; a room is straight walls.
 */

export interface OutlineOptions {
  cellMetres?: number;
  /** Morphological closing radius, in cells. 2 bridges a sofa-sized gap. */
  closeRadius?: number;
  /** Collapse walls shorter than this into their neighbours (metres). */
  minWallMetres?: number;
}

/**
 * Validated against a real Scaniverse scan of an open-plan play area and
 * kitchen, whose owner had separately drawn the same room by hand at 208 sq ft.
 * A previous tuning pass judged parameters by vertex count and area alone —
 * and shipped an outline that had the right area and a shape like a dart,
 * because area is blind to shape. The reference scan's outline is now asserted
 * to stay inside its own occupancy bounds (see outline.test.ts).
 */
const DEFAULTS: Required<OutlineOptions> = {
  cellMetres: 0.15,
  closeRadius: 3,
  minWallMetres: 1.2,
};

type Grid = { cells: Set<string>; key: (x: number, y: number) => string };

const gridOf = (cells: Iterable<string>): Grid => ({
  cells: new Set(cells),
  key: (x, y) => `${x},${y}`,
});

function dilate(grid: Grid, radius: number): Grid {
  const out = new Set<string>();
  for (const cell of grid.cells) {
    const [cx, cy] = cell.split(",").map(Number) as [number, number];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        out.add(grid.key(cx + dx, cy + dy));
      }
    }
  }
  return gridOf(out);
}

function erode(grid: Grid, radius: number): Grid {
  const out = new Set<string>();
  for (const cell of grid.cells) {
    const [cx, cy] = cell.split(",").map(Number) as [number, number];
    let solid = true;
    for (let dx = -radius; dx <= radius && solid; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        if (!grid.cells.has(grid.key(cx + dx, cy + dy))) {
          solid = false;
          break;
        }
      }
    }
    if (solid) out.add(cell);
  }
  return gridOf(out);
}

/** Largest 4-connected component — the room, without the hallway slivers. */
function largestComponent(grid: Grid): Grid {
  const seen = new Set<string>();
  let best: string[] = [];
  for (const start of grid.cells) {
    if (seen.has(start)) continue;
    const stack = [start];
    const component: string[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      component.push(cell);
      const [cx, cy] = cell.split(",").map(Number) as [number, number];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const next = grid.key(cx + dx, cy + dy);
        if (grid.cells.has(next) && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  return gridOf(best);
}

/** Fill enclosed holes: anything not reachable from outside the bounds is floor. */
function fillHoles(grid: Grid): Grid {
  if (grid.cells.size === 0) return grid;
  const coords = [...grid.cells].map((c) => c.split(",").map(Number) as [number, number]);
  const minX = Math.min(...coords.map((c) => c[0])) - 1;
  const maxX = Math.max(...coords.map((c) => c[0])) + 1;
  const minY = Math.min(...coords.map((c) => c[1])) - 1;
  const maxY = Math.max(...coords.map((c) => c[1])) + 1;

  const outside = new Set<string>();
  const stack: [number, number][] = [[minX, minY]];
  outside.add(grid.key(minX, minY));
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const key = grid.key(nx, ny);
      if (outside.has(key) || grid.cells.has(key)) continue;
      outside.add(key);
      stack.push([nx, ny]);
    }
  }

  const filled = new Set(grid.cells);
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const key = grid.key(x, y);
      if (!grid.cells.has(key) && !outside.has(key)) filled.add(key);
    }
  }
  return gridOf(filled);
}

/**
 * Trace the boundary as a closed ring of cell corners (marching-squares style:
 * every occupied cell contributes the edges it does not share with a neighbour,
 * and those edges chain into a loop).
 */
function traceBoundary(grid: Grid): Vec2[] {
  const edges = new Map<string, [number, number][]>();
  const add = (from: [number, number], to: [number, number]) => {
    const key = `${from[0]},${from[1]}`;
    const list = edges.get(key);
    if (list) list.push(to);
    else edges.set(key, [to]);
  };

  for (const cell of grid.cells) {
    const [cx, cy] = cell.split(",").map(Number) as [number, number];
    // Corners in grid units; edges wound anticlockwise around each cell.
    const corners: [number, number][] = [
      [cx, cy],
      [cx + 1, cy],
      [cx + 1, cy + 1],
      [cx, cy + 1],
    ];
    const neighbours: [number, number][] = [
      [cx, cy - 1],
      [cx + 1, cy],
      [cx, cy + 1],
      [cx - 1, cy],
    ];
    for (let i = 0; i < 4; i++) {
      const [nx, ny] = neighbours[i]!;
      if (grid.cells.has(grid.key(nx, ny))) continue;
      add(corners[i]!, corners[(i + 1) % 4]!);
    }
  }
  if (edges.size === 0) return [];

  const startKey = [...edges.keys()][0]!;
  const start = startKey.split(",").map(Number) as [number, number];
  const ring: Vec2[] = [];
  let current = start;
  const guard = edges.size * 4 + 8;
  for (let step = 0; step < guard; step++) {
    ring.push({ x: current[0], y: current[1] });
    const options = edges.get(`${current[0]},${current[1]}`);
    if (!options || options.length === 0) break;
    const next = options.shift()!;
    if (next[0] === start[0] && next[1] === start[1]) break;
    current = next;
  }
  return ring;
}

/**
 * Remove vertices that sit on a straight run, so the marching-squares
 * staircase becomes one vertex per direction change. Works on the integer
 * grid ring, where collinear means exactly equal steps.
 */
function mergeCollinear(ring: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length]!;
    const here = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    if (here.x === prev.x && here.x === next.x) continue;
    if (here.y === prev.y && here.y === next.y) continue;
    if (here.x === next.x && here.y === next.y) continue; // duplicate
    out.push(here);
  }
  return out;
}

/**
 * Straighten a rectilinear ring by repeatedly removing its shortest edge.
 *
 * This replaces a Douglas–Peucker → snap-to-axes → re-intersect-corners chain
 * that failed catastrophically on the first real scan it met: two snapped
 * walls meeting at a shallow angle intersect far away, and the reference
 * Scaniverse room came back as a dart with a 36-foot wall — vertices metres
 * outside its own floor. (The tuning table in this file's history recorded
 * that outline as "7 vertices, 212 sq ft" and looked healthy by area alone;
 * shape was never asserted.)
 *
 * The safe move exists because the traced boundary is already rectilinear:
 * a short edge is removed by translating the SHORTER of its two perpendicular
 * neighbours onto the line of the longer one. Every vertex only ever adopts a
 * coordinate another vertex already has, so the ring can never grow past the
 * occupancy it came from — no intersection step, no spikes, closed by
 * construction, and an L-shaped room keeps its L.
 */
function collapseShortEdges(ring: Vec2[], minLength: number): Vec2[] {
  let points = ring.map((p) => ({ ...p }));
  for (let guard = 0; guard < 4096 && points.length > 4; guard++) {
    let shortest = -1;
    let shortestLength = minLength;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (length < shortestLength) {
        shortestLength = length;
        shortest = i;
      }
    }
    if (shortest === -1) break;

    const n = points.length;
    const i0 = (shortest - 1 + n) % n; // start of the edge before
    const i1 = shortest; //               short edge start
    const i2 = (shortest + 1) % n; //     short edge end
    const i3 = (shortest + 2) % n; //     end of the edge after
    const before = Math.abs(points[i1]!.x - points[i0]!.x) + Math.abs(points[i1]!.y - points[i0]!.y);
    const after = Math.abs(points[i3]!.x - points[i2]!.x) + Math.abs(points[i3]!.y - points[i2]!.y);
    const vertical = points[i1]!.x === points[i2]!.x;

    // Translate the shorter neighbour (both endpoints) onto the longer one's
    // line; the short edge collapses to nothing and the neighbours merge.
    if (before < after) {
      if (vertical) points[i0]!.y = points[i1]!.y = points[i2]!.y;
      else points[i0]!.x = points[i1]!.x = points[i2]!.x;
    } else {
      if (vertical) points[i2]!.y = points[i3]!.y = points[i1]!.y;
      else points[i2]!.x = points[i3]!.x = points[i1]!.x;
    }
    points = mergeCollinear(points);
  }
  return points;
}

/**
 * Trace an outline from floor-occupancy cells, in plan coordinates (metres).
 *
 * `cells` are occupied floor positions — the same set `measureFootprint`
 * produces. `angle` is the room's principal wall direction, used to straighten
 * the result. Returns a closed anticlockwise ring, or null when there is not
 * enough floor to be a room.
 */
export function traceFloorOutline(
  cells: readonly [number, number][],
  angle: number,
  options: OutlineOptions = {},
): Vec2[] | null {
  const { cellMetres, closeRadius, minWallMetres } = { ...DEFAULTS, ...options };
  if (cells.length < 8) return null;

  // Work in the room's own frame, where the boundary is rectilinear.
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const grid = gridOf(
    cells.map(([x, y]) => {
      const u = x * cos - y * sin;
      const v = x * sin + y * cos;
      return `${Math.round(u / cellMetres)},${Math.round(v / cellMetres)}`;
    }),
  );
  // Close, keep the room, fill what the furniture hid.
  const closed = erode(dilate(grid, closeRadius), closeRadius);
  const component = largestComponent(closed.cells.size > 0 ? closed : grid);
  const solid = fillHoles(component);
  if (solid.cells.size < 8) return null;

  // The traced boundary is unit axis-aligned steps in grid coordinates; keep
  // it in integers through the whole simplification so collinearity and edge
  // lengths are exact, and scale to metres only at the end.
  const traced = mergeCollinear(traceBoundary(solid));
  if (traced.length < 4) return null;

  // Collapse the staircase into walls. If the collapse ever folds the ring
  // over itself (a deep comb of notches can), retry gentler rather than ship
  // a self-intersecting plan; a still-broken ring falls back to the caller's
  // fitted rectangle, which is honest and editable.
  let ring: Vec2[] | null = null;
  for (const minWall of [minWallMetres, minWallMetres / 2, minWallMetres / 4]) {
    const candidate = collapseShortEdges(traced, Math.max(1, Math.round(minWall / cellMetres)));
    if (candidate.length >= 4 && isSimplePolygon(candidate.map((p) => ({ x: p.x * cellMetres, y: p.y * cellMetres })))) {
      ring = candidate;
      break;
    }
  }
  if (!ring) return null;

  // Back to metres, and back to the caller's frame.
  return ring.map((p) => {
    const u = p.x * cellMetres;
    const v = p.y * cellMetres;
    return { x: u * cos + v * sin, y: -u * sin + v * cos };
  });
}
