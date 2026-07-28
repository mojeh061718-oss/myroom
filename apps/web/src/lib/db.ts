import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { RoomPlan, Scene } from "@myroom/schema";
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
}

export const DEFAULT_SETTINGS: Settings = { tutorialSeen: false, displayUnit: "m", theme: "dark" };

interface MyRoomDB extends DBSchema {
  projects: { key: string; value: LocalProject };
  settings: { key: string; value: Settings };
}

let dbPromise: Promise<IDBPDatabase<MyRoomDB>> | null = null;

function db(): Promise<IDBPDatabase<MyRoomDB>> {
  dbPromise ??= openDB<MyRoomDB>("myroom", 1, {
    upgrade(database) {
      database.createObjectStore("projects", { keyPath: "id" });
      database.createObjectStore("settings");
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
  await (await db()).delete("projects", id);
}

export async function getSettings(): Promise<Settings> {
  const stored = await (await db()).get("settings", "app");
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function putSettings(settings: Settings): Promise<void> {
  await (await db()).put("settings", settings, "app");
}
