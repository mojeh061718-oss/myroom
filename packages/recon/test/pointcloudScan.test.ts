import { describe, expect, it } from "vitest";
import { mulberry32, parsePointCloudScan } from "../src/pointcloudScan.js";

/**
 * A synthetic scan of a 4 × 3 m room, 2.5 m ceiling, one sofa-sized box —
 * points only, no faces, like a Polycam PLY export. World is Y-up; the plan
 * frame is (x, −z).
 */
function syntheticRoom(): Float32Array {
  const rand = mulberry32(7);
  const jitter = () => (rand() - 0.5) * 0.02;
  const points: number[] = [];
  const push = (x: number, y: number, z: number) => points.push(x + jitter(), y + jitter(), z + jitter());

  // Floor: 4 × 3 grid.
  for (let x = 0; x <= 4; x += 0.06) {
    for (let z = 0; z <= 3; z += 0.06) push(x, 0, z);
  }
  // Four walls up to 2.5 m.
  for (let t = 0; t <= 4; t += 0.05) {
    for (let y = 0.05; y <= 2.5; y += 0.07) {
      push(t, y, 0);
      push(t, y, 3);
    }
  }
  for (let t = 0; t <= 3; t += 0.05) {
    for (let y = 0.05; y <= 2.5; y += 0.07) {
      push(0, y, t);
      push(4, y, t);
    }
  }
  // A sofa-sized box (1.8 w × 0.8 d × 0.8 h) in the middle of the floor,
  // clear of every wall.
  const box = { x0: 1.2, x1: 3.0, z0: 1.2, z1: 2.0, h: 0.8 };
  for (let x = box.x0; x <= box.x1; x += 0.05) {
    for (let z = box.z0; z <= box.z1; z += 0.05) push(x, box.h, z); // top
  }
  for (let x = box.x0; x <= box.x1; x += 0.05) {
    for (let y = 0.1; y <= box.h; y += 0.05) {
      push(x, y, box.z0);
      push(x, y, box.z1);
    }
  }
  for (let z = box.z0; z <= box.z1; z += 0.05) {
    for (let y = 0.1; y <= box.h; y += 0.05) {
      push(box.x0, y, z);
      push(box.x1, y, z);
    }
  }
  return new Float32Array(points);
}

describe("parsePointCloudScan (docs/05 §2: point clouds are read on the device)", () => {
  const parsed = parsePointCloudScan(syntheticRoom(), "ply");

  it("parses and returns a closed wall outline near 4 × 3 m", () => {
    expect(parsed.parsed).toBe(true);
    expect(parsed.failure).toBeNull();
    expect(parsed.walls.length).toBeGreaterThanOrEqual(4);
    // The outline's bounding box should match the room to within the
    // occupancy cell size.
    const xs = parsed.walls.flatMap((w) => [w.start.x, w.end.x]);
    const ys = parsed.walls.flatMap((w) => [w.start.y, w.end.y]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3, 0);
  });

  it("measures the ceiling height from the walls' vertical span", () => {
    expect(parsed.ceilingHeight).not.toBeNull();
    expect(parsed.ceilingHeight!).toBeGreaterThan(2.2);
    expect(parsed.ceilingHeight!).toBeLessThan(2.7);
  });

  it("clusters the sofa into one seed box of about the right size", () => {
    expect(parsed.seedBoxes.length).toBeGreaterThanOrEqual(1);
    const box = [...parsed.seedBoxes].sort(
      (a, b) => b.size.w * b.size.d * b.size.h - a.size.w * a.size.d * a.size.h,
    )[0]!;
    const dims = [box.size.w, box.size.d].sort((a, b) => b - a);
    expect(dims[0]).toBeGreaterThan(1.4);
    expect(dims[0]).toBeLessThan(2.2);
    expect(dims[1]).toBeGreaterThan(0.5);
    expect(dims[1]).toBeLessThan(1.2);
    expect(box.size.h).toBeGreaterThan(0.5);
    expect(box.size.h).toBeLessThan(1.1);
    // No taxonomy passed, so the box is honest about not knowing what it is.
    expect(box.category).toBeNull();
  });

  it("produces a silhouette for the S5 preview", () => {
    expect(parsed.silhouette.length).toBeGreaterThan(50);
  });

  it("is deterministic", () => {
    const again = parsePointCloudScan(syntheticRoom(), "ply");
    expect(again.walls).toEqual(parsed.walls);
    expect(again.seedBoxes).toEqual(parsed.seedBoxes);
  });

  it("declines clouds that are too small or too flat, with a reason", () => {
    expect(parsePointCloudScan(new Float32Array(30), "ply").parsed).toBe(false);
    const flat: number[] = [];
    for (let x = 0; x < 3; x += 0.05) for (let z = 0; z < 3; z += 0.05) flat.push(x, 0, z);
    const result = parsePointCloudScan(new Float32Array(flat), "ply");
    expect(result.parsed).toBe(false);
    expect(result.failure).toBeTruthy();
  });
});
