import { CatalogItemSchema, type CatalogItem } from "@myroom/schema";
import raw from "../assets/manifest.json" with { type: "json" };

/**
 * The built CC0 catalog (docs/07 §5, docs/08 §5).
 *
 * Produced by `scripts/build-catalog.mjs` from Poly Haven's CC0 library: each
 * entry records its `license` and `source`, its triangle count is inside the
 * 15 k budget, and `nativeSize` is measured from the model's world-space
 * bounding box so it places at true scale.
 *
 * Categories with no model yet fall back to parametric geometry, so every one
 * of the 183 taxonomy categories remains placeable (docs/05 §6).
 */
export const CATALOG_ITEMS: readonly CatalogItem[] = Object.freeze(
  (raw as unknown[]).map((entry) => CatalogItemSchema.parse(entry)),
);

const BY_ID = new Map(CATALOG_ITEMS.map((i) => [i.id, i]));
const BY_CATEGORY = new Map<string, CatalogItem[]>();
for (const item of CATALOG_ITEMS) {
  const list = BY_CATEGORY.get(item.category) ?? [];
  list.push(item);
  BY_CATEGORY.set(item.category, list);
}

export function getCatalogItem(id: string): CatalogItem | undefined {
  return BY_ID.get(id);
}

/** Every built model for a category, best (fewest triangles) first. */
export function modelsForCategory(categoryId: string): CatalogItem[] {
  return [...(BY_CATEGORY.get(categoryId) ?? [])].sort((a, b) => a.asset.tris - b.asset.tris);
}

export function categoriesWithModels(): string[] {
  return [...BY_CATEGORY.keys()];
}
