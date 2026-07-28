import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomPlanSchema } from "../src/roomplan.js";
import {
  CapturePlanSchema,
  JobEventSchema,
  MeasuredObjectSchema,
  ScanParseSchema,
  capturePlanFor,
  missingWallShots,
} from "../src/reconstruction.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (file: string) => RoomPlanSchema.parse(JSON.parse(readFileSync(join(fixturesDir, file), "utf8")));

describe("capture plan (docs/01 §6)", () => {
  it("requires exactly one photo per wall", () => {
    const plan = load("plan-rectangle.json");
    const capture = capturePlanFor(plan);
    expect(CapturePlanSchema.parse(capture)).toEqual(capture);

    const wallShots = capture.shots.filter((s) => s.kind === "wall");
    expect(wallShots).toHaveLength(plan.walls.length);
    expect(wallShots.every((s) => s.required)).toBe(true);
    expect(wallShots.map((s) => s.wallLabels[0]).sort()).toEqual(plan.walls.map((w) => w.label).sort());
  });

  it("adds one wide shot per opposing corner pair, and never asks twice", () => {
    const plan = load("plan-rectangle.json");
    const corners = capturePlanFor(plan).shots.filter((s) => s.kind === "corner");
    // A rectangle has two diagonals, not four.
    expect(corners).toHaveLength(2);
    expect(new Set(corners.map((s) => s.id)).size).toBe(2);
    expect(corners.every((s) => !s.required)).toBe(true);
  });

  it("scales the corner set to the room's shape", () => {
    const l = capturePlanFor(load("plan-l-shape.json")).shots.filter((s) => s.kind === "corner");
    expect(l).toHaveLength(3); // 6 vertices → 3 diagonals
  });

  it("reports which walls are still missing", () => {
    const plan = load("plan-rectangle.json");
    const [first, second] = plan.walls.map((w) => w.label);
    expect(missingWallShots(plan, [first!, second!])).toEqual(
      plan.walls.slice(2).map((w) => w.label),
    );
    expect(missingWallShots(plan, plan.walls.map((w) => w.label))).toEqual([]);
  });
});

describe("pipeline artifacts", () => {
  it("a measured object always names the photos it came from", () => {
    const base = {
      id: "m1",
      category: "sofa",
      position: { x: 1, y: 0.4, z: -1 },
      rotationY: 0,
      size: { w: 2.1, d: 0.9, h: 0.8 },
      support: "floor",
      confidence: 0.8,
      lowConfidence: false,
    };
    expect(MeasuredObjectSchema.safeParse({ ...base, sourcePhotoIds: ["p1"] }).success).toBe(true);
    expect(MeasuredObjectSchema.safeParse({ ...base, sourcePhotoIds: [] }).success).toBe(false);
  });

  it("a scan that failed to parse still validates, carrying its reason (docs/05 §8)", () => {
    const parsed = ScanParseSchema.parse({
      format: "e57",
      parsed: false,
      failure: "unsupported point record type",
      walls: [],
      ceilingHeight: null,
      seedBoxes: [],
      disagreements: [],
    });
    expect(parsed.parsed).toBe(false);
    expect(parsed.silhouette).toEqual([]);
  });

  it("job events are a closed union — an unknown event type is rejected", () => {
    expect(JobEventSchema.safeParse({ type: "stage", stage: "detect-segment", progress: 0.5 }).success).toBe(true);
    expect(JobEventSchema.safeParse({ type: "vibes", mood: "good" }).success).toBe(false);
  });
});
