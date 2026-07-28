import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomPlanSchema, planLoop } from "@myroom/schema";
import { applyRefinements, describeRefinements, proposeRefinements, type ScanWallLine } from "../src/refine.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../schema/test/fixtures");
const plan = RoomPlanSchema.parse(JSON.parse(readFileSync(join(fixturesDir, "plan-rectangle.json"), "utf8")));

/** Scan wall lines derived from the plan, optionally scaled and rotated. */
function scanOf(source = plan, scale = 1, rotation = 0.4): ScanWallLine[] {
  const loop = planLoop(source)!;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const move = (p: { x: number; y: number }): [number, number] => [
    (p.x * c - p.y * s) * scale + 12,
    (p.x * s + p.y * c) * scale - 7,
  ];
  return loop.map((p, i) => ({ start: move(p), end: move(loop[(i + 1) % loop.length]!) }));
}

describe("plan refinement from a scan (docs/05 §2)", () => {
  it("compares lengths without needing the scan to be aligned", () => {
    // The scan is rotated and translated; lengths are invariant, so the
    // comparison holds without any registration.
    const proposal = proposeRefinements(plan, scanOf());
    expect(proposal.comparable).toBe(true);
    expect(proposal.disagreements.every((d) => Math.abs(d.delta) < 1e-6)).toBe(true);
    expect(proposal.uniformScale).toBeNull();
  });

  it("applies a consistent scale error and keeps the room closed", () => {
    const proposal = proposeRefinements(plan, scanOf(plan, 1.04));
    expect(proposal.uniformScale).toBeCloseTo(1.04, 4);

    const refined = applyRefinements(plan, proposal);
    expect(RoomPlanSchema.parse(refined)).toBeTruthy();
    expect(refined.source).toBe("drawn+lidarRefined");

    const before = planLoop(plan)!;
    const after = planLoop(refined)!;
    const beforeWidth = Math.max(...before.map((p) => p.x)) - Math.min(...before.map((p) => p.x));
    const afterWidth = Math.max(...after.map((p) => p.x)) - Math.min(...after.map((p) => p.x));
    expect(afterWidth / beforeWidth).toBeCloseTo(1.04, 4);

    // Openings scale with the wall they're in, so a door stays in its doorway.
    const doorBefore = plan.walls.flatMap((w) => w.openings)[0];
    const doorAfter = refined.walls.flatMap((w) => w.openings)[0];
    if (doorBefore && doorAfter) {
      expect(doorAfter.width / doorBefore.width).toBeCloseTo(1.04, 4);
    }
  });

  it("refuses to smear one mis-drawn wall across the whole room", () => {
    const walls = scanOf();
    // One wall is 70 cm longer in the scan; the others agree.
    walls[0] = {
      start: walls[0]!.start,
      end: [walls[0]!.end[0] + 0.7, walls[0]!.end[1]],
    };
    const proposal = proposeRefinements(plan, walls);
    expect(proposal.uniformScale).toBeNull();
    const flagged = proposal.disagreements.filter((d) => d.needsReview);
    expect(flagged.length).toBeGreaterThan(0);

    // Reported, not applied: the drawing survives untouched.
    const refined = applyRefinements(plan, proposal);
    expect(refined.vertices).toEqual(plan.vertices);
    expect(describeRefinements(proposal, refined, plan).join(" ")).toContain("left your drawing alone");
  });

  it("applies a ceiling height and never leaves an opening taller than its wall", () => {
    const tallDoor = {
      ...plan,
      walls: plan.walls.map((w) => ({
        ...w,
        openings: w.openings.map((o) => ({ ...o, headHeight: 2.4 })),
      })),
    };
    const proposal = proposeRefinements(tallDoor, scanOf(), 2.31);
    const refined = applyRefinements(tallDoor, proposal);
    expect(refined.walls.every((w) => w.height === 2.31)).toBe(true);
    expect(refined.walls.flatMap((w) => w.openings).every((o) => o.headHeight <= 2.31)).toBe(true);
    expect(RoomPlanSchema.safeParse(refined).success).toBe(true);
  });

  it("says why it can't compare, instead of comparing the wrong walls", () => {
    const partial = scanOf().slice(0, 3);
    const proposal = proposeRefinements(plan, partial);
    expect(proposal.comparable).toBe(false);
    expect(proposal.reason).toContain("scan found 3");
    expect(proposal.disagreements).toEqual([]);
  });
});
