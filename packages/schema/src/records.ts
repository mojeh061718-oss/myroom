import { z } from "zod";
import { Id } from "./roomplan.js";

/** docs/07 §6–§7 — API-level records (PostgreSQL) and upload validation. */

export const AccuracyTierSchema = z.enum(["sketch", "photo", "lidar"]);

export const ProjectSchema = z.object({
  id: Id,
  ownerId: Id,
  name: z.string().min(1).max(120),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  planId: Id.nullable(),
  currentSceneId: Id.nullable(),
  accuracyTier: AccuracyTierSchema,
  thumbnailRef: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const VersionSchema = z.object({
  id: Id,
  projectId: Id,
  name: z.string().min(1).max(120),
  sceneSnapshotRef: z.string(),
  thumbnailRef: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** true only for version zero, "Original room" (docs/01 §11) */
  locked: z.boolean(),
});
export type Version = z.infer<typeof VersionSchema>;

export const UploadKindSchema = z.enum(["photo", "lidar"]);

export const UploadSchema = z.object({
  id: Id,
  projectId: Id,
  kind: UploadKindSchema,
  filename: z.string().min(1),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  wallTag: z.string().optional(),
  exif: z.record(z.unknown()).optional(),
  status: z.enum(["pending", "stored", "rejected"]),
  storageRef: z.string().nullable(),
});
export type Upload = z.infer<typeof UploadSchema>;

/** docs/07 §7 — accepted upload formats and limits. */
export const UPLOAD_LIMITS = {
  photo: {
    extensions: [".jpg", ".jpeg", ".png", ".heic", ".webp"],
    maxBytes: 25 * 1024 * 1024,
    maxPerProject: 40,
  },
  lidar: {
    extensions: [".usdz", ".json", ".ply", ".glb", ".e57", ".las", ".laz"],
    maxBytes: 500 * 1024 * 1024,
    maxPerProject: 10,
  },
} as const;

/** API request bodies (docs/03 §3). */
export const CreateProjectBody = z.object({ name: z.string().min(1).max(120) });
export const RenameProjectBody = z.object({ name: z.string().min(1).max(120) });
