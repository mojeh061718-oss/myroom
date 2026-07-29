import { describe, expect, it } from "vitest";

import { triangulate } from "../src/triangulate.js";

/** Shoelace area of a closed loop. */
function polygonArea(loop: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Total area of the emitted triangle fan. */
function triangulatedArea(loop: { x: number; y: number }[], indices: number[]): number {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = loop[indices[i]!]!;
    const b = loop[indices[i + 1]!]!;
    const c = loop[indices[i + 2]!]!;
    total += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }
  return total;
}

describe("triangulate covers the whole polygon", () => {
  it("tiles a simple rectangle", () => {
    const loop = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 4 },
      { x: 0, y: 4 },
    ];
    const indices = triangulate(loop);
    expect(triangulatedArea(loop, indices)).toBeCloseTo(polygonArea(loop), 6);
  });

  it("tiles an L-shaped room", () => {
    const loop = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: 0, y: 6 },
    ];
    const indices = triangulate(loop);
    expect(triangulatedArea(loop, indices)).toBeCloseTo(polygonArea(loop), 6);
  });

  it("tiles a room with a narrow alcove", () => {
    // The reported repro: a 5x4 room with a 0.35 x 0.35 alcove. Every edge is
    // above the 0.3 m minimum wall length, so the drawing board accepts it.
    const loop = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 4 },
      { x: 2.35, y: 4 },
      { x: 2.35, y: 4.35 },
      { x: 2, y: 4.35 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];
    const expected = polygonArea(loop);
    const indices = triangulate(loop);
    const actual = triangulatedArea(loop, indices);

    // A partial fan here means the rendered floor has a hole in it.
    expect(actual).toBeCloseTo(expected, 6);
    expect(indices.length / 3).toBe(loop.length - 2);
  });

  it("emits a complete fan for every vertex count it accepts", () => {
    // A regular polygon is the easy case; the point is that the triangle count
    // is always n-2 and never a truncated partial result.
    for (const n of [3, 4, 5, 6, 8, 12]) {
      const loop = Array.from({ length: n }, (_, i) => ({
        x: Math.cos((2 * Math.PI * i) / n) * 3,
        y: Math.sin((2 * Math.PI * i) / n) * 3,
      }));
      const indices = triangulate(loop);
      expect(indices.length / 3, `n=${n}`).toBe(n - 2);
      expect(triangulatedArea(loop, indices)).toBeCloseTo(polygonArea(loop), 6);
    }
  });
});
