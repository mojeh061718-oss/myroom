import { describe, expect, it } from "vitest";
import { triangulate } from "../src/triangulate.js";
import { wallFacePolygons } from "../src/offset.js";
import { polygonArea, isSimplePolygon, signedArea } from "../src/polygon.js";
import { buildShell, type ShellWallInput } from "../src/shell.js";
import type { Vec2 } from "../src/vec.js";

const loop: Vec2[] = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 4 },
  { x: 2.35, y: 4 },
  { x: 2.35, y: 4.35 },
  { x: 2, y: 4.35 },
  { x: 2, y: 4 },
  { x: 0, y: 4 },
];

function triArea(pts: readonly Vec2[], idx: number[]): number {
  let total = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = pts[idx[i]!]!;
    const b = pts[idx[i + 1]!]!;
    const c = pts[idx[i + 2]!]!;
    total += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }
  return total;
}

const walls = (n: number, t: number): ShellWallInput[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    label: `L${i}`,
    thickness: t,
    height: 2.44,
    openings: [],
  }));

describe("VERIFY claim", () => {
  it("raw loop", () => {
    console.log("raw simple?", isSimplePolygon(loop), "signedArea", signedArea(loop));
    const t = triangulate(loop);
    console.log("raw tris", t.length / 3, "area", triArea(loop, t), "expected", polygonArea(loop));
    // edge lengths
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      console.log("edge", i, Math.hypot(b.x - a.x, b.y - a.y).toFixed(4));
    }
  });

  for (const th of [0.4, 0.5, 0.3, 0.2, 0.115]) {
    it(`thickness ${th}`, () => {
      const { inner } = wallFacePolygons(loop, new Array(loop.length).fill(th));
      console.log(`--- thickness ${th}`);
      console.log("inner", JSON.stringify(inner.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)])));
      console.log("inner simple?", isSimplePolygon(inner));
      console.log("inner |area| (shoelace)", polygonArea(inner));
      const tris = triangulate(inner);
      console.log("tri count", tris.length / 3, "of expected", inner.length - 2);
      console.log("tri area", triArea(inner, tris));
      const shell = buildShell(loop, walls(loop.length, th));
      console.log("floor tris", shell.floor.indices.length / 3, "floorArea field", shell.floorArea);
      // measure actual floor mesh area
      let fa = 0;
      const pos = shell.floor.positions;
      for (let i = 0; i < shell.floor.indices.length; i += 3) {
        const g = (k: number) => [pos[k * 3]!, pos[k * 3 + 2]!];
        const [ax, az] = g(shell.floor.indices[i]!);
        const [bx, bz] = g(shell.floor.indices[i + 1]!);
        const [cx, cz] = g(shell.floor.indices[i + 2]!);
        fa += Math.abs((bx! - ax!) * (cz! - az!) - (cx! - ax!) * (bz! - az!)) / 2;
      }
      console.log("floor mesh area", fa);
    });
  }
});
