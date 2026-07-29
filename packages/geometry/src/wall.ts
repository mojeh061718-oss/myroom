import { type Vec2, add, sub, scale, normalize, dist, midpoint } from "./vec.js";
import { isClockwise } from "./polygon.js";

/**
 * Typed dimensions beat drawn ones (docs/04 §4): re-solve a wall to an exact
 * length, keeping the `fixed` endpoint exactly where it is and sliding the other
 * endpoint along the wall's current direction.
 */
export function resolveWallLength(
  start: Vec2,
  end: Vec2,
  newLength: number,
  fixed: "start" | "end",
): { start: Vec2; end: Vec2 } {
  if (newLength <= 0 || dist(start, end) === 0) return { start, end };
  if (fixed === "start") {
    const dir = normalize(sub(end, start));
    return { start, end: add(start, scale(dir, newLength)) };
  }
  const dir = normalize(sub(start, end));
  return { start: add(end, scale(dir, newLength)), end };
}

/**
 * Wall labeling (docs/04 §5, docs/07 §2): walls are labeled A, B, C… clockwise
 * starting from the northernmost wall.
 *
 * Input: the closed vertex loop in drawing order (edge i runs loop[i] → loop[i+1]).
 * Output: for each edge index i, its label ("A".."Z", then "AA"…).
 * Northernmost = edge whose midpoint has the greatest +Y (north); ties break west
 * (smaller X). Clockwise is walked in plan coordinates (+X east, +Y north).
 */
export function labelWalls(loop: readonly Vec2[]): string[] {
  const n = loop.length;
  if (n < 3) return loop.map((_, i) => indexToLabel(i));

  // Edge order in clockwise traversal, expressed as original edge indices.
  const cw = isClockwise(loop);
  // Original edge i connects loop[i] -> loop[(i+1)%n].
  const mids = loop.map((v, i) => midpoint(v, loop[(i + 1) % n]!));
  let startEdge = 0;
  for (let i = 1; i < n; i++) {
    const m = mids[i]!;
    const best = mids[startEdge]!;
    if (m.y > best.y + 1e-9 || (Math.abs(m.y - best.y) <= 1e-9 && m.x < best.x - 1e-9)) {
      startEdge = i;
    }
  }

  const labels = new Array<string>(n);
  for (let k = 0; k < n; k++) {
    // Walk edges in clockwise order starting at startEdge.
    const edge = cw ? (startEdge + k) % n : (startEdge - k + n * 2) % n;
    labels[edge] = indexToLabel(k);
  }
  return labels;
}

export function indexToLabel(i: number): string {
  let label = "";
  let x = i;
  do {
    label = String.fromCharCode(65 + (x % 26)) + label;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return label;
}
