import type { JobEvent, JobStage } from "@myroom/schema";

/**
 * Job pipeline plumbing (docs/03 §4). The production driver is BullMQ over
 * Redis with one queue per stage, consumed by the containerized Python workers;
 * route code only ever sees these two interfaces, so the driver swap touches no
 * handler.
 *
 * The in-process driver below runs the orchestrator in the API process. It is
 * how dev (`docker-compose` without a GPU) and CI run the golden path
 * (docs/03 §8: "Playwright E2E on the golden path (draw → mock-reconstruct →
 * edit)").
 */
export interface QueuedJob {
  jobId: string;
  projectId: string;
  ownerId: string;
  photoIds: string[];
  lidarId: string | null;
}

/** Progress fan-out: Redis pub/sub in production, an emitter in-process here. */
export interface EventBus {
  publish(jobId: string, event: JobEvent): void;
  /** Replays events already seen after `lastEventId`, then streams live ones. */
  subscribe(jobId: string, lastEventId: number, listener: (id: number, event: JobEvent) => void): () => void;
  history(jobId: string): { id: number; event: JobEvent }[];
}

export function createMemoryEventBus(): EventBus {
  const log = new Map<string, { id: number; event: JobEvent }[]>();
  const listeners = new Map<string, Set<(id: number, event: JobEvent) => void>>();

  return {
    publish(jobId, event) {
      const entries = log.get(jobId) ?? [];
      const entry = { id: entries.length + 1, event };
      entries.push(entry);
      log.set(jobId, entries);
      for (const l of listeners.get(jobId) ?? []) l(entry.id, event);
    },
    subscribe(jobId, lastEventId, listener) {
      // Replay first: an SSE reconnect carries Last-Event-ID and must not miss
      // the object discoveries that happened while the socket was down
      // (docs/03 §5).
      for (const entry of log.get(jobId) ?? []) {
        if (entry.id > lastEventId) listener(entry.id, entry.event);
      }
      const set = listeners.get(jobId) ?? new Set();
      set.add(listener);
      listeners.set(jobId, set);
      return () => set.delete(listener);
    },
    history(jobId) {
      return [...(log.get(jobId) ?? [])];
    },
  };
}

/** Stage order, used for both progress reporting and the S6 checklist. */
export const STAGE_ORDER: JobStage[] = [
  "queued",
  "lidar-parse",
  "detect-segment",
  "depth-scale",
  "match-texture",
  "scene-assemble",
  "done",
];
