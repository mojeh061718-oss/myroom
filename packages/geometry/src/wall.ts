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
 * Typed dimensions on a closed loop (docs/04 §4) without shearing the room.
 *
 * Sliding only the edited wall's end vertex turns a rectangle into a
 * trapezoid — the one thing nobody typing "12'" wants. Instead the correction
 * is propagated: the end vertex moves along the wall direction, every
 * following vertex whose outgoing edge is near-perpendicular to the edited
 * wall translates with it, and the first near-parallel edge absorbs the delta
 * by changing length. For a rectangle that means the opposite wall keeps its
 * length and the two side walls grow or shrink together — the room stays
 * rectangular.
 *
 * `loop` is the closed vertex ring (edge i runs loop[i] → loop[(i+1)%n]).
 * Returns the new ring, or null when the shape can't be preserved this way
 * (diagonal walls in the path, the absorbing edge would collapse or flip) —
 * callers fall back to the simple end-vertex slide.
 */
export function resolveLoopWallLength(
  loop: readonly Vec2[],
  edgeIndex: number,
  newLength: number,
  angleToleranceDeg = 5,
): Vec2[] | null {
  const n = loop.length;
  if (n < 3 || newLength <= 0 || edgeIndex < 0 || edgeIndex >= n) return null;
  const p0 = loop[edgeIndex]!;
  const p1 = loop[(edgeIndex + 1) % n]!;
  const current = dist(p0, p1);
  if (current === 0) return null;
  const dir = normalize(sub(p1, p0));
  const delta = scale(dir, newLength - current);

  const sinTol = Math.sin((angleToleranceDeg * Math.PI) / 180);
  const cosTol = Math.cos((angleToleranceDeg * Math.PI) / 180);

  const out = loop.map((p) => ({ ...p }));
  out[(edgeIndex + 1) % n] = add(p1, delta);

  for (let k = 2; k <= n; k++) {
    const fromIdx = (edgeIndex + k - 1) % n;
    const toIdx = (edgeIndex + k) % n;
    const edge = sub(loop[toIdx]!, loop[fromIdx]!);
    const len = dist(loop[fromIdx]!, loop[toIdx]!);
    if (len === 0) return null;
    const dot = (edge.x * dir.x + edge.y * dir.y) / len;

    if (Math.abs(dot) >= cosTol) {
      // Near-parallel: this edge absorbs the delta. Refuse when that would
      // collapse it or flip its direction.
      const absorbed = sub(out[toIdx]!, out[fromIdx]!);
      const along = absorbed.x * edge.x + absorbed.y * edge.y;
      if (along <= 0 || dist(out[fromIdx]!, out[toIdx]!) < 1e-6) return null;
      return out;
    }
    if (Math.abs(dot) <= sinTol) {
      if (toIdx === edgeIndex) return null; // walked the whole loop, nothing absorbed
      out[toIdx] = add(loop[toIdx]!, delta);
      continue;
    }
    return null; // diagonal — can't preserve the shape, let the caller fall back
  }
  return null;
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
