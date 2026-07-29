import { describe, expect, it } from "vitest";
import { buildShell, pointInPolygon, type ShellWallInput, type Vec2 } from "@myroom/geometry";
import { poseFor } from "./CameraRig.js";

const rect = (w = 5.2, d = 3.6): Vec2[] => [
  { x: -w / 2, y: d / 2 },
  { x: w / 2, y: d / 2 },
  { x: w / 2, y: -d / 2 },
  { x: -w / 2, y: -d / 2 },
];

const lShape: Vec2[] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 3 },
  { x: 3, y: 3 },
  { x: 3, y: 5 },
  { x: 0, y: 5 },
];

const walls = (n: number, openings: ShellWallInput["openings"] = []): ShellWallInput[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    label: String.fromCharCode(65 + i),
    thickness: 0.115,
    height: 2.44,
    openings: i === 0 ? openings : [],
  }));

/** World (x, z) back to plan (x, y). */
const toPlan = (x: number, z: number): Vec2 => ({ x, y: -z });

describe("camera presets (docs/06 §2)", () => {
  const cases: { name: string; loop: Vec2[] }[] = [
    { name: "rect", loop: rect() },
    { name: "rect drawn clockwise", loop: [...rect()].reverse() },
    { name: "L-shape", loop: lShape },
  ];

  for (const { name, loop } of cases) {
    it(`Inside stands within the room and looks across it — ${name}`, () => {
      const shell = buildShell(loop, walls(loop.length));
      const pose = poseFor("inside", shell, 0.48, 0);

      // The camera must be inside the room, not out in the void behind a wall.
      expect(pointInPolygon(toPlan(pose.position.x, pose.position.z), loop), "camera inside").toBe(true);
      expect(pointInPolygon(toPlan(pose.target.x, pose.target.z), loop), "target inside").toBe(true);

      // Eye height, and far enough from the target to frame the room rather
      // than a corner or the inside of a doorway.
      expect(pose.position.y).toBeGreaterThan(1.2);
      expect(pose.position.y).toBeLessThan(shell.height);
      expect(pose.position.distanceTo(pose.target)).toBeGreaterThan(0.9);
    });

    it(`Dollhouse frames the whole room from outside and above — ${name}`, () => {
      const shell = buildShell(loop, walls(loop.length));
      const pose = poseFor("dollhouse", shell, 0.48, 0.9);
      expect(pose.position.y).toBeGreaterThan(shell.height);
      const span = Math.max(
        shell.bounds.max[0] - shell.bounds.min[0],
        shell.bounds.max[2] - shell.bounds.min[2],
      );
      expect(pose.position.distanceTo(pose.target)).toBeGreaterThan(span);
    });
  }

  it("Inside keeps clear of a doorway on the wall it stands against", () => {
    // A door centred on the longest wall is exactly where a naive preset parks
    // the camera, which frames the empty void through the opening.
    const loop = rect();
    const shell = buildShell(
      loop,
      walls(4, [{ id: "d", kind: "door", offset: 2.19, width: 0.82, sillHeight: 0, headHeight: 2.03 }]),
    );
    const pose = poseFor("inside", shell, 0.48, 0);
    expect(pointInPolygon(toPlan(pose.position.x, pose.position.z), loop)).toBe(true);
    // Looking direction must have a real horizontal run across the room.
    const dx = pose.target.x - pose.position.x;
    const dz = pose.target.z - pose.position.z;
    expect(Math.hypot(dx, dz)).toBeGreaterThan(0.8);
  });
});
