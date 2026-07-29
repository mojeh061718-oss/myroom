import { describe, expect, it } from "vitest";
import { CatalogItemSchema } from "@myroom/schema";
import { CATALOG_ITEMS, categoriesWithModels, getCatalogItem, modelsForCategory } from "../src/manifest.js";
import { getCategory } from "../src/taxonomy.js";

describe("built CC0 catalog (docs/07 §5, docs/08 §5)", () => {
  it("has models and every entry validates against the schema", () => {
    expect(CATALOG_ITEMS.length).toBeGreaterThan(0);
    for (const item of CATALOG_ITEMS) {
      expect(CatalogItemSchema.safeParse(item).success, item.id).toBe(true);
    }
  });

  it("is CC0 only, with a source recorded per item", () => {
    for (const item of CATALOG_ITEMS) {
      expect(item.license, item.id).toBe("CC0");
      expect(item.source, item.id).toMatch(/^https:\/\//);
    }
  });

  it("respects the 15k triangle budget (docs/06 §8)", () => {
    for (const item of CATALOG_ITEMS) {
      expect(item.asset.tris, item.id).toBeGreaterThan(0);
      expect(item.asset.tris, item.id).toBeLessThanOrEqual(15000);
    }
  });

  it("carries plausible real-world dimensions in metres", () => {
    for (const item of CATALOG_ITEMS) {
      for (const [axis, v] of Object.entries(item.nativeSize)) {
        expect(v, `${item.id}.${axis}`).toBeGreaterThan(0.02);
        expect(v, `${item.id}.${axis}`).toBeLessThan(6);
      }
    }
  });

  it("only files models under categories that exist in the taxonomy", () => {
    for (const item of CATALOG_ITEMS) {
      expect(getCategory(item.category), item.id).toBeDefined();
    }
  });

  it("has unique ids and resolves them", () => {
    const ids = CATALOG_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getCatalogItem(ids[0]!)).toBeDefined();
    expect(getCatalogItem("nope/nope")).toBeUndefined();
  });

  it("groups models by category, cheapest first", () => {
    for (const category of categoriesWithModels()) {
      const models = modelsForCategory(category);
      expect(models.length).toBeGreaterThan(0);
      for (let i = 1; i < models.length; i++) {
        expect(models[i]!.asset.tris).toBeGreaterThanOrEqual(models[i - 1]!.asset.tris);
      }
    }
  });
});
