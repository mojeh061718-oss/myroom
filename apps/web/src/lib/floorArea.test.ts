import "fake-indexeddb/auto";
import { formatArea } from "@myroom/geometry";
import { planToShell, usableFloorArea } from "@myroom/schema";
import { describe, expect, it } from "vitest";

import { emptyPlan } from "../stores/projectsStore.js";
import { uuidv7 } from "./uuid.js";
import type { RoomPlan } from "@myroom/schema";

/**
 * The same room must report the same size on every screen.
 *
 * `plan.floorArea` is the centreline polygon's area; the 3D shell reports the
 * inner offset ring's. The drawing board and home cards printed the first, the
 * sandbox and processing screen the second, neither labelled — so a room read
 * 212 ft² while being drawn and 200 ft² the moment it was built, which looks
 * like the reconstruction shrank it.
 */

const FT = 0.3048;

function closedPlan(width: number, depth: number, thickness = 0.115): RoomPlan {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ];
  const vertices = corners.map((c) => ({ id: uuidv7(), ...c }));
  const plan = emptyPlan();
  return {
    ...plan,
    vertices,
    walls: vertices.map((v, i) => ({
      id: uuidv7(),
      label: String.fromCharCode(65 + i),
      start: v.id,
      end: vertices[(i + 1) % vertices.length]!.id,
      thickness,
      height: 8 * FT,
      openings: [],
    })),
    closed: true,
    floorArea: width * depth,
  };
}

describe("one room, one floor area", () => {
  it("the board and the sandbox print the same string", () => {
    const plan = closedPlan(16 * FT, 13 * FT);
    const board = formatArea(usableFloorArea(plan)!, "ft");
    const sandbox = formatArea(planToShell(plan)!.floorArea, "ft");
    expect(board).toBe(sandbox);
  });

  it("reports the floor inside the walls, not to the wall centres", () => {
    const plan = closedPlan(5, 4, 0.2);
    const usable = usableFloorArea(plan)!;
    // Centreline area is 20 m²; inside 0.2 m walls it is 4.8 x 3.8 = 18.24.
    expect(plan.floorArea).toBeCloseTo(20, 6);
    expect(usable).toBeCloseTo(18.24, 2);
    expect(usable).toBeLessThan(plan.floorArea!);
  });

  it("agrees across every wall thickness the editor allows", () => {
    for (const thickness of [0.05, 0.115, 0.3, 0.5]) {
      const plan = closedPlan(5, 4, thickness);
      expect(usableFloorArea(plan), `thickness ${thickness}`).toBeCloseTo(
        planToShell(plan)!.floorArea,
        9,
      );
    }
  });

  it("declines for an unclosed plan rather than guessing", () => {
    const plan = { ...closedPlan(5, 4), closed: false };
    expect(usableFloorArea(plan)).toBeNull();
  });
});
