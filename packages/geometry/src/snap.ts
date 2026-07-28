import { type Vec2, sub, add, scale, dist, len } from "./vec.js";

/**
 * Snapping resolution (docs/04 §4). Pure function: raw pointer position in plan
 * meters + context → snapped point. Radii are SCREEN-SPACE (constant finger
 * effort at every zoom), so pixel radii are converted via `pxPerMeter`.
 *
 * Priority (highest wins):
 *   1 closure  — within 0.25 m (screen-adjusted) of the chain origin
 *   2 vertex   — existing vertices, 12 px radius
 *   3 ortho    — 0°/45°/90° within 4°, unless disabled by modifier
 *   4 guide    — h/v alignment with any existing vertex, ±6 px
 *   5 grid     — 0.05 m increments, only past 1:50 zoom
 */

export const VERTEX_SNAP_PX = 12;
export const GUIDE_SNAP_PX = 6;
export const CLOSURE_SNAP_M = 0.25;
export const CLOSURE_SNAP_MIN_PX = 16;
export const ORTHO_TOLERANCE_RAD = (4 * Math.PI) / 180;
export const GRID_STEP_M = 0.05;
/** 1:50 on a ~96 dpi CSS-px screen ⇒ 1 m ≈ 75.6 px. Grid snap only when closer. */
export const GRID_MIN_PX_PER_M = 75;

export type SnapKind = "closure" | "vertex" | "ortho" | "guide" | "grid" | "none";

export interface SnapGuide {
  axis: "h" | "v";
  through: Vec2;
}

export interface SnapContext {
  /** Chain origin vertex — closure snap target (null when not drawing a chain). */
  origin?: Vec2 | null;
  /** All existing vertices (endpoint snap + alignment guides). */
  vertices?: readonly Vec2[];
  /** Previous point of the active chain — ortho snap pivot. */
  prev?: Vec2 | null;
  /** Current zoom: CSS pixels per plan meter. */
  pxPerMeter: number;
  /** Modifier held → ortho disabled (docs/04 §4.3). */
  orthoDisabled?: boolean;
}

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  guides: SnapGuide[];
}

export function resolveSnap(raw: Vec2, ctx: SnapContext): SnapResult {
  const px = (n: number) => n / ctx.pxPerMeter;
  const vertices = ctx.vertices ?? [];

  // 1 — closure
  if (ctx.origin) {
    const radius = Math.max(CLOSURE_SNAP_M, px(CLOSURE_SNAP_MIN_PX));
    if (dist(raw, ctx.origin) <= radius) {
      return { point: { ...ctx.origin }, kind: "closure", guides: [] };
    }
  }

  // 2 — vertex
  let bestVertex: Vec2 | null = null;
  let bestVertexD = px(VERTEX_SNAP_PX);
  for (const v of vertices) {
    if (ctx.origin && v.x === ctx.origin.x && v.y === ctx.origin.y) continue;
    const d = dist(raw, v);
    if (d <= bestVertexD) {
      bestVertex = v;
      bestVertexD = d;
    }
  }
  if (bestVertex) return { point: { ...bestVertex }, kind: "vertex", guides: [] };

  // 3 — ortho (projects the point onto the nearest 45° ray from prev)
  let point = { ...raw };
  let kind: SnapKind = "none";
  if (ctx.prev && !ctx.orthoDisabled) {
    const d = sub(raw, ctx.prev);
    const r = len(d);
    if (r > 1e-9) {
      const angle = Math.atan2(d.y, d.x);
      const step = Math.PI / 4;
      const snapped = Math.round(angle / step) * step;
      if (Math.abs(angle - snapped) <= ORTHO_TOLERANCE_RAD) {
        point = add(ctx.prev, scale({ x: Math.cos(snapped), y: Math.sin(snapped) }, r));
        // Exact axes deserve exact coordinates (kills float drift on H/V walls).
        const k = Math.round(snapped / step);
        if (((k % 4) + 4) % 4 === 0) point.y = ctx.prev.y;
        if (((k % 4) + 4) % 4 === 2) point.x = ctx.prev.x;
        kind = "ortho";
      }
    }
  }

  // 4 — alignment guides (may refine the ortho point along its free axis)
  const guides: SnapGuide[] = [];
  const guideTol = px(GUIDE_SNAP_PX);
  if (kind !== "ortho") {
    let gx: Vec2 | null = null;
    let gy: Vec2 | null = null;
    for (const v of vertices) {
      if (Math.abs(v.x - point.x) <= guideTol && (!gx || Math.abs(v.x - point.x) < Math.abs(gx.x - point.x))) gx = v;
      if (Math.abs(v.y - point.y) <= guideTol && (!gy || Math.abs(v.y - point.y) < Math.abs(gy.y - point.y))) gy = v;
    }
    if (gx) {
      point.x = gx.x;
      guides.push({ axis: "v", through: gx });
      kind = "guide";
    }
    if (gy) {
      point.y = gy.y;
      guides.push({ axis: "h", through: gy });
      kind = "guide";
    }
  }

  // 5 — grid
  if (kind === "none" && ctx.pxPerMeter >= GRID_MIN_PX_PER_M) {
    point = {
      x: Math.round(point.x / GRID_STEP_M) * GRID_STEP_M,
      y: Math.round(point.y / GRID_STEP_M) * GRID_STEP_M,
    };
    kind = "grid";
  }

  return { point, kind, guides };
}
