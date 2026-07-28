import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { indexToLabel, labelWalls, resolveWallLength } from "../src/wall.js";
import { dist, sub, normalize } from "../src/vec.js";
import type { Vec2 } from "../src/vec.js";

const point = fc.record({
  x: fc.double({ min: -50, max: 50, noNaN: true }),
  y: fc.double({ min: -50, max: 50, noNaN: true }),
});

describe("resolveWallLength (docs/04 §7: typed length preserves the fixed endpoint)", () => {
  it("keeps the fixed endpoint exact, hits the new length, preserves direction", () => {
    fc.assert(
      fc.property(
        point,
        point,
        fc.double({ min: 0.3, max: 30, noNaN: true }),
        fc.constantFrom<"start" | "end">("start", "end"),
        (start, end, L, fixed) => {
          fc.pre(dist(start, end) > 1e-6);
          const solved = resolveWallLength(start, end, L, fixed);
          if (fixed === "start") {
            expect(solved.start).toEqual(start); // exact, not approximate
          } else {
            expect(solved.end).toEqual(end);
          }
          expect(dist(solved.start, solved.end)).toBeCloseTo(L, 9);
          const d0 = normalize(sub(end, start));
          const d1 = normalize(sub(solved.end, solved.start));
          expect(d1.x).toBeCloseTo(d0.x, 9);
          expect(d1.y).toBeCloseTo(d0.y, 9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is a no-op for degenerate input", () => {
    const p = { x: 1, y: 2 };
    expect(resolveWallLength(p, p, 3, "start")).toEqual({ start: p, end: p });
    expect(resolveWallLength(p, { x: 2, y: 2 }, 0, "start")).toEqual({ start: p, end: { x: 2, y: 2 } });
  });
});

describe("labelWalls (docs/04 §5: A, B, C… clockwise from northernmost)", () => {
  it("labels a CCW-drawn rectangle clockwise starting at the north wall", () => {
    // Drawn counter-clockwise: south, east, north, west edges.
    const loop: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ];
    // Edge 2 (6,4)→(0,4) is northernmost ⇒ A. Clockwise from north: N→E→S→W,
    // so east=B, south=C, west=D.
    expect(labelWalls(loop)).toEqual(["C", "B", "A", "D"]);
  });

  it("labels a CW-drawn rectangle identically by geometry", () => {
    const loop: Vec2[] = [
      { x: 0, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 0 },
      { x: 0, y: 0 },
    ];
    // Edge 0 is the north wall ⇒ A, then clockwise: east=B, south=C, west=D.
    expect(labelWalls(loop)).toEqual(["A", "B", "C", "D"]);
  });

  it("always produces n unique labels starting with A on the northernmost edge", () => {
    // Constructive star polygon — see polygon.test.ts for why no filter is used.
    const star = fc
      .array(
        fc.record({
          w: fc.double({ min: 0.6, max: 1, noNaN: true }),
          radius: fc.double({ min: 1, max: 10, noNaN: true }),
        }),
        { minLength: 3, maxLength: 10 },
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
    fc.assert(
      fc.property(star, (loop) => {
        const labels = labelWalls(loop);
        expect(new Set(labels).size).toBe(loop.length);
        const mids = loop.map((v, i) => ({
          y: (v.y + loop[(i + 1) % loop.length]!.y) / 2,
          i,
        }));
        const north = mids.reduce((a, b) => (b.y > a.y ? b : a));
        expect(labels[north.i]).toBe("A");
      }),
      { numRuns: 200 },
    );
  });
});

describe("indexToLabel", () => {
  it("handles the alphabet rollover", () => {
    expect(indexToLabel(0)).toBe("A");
    expect(indexToLabel(25)).toBe("Z");
    expect(indexToLabel(26)).toBe("AA");
  });
});
