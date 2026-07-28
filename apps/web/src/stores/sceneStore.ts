import { create } from "zustand";
import type { PlacedObject, RoomPlan, Scene } from "@myroom/schema";
import { getCatalogItem, getCategory, OBJECT_CATEGORIES } from "@myroom/catalog";
import { planToShell, type ShellGeometry } from "./sceneTypes.js";
import { uuidv7 } from "../lib/uuid.js";
import { getProject, putProject } from "../lib/db.js";

/**
 * The Scene document is the single source of truth for the sandbox
 * (docs/06 intro: "the renderer holds no state of its own, so undo/redo,
 * versions, sync and sharing all come free from document-level operations").
 *
 * Every mutation goes through `apply`, which records an inverse command
 * (docs/06 §6). The renderer is a pure function of `scene`.
 */

export interface SceneVersion {
  id: string;
  name: string;
  scene: Scene;
  createdAt: string;
  /** version zero, "Original room", is never overwritable (docs/01 §11) */
  locked: boolean;
}

interface Command {
  label: string;
  before: Scene;
  after: Scene;
}

export const DEFAULT_WALL_COLOR = "#EDE9E3";
export const DEFAULT_FLOOR = "#B99A72";
export const DEFAULT_CEILING = "#F4F2EC";

export function emptyScene(planId: string): Scene {
  return {
    schemaVersion: 1,
    id: uuidv7(),
    planId,
    objects: [],
    finishes: {
      walls: {},
      floor: { color: DEFAULT_FLOOR, finish: "matte" },
      ceiling: { color: DEFAULT_CEILING },
      baseboard: { color: "#FFFFFF", height: 0.09 },
    },
    lighting: { hdri: "procedural-room-01", keyIntensity: 1 },
    provenance: { tier: "sketch", reconstructionJobId: null, generatedAt: new Date().toISOString() },
  };
}

/** A new object of `categoryId`, sized and supported from the taxonomy. */
export function makePlacedObject(
  categoryId: string,
  position: { x: number; y: number; z: number },
  overrides: Partial<PlacedObject> = {},
): PlacedObject {
  const category = getCategory(categoryId) ?? OBJECT_CATEGORIES[0]!;
  return {
    id: uuidv7(),
    catalogId: null,
    placeholder: { category: category.id, shape: `${category.id}Massing` },
    label: category.label,
    support: category.support,
    wallId: null,
    parentObjectId: null,
    position,
    rotationY: 0,
    size: { ...category.defaultSize },
    materials: {},
    collisionExempt: category.collisionExempt,
    recon: null,
    ...overrides,
  };
}

interface SceneState {
  projectId: string | null;
  plan: RoomPlan | null;
  shell: ShellGeometry | null;
  scene: Scene | null;
  versions: SceneVersion[];
  activeVersionId: string | null;
  selectedId: string | null;
  editing: boolean;
  undoStack: Command[];
  redoStack: Command[];
  /** set while dragging so the whole gesture collapses into one command */
  dragBaseline: Scene | null;

  load: (projectId: string) => Promise<boolean>;
  setEditing: (editing: boolean) => void;
  select: (id: string | null) => void;

  addObject: (categoryId: string, position: { x: number; y: number; z: number }, overrides?: Partial<PlacedObject>) => string;
  updateObject: (id: string, patch: Partial<PlacedObject>, commit: boolean) => void;
  duplicateObject: (id: string) => void;
  deleteObject: (id: string) => void;
  swapObject: (id: string, categoryId: string, catalogId?: string) => void;

  paintWall: (wallId: string | "all", color: string) => void;
  paintFloor: (color: string) => void;
  paintCeiling: (color: string) => void;
  paintObjectSlot: (id: string, slot: string, color: string) => void;

  saveVersion: (name: string) => void;
  restoreVersion: (versionId: string) => void;
  deleteVersion: (versionId: string) => void;
  renameVersion: (versionId: string, name: string) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export const useScene = create<SceneState>((set, get) => {
  const persist = () => {
    const { projectId, scene, versions } = get();
    if (!projectId || !scene) return;
    void getProject(projectId).then((existing) => {
      if (!existing) return;
      void putProject({
        ...existing,
        updatedAt: new Date().toISOString(),
        scene,
        versions: versions.map((v) => ({ ...v })),
      });
    });
  };

  const apply = (label: string, next: Scene, commit = true) => {
    const before = get().dragBaseline ?? get().scene;
    if (!before) return;
    if (commit) {
      set({
        scene: next,
        undoStack: [...get().undoStack, { label, before, after: next }],
        redoStack: [],
        dragBaseline: null,
      });
      persist();
    } else {
      set({ scene: next, dragBaseline: before });
    }
  };

  const withObjects = (scene: Scene, objects: PlacedObject[]): Scene => ({ ...scene, objects });

  return {
    projectId: null,
    plan: null,
    shell: null,
    scene: null,
    versions: [],
    activeVersionId: null,
    selectedId: null,
    editing: false,
    undoStack: [],
    redoStack: [],
    dragBaseline: null,

    load: async (projectId) => {
      const project = await getProject(projectId);
      if (!project) return false;
      const shell = planToShell(project.plan);
      const scene = project.scene ?? emptyScene(project.plan.id);
      const versions = project.versions ?? [];
      set({
        projectId,
        plan: project.plan,
        shell,
        scene,
        versions,
        activeVersionId: versions[0]?.id ?? null,
        selectedId: null,
        editing: false,
        undoStack: [],
        redoStack: [],
        dragBaseline: null,
      });
      return true;
    },

    setEditing: (editing) => set({ editing, selectedId: editing ? get().selectedId : null }),
    select: (selectedId) => set({ selectedId }),

    addObject: (categoryId, position, overrides) => {
      const { scene } = get();
      if (!scene) return "";
      const object = makePlacedObject(categoryId, position, overrides);
      apply(`Add ${object.label}`, withObjects(scene, [...scene.objects, object]));
      set({ selectedId: object.id });
      return object.id;
    },

    updateObject: (id, patch, commit) => {
      const { scene } = get();
      if (!scene) return;
      const next = withObjects(
        scene,
        scene.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      );
      apply("Move object", next, commit);
    },

    duplicateObject: (id) => {
      const { scene } = get();
      if (!scene) return;
      const source = scene.objects.find((o) => o.id === id);
      if (!source) return;
      const copy: PlacedObject = {
        ...structuredClone(source),
        id: uuidv7(),
        position: { ...source.position, x: source.position.x + 0.3, z: source.position.z + 0.3 },
      };
      apply(`Duplicate ${source.label}`, withObjects(scene, [...scene.objects, copy]));
      set({ selectedId: copy.id });
    },

    deleteObject: (id) => {
      const { scene } = get();
      if (!scene) return;
      const target = scene.objects.find((o) => o.id === id);
      apply(
        `Delete ${target?.label ?? "object"}`,
        withObjects(scene, scene.objects.filter((o) => o.id !== id)),
      );
      set({ selectedId: null });
    },

    swapObject: (id, categoryId, catalogId) => {
      const { scene } = get();
      if (!scene) return;
      const source = scene.objects.find((o) => o.id === id);
      const category = getCategory(categoryId);
      if (!source || !category) return;
      const model = catalogId ? getCatalogItem(catalogId) : undefined;
      // Keep the placement the user already chose; adopt the new silhouette.
      const swapped: PlacedObject = {
        ...source,
        placeholder: model ? null : { category: category.id, shape: `${category.id}Massing` },
        catalogId: model?.id ?? null,
        label: model?.name ?? category.label,
        support: category.support,
        collisionExempt: category.collisionExempt,
        size: { ...(model?.nativeSize ?? category.defaultSize) },
        materials: {},
        wallId: category.support === "wall" ? source.wallId : null,
        parentObjectId: category.support === "surface" ? source.parentObjectId : null,
      };
      apply(`Swap to ${category.label}`, withObjects(scene, scene.objects.map((o) => (o.id === id ? swapped : o))));
    },

    paintWall: (wallId, color) => {
      const { scene, shell } = get();
      if (!scene) return;
      const walls = { ...scene.finishes.walls };
      if (wallId === "all") {
        for (const w of shell?.walls ?? []) walls[w.wallId] = { color, finish: "matte" };
      } else {
        walls[wallId] = { color, finish: "matte" };
      }
      apply(wallId === "all" ? "Paint all walls" : "Paint wall", {
        ...scene,
        finishes: { ...scene.finishes, walls },
      });
    },

    paintFloor: (color) => {
      const { scene } = get();
      if (!scene) return;
      apply("Change floor", {
        ...scene,
        finishes: { ...scene.finishes, floor: { ...scene.finishes.floor, color } },
      });
    },

    paintCeiling: (color) => {
      const { scene } = get();
      if (!scene) return;
      apply("Change ceiling", {
        ...scene,
        finishes: { ...scene.finishes, ceiling: { ...scene.finishes.ceiling, color } },
      });
    },

    paintObjectSlot: (id, slot, color) => {
      const { scene } = get();
      if (!scene) return;
      apply(
        "Recolour object",
        withObjects(
          scene,
          scene.objects.map((o) =>
            o.id === id ? { ...o, materials: { ...o.materials, [slot]: { color } } } : o,
          ),
        ),
      );
    },

    saveVersion: (name) => {
      const { scene, versions } = get();
      if (!scene) return;
      const version: SceneVersion = {
        id: uuidv7(),
        name,
        scene: structuredClone(scene),
        createdAt: new Date().toISOString(),
        // Version zero is "Original room" and is locked forever (docs/06 §6).
        locked: versions.length === 0,
      };
      set({ versions: [...versions, version], activeVersionId: version.id });
      persist();
    },

    restoreVersion: (versionId) => {
      const { versions, scene } = get();
      const version = versions.find((v) => v.id === versionId);
      if (!version || !scene) return;
      apply(`Restore "${version.name}"`, structuredClone(version.scene));
      set({ activeVersionId: versionId, selectedId: null });
    },

    deleteVersion: (versionId) => {
      const { versions } = get();
      const version = versions.find((v) => v.id === versionId);
      if (!version || version.locked) return;
      set({ versions: versions.filter((v) => v.id !== versionId) });
      persist();
    },

    renameVersion: (versionId, name) => {
      set({ versions: get().versions.map((v) => (v.id === versionId ? { ...v, name } : v)) });
      persist();
    },

    undo: () => {
      const { undoStack, redoStack } = get();
      const cmd = undoStack[undoStack.length - 1];
      if (!cmd) return;
      set({
        scene: cmd.before,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, cmd],
        selectedId: null,
      });
      persist();
    },

    redo: () => {
      const { undoStack, redoStack } = get();
      const cmd = redoStack[redoStack.length - 1];
      if (!cmd) return;
      set({
        scene: cmd.after,
        undoStack: [...undoStack, cmd],
        redoStack: redoStack.slice(0, -1),
      });
      persist();
    },

    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,
  };
});
