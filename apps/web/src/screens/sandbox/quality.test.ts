import { describe, expect, it } from "vitest";
import {
  FLOOR_FPS,
  QUALITY_LEVELS,
  SAMPLES_TO_STEP_DOWN,
  SAMPLES_TO_STEP_UP,
  initialGovernorState,
  levelFor,
  stepQuality,
} from "./quality.js";

const run = (fps: number[], start = initialGovernorState()) => fps.reduce(stepQuality, start);

describe("auto quality stepping (docs/06 §8)", () => {
  it("steps down after a sustained drop, not a single bad frame", () => {
    expect(run([20]).level).toBe(0);
    expect(run(Array(SAMPLES_TO_STEP_DOWN).fill(20)).level).toBe(1);
  });

  it("steps down in the order the budget specifies", () => {
    // pixel ratio first, then shadow map, then AO.
    const [best, high, balanced, saver, minimum] = QUALITY_LEVELS;
    expect(high!.pixelRatio).toBeLessThan(best!.pixelRatio);
    expect(balanced!.shadowMapSize).toBeLessThan(high!.shadowMapSize);
    expect(saver!.ao).toBe(false);
    expect(balanced!.ao).toBe(true);
    expect(minimum!.shadowMapSize).toBeLessThan(balanced!.shadowMapSize);
  });

  it("climbs back only with sustained headroom, and more slowly than it fell", () => {
    expect(SAMPLES_TO_STEP_UP).toBeGreaterThan(SAMPLES_TO_STEP_DOWN);
    const dropped = run(Array(SAMPLES_TO_STEP_DOWN).fill(20));
    expect(dropped.level).toBe(1);
    expect(run(Array(SAMPLES_TO_STEP_UP - 1).fill(60), dropped).level).toBe(1);
    expect(run(Array(SAMPLES_TO_STEP_UP).fill(60), dropped).level).toBe(0);
  });

  it("does not oscillate when the frame rate sits between the bands", () => {
    // 45 fps: above the floor, below the headroom. Nothing should move.
    const settled = run(Array(20).fill(45), initialGovernorState(2));
    expect(settled.level).toBe(2);
  });

  it("does not oscillate when the frame rate alternates around the floor", () => {
    const flapping = run(Array(20).fill(0).flatMap(() => [20, 60]));
    // Alternating samples reset each other's counters, so nothing steps.
    expect(flapping.level).toBe(0);
  });

  it("stops at the bottom instead of stepping off the end", () => {
    const floored = run(Array(80).fill(10));
    expect(floored.level).toBe(QUALITY_LEVELS.length - 1);
    expect(FLOOR_FPS).toBeGreaterThan(0);
  });

  it("honours a manual override in both directions (docs/06 §8)", () => {
    expect(levelFor("best", 4)).toBe(QUALITY_LEVELS[0]);
    expect(levelFor("saver", 0).name).toBe("Battery saver");
    expect(levelFor("auto", 2)).toBe(QUALITY_LEVELS[2]);
    // An out-of-range auto index clamps rather than returning undefined.
    expect(levelFor("auto", 99)).toBe(QUALITY_LEVELS[QUALITY_LEVELS.length - 1]);
  });
});
