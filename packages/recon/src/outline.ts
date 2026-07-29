import type { Vec2 } from "@myroom/geometry";

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
  /** Drop segments shorter than this after simplification (metres). */
  minWallMetres?: number;
  /** Snap a segment to the room's axes when it is within this many degrees. */
  snapDegrees?: number;
  /** Douglas–Peucker tolerance, metres. */
  toleranceMetres?: number;
}

/**
 * Tuned against a real Scaniverse scan of an open-plan play area and kitchen,
 * whose owner had separately drawn the same room by hand at 208 sq ft:
 *
 *   tolerance  minWall  close | vertices  area
 *      0.12      0.35     2   |    28     208 sq ft
 *      0.25      0.60     2   |    15     218
 *      0.30      0.90     3   |    10     221
 *      0.40      1.20     3   |     7     212   <- chosen
 *      0.50      1.20     4   |     8     245
 *
 * Coarser simplification gives both fewer vertices *and* better area, because
 * what it removes is scanner noise rather than architecture. Twenty-eight
 * vertices is not a plan anyone wants to edit on a phone; seven is.
 */
const DEFAULTS: Required<OutlineOptions> = {
  cellMetres: 0.15,
  closeRadius: 3,
  minWallMetres: 1.2,
  snapDegrees: 22,
  toleranceMetres: 0.4,
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

/** Douglas–Peucker on a closed ring. */
function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    const a = points[first]!;
    const b = points[last]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    for (let i = first + 1; i < last; i++) {
      const p = points[i]!;
      const distance =
        length < 1e-12
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length;
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Snap each edge to the room's own axes, then re-intersect neighbours so the
 * corners stay closed.
 *
 * A traced ring is a staircase of 15 cm steps. Rooms are not staircases, and a
 * plan full of 15 cm jogs is worse to edit than one the user drew themselves.
 */
function regularise(ring: readonly Vec2[], angle: number, snapDegrees: number): Vec2[] {
  if (ring.length < 3) return [...ring];
  const axes = [angle, angle + Math.PI / 2];
  const snapped: { point: Vec2; dir: Vec2 }[] = [];

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const edgeAngle = Math.atan2(b.y - a.y, b.x - a.x);
    let best = edgeAngle;
    let bestDelta = Infinity;
    for (const axis of axes) {
      for (const candidate of [axis, axis + Math.PI]) {
        let delta = Math.abs(((edgeAngle - candidate + Math.PI) % (2 * Math.PI)) - Math.PI);
        delta = Math.min(delta, Math.abs(2 * Math.PI - delta));
        if (delta < bestDelta) {
          bestDelta = delta;
          best = candidate;
        }
      }
    }
    const use = bestDelta <= (snapDegrees * Math.PI) / 180 ? best : edgeAngle;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    snapped.push({ point: mid, dir: { x: Math.cos(use), y: Math.sin(use) } });
  }

  // Re-corner: each vertex is where its two adjacent (now-straightened) walls meet.
  const out: Vec2[] = [];
  for (let i = 0; i < snapped.length; i++) {
    const p = snapped[i]!;
    const q = snapped[(i + 1) % snapped.length]!;
    const denominator = p.dir.x * q.dir.y - p.dir.y * q.dir.x;
    if (Math.abs(denominator) < 1e-9) continue; // parallel: no corner here
    const t = ((q.point.x - p.point.x) * q.dir.y - (q.point.y - p.point.y) * q.dir.x) / denominator;
    out.push({ x: p.point.x + p.dir.x * t, y: p.point.y + p.dir.y * t });
  }
  return out;
}

/** Drop vertices closer together than `minWall`, collapsing tiny jogs. */
function dropShortWalls(ring: readonly Vec2[], minWall: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minWall) out.push(p);
  }
  while (out.length > 3) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.hypot(first.x - last.x, first.y - last.y) < minWall) out.pop();
    else break;
  }
  return out;
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
  const { cellMetres, closeRadius, minWallMetres, snapDegrees, toleranceMetres } = {
    ...DEFAULTS,
    ...options,
  };
  if (cells.length < 8) return null;

  const grid = gridOf(cells.map(([x, y]) => `${Math.round(x / cellMetres)},${Math.round(y / cellMetres)}`));
  // Close, keep the room, fill what the furniture hid.
  const closed = erode(dilate(grid, closeRadius), closeRadius);
  const component = largestComponent(closed.cells.size > 0 ? closed : grid);
  const solid = fillHoles(component);
  if (solid.cells.size < 8) return null;

  const traced = traceBoundary(solid).map((p) => ({ x: p.x * cellMetres, y: p.y * cellMetres }));
  if (traced.length < 4) return null;

  const simplified = simplify(traced, toleranceMetres);
  const straightened = regularise(simplified, angle, snapDegrees);
  const ring = dropShortWalls(straightened, minWallMetres);
  return ring.length >= 3 ? ring : null;
}
