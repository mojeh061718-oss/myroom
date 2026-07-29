import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { SceneSchema } from "@myroom/schema";
import { useScene, emptyScene, makePlacedObject } from "./sceneStore.js";
import { emptyPlan } from "./projectsStore.js";
import { putProject } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import { labelWallsForPlan } from "@myroom/schema";

/** A closed 6 × 4 room, so planToShell yields a real shell. */
function closedPlan() {
  const plan = emptyPlan();
  const v = [
    { id: "v0", x: 0, y: 4 },
    { id: "v1", x: 6, y: 4 },
    { id: "v2", x: 6, y: 0 },
    { id: "v3", x: 0, y: 0 },
  ];
  plan.vertices = v;
  plan.walls = v.map((_, i) => ({
    id: `w${i}`,
    label: String.fromCharCode(65 + i),
    start: v[i]!.id,
    end: v[(i + 1) % v.length]!.id,
    thickness: 0.115,
    height: 2.44,
    openings: [],
  }));
  plan.closed = true;
  return labelWallsForPlan(plan);
}

async function freshScene() {
  const id = uuidv7();
  const now = new Date().toISOString();
  await putProject({ id, name: "Room", createdAt: now, updatedAt: now, plan: closedPlan(), thumbnailSvg: null });
  const ok = await useScene.getState().load(id);
  expect(ok).toBe(true);
  return id;
}

describe("sceneStore (docs/06 §6 command pattern)", () => {
  beforeEach(async () => {
    await freshScene();
  });

  it("loads a shell and an empty, schema-valid scene", () => {
    const s = useScene.getState();
    expect(s.shell?.walls).toHaveLength(4);
    expect(s.scene?.objects).toHaveLength(0);
    expect(() => SceneSchema.parse(s.scene)).not.toThrow();
  });

  it("adds objects from the taxonomy with real sizes and support", () => {
    const s = useScene.getState;
    s().addObject("sofa", { x: 1, y: 0, z: -1 });
    const obj = s().scene!.objects[0]!;
    expect(obj.label).toBe("Sofa");
    expect(obj.support).toBe("floor");
    expect(obj.size.w).toBeCloseTo(2.1, 6);
    expect(() => SceneSchema.parse(s().scene)).not.toThrow();
  });

  it("adds an imported model as a schema-valid, undoable, swappable object", () => {
    const s = useScene.getState;
    const asset = { id: "asset-1", name: "Grandpa's chair", nativeSize: { w: 0.7, d: 0.7, h: 1.0 } };
    const objectId = s().addImported(asset, { x: 1, y: 0, z: -1 });
    const obj = s().scene!.objects.find((o) => o.id === objectId)!;
    expect(obj.importedAssetId).toBe("asset-1");
    expect(obj.catalogId).toBeNull();
    expect(obj.placeholder).toBeNull();
    expect(obj.label).toBe("Grandpa's chair");
    expect(obj.size).toEqual(asset.nativeSize);
    expect(() => SceneSchema.parse(s().scene)).not.toThrow();

    // Duplicate keeps the asset reference.
    s().duplicateObject(objectId);
    expect(s().scene!.objects.filter((o) => o.importedAssetId === "asset-1")).toHaveLength(2);

    // Swapping to a catalog category replaces the imported identity.
    s().swapObject(objectId, "armchair");
    const swapped = s().scene!.objects.find((o) => o.id === objectId)!;
    expect(swapped.importedAssetId).toBeNull();
    expect(swapped.placeholder?.category).toBe("armchair");
    expect(() => SceneSchema.parse(s().scene)).not.toThrow();

    // Undo restores the imported object.
    s().undo();
    expect(s().scene!.objects.find((o) => o.id === objectId)!.importedAssetId).toBe("asset-1");
  });

  it("keeps ceiling and wall objects schema-valid", () => {
    const s = useScene.getState;
    s().addObject("ceiling-fan", { x: 0, y: 2.26, z: 0 });
    s().addObject("framed-picture", { x: 0, y: 1.55, z: 0 }, { wallId: "w0" });
    expect(() => SceneSchema.parse(s().scene)).not.toThrow();
    const fan = s().scene!.objects.find((o) => o.label === "Ceiling Fan")!;
    expect(fan.support).toBe("ceiling");
    expect(fan.collisionExempt).toBe(true);
  });

  it("undo/redo covers add, move, paint, duplicate, swap and delete", () => {
    const s = useScene.getState;
    const start = structuredClone(s().scene!);

    s().addObject("sofa", { x: 1, y: 0, z: -1 });
    const id = s().scene!.objects[0]!.id;
    s().updateObject(id, { position: { x: 2, y: 0, z: -1 } }, true);
    s().paintWall("all", "#9CAF88");
    s().paintFloor("#7A5B41");
    s().paintObjectSlot(id, "upholstery", "#5B6247");
    s().duplicateObject(id);
    s().swapObject(id, "armchair");
    s().deleteObject(id);
    const after = structuredClone(s().scene!);

    for (let i = 0; i < 8; i++) s().undo();
    expect(s().scene).toEqual(start);
    for (let i = 0; i < 8; i++) s().redo();
    expect(s().scene).toEqual(after);
  });

  it("collapses a whole drag gesture into one undo step", () => {
    const s = useScene.getState;
    s().addObject("coffee-table", { x: 0, y: 0, z: 0 });
    const id = s().scene!.objects[0]!.id;
    const afterAdd = structuredClone(s().scene!);

    // Preview frames (commit=false) then one commit, as the drag handler does.
    s().updateObject(id, { position: { x: 0.5, y: 0, z: 0 } }, false);
    s().updateObject(id, { position: { x: 1.0, y: 0, z: 0 } }, false);
    s().updateObject(id, { position: { x: 1.5, y: 0, z: 0 } }, true);
    expect(s().scene!.objects[0]!.position.x).toBeCloseTo(1.5, 6);

    s().undo();
    expect(s().scene).toEqual(afterAdd);
  });

  it("locks version zero and restores versions as undoable commands", () => {
    const s = useScene.getState;
    s().addObject("sofa", { x: 1, y: 0, z: -1 });
    s().saveVersion("Original room");
    expect(s().versions[0]!.locked).toBe(true);

    s().addObject("rug", { x: 0, y: 0, z: 0 });
    s().saveVersion("With rug");
    expect(s().versions[1]!.locked).toBe(false);
    expect(s().scene!.objects).toHaveLength(2);

    s().restoreVersion(s().versions[0]!.id);
    expect(s().scene!.objects).toHaveLength(1);
    s().undo();
    expect(s().scene!.objects).toHaveLength(2);

    // A locked version can never be deleted (docs/06 §6).
    s().deleteVersion(s().versions[0]!.id);
    expect(s().versions[0]!.name).toBe("Original room");
  });

  it("swap keeps the object's place but adopts the new silhouette", () => {
    const s = useScene.getState;
    s().addObject("sofa", { x: 1.2, y: 0, z: -0.8 });
    const id = s().scene!.objects[0]!.id;
    s().updateObject(id, { rotationY: 1.2 }, true);
    s().swapObject(id, "armchair");
    const obj = s().scene!.objects[0]!;
    expect(obj.label).toBe("Armchair");
    expect(obj.position.x).toBeCloseTo(1.2, 6);
    expect(obj.rotationY).toBeCloseTo(1.2, 6);
    expect(obj.size.w).toBeCloseTo(0.85, 6);
  });

  it("makePlacedObject always produces a valid document node", () => {
    const o = makePlacedObject("microwave", { x: 0, y: 0.9, z: 0 }, { parentObjectId: "parent" });
    expect(o.support).toBe("surface");
    expect(o.parentObjectId).toBe("parent");
    const s = emptyScene("plan-1");
    expect(() => SceneSchema.parse({ ...s, objects: [o] })).not.toThrow();
  });
});
