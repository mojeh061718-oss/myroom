import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomPlanSchema, SceneSchema, planToShell, type MeasuredObject } from "@myroom/schema";
import { getCategory } from "@myroom/catalog";
import type { CatalogItem } from "@myroom/schema";
import { dimensionFit, matchCatalog, MATCH_THRESHOLD } from "../src/match.js";
import { assembleScene, dedupeMeasured, iou3d } from "../src/assemble.js";
import { demoMeasuredObjects } from "../src/demo.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../schema/test/fixtures");
const plan = RoomPlanSchema.parse(JSON.parse(readFileSync(join(fixturesDir, "plan-rectangle.json"), "utf8")));
const shell = planToShell(plan)!;

let counter = 0;
const newId = () => `id-${++counter}`;

const item = (over: Partial<CatalogItem> & Pick<CatalogItem, "id" | "nativeSize">): CatalogItem => ({
  category: "sofa",
  name: over.id,
  asset: { glb: "catalog/models/x.glb", tris: 1000 },
  scaleBounds: { min: 0.8, max: 1.25, nonUniform: true },
  materialSlots: ["upholstery"],
  faceSlot: null,
  support: "floor",
  embedding: null,
  license: "CC0",
  source: "https://polyhaven.com/a/x",
  ...over,
});

const measured = (over: Partial<MeasuredObject> = {}): MeasuredObject => ({
  id: newId(),
  category: "sofa",
  position: { x: 1, y: 0, z: -1 },
  rotationY: 0,
  size: { w: 2.1, d: 0.9, h: 0.84 },
  support: "floor",
  confidence: 0.8,
  sourcePhotoIds: ["p1"],
  lowConfidence: false,
  palette: [],
  faceTextureRef: null,
  ...over,
});

describe("stage 4 — catalog match (docs/05 §6)", () => {
  it("prefers the model that fits the measurement", () => {
    const close = item({ id: "sofa/close", nativeSize: { w: 2.0, d: 0.9, h: 0.85 } });
    const wrong = item({ id: "sofa/loveseat", nativeSize: { w: 1.2, d: 0.8, h: 0.8 } });
    const match = matchCatalog({ measured: measured(), candidates: [wrong, close] });
    expect(match.catalogId).toBe("sofa/close");
    expect(match.runnerUpCatalogIds).toEqual(["sofa/loveseat"]);
  });

  it("falls back to a placeholder rather than forcing a bad match", () => {
    // A 3.6 m sectional against a 1.2 m loveseat: no scale bound reaches it.
    const wrong = item({ id: "sofa/loveseat", nativeSize: { w: 1.2, d: 0.8, h: 0.8 } });
    const match = matchCatalog({ measured: measured({ size: { w: 3.6, d: 1.6, h: 0.9 } }), candidates: [wrong] });
    expect(match.catalogId).toBeNull();
    expect(match.score).toBeLessThan(MATCH_THRESHOLD);
    // Still offers what it had — "no confident match" is not "no options".
    expect(match.runnerUpCatalogIds).toEqual(["sofa/loveseat"]);
  });

  it("penalizes a uniform-scale-only model that would need stretching", () => {
    const uniform = item({
      id: "sofa/uniform",
      nativeSize: { w: 2.1, d: 0.9, h: 0.84 },
      scaleBounds: { min: 0.8, max: 1.25, nonUniform: false },
    });
    const flexible = item({ id: "sofa/flexible", nativeSize: { w: 2.1, d: 0.9, h: 0.84 } });
    // Same native size, but the measurement is wide and shallow.
    const target = measured({ size: { w: 2.5, d: 0.8, h: 0.84 } });
    expect(dimensionFit(flexible, target.size)).toBeGreaterThan(dimensionFit(uniform, target.size));
  });

  it("matches against the shipped catalog without a candidate list", () => {
    const match = matchCatalog({ measured: measured({ category: "bookshelf", size: { w: 0.9, d: 0.3, h: 1.9 } }) });
    // Either a real model or an honest null — never a throw or a wrong category.
    if (match.catalogId) expect(match.catalogId.startsWith("bookshelf/")).toBe(true);
    expect(match.runnerUpCatalogIds.length).toBeLessThanOrEqual(2);
  });
});

describe("stage 6 — assembly (docs/05 §7)", () => {
  it("merges the same object seen from two photos", () => {
    const a = measured({ sourcePhotoIds: ["p1"], confidence: 0.9 });
    const b = measured({ sourcePhotoIds: ["p2"], confidence: 0.6, position: { x: 1.08, y: 0, z: -1.05 } });
    const merged = dedupeMeasured([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sourcePhotoIds.sort()).toEqual(["p1", "p2"]);
    expect(merged[0]!.confidence).toBeCloseTo(0.9);
  });

  it("keeps two genuinely different objects apart", () => {
    const a = measured({ position: { x: 0.6, y: 0, z: -0.6 } });
    const b = measured({ position: { x: 4.5, y: 0, z: -2.5 } });
    expect(dedupeMeasured([a, b])).toHaveLength(2);
    expect(iou3d({ x: 0, y: 0, z: 0, w: 1, d: 1, h: 1 }, { x: 5, y: 0, z: 0, w: 1, d: 1, h: 1 })).toBe(0);
  });

  it("produces a schema-valid scene in which every measured object survives", () => {
    const objects = demoMeasuredObjects(shell, { newId });
    const matches = objects.map((m) => matchCatalog({ measured: m }));
    const { scene } = assembleScene({
      sceneId: newId(),
      planId: plan.id,
      shell,
      measured: objects,
      matches,
      tier: "photo",
      jobId: "job-1",
      now: new Date().toISOString(),
      newId,
    });

    expect(SceneSchema.parse(scene)).toEqual(scene);
    expect(scene.objects).toHaveLength(objects.length);
    // "Never omit a detected object silently": each is either a model or a
    // placeholder, and every one carries its provenance.
    for (const o of scene.objects) {
      expect(o.catalogId === null).toBe(o.placeholder !== null);
      expect(o.recon).not.toBeNull();
      expect(o.recon!.sourcePhotoIds.length).toBeGreaterThan(0);
    }
  });

  it("mounts wall objects on a real wall, facing into the room", () => {
    const tv = measured({
      category: "tv",
      support: "wall",
      size: { w: 1.2, d: 0.07, h: 0.7 },
      position: { x: 1.0, y: 1.15, z: -0.4 },
    });
    const { scene } = assembleScene({
      sceneId: newId(),
      planId: plan.id,
      shell,
      measured: [tv],
      matches: [matchCatalog({ measured: tv })],
      tier: "photo",
      jobId: null,
      now: new Date().toISOString(),
      newId,
    });
    const placed = scene.objects[0]!;
    expect(placed.support).toBe("wall");
    expect(placed.wallId).not.toBeNull();
    const wall = shell.walls.find((w) => w.wallId === placed.wallId)!;
    expect(placed.rotationY).toBeCloseTo(Math.atan2(wall.inwardNormal[0], wall.inwardNormal[2]), 6);
    // Its top cannot poke through the ceiling.
    expect(placed.position.y + placed.size.h).toBeLessThanOrEqual(shell.height + 1e-9);
  });

  it("moves an object that would land inside another one", () => {
    // Different classes: two overlapping sightings of the *same* class are one
    // object (dedupe), but a chair and a table in the same square metre are a
    // collision the assembler has to resolve.
    const first = measured({ category: "armchair", size: { w: 0.8, d: 0.85, h: 0.9 }, position: { x: 1.2, y: 0, z: -1.2 } });
    const second = measured({
      category: "side-table",
      size: { w: 0.6, d: 0.6, h: 0.55 },
      position: { x: 1.3, y: 0, z: -1.25 },
      confidence: 0.5,
      sourcePhotoIds: ["p2"],
    });
    const { scene, warnings } = assembleScene({
      sceneId: newId(),
      planId: plan.id,
      shell,
      measured: [first, second],
      matches: [],
      tier: "photo",
      jobId: null,
      now: new Date().toISOString(),
      newId,
    });
    expect(scene.objects).toHaveLength(2);
    const [a, b] = scene.objects;
    const apart = Math.hypot(a!.position.x - b!.position.x, a!.position.z - b!.position.z);
    expect(apart).toBeGreaterThan(0.5);
    expect(warnings.some((w) => w.includes("overlapped"))).toBe(true);
  });

  it("sits a surface object on the thing beneath it, or drops it to the floor", () => {
    const table = measured({ category: "side-table", size: { w: 0.5, d: 0.5, h: 0.55 }, position: { x: 2, y: 0, z: -2 } });
    const lamp = measured({
      category: "table-lamp",
      support: "surface",
      size: { w: 0.3, d: 0.3, h: 0.45 },
      position: { x: 2.02, y: 0.55, z: -2.01 },
    });
    const orphan = measured({
      category: "table-lamp",
      support: "surface",
      size: { w: 0.3, d: 0.3, h: 0.45 },
      position: { x: 5.2, y: 0.6, z: -3.0 },
    });
    const { scene } = assembleScene({
      sceneId: newId(),
      planId: plan.id,
      shell,
      measured: [table, lamp, orphan],
      matches: [],
      tier: "photo",
      jobId: null,
      now: new Date().toISOString(),
      newId,
    });
    const onTable = scene.objects.find((o) => o.support === "surface");
    expect(onTable?.parentObjectId).not.toBeNull();
    // The one with nothing under it became a floor object rather than floating.
    const floated = scene.objects.filter((o) => o.support === "surface" && o.parentObjectId === null);
    expect(floated).toHaveLength(0);
  });
});

describe("demo fixture generator", () => {
  it("lays out a room that fits inside its own walls", () => {
    const objects = demoMeasuredObjects(shell, { newId });
    expect(objects.length).toBeGreaterThan(4);
    for (const o of objects) {
      expect(getCategory(o.category)).toBeDefined();
      expect(o.position.x).toBeGreaterThanOrEqual(shell.bounds.min[0] - 0.01);
      expect(o.position.x).toBeLessThanOrEqual(shell.bounds.max[0] + 0.01);
    }
  });

  it("is deterministic — same shell, same layout", () => {
    let a = 0;
    let b = 0;
    const one = demoMeasuredObjects(shell, { newId: () => `a-${++a}` });
    const two = demoMeasuredObjects(shell, { newId: () => `b-${++b}` });
    expect(one.map((o) => [o.category, o.position.x, o.position.z])).toEqual(
      two.map((o) => [o.category, o.position.x, o.position.z]),
    );
  });
});
