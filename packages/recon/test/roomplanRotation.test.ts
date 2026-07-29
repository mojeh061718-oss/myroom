import { describe, expect, it } from "vitest";

import { parseRoomPlanJson } from "../src/scan.js";

/**
 * RoomPlan object yaw must survive the import (docs/05 §2).
 *
 * The transform is a column-major 4×4. For a rotation of θ about Y, column 0
 * (the object's local +X in world space) is (cos θ, 0, −sin θ) and column 2
 * (local +Z) is (sin θ, 0, cos θ). Yaw is therefore atan2(m[8], m[10]).
 *
 * Reading it off column 0 instead gives atan2(cos θ, −sin θ) = θ + π/2, so
 * every scanned object arrives a quarter-turn out: a sofa along the north wall
 * imports facing east, and the near-wall snap in assemble.ts then treats its
 * width as its depth.
 */

/** Column-major 4×4 for a yaw of `theta` at position `p`. */
function yawMatrix(theta: number, p: { x: number; y: number; z: number }): number[] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    // column 0: local +X
    c, 0, -s, 0,
    // column 1: local +Y
    0, 1, 0, 0,
    // column 2: local +Z
    s, 0, c, 0,
    // column 3: translation
    p.x, p.y, p.z, 1,
  ];
}

function docWithObjectAt(theta: number) {
  return {
    walls: [
      { transform: yawMatrix(0, { x: 0, y: 1.2, z: -2 }), dimensions: [4, 2.4, 0.1] },
      { transform: yawMatrix(Math.PI / 2, { x: 2, y: 1.2, z: 0 }), dimensions: [4, 2.4, 0.1] },
      { transform: yawMatrix(0, { x: 0, y: 1.2, z: 2 }), dimensions: [4, 2.4, 0.1] },
      { transform: yawMatrix(Math.PI / 2, { x: -2, y: 1.2, z: 0 }), dimensions: [4, 2.4, 0.1] },
    ],
    objects: [
      {
        category: "sofa",
        transform: yawMatrix(theta, { x: 0.5, y: 0.4, z: -1.2 }),
        dimensions: [2.1, 0.8, 0.9],
      },
    ],
  };
}

/** Compare angles modulo a full turn. */
function angleClose(actual: number, expected: number, tolerance = 1e-6): boolean {
  const twoPi = Math.PI * 2;
  const delta = Math.abs(((actual - expected) % twoPi) + twoPi) % twoPi;
  return Math.min(delta, twoPi - delta) < tolerance;
}

describe("RoomPlan object rotation", () => {
  it("recovers a zero yaw as zero", () => {
    const parsed = parseRoomPlanJson(JSON.stringify(docWithObjectAt(0)));
    expect(parsed).not.toBeNull();
    expect(angleClose(parsed!.objects[0]!.rotationY, 0)).toBe(true);
  });

  it.each([
    ["quarter turn", Math.PI / 2],
    ["half turn", Math.PI],
    ["three-quarter turn", -Math.PI / 2],
    ["30 degrees", Math.PI / 6],
    ["-140 degrees", (-140 * Math.PI) / 180],
  ])("recovers %s exactly", (_label, theta) => {
    const parsed = parseRoomPlanJson(JSON.stringify(docWithObjectAt(theta)));
    expect(parsed).not.toBeNull();
    const got = parsed!.objects[0]!.rotationY;
    expect(
      angleClose(got, theta),
      `expected ${theta.toFixed(4)} rad, got ${got.toFixed(4)} rad (delta ${(got - theta).toFixed(4)})`,
    ).toBe(true);
  });

  it("keeps position and size intact while doing so", () => {
    const parsed = parseRoomPlanJson(JSON.stringify(docWithObjectAt(Math.PI / 3)));
    const object = parsed!.objects[0]!;
    expect(object.position.x).toBeCloseTo(0.5, 9);
    // RoomPlan reports the box centre; our objects sit on their base.
    expect(object.position.y).toBeCloseTo(0.4 - 0.8 / 2, 9);
    expect(object.position.z).toBeCloseTo(-1.2, 9);
    expect(object.size.w).toBeCloseTo(2.1, 9);
    expect(object.size.h).toBeCloseTo(0.8, 9);
    expect(object.size.d).toBeCloseTo(0.9, 9);
  });
});
