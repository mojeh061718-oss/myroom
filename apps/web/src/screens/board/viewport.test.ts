import { describe, expect, it } from "vitest";
import { formatLength } from "@myroom/geometry";
import { scaleBarMeters, toPlan, toScreen } from "./viewport.js";

describe("scale bar", () => {
  it("steps in round metres when the display is metric", () => {
    for (const ppm of [20, 40, 60, 120, 300]) {
      const bar = scaleBarMeters(ppm, "m");
      expect([0.1, 0.2, 0.5, 1, 2, 5, 10]).toContain(Math.round(bar * 100) / 100);
    }
  });

  it("steps in round feet when the display is imperial", () => {
    // A bar labelled `3'3¼"` is a metre wearing a disguise — it tells an
    // imperial reader nothing about the scale they are looking at.
    for (const ppm of [20, 40, 60, 120, 300]) {
      const label = formatLength(scaleBarMeters(ppm, "ft"), "ft");
      expect(label).toMatch(/^\d+'$|^\d+"$/);
    }
  });

  it("stays close to the 80 px target at every zoom", () => {
    for (const ppm of [20, 40, 60, 120, 300]) {
      for (const unit of ["m", "ft"] as const) {
        const px = scaleBarMeters(ppm, unit) * ppm;
        expect(px).toBeGreaterThan(20);
        expect(px).toBeLessThan(260);
      }
    }
  });

  it("defaults to metric when no unit is given", () => {
    expect(scaleBarMeters(60)).toBe(scaleBarMeters(60, "m"));
  });
});

describe("screen ↔ plan", () => {
  it("round-trips a point through both transforms", () => {
    const v = { cx: 1.5, cy: -2.25, ppm: 73 };
    const point = { x: 3.4, y: -1.1 };
    const back = toPlan(toScreen(point, v, 400, 800), v, 400, 800);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("puts plan north above plan south on screen", () => {
    const v = { cx: 0, cy: 0, ppm: 60 };
    const north = toScreen({ x: 0, y: 1 }, v, 400, 800);
    const south = toScreen({ x: 0, y: -1 }, v, 400, 800);
    expect(north.y).toBeLessThan(south.y);
  });
});
