import { type Vec2, sub, cross } from "./vec.js";
import { signedArea } from "./polygon.js";

const EPS = 1e-12;

function isConvex(prev: Vec2, cur: Vec2, next: Vec2): boolean {
  return cross(sub(cur, prev), sub(next, cur)) > 0;
}

/** Barycentric containment, inclusive of edges. */
function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon (docs/06 §1 — the floor and
 * ceiling of an L-shaped or irregular room are concave, so a fan won't do).
 *
 * Returns triangle indices into the input loop, always counter-clockwise in
 * plan coordinates. O(n²), which is irrelevant at room scale (≤ 20 walls).
 */
export function triangulate(loop: readonly Vec2[]): number[] {
  const n = loop.length;
  if (n < 3) return [];

  // Work counter-clockwise so "convex" is a consistent test.
  const ccw = signedArea(loop) > 0;
  const idx = Array.from({ length: n }, (_, i) => (ccw ? i : n - 1 - i));

  const triangles: number[] = [];
  const remaining = [...idx];
  let guard = 0;

  while (remaining.length > 3) {
    if (guard++ > n * n + 16) break; // degenerate input; emit what we have
    let clipped = false;

    for (let i = 0; i < remaining.length; i++) {
      const iPrev = remaining[(i - 1 + remaining.length) % remaining.length]!;
      const iCur = remaining[i]!;
      const iNext = remaining[(i + 1) % remaining.length]!;
      const prev = loop[iPrev]!;
      const cur = loop[iCur]!;
      const next = loop[iNext]!;

      if (!isConvex(prev, cur, next)) continue;

      // An ear contains no other vertex of the polygon.
      let contains = false;
      for (const other of remaining) {
        if (other === iPrev || other === iCur || other === iNext) continue;
        if (pointInTriangle(loop[other]!, prev, cur, next)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      triangles.push(iPrev, iCur, iNext);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // no ear found — malformed polygon
  }

  if (remaining.length === 3) {
    triangles.push(remaining[0]!, remaining[1]!, remaining[2]!);
  }
  return triangles;
}
