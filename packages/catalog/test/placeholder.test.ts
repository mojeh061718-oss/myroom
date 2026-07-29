import { describe, expect, it } from "vitest";
import { OBJECT_CATEGORIES } from "../src/taxonomy.js";
import { archetypeFor, placeholderParts } from "../src/placeholder.js";

describe("parametric object geometry (docs/05 §6)", () => {
  it("produces parts for every single category — nothing is ever unrenderable", () => {
    for (const c of OBJECT_CATEGORIES) {
      const parts = placeholderParts(c.id);
      expect(parts.length, c.id).toBeGreaterThan(0);
    }
  });

  it("keeps every part inside the object's unit bounding box", () => {
    for (const c of OBJECT_CATEGORIES) {
      for (const p of placeholderParts(c.id)) {
        const [px, py, pz] = p.position;
        const [sx, sy, sz] = p.size;
        expect(Math.abs(px) + sx / 2, `${c.id} x`).toBeLessThanOrEqual(0.51);
        expect(Math.abs(pz) + sz / 2, `${c.id} z`).toBeLessThanOrEqual(0.51);
        expect(py - sy / 2, `${c.id} y-min`).toBeGreaterThanOrEqual(-0.01);
        expect(py + sy / 2, `${c.id} y-max`).toBeLessThanOrEqual(1.01);
      }
    }
  });

  it("only paints slots the category actually declares", () => {
    for (const c of OBJECT_CATEGORIES) {
      const allowed = new Set([...c.materialSlots, c.faceSlot, "pot", "body"].filter(Boolean));
      for (const p of placeholderParts(c.id)) {
        expect(allowed.has(p.slot), `${c.id} slot ${p.slot}`).toBe(true);
      }
    }
  });

  it("gives recognisable archetypes to the headline categories", () => {
    const expected: Record<string, string> = {
      sofa: "seating",
      ottoman: "chair",
      "coffee-table": "table",
      cabinet: "storage",
      microwave: "appliance",
      "air-fryer": "appliance",
      "ceiling-fan": "fan",
      "framed-picture": "flat",
      tv: "screen",
      rug: "rug",
      "floor-lamp": "lamp",
      "floor-plant": "plant",
      bed: "bed",
      "coat-rack": "stand",
    };
    for (const [id, arch] of Object.entries(expected)) {
      const c = OBJECT_CATEGORIES.find((x) => x.id === id)!;
      expect(archetypeFor(c), id).toBe(arch);
    }
  });

  it("stays cheap enough for a furnished room's triangle budget", () => {
    // Worst-case parts per object, against the docs/06 §8 300k triangle budget.
    const max = Math.max(...OBJECT_CATEGORIES.map((c) => placeholderParts(c.id).length));
    expect(max).toBeLessThanOrEqual(8);
  });
});

describe("no two placeholder faces share a plane", () => {
  /**
   * Coplanar surfaces z-fight, and on a phone that renders as a black-and-white
   * checkerboard. In the shipped build a framed picture on the wall and the
   * inside of a shelf both showed it — the single most visible defect in the
   * app — because the front panel's face landed on exactly the same plane as
   * the body it sat on.
   */
  it.each(OBJECT_CATEGORIES.map((c) => [c.id, c] as const))(
    "%s: front faces are separated",
    (_id, category) => {
      const parts = placeholderParts(category);
      // Front-facing plane of each part, in unit space.
      const fronts = parts.map((p) => p.position[2] + p.size[2] / 2);
      for (let i = 0; i < fronts.length; i++) {
        for (let j = i + 1; j < fronts.length; j++) {
          const gap = Math.abs(fronts[i]! - fronts[j]!);
          // Either clearly separated, or exactly the same part geometry
          // repeated side by side (two cabinet doors, four fan blades), which
          // do not overlap in x/y and so cannot fight.
          const a = parts[i]!;
          const b = parts[j]!;
          const overlapsXY =
            Math.abs(a.position[0] - b.position[0]) < (a.size[0] + b.size[0]) / 2 - 1e-6 &&
            Math.abs(a.position[1] - b.position[1]) < (a.size[1] + b.size[1]) / 2 - 1e-6;
          if (overlapsXY) {
            expect(gap, `${_id}: parts ${i} and ${j} share a front plane`).toBeGreaterThan(0.01);
          }
        }
      }
    },
  );
})
