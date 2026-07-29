import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveSnap, CLOSURE_SNAP_M, GRID_MIN_PX_PER_M, GRID_STEP_M } from "../src/snap.js";
import { dist } from "../src/vec.js";

const zooms = fc.double({ min: 5, max: 400, noNaN: true }); // 1:200 → 1:10 spans ~19→378 px/m

describe("resolveSnap priorities (docs/04 §4) at every zoom level (docs/04 §7)", () => {
  it("closure beats everything within its radius", () => {
    fc.assert(
      fc.property(zooms, fc.double({ min: 0, max: CLOSURE_SNAP_M - 0.001, noNaN: true }), (pxPerMeter, d) => {
        const origin = { x: 3, y: 4 };
        const res = resolveSnap(
          { x: origin.x + d, y: origin.y },
          { origin, vertices: [origin, { x: 3.1, y: 4 }], prev: { x: 0, y: 4 }, pxPerMeter },
        );
        expect(res.kind).toBe("closure");
        expect(res.point).toEqual(origin);
      }),
    );
  });

  it("vertex snap radius is screen-space: 12 px at any zoom", () => {
    fc.assert(
      fc.property(zooms, (pxPerMeter) => {
        const v = { x: 5, y: 5 };
        const inside = { x: 5 + 11 / pxPerMeter, y: 5 };
        const outside = { x: 5 + 14 / pxPerMeter, y: 5 };
        expect(resolveSnap(inside, { vertices: [v], pxPerMeter }).kind).toBe("vertex");
        expect(resolveSnap(outside, { vertices: [v], pxPerMeter }).kind).not.toBe("vertex");
      }),
    );
  });

  it("ortho snaps within 4° of horizontal and preserves exact axis coordinates", () => {
    fc.assert(
      fc.property(zooms, fc.double({ min: -3.9, max: 3.9, noNaN: true }), (pxPerMeter, deg) => {
        const prev = { x: 1, y: 1 };
        const r = 3;
        const a = (deg * Math.PI) / 180;
        const raw = { x: prev.x + Math.cos(a) * r, y: prev.y + Math.sin(a) * r };
        const res = resolveSnap(raw, { prev, pxPerMeter: Math.min(pxPerMeter, GRID_MIN_PX_PER_M - 1) });
        expect(res.kind).toBe("ortho");
        expect(res.point.y).toBe(prev.y);
        expect(dist(res.point, prev)).toBeCloseTo(r, 9);
      }),
    );
  });

  it("ortho respects the disable modifier", () => {
    const prev = { x: 0, y: 0 };
    const raw = { x: 3, y: 0.05 };
    expect(resolveSnap(raw, { prev, pxPerMeter: 50 }).kind).toBe("ortho");
    expect(resolveSnap(raw, { prev, pxPerMeter: 50, orthoDisabled: true }).kind).toBe("none");
  });

  it("alignment guide snaps X to a vertex within 6 px", () => {
    const pxPerMeter = 100;
    const v = { x: 2, y: 9 };
    const res = resolveSnap({ x: 2 + 4 / pxPerMeter, y: 5 }, { vertices: [v], pxPerMeter });
    expect(res.kind).toBe("guide");
    expect(res.point.x).toBe(2);
    expect(res.guides[0]).toEqual({ axis: "v", through: v });
  });

  it("grid snaps to 0.05 m only when zoomed past 1:50", () => {
    const raw = { x: 1.234, y: 5.678 };
    const zoomed = resolveSnap(raw, { pxPerMeter: GRID_MIN_PX_PER_M + 10 });
    expect(zoomed.kind).toBe("grid");
    expect(zoomed.point.x).toBeCloseTo(Math.round(raw.x / GRID_STEP_M) * GRID_STEP_M, 9);
    const wide = resolveSnap(raw, { pxPerMeter: GRID_MIN_PX_PER_M - 20 });
    expect(wide.kind).toBe("none");
    expect(wide.point).toEqual(raw);
  });
});
