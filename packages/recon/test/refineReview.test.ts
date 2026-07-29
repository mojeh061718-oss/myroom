import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_THRESHOLD_M, RoomPlanSchema, planLoop, wallLength } from "@myroom/schema";

import { applyRefinements, describeRefinements, proposeRefinements, type ScanWallLine } from "../src/refine.js";

/**
 * docs/05 §2: a scan corrects the user's drawing, it does not replace it, and
 * "large disagreements > 0.4 m flag a review prompt rather than silently
 * overriding".
 *
 * A uniform scale large enough to push a wall past REVIEW_THRESHOLD_M was being
 * applied anyway — and then `describeRefinements` told the user both that the
 * scale had been "applied" and, for the same wall, that "we left your drawing
 * alone". One of those two sentences is false, and it is the reassuring one.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../schema/test/fixtures");
const plan = RoomPlanSchema.parse(JSON.parse(readFileSync(join(fixturesDir, "plan-rectangle.json"), "utf8")));

function scanOf(scale: number): ScanWallLine[] {
  const loop = planLoop(plan)!;
  const move = (p: { x: number; y: number }): [number, number] => [p.x * scale, p.y * scale];
  return loop.map((p, i) => ({ start: move(p), end: move(loop[(i + 1) % loop.length]!) }));
}

/** The longest wall, whose absolute delta grows fastest with the scale. */
function longestWallLength(source = plan): number {
  return Math.max(...source.walls.map((w) => wallLength(source, w)));
}

describe("a scan does not silently override a drawing it disagrees with", () => {
  // 6.2 m longest wall; a 12% scale moves it by ~0.74 m, well past 0.4 m.
  const bigScale = 1.12;

  it("the fixture actually produces an over-threshold disagreement", () => {
    const proposal = proposeRefinements(plan, scanOf(bigScale));
    expect(proposal.comparable).toBe(true);
    expect(proposal.uniformScale).toBeCloseTo(bigScale, 3);
    const flagged = proposal.disagreements.filter((d) => d.needsReview);
    expect(flagged.length).toBeGreaterThan(0);
    expect(Math.abs(flagged[0]!.delta)).toBeGreaterThan(REVIEW_THRESHOLD_M);
  });

  it("does not tell the user contradictory things about the same wall", () => {
    const proposal = proposeRefinements(plan, scanOf(bigScale));
    const refined = applyRefinements(plan, proposal);
    const notes = describeRefinements(proposal, refined, plan);

    const claimsApplied = notes.some((n) => n.includes("applied"));
    const claimsUntouched = notes.some((n) => n.includes("left your drawing alone"));

    // Both at once is incoherent: either the plan changed or it did not.
    expect(
      claimsApplied && claimsUntouched,
      `notes contradict each other:\n${notes.map((n) => `  - ${n}`).join("\n")}`,
    ).toBe(false);
  });

  it("if it says it left the drawing alone, the drawing is actually unchanged", () => {
    const proposal = proposeRefinements(plan, scanOf(bigScale));
    const refined = applyRefinements(plan, proposal);
    const notes = describeRefinements(proposal, refined, plan);

    if (notes.some((n) => n.includes("left your drawing alone"))) {
      expect(longestWallLength(refined)).toBeCloseTo(longestWallLength(plan), 6);
    }
  });

  it("still applies a small consistent correction, which is the point of the feature", () => {
    // 2% on a 6.2 m wall is 0.12 m — well inside the threshold, so it applies
    // without needing anyone's permission.
    const proposal = proposeRefinements(plan, scanOf(1.02));
    expect(proposal.disagreements.every((d) => !d.needsReview)).toBe(true);

    const refined = applyRefinements(plan, proposal);
    expect(longestWallLength(refined)).toBeCloseTo(longestWallLength(plan) * 1.02, 4);
    expect(refined.source).toBe("drawn+lidarRefined");
    expect(RoomPlanSchema.parse(refined)).toBeTruthy();
  });
});
