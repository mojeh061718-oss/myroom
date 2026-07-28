import type { PlacedObject, Scene } from "@myroom/schema";

/**
 * Golden-room scoring (docs/05 §9).
 *
 * "≥ 5 fixture rooms (real measured rooms: photos + LiDAR + hand-labeled ground
 * truth scenes). Every pipeline change runs the suite; regressions in
 * position/size error, detection recall, or match quality block merge."
 *
 * This module is the *scoring*, which is testable on its own. The fixtures are
 * measurements of real rooms and cannot be synthesized — see
 * `fixtures/golden-rooms/README.md`.
 */

export interface GroundTruthObject {
  category: string;
  /** metres, same frame as the Scene: base elevation in y */
  position: { x: number; y: number; z: number };
  size: { w: number; d: number; h: number };
  /** false for small clutter that recall is not measured against */
  major?: boolean;
}

export interface GoldenTruth {
  room: string;
  tier: "photo" | "lidar";
  objects: GroundTruthObject[];
}

/** docs/05 §9 accuracy tiers. */
export const TIER_TARGETS = {
  photo: { positionM: 0.15, sizeFraction: 0.1, recall: 0.85 },
  lidar: { positionM: 0.05, sizeFraction: 0.05, recall: 0.85 },
} as const;

/**
 * "Major furniture" for the recall target: anything at least 60 cm in its
 * longest dimension. Recall over a vase is not what the target is about, and
 * counting one would let a pipeline that finds only cushions look good.
 */
export const MAJOR_MIN_EXTENT = 0.6;

/** How far a candidate may be and still be considered the same object. */
export const ASSOCIATION_RADIUS_M = 1.0;

export interface MatchedPair {
  truth: GroundTruthObject;
  actual: PlacedObject;
  positionError: number;
  /** mean relative size error across the three axes */
  sizeError: number;
}

export interface GoldenScore {
  room: string;
  tier: "photo" | "lidar";
  matched: MatchedPair[];
  missed: GroundTruthObject[];
  extra: PlacedObject[];
  recall: number;
  medianPositionError: number;
  p90PositionError: number;
  medianSizeError: number;
  /** fraction of matched objects placed with a real catalog model */
  matchQuality: number;
  passes: boolean;
  failures: string[];
}

const isMajor = (o: { size: { w: number; d: number; h: number }; major?: boolean }): boolean =>
  o.major ?? Math.max(o.size.w, o.size.d, o.size.h) >= MAJOR_MIN_EXTENT;

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function relativeSizeError(
  truth: { w: number; d: number; h: number },
  actual: { w: number; d: number; h: number },
): number {
  const axes: [number, number][] = [
    [truth.w, actual.w],
    [truth.d, actual.d],
    [truth.h, actual.h],
  ];
  return axes.reduce((sum, [t, a]) => sum + Math.abs(a - t) / t, 0) / axes.length;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Score one room. Association is greedy nearest-first over same-category pairs,
 * which is stable and order-independent: every candidate pair is ranked by
 * distance before any of them is committed.
 */
export function scoreRoom(truth: GoldenTruth, scene: Scene): GoldenScore {
  const targets = TIER_TARGETS[truth.tier];
  const pairs: { t: number; a: number; distance: number }[] = [];

  truth.objects.forEach((t, ti) => {
    scene.objects.forEach((a, ai) => {
      const category = a.placeholder?.category ?? categoryOfCatalogId(a.catalogId);
      if (category !== t.category) return;
      const d = distance(t.position, a.position);
      if (d <= ASSOCIATION_RADIUS_M) pairs.push({ t: ti, a: ai, distance: d });
    });
  });
  pairs.sort((x, y) => x.distance - y.distance);

  const usedTruth = new Set<number>();
  const usedActual = new Set<number>();
  const matched: MatchedPair[] = [];
  for (const pair of pairs) {
    if (usedTruth.has(pair.t) || usedActual.has(pair.a)) continue;
    usedTruth.add(pair.t);
    usedActual.add(pair.a);
    const t = truth.objects[pair.t]!;
    const a = scene.objects[pair.a]!;
    matched.push({
      truth: t,
      actual: a,
      positionError: pair.distance,
      sizeError: relativeSizeError(t.size, a.size),
    });
  }

  const missed = truth.objects.filter((_, i) => !usedTruth.has(i));
  const extra = scene.objects.filter((_, i) => !usedActual.has(i));

  const majorTruth = truth.objects.filter(isMajor);
  const majorFound = matched.filter((m) => isMajor(m.truth));
  const recall = majorTruth.length === 0 ? 1 : majorFound.length / majorTruth.length;

  const positionErrors = matched.map((m) => m.positionError);
  const sizeErrors = matched.map((m) => m.sizeError);
  const medianPositionError = quantile(positionErrors, 0.5);
  const p90PositionError = quantile(positionErrors, 0.9);
  const medianSizeError = quantile(sizeErrors, 0.5);
  const matchQuality =
    matched.length === 0 ? 0 : matched.filter((m) => m.actual.catalogId !== null).length / matched.length;

  const failures: string[] = [];
  // The target is a per-object accuracy claim, so hold the 90th percentile to
  // it, not the median — a median inside 15 cm with a quarter of the room a
  // metre out is not "positions ± 15 cm".
  if (p90PositionError > targets.positionM) {
    failures.push(
      `position: p90 ${(p90PositionError * 100).toFixed(1)} cm exceeds the ${(targets.positionM * 100).toFixed(0)} cm target`,
    );
  }
  if (quantile(sizeErrors, 0.9) > targets.sizeFraction) {
    failures.push(
      `size: p90 ${(quantile(sizeErrors, 0.9) * 100).toFixed(1)}% exceeds the ${(targets.sizeFraction * 100).toFixed(0)}% target`,
    );
  }
  if (recall < targets.recall) {
    failures.push(
      `recall: ${(recall * 100).toFixed(0)}% of major furniture found, target ${(targets.recall * 100).toFixed(0)}%`,
    );
  }

  return {
    room: truth.room,
    tier: truth.tier,
    matched,
    missed,
    extra,
    recall,
    medianPositionError,
    p90PositionError,
    medianSizeError,
    matchQuality,
    passes: failures.length === 0,
    failures,
  };
}

/** Catalog ids are `category/model`, so the category is recoverable from one. */
export function categoryOfCatalogId(catalogId: string | null): string | null {
  if (!catalogId) return null;
  const slash = catalogId.indexOf("/");
  return slash === -1 ? catalogId : catalogId.slice(0, slash);
}

/**
 * Compare a run against the last recorded one. A pipeline change that makes any
 * room worse blocks merge, even if every room still passes its absolute target
 * (docs/09 cross-milestone rule 2: budgets are tests).
 */
export interface Baseline {
  [room: string]: { p90PositionError: number; medianSizeError: number; recall: number };
}

export function regressions(scores: GoldenScore[], baseline: Baseline, tolerance = 0.02): string[] {
  const out: string[] = [];
  for (const score of scores) {
    const previous = baseline[score.room];
    if (!previous) continue;
    if (score.p90PositionError > previous.p90PositionError + tolerance) {
      out.push(
        `${score.room}: position p90 regressed from ${(previous.p90PositionError * 100).toFixed(1)} cm to ${(score.p90PositionError * 100).toFixed(1)} cm`,
      );
    }
    if (score.medianSizeError > previous.medianSizeError + tolerance) {
      out.push(
        `${score.room}: size error regressed from ${(previous.medianSizeError * 100).toFixed(1)}% to ${(score.medianSizeError * 100).toFixed(1)}%`,
      );
    }
    if (score.recall < previous.recall - tolerance) {
      out.push(
        `${score.room}: recall regressed from ${(previous.recall * 100).toFixed(0)}% to ${(score.recall * 100).toFixed(0)}%`,
      );
    }
  }
  return out;
}
