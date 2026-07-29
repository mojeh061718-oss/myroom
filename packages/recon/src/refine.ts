import { planLoop, type RoomPlan } from "@myroom/schema";
import { REVIEW_THRESHOLD_M } from "@myroom/schema";

/**
 * Plan refinement from a scan (docs/05 §2).
 *
 * "Output: refined shell (corrected wall lengths/angles — **user's drawing
 * corrected, not replaced**; large disagreements > 0.4 m flag a review prompt
 * rather than silently overriding)".
 *
 * Two corrections are safe to apply without asking, because both preserve the
 * closed polygon the user drew:
 *
 * * **ceiling height** — a scalar, and the one measurement a phone scan is
 *   unambiguously better at than a person with a tape measure;
 * * **a uniform scale** — when every wall is off by the same factor, the room's
 *   shape was right and only the ruler was wrong.
 *
 * Anything else is *reported*, not applied: correcting one wall of a closed
 * polygon moves its neighbours, and there is no single right way to absorb that.
 * The user fixes it on the drawing board, where exact dimension entry already
 * exists (docs/04 §3).
 *
 * Wall pairing here is by length rank, which needs no registration: lengths are
 * invariant under the rigid transform between the scan's frame and the plan's.
 * The authoritative registration (2D ICP against the drawn outline) runs in the
 * worker, where the scan's own geometry is available.
 */

export interface WallDisagreement {
  wallId: string;
  label: string;
  drawnLength: number;
  scannedLength: number;
  /** scanned − drawn, metres */
  delta: number;
  needsReview: boolean;
}

export interface RefinementProposal {
  /** false when the scan and the plan can't be lined up wall-for-wall */
  comparable: boolean;
  reason: string | null;
  disagreements: WallDisagreement[];
  /** set when every wall is off by the same factor */
  uniformScale: number | null;
  ceilingHeight: number | null;
}

export interface ScanWallLine {
  start: [number, number];
  end: [number, number];
}

const lengthOf = (wall: ScanWallLine): number =>
  Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);

/** Ratios this close to each other count as one scale factor, not many errors. */
export const UNIFORM_SCALE_TOLERANCE = 0.02;

export function proposeRefinements(
  plan: RoomPlan,
  scanWalls: readonly ScanWallLine[],
  ceilingHeight: number | null = null,
): RefinementProposal {
  const loop = planLoop(plan);
  if (!loop || !plan.closed) {
    return { comparable: false, reason: "the plan isn't closed yet", disagreements: [], uniformScale: null, ceilingHeight };
  }
  if (scanWalls.length !== plan.walls.length) {
    return {
      comparable: false,
      reason: `your plan has ${plan.walls.length} walls and the scan found ${scanWalls.length}`,
      disagreements: [],
      uniformScale: null,
      ceilingHeight,
    };
  }

  const drawn = plan.walls.map((wall, i) => {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    return { wall, length: Math.hypot(b.x - a.x, b.y - a.y) };
  });

  // Pair by length rank: the longest scanned wall is the longest drawn wall.
  const drawnByLength = [...drawn].sort((a, b) => b.length - a.length);
  const scannedByLength = [...scanWalls].map(lengthOf).sort((a, b) => b - a);

  const disagreements: WallDisagreement[] = drawnByLength.map((entry, i) => {
    const scannedLength = scannedByLength[i]!;
    const delta = scannedLength - entry.length;
    return {
      wallId: entry.wall.id,
      label: entry.wall.label,
      drawnLength: entry.length,
      scannedLength,
      delta,
      needsReview: Math.abs(delta) > REVIEW_THRESHOLD_M,
    };
  });

  const ratios = disagreements.map((d) => d.scannedLength / d.drawnLength);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const spread = Math.max(...ratios.map((r) => Math.abs(r - mean)));
  // A uniform scale is only claimed when it explains *everything*; one wall
  // genuinely mis-drawn would otherwise be smeared across the whole room.
  const uniformScale = spread <= UNIFORM_SCALE_TOLERANCE && Math.abs(mean - 1) > 0.005 ? mean : null;

  return { comparable: true, reason: null, disagreements, uniformScale, ceilingHeight };
}

/**
 * Apply the corrections that preserve the drawn shape. Returns the plan
 * unchanged when there is nothing safe to apply.
 */
/**
 * Whether the scan's uniform scale may be applied without asking.
 *
 * docs/05 §2: the scan corrects the drawing, it does not replace it, and
 * "large disagreements > 0.4 m flag a review prompt rather than silently
 * overriding". A uniform scale big enough to move a wall past
 * `REVIEW_THRESHOLD_M` is exactly such a disagreement — it is consistent, but
 * consistency is not permission. Applying it anyway also made
 * `describeRefinements` contradict itself: it reported the scale as "applied"
 * and, for the same over-threshold wall, that "we left your drawing alone".
 */
export function scaleIsSafeToApply(proposal: RefinementProposal): boolean {
  if (!proposal.uniformScale || proposal.uniformScale <= 0) return false;
  return !proposal.disagreements.some((d) => d.needsReview);
}

export function applyRefinements(plan: RoomPlan, proposal: RefinementProposal): RoomPlan {
  let next = plan;

  if (scaleIsSafeToApply(proposal)) {
    const k = proposal.uniformScale;
    const loop = planLoop(plan);
    if (loop) {
      // Scale about the room's centroid so the plan doesn't wander off its own
      // origin, and scale opening offsets and widths with the wall they're in.
      const cx = loop.reduce((sum, p) => sum + p.x, 0) / loop.length;
      const cy = loop.reduce((sum, p) => sum + p.y, 0) / loop.length;
      next = {
        ...next,
        vertices: next.vertices.map((v) => ({ ...v, x: cx + (v.x - cx) * k, y: cy + (v.y - cy) * k })),
        walls: next.walls.map((w) => ({
          ...w,
          openings: w.openings.map((o) => ({ ...o, offset: o.offset * k, width: o.width * k })),
        })),
        floorArea: next.floorArea === null ? null : next.floorArea * k * k,
        source: "drawn+lidarRefined",
      };
    }
  }

  if (proposal.ceilingHeight && proposal.ceilingHeight >= 2 && proposal.ceilingHeight <= 6) {
    const height = Math.round(proposal.ceilingHeight * 1000) / 1000;
    next = {
      ...next,
      walls: next.walls.map((w) => ({
        ...w,
        height,
        // An opening can't be taller than the wall it's in (docs/07 §2).
        openings: w.openings.map((o) => ({ ...o, headHeight: Math.min(o.headHeight, height) })),
      })),
      source: "drawn+lidarRefined",
    };
  }

  return next;
}

/** One line per correction, for the toast and the version note. */
export function describeRefinements(proposal: RefinementProposal, applied: RoomPlan, before: RoomPlan): string[] {
  const out: string[] = [];
  if (proposal.uniformScale) {
    const percent = ((proposal.uniformScale - 1) * 100).toFixed(1);
    const direction = proposal.uniformScale > 1 ? "larger" : "smaller";
    out.push(
      scaleIsSafeToApply(proposal)
        ? `Your scan says the room is ${percent}% ${direction} — applied.`
        : `Your scan says the room is ${percent}% ${direction}. That's a big enough difference ` +
          `that we left your drawing as you made it — check the walls below and decide.`,
    );
  }
  const beforeHeight = before.walls[0]?.height;
  const afterHeight = applied.walls[0]?.height;
  if (beforeHeight !== undefined && afterHeight !== undefined && Math.abs(afterHeight - beforeHeight) > 0.005) {
    out.push(`Ceiling height corrected to ${afterHeight.toFixed(2)} m from the scan.`);
  }
  for (const d of proposal.disagreements.filter((d) => d.needsReview)) {
    out.push(
      `Wall ${d.label}: your plan says ${d.drawnLength.toFixed(2)} m, the scan says ${d.scannedLength.toFixed(2)} m. ` +
        `We left your drawing alone — check it on the plan if you like.`,
    );
  }
  return out;
}
