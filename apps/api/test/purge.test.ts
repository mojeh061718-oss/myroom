import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/store.js";
import { createMemoryBlobs } from "../src/blobs.js";
import { overduePurges, runPurgeJob, PURGE_DEADLINE_HOURS } from "../src/jobs/purge.js";

/**
 * "Deletion is real" (docs/03 §7, docs/01 §12) — a product promise, so it gets
 * a test that fails if the bytes survive.
 */
describe("storage purge", () => {
  async function project() {
    const store = createMemoryStore();
    const blobs = createMemoryBlobs();
    const record = await store.createProject("owner", "Living room", "p1", new Date().toISOString());
    await blobs.put(`uploads/${record.id}/photo-a.jpg`, new Uint8Array([1]));
    await blobs.put(`uploads/${record.id}/photo-b.jpg`, new Uint8Array([2]));
    await blobs.put(`scenes/${record.id}/bundle.glb`, new Uint8Array([3]));
    // Another project's bytes, and the shared public catalog.
    await blobs.put("uploads/p2/photo.jpg", new Uint8Array([4]));
    await blobs.put("catalog/models/sofa.glb", new Uint8Array([5]));
    return { store, blobs, record };
  }

  it("removes every byte of a deleted project, and nothing else", async () => {
    const { store, blobs, record } = await project();
    await store.deleteProject("owner", record.id);

    const reports = await runPurgeJob(store, blobs);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.objectsRemoved).toBe(3);

    expect(await blobs.list(`uploads/${record.id}/`)).toEqual([]);
    expect(await blobs.list(`scenes/${record.id}/`)).toEqual([]);
    expect(await blobs.list("uploads/p2/")).toHaveLength(1);
    expect(await blobs.list("catalog/")).toHaveLength(1);
  });

  it("audits completion, and is safe to run twice", async () => {
    const { store, blobs, record } = await project();
    await store.deleteProject("owner", record.id);

    await runPurgeJob(store, blobs);
    const audit = await store.purgeAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.projectId).toBe(record.id);
    expect(audit[0]!.objectsRemoved).toBe(3);

    // Nothing left pending, so a second run is a no-op rather than a re-purge.
    expect(await store.pendingPurges()).toEqual([]);
    expect(await runPurgeJob(store, blobs)).toEqual([]);
  });

  it("reports a deletion whose bytes outlived the 24-hour promise", async () => {
    const { store, record } = await project();
    await store.deleteProject("owner", record.id);

    const now = () => new Date(Date.now() + (PURGE_DEADLINE_HOURS + 1) * 3_600_000).toISOString();
    const overdue = await overduePurges(store, now);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.projectId).toBe(record.id);
    expect(overdue[0]!.overdueHours).toBeGreaterThan(PURGE_DEADLINE_HOURS);

    // And nothing is overdue the moment it is requested.
    expect(await overduePurges(store)).toEqual([]);
  });

  it("purges a project's uploads from the record store too", async () => {
    const { store, record } = await project();
    await store.createUpload({
      id: "u1",
      projectId: record.id,
      kind: "photo",
      filename: "a.jpg",
      byteSize: 10,
      sha256: "a".repeat(64),
      status: "stored",
      storageRef: `uploads/${record.id}/a.jpg`,
    });
    await store.deleteProject("owner", record.id);
    expect(await store.listUploads(record.id)).toEqual([]);
  });
});
