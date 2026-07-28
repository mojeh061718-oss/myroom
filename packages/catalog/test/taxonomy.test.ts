import { describe, expect, it } from "vitest";
import { ObjectCategorySchema, PlacedObjectSchema } from "@myroom/schema";
import {
  CATEGORY_GROUPS,
  OBJECT_CATEGORIES,
  categoriesInGroup,
  detectionVocabulary,
  getCategory,
} from "../src/taxonomy.js";

describe("object taxonomy", () => {
  it("covers at least the docs/05 §3 vocabulary size", () => {
    expect(OBJECT_CATEGORIES.length).toBeGreaterThanOrEqual(120);
  });

  it("has unique ids and validates against the schema", () => {
    const ids = OBJECT_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of OBJECT_CATEGORIES) {
      expect(ObjectCategorySchema.safeParse(c).success, c.id).toBe(true);
    }
  });

  it("every group is non-empty and every category belongs to a known group", () => {
    for (const g of CATEGORY_GROUPS) expect(categoriesInGroup(g).length).toBeGreaterThan(0);
    for (const c of OBJECT_CATEGORIES) expect(CATEGORY_GROUPS).toContain(c.group);
  });

  it("wall- and ceiling-mounted categories declare a mount height and skip collision", () => {
    for (const c of OBJECT_CATEGORIES) {
      if (c.support === "wall" || c.support === "ceiling") {
        expect(c.mountHeight, c.id).not.toBeNull();
        expect(c.mountHeight!, c.id).toBeGreaterThan(0);
        expect(c.collisionExempt, c.id).toBe(true);
      }
    }
  });

  it("keeps every default size in plausible room-scale meters", () => {
    for (const c of OBJECT_CATEGORIES) {
      for (const [axis, v] of Object.entries(c.defaultSize)) {
        expect(v, `${c.id}.${axis}`).toBeGreaterThan(0.005);
        expect(v, `${c.id}.${axis}`).toBeLessThan(3);
      }
      // A wall/ceiling item must fit under a standard 2.44 m ceiling at its mount.
      if (c.mountHeight !== null) {
        expect(c.mountHeight + c.defaultSize.h / 2, c.id).toBeLessThanOrEqual(2.44);
      }
    }
  });

  it("includes every explicitly requested class", () => {
    const requested = [
      "ottoman",
      "framed-picture",
      "floating-shelf",
      "microwave",
      "air-fryer",
      "cabinet",
      "tv",
      "ceiling-fan",
      "coat-rack",
    ];
    for (const id of requested) expect(getCategory(id), id).toBeDefined();
  });

  it("routes common phrasings to the right category through the detection vocabulary", () => {
    const vocab = detectionVocabulary();
    const expected: Record<string, string> = {
      couch: "sofa",
      footstool: "ottoman",
      painting: "framed-picture",
      picture: "framed-picture",
      "wall shelf": "floating-shelf",
      "microwave oven": "microwave",
      airfryer: "air-fryer",
      cupboard: "cabinet",
      television: "tv",
      "tv stand": "media-console",
      "coat stand": "coat-rack",
      "pedestal fan": "floor-fan",
      "area rug": "rug",
    };
    for (const [prompt, id] of Object.entries(expected)) {
      expect(vocab.get(prompt), prompt).toBe(id);
    }
  });

  it("every category can be instantiated as a valid PlacedObject", () => {
    for (const c of OBJECT_CATEGORIES) {
      const placed = {
        id: `obj-${c.id}`,
        catalogId: null,
        placeholder: { category: c.id, shape: `${c.id}Massing` },
        label: c.label,
        support: c.support,
        wallId: c.support === "wall" ? "wall-a" : null,
        parentObjectId: c.support === "surface" ? "obj-parent" : null,
        position: { x: 0, y: c.mountHeight ?? 0, z: 0 },
        rotationY: 0,
        size: c.defaultSize,
        materials: {},
        collisionExempt: c.collisionExempt,
        recon: null,
      };
      expect(PlacedObjectSchema.safeParse(placed).success, c.id).toBe(true);
    }
  });
});
