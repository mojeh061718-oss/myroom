import { describe, expect, it } from "vitest";
import type { PlacedObject, Scene } from "@myroom/schema";
import { regressions, scoreRoom, type GoldenTruth } from "../src/golden.js";

const object = (category: string, x: number, z: number, size: { w: number; d: number; h: number }, catalogId: string | null = null): PlacedObject => ({
  id: `${category}-${x}-${z}`,
  catalogId,
  placeholder: catalogId ? null : { category, shape: `${category}Massing` },
  importedAssetId: null,
  label: category,
  support: "floor",
  wallId: null,
  parentObjectId: null,
  position: { x, y: 0, z },
  rotationY: 0,
  size,
  materials: {},
  collisionExempt: false,
  recon: null,
});

const scene = (objects: PlacedObject[]): Scene => ({
  schemaVersion: 1,
  id: "scene",
  planId: "plan",
  objects,
  finishes: {
    walls: {},
    floor: { color: "#B99A72" },
    ceiling: { color: "#F4F2EC" },
    baseboard: { color: "#FFFFFF", height: 0.09 },
  },
  lighting: { hdri: "procedural-room-01", keyIntensity: 1 },
  provenance: { tier: "photo", reconstructionJobId: null, generatedAt: new Date().toISOString() },
});

const SOFA = { w: 2.1, d: 0.9, h: 0.84 };
const TABLE = { w: 1.1, d: 0.6, h: 0.42 };

const truth: GoldenTruth = {
  room: "living-room-01",
  tier: "photo",
  objects: [
    { category: "sofa", position: { x: 1, y: 0, z: -1 }, size: SOFA },
    { category: "coffee-table", position: { x: 1, y: 0, z: -2.2 }, size: TABLE },
  ],
};

describe("golden-room scoring (docs/05 §9)", () => {
  it("passes a room reconstructed inside the photo-calibrated targets", () => {
    const score = scoreRoom(
      truth,
      scene([
        object("sofa", 1.08, -1.05, { w: 2.15, d: 0.92, h: 0.85 }, "sofa/one"),
        object("coffee-table", 0.95, -2.28, { w: 1.05, d: 0.62, h: 0.43 }),
      ]),
    );
    expect(score.passes).toBe(true);
    expect(score.recall).toBe(1);
    expect(score.matched).toHaveLength(2);
    expect(score.matchQuality).toBeCloseTo(0.5);
  });

  it("fails on the 90th percentile, not the median", () => {
    // Three of four objects are perfect; one is 80 cm out. The median says
    // "excellent", and the room is still not ±15 cm.
    const wide: GoldenTruth = {
      room: "spread",
      tier: "photo",
      objects: [0, 1, 2, 3].map((i) => ({
        category: "dining-chair",
        position: { x: i, y: 0, z: 0 },
        size: { w: 0.46, d: 0.52, h: 0.9 },
      })),
    };
    const score = scoreRoom(
      wide,
      scene([
        object("dining-chair", 0, 0, { w: 0.46, d: 0.52, h: 0.9 }),
        object("dining-chair", 1, 0, { w: 0.46, d: 0.52, h: 0.9 }),
        object("dining-chair", 2, 0, { w: 0.46, d: 0.52, h: 0.9 }),
        object("dining-chair", 3.8, 0, { w: 0.46, d: 0.52, h: 0.9 }),
      ]),
    );
    expect(score.medianPositionError).toBeLessThan(0.15);
    expect(score.passes).toBe(false);
    expect(score.failures.join(" ")).toContain("position");
  });

  it("counts a missed sofa against recall but ignores missed clutter", () => {
    const withClutter: GoldenTruth = {
      room: "clutter",
      tier: "photo",
      objects: [
        ...truth.objects,
        { category: "photo-frame", position: { x: 2, y: 0.6, z: -2 }, size: { w: 0.2, d: 0.06, h: 0.25 } },
      ],
    };
    // Only the sofa found: 1 of 2 major objects → 50% recall.
    const score = scoreRoom(withClutter, scene([object("sofa", 1, -1, SOFA)]));
    expect(score.recall).toBe(0.5);
    expect(score.passes).toBe(false);
    expect(score.missed.map((m) => m.category)).toContain("coffee-table");
  });

  it("never associates two truths with one object, or across categories", () => {
    const twoSofas: GoldenTruth = {
      room: "pair",
      tier: "photo",
      objects: [
        { category: "sofa", position: { x: 0, y: 0, z: 0 }, size: SOFA },
        { category: "sofa", position: { x: 0.4, y: 0, z: 0 }, size: SOFA },
      ],
    };
    const score = scoreRoom(twoSofas, scene([object("sofa", 0.05, 0, SOFA)]));
    expect(score.matched).toHaveLength(1);
    expect(score.missed).toHaveLength(1);

    // A coffee table standing exactly where the sofa should be is not the sofa.
    const wrongClass = scoreRoom(truth, scene([object("coffee-table", 1, -1, SOFA)]));
    expect(wrongClass.matched.every((m) => m.truth.category === "coffee-table")).toBe(true);
  });

  it("recovers the category from a catalog id", () => {
    const score = scoreRoom(truth, scene([object("sofa", 1, -1, SOFA, "sofa/polyhaven-01")]));
    expect(score.matched).toHaveLength(1);
    expect(score.matchQuality).toBe(1);
  });

  it("holds LiDAR rooms to the tighter target", () => {
    const lidar: GoldenTruth = { ...truth, tier: "lidar" };
    const drift = scene([
      object("sofa", 1.1, -1, SOFA),
      object("coffee-table", 1.1, -2.2, TABLE),
    ]);
    // 10 cm passes as photo-calibrated and fails as LiDAR-verified.
    expect(scoreRoom(truth, drift).passes).toBe(true);
    expect(scoreRoom(lidar, drift).passes).toBe(false);
  });

  it("blocks a change that makes a passing room worse", () => {
    const score = scoreRoom(
      truth,
      scene([object("sofa", 1.12, -1, SOFA), object("coffee-table", 1, -2.2, TABLE)]),
    );
    const baseline = { "living-room-01": { p90PositionError: 0.02, medianSizeError: 0.01, recall: 1 } };
    expect(regressions([score], baseline)).toHaveLength(1);
    expect(regressions([score], baseline)[0]).toContain("position p90 regressed");
    // Unknown rooms are not regressions — a new fixture has no history.
    expect(regressions([score], {})).toHaveLength(0);
  });
});
