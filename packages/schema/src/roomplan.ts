import { z } from "zod";
import { isSimplePolygon, polygonArea, dist, labelWalls, buildShell } from "@myroom/geometry";
import type { ShellGeometry } from "@myroom/geometry";
import type { Vec2 } from "@myroom/geometry";

/** docs/07 §2 — RoomPlan, the output of the drawing board. Meters, radians, UUIDv7 ids. */

export const Id = z.string().min(1);

export const VertexSchema = z.object({
  id: Id,
  x: z.number().finite(),
  y: z.number().finite(),
});

export const OpeningSchema = z.object({
  id: Id,
  kind: z.enum(["door", "window"]),
  /** meters from wall start to opening start */
  offset: z.number().nonnegative(),
  width: z.number().positive(),
  /** 0 for doors */
  sillHeight: z.number().nonnegative(),
  headHeight: z.number().positive(),
  swing: z.enum(["left", "right"]).nullable(),
});

export const WallSchema = z.object({
  id: Id,
  /** A, B, C… clockwise from northernmost (docs/04 §5) */
  label: z.string().regex(/^[A-Z]+$/),
  start: Id,
  end: Id,
  thickness: z.number().min(0.05).max(0.5),
  height: z.number().min(2.0).max(6.0),
  openings: z.array(OpeningSchema),
});

const RoomPlanBase = z.object({
  schemaVersion: z.literal(1),
  id: Id,
  units: z.literal("m"),
  vertices: z.array(VertexSchema),
  walls: z.array(WallSchema),
  closed: z.boolean(),
  /** derived, cached */
  floorArea: z.number().nonnegative().nullable(),
  /**
   * Where the plan's geometry came from.
   *
   * "scan" is a plan the scan BUILT — the scan-first path, where a LiDAR mesh
   * traces its own floor outline and the person tidies it. That is different
   * from "drawn+lidarRefined", which is a hand-drawn plan a scan later
   * corrected, and the accuracy story is different too.
   */
  source: z.enum(["drawn", "drawn+lidarRefined", "scan"]),
  curvedWalls: z.null(),
  roomGroups: z.null(),
});

export type RoomPlan = z.infer<typeof RoomPlanBase>;
export type Wall = z.infer<typeof WallSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type Vertex = z.infer<typeof VertexSchema>;

/**
 * Reconstruct the ordered vertex loop from walls when the plan is closed.
 * Returns null when the walls do not form exactly one closed chain.
 */
export function planLoop(plan: Pick<RoomPlan, "vertices" | "walls">): Vec2[] | null {
  const byId = new Map(plan.vertices.map((v) => [v.id, v]));
  if (plan.walls.length < 3) return null;
  const next = new Map<string, string>();
  for (const w of plan.walls) {
    if (next.has(w.start)) return null; // branching
    next.set(w.start, w.end);
  }
  const startId = plan.walls[0]!.start;
  const loop: Vec2[] = [];
  let cur = startId;
  for (let i = 0; i < plan.walls.length; i++) {
    const v = byId.get(cur);
    if (!v) return null;
    loop.push({ x: v.x, y: v.y });
    const n = next.get(cur);
    if (n === undefined) return null;
    cur = n;
  }
  if (cur !== startId) return null; // not a single closed cycle
  return loop;
}

/**
 * Recompute wall labels (A, B, C… clockwise from northernmost, docs/04 §5) and
 * the cached floor area from the geometry. Labels drive the guided photo shot
 * list and every downstream mini-plan, so they are derived — never trusted from
 * whatever a client sent. Open plans are returned unchanged.
 */
export function labelWallsForPlan(plan: RoomPlan): RoomPlan {
  if (!plan.closed) return plan;
  const loop = planLoop(plan);
  if (!loop || !isSimplePolygon(loop)) return plan;
  const labels = labelWalls(loop);
  return {
    ...plan,
    floorArea: Math.round(polygonArea(loop) * 10000) / 10000,
    walls: plan.walls.map((w, i) => ({ ...w, label: labels[i] ?? w.label })),
  };
}

/**
 * RoomPlan → 3D shell (docs/06 §1). Returns null for an open or invalid plan:
 * the sandbox only ever renders a watertight room.
 */
/**
 * The floor area to show a user: the area inside the walls.
 *
 * `plan.floorArea` is the CENTRELINE polygon's area, and the schema enforces
 * that (a cached value disagreeing by more than 0.05 m² is a validation
 * error). The 3D shell reports the INNER offset ring's area instead. Both are
 * defensible and they are not the same number — on a 7-vertex plan at the
 * shipped 0.115 m wall thickness they differ by 12 ft².
 *
 * The app was printing the first on the drawing board and the home cards, and
 * the second in the sandbox and on the processing screen, unlabelled. So a
 * room measured 212 ft² while being drawn and 200 ft² the moment it was built
 * — which reads as reconstruction having silently shrunk it.
 *
 * One definition wins for display, and it is this one: the floor you could
 * actually carpet. Deriving it from `planToShell` rather than recomputing the
 * offset means the number cannot drift from the one the sandbox renders.
 */
export function usableFloorArea(plan: RoomPlan): number | null {
  return planToShell(plan)?.floorArea ?? null;
}

export function planToShell(plan: RoomPlan): ShellGeometry | null {
  if (!plan.closed) return null;
  const loop = planLoop(plan);
  if (!loop || !isSimplePolygon(loop)) return null;
  return buildShell(
    loop,
    plan.walls.map((w) => ({
      id: w.id,
      label: w.label,
      thickness: w.thickness,
      height: w.height,
      openings: w.openings.map((o) => ({
        id: o.id,
        kind: o.kind,
        offset: o.offset,
        width: o.width,
        sillHeight: o.sillHeight,
        headHeight: o.headHeight,
      })),
    })),
  );
}

export function wallLength(plan: Pick<RoomPlan, "vertices">, wall: Pick<Wall, "start" | "end">): number {
  const byId = new Map(plan.vertices.map((v) => [v.id, v]));
  const a = byId.get(wall.start);
  const b = byId.get(wall.end);
  if (!a || !b) return 0;
  return dist(a, b);
}

/** Full invariant set from docs/07 §2, applied on top of the field-level schema. */
export const RoomPlanSchema = RoomPlanBase.superRefine((plan, ctx) => {
  const vertexIds = new Set(plan.vertices.map((v) => v.id));
  if (vertexIds.size !== plan.vertices.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate vertex ids" });
  }
  for (const w of plan.walls) {
    if (!vertexIds.has(w.start) || !vertexIds.has(w.end)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `wall ${w.label}: unknown vertex reference` });
      return;
    }
    const length = wallLength(plan, w);
    const sorted = [...w.openings].sort((a, b) => a.offset - b.offset);
    let prevEnd = -Infinity;
    for (const o of sorted) {
      if (o.offset + o.width > length + 1e-9) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `wall ${w.label}: opening exceeds wall length (offset + width ≤ ${length.toFixed(3)})`,
        });
      }
      if (o.offset < prevEnd - 1e-9) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `wall ${w.label}: openings overlap` });
      }
      if (o.headHeight <= o.sillHeight) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `wall ${w.label}: opening headHeight must exceed sillHeight` });
      }
      if (o.headHeight > w.height + 1e-9) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `wall ${w.label}: opening taller than wall` });
      }
      prevEnd = o.offset + o.width;
    }
  }
  if (plan.closed) {
    const loop = planLoop(plan);
    if (!loop) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "closed plan must be exactly one closed wall chain" });
    } else if (!isSimplePolygon(loop)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "closed plan must be a simple (non-self-intersecting) polygon" });
    } else if (plan.floorArea != null && Math.abs(polygonArea(loop) - plan.floorArea) > 0.05) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cached floorArea disagrees with polygon area" });
    }
    const labels = new Set(plan.walls.map((w) => w.label));
    if (labels.size !== plan.walls.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "wall labels must be unique" });
    }
  }
});
