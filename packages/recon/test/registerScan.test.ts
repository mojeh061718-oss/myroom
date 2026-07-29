import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomPlanSchema, planLoop, planToShell, type MeasuredObject } from "@myroom/schema";
import { applyRegistration, registerScanToPlan } from "../src/registerScan.js";
import { assembleScene } from "../src/assemble.js";
import type { ScanWallLine } from "../src/refine.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../schema/test/fixtures");
const plan = RoomPlanSchema.parse(JSON.parse(readFileSync(join(fixturesDir, "plan-rectangle.json"), "utf8")));
const loop = planLoop(plan)!;

/** The plan's own outline as scan walls, rotated by `theta` then shifted. */
function transformedWalls(theta: number, tx: number, ty: number): ScanWallLine[] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const move = (p: { x: number; y: number }): [number, number] => [p.x * c - p.y * s + tx, p.x * s + p.y * c + ty];
  return loop.map((p, i) => ({ start: move(p), end: move(loop[(i + 1) % loop.length]!) }));
}

describe("registerScanToPlan (docs/05 §2: 2D ICP of scan walls onto the drawn polygon)", () => {
  it("recovers a rotation + translation and maps scan points onto the plan", () => {
    // The scanner's session frame: 33° rotated, 5.2 m away.
    const theta = (33 * Math.PI) / 180;
    const registration = registerScanToPlan(transformedWalls(theta, 5.2, -3.1), loop);
    expect(registration).not.toBeNull();
    expect(registration!.residual).toBeLessThan(0.05);
    // A corner in scan space lands on the matching plan corner… or at least
    // ON the outline (a rectangle has symmetries; the residual is what's
    // guaranteed). Check the mapped centroid instead, which is symmetry-proof.
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const centroid = loop.reduce((acc, p) => ({ x: acc.x + p.x / loop.length, y: acc.y + p.y / loop.length }), { x: 0, y: 0 });
    const scanCentroid = { x: centroid.x * c - centroid.y * s + 5.2, y: centroid.x * s + centroid.y * c - 3.1 };
    const mapped = applyRegistration(registration!, scanCentroid);
    expect(mapped.x).toBeCloseTo(centroid.x, 1);
    expect(mapped.y).toBeCloseTo(centroid.y, 1);
  });

  it("handles a scan that is a quarter-turn out", () => {
    const registration = registerScanToPlan(transformedWalls(Math.PI / 2, -2, 4), loop);
    expect(registration).not.toBeNull();
    expect(registration!.residual).toBeLessThan(0.05);
  });

  it("survives a noisy, incomplete scan outline", () => {
    // Only 3 of 4 walls seen, each endpoint jittered ~3 cm.
    const walls = transformedWalls(0.4, 1, 1).slice(0, 3);
    let seed = 5;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return ((seed % 1000) / 1000 - 0.5) * 0.06;
    };
    const noisy = walls.map((w) => ({
      start: [w.start[0] + rand(), w.start[1] + rand()] as [number, number],
      end: [w.end[0] + rand(), w.end[1] + rand()] as [number, number],
    }));
    const registration = registerScanToPlan(noisy, loop);
    expect(registration).not.toBeNull();
    // A partial outline can settle slightly off; the guarantee is "usable",
    // not "perfect" — the closed-loop case above pins the tight bound, and
    // refineFromScan refuses registrations worse than 0.5 m.
    expect(registration!.residual).toBeLessThan(0.3);
  });

  it("returns null when there's nothing to register", () => {
    expect(registerScanToPlan([], loop)).toBeNull();
    expect(registerScanToPlan(transformedWalls(0, 0, 0), [])).toBeNull();
  });
});

describe("assembleScene pins scan-measured objects (docs/05 §7)", () => {
  const shell = planToShell(plan)!;
  let counter = 0;
  const newId = () => `pin-${++counter}`;

  const scanMeasured = (over: Partial<MeasuredObject> = {}): MeasuredObject => ({
    id: newId(),
    category: "sofa",
    position: { x: shell.center[0], y: 0, z: shell.center[2] },
    rotationY: 0.31,
    size: { w: 2.0, d: 0.9, h: 0.8 },
    support: "floor",
    confidence: 0.9,
    sourcePhotoIds: ["scan"],
    lowConfidence: false,
    palette: [],
    faceTextureRef: null,
    ...over,
  });

  it("keeps a scan-measured pose exactly — no wall snap, no collision shuffle", () => {
    // Two deliberately overlapping boxes near a wall: a real room's rug-under-
    // table reality. Neither may move or rotate.
    const near = shell.walls[0]!;
    const nearWall = {
      x: (near.start[0] + near.end[0]) / 2 + near.inwardNormal[0] * 0.55,
      y: 0,
      z: (near.start[2] + near.end[2]) / 2 + near.inwardNormal[2] * 0.55,
    };
    // Different categories so the multi-photo dedupe pass doesn't merge them.
    const a = scanMeasured({ position: nearWall, rotationY: 0.2 });
    const b = scanMeasured({
      category: "coffee-table",
      size: { w: 1.1, d: 0.6, h: 0.45 },
      position: { ...nearWall, x: nearWall.x + 0.3 },
      rotationY: 0.2,
    });
    const { scene, warnings } = assembleScene({
      sceneId: "scene-1",
      planId: plan.id,
      shell,
      measured: [a, b],
      matches: [],
      tier: "lidar",
      jobId: null,
      now: new Date().toISOString(),
      newId,
    });
    const placedA = scene.objects.find((o) => o.recon?.sourcePhotoIds.includes("scan") && o.position.x === a.position.x);
    expect(placedA).toBeDefined();
    expect(scene.objects).toHaveLength(2);
    for (const [source, placed] of [
      [a, scene.objects[0]!],
      [b, scene.objects[1]!],
    ] as const) {
      expect(placed.position.x).toBeCloseTo(source.position.x, 9);
      expect(placed.position.z).toBeCloseTo(source.position.z, 9);
      expect(placed.rotationY).toBeCloseTo(source.rotationY, 9);
    }
    expect(warnings.some((w) => w.includes("moved it"))).toBe(false);
  });

  it("still snaps and un-collides photo-measured objects", () => {
    const near = shell.walls[0]!;
    const photo = scanMeasured({
      sourcePhotoIds: ["photo-1"],
      position: {
        x: (near.start[0] + near.end[0]) / 2 + near.inwardNormal[0] * 0.5,
        y: 0,
        z: (near.start[2] + near.end[2]) / 2 + near.inwardNormal[2] * 0.5,
      },
      rotationY: 0.4,
    });
    const { scene } = assembleScene({
      sceneId: "scene-2",
      planId: plan.id,
      shell,
      measured: [photo],
      matches: [],
      tier: "photo",
      jobId: null,
      now: new Date().toISOString(),
      newId,
    });
    // Near-wall photo objects still get squared up to the wall.
    const wallAngle = Math.atan2(near.inwardNormal[0], near.inwardNormal[2]);
    expect(scene.objects[0]!.rotationY).toBeCloseTo(wallAngle, 6);
  });
});
