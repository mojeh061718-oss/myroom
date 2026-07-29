import { type Vec2, sub, cross, dist } from "./vec.js";

const EPS = 1e-9;

/** Orientation of ordered triple: >0 counter-clockwise, <0 clockwise, 0 collinear. */
export function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return cross(sub(b, a), sub(c, a));
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.abs(orient(a, b, p)) <= EPS &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/**
 * True when segments [p1,p2] and [p3,p4] intersect.
 * With `ignoreSharedEndpoints`, touching only at a shared endpoint does not count —
 * the case for chained walls that legitimately meet at a vertex.
 */
export function segmentsIntersect(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  p4: Vec2,
  ignoreSharedEndpoints = false,
): boolean {
  if (ignoreSharedEndpoints) {
    const shared = (a: Vec2, b: Vec2) => dist(a, b) <= EPS;
    if (shared(p1, p3) || shared(p1, p4) || shared(p2, p3) || shared(p2, p4)) {
      // Shared endpoint: still an intersection if the segments overlap collinearly.
      const d1 = orient(p3, p4, p1);
      const d2 = orient(p3, p4, p2);
      if (Math.abs(d1) <= EPS && Math.abs(d2) <= EPS) {
        // Collinear — overlapping beyond the shared point?
        const pts = [p1, p2, p3, p4];
        const axis = Math.abs(p4.x - p3.x) > Math.abs(p4.y - p3.y) ? "x" : "y";
        const [s1a, s1b] = [Math.min(p1[axis], p2[axis]), Math.max(p1[axis], p2[axis])];
        const [s2a, s2b] = [Math.min(p3[axis], p4[axis]), Math.max(p3[axis], p4[axis])];
        void pts;
        return Math.min(s1b, s2b) - Math.max(s1a, s2a) > EPS;
      }
      return false;
    }
  }
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);

  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  if (Math.abs(d1) <= EPS && onSegment(p3, p4, p1)) return true;
  if (Math.abs(d2) <= EPS && onSegment(p3, p4, p2)) return true;
  if (Math.abs(d3) <= EPS && onSegment(p1, p2, p3)) return true;
  if (Math.abs(d4) <= EPS && onSegment(p1, p2, p4)) return true;
  return false;
}

/** Twice-signed area via the shoelace formula. Positive = counter-clockwise (Y-up plan). */
export function signedArea(loop: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonArea(loop: readonly Vec2[]): number {
  return Math.abs(signedArea(loop));
}

export function isClockwise(loop: readonly Vec2[]): boolean {
  return signedArea(loop) < 0;
}

/**
 * A valid room is one closed, SIMPLE polygon (docs/04 §1): no two non-adjacent
 * edges intersect, adjacent edges touch only at their shared vertex, area > 0.
 */
export function isSimplePolygon(loop: readonly Vec2[]): boolean {
  const n = loop.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    if (dist(loop[i]!, loop[(i + 1) % n]!) <= EPS) return false; // degenerate edge
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const a1 = loop[i]!;
      const a2 = loop[(i + 1) % n]!;
      const b1 = loop[j]!;
      const b2 = loop[(j + 1) % n]!;
      if (segmentsIntersect(a1, a2, b1, b2, adjacent)) return false;
    }
  }
  return polygonArea(loop) > EPS;
}

/**
 * Ray-casting containment test. Correct for concave rooms, where a bounding-box
 * centre says nothing useful about which side of a wall the interior is on.
 * Points exactly on an edge count as inside.
 */
export function pointInPolygon(p: Vec2, loop: readonly Vec2[]): boolean {
  const n = loop.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = loop[i]!;
    const b = loop[j]!;
    if (Math.abs(orient(a, b, p)) <= EPS && onSegment(a, b, p)) return true;
    const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Input-time guard (docs/04 §5): would appending segment [from,to] to the open
 * chain cross any existing chain segment? The joint with the last segment is
 * exempt (they share `from`), as is closing onto the chain origin.
 */
export function chainSegmentConflicts(chain: readonly Vec2[], from: Vec2, to: Vec2): boolean {
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    if (segmentsIntersect(a, b, from, to, true)) return true;
  }
  return false;
}
