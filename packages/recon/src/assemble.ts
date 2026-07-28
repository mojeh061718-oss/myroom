import {
  AGAINST_WALL_M,
  distancesToWalls,
  findFreeSpot,
  footprintsOverlap,
  type ShellGeometry,
  type SnapWall,
} from "@myroom/geometry";
import { getCatalogItem, getCategory } from "@myroom/catalog";
import type { CatalogMatch, MeasuredObject, PlacedObject, Scene } from "@myroom/schema";

/**
 * Stage 6 — scene assembly (docs/05 §7).
 *
 * Fan-in stage: dedupe objects seen in several photos, resolve support and
 * collisions, snap near-wall objects parallel to their wall, and write the
 * `Scene` document. Every measured object reaches the scene — with a catalog
 * model, or as a parametric placeholder, but never dropped (docs/05 §6).
 */

export const DEFAULT_WALL_COLOR = "#EDE9E3";
export const DEFAULT_FLOOR_COLOR = "#B99A72";
export const DEFAULT_CEILING_COLOR = "#F4F2EC";

/** Two detections of the same class overlapping this much are one object. */
export const MERGE_IOU = 0.3;

export interface AssembleInput {
  sceneId: string;
  planId: string;
  shell: ShellGeometry;
  measured: readonly MeasuredObject[];
  matches: readonly CatalogMatch[];
  tier: "sketch" | "photo" | "lidar";
  jobId: string | null;
  now: string;
  newId: () => string;
}

export interface AssembleResult {
  scene: Scene;
  /** user-facing notes about what the assembler had to do (docs/05 §8) */
  warnings: string[];
}

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

const boxOf = (o: MeasuredObject): Box => ({
  x: o.position.x,
  y: o.position.y,
  z: o.position.z,
  ...o.size,
});

/**
 * Axis-aligned 3D IoU. Rotation is deliberately ignored: at the ±15 cm accuracy
 * this stage works to, an oriented-box intersection is false precision, and the
 * axis-aligned form never *under*-reports overlap, which is the safe direction
 * for a dedupe test.
 */
export function iou3d(a: Box, b: Box): number {
  const overlap = (ac: number, as: number, bc: number, bs: number) =>
    Math.max(0, Math.min(ac + as / 2, bc + bs / 2) - Math.max(ac - as / 2, bc - bs / 2));
  const ox = overlap(a.x, a.w, b.x, b.w);
  const oz = overlap(a.z, a.d, b.z, b.d);
  // y is a base elevation, not a centre, so the vertical span is [y, y + h].
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ox * oy * oz;
  if (inter === 0) return 0;
  const va = a.w * a.d * a.h;
  const vb = b.w * b.d * b.h;
  return inter / (va + vb - inter);
}

/** Merge duplicate sightings of one object across photos (docs/05 §7b). */
export function dedupeMeasured(measured: readonly MeasuredObject[]): MeasuredObject[] {
  const merged: MeasuredObject[] = [];
  // Highest confidence first, so the winner's geometry is the one we keep.
  for (const candidate of [...measured].sort((a, b) => b.confidence - a.confidence)) {
    const twin = merged.find(
      (m) => m.category === candidate.category && iou3d(boxOf(m), boxOf(candidate)) >= MERGE_IOU,
    );
    if (twin) {
      twin.sourcePhotoIds = [...new Set([...twin.sourcePhotoIds, ...candidate.sourcePhotoIds])];
      // Seeing the same thing twice is corroboration, not new information: take
      // the higher confidence but never above what one clean sighting can earn.
      twin.confidence = Math.max(twin.confidence, candidate.confidence);
      twin.lowConfidence = twin.lowConfidence && candidate.lowConfidence;
      if (twin.palette.length === 0) twin.palette = candidate.palette;
      continue;
    }
    merged.push({ ...candidate, sourcePhotoIds: [...candidate.sourcePhotoIds], palette: [...candidate.palette] });
  }
  return merged;
}

function snapWallsOf(shell: ShellGeometry): SnapWall[] {
  return shell.walls.map((w) => ({
    wallId: w.wallId,
    start: [w.start[0], w.start[2]],
    end: [w.end[0], w.end[2]],
    inwardNormal: [w.inwardNormal[0], w.inwardNormal[2]],
    thickness: w.thickness,
  }));
}

export function assembleScene(input: AssembleInput): AssembleResult {
  const { shell, now, newId } = input;
  const warnings: string[] = [];
  const matchById = new Map(input.matches.map((m) => [m.measuredId, m]));
  const walls = snapWallsOf(shell);

  const objects: PlacedObject[] = [];
  const placeholders: string[] = [];
  const placed: { position: { x: number; z: number }; size: { w: number; d: number }; rotationY: number; collisionExempt: boolean }[] = [];

  for (const m of dedupeMeasured(input.measured)) {
    const category = getCategory(m.category);
    const match = matchById.get(m.id);
    const model = match?.catalogId ? getCatalogItem(match.catalogId) : undefined;
    if (match && !match.catalogId) {
      // Explicit, not silent: the object is here, just as a stand-in. Collected
      // and reported once at the end — eight near-identical lines is noise, and
      // each object carries its own "wrong item?" prompt anyway.
      placeholders.push(category?.label ?? m.category);
    }

    let position = { ...m.position };
    let rotationY = m.rotationY;
    let wallId: string | null = null;
    const size = { ...m.size };
    const collisionExempt = category?.collisionExempt ?? false;

    if (m.support === "wall") {
      // Mount flush to the nearest wall face, facing into the room.
      const nearest = distancesToWalls({ x: position.x, z: position.z }, walls)[0];
      const wall = nearest ? shell.walls.find((w) => w.wallId === nearest.wallId) : undefined;
      if (wall && nearest) {
        wallId = wall.wallId;
        position = {
          x: nearest.point.x + wall.inwardNormal[0] * (wall.thickness / 2),
          y: Math.min(position.y, shell.height - size.h),
          z: nearest.point.z + wall.inwardNormal[2] * (wall.thickness / 2),
        };
        rotationY = Math.atan2(wall.inwardNormal[0], wall.inwardNormal[2]);
      } else {
        warnings.push(`Couldn't find a wall for the ${category?.label ?? m.category}; left it where it was measured.`);
      }
    } else if (m.support === "ceiling") {
      position.y = Math.max(0, shell.height - size.h);
    } else if (m.support === "floor") {
      position.y = 0;
      // Snap near-wall objects parallel and flush (docs/05 §7c).
      const nearest = distancesToWalls({ x: position.x, z: position.z }, walls)[0];
      const wall = nearest ? shell.walls.find((w) => w.wallId === nearest.wallId) : undefined;
      if (wall && nearest && nearest.distance - size.d / 2 - wall.thickness / 2 < AGAINST_WALL_M) {
        rotationY = Math.atan2(wall.inwardNormal[0], wall.inwardNormal[2]);
        const inset = wall.thickness / 2 + size.d / 2;
        position = {
          x: nearest.point.x + wall.inwardNormal[0] * inset,
          y: 0,
          z: nearest.point.z + wall.inwardNormal[2] * inset,
        };
      }

      // Soft collision: two pieces of furniture can't occupy one patch of floor.
      // The later (lower-confidence) one moves, the confident one stays put.
      const clashes =
        !collisionExempt &&
        placed.some(
          (other) =>
            !other.collisionExempt &&
            footprintsOverlap(
              { position: { x: position.x, z: position.z }, size, rotationY },
              other,
            ),
        );
      if (clashes) {
        const spot = findFreeSpot(walls, placed, size, [shell.center[0], shell.center[2]]);
        position = { x: spot.x, y: 0, z: spot.z };
        rotationY = spot.rotationY;
        warnings.push(`The ${category?.label ?? m.category} overlapped another object — moved it to clear floor space.`);
      }
    }

    if (m.support === "floor" || m.support === "ceiling" || m.support === "wall") {
      placed.push({ position: { x: position.x, z: position.z }, size, rotationY, collisionExempt });
    }

    const materials: PlacedObject["materials"] = {};
    const slots = model?.materialSlots ?? category?.materialSlots ?? [];
    const albedo = m.palette[0];
    if (albedo && slots[0]) {
      // "the couch is *their* couch color" (docs/05 §7): the dominant colour
      // lands on the model's primary albedo slot only — trims and hardware keep
      // their own materials.
      materials[slots[0]] = { color: albedo };
    }
    if (m.faceTextureRef && (model?.faceSlot ?? category?.faceSlot)) {
      materials[(model?.faceSlot ?? category?.faceSlot)!] = { textureRef: m.faceTextureRef };
    }

    objects.push({
      id: newId(),
      catalogId: model?.id ?? null,
      placeholder: model ? null : { category: m.category, shape: `${m.category}Massing` },
      label: model?.name ?? category?.label ?? m.category,
      support: m.support,
      wallId,
      parentObjectId: null,
      position,
      rotationY,
      size,
      materials,
      collisionExempt,
      recon: {
        confidence: m.confidence,
        sourcePhotoIds: m.sourcePhotoIds,
        runnerUpCatalogIds: match?.runnerUpCatalogIds ?? [],
        lowConfidence: m.lowConfidence,
      },
    });
  }

  if (placeholders.length === 1) {
    warnings.push(`We don't have a close model for the ${placeholders[0]} yet — it's a placeholder shape you can swap.`);
  } else if (placeholders.length > 1) {
    warnings.push(
      `${placeholders.length} pieces are placeholder shapes for now (${placeholders.slice(0, 3).join(", ")}` +
        `${placeholders.length > 3 ? ", …" : ""}) — tap any of them to choose a better match.`,
    );
  }

  // Small items measured above the floor sit on whatever is under them
  // (docs/05 §7b: "small items may sit on detected surfaces").
  resolveSurfaceSupport(objects);

  const scene: Scene = {
    schemaVersion: 1,
    id: input.sceneId,
    planId: input.planId,
    objects,
    finishes: {
      walls: Object.fromEntries(
        shell.walls.map((w) => [w.wallId, { color: DEFAULT_WALL_COLOR, finish: "matte" as const }]),
      ),
      floor: { color: DEFAULT_FLOOR_COLOR, finish: "matte" },
      ceiling: { color: DEFAULT_CEILING_COLOR },
      baseboard: { color: "#FFFFFF", height: 0.09 },
    },
    lighting: { hdri: "procedural-room-01", keyIntensity: 1 },
    provenance: { tier: input.tier, reconstructionJobId: input.jobId, generatedAt: now },
  };

  return { scene, warnings };
}

/**
 * Re-home floating floor-class objects onto the surface beneath them. A lamp
 * measured 0.75 m up is on the side table, not hovering — and the schema
 * requires a `parentObjectId` before it will accept that claim.
 */
function resolveSurfaceSupport(objects: PlacedObject[]): void {
  for (const o of objects) {
    if (o.support !== "surface") continue;
    const host = objects.find(
      (candidate) =>
        candidate !== o &&
        candidate.support === "floor" &&
        Math.abs(candidate.position.y + candidate.size.h - o.position.y) < 0.25 &&
        footprintsOverlap(
          { position: { x: o.position.x, z: o.position.z }, size: o.size, rotationY: o.rotationY },
          { position: { x: candidate.position.x, z: candidate.position.z }, size: candidate.size, rotationY: candidate.rotationY },
        ),
    );
    if (host) {
      o.parentObjectId = host.id;
      o.position = { ...o.position, y: host.position.y + host.size.h };
    } else {
      // No host found: it becomes a floor object rather than an invalid one.
      o.support = "floor";
      o.position = { ...o.position, y: 0 };
    }
  }
}
