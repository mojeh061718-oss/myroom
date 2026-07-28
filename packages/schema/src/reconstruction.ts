import { z } from "zod";
import { Id, planLoop, type RoomPlan } from "./roomplan.js";
import { SupportSchema } from "./scene.js";

/**
 * Reconstruction contracts (docs/05, docs/03 §3–§4).
 *
 * Every artifact each pipeline stage writes to object storage is defined here,
 * so the TypeScript orchestrator and the Python workers agree by construction —
 * the workers validate against the JSON Schema generated from these shapes
 * (docs/03 §2: "Never hand-write a type that exists in schema").
 */

// --- capture (docs/01 §6) ----------------------------------------------------

export const ShotKindSchema = z.enum(["wall", "corner", "detail"]);

/**
 * One requested photo. The shot list is generated from the plan, so the guided
 * flow can say exactly which wall is still missing ("3 of 4 walls photographed").
 */
export const CaptureShotSchema = z.object({
  id: z.string().min(1),
  kind: ShotKindSchema,
  /** wall label for kind="wall"; the two labels flanking the corner otherwise */
  wallLabels: z.array(z.string()).min(0),
  prompt: z.string().min(1),
  /** a wall shot is required to proceed; corner and detail shots are optional */
  required: z.boolean(),
});
export type CaptureShot = z.infer<typeof CaptureShotSchema>;

export const CapturePlanSchema = z.object({
  planId: Id,
  shots: z.array(CaptureShotSchema),
});
export type CapturePlan = z.infer<typeof CapturePlanSchema>;

/**
 * Instant per-photo quality check (docs/01 §6). Failures "prompt a friendly
 * retake suggestion, never a block", so this carries advice, not a veto.
 */
export const PhotoQualitySchema = z.object({
  /** variance of the Laplacian, normalized; higher is sharper */
  sharpness: z.number().nonnegative(),
  /** mean luma, 0–1 */
  exposure: z.number().min(0).max(1),
  verdict: z.enum(["good", "soft", "dark", "bright"]),
  advice: z.string().nullable(),
});
export type PhotoQuality = z.infer<typeof PhotoQualitySchema>;

// --- pipeline artifacts (docs/05 §3–§7) --------------------------------------

const Vec3 = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const Size3 = z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() });

/** Stage 1 output, per photo (docs/05 §3). */
export const DetectionSchema = z.object({
  id: Id,
  photoId: Id,
  /** taxonomy category id when the class maps cleanly, else the raw prompt */
  category: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** pixel box [x, y, w, h] in the source photo */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** storage ref of the SAM 2 mask crop, consumed by stage 5 */
  maskRef: z.string().nullable(),
  wallTag: z.string().nullable(),
});
export type Detection = z.infer<typeof DetectionSchema>;

/** Stage 2 output, per photo (docs/05 §4). */
export const CameraSolveSchema = z.object({
  photoId: Id,
  wallLabel: z.string().nullable(),
  /** camera position and yaw in world meters/radians */
  position: Vec3,
  yaw: z.number().finite(),
  pitch: z.number().finite(),
  /** vertical field of view, radians */
  fovY: z.number().positive(),
  /** scale factor applied to the monocular depth map to match the known wall */
  depthScale: z.number().positive(),
  solved: z.boolean(),
  /** why the solve failed, when solved=false (docs/05 §8 → lowConfidence) */
  failure: z.string().nullable(),
});
export type CameraSolve = z.infer<typeof CameraSolveSchema>;

/** Stage 3 output, one per object instance seen in one photo (docs/05 §5). */
export const MeasuredObjectSchema = z.object({
  id: Id,
  category: z.string().min(1),
  position: Vec3,
  rotationY: z.number().finite(),
  size: Size3,
  support: SupportSchema,
  confidence: z.number().min(0).max(1),
  sourcePhotoIds: z.array(Id).min(1),
  /** true when the pose solve failed and placement fell back to the wall tag */
  lowConfidence: z.boolean(),
  /** dominant colour from stage 5, applied to the model's albedo slots */
  palette: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).default([]),
  /** rectified crop for flat-front classes (framed art, TVs, rugs) */
  faceTextureRef: z.string().nullable().default(null),
});
export type MeasuredObject = z.infer<typeof MeasuredObjectSchema>;

/** Stage 4 output, per measured object (docs/05 §6). */
export const CatalogMatchSchema = z.object({
  measuredId: Id,
  /** null ⇒ no acceptable match ⇒ parametric placeholder, never omission */
  catalogId: z.string().nullable(),
  score: z.number().min(0).max(1),
  runnerUpCatalogIds: z.array(z.string()).max(2),
});
export type CatalogMatch = z.infer<typeof CatalogMatchSchema>;

// --- Stage 0, LiDAR (docs/05 §2) ---------------------------------------------

export const ScanFormatSchema = z.enum(["roomplan-json", "usdz", "ply", "glb", "e57", "las"]);

/**
 * A wall the scan found, expressed in the plan's own 2D frame after
 * registration, so it can be compared against what the user drew.
 */
export const ScanWallSchema = z.object({
  start: z.object({ x: z.number(), y: z.number() }),
  end: z.object({ x: z.number(), y: z.number() }),
  height: z.number().positive().nullable(),
});

export const ScanSeedBoxSchema = z.object({
  category: z.string().nullable(),
  position: Vec3,
  rotationY: z.number().finite(),
  size: Size3,
});

/**
 * Where the scan and the drawing disagree. docs/05 §2: the drawing is
 * *corrected, not replaced*, and disagreements over 0.4 m "flag a review prompt
 * rather than silently overriding".
 */
export const ScanDisagreementSchema = z.object({
  wallId: Id,
  wallLabel: z.string(),
  drawnLength: z.number().positive(),
  scannedLength: z.number().positive(),
  /** metres; > REVIEW_THRESHOLD_M needs the user's decision */
  delta: z.number(),
  needsReview: z.boolean(),
});
export type ScanDisagreement = z.infer<typeof ScanDisagreementSchema>;

export const REVIEW_THRESHOLD_M = 0.4;

export const ScanParseSchema = z.object({
  format: ScanFormatSchema,
  /** false ⇒ proceed photo-only with an explanatory toast (docs/05 §8) */
  parsed: z.boolean(),
  failure: z.string().nullable(),
  walls: z.array(ScanWallSchema),
  ceilingHeight: z.number().positive().nullable(),
  seedBoxes: z.array(ScanSeedBoxSchema),
  disagreements: z.array(ScanDisagreementSchema),
  /** point-cloud silhouette in plan coordinates, for the S5 preview overlay */
  silhouette: z.array(z.tuple([z.number(), z.number()])).default([]),
});
export type ScanParse = z.infer<typeof ScanParseSchema>;

// --- job & events (docs/03 §4–§5) --------------------------------------------

export const JobStageSchema = z.enum([
  "queued",
  "lidar-parse",
  "detect-segment",
  "depth-scale",
  "match-texture",
  "scene-assemble",
  "done",
]);
export type JobStage = z.infer<typeof JobStageSchema>;

/** Stage list shown with checkmarks on S6, in order (docs/01 §8). */
export const STAGE_LABELS: Record<JobStage, string> = {
  queued: "Getting ready",
  "lidar-parse": "Reading your scan",
  "detect-segment": "Reading photos",
  "depth-scale": "Finding objects",
  "match-texture": "Matching furniture",
  "scene-assemble": "Building your room",
  done: "Done",
};

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "partial", "failed"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ReconstructionJobSchema = z.object({
  id: Id,
  projectId: Id,
  status: JobStatusSchema,
  stage: JobStageSchema,
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  /** every non-fatal fallback taken, surfaced verbatim on S6 (docs/05 §8) */
  warnings: z.array(z.string()),
  sceneId: Id.nullable(),
  tier: z.enum(["sketch", "photo", "lidar"]),
});
export type ReconstructionJob = z.infer<typeof ReconstructionJobSchema>;

/**
 * SSE payloads (docs/03 §5). The Processing screen is driven entirely by these:
 * a stage event ticks the checklist, an object event pops a silhouette into the
 * plan ("Found: sofa · 2.2 m").
 */
export const JobEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stage"),
    stage: JobStageSchema,
    /** 0–1 within the stage; null when the stage has no measurable progress */
    progress: z.number().min(0).max(1).nullable(),
  }),
  z.object({
    type: z.literal("object"),
    category: z.string(),
    label: z.string(),
    position: Vec3,
    size: Size3,
    confidence: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal("warning"), message: z.string(), wallLabel: z.string().nullable() }),
  z.object({
    type: z.literal("done"),
    status: JobStatusSchema,
    sceneId: Id,
    tier: z.enum(["sketch", "photo", "lidar"]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type JobEvent = z.infer<typeof JobEventSchema>;

// --- share (docs/03 §3) ------------------------------------------------------

export const ShareTokenSchema = z.object({
  token: z.string().min(16),
  projectId: Id,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});
export type ShareToken = z.infer<typeof ShareTokenSchema>;

// --- request bodies ----------------------------------------------------------

export const CreateUploadBody = z.object({
  kind: z.enum(["photo", "lidar"]),
  filename: z.string().min(1).max(256),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  wallTag: z.string().max(8).optional(),
});

export const ReconstructBody = z.object({
  /** uploads to use; empty ⇒ the API answers with the "no photos" problem */
  photoIds: z.array(Id),
  lidarId: Id.nullable().default(null),
});

// --- capture plan generation (docs/01 §6) ------------------------------------

/**
 * The requested shot set for a plan: one photo per wall (required), plus one
 * corner-to-corner wide shot per opposing corner pair. Detail shots are
 * unlimited and user-initiated, so they are not enumerated here.
 */
export function capturePlanFor(plan: RoomPlan): CapturePlan {
  const shots: CaptureShot[] = plan.walls.map((wall) => ({
    id: `wall-${wall.id}`,
    kind: "wall" as const,
    wallLabels: [wall.label],
    prompt: `Stand back and photograph Wall ${wall.label} — get the whole wall in frame.`,
    required: true,
  }));

  // "Opposing" corners are those roughly half the loop apart: in a rectangle the
  // two diagonals, in an L-shape the three widest sightlines. Pairing i with
  // i + ⌊n/2⌋ walks each diagonal exactly once for even n and covers every
  // vertex for odd n.
  const loop = planLoop(plan);
  if (loop && loop.length >= 4) {
    const n = loop.length;
    const half = Math.floor(n / 2);
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const j = (i + half) % n;
      const key = [i, j].sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      // The walls meeting at each corner name it for the user.
      const labels = [cornerLabel(plan, i), cornerLabel(plan, j)];
      shots.push({
        id: `corner-${key}`,
        kind: "corner",
        wallLabels: labels,
        prompt: `From the ${labels[0]} corner, take one wide shot across the room.`,
        required: false,
      });
    }
  }

  return { planId: plan.id, shots };
}

/** Name a corner by the walls that meet at it: "A/B". */
function cornerLabel(plan: RoomPlan, vertexIndex: number): string {
  const incoming = plan.walls[(vertexIndex - 1 + plan.walls.length) % plan.walls.length];
  const outgoing = plan.walls[vertexIndex % plan.walls.length];
  return [incoming?.label, outgoing?.label].filter(Boolean).join("/");
}

/**
 * Which required shots are still missing, given the wall tags already uploaded.
 * Drives the "3 of 4 walls photographed" progress line.
 */
export function missingWallShots(plan: RoomPlan, taggedWallLabels: string[]): string[] {
  const have = new Set(taggedWallLabels);
  return plan.walls.map((w) => w.label).filter((label) => !have.has(label));
}
