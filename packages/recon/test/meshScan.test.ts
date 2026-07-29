import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  findHorizontalPlanes,
  findPrincipalAngle,
  measureFootprint,
  parseMeshScan,
  triangleFacets,
} from "../src/mesh.js";

/**
 * Mesh scans (docs/05 §2). The app accepted `.glb` and `.ply`, sniffed them
 * correctly, and then dropped them — the only client parser was for RoomPlan
 * JSON, and every other format was deferred to a worker tier that is not
 * deployed. Someone who scanned their living room got a note about a server
 * they cannot reach.
 */

const FT = 0.3048;
const SQ_FT = 10.7639;

interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

function meshFromQuads(quads: [number, number, number][][]): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const quad of quads) {
    const base = positions.length / 3;
    for (const [x, y, z] of quad) positions.push(x, y, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Subdivide a quad, so a wall is many triangles as a real scan's would be. */
function grid(
  origin: [number, number, number],
  u: [number, number, number],
  v: [number, number, number],
  nu: number,
  nv: number,
): [number, number, number][][] {
  const quads: [number, number, number][][] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const p = (a: number, b: number): [number, number, number] => [
        origin[0] + (u[0] * a) / nu + (v[0] * b) / nv,
        origin[1] + (u[1] * a) / nu + (v[1] * b) / nv,
        origin[2] + (u[2] * a) / nu + (v[2] * b) / nv,
      ];
      quads.push([p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)]);
    }
  }
  return quads;
}

/** A closed rectangular room, optionally rotated about Y, with some clutter. */
function room({
  width = 16 * FT,
  depth = 13 * FT,
  height = 8 * FT,
  angle = 0,
  ceiling = true,
  clutter = true,
} = {}): Mesh {
  const quads: [number, number, number][][] = [];
  quads.push(...grid([0, 0, 0], [width, 0, 0], [0, 0, -depth], 20, 16));
  if (ceiling) quads.push(...grid([0, height, 0], [width, 0, 0], [0, 0, -depth], 20, 16));
  quads.push(...grid([0, 0, 0], [width, 0, 0], [0, height, 0], 20, 10));
  quads.push(...grid([0, 0, -depth], [width, 0, 0], [0, height, 0], 20, 10));
  quads.push(...grid([0, 0, 0], [0, 0, -depth], [0, height, 0], 16, 10));
  quads.push(...grid([width, 0, 0], [0, 0, -depth], [0, height, 0], 16, 10));

  if (clutter) {
    // A sofa-sized block, finely tessellated — this is what outvotes the walls
    // when facets are counted instead of weighted by area.
    for (const y of [0.42, 0.86]) {
      quads.push(...grid([1, y, -0.2], [2, 0, 0], [0, 0, -0.9], 30, 20));
    }
  }

  const mesh = meshFromQuads(quads);
  if (angle !== 0) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      const z = mesh.positions[i + 2]!;
      mesh.positions[i] = x * cos - z * sin;
      mesh.positions[i + 2] = x * sin + z * cos;
    }
  }
  return mesh;
}

describe("mesh scans are read on the device", () => {
  it("finds the floor and ceiling", () => {
    const { positions, indices } = room();
    const planes = findHorizontalPlanes(triangleFacets(positions, indices));
    expect(planes).not.toBeNull();
    expect(planes!.floorY).toBeCloseTo(0, 2);
    expect(planes!.ceilingY).toBeCloseTo(8 * FT, 2);
  });

  it("is not fooled into calling a sofa the floor", () => {
    const { positions, indices } = room({ clutter: true });
    const planes = findHorizontalPlanes(triangleFacets(positions, indices))!;
    expect(planes.floorY).toBeLessThan(0.2);
  });

  it("measures the ceiling height", () => {
    const { positions, indices } = room();
    const scan = parseMeshScan(positions, indices, "glb");
    expect(scan.parsed).toBe(true);
    expect(scan.ceilingHeight).toBeCloseTo(8 * FT, 2);
  });

  /**
   * The reference scan's walls run 30° off the scanner's axes. Fitting an
   * axis-aligned box to that reported 482 sq ft for a room of about 200.
   */
  it.each([0, 15, 29.9, 44])("measures a room rotated %s degrees", (degrees) => {
    const angle = (degrees * Math.PI) / 180;
    const { positions, indices } = room({ angle });
    const found = findPrincipalAngle(triangleFacets(positions, indices));
    expect(found).not.toBeNull();
    // Walls are perpendicular, so the answer is only meaningful modulo 90°.
    const delta = Math.abs((((found! - angle) * 180) / Math.PI) % 90);
    expect(Math.min(delta, 90 - delta)).toBeLessThan(3);
  });

  it("recovers true dimensions from a rotated room, where a box would not", () => {
    const angle = (30 * Math.PI) / 180;
    const { positions, indices } = room({ width: 16 * FT, depth: 13 * FT, angle });
    const facets = triangleFacets(positions, indices);
    const planes = findHorizontalPlanes(facets)!;
    const footprint = measureFootprint(facets, planes, findPrincipalAngle(facets)!);

    const sides = [footprint.width, footprint.depth].sort((a, b) => a - b);
    expect(sides[0]).toBeCloseTo(13 * FT, 1);
    expect(sides[1]).toBeCloseTo(16 * FT, 1);

    // What the old axis-aligned reading produced, for contrast.
    const naive = measureFootprint(facets, planes, 0);
    expect(naive.width * naive.depth).toBeGreaterThan(footprint.width * footprint.depth * 1.3);
  });

  it("measures floor area by occupancy, not by the rectangle around it", () => {
    const { positions, indices } = room({ width: 16 * FT, depth: 13 * FT });
    const facets = triangleFacets(positions, indices);
    const planes = findHorizontalPlanes(facets)!;
    const footprint = measureFootprint(facets, planes, findPrincipalAngle(facets)!);
    expect(footprint.occupiedArea * SQ_FT).toBeGreaterThan(16 * 13 * 0.8);
    expect(footprint.occupiedArea * SQ_FT).toBeLessThan(16 * 13 * 1.3);
  });

  it("emits four wall segments that close", () => {
    const { positions, indices } = room();
    const scan = parseMeshScan(positions, indices, "glb");
    expect(scan.walls).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(scan.walls[i]!.end.x).toBeCloseTo(scan.walls[(i + 1) % 4]!.start.x, 9);
      expect(scan.walls[i]!.end.y).toBeCloseTo(scan.walls[(i + 1) % 4]!.start.y, 9);
    }
  });

  it("produces a silhouette for the upload preview", () => {
    const { positions, indices } = room();
    expect(parseMeshScan(positions, indices, "glb").silhouette.length).toBeGreaterThan(20);
  });

  it("reports no ceiling rather than inventing one", () => {
    const { positions, indices } = room({ ceiling: false });
    const scan = parseMeshScan(positions, indices, "glb");
    if (scan.ceilingHeight !== null) expect(scan.ceilingHeight).toBeLessThan(8 * FT - 0.1);
  });

  it("says what is wrong rather than failing silently", () => {
    const tiny = parseMeshScan(new Float32Array([0, 0, 0, 1, 1, 1]), new Uint32Array([0, 1, 2]), "glb");
    expect(tiny.parsed).toBe(false);
    expect(tiny.failure).toBeTruthy();

    const flat = parseMeshScan(new Float32Array(3000), new Uint32Array(3000), "ply");
    expect(flat.parsed).toBe(false);
    expect(flat.failure).toBeTruthy();
  });

  it("never claims seed boxes it cannot name", () => {
    const { positions, indices } = room();
    // An unlabelled mesh cannot say *what* occupies a volume, and docs/05 §6
    // would place an anonymous parametric blank for each one.
    expect(parseMeshScan(positions, indices, "glb").seedBoxes).toEqual([]);
  });
});

/**
 * A Scaniverse export of a real open-plan play area and kitchen: 140,885
 * vertices, 175,542 triangles. Skipped when the fixture is absent so CI stays
 * hermetic.
 */
const POSITIONS = "/tmp/sv_positions.bin";
const INDICES = "/tmp/sv_indices.bin";
const HAVE_SCAN = existsSync(POSITIONS) && existsSync(INDICES);
describe.skipIf(!HAVE_SCAN)("a real Scaniverse scan", () => {
  // skipIf still collects the suite body, so the fixture reads must not run
  // when the files are absent.
  const positions = HAVE_SCAN ? new Float32Array(readFileSync(POSITIONS).buffer) : new Float32Array();
  const indices = HAVE_SCAN ? new Uint32Array(readFileSync(INDICES).buffer) : new Uint32Array();

  it("parses", () => {
    expect(parseMeshScan(positions, indices, "glb").parsed).toBe(true);
  });

  it("recovers a plausible ceiling height", () => {
    const height = parseMeshScan(positions, indices, "glb").ceilingHeight;
    expect(height).not.toBeNull();
    expect(height!).toBeGreaterThan(2.0);
    expect(height!).toBeLessThan(3.2);
  });

  it("finds that the room is rotated about 30 degrees off the scan axes", () => {
    const angle = findPrincipalAngle(triangleFacets(positions, indices));
    expect(angle).not.toBeNull();
    expect((angle! * 180) / Math.PI).toBeGreaterThan(25);
    expect((angle! * 180) / Math.PI).toBeLessThan(35);
  });

  it("measures the footprint the walls enclose", () => {
    const facets = triangleFacets(positions, indices);
    const planes = findHorizontalPlanes(facets)!;
    const footprint = measureFootprint(facets, planes, findPrincipalAngle(facets)!);
    // Occupancy counts everything below the ceiling — furniture proves the
    // volume it stands in — so this is the area the walls enclose (~285 sq ft
    // for this space), not just the floor a camera can see between the
    // furniture. The owner's 208 sq ft hand drawing under-measured the same
    // open-plan run; the scan's wall bands, not the drawing, are the truth
    // this fixture pins.
    const sqFt = footprint.occupiedArea * SQ_FT;
    expect(sqFt).toBeGreaterThan(240);
    expect(sqFt).toBeLessThan(330);
  });
});

/**
 * The parser must use the outline tracer it ships with. Emitting the fitted
 * rectangle unconditionally made `traceFloorOutline` dead code and reintroduced
 * the exact failure it exists to prevent.
 */
describe("parseMeshScan traces the floor rather than boxing it", () => {
  /** An L-shaped room: a rectangle with a bite out of one corner. */
  function lShapedMesh(): { positions: Float32Array; indices: Uint32Array } {
    const positions: number[] = [];
    const indices: number[] = [];
    const quad = (corners: [number, number, number][]) => {
      const base = positions.length / 3;
      for (const [x, y, z] of corners) positions.push(x, y, z);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const W = 6;
    const D = 5;
    const H = 2.4384;
    const BITE_W = 2.2;
    const BITE_D = 2.0;
    const step = 0.1;
    // Floor, minus the bitten corner.
    for (let x = 0; x < W; x += step) {
      for (let z = 0; z < D; z += step) {
        if (x > W - BITE_W && z > D - BITE_D) continue;
        quad([
          [x, 0, -z],
          [x + step, 0, -z],
          [x + step, 0, -(z + step)],
          [x, 0, -(z + step)],
        ]);
      }
    }
    // Ceiling over the same footprint, and a perimeter of walls tall enough to
    // establish the wall band.
    for (let x = 0; x < W; x += step) {
      for (let z = 0; z < D; z += step) {
        if (x > W - BITE_W && z > D - BITE_D) continue;
        quad([
          [x, H, -z],
          [x + step, H, -z],
          [x + step, H, -(z + step)],
          [x, H, -(z + step)],
        ]);
      }
    }
    for (let x = 0; x < W; x += step) {
      for (let y = 0; y < H; y += 0.2) {
        quad([
          [x, y, 0],
          [x + step, y, 0],
          [x + step, y + 0.2, 0],
          [x, y + 0.2, 0],
        ]);
      }
    }
    for (let z = 0; z < D; z += step) {
      for (let y = 0; y < H; y += 0.2) {
        quad([
          [0, y, -z],
          [0, y, -(z + step)],
          [0, y + 0.2, -(z + step)],
          [0, y + 0.2, -z],
        ]);
      }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  it("keeps an L-shaped room an L", () => {
    const { positions, indices } = lShapedMesh();
    const scan = parseMeshScan(positions, indices, "glb");
    expect(scan.parsed).toBe(true);
    // A rectangle is four walls. An L needs more, or it is not an L.
    expect(scan.walls.length).toBeGreaterThan(4);
  });

  it("still closes, whatever the shape", () => {
    const { positions, indices } = lShapedMesh();
    const scan = parseMeshScan(positions, indices, "glb");
    for (let i = 0; i < scan.walls.length; i++) {
      const next = scan.walls[(i + 1) % scan.walls.length]!;
      expect(scan.walls[i]!.end.x).toBeCloseTo(next.start.x, 9);
      expect(scan.walls[i]!.end.y).toBeCloseTo(next.start.y, 9);
    }
  });
});
