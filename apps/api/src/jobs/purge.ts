import type { Blobs } from "../blobs.js";
import type { Store } from "../store.js";

/**
 * Storage purge (docs/03 §7, docs/01 §12).
 *
 * "Deletion is real: project delete → immediate DB tombstone → storage purge
 * job removes all `uploads/` and `scenes/` objects within 24 h; purge
 * completion is audited."
 *
 * The tombstone is written synchronously by `deleteProject`; this job does the
 * byte removal. It is idempotent and safe to run on a schedule.
 */

export const PURGE_DEADLINE_HOURS = 24;

export interface PurgeReport {
  projectId: string;
  objectsRemoved: number;
  requestedAt: string;
  completedAt: string;
  /** hours between the deletion request and the bytes actually going */
  latencyHours: number;
}

export async function runPurgeJob(
  store: Store,
  blobs: Blobs,
  now: () => string = () => new Date().toISOString(),
): Promise<PurgeReport[]> {
  const pending = await store.pendingPurges();
  const reports: PurgeReport[] = [];

  for (const entry of pending) {
    // Every prefix a project's bytes can live under (docs/03 §7). `catalog/` is
    // public and shared, and is deliberately not one of them.
    let removed = 0;
    for (const prefix of [`uploads/${entry.projectId}/`, `scenes/${entry.projectId}/`]) {
      removed += await blobs.deletePrefix(prefix);
    }
    const completedAt = now();
    await store.markPurged(entry.projectId, removed, completedAt);
    reports.push({
      projectId: entry.projectId,
      objectsRemoved: removed,
      requestedAt: entry.requestedAt,
      completedAt,
      latencyHours: (Date.parse(completedAt) - Date.parse(entry.requestedAt)) / 3_600_000,
    });
  }

  return reports;
}

/**
 * Anything deleted more than 24 h ago whose bytes are still present. A
 * non-empty result is a broken promise, so it is a check, not a metric.
 */
export async function overduePurges(
  store: Store,
  now: () => string = () => new Date().toISOString(),
): Promise<{ projectId: string; requestedAt: string; overdueHours: number }[]> {
  const cutoff = Date.parse(now()) - PURGE_DEADLINE_HOURS * 3_600_000;
  return (await store.pendingPurges())
    .filter((entry) => Date.parse(entry.requestedAt) < cutoff)
    .map((entry) => ({
      ...entry,
      overdueHours: (Date.parse(now()) - Date.parse(entry.requestedAt)) / 3_600_000,
    }));
}
