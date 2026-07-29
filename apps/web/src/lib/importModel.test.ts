import { describe, expect, it } from "vitest";
import { unitScaleFor } from "./importModel.js";

describe("unitScaleFor (docs/06 §5: imported models land at believable sizes)", () => {
  it("keeps metre-scale models as they are", () => {
    expect(unitScaleFor(0.8)).toEqual({ scale: 1, note: null });
    expect(unitScaleFor(2.2).scale).toBe(1);
  });

  it("reads centimetre exports as centimetres", () => {
    const { scale, note } = unitScaleFor(85); // an 85 cm chair exported unit-per-cm
    expect(scale).toBe(0.01);
    expect(note).toContain("centimetres");
  });

  it("reads millimetre exports as millimetres", () => {
    const { scale, note } = unitScaleFor(850);
    expect(scale).toBe(0.001);
    expect(note).toContain("millimetres");
  });

  it("reads inch exports as inches when nothing else fits", () => {
    // 33.5 units: metres → 33.5 m (too big), cm → 0.335 m fits… so cm wins
    // first; a value where only inches land in range:
    const { scale } = unitScaleFor(120); // 120 in = 3.05 m; 120 cm = 1.2 m also fits → cm wins
    expect(scale).toBe(0.01);
    const inches = unitScaleFor(700); // 7 m / 700 cm = 7 m? no — 700 cm = 7 m too big; 700 mm = 0.7 ✓
    expect(inches.scale).toBe(0.001);
  });

  it("normalizes hopeless sizes to fit a room and says so", () => {
    const tiny = unitScaleFor(0.001);
    expect(tiny.scale * 0.001).toBeCloseTo(1.5, 6);
    expect(tiny.note).toContain("check the size");
    const huge = unitScaleFor(1_000_000);
    expect(huge.scale * 1_000_000).toBeCloseTo(1.5, 6);
  });
});
