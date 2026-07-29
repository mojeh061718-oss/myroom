import type { Project, ReconstructionJob, RoomPlan, Scene, ShareToken, Upload } from "@myroom/schema";

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
  scene: Scene | null;
  sceneVersion: number;
}

export interface VersionRecord {
  id: string;
  projectId: string;
  name: string;
  scene: Scene;
  createdAt: string;
  locked: boolean;
}

export interface Store {
  createProject(ownerId: string, name: string, id: string, now: string): Promise<ProjectRecord>;
  listProjects(ownerId: string): Promise<ProjectRecord[]>;
  getProject(ownerId: string, id: string): Promise<ProjectRecord | undefined>;
  /** Owner-less lookup, used only to resolve a share token (docs/03 §3). */
  getProjectById(id: string): Promise<ProjectRecord | undefined>;
  renameProject(ownerId: string, id: string, name: string, now: string): Promise<ProjectRecord | undefined>;
  deleteProject(ownerId: string, id: string): Promise<boolean>;
  savePlan(ownerId: string, id: string, plan: RoomPlan, now: string): Promise<ProjectRecord | undefined>;
  /** Storage objects queued for purge (docs/03 §7: purge within 24 h, audited). */
  pendingPurges(): Promise<{ projectId: string; requestedAt: string }[]>;
  markPurged(projectId: string, objectsRemoved: number, at: string): Promise<void>;
  purgeAudit(): Promise<{ projectId: string; requestedAt: string; completedAt: string; objectsRemoved: number }[]>;

  // --- uploads (docs/03 §3) --------------------------------------------------
  createUpload(upload: Upload): Promise<Upload>;
  getUpload(projectId: string, uploadId: string): Promise<Upload | undefined>;
  listUploads(projectId: string): Promise<Upload[]>;
  updateUpload(uploadId: string, patch: Partial<Upload>): Promise<Upload | undefined>;

  // --- scene & versions ------------------------------------------------------
  saveScene(ownerId: string, projectId: string, scene: Scene, now: string): Promise<ProjectRecord | undefined>;
  createVersion(version: VersionRecord): Promise<VersionRecord>;
  listVersions(projectId: string): Promise<VersionRecord[]>;
  deleteVersion(projectId: string, versionId: string): Promise<boolean>;

  // --- jobs & sharing --------------------------------------------------------
  createJob(job: ReconstructionJob): Promise<ReconstructionJob>;
  getJob(jobId: string): Promise<ReconstructionJob | undefined>;
  updateJob(jobId: string, patch: Partial<ReconstructionJob>): Promise<ReconstructionJob | undefined>;
  countJobsSince(projectId: string, since: string): Promise<number>;
  createShare(token: ShareToken): Promise<ShareToken>;
  getShare(token: string): Promise<ShareToken | undefined>;
}

export function createMemoryStore(): Store {
  const projects = new Map<string, ProjectRecord>();
  const purges: { projectId: string; requestedAt: string; completedAt: string | null; objectsRemoved: number }[] = [];
  const uploads = new Map<string, Upload>();
  const versions = new Map<string, VersionRecord>();
  const jobs = new Map<string, ReconstructionJob>();
  const shares = new Map<string, ShareToken>();

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
        scene: null,
        sceneVersion: 0,
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
    async getProjectById(id) {
      return projects.get(id);
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
      for (const [key, u] of uploads) if (u.projectId === id) uploads.delete(key);
      for (const [key, v] of versions) if (v.projectId === id) versions.delete(key);
      for (const [key, s] of shares) if (s.projectId === id) shares.delete(key);
      // Deletion is real (docs/03 §7): tombstone now, storage purge within 24 h.
      purges.push({ projectId: id, requestedAt: new Date().toISOString(), completedAt: null, objectsRemoved: 0 });
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
      return purges.filter((p) => p.completedAt === null).map(({ projectId, requestedAt }) => ({ projectId, requestedAt }));
    },
    async markPurged(projectId, objectsRemoved, at) {
      const entry = purges.find((p) => p.projectId === projectId && p.completedAt === null);
      if (entry) {
        entry.completedAt = at;
        entry.objectsRemoved = objectsRemoved;
      }
    },
    async purgeAudit() {
      return purges
        .filter((p) => p.completedAt !== null)
        .map((p) => ({ ...p, completedAt: p.completedAt! }));
    },

    async createUpload(upload) {
      uploads.set(upload.id, upload);
      return upload;
    },
    async getUpload(projectId, uploadId) {
      const u = uploads.get(uploadId);
      return u && u.projectId === projectId ? u : undefined;
    },
    async listUploads(projectId) {
      return [...uploads.values()].filter((u) => u.projectId === projectId);
    },
    async updateUpload(uploadId, patch) {
      const u = uploads.get(uploadId);
      if (!u) return undefined;
      const next = { ...u, ...patch };
      uploads.set(uploadId, next);
      return next;
    },

    async saveScene(ownerId, projectId, scene, now) {
      const p = owned(ownerId, projectId);
      if (!p) return undefined;
      const next: ProjectRecord = {
        ...p,
        scene,
        currentSceneId: scene.id,
        accuracyTier: scene.provenance.tier,
        updatedAt: now,
        sceneVersion: p.sceneVersion + 1,
      };
      projects.set(projectId, next);
      return next;
    },
    async createVersion(version) {
      versions.set(version.id, version);
      return version;
    },
    async listVersions(projectId) {
      return [...versions.values()]
        .filter((v) => v.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async deleteVersion(projectId, versionId) {
      const v = versions.get(versionId);
      // Version zero is locked forever (docs/01 §11).
      if (!v || v.projectId !== projectId || v.locked) return false;
      versions.delete(versionId);
      return true;
    },

    async createJob(job) {
      jobs.set(job.id, job);
      return job;
    },
    async getJob(jobId) {
      return jobs.get(jobId);
    },
    async updateJob(jobId, patch) {
      const j = jobs.get(jobId);
      if (!j) return undefined;
      const next = { ...j, ...patch };
      jobs.set(jobId, next);
      return next;
    },
    async countJobsSince(projectId, since) {
      return [...jobs.values()].filter((j) => j.projectId === projectId && j.createdAt >= since).length;
    },
    async createShare(token) {
      shares.set(token.token, token);
      return token;
    },
    async getShare(token) {
      return shares.get(token);
    },
  };
}
