import { describe, expect, it } from "vitest";

import { buildShell, type ShellWallInput } from "../src/shell.js";

/**
 * The floor the shell reports must be the floor it actually drew.
 *
 * `triangulate` is documented as taking a *simple* polygon, and every guard in
 * the codebase checks `isSimplePolygon` on the plan's **centreline** loop.
 * Nothing checks the ring that comes back out of `offsetPolygon` — and on a
 * room with a narrow alcove, a thick wall's two corner recessions eat the notch
 * and invert it.
 *
 * Ear clipping then finds no ear, breaks out of its loop, and returns a
 * truncated index list. `buildShell` never checks it got `n - 2` triangles, so
 * the floor mesh is built from whatever survived, while `floorArea` is still
 * the shoelace of the whole (self-intersecting) ring. The sandbox renders half
 * a floor and prints a full-size area over it, with no error anywhere.
 *
 * An earlier pass of mine dismissed this by triangulating the centreline loop,
 * which is simple and tiles correctly. That check never routed through the
 * offset, so it proved nothing about the case that actually breaks.
 */

/** 5 × 4 m room with a 0.35 m square alcove; every edge clears MIN_WALL_LENGTH. */
const ALCOVE_LOOP = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 4 },
  { x: 2.35, y: 4 },
  { x: 2.35, y: 4.35 },
  { x: 2, y: 4.35 },
  { x: 2, y: 4 },
  { x: 0, y: 4 },
];

const RECTANGLE = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 4 },
  { x: 0, y: 4 },
];

function wallsAt(loop: readonly { x: number; y: number }[], thickness: number): ShellWallInput[] {
  return loop.map((_, i) => ({
    id: `w${i}`,
    label: String.fromCharCode(65 + i),
    thickness,
    height: 2.4384,
    openings: [],
  }));
}

/** Sum the triangle areas of a horizontal mesh — the floor as actually drawn. */
function meshArea(mesh: { positions: number[]; indices: number[] }): number {
  let total = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [ia, ib, ic] = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const ax = mesh.positions[ia * 3]!;
    const az = mesh.positions[ia * 3 + 2]!;
    const bx = mesh.positions[ib * 3]!;
    const bz = mesh.positions[ib * 3 + 2]!;
    const cx = mesh.positions[ic * 3]!;
    const cz = mesh.positions[ic * 3 + 2]!;
    total += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return total;
}

describe("a reported floor area matches the floor that was drawn", () => {
  it("holds for a plain rectangle at every legal thickness", () => {
    for (const thickness of [0.05, 0.115, 0.3, 0.5]) {
      const shell = buildShell(RECTANGLE, wallsAt(RECTANGLE, thickness));
      expect(meshArea(shell.floor), `rectangle at ${thickness} m`).toBeCloseTo(shell.floorArea, 3);
    }
  });

  it("holds for an alcove room at a thickness narrower than the alcove", () => {
    const shell = buildShell(ALCOVE_LOOP, wallsAt(ALCOVE_LOOP, 0.115));
    expect(meshArea(shell.floor)).toBeCloseTo(shell.floorArea, 3);
  });

  it.each([0.3, 0.4, 0.5])(
    "holds for an alcove room at %s m, where the offset ring degenerates",
    (thickness) => {
      const shell = buildShell(ALCOVE_LOOP, wallsAt(ALCOVE_LOOP, thickness));
      // Refusing to build is a legitimate answer; quietly drawing half a floor
      // under a full-size number is not.
      if (shell.floorArea === 0 && shell.floor.indices.length === 0) return;
      expect(
        meshArea(shell.floor),
        `reports ${shell.floorArea.toFixed(2)} m² but drew ${meshArea(shell.floor).toFixed(2)} m²`,
      ).toBeCloseTo(shell.floorArea, 3);
    },
  );

  it("draws a ceiling that matches its floor", () => {
    for (const thickness of [0.115, 0.4]) {
      const shell = buildShell(ALCOVE_LOOP, wallsAt(ALCOVE_LOOP, thickness));
      if (shell.floor.indices.length === 0) continue;
      expect(meshArea(shell.ceiling), `thickness ${thickness}`).toBeCloseTo(meshArea(shell.floor), 3);
    }
  });
});
