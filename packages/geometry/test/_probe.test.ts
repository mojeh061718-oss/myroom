import { describe, it } from "vitest";
import { offsetPolygon, wallFacePolygons } from "../src/offset.js";
import { triangulate } from "../src/triangulate.js";
import { polygonArea, isSimplePolygon, signedArea, pointInPolygon } from "../src/polygon.js";
import { buildShell, type ShellWallInput } from "../src/shell.js";
import { labelWalls } from "../src/wall.js";
import type { Vec2 } from "../src/vec.js";

const plainWalls = (n: number, height = 2.44, thickness = 0.115): ShellWallInput[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    label: String.fromCharCode(65 + i),
    thickness,
    height,
    openings: [],
  }));

const fmt = (l: readonly Vec2[]) => l.map((p) => `(${p.x.toFixed(4)},${p.y.toFixed(4)})`).join(" ");

const lShape: Vec2[] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 3 },
  { x: 3, y: 3 },
  { x: 3, y: 5 },
  { x: 0, y: 5 },
];

describe("probe", () => {
  it("L-shape offsets", () => {
    const { inner, outer } = wallFacePolygons(lShape, new Array(6).fill(0.115));
    console.log("L inner:", fmt(inner));
    console.log("L outer:", fmt(outer));
    console.log("L area centre", polygonArea(lShape), "inner", polygonArea(inner), "outer", polygonArea(outer));
    // hand: inner should be (0.0575,0.0575)(5.9425,0.0575)(5.9425,2.9425)(2.9425,2.9425)(2.9425,4.9425)(0.0575,4.9425)
    // area = 6*5 - 3*2 = 24 centre; inner = 5.885*2.885 + 2.885*2.0 ... compute below
  });

  it("acute corner miter clamp", () => {
    // narrow wedge room: very acute at (0,0)
    const wedge: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0.2 },
      { x: 6, y: -0.2 + 4 },
    ];
    const { inner } = wallFacePolygons(wedge, [0.115, 0.115, 0.115]);
    console.log("wedge inner:", fmt(inner), "simple?", isSimplePolygon(inner), "area", polygonArea(inner), "orig", polygonArea(wedge));
  });

  it("thin room where inner offset inverts", () => {
    // A 0.15 m deep alcove with 0.115 walls -> inner faces cross
    const thin: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 0.15 },
      { x: 0, y: 0.15 },
    ];
    const { inner } = wallFacePolygons(thin, new Array(4).fill(0.115));
    console.log("thin inner:", fmt(inner), "signedArea", signedArea(inner), "area", polygonArea(inner));
    const shell = buildShell(thin, plainWalls(4));
    console.log("thin floorArea", shell.floorArea, "triCount", shell.triangleCount);
  });

  it("labelWalls on CCW rect", () => {
    const ccw: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ];
    console.log("ccw signedArea", signedArea(ccw), "labels", labelWalls(ccw));
    const cw = [...ccw].reverse();
    console.log("cw", fmt(cw), "labels", labelWalls(cw));
    console.log("L labels", labelWalls(lShape), "signedArea", signedArea(lShape));
  });

  it("triangulate reversed / collinear / duplicate", () => {
    const collinear: Vec2[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const t = triangulate(collinear);
    let area = 0;
    for (let i = 0; i < t.length; i += 3) {
      const a = collinear[t[i]!]!, b = collinear[t[i + 1]!]!, c = collinear[t[i + 2]!]!;
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
    console.log("collinear tris", t, "area", area, "expected", polygonArea(collinear));

    // A "comb"/U shape - classic ear clipping stress
    const u: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 5 },
      { x: 0, y: 5 },
    ];
    const tu = triangulate(u);
    let au = 0;
    for (let i = 0; i < tu.length; i += 3) {
      const a = u[tu[i]!]!, b = u[tu[i + 1]!]!, c = u[tu[i + 2]!]!;
      au += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
    console.log("U tris count", tu.length / 3, "expected", u.length - 2, "area", au, "expected", polygonArea(u));
  });

  it("buildShell area for L", () => {
    const shell = buildShell(lShape, plainWalls(6));
    const { inner } = wallFacePolygons(lShape, new Array(6).fill(0.115));
    console.log("L shell floorArea", shell.floorArea, "polygonArea(inner)", polygonArea(inner));
    console.log("bounds", JSON.stringify(shell.bounds), "center", JSON.stringify(shell.center));
    // floor triangle area sum
    let a = 0;
    const f = shell.floor;
    for (let i = 0; i < f.indices.length; i += 3) {
      const ia = f.indices[i]!, ib = f.indices[i + 1]!, ic = f.indices[i + 2]!;
      const ax = f.positions[ia * 3]!, az = f.positions[ia * 3 + 2]!;
      const bx = f.positions[ib * 3]!, bz = f.positions[ib * 3 + 2]!;
      const cx = f.positions[ic * 3]!, cz = f.positions[ic * 3 + 2]!;
      a += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    }
    console.log("L floor mesh area", a);
  });
});
