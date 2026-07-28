import {
  planToShell,
  type JobStage,
  type MeasuredObject,
  type ReconstructionJob,
  type ScanParse,
  type Scene,
  type Upload,
} from "@myroom/schema";
import { assembleScene, demoMeasuredObjects, matchCatalog } from "@myroom/recon";
import { getCategory } from "@myroom/catalog";
import type { EventBus, QueuedJob } from "./queue.js";
import type { Store } from "../store.js";

/**
 * The `reconstruct` orchestrator (docs/03 §4). It owns stage sequencing,
 * timeouts, and the fallback table in docs/05 §8 — the pipeline never
 * dead-ends, so every path through this function ends in an editable scene.
 *
 * Stages 0–3 and 5 (scan parse, detect, solve, measure, appearance) are pixel
 * and point-cloud work and belong to the Python workers behind `StageWorkers`.
 * Stages 4 and 6 (catalog match, assembly) run here, in TypeScript, because
 * they are pure operations over `packages/catalog` and `packages/geometry`;
 * see DECISIONS.md → "Where the pipeline's non-pixel stages run".
 */

export interface MeasureResult {
  measured: MeasuredObject[];
  warnings: string[];
  /** per-photo notes: which photos were skipped and why (docs/05 §8) */
  unusablePhotoIds: string[];
}

/**
 * The seam between the orchestrator and the GPU tier. The production driver
 * dispatches BullMQ jobs to the Python workers; `createDemoWorkers` below is
 * the CPU-only driver used by dev and CI.
 */
export interface StageWorkers {
  name: string;
  parseScan(lidar: Upload): Promise<ScanParse>;
  measure(input: {
    photos: Upload[];
    scan: ScanParse | null;
    shell: NonNullable<ReturnType<typeof planToShell>>;
    onProgress: (stage: JobStage, progress: number) => void;
  }): Promise<MeasureResult>;
}

export interface RunOptions {
  store: Store;
  bus: EventBus;
  workers: StageWorkers;
  job: QueuedJob;
  now: () => string;
  newId: () => string;
  /** docs/03 §4: 5 min per stage, 10 min total */
  stageTimeoutMs?: number;
}

export const STAGE_TIMEOUT_MS = 5 * 60 * 1000;

async function withTimeout<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one reconstruction to completion. Resolves with the final job record —
 * `failed` only when there was not even a plan to build a shell from, because
 * anything less still yields the accurate empty room (docs/05 §8).
 */
export async function runReconstruction(opts: RunOptions): Promise<ReconstructionJob> {
  const { store, bus, workers, job, now, newId } = opts;
  const timeout = opts.stageTimeoutMs ?? STAGE_TIMEOUT_MS;
  const warnings: string[] = [];

  const setStage = async (stage: JobStage, progress: number | null = null) => {
    await store.updateJob(job.jobId, { stage, status: stage === "done" ? "succeeded" : "running" });
    bus.publish(job.jobId, { type: "stage", stage, progress });
  };

  const project = await store.getProject(job.ownerId, job.projectId);
  const plan = project?.plan ?? null;
  const shell = plan ? planToShell(plan) : null;
  if (!plan || !shell) {
    const failed = await store.updateJob(job.jobId, {
      status: "failed",
      stage: "queued",
      finishedAt: now(),
      warnings: ["This project has no closed floor plan yet."],
    });
    bus.publish(job.jobId, { type: "error", message: "Draw and close the room before building it." });
    return failed!;
  }

  const uploads = await store.listUploads(job.projectId);
  const photos = uploads.filter((u) => job.photoIds.includes(u.id) && u.status === "stored");
  const lidar = job.lidarId ? (uploads.find((u) => u.id === job.lidarId) ?? null) : null;

  let scan: ScanParse | null = null;
  if (lidar) {
    await setStage("lidar-parse");
    try {
      scan = await withTimeout(workers.parseScan(lidar), timeout, "Reading your scan");
      if (!scan.parsed) {
        // "Proceed photo-only; toast explains the scan couldn't be read."
        warnings.push(`We couldn't read that scan (${scan.failure ?? "unsupported file"}), so we used your photos only.`);
        bus.publish(job.jobId, { type: "warning", message: warnings[warnings.length - 1]!, wallLabel: null });
        scan = null;
      }
    } catch (error) {
      warnings.push(`Reading the scan took too long, so we used your photos only.`);
      bus.publish(job.jobId, { type: "warning", message: warnings[warnings.length - 1]!, wallLabel: null });
      void error;
      scan = null;
    }
  }

  let measured: MeasuredObject[] = [];
  await setStage("detect-segment", 0);
  try {
    const result = await withTimeout(
      workers.measure({
        photos,
        scan,
        shell,
        onProgress: (stage, progress) => bus.publish(job.jobId, { type: "stage", stage, progress }),
      }),
      timeout,
      "Finding objects",
    );
    measured = result.measured;
    warnings.push(...result.warnings);
    for (const warning of result.warnings) {
      bus.publish(job.jobId, { type: "warning", message: warning, wallLabel: null });
    }
  } catch (error) {
    // A dead vision tier is not a dead end: the room shell is still exact.
    warnings.push("We couldn't read the photos this time, so here's your room with nothing in it yet.");
    bus.publish(job.jobId, { type: "warning", message: warnings[warnings.length - 1]!, wallLabel: null });
    void error;
  }

  if (measured.length === 0) {
    warnings.push("No furniture was recognized — add pieces yourself from the catalog whenever you like.");
  }

  await setStage("match-texture", 0);
  const matches = measured.map((m, i) => {
    bus.publish(job.jobId, { type: "stage", stage: "match-texture", progress: (i + 1) / Math.max(1, measured.length) });
    return matchCatalog({ measured: m });
  });

  // Announce each object as it lands, so S6 can pop silhouettes in one by one.
  for (const m of measured) {
    bus.publish(job.jobId, {
      type: "object",
      category: m.category,
      label: getCategory(m.category)?.label ?? m.category,
      position: m.position,
      size: m.size,
      confidence: m.confidence,
    });
  }

  await setStage("scene-assemble", 0);
  const tier: Scene["provenance"]["tier"] = scan ? "lidar" : photos.length > 0 ? "photo" : "sketch";
  const { scene, warnings: assemblyWarnings } = assembleScene({
    sceneId: newId(),
    planId: plan.id,
    shell,
    measured,
    matches,
    tier,
    jobId: job.jobId,
    now: now(),
    newId,
  });
  warnings.push(...assemblyWarnings);

  await store.saveScene(job.ownerId, job.projectId, scene, now());
  const finished = await store.updateJob(job.jobId, {
    status: measured.length === 0 || warnings.length > 0 ? "partial" : "succeeded",
    stage: "done",
    finishedAt: now(),
    warnings,
    sceneId: scene.id,
    tier,
  });
  bus.publish(job.jobId, { type: "stage", stage: "done", progress: 1 });
  bus.publish(job.jobId, { type: "done", status: finished!.status, sceneId: scene.id, tier });
  return finished!;
}

/**
 * CPU-only stage driver for dev and CI (docs/03 §8: "Full local pipeline must
 * run on a laptop without GPU").
 *
 * It does not look at the photos: it lays out a typical room from the shell so
 * the golden path is exercisable without a GPU. Callers must present its output
 * as an example, never as a detection — see `demoMeasuredObjects`.
 */
export function createDemoWorkers(newId: () => string): StageWorkers {
  return {
    name: "demo",
    async parseScan(lidar) {
      return {
        format: "roomplan-json",
        parsed: false,
        failure: `the demo worker cannot read ${lidar.filename}`,
        walls: [],
        ceilingHeight: null,
        seedBoxes: [],
        disagreements: [],
        silhouette: [],
      };
    },
    async measure({ photos, shell, onProgress }) {
      onProgress("detect-segment", 1);
      onProgress("depth-scale", 1);
      // No photos, nothing to find. Inventing furniture for an empty upload set
      // would be a claim about a room nobody photographed.
      if (photos.length === 0) return { measured: [], warnings: [], unusablePhotoIds: [] };
      return {
        measured: demoMeasuredObjects(shell, { newId, photoIds: photos.map((p) => p.id) }),
        warnings: [
          "Demo reconstruction: these pieces are examples laid out from your floor plan, not objects detected in your photos.",
        ],
        unusablePhotoIds: [],
      };
    },
  };
}
