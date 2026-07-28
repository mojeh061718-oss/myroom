import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { chainSegmentConflicts, isSimplePolygon, polygonArea, isClockwise, segmentsIntersect, signedArea } from "../src/polygon.js";
import type { Vec2 } from "../src/vec.js";

/**
 * Random star-shaped polygon, built constructively (no filter — fc.double's
 * boundary bias would reject almost every sample). Angular gaps come from
 * weights in [0.6, 1] normalized to 2π: every gap is then in (0.05, π), so the
 * origin is strictly inside and the angular sort yields a simple polygon.
 */
const starPolygon = (minVerts = 3, maxVerts = 12) =>
  fc
    .array(
      fc.record({
        w: fc.double({ min: 0.6, max: 1, noNaN: true }),
        radius: fc.double({ min: 0.5, max: 10, noNaN: true }),
      }),
      { minLength: minVerts, maxLength: maxVerts },
    )
    .map((pts) => {
      const total = pts.reduce((s, p) => s + p.w, 0);
      let angle = 0;
      return pts.map((p): Vec2 => {
        const v = { x: Math.cos(angle) * p.radius, y: Math.sin(angle) * p.radius };
        angle += (p.w / total) * Math.PI * 2;
        return v;
      });
    });

describe("polygon validation (docs/04 §7 property tests)", () => {
  it("star-shaped polygons are always simple with positive area", () => {
    fc.assert(
      fc.property(starPolygon(), (loop) => {
        expect(isSimplePolygon(loop)).toBe(true);
        expect(polygonArea(loop)).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it("reversing a loop flips orientation but preserves simplicity and area", () => {
    fc.assert(
      fc.property(starPolygon(), (loop) => {
        const rev = [...loop].reverse();
        expect(isSimplePolygon(rev)).toBe(true);
        expect(polygonArea(rev)).toBeCloseTo(polygonArea(loop), 9);
        expect(signedArea(rev)).toBeCloseTo(-signedArea(loop), 9);
        expect(isClockwise(rev)).toBe(!isClockwise(loop));
      }),
      { numRuns: 200 },
    );
  });

  it("rejects the bow-tie (self-intersecting) quad", () => {
    const bowtie: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ];
    expect(isSimplePolygon(bowtie)).toBe(false);
  });

  it("rejects degenerate inputs", () => {
    expect(isSimplePolygon([])).toBe(false);
    expect(isSimplePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(false);
    expect(
      isSimplePolygon([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 4, y: 0 },
      ]),
    ).toBe(false); // collinear, zero area
    expect(
      isSimplePolygon([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false); // repeated vertex
  });

  it("accepts the docs L-shape and rectangle", () => {
    const rect: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6.2, y: 0 },
      { x: 6.2, y: 4.8 },
      { x: 0, y: 4.8 },
    ];
    const lShape: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 5 },
      { x: 0, y: 5 },
    ];
    expect(isSimplePolygon(rect)).toBe(true);
    expect(polygonArea(rect)).toBeCloseTo(29.76, 9);
    expect(isSimplePolygon(lShape)).toBe(true);
    expect(polygonArea(lShape)).toBeCloseTo(24, 9);
  });
});

describe("segment intersection", () => {
  it("detects crossing / non-crossing / touching", () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(false);
    // shared endpoint counts unless exempted
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, true)).toBe(false);
    // collinear overlap through a shared endpoint is still a conflict
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, true)).toBe(true);
  });
});

describe("chain input guard (docs/04 §5 self-intersection prevention)", () => {
  const chain: Vec2[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 3 },
  ];
  it("allows a clean continuation and a clean closure", () => {
    expect(chainSegmentConflicts(chain, { x: 4, y: 3 }, { x: 0, y: 3 })).toBe(false);
    expect(chainSegmentConflicts(chain, { x: 4, y: 3 }, { x: 0, y: 0 })).toBe(false);
  });
  it("rejects a wall crossing an earlier wall", () => {
    expect(chainSegmentConflicts(chain, { x: 4, y: 3 }, { x: 2, y: -2 })).toBe(true);
  });
});
