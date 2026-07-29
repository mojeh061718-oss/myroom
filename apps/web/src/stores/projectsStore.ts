import { create } from "zustand";
import type { RoomPlan } from "@myroom/schema";
import { uuidv7 } from "../lib/uuid.js";
import {
  deleteProject as dbDelete,
  listProjects,
  putProject,
  type LocalProject,
} from "../lib/db.js";

export function emptyPlan(): RoomPlan {
  return {
    schemaVersion: 1,
    id: uuidv7(),
    units: "m",
    vertices: [],
    walls: [],
    closed: false,
    floorArea: null,
    source: "drawn",
    curvedWalls: null,
    roomGroups: null,
  };
}

interface ProjectsState {
  projects: LocalProject[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createProject: (name?: string) => Promise<LocalProject>;
  renameProject: (id: string, name: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  hydrated: false,
  hydrate: async () => {
    set({ projects: await listProjects(), hydrated: true });
  },
  createProject: async (name = "New room") => {
    const now = new Date().toISOString();
    const project: LocalProject = {
      id: uuidv7(),
      name,
      createdAt: now,
      updatedAt: now,
      plan: emptyPlan(),
      thumbnailSvg: null,
    };
    await putProject(project);
    set({ projects: [project, ...get().projects] });
    return project;
  },
  renameProject: async (id, name) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return;
    const updated = { ...project, name, updatedAt: new Date().toISOString() };
    await putProject(updated);
    set({ projects: get().projects.map((p) => (p.id === id ? updated : p)) });
  },
  duplicateProject: async (id) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return;
    const now = new Date().toISOString();
    const copy: LocalProject = {
      ...structuredClone(project),
      id: uuidv7(),
      name: `${project.name} copy`,
      createdAt: now,
      updatedAt: now,
    };
    copy.plan.id = uuidv7();
    await putProject(copy);
    set({ projects: [copy, ...get().projects] });
  },
  removeProject: async (id) => {
    await dbDelete(id);
    set({ projects: get().projects.filter((p) => p.id !== id) });
  },
}));
