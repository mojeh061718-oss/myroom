import { describe, expect, it } from "vitest";
import { PlacedObjectSchema, SceneSchema, CatalogItemSchema } from "../src/scene.js";

const sofa = {
  id: "obj-1",
  catalogId: "sofa/modern-3seat-04",
  placeholder: null,
  label: "Sofa",
  support: "floor",
  wallId: null,
  parentObjectId: null,
  position: { x: 1.2, y: 0, z: -3.4 },
  rotationY: 1.5708,
  size: { w: 2.2, d: 0.95, h: 0.85 },
  materials: { upholstery: { color: "#5B6247" } },
  collisionExempt: false,
  recon: null,
};

describe("PlacedObject invariants (docs/07 §4)", () => {
  it("accepts a valid floor object", () => {
    expect(PlacedObjectSchema.safeParse(sofa).success).toBe(true);
  });
  it("requires exactly one of catalogId/placeholder/importedAssetId", () => {
    expect(PlacedObjectSchema.safeParse({ ...sofa, catalogId: null }).success).toBe(false);
    expect(
      PlacedObjectSchema.safeParse({
        ...sofa,
        catalogId: null,
        placeholder: { category: "sofa", shape: "sofaMassing" },
      }).success,
    ).toBe(true);
    expect(
      PlacedObjectSchema.safeParse({
        ...sofa,
        placeholder: { category: "sofa", shape: "sofaMassing" },
      }).success,
    ).toBe(false);
    expect(
      PlacedObjectSchema.safeParse({ ...sofa, catalogId: null, importedAssetId: "asset-1" }).success,
    ).toBe(true);
    expect(PlacedObjectSchema.safeParse({ ...sofa, importedAssetId: "asset-1" }).success).toBe(false);
  });
  it("parses scenes saved before importedAssetId existed", () => {
    const legacy = { ...sofa } as Record<string, unknown>;
    delete legacy.importedAssetId;
    const parsed = PlacedObjectSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.importedAssetId).toBeNull();
  });
  it("requires wallId for wall support and parentObjectId for surface support", () => {
    expect(PlacedObjectSchema.safeParse({ ...sofa, support: "wall" }).success).toBe(false);
    expect(PlacedObjectSchema.safeParse({ ...sofa, support: "wall", wallId: "w-a" }).success).toBe(true);
    expect(PlacedObjectSchema.safeParse({ ...sofa, support: "surface" }).success).toBe(false);
    expect(PlacedObjectSchema.safeParse({ ...sofa, support: "surface", parentObjectId: "obj-0" }).success).toBe(true);
  });
});

describe("Scene (docs/07 §3)", () => {
  it("accepts a minimal valid scene", () => {
    const scene = {
      schemaVersion: 1,
      id: "scene-1",
      planId: "plan-1",
      objects: [sofa],
      finishes: {
        walls: { "w-a": { color: "#9CAF88", finish: "matte" } },
        floor: { materialId: "wood/oak-natural-01" },
        ceiling: { color: "#F4F2EC" },
        baseboard: { color: "#FFFFFF", height: 0.09 },
      },
      lighting: { hdri: "studio-warm-01", keyIntensity: 1 },
      provenance: { tier: "sketch", reconstructionJobId: null, generatedAt: "2026-07-28T12:00:00.000Z" },
    };
    expect(SceneSchema.safeParse(scene).success).toBe(true);
  });
});

describe("CatalogItem (docs/07 §5)", () => {
  const item = {
    id: "sofa/modern-3seat-04",
    category: "sofa",
    name: "Modern 3-Seat Sofa",
    asset: { glb: "catalog/abc/model.glb", tris: 9800 },
    nativeSize: { w: 2.1, d: 0.92, h: 0.83 },
    scaleBounds: { min: 0.8, max: 1.25, nonUniform: true },
    materialSlots: ["upholstery", "legs"],
    faceSlot: null,
    support: "floor",
    embedding: "catalog/abc/clip.bin",
    license: "CC0",
    source: "https://polyhaven.com/a/sofa",
  };
  it("accepts a valid item and enforces the 15k-tri budget", () => {
    expect(CatalogItemSchema.safeParse(item).success).toBe(true);
    expect(CatalogItemSchema.safeParse({ ...item, asset: { ...item.asset, tris: 15001 } }).success).toBe(false);
  });
  it("only ever accepts CC0", () => {
    expect(CatalogItemSchema.safeParse({ ...item, license: "CC-BY" }).success).toBe(false);
  });
});
