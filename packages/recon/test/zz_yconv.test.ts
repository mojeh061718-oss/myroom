import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomPlanSchema, planToShell } from "@myroom/schema";
import { assembleScene } from "../src/assemble.js";
import { fuseSeedBoxes } from "../src/fuse.js";
import type { ScanSeedObject } from "../src/scan.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../schema/test/fixtures");
const plan = RoomPlanSchema.parse(JSON.parse(readFileSync(join(fixturesDir, "plan-rectangle.json"), "utf8")));
const shell = planToShell(plan)!;
let n = 0;
const newId = () => `id-${++n}`;

function run(y: number) {
  const seed: ScanSeedObject = {
    category: "tv",
    position: { x: 0, y, z: -1.4 },
    rotationY: 0,
    size: { w: 1.23, d: 0.07, h: 0.71 },
  };
  const fused = fuseSeedBoxes([], [seed], { newId });
  const { scene } = assembleScene({
    sceneId: newId(), planId: plan.id, shell, measured: fused.measured, matches: [],
    tier: "lidar", jobId: null, now: new Date().toISOString(), newId,
  });
  return scene.objects[0]!;
}

describe("y convention", () => {
  it("shows the divergence", () => {
    console.log("shell.height", shell.height);
    const worker = run(1.2);      // python worker: RoomPlan centre, unconverted
    const client = run(1.2 - 0.71 / 2); // scan.ts: converted to base
    console.log("worker support", worker.support, "y", worker.position.y, "centre", worker.position.y + worker.size.h / 2);
    console.log("client support", client.support, "y", client.position.y, "centre", client.position.y + client.size.h / 2);
    expect(worker.position.y - client.position.y).toBeCloseTo(0.355, 6);
  });
});
