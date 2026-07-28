import type { Project, RoomPlan } from "@myroom/schema";

/**
 * Repository interface for the API's metadata tier.
 *
 * M1 ships the in-memory implementation so the golden path and contract tests
 * run with no services; the Drizzle/PostgreSQL implementation (docs/08 §2)
 * lands with the hosted deployment. Route handlers only ever see this
 * interface, so swapping the backing store touches no route code.
 */
export interface ProjectRecord extends Project {
  plan: RoomPlan | null;
  /** ETag for optimistic concurrency on plan/scene writes (docs/03 §3) */
  planVersion: number;
}

export interface Store {
  createProject(ownerId: string, name: string, id: string, now: string): Promise<ProjectRecord>;
  listProjects(ownerId: string): Promise<ProjectRecord[]>;
  getProject(ownerId: string, id: string): Promise<ProjectRecord | undefined>;
  renameProject(ownerId: string, id: string, name: string, now: string): Promise<ProjectRecord | undefined>;
  deleteProject(ownerId: string, id: string): Promise<boolean>;
  savePlan(ownerId: string, id: string, plan: RoomPlan, now: string): Promise<ProjectRecord | undefined>;
  /** Storage objects queued for purge (docs/03 §7: purge within 24 h, audited). */
  pendingPurges(): Promise<{ projectId: string; requestedAt: string }[]>;
}

export function createMemoryStore(): Store {
  const projects = new Map<string, ProjectRecord>();
  const purges: { projectId: string; requestedAt: string }[] = [];

  const owned = (ownerId: string, id: string) => {
    const p = projects.get(id);
    return p && p.ownerId === ownerId ? p : undefined;
  };

  return {
    async createProject(ownerId, name, id, now) {
      const record: ProjectRecord = {
        id,
        ownerId,
        name,
        createdAt: now,
        updatedAt: now,
        planId: null,
        currentSceneId: null,
        accuracyTier: "sketch",
        thumbnailRef: null,
        plan: null,
        planVersion: 0,
      };
      projects.set(id, record);
      return record;
    },
    async listProjects(ownerId) {
      return [...projects.values()]
        .filter((p) => p.ownerId === ownerId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async getProject(ownerId, id) {
      return owned(ownerId, id);
    },
    async renameProject(ownerId, id, name, now) {
      const p = owned(ownerId, id);
      if (!p) return undefined;
      const next = { ...p, name, updatedAt: now };
      projects.set(id, next);
      return next;
    },
    async deleteProject(ownerId, id) {
      const p = owned(ownerId, id);
      if (!p) return false;
      projects.delete(id);
      // Deletion is real (docs/03 §7): tombstone now, storage purge within 24 h.
      purges.push({ projectId: id, requestedAt: new Date().toISOString() });
      return true;
    },
    async savePlan(ownerId, id, plan, now) {
      const p = owned(ownerId, id);
      if (!p) return undefined;
      const next: ProjectRecord = {
        ...p,
        plan,
        planId: plan.id,
        updatedAt: now,
        planVersion: p.planVersion + 1,
      };
      projects.set(id, next);
      return next;
    },
    async pendingPurges() {
      return [...purges];
    },
  };
}
