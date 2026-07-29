import { getCategory, modelsForCategory } from "@myroom/catalog";
import type { CatalogItem, CatalogMatch, MeasuredObject } from "@myroom/schema";

/**
 * Stage 4 — catalog match (docs/05 §6).
 *
 * Candidate set by class, ranked by **dimension fit** (penalize > 15% deviation
 * after allowed non-uniform scale) and, when the appearance worker supplied one,
 * **shape similarity** from the CLIP embedding of the photo crop. The winner is
 * instantiated at the measured size; its two runners-up ride along in the scene
 * document so the "wrong item?" swap sheet is instant.
 *
 * Below `MATCH_THRESHOLD` there is no winner and the caller must fall back to a
 * parametric placeholder — *never* to omitting the object (docs/05 §6).
 *
 * This stage runs in TypeScript rather than in a Python worker because the
 * catalog manifest is a TypeScript package; see DECISIONS.md → "Where the
 * pipeline's non-pixel stages run".
 */

export const MATCH_THRESHOLD = 0.55;
/** deviation past which dimension fit is actively penalized (docs/05 §6) */
export const DIMENSION_TOLERANCE = 0.15;

export interface MatchInput {
  measured: Pick<MeasuredObject, "id" | "category" | "size"> & {
    /** unit-length CLIP embedding of the photo crop, when stage 5 produced one */
    embedding?: readonly number[];
  };
  /** overrides the shipped catalog; used by the regression suite */
  candidates?: readonly CatalogItem[];
  threshold?: number;
}

/**
 * How well `item` can be scaled to `size` without leaving its allowed scale
 * bounds. 1 = exact fit at native size, 0 = cannot be scaled to fit at all.
 */
export function dimensionFit(item: CatalogItem, size: { w: number; d: number; h: number }): number {
  const axes: [number, number][] = [
    [size.w, item.nativeSize.w],
    [size.d, item.nativeSize.d],
    [size.h, item.nativeSize.h],
  ];
  const ratios = axes.map(([want, native]) => want / native);
  const { min, max, nonUniform } = item.scaleBounds;

  // A uniform-only model must satisfy every axis with one scale factor, so the
  // ratio it would need is the geometric mean — anything else distorts it.
  const applied = nonUniform
    ? ratios
    : ratios.map(() => Math.cbrt(ratios[0]! * ratios[1]! * ratios[2]!));

  let penalty = 0;
  for (let i = 0; i < applied.length; i++) {
    const clamped = Math.min(max, Math.max(min, applied[i]!));
    // Residual is what the scale bounds could not deliver …
    const residual = Math.abs(Math.log(ratios[i]! / clamped));
    // … plus the deviation from native size beyond the free tolerance.
    const stretch = Math.abs(Math.log(clamped));
    penalty += residual * 2 + Math.max(0, stretch - Math.log(1 + DIMENSION_TOLERANCE));
  }
  return Math.exp(-penalty);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, dot / Math.sqrt(na * nb));
}

function parseEmbedding(item: CatalogItem): number[] | null {
  if (!item.embedding) return null;
  try {
    const parsed = JSON.parse(item.embedding);
    return Array.isArray(parsed) && parsed.every((n) => typeof n === "number") ? parsed : null;
  } catch {
    return null;
  }
}

export function matchCatalog(input: MatchInput): CatalogMatch {
  const { measured } = input;
  const threshold = input.threshold ?? MATCH_THRESHOLD;
  const candidates = input.candidates ?? modelsForCategory(measured.category);

  const scored = candidates
    .map((item) => {
      const fit = dimensionFit(item, measured.size);
      const itemEmbedding = parseEmbedding(item);
      // Shape similarity only participates when both sides have an embedding;
      // with no embeddings the ranking is dimension fit alone, which is honest
      // rather than pretending to a similarity we never computed.
      const similarity =
        measured.embedding && itemEmbedding ? cosine(measured.embedding, itemEmbedding) : null;
      const score = similarity === null ? fit : 0.5 * fit + 0.5 * similarity;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const winner = scored[0];
  if (!winner || winner.score < threshold) {
    return {
      measuredId: measured.id,
      catalogId: null,
      score: winner?.score ?? 0,
      // Runners-up are still offered: "no confident match" is not "no options".
      runnerUpCatalogIds: scored.slice(0, 2).map((s) => s.item.id),
    };
  }
  return {
    measuredId: measured.id,
    catalogId: winner.item.id,
    score: winner.score,
    runnerUpCatalogIds: scored.slice(1, 3).map((s) => s.item.id),
  };
}

/** The label shown on the object card: the matched model, else the category. */
export function labelFor(match: CatalogMatch, category: string, catalogName?: string): string {
  if (match.catalogId && catalogName) return catalogName;
  return getCategory(category)?.label ?? category;
}
