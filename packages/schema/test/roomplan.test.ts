import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { labelWalls, polygonArea } from "@myroom/geometry";
import { RoomPlanSchema, planLoop, wallLength } from "../src/roomplan.js";
import { migrateDocument, CURRENT_SCHEMA_VERSION } from "../src/migrations/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtures = ["plan-rectangle.json", "plan-l-shape.json", "plan-irregular-6.json"];

describe("golden plan fixtures (docs/04 §7: serialize → deserialize → identical)", () => {
  for (const file of fixtures) {
    it(`${file} round-trips byte-stable and satisfies all invariants`, () => {
      const raw = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
      const parsed = RoomPlanSchema.parse(raw);
      // Serialize → deserialize → parse again: structurally identical.
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw);
      expect(RoomPlanSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);

      // Geometry agreement: loop closes, area matches cache, labels match geometry.
      const loop = planLoop(parsed);
      expect(loop).not.toBeNull();
      expect(polygonArea(loop!)).toBeCloseTo(parsed.floorArea!, 6);
      const labels = labelWalls(loop!);
      parsed.walls.forEach((w, i) => expect(w.label).toBe(labels[i]));
    });
  }
});

describe("RoomPlan invariants (docs/07 §2)", () => {
  const base = () => JSON.parse(readFileSync(join(fixturesDir, "plan-rectangle.json"), "utf8"));

  it("rejects an opening exceeding its wall length", () => {
    const doc = base();
    doc.walls[0].openings[0].offset = 5.5; // 5.5 + 1.2 > 6.2
    expect(RoomPlanSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects overlapping openings on one wall", () => {
    const doc = base();
    doc.walls[0].openings.push({
      id: "o-window-2",
      kind: "window",
      offset: 2.5,
      width: 1.0,
      sillHeight: 0.9,
      headHeight: 2.1,
      swing: null,
    });
    expect(RoomPlanSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects out-of-range thickness and height", () => {
    const thick = base();
    thick.walls[0].thickness = 0.6;
    expect(RoomPlanSchema.safeParse(thick).success).toBe(false);
    const tall = base();
    tall.walls[0].height = 6.5;
    expect(RoomPlanSchema.safeParse(tall).success).toBe(false);
  });

  it("rejects a closed plan whose walls don't form one cycle", () => {
    const doc = base();
    doc.walls[3].end = "v-se"; // break the cycle
    expect(RoomPlanSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects a self-intersecting closed plan", () => {
    const doc = base();
    // Swap two vertices to make a bow-tie.
    const [se, sw] = [doc.vertices[2], doc.vertices[3]];
    se.x = 0;
    sw.x = 6.2;
    doc.floorArea = null;
    expect(RoomPlanSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects a cached floorArea that disagrees with the polygon", () => {
    const doc = base();
    doc.floorArea = 12;
    expect(RoomPlanSchema.safeParse(doc).success).toBe(false);
  });

  it("computes wall lengths from vertices", () => {
    const doc = RoomPlanSchema.parse(base());
    expect(wallLength(doc, doc.walls[0]!)).toBeCloseTo(6.2, 9);
    expect(wallLength(doc, doc.walls[1]!)).toBeCloseTo(4.8, 9);
  });
});

describe("migrations", () => {
  it("passes current-version documents through untouched", () => {
    const doc = { schemaVersion: CURRENT_SCHEMA_VERSION, id: "x" };
    expect(migrateDocument(doc)).toEqual(doc);
  });
  it("throws on an unknown future gap", () => {
    expect(() => migrateDocument({ schemaVersion: 0 })).toThrow();
  });
});
