/**
 * Auto quality stepping (docs/06 §8).
 *
 * "monitor rolling FPS; below threshold step down pixel ratio → shadow map size
 * → AO off → environment resolution, in that order (and back up when headroom
 * returns)."
 *
 * The policy is pure so it can be tested without a GPU; the renderer wiring
 * that applies it lives in `QualityGovernor`.
 */

export interface QualityLevel {
  name: string;
  /** cap on devicePixelRatio */
  pixelRatio: number;
  shadowMapSize: number;
  /** contact shadows / ambient occlusion */
  ao: boolean;
  environmentResolution: number;
}

/** Ordered best → worst; stepping down means moving one index later. */
export const QUALITY_LEVELS: QualityLevel[] = [
  { name: "Best quality", pixelRatio: 2, shadowMapSize: 2048, ao: true, environmentResolution: 256 },
  { name: "High", pixelRatio: 1.5, shadowMapSize: 1024, ao: true, environmentResolution: 256 },
  { name: "Balanced", pixelRatio: 1.25, shadowMapSize: 512, ao: true, environmentResolution: 128 },
  { name: "Battery saver", pixelRatio: 1, shadowMapSize: 512, ao: false, environmentResolution: 128 },
  { name: "Minimum", pixelRatio: 1, shadowMapSize: 256, ao: false, environmentResolution: 64 },
];

/** docs/06 §8: 60 fps target, 30 fps floor. */
export const TARGET_FPS = 60;
export const FLOOR_FPS = 30;
/** Step up only with real headroom, so the governor can't oscillate. */
export const HEADROOM_FPS = 55;

export interface GovernorState {
  level: number;
  /** consecutive samples spent below the floor / above the headroom */
  below: number;
  above: number;
}

export const initialGovernorState = (level = 0): GovernorState => ({ level, below: 0, above: 0 });

/** How many consecutive one-second samples justify a change. */
export const SAMPLES_TO_STEP_DOWN = 2;
export const SAMPLES_TO_STEP_UP = 6;

/**
 * Fold one FPS sample into the governor. Stepping down is quick (two bad
 * seconds is already a bad experience); stepping back up is slow, because a
 * level that just failed is likely to fail again and flapping is worse than
 * either level.
 */
export function stepQuality(state: GovernorState, fps: number): GovernorState {
  if (fps < FLOOR_FPS) {
    const below = state.below + 1;
    if (below >= SAMPLES_TO_STEP_DOWN && state.level < QUALITY_LEVELS.length - 1) {
      return { level: state.level + 1, below: 0, above: 0 };
    }
    return { ...state, below, above: 0 };
  }
  if (fps > HEADROOM_FPS) {
    const above = state.above + 1;
    if (above >= SAMPLES_TO_STEP_UP && state.level > 0) {
      return { level: state.level - 1, below: 0, above: 0 };
    }
    return { ...state, above, below: 0 };
  }
  // Between the floor and the headroom is exactly where we want to be.
  return { ...state, below: 0, above: 0 };
}

export type QualityPreference = "auto" | "best" | "saver";

export function levelFor(preference: QualityPreference, auto: number): QualityLevel {
  if (preference === "best") return QUALITY_LEVELS[0]!;
  if (preference === "saver") return QUALITY_LEVELS[3]!;
  return QUALITY_LEVELS[Math.min(auto, QUALITY_LEVELS.length - 1)]!;
}
