import {
  planToShell,
  type JobEvent,
  type RoomPlan,
  type Scene,
  type ScanParse,
} from "@myroom/schema";
import { assembleScene, demoMeasuredObjects, matchCatalog } from "@myroom/recon";
import { getCategory } from "@myroom/catalog";
import { uuidv7 } from "./uuid.js";
import type { LocalUpload } from "./db.js";

/**
 * Client half of the reconstruction flow (docs/01 §8, docs/03 §3–§5).
 *
 * Two paths, and which one runs is never hidden from the user:
 *
 * 1. **Server** — when an API is configured, photos upload to storage and the
 *    pipeline runs on the worker tier; progress arrives over SSE.
 * 2. **Demo** — the static build (GitHub Pages staging) has no API and no GPU.
 *    Rather than a dead end, it lays a typical room out from the floor plan and
 *    says so, on the processing screen and in the room's own warning list. It
 *    is *not* a reconstruction of anyone's photos and must never be shown as
 *    one; see DECISIONS.md → "Demo reconstruction is labelled".
 */

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
export const hasApi = API_BASE.length > 0;

export const DEMO_NOTICE =
  "Demo reconstruction: these pieces are examples laid out from your floor plan, not objects detected in your photos.";

export interface ReconstructResult {
  scene: Scene;
  warnings: string[];
  tier: Scene["provenance"]["tier"];
  demo: boolean;
}

export interface ReconstructInput {
  projectId: string;
  plan: RoomPlan;
  uploads: LocalUpload[];
  scan?: ScanParse | null;
  onEvent: (event: JobEvent) => void;
  signal?: AbortSignal;
}

export async function reconstruct(input: ReconstructInput): Promise<ReconstructResult> {
  return hasApi ? viaApi(input) : locally(input);
}

// --- demo path ---------------------------------------------------------------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

async function locally({ plan, uploads, scan, onEvent, signal }: ReconstructInput): Promise<ReconstructResult> {
  const shell = planToShell(plan);
  if (!shell) throw new Error("Draw and close the room before building it.");

  const photos = uploads.filter((u) => u.kind === "photo");
  onEvent({ type: "stage", stage: "detect-segment", progress: null });
  await sleep(240, signal);

  const measured = photos.length > 0 ? demoMeasuredObjects(shell, { newId: uuidv7 }) : [];
  onEvent({ type: "stage", stage: "depth-scale", progress: 1 });
  await sleep(200, signal);

  onEvent({ type: "stage", stage: "match-texture", progress: 0 });
  const matches = measured.map((m) => matchCatalog({ measured: m }));

  // The objects already exist; the pacing here is the reveal animation of
  // docs/01 §8 ("detected-object silhouettes pop in one by one"), not a stage
  // pretending to take time.
  for (let i = 0; i < measured.length; i++) {
    const m = measured[i]!;
    onEvent({
      type: "object",
      category: m.category,
      label: getCategory(m.category)?.label ?? m.category,
      position: m.position,
      size: m.size,
      confidence: m.confidence,
    });
    onEvent({ type: "stage", stage: "match-texture", progress: (i + 1) / measured.length });
    await sleep(160, signal);
  }

  onEvent({ type: "stage", stage: "scene-assemble", progress: 0 });
  const tier: Scene["provenance"]["tier"] = scan ? "lidar" : photos.length > 0 ? "photo" : "sketch";
  const { scene, warnings } = assembleScene({
    sceneId: uuidv7(),
    planId: plan.id,
    shell,
    measured,
    matches,
    tier,
    jobId: null,
    now: new Date().toISOString(),
    newId: uuidv7,
  });

  const notices = [
    ...(photos.length > 0 ? [DEMO_NOTICE] : ["No photos yet — add pieces yourself from the catalog whenever you like."]),
    ...warnings,
  ];
  for (const message of notices) onEvent({ type: "warning", message, wallLabel: null });
  onEvent({ type: "stage", stage: "done", progress: 1 });
  onEvent({ type: "done", status: "partial", sceneId: scene.id, tier });

  return { scene, warnings: notices, tier, demo: photos.length > 0 };
}

// --- server path -------------------------------------------------------------

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", ...init });
  if (!res.ok && res.headers.get("content-type")?.includes("problem+json")) {
    const problem = (await res.json()) as { detail?: string; title?: string };
    throw new Error(problem.detail ?? problem.title ?? "That didn't work.");
  }
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res;
}

/** Upload one file direct-to-storage and confirm it (docs/03 §3). */
export async function uploadOne(projectId: string, upload: LocalUpload): Promise<string> {
  const created = await api(`/v1/projects/${projectId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: upload.kind,
      filename: upload.filename,
      size: upload.blob.size,
      sha256: await sha256(upload.blob),
      ...(upload.wallLabel ? { wallTag: upload.wallLabel } : {}),
    }),
  }).then((r) => r.json());

  const target = created.uploadUrl.startsWith("http") ? created.uploadUrl : `${API_BASE}${created.uploadUrl}`;
  const put = await fetch(target, {
    method: "PUT",
    body: upload.blob,
    headers: { "content-type": upload.blob.type || "application/octet-stream" },
  });
  if (!put.ok) throw new Error("The upload didn't go through. Check your connection and try again.");

  await api(`/v1/projects/${projectId}/uploads/${created.upload.id}/complete`, { method: "POST" });
  return created.upload.id as string;
}

async function viaApi({ projectId, uploads, onEvent, signal }: ReconstructInput): Promise<ReconstructResult> {
  const photoIds: string[] = [];
  let lidarId: string | null = null;
  for (const upload of uploads) {
    const remoteId = upload.remoteId ?? (await uploadOne(projectId, upload));
    if (upload.kind === "lidar") lidarId = remoteId;
    else photoIds.push(remoteId);
  }

  const { jobId } = await api(`/v1/projects/${projectId}/reconstruct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photoIds, lidarId }),
  }).then((r) => r.json());

  const warnings: string[] = [];
  const done = await streamJob(jobId, (event) => {
    if (event.type === "warning") warnings.push(event.message);
    onEvent(event);
  }, signal);

  const scene = (await api(`/v1/projects/${projectId}/scene`).then((r) => r.json())) as Scene;
  return { scene, warnings, tier: done.tier, demo: false };
}

/**
 * Follow a job's SSE stream to completion. `EventSource` can't send cookies to
 * a cross-origin API, so the stream is read from `fetch` — which also gives us
 * the abort signal for free when the user leaves the screen.
 */
export async function streamJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  signal?: AbortSignal,
): Promise<Extract<JobEvent, { type: "done" }>> {
  const res = await fetch(`${API_BASE}/v1/jobs/${jobId}/events`, {
    credentials: "include",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.body) throw new Error("Progress updates aren't available right now.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) {
        const event = JSON.parse(line.slice(6)) as JobEvent;
        onEvent(event);
        if (event.type === "done") return event;
        if (event.type === "error") throw new Error(event.message);
      }
      split = buffer.indexOf("\n\n");
    }
  }
  throw new Error("The connection dropped before your room was finished.");
}
