import { z } from "zod";
import { Id } from "./roomplan.js";

/** docs/07 §3–§5 — Scene, PlacedObject, CatalogItem. */

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const MaterialOverrideSchema = z.object({
  color: HexColor.optional(),
  textureRef: z.string().optional(),
});

/**
 * How an object is held in the room. docs/07 §4 defines floor/wall/surface;
 * "ceiling" is added here because the blueprint's own object vocabulary
 * (docs/05 §3: "pendant") and ceiling fans/chandeliers have no other anchor.
 * See DECISIONS.md → "Ceiling support type".
 */
export const SupportSchema = z.enum(["floor", "wall", "surface", "ceiling"]);
export type Support = z.infer<typeof SupportSchema>;

const PlacedObjectBase = z.object({
  id: Id,
  /** null ⇒ parametric placeholder */
  catalogId: z.string().nullable(),
  placeholder: z
    .object({
      category: z.string(),
      shape: z.string(),
    })
    .nullable(),
  label: z.string(),
  support: SupportSchema,
  /** required when support = "wall" */
  wallId: Id.nullable(),
  /** required when support = "surface" */
  parentObjectId: Id.nullable(),
  /** Y-up world, meters (2D plan (x, y) ↔ 3D (x, −z)) */
  position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
  rotationY: z.number().finite(),
  /** actual instance size, meters */
  size: z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }),
  materials: z.record(MaterialOverrideSchema).default({}),
  collisionExempt: z.boolean().default(false),
  /** present only on pipeline-created objects */
  recon: z
    .object({
      confidence: z.number().min(0).max(1),
      sourcePhotoIds: z.array(Id),
      runnerUpCatalogIds: z.array(z.string()),
      lowConfidence: z.boolean(),
    })
    .nullable()
    .default(null),
});

export const PlacedObjectSchema = PlacedObjectBase.superRefine((o, ctx) => {
  if ((o.catalogId === null) === (o.placeholder === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of catalogId/placeholder must be non-null" });
  }
  if (o.support === "wall" && o.wallId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "wall-supported object requires wallId" });
  }
  if (o.support === "surface" && o.parentObjectId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "surface-supported object requires parentObjectId" });
  }
  if (o.support === "ceiling" && o.parentObjectId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ceiling-supported object cannot sit on another object" });
  }
});

export type PlacedObject = z.infer<typeof PlacedObjectSchema>;

export const SurfaceFinishSchema = z.object({
  color: HexColor.optional(),
  finish: z.enum(["matte", "eggshell", "satin"]).optional(),
  materialId: z.string().optional(),
});

export const SceneSchema = z.object({
  schemaVersion: z.literal(1),
  id: Id,
  /** the RoomPlan this scene sits inside */
  planId: Id,
  objects: z.array(PlacedObjectSchema),
  finishes: z.object({
    walls: z.record(SurfaceFinishSchema),
    floor: SurfaceFinishSchema,
    ceiling: SurfaceFinishSchema,
    baseboard: z.object({ color: HexColor, height: z.number().positive() }),
  }),
  lighting: z.object({
    hdri: z.string(),
    keyIntensity: z.number().nonnegative(),
  }),
  provenance: z.object({
    /** accuracy badge tier (docs/05 §9) */
    tier: z.enum(["sketch", "photo", "lidar"]),
    reconstructionJobId: Id.nullable(),
    generatedAt: z.string().datetime(),
  }),
});

export type Scene = z.infer<typeof SceneSchema>;

export const CatalogItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  name: z.string(),
  asset: z.object({
    glb: z.string(),
    /** ≤ 15k enforced by the catalog asset pipeline (docs/06 §8) */
    tris: z.number().int().positive().max(15000),
  }),
  nativeSize: z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }),
  scaleBounds: z.object({ min: z.number().positive(), max: z.number().positive(), nonUniform: z.boolean() }),
  materialSlots: z.array(z.string()),
  /** "face" for frames/TVs/mirrors/rugs */
  faceSlot: z.string().nullable(),
  support: SupportSchema,
  /** for pipeline matching (docs/05 §6) */
  embedding: z.string().nullable(),
  license: z.literal("CC0"),
  source: z.string().url(),
  attribution: z.string().optional(),
});

export type CatalogItem = z.infer<typeof CatalogItemSchema>;

/**
 * ObjectCategory — one recognizable *kind* of thing a room can contain.
 *
 * The taxonomy (data in `packages/catalog`) is the contract shared by three
 * consumers: the detection vocabulary (docs/05 §3), the parametric-placeholder
 * fallback (docs/05 §6 — "never omit a detected object silently"), and the
 * catalog browser's category tree (docs/06 §5). Every category must be
 * placeable and editable by hand even before any CC0 model exists for it.
 */
export const ObjectCategorySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  label: z.string().min(1),
  /** catalog browser grouping (docs/06 §5) */
  group: z.string().min(1),
  support: SupportSchema,
  /** typical real-world size, meters — drives the placeholder and "fits here" */
  defaultSize: z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }),
  /** default mounting height for wall/ceiling items: meters to object center */
  mountHeight: z.number().nonnegative().nullable(),
  materialSlots: z.array(z.string()).min(1),
  /** "face" for flat-front classes that take a rectified photo crop (docs/05 §7) */
  faceSlot: z.string().nullable(),
  /** rugs and wall items don't participate in collision (docs/06 §3) */
  collisionExempt: z.boolean(),
  /** open-vocabulary detection prompts (docs/05 §3) */
  detectionPrompts: z.array(z.string().min(1)).min(1),
});

export type ObjectCategory = z.infer<typeof ObjectCategorySchema>;
