import { describe, expect, it } from "vitest";
import {
  AGAINST_WALL_M,
  angleDelta,
  distancesToWalls,
  footprintsOverlap,
  rotatedFootprint,
  snapObject,
  snapToWallRun,
  findFreeSpot,
  type SnapWall,
} from "../src/objectSnap.js";

/** A 6 × 4 m room centred on the origin, walls running clockwise in XZ. */
const room: SnapWall[] = [
  { wallId: "N", start: [-3, -2], end: [3, -2], inwardNormal: [0, 1], thickness: 0.115 },
  { wallId: "E", start: [3, -2], end: [3, 2], inwardNormal: [-1, 0], thickness: 0.115 },
  { wallId: "S", start: [3, 2], end: [-3, 2], inwardNormal: [0, -1], thickness: 0.115 },
  { wallId: "W", start: [-3, 2], end: [-3, -2], inwardNormal: [1, 0], thickness: 0.115 },
];
const centre: [number, number] = [0, 0];
const sofa = { w: 2.1, d: 0.92 };

describe("angleDelta", () => {
  it("wraps to the shortest signed difference", () => {
    expect(angleDelta(0.1, 6.2)).toBeCloseTo(0.1 + Math.PI * 2 - 6.2, 6);
    expect(angleDelta(Math.PI, -Math.PI)).toBeCloseTo(0, 6);
  });
});

describe("snapObject (docs/06 §3)", () => {
  it("locks rotation parallel to the nearest wall within 8°", () => {
    const nearlyParallel = 5 * (Math.PI / 180);
    const r = snapObject({
      position: { x: 0, z: -1.0 },
      rotationY: nearlyParallel,
      size: sofa,
      walls: room,
      roomCenter: centre,
    });
    expect(r.parallelToWall).toBe("N");
    expect(Math.abs(angleDelta(r.rotationY, 0)) % (Math.PI / 2)).toBeLessThan(1e-6);
  });

  it("leaves a deliberately angled object alone", () => {
    const angled = 30 * (Math.PI / 180);
    const r = snapObject({
      position: { x: 0, z: -1.0 },
      rotationY: angled,
      size: sofa,
      walls: room,
      roomCenter: centre,
    });
    expect(r.parallelToWall).toBeNull();
    expect(r.rotationY).toBeCloseTo(angled, 9);
  });

  it("pulls an object flush against the wall from within 12 cm", () => {
    // Wall face at z = −2 + 0.0575; a 0.92-deep sofa sits flush at z ≈ −1.48.
    const flushZ = -2 + 0.0575 + sofa.d / 2;
    const r = snapObject({
      position: { x: 0.5, z: flushZ + 0.08 },
      rotationY: 0,
      size: sofa,
      walls: room,
      roomCenter: centre,
    });
    expect(r.againstWall).toBe("N");
    expect(r.position.z).toBeCloseTo(flushZ, 6);
    expect(r.position.x).toBeCloseTo(0.5, 6); // slides only along the normal
  });

  it("does not yank an object across the room from outside the threshold", () => {
    const flushZ = -2 + 0.0575 + sofa.d / 2;
    const r = snapObject({
      position: { x: 0.5, z: flushZ + AGAINST_WALL_M + 0.05 },
      rotationY: 0,
      size: sofa,
      walls: room,
      roomCenter: centre,
    });
    expect(r.againstWall).toBeNull();
  });

  it("falls back to the room centre guides", () => {
    const r = snapObject({
      position: { x: 0.04, z: 0.9 },
      rotationY: 0.6,
      size: sofa,
      walls: room,
      roomCenter: centre,
    });
    expect(r.centeredOn).toBe("x");
    expect(r.position.x).toBe(0);
  });

  it("skips flush-snapping for collision-exempt items like rugs", () => {
    const r = snapObject({
      position: { x: 0, z: -1.9 },
      rotationY: 0,
      size: { w: 2.4, d: 1.7 },
      walls: room,
      roomCenter: centre,
      exempt: true,
    });
    expect(r.againstWall).toBeNull();
  });
});

describe("snapToWallRun (docs/06 §3 wall items)", () => {
  it("puts a wall item on the nearest wall, facing into the room", () => {
    const r = snapToWallRun({ x: 1, z: -1.8 }, room, 0.6)!;
    expect(r.wallId).toBe("N");
    expect(r.position.z).toBeCloseTo(-2 + 0.0575, 6);
    // Facing +z, into the room.
    expect(Math.sin(r.rotationY)).toBeCloseTo(0, 6);
    expect(Math.cos(r.rotationY)).toBeCloseTo(1, 6);
  });

  it("hops to the adjacent wall when dragged past a corner", () => {
    const onNorth = snapToWallRun({ x: 2.5, z: -1.9 }, room, 0.6)!;
    const pastCorner = snapToWallRun({ x: 2.9, z: -1.2 }, room, 0.6)!;
    expect(onNorth.wallId).toBe("N");
    expect(pastCorner.wallId).toBe("E");
  });

  it("never lets an object hang off the end of its wall", () => {
    // Dragged toward the corner: the item stays wholly on the north wall.
    const r = snapToWallRun({ x: 2.9, z: -1.95 }, room, 1.2)!;
    expect(r.wallId).toBe("N");
    expect(r.position.x).toBeCloseTo(2.4, 6); // half a width in from the end
  });
});

describe("footprints", () => {
  it("rotating 90° swaps width and depth", () => {
    const f = rotatedFootprint({ w: 2, d: 1 }, Math.PI / 2);
    expect(f.hw).toBeCloseTo(0.5, 6);
    expect(f.hd).toBeCloseTo(1, 6);
  });

  it("detects overlap softly", () => {
    const a = { position: { x: 0, z: 0 }, size: { w: 2, d: 1 }, rotationY: 0 };
    const b = { position: { x: 1.5, z: 0 }, size: { w: 2, d: 1 }, rotationY: 0 };
    const c = { position: { x: 2.5, z: 0 }, size: { w: 2, d: 1 }, rotationY: 0 };
    expect(footprintsOverlap(a, b)).toBe(true);
    expect(footprintsOverlap(a, c)).toBe(false);
  });
});

describe("distancesToWalls", () => {
  it("returns the two nearest walls for the live drag measurements", () => {
    const d = distancesToWalls({ x: 2, z: 1 }, room);
    expect(d[0]!.wallId).toBe("E");
    expect(d[0]!.distance).toBeCloseTo(1, 6);
    expect(d[1]!.wallId).toBe("S");
    expect(d[1]!.distance).toBeCloseTo(1, 6);
  });
});

describe("findFreeSpot (docs/06 §5)", () => {
  it("places the first object flush against a wall, not floating mid-room", () => {
    const spot = findFreeSpot(room, [], sofa, centre);
    const againstAWall = room.some((w) => {
      const toObj = [spot.x - w.start[0], spot.z - w.start[1]];
      const along = toObj[0]! * w.inwardNormal[0] + toObj[1]! * w.inwardNormal[1];
      return Math.abs(along - (w.thickness / 2 + sofa.d / 2)) < 1e-6;
    });
    expect(againstAWall).toBe(true);
  });

  it("does not stack a second object on the first", () => {
    const first = findFreeSpot(room, [], sofa, centre);
    const placed = [{ position: { x: first.x, z: first.z }, size: sofa, rotationY: first.rotationY }];
    const second = findFreeSpot(room, placed, sofa, centre);
    expect(footprintsOverlap(
      { position: { x: second.x, z: second.z }, size: sofa, rotationY: second.rotationY },
      { position: placed[0]!.position, size: sofa, rotationY: placed[0]!.rotationY },
    )).toBe(false);
  });

  it("furnishes several pieces without any two overlapping", () => {
    const placed: { position: { x: number; z: number }; size: { w: number; d: number }; rotationY: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const s = findFreeSpot(room, placed, { w: 1.2, d: 0.6 }, centre);
      placed.push({ position: { x: s.x, z: s.z }, size: { w: 1.2, d: 0.6 }, rotationY: s.rotationY });
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(footprintsOverlap(placed[i]!, placed[j]!), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it("ignores collision-exempt items like rugs when finding space", () => {
    const rug = { position: { x: 0, z: 0 }, size: { w: 2.4, d: 1.7 }, rotationY: 0, collisionExempt: true };
    const spot = findFreeSpot(room, [rug], sofa, centre);
    expect(Number.isFinite(spot.x)).toBe(true);
  });
});

describe("a wall-mounted object sits against the wall, not inside it", () => {
  /**
   * `snapToWallRun` returns the object's CENTRE, so clearing the wall needs
   * half the wall's thickness *and* half the object's depth. Only the former
   * was applied, so a wall cabinet's centre landed on the plaster and half of
   * it was buried. At the shipped 0.115 m wall thickness a 0.35 m cabinet's
   * back face ended up 11.8 cm outside the building, and a 0.5 m range hood
   * 19 cm — visible from the dollhouse view.
   */
  it.each([
    [0.05, "picture frame"],
    [0.35, "wall cabinet"],
    [0.5, "range hood"],
  ])("clears the wall face by half its depth (%s m, %s)", (depth) => {
    const thickness = 0.115;
    const walls = [
      {
        wallId: "n",
        start: [0, -2] as [number, number],
        end: [4, -2] as [number, number],
        inwardNormal: [0, 1] as [number, number],
        thickness,
      },
    ];
    const snapped = snapToWallRun({ x: 2, z: -1.9 }, walls, 0.6, depth)!;
    expect(snapped).not.toBeNull();
    // Centre stands off the centreline by half the wall plus half the object.
    expect(snapped.position.z - -2).toBeCloseTo(thickness / 2 + depth / 2, 9);
    // And therefore the back face touches the inner face exactly.
    const backFace = snapped.position.z - depth / 2;
    expect(backFace).toBeCloseTo(-2 + thickness / 2, 9);
  });

  it("leaves a zero-depth object on the wall face, as before", () => {
    const walls = [
      {
        wallId: "n",
        start: [0, -2] as [number, number],
        end: [4, -2] as [number, number],
        inwardNormal: [0, 1] as [number, number],
        thickness: 0.1,
      },
    ];
    expect(snapToWallRun({ x: 2, z: -1.9 }, walls, 0.6)!.position.z).toBeCloseTo(-1.95, 9);
  });
});
