import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildShell, type ShellWallInput } from "../src/shell.js";
import { triangulate } from "../src/triangulate.js";
import { wallFacePolygons } from "../src/offset.js";
import { polygonArea, isSimplePolygon, pointInPolygon } from "../src/polygon.js";
import type { Vec2 } from "../src/vec.js";

const rect = (w = 6.2, h = 4.8): Vec2[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

const lShape: Vec2[] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 3 },
  { x: 3, y: 3 },
  { x: 3, y: 5 },
  { x: 0, y: 5 },
];

const plainWalls = (n: number, height = 2.44, thickness = 0.115): ShellWallInput[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    label: String.fromCharCode(65 + i),
    thickness,
    height,
    openings: [],
  }));

/** Every triangle's geometric normal must agree with its stored vertex normal. */
function normalsConsistent(mesh: {
  positions: number[];
  normals: number[];
  indices: number[];
}): boolean {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [ia, ib, ic] = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const p = (k: number) => [mesh.positions[k * 3]!, mesh.positions[k * 3 + 1]!, mesh.positions[k * 3 + 2]!];
    const [ax, ay, az] = p(ia);
    const [bx, by, bz] = p(ib);
    const [cx, cy, cz] = p(ic);
    const ux = bx! - ax!, uy = by! - ay!, uz = bz! - az!;
    const vx = cx! - ax!, vy = cy! - ay!, vz = cz! - az!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue; // degenerate sliver
    const sx = mesh.normals[ia * 3]!, sy = mesh.normals[ia * 3 + 1]!, sz = mesh.normals[ia * 3 + 2]!;
    if ((nx * sx + ny * sy + nz * sz) / len < 0) return false;
  }
  return true;
}

describe("triangulate", () => {
  it("triangulates a convex quad into 2 triangles covering its area", () => {
    const loop = rect();
    const tris = triangulate(loop);
    expect(tris).toHaveLength(6);
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = loop[tris[i]!]!;
      const b = loop[tris[i + 1]!]!;
      const c = loop[tris[i + 2]!]!;
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
    expect(area).toBeCloseTo(polygonArea(loop), 9);
  });

  it("handles the concave L-shape (a fan would fail here)", () => {
    const tris = triangulate(lShape);
    expect(tris).toHaveLength((lShape.length - 2) * 3);
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = lShape[tris[i]!]!;
      const b = lShape[tris[i + 1]!]!;
      const c = lShape[tris[i + 2]!]!;
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
    expect(area).toBeCloseTo(polygonArea(lShape), 9);
  });

  it("produces n-2 triangles whose total area matches, for random star polygons", () => {
    const star = fc
      .array(fc.record({ w: fc.double({ min: 0.6, max: 1, noNaN: true }), r: fc.double({ min: 1, max: 8, noNaN: true }) }), {
        minLength: 3,
        maxLength: 10,
      })
      .map((pts) => {
        const total = pts.reduce((s, p) => s + p.w, 0);
        let ang = 0;
        return pts.map((p): Vec2 => {
          const v = { x: Math.cos(ang) * p.r, y: Math.sin(ang) * p.r };
          ang += (p.w / total) * Math.PI * 2;
          return v;
        });
      });
    fc.assert(
      fc.property(star, (loop) => {
        const tris = triangulate(loop);
        expect(tris.length).toBe((loop.length - 2) * 3);
        let area = 0;
        for (let i = 0; i < tris.length; i += 3) {
          const a = loop[tris[i]!]!;
          const b = loop[tris[i + 1]!]!;
          const c = loop[tris[i + 2]!]!;
          area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
        }
        expect(area).toBeCloseTo(polygonArea(loop), 6);
      }),
      { numRuns: 150 },
    );
  });
});

describe("mitered wall offsets", () => {
  it("shrinks the interior and grows the exterior by half a thickness", () => {
    const loop = rect(6, 4);
    const { inner, outer } = wallFacePolygons(loop, [0.2, 0.2, 0.2, 0.2]);
    // 6×4 centreline ⇒ interior 5.8×3.8, exterior 6.2×4.2
    expect(polygonArea(inner)).toBeCloseTo(5.8 * 3.8, 6);
    expect(polygonArea(outer)).toBeCloseTo(6.2 * 4.2, 6);
    expect(isSimplePolygon(inner)).toBe(true);
    expect(isSimplePolygon(outer)).toBe(true);
  });

  it("miters an L-shape without self-intersecting", () => {
    const { inner, outer } = wallFacePolygons(lShape, new Array(6).fill(0.115));
    expect(isSimplePolygon(inner)).toBe(true);
    expect(isSimplePolygon(outer)).toBe(true);
    expect(polygonArea(inner)).toBeLessThan(polygonArea(lShape));
    expect(polygonArea(outer)).toBeGreaterThan(polygonArea(lShape));
  });

  it("is handedness-independent: interior always shrinks", () => {
    const cw = [...rect(6, 4)].reverse();
    const { inner, outer } = wallFacePolygons(cw, [0.2, 0.2, 0.2, 0.2]);
    expect(polygonArea(inner)).toBeCloseTo(5.8 * 3.8, 6);
    expect(polygonArea(outer)).toBeCloseTo(6.2 * 4.2, 6);
  });
});

describe("buildShell (docs/06 §1)", () => {
  it("builds a closed rectangular room with consistent normals", () => {
    const shell = buildShell(rect(), plainWalls(4));
    expect(shell.walls).toHaveLength(4);
    expect(shell.height).toBeCloseTo(2.44, 9);
    expect(shell.floorArea).toBeCloseTo((6.2 - 0.115) * (4.8 - 0.115), 4);
    for (const w of shell.walls) expect(normalsConsistent(w.mesh), w.label).toBe(true);
    expect(normalsConsistent(shell.floor)).toBe(true);
    expect(normalsConsistent(shell.ceiling)).toBe(true);
  });

  it("orients the floor up and the ceiling down", () => {
    const shell = buildShell(rect(), plainWalls(4));
    for (let i = 1; i < shell.floor.normals.length; i += 3) expect(shell.floor.normals[i]).toBe(1);
    for (let i = 1; i < shell.ceiling.normals.length; i += 3) expect(shell.ceiling.normals[i]).toBe(-1);
    // floor sits at y=0, ceiling at wall height
    for (let i = 1; i < shell.floor.positions.length; i += 3) expect(shell.floor.positions[i]).toBe(0);
    for (let i = 1; i < shell.ceiling.positions.length; i += 3) {
      expect(shell.ceiling.positions[i]).toBeCloseTo(2.44, 9);
    }
  });

  it("points every wall's inward normal into the room, for both handedness and concave plans", () => {
    for (const loop of [rect(), lShape, [...rect()].reverse(), [...lShape].reverse()]) {
      const shell = buildShell(loop, plainWalls(loop.length));
      for (const w of shell.walls) {
        // Step off the wall midpoint along its inward normal; that must land
        // inside the room polygon. (A bounding-box centre would be wrong here:
        // for the L-shape it sits perpendicular to one wall's normal.)
        const mx = (w.start[0] + w.end[0]) / 2;
        const mz = (w.start[2] + w.end[2]) / 2;
        const probe = {
          x: mx + w.inwardNormal[0] * 0.25,
          y: -(mz + w.inwardNormal[2] * 0.25), // world −z back to plan y
        };
        expect(pointInPolygon(probe, loop), `${w.label} inward`).toBe(true);
        const outward = {
          x: mx - w.inwardNormal[0] * 0.25,
          y: -(mz - w.inwardNormal[2] * 0.25),
        };
        expect(pointInPolygon(outward, loop), `${w.label} outward`).toBe(false);
      }
    }
  });

  it("punches openings out of both faces and adds reveals", () => {
    const walls = plainWalls(4);
    walls[0] = {
      ...walls[0]!,
      openings: [
        { id: "d", kind: "door", offset: 1.2, width: 0.82, sillHeight: 0, headHeight: 2.03 },
        { id: "w", kind: "window", offset: 3.0, width: 1.2, sillHeight: 0.9, headHeight: 2.1 },
      ],
    };
    const withOpenings = buildShell(rect(), walls);
    const plain = buildShell(rect(), plainWalls(4));

    const cut = withOpenings.walls[0]!.mesh;
    const solid = plain.walls[0]!.mesh;
    expect(normalsConsistent(cut)).toBe(true);
    // More geometry than the solid wall: the hole splits faces and adds reveals.
    expect(cut.indices.length).toBeGreaterThan(solid.indices.length);

    // No vertex may sit strictly inside a hole on either face.
    const holes = walls[0]!.openings;
    for (let i = 0; i < cut.positions.length; i += 3) {
      const x = cut.positions[i]!;
      const y = cut.positions[i + 1]!;
      const insideX = holes.some((o) => x > o.offset + 1e-6 && x < o.offset + o.width - 1e-6);
      const insideY = holes.some((o) => y > o.sillHeight + 1e-6 && y < o.headHeight - 1e-6);
      expect(insideX && insideY).toBe(false);
    }
  });

  it("keeps a door's opening clear down to the floor", () => {
    const walls = plainWalls(4);
    walls[0] = {
      ...walls[0]!,
      openings: [{ id: "d", kind: "door", offset: 1.2, width: 0.82, sillHeight: 0, headHeight: 2.03 }],
    };
    const shell = buildShell(rect(), walls);
    const mesh = shell.walls[0]!.mesh;
    // No wall surface anywhere within the doorway footprint below the head.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      const y = mesh.positions[i + 1]!;
      if (x > 1.25 && x < 1.97 && y > 0.05 && y < 1.9) {
        // Only jamb/reveal surfaces may appear here, and those sit at the edges.
        expect(false, `unexpected surface at x=${x} y=${y}`).toBe(true);
      }
    }
  });

  it("is deterministic — identical input yields byte-identical geometry", () => {
    const a = buildShell(lShape, plainWalls(6));
    const b = buildShell(lShape, plainWalls(6));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("stays well within the docs/06 §8 triangle budget for an empty shell", () => {
    const walls = plainWalls(6);
    walls[0] = {
      ...walls[0]!,
      openings: [{ id: "w", kind: "window", offset: 1, width: 1.2, sillHeight: 0.9, headHeight: 2.1 }],
    };
    const shell = buildShell(lShape, walls);
    expect(shell.triangleCount).toBeLessThan(1000);
  });

  it("returns an empty shell for degenerate input rather than throwing", () => {
    expect(buildShell([], []).walls).toHaveLength(0);
    expect(buildShell(rect(), plainWalls(3)).walls).toHaveLength(0);
  });
});
