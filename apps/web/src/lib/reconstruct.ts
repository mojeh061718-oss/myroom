import { planLoop, planToShell, type JobEvent, type RoomPlan, type Scene } from "@myroom/schema";
import {
  applyRefinements,
  applyRegistration,
  assembleScene,
  demoMeasuredObjects,
  describeRefinements,
  fuseSeedBoxes,
  matchCatalog,
  parseMeshScan,
  parsePointCloudScan,
  parseRoomPlanJson,
  proposeRefinements,
  registerScanToPlan,
  SCANNED_ITEM_CATEGORY,
  SCANNED_ITEM_LABEL,
  type RefinementProposal,
  type ScanSeedObject,
  type ScanWallLine,
} from "@myroom/recon";
import { getCategory, OBJECT_CATEGORIES } from "@myroom/catalog";
import { decodeScanFile } from "./scanDecode.js";
import { t } from "../i18n/index.js";
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

export const DEMO_NOTICE = t("recon.demoNotice");

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
  /** true when stage 0 actually read the scan and used it (docs/05 §9) */
  scanParsed?: boolean;
  /** objects the scan measured, fused into stage 3 (docs/05 §5) */
  seeds?: ScanSeedObject[];
  onEvent: (event: JobEvent) => void;
  signal?: AbortSignal;
}

export async function reconstruct(input: ReconstructInput): Promise<ReconstructResult> {
  if (!hasApi) return locally(input);
  try {
    return await viaApi(input);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    // A configured-but-unreachable API must not be a dead end when the whole
    // pipeline can run on the device (docs/03 §6). Say which path ran.
    input.onEvent({
      type: "warning",
      message: "We couldn't reach the server, so your room was built on this device instead.",
      wallLabel: null,
    });
    return locally(input);
  }
}

export interface ScanRefinement {
  plan: RoomPlan;
  /** what changed, and what we deliberately left alone (docs/05 §2) */
  notes: string[];
  /** true only when the scan was actually read and used */
  refined: boolean;
  /** the furniture the scan measured, registered into PLAN coordinates */
  seeds: ScanSeedObject[];
  /** the same seeds in the scan's own frame (index-aligned with `seeds`) */
  scanSeeds: ScanSeedObject[];
  /** decoded scan geometry (world Y-up, scan frame), for thumbnails */
  scanMesh: { positions: Float32Array; indices: Uint32Array } | null;
}

/**
 * Lay the scan's furniture into the plan's coordinate frame (docs/05 §2:
 * "register scan to the user's plan… then 2D ICP of extracted wall lines
 * against the drawn polygon"). Without this the seed boxes arrive wherever
 * the scanner's session origin was — real objects in the wrong room.
 */
function registerSeeds(
  plan: RoomPlan,
  scanWallLines: readonly ScanWallLine[],
  seeds: ScanSeedObject[],
): { seeds: ScanSeedObject[]; note: string | null } {
  if (seeds.length === 0) return { seeds, note: null };
  const loop = planLoop(plan);
  if (!loop || scanWallLines.length < 2) return { seeds, note: null };
  const registration = registerScanToPlan(scanWallLines, loop);
  if (!registration || registration.residual > 0.5) {
    return {
      seeds,
      note: "We couldn't confidently line the scan's furniture up with your walls — check positions after building, and drag anything that's off.",
    };
  }
  const moved = seeds.map((seed) => {
    // World (x, z) ↔ plan (x, −z); yaw adds the registration's rotation.
    const p = applyRegistration(registration, { x: seed.position.x, y: -seed.position.z });
    return {
      ...seed,
      position: { x: p.x, y: seed.position.y, z: -p.y },
      rotationY: seed.rotationY + registration.rotation,
    };
  });
  const degrees = Math.round((((registration.rotation * 180) / Math.PI) % 360 + 360) % 360);
  const cm = Math.max(1, Math.round(registration.residual * 100));
  return {
    seeds: moved,
    note: `Lined the scan up with your walls${degrees ? ` (rotated ${degrees}°)` : ""} — matched to about ${cm} cm.`,
  };
}

/**
 * Refinements that survive a wall-count mismatch. Length-rank pairing needs
 * one scanned wall per drawn wall, but the ceiling height the scan measured
 * is a scalar and stays true however many walls the tracer found — a scan
 * that can't correct the outline can still correct the ceiling. Seeds are
 * registered against the plan as it stands AFTER refinement, so a corrected
 * scale can't strand the furniture in pre-correction coordinates.
 */
function applyWhatFits(
  plan: RoomPlan,
  proposal: RefinementProposal,
  rawSeeds: ScanSeedObject[],
  scanWallLines: readonly ScanWallLine[],
  scanMesh: ScanRefinement["scanMesh"],
): ScanRefinement {
  let refinedPlan: RoomPlan;
  let notes: string[];
  let refined: boolean;
  if (proposal.comparable) {
    refinedPlan = applyRefinements(plan, proposal);
    notes = describeRefinements(proposal, refinedPlan, plan);
    refined = true;
  } else {
    const partial: RefinementProposal = { ...proposal, disagreements: [], uniformScale: null };
    refinedPlan = applyRefinements(plan, partial);
    refined = refinedPlan !== plan;
    notes = [
      `We couldn't line the scan up with your plan (${proposal.reason}), so we kept your walls as you drew them.`,
      ...describeRefinements(partial, refinedPlan, plan),
    ];
  }
  const registered = registerSeeds(refinedPlan, scanWallLines, rawSeeds);
  if (registered.note) notes.push(registered.note);
  return { plan: refinedPlan, notes, refined, seeds: registered.seeds, scanSeeds: rawSeeds, scanMesh };
}

/**
 * Stage 0 on the device (docs/05 §2).
 *
 * Every accepted format is read here: RoomPlan JSON (parametric — the gold
 * input), GLB and PLY meshes (including Draco), PLY and LAS point clouds, and
 * USDZ archives. The scan corrects the drawn plan — uniform scale and ceiling
 * height — and its measured furniture comes back as seeds for stage 3.
 * Formats that genuinely can't be read on the device (LAZ, E57, binary USDC)
 * get a message that says which export switch to flip.
 */
export async function refineFromScan(plan: RoomPlan, uploads: LocalUpload[]): Promise<ScanRefinement> {
  const none: Omit<ScanRefinement, "plan" | "notes"> = { refined: false, seeds: [], scanSeeds: [], scanMesh: null };
  const scan = uploads.find((u) => u.kind === "lidar");
  if (!scan) return { plan, notes: [], ...none };

  const geometry = await decodeScanFile(scan.blob);

  if (geometry.kind === "error") {
    return { plan, notes: [`We couldn't read that scan: ${geometry.reason}.`], ...none };
  }

  if (geometry.kind === "roomplan-json") {
    const preview = parseRoomPlanJson(geometry.text);
    if (!preview) {
      // docs/05 §8: a scan we can't read is a toast, not a failure.
      return { plan, notes: ["We couldn't read that scan, so we used your plan and photos."], ...none };
    }
    const lines = preview.walls.map((w) => ({ start: w.start, end: w.end }));
    const proposal = proposeRefinements(plan, preview.walls, preview.ceilingHeight);
    return applyWhatFits(plan, proposal, preview.objects, lines, null);
  }

  const parsed =
    geometry.kind === "mesh"
      ? parseMeshScan(geometry.positions, geometry.indices, geometry.format, { categories: OBJECT_CATEGORIES })
      : parsePointCloudScan(geometry.positions, geometry.format, { categories: OBJECT_CATEGORIES });
  if (!parsed.parsed) {
    return { plan, notes: [`We couldn't read that scan: ${parsed.failure ?? "unknown reason"}.`], ...none };
  }

  // ScanParse carries walls as {x, y} points; the refiner wants tuples.
  const lines = parsed.walls.map((w) => ({
    start: [w.start.x, w.start.y] as [number, number],
    end: [w.end.x, w.end.y] as [number, number],
  }));
  const proposal = proposeRefinements(plan, lines, parsed.ceilingHeight);
  // The boxes the scan measured are seeds whether or not the outline lined
  // up — they were thrown away here once, which meant a scanned room came
  // back furnished with invented demo furniture.
  return applyWhatFits(plan, proposal, parsed.seedBoxes, lines, {
    positions: geometry.positions,
    indices: geometry.kind === "mesh" ? geometry.indices : new Uint32Array(),
  });
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

async function locally({ plan, uploads, scanParsed, seeds, onEvent, signal }: ReconstructInput): Promise<ReconstructResult> {
  const shell = planToShell(plan);
  if (!shell) throw new Error("Draw and close the room before building it.");

  const photos = uploads.filter((u) => u.kind === "photo");
  const scanned = scanParsed ?? false;
  onEvent({ type: "stage", stage: "detect-segment", progress: null });
  await sleep(240, signal);

  // Anything the scan measured is data about this room, so it replaces the
  // demo layout rather than being mixed with it — half-real furniture would
  // be impossible for anyone to reason about. An unnamed box still earns its
  // place: "something this size is here" was measured, and the user can say
  // what it is with Swap. Falling back to invented demo furniture because the
  // scan declined to *name* what it measured was the old behaviour, and it
  // meant a scanned room came back furnished with fiction.
  const scanSeeds = seeds ?? [];
  const measured =
    scanSeeds.length > 0
      ? fuseSeedBoxes([], scanSeeds, { newId: uuidv7 }).measured
      : photos.length > 0
        ? demoMeasuredObjects(shell, { newId: uuidv7 })
        : [];
  const fromScan = scanSeeds.length > 0;
  // Say it before the first fabricated object appears, not after the room is
  // finished — a label that arrives late has already misled someone.
  if (!fromScan && photos.length > 0) onEvent({ type: "warning", message: DEMO_NOTICE, wallLabel: null });
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
      label: getCategory(m.category)?.label ?? (m.category === SCANNED_ITEM_CATEGORY ? SCANNED_ITEM_LABEL : m.category),
      position: m.position,
      size: m.size,
      confidence: m.confidence,
    });
    onEvent({ type: "stage", stage: "match-texture", progress: (i + 1) / measured.length });
    await sleep(160, signal);
  }

  onEvent({ type: "stage", stage: "scene-assemble", progress: 0 });
  // The badge is the honesty contract (docs/05 §9), and the same test has to
  // apply to photos as to scans: a tier is earned by what was *measured*, not
  // by what was uploaded.
  //
  // This used to read `photos.length > 0 ? "photo" : "sketch"`, which awarded
  // "Photo-calibrated" — and its promise of "positions within about 15 cm" —
  // to any room where the user had attached photos, whatever happened next. On
  // this path nothing happens next: `demoMeasuredObjects` lays out a typical
  // room from the floor plan and never opens a photo. A user who took four
  // photos got a confident accuracy claim over furniture that was invented.
  //
  // The test is `fromScan`, not `scanned`. `scanned` only says the file
  // parsed; `fromScan` says objects in this room were actually measured.
  //
  // Getting that wrong is not hypothetical — the first version of this fix
  // used `scanned` and moved the bug rather than removing it. A mesh scan
  // (.glb/.ply) parses successfully and deliberately returns no seed boxes,
  // because an unlabelled mesh cannot say *what* occupies a volume. So it
  // parsed, fell through to demoMeasuredObjects, and was badged
  // "LiDAR-verified" over furniture the app invented — the same lie as before
  // with a different word on it.
  //
  // A parsed scan does improve the shell, and that improvement is real: the
  // walls and ceiling height it corrects are measurements. But the badge
  // describes the whole room, and a room whose contents were invented cannot
  // carry a badge promising measured contents.
  const tier: Scene["provenance"]["tier"] = fromScan ? "lidar" : "sketch";
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
    ...(fromScan
      ? [t("recon.fromScan", { count: measured.length })]
      : photos.length > 0
        ? [DEMO_NOTICE]
        : [t("recon.noPhotos")]),
    ...warnings,
  ];
  // The demo notice already went out above; don't say it twice.
  for (const message of notices) {
    if (message !== DEMO_NOTICE) onEvent({ type: "warning", message, wallLabel: null });
  }
  onEvent({ type: "stage", stage: "done", progress: 1 });
  onEvent({ type: "done", status: "partial", sceneId: scene.id, tier });

  return { scene, warnings: notices, tier, demo: !fromScan && photos.length > 0 };
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
