import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { PhotoQuality, RoomPlan, Scene } from "@myroom/schema";
import type { DisplayUnit } from "@myroom/geometry";

/**
 * IndexedDB is the WRITE-PRIMARY copy of every project (docs/03 §6, docs/01 §12
 * "never lose work"): edits land here first and sync to the API when online.
 */

export interface LocalProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  plan: RoomPlan;
  /** the editable Scene document (docs/07 §3); absent until the room is built */
  scene?: Scene;
  /** named snapshots, version zero locked as "Original room" (docs/06 §6) */
  versions?: {
    id: string;
    name: string;
    scene: Scene;
    createdAt: string;
    locked: boolean;
  }[];
  /** poster SVG for the Projects Home card */
  thumbnailSvg: string | null;
}

export interface Settings {
  tutorialSeen: boolean;
  displayUnit: DisplayUnit;
  theme: "dark" | "light";
  /** manual override for auto quality stepping (docs/06 §8) */
  quality: "auto" | "best" | "saver";
}

export const DEFAULT_SETTINGS: Settings = {
  tutorialSeen: false,
  displayUnit: "ft",
  theme: "dark",
  quality: "auto",
};

/**
 * A photo (or scan) the user captured for this project. The bytes stay on the
 * device until a reconstruction actually needs them (docs/01 §12), and are
 * deleted with the project.
 */
export interface LocalUpload {
  id: string;
  projectId: string;
  kind: "photo" | "lidar";
  filename: string;
  /** the wall this shot is tagged to — a hint for the pipeline, not a constraint */
  wallLabel: string | null;
  shotId: string | null;
  blob: Blob;
  quality: PhotoQuality | null;
  createdAt: string;
  /** set once the API has confirmed the bytes; null while device-only */
  remoteId: string | null;
}

/**
 * A 3D model the user imported into the sandbox (docs/06 §5). Whatever format
 * it arrived in, it is stored normalized to GLB so there is exactly one render
 * path — and it stays on the device, like everything else.
 */
export interface LocalAsset {
  id: string;
  projectId: string;
  /** display name, from the imported filename */
  name: string;
  /** normalized GLB bytes */
  blob: Blob;
  /** real-world size after import scaling, meters */
  nativeSize: { w: number; d: number; h: number };
  triangles: number;
  createdAt: string;
}

interface MyRoomDB extends DBSchema {
  projects: { key: string; value: LocalProject };
  settings: { key: string; value: Settings };
  uploads: { key: string; value: LocalUpload; indexes: { byProject: string } };
  assets: { key: string; value: LocalAsset; indexes: { byProject: string } };
}

let dbPromise: Promise<IDBPDatabase<MyRoomDB>> | null = null;

function db(): Promise<IDBPDatabase<MyRoomDB>> {
  dbPromise ??= openDB<MyRoomDB>("myroom", 3, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore("projects", { keyPath: "id" });
        database.createObjectStore("settings");
      }
      if (oldVersion < 2) {
        const uploads = database.createObjectStore("uploads", { keyPath: "id" });
        uploads.createIndex("byProject", "projectId");
      }
      if (oldVersion < 3) {
        const assets = database.createObjectStore("assets", { keyPath: "id" });
        assets.createIndex("byProject", "projectId");
      }
    },
  });
  return dbPromise;
}

export async function listProjects(): Promise<LocalProject[]> {
  const all = await (await db()).getAll("projects");
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<LocalProject | undefined> {
  return (await db()).get("projects", id);
}

export async function putProject(project: LocalProject): Promise<void> {
  await (await db()).put("projects", project);
}

export async function deleteProject(id: string): Promise<void> {
  const database = await db();
  await database.delete("projects", id);
  // Deleting a project deletes its photos — and its imported models — with it,
  // on the device as well as in the cloud (docs/03 §7, docs/01 §12). Leaving
  // them behind would keep pieces of someone's home after they asked for them
  // to be gone.
  const orphans = await database.getAllKeysFromIndex("uploads", "byProject", id);
  await Promise.all(orphans.map((key) => database.delete("uploads", key)));
  const assets = await database.getAllKeysFromIndex("assets", "byProject", id);
  await Promise.all(assets.map((key) => database.delete("assets", key)));
}

export async function putUpload(upload: LocalUpload): Promise<void> {
  await (await db()).put("uploads", upload);
}

export async function listUploads(projectId: string): Promise<LocalUpload[]> {
  const all = await (await db()).getAllFromIndex("uploads", "byProject", projectId);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteUpload(id: string): Promise<void> {
  await (await db()).delete("uploads", id);
}

export async function putAsset(asset: LocalAsset): Promise<void> {
  await (await db()).put("assets", asset);
}

export async function getAsset(id: string): Promise<LocalAsset | undefined> {
  return (await db()).get("assets", id);
}

export async function listAssets(projectId: string): Promise<LocalAsset[]> {
  const all = await (await db()).getAllFromIndex("assets", "byProject", projectId);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteAsset(id: string): Promise<void> {
  await (await db()).delete("assets", id);
}

export async function getSettings(): Promise<Settings> {
  const stored = await (await db()).get("settings", "app");
  // Defaults are feet-and-inches (docs/04 §4); the Units control in Settings
  // persists whichever the user picks.
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function putSettings(settings: Settings): Promise<void> {
  await (await db()).put("settings", settings, "app");
}
