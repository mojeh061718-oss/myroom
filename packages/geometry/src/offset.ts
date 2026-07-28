import { type Vec2, add, sub, scale, normalize, perp, cross, dot } from "./vec.js";
import { signedArea } from "./polygon.js";

/**
 * Mitered offset of a closed polygon (docs/06 §1 — walls must meet cleanly at
 * corners rather than overlapping boxes, or the shell shows seams from inside).
 *
 * `distances[i]` is how far edge i moves along its own normal. Positive is to
 * the LEFT of the directed edge, which for a counter-clockwise loop in plan
 * coordinates is the polygon interior. Per-edge distances let walls carry
 * different thicknesses (docs/04 §1).
 *
 * Corners are solved by intersecting the two offset edge lines. Near-parallel
 * corners fall back to the averaged offset point, and miters are clamped so a
 * very sharp corner can't shoot a spike across the room.
 */
export function offsetPolygon(
  loop: readonly Vec2[],
  distances: readonly number[],
  miterLimit = 8,
): Vec2[] {
  const n = loop.length;
  if (n < 3) return [...loop];

  const ccw = signedArea(loop) > 0;
  const out: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n;
    // Vertex i is shared by edge iPrev (loop[iPrev] → loop[i]) and edge i.
    const aStart = loop[iPrev]!;
    const aEnd = loop[i]!;
    const bStart = loop[i]!;
    const bEnd = loop[(i + 1) % n]!;

    const dirA = normalize(sub(aEnd, aStart));
    const dirB = normalize(sub(bEnd, bStart));
    // perp() is the left-hand normal; flip for clockwise loops so "positive
    // distance" always means the same side of the wall.
    const sign = ccw ? 1 : -1;
    const nA = scale(perp(dirA), sign);
    const nB = scale(perp(dirB), sign);

    const dA = distances[iPrev] ?? 0;
    const dB = distances[i] ?? 0;

    const pA = add(aEnd, scale(nA, dA));
    const pB = add(bStart, scale(nB, dB));

    const denom = cross(dirA, dirB);
    if (Math.abs(denom) < 1e-9) {
      // Collinear (or reversed): no miter to solve.
      out.push({ x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 });
      continue;
    }

    // Intersect line(pA, dirA) with line(pB, dirB).
    const t = cross(sub(pB, pA), dirB) / denom;
    const hit = add(pA, scale(dirA, t));

    // Clamp runaway miters at very acute corners.
    const maxLen = miterLimit * Math.max(Math.abs(dA), Math.abs(dB), 1e-6);
    const fromVertex = sub(hit, loop[i]!);
    if (dot(fromVertex, fromVertex) > maxLen * maxLen) {
      const clamped = add(loop[i]!, scale(normalize(fromVertex), maxLen));
      out.push(clamped);
    } else {
      out.push(hit);
    }
  }
  return out;
}

/**
 * Inner and outer wall faces for a closed room polygon.
 * `thickness[i]` is wall i's full thickness; the wall is centred on the drawn
 * line, so each face sits half a thickness away (docs/04 §1).
 */
export function wallFacePolygons(
  loop: readonly Vec2[],
  thickness: readonly number[],
): { inner: Vec2[]; outer: Vec2[] } {
  const half = thickness.map((t) => t / 2);
  return {
    inner: offsetPolygon(loop, half),
    outer: offsetPolygon(loop, half.map((h) => -h)),
  };
}
