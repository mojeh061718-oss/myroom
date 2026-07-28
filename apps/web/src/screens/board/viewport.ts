import type { DisplayUnit, Vec2 } from "@myroom/geometry";

/**
 * Board viewport (docs/04 §2): pan/zoom over the plan. `ppm` = CSS px per meter.
 * Zoom range 1:200 → 1:10 ≈ 19–378 px/m at 96 dpi.
 */
export interface Viewport {
  cx: number;
  cy: number;
  ppm: number;
}

export const MIN_PPM = 19;
export const MAX_PPM = 378;

export const clampPpm = (ppm: number): number => Math.min(MAX_PPM, Math.max(MIN_PPM, ppm));

export function toScreen(p: Vec2, v: Viewport, w: number, h: number): Vec2 {
  return { x: (p.x - v.cx) * v.ppm + w / 2, y: h / 2 - (p.y - v.cy) * v.ppm };
}

export function toPlan(s: Vec2, v: Viewport, w: number, h: number): Vec2 {
  return { x: (s.x - w / 2) / v.ppm + v.cx, y: v.cy - (s.y - h / 2) / v.ppm };
}

/** SVG transform mapping plan coordinates (+Y north) into this viewport's screen space. */
export function planGroupTransform(v: Viewport, w: number, h: number): string {
  return `translate(${w / 2 - v.cx * v.ppm}, ${h / 2 + v.cy * v.ppm}) scale(${v.ppm}, ${-v.ppm})`;
}

const METERS_PER_FOOT = 0.3048;

/**
 * Nice round scale-bar length (m) targeting ~80 px on screen.
 *
 * The steps are round in the unit being *displayed*, not in metres. A bar
 * labelled `3'3¼"` is a metre in disguise and tells an imperial reader nothing;
 * in feet the rungs are 1, 2, 5, 10… feet, same as they are 0.1, 0.2, 0.5, 1…
 * metres in metric.
 */
export function scaleBarMeters(ppm: number, unit: DisplayUnit = "m"): number {
  const target = 80 / ppm;
  const steps =
    unit === "ft"
      ? [0.5, 1, 2, 5, 10, 20, 50].map((feet) => feet * METERS_PER_FOOT)
      : [0.1, 0.2, 0.5, 1, 2, 5, 10];
  return steps.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), steps[0]!);
}
