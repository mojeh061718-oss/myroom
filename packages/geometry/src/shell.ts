import { type Vec2, sub, add, scale, normalize, perp, dot, dist } from "./vec.js";
import { signedArea, polygonArea } from "./polygon.js";
import { wallFacePolygons } from "./offset.js";
import { triangulate } from "./triangulate.js";

/**
 * Shell generation (docs/06 §1): RoomPlan → walls, floor and ceiling.
 *
 * Deterministic and pure — the same plan always produces byte-identical
 * geometry, which is what makes the golden tests in docs/06 §9 meaningful and
 * lets the renderer stay a pure function of the document.
 *
 * Coordinates: the plan's (x, y) maps to world (x, −z), Y-up, meters
 * (docs/07 §5). UVs are in meters so materials tile at real-world scale.
 */

export interface MeshData {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export interface ShellOpening {
  id: string;
  kind: "door" | "window";
  offset: number;
  width: number;
  sillHeight: number;
  headHeight: number;
}

export interface ShellWallInput {
  id: string;
  label: string;
  thickness: number;
  height: number;
  openings: readonly ShellOpening[];
}

export interface WallShell {
  wallId: string;
  label: string;
  mesh: MeshData;
  /** centreline endpoints in world space, for placing wall-mounted objects */
  start: [number, number, number];
  end: [number, number, number];
  /** unit normal pointing into the room */
  inwardNormal: [number, number, number];
  length: number;
  height: number;
  thickness: number;
  /** how many doors/windows pierce this wall */
  openingCount: number;
}

export interface ShellGeometry {
  walls: WallShell[];
  floor: MeshData;
  ceiling: MeshData;
  height: number;
  floorArea: number;
  center: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangleCount: number;
}

const EPS = 1e-7;

function emptyMesh(): MeshData {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/** Plan point → world position at height y. */
const p3 = (p: Vec2, y: number): [number, number, number] => [p.x, y, -p.y];

function cross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Append a quad with an explicit desired normal. Winding is derived from the
 * geometry and flipped when it disagrees, so face orientation can never drift
 * out of sync with the normal regardless of wall direction or loop handedness.
 */
function pushQuad(
  mesh: MeshData,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  normal: [number, number, number],
  uv: [[number, number], [number, number], [number, number], [number, number]],
): void {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const geo = cross3(ab, ac);
  const flip = geo[0] * normal[0] + geo[1] * normal[1] + geo[2] * normal[2] < 0;

  const base = mesh.positions.length / 3;
  const verts = flip ? [a, d, c, b] : [a, b, c, d];
  const uvs = flip ? [uv[0], uv[3], uv[2], uv[1]] : uv;

  for (let i = 0; i < 4; i++) {
    mesh.positions.push(verts[i]![0], verts[i]![1], verts[i]![2]);
    mesh.normals.push(normal[0], normal[1], normal[2]);
    mesh.uvs.push(uvs[i]![0], uvs[i]![1]);
  }
  mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pushTriangle(
  mesh: MeshData,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  normal: [number, number, number],
  uv: [[number, number], [number, number], [number, number]],
): void {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const geo = cross3(ab, ac);
  const flip = geo[0] * normal[0] + geo[1] * normal[1] + geo[2] * normal[2] < 0;
  const verts = flip ? [a, c, b] : [a, b, c];
  const uvs = flip ? [uv[0], uv[2], uv[1]] : uv;
  const base = mesh.positions.length / 3;
  for (let i = 0; i < 3; i++) {
    mesh.positions.push(verts[i]![0], verts[i]![1], verts[i]![2]);
    mesh.normals.push(normal[0], normal[1], normal[2]);
    mesh.uvs.push(uvs[i]![0], uvs[i]![1]);
  }
  mesh.indices.push(base, base + 1, base + 2);
}

/** Sorted unique values, collapsing near-duplicates. */
function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1]! > EPS) out.push(v);
  }
  return out;
}

interface Rect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * Triangulate a rectangle with rectangular holes by grid decomposition.
 *
 * docs/06 §1 describes this as a boolean subtraction; for axis-aligned
 * rectangular openings a direct decomposition is deterministic, allocation-free
 * and yields clean real-world UVs, so no CSG library is involved
 * (see DECISIONS.md → "Analytic opening cutouts").
 */
function gridCells(face: Rect, holes: readonly Rect[]): Rect[] {
  const us = uniqueSorted([face.u0, face.u1, ...holes.flatMap((h) => [h.u0, h.u1])]).filter(
    (u) => u >= face.u0 - EPS && u <= face.u1 + EPS,
  );
  const vs = uniqueSorted([face.v0, face.v1, ...holes.flatMap((h) => [h.v0, h.v1])]).filter(
    (v) => v >= face.v0 - EPS && v <= face.v1 + EPS,
  );

  const cells: Rect[] = [];
  for (let i = 0; i + 1 < us.length; i++) {
    for (let j = 0; j + 1 < vs.length; j++) {
      const cell: Rect = { u0: us[i]!, u1: us[i + 1]!, v0: vs[j]!, v1: vs[j + 1]! };
      const cu = (cell.u0 + cell.u1) / 2;
      const cv = (cell.v0 + cell.v1) / 2;
      const inHole = holes.some(
        (h) => cu > h.u0 + EPS && cu < h.u1 - EPS && cv > h.v0 + EPS && cv < h.v1 - EPS,
      );
      if (!inHole) cells.push(cell);
    }
  }
  // Merge horizontally adjacent cells sharing a v-range to cut triangle count.
  const merged: Rect[] = [];
  for (const cell of cells) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.v0 - cell.v0) < EPS &&
      Math.abs(prev.v1 - cell.v1) < EPS &&
      Math.abs(prev.u1 - cell.u0) < EPS
    ) {
      prev.u1 = cell.u1;
    } else {
      merged.push({ ...cell });
    }
  }
  return merged;
}

export function buildShell(
  loop: readonly Vec2[],
  walls: readonly ShellWallInput[],
): ShellGeometry {
  if (loop.length < 3 || walls.length !== loop.length) {
    return {
      walls: [],
      floor: emptyMesh(),
      ceiling: emptyMesh(),
      height: 0,
      floorArea: 0,
      center: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      triangleCount: 0,
    };
  }

  // Handedness is absorbed into the interior normal rather than by reversing
  // the loop — reversing would silently mirror every opening offset, since
  // offsets are measured from the wall's own start (docs/04 §1).
  const ccw = signedArea(loop) > 0;
  const inwardSign = ccw ? 1 : -1;
  const ring = loop;
  const orderedWalls = walls;

  const n = ring.length;
  const thickness = orderedWalls.map((w) => w.thickness);
  const { inner, outer } = wallFacePolygons(ring, thickness);
  const height = Math.max(...orderedWalls.map((w) => w.height));

  const wallShells: WallShell[] = [];

  for (let i = 0; i < n; i++) {
    const wall = orderedWalls[i]!;
    const cA = ring[i]!;
    const cB = ring[(i + 1) % n]!;
    const dir = normalize(sub(cB, cA));
    const centreLength = dist(cA, cB);
    const inwardN = scale(perp(dir), inwardSign); // left of the edge when CCW
    const h = wall.height;

    const aIn = inner[i]!;
    const bIn = inner[(i + 1) % n]!;
    const aOut = outer[i]!;
    const bOut = outer[(i + 1) % n]!;

    // Face spans in centreline parameter space.
    const uInA = dot(sub(aIn, cA), dir);
    const uInB = dot(sub(bIn, cA), dir);
    const uOutA = dot(sub(aOut, cA), dir);
    const uOutB = dot(sub(bOut, cA), dir);

    const mesh = emptyMesh();

    const holes: Rect[] = wall.openings.map((o) => ({
      u0: o.offset,
      u1: o.offset + o.width,
      v0: o.sillHeight,
      v1: Math.min(o.headHeight, h),
    }));

    // Point on a face line at centreline parameter u, at height v.
    const facePoint = (origin: Vec2, uOrigin: number, u: number, v: number): [number, number, number] => {
      const p = add(origin, scale(dir, u - uOrigin));
      return p3(p, v);
    };

    const clampHoles = (u0: number, u1: number): Rect[] =>
      holes
        .map((hole) => ({
          u0: Math.max(hole.u0, u0),
          u1: Math.min(hole.u1, u1),
          v0: hole.v0,
          v1: hole.v1,
        }))
        .filter((hole) => hole.u1 - hole.u0 > EPS);

    // --- inner face (faces the room) ---
    {
      const nrm: [number, number, number] = [inwardN.x, 0, -inwardN.y];
      const face: Rect = { u0: Math.min(uInA, uInB), u1: Math.max(uInA, uInB), v0: 0, v1: h };
      for (const c of gridCells(face, clampHoles(face.u0, face.u1))) {
        pushQuad(
          mesh,
          facePoint(aIn, uInA, c.u0, c.v0),
          facePoint(aIn, uInA, c.u1, c.v0),
          facePoint(aIn, uInA, c.u1, c.v1),
          facePoint(aIn, uInA, c.u0, c.v1),
          nrm,
          [
            [c.u0, c.v0],
            [c.u1, c.v0],
            [c.u1, c.v1],
            [c.u0, c.v1],
          ],
        );
      }
    }

    // --- outer face ---
    {
      const nrm: [number, number, number] = [-inwardN.x, 0, inwardN.y];
      const face: Rect = { u0: Math.min(uOutA, uOutB), u1: Math.max(uOutA, uOutB), v0: 0, v1: h };
      for (const c of gridCells(face, clampHoles(face.u0, face.u1))) {
        pushQuad(
          mesh,
          facePoint(aOut, uOutA, c.u0, c.v0),
          facePoint(aOut, uOutA, c.u1, c.v0),
          facePoint(aOut, uOutA, c.u1, c.v1),
          facePoint(aOut, uOutA, c.u0, c.v1),
          nrm,
          [
            [c.u0, c.v0],
            [c.u1, c.v0],
            [c.u1, c.v1],
            [c.u0, c.v1],
          ],
        );
      }
    }

    // --- top face (openings that reach the ceiling split it) ---
    {
      const topHoles = holes
        .filter((hole) => hole.v1 >= h - EPS)
        .map((hole) => ({ u0: hole.u0, u1: hole.u1, v0: 0, v1: 1 }));
      const uStart = Math.min(uInA, uOutA);
      const uEnd = Math.max(uInB, uOutB);
      const face: Rect = { u0: uStart, u1: uEnd, v0: 0, v1: 1 };
      for (const c of gridCells(face, topHoles)) {
        const innerP0 = add(aIn, scale(dir, c.u0 - uInA));
        const innerP1 = add(aIn, scale(dir, c.u1 - uInA));
        const outerP0 = add(aOut, scale(dir, c.u0 - uOutA));
        const outerP1 = add(aOut, scale(dir, c.u1 - uOutA));
        pushQuad(
          mesh,
          p3(innerP0, h),
          p3(innerP1, h),
          p3(outerP1, h),
          p3(outerP0, h),
          [0, 1, 0],
          [
            [c.u0, 0],
            [c.u1, 0],
            [c.u1, wall.thickness],
            [c.u0, wall.thickness],
          ],
        );
      }
    }

    // --- opening reveals: the surfaces you see inside the hole ---
    for (const o of wall.openings) {
      const v0 = o.sillHeight;
      const v1 = Math.min(o.headHeight, h);
      const u0 = o.offset;
      const u1 = o.offset + o.width;
      const innerAt = (u: number) => add(aIn, scale(dir, u - uInA));
      const outerAt = (u: number) => add(aOut, scale(dir, u - uOutA));
      const t = wall.thickness;

      // Sill (upward-facing) — omitted for doors, whose sill is the floor.
      if (o.kind !== "door" && v0 > EPS) {
        pushQuad(
          mesh,
          p3(innerAt(u0), v0),
          p3(innerAt(u1), v0),
          p3(outerAt(u1), v0),
          p3(outerAt(u0), v0),
          [0, 1, 0],
          [
            [u0, 0],
            [u1, 0],
            [u1, t],
            [u0, t],
          ],
        );
      }
      // Head (downward-facing)
      if (v1 < h - EPS) {
        pushQuad(
          mesh,
          p3(innerAt(u0), v1),
          p3(innerAt(u1), v1),
          p3(outerAt(u1), v1),
          p3(outerAt(u0), v1),
          [0, -1, 0],
          [
            [u0, 0],
            [u1, 0],
            [u1, t],
            [u0, t],
          ],
        );
      }
      // Jambs — normals point across the opening, back toward the wall body.
      const jambN: [number, number, number] = [dir.x, 0, -dir.y];
      pushQuad(
        mesh,
        p3(innerAt(u0), v0),
        p3(outerAt(u0), v0),
        p3(outerAt(u0), v1),
        p3(innerAt(u0), v1),
        jambN,
        [
          [0, v0],
          [t, v0],
          [t, v1],
          [0, v1],
        ],
      );
      pushQuad(
        mesh,
        p3(innerAt(u1), v0),
        p3(outerAt(u1), v0),
        p3(outerAt(u1), v1),
        p3(innerAt(u1), v1),
        [-jambN[0], 0, -jambN[2]],
        [
          [0, v0],
          [t, v0],
          [t, v1],
          [0, v1],
        ],
      );
    }

    wallShells.push({
      wallId: wall.id,
      label: wall.label,
      mesh,
      start: p3(cA, 0),
      end: p3(cB, 0),
      inwardNormal: [inwardN.x, 0, -inwardN.y],
      length: centreLength,
      height: h,
      thickness: wall.thickness,
      openingCount: wall.openings.length,
    });
  }

  // --- floor & ceiling from the interior polygon ---
  const floor = emptyMesh();
  const ceiling = emptyMesh();
  const tris = triangulate(inner);
  for (let i = 0; i < tris.length; i += 3) {
    const pa = inner[tris[i]!]!;
    const pb = inner[tris[i + 1]!]!;
    const pc = inner[tris[i + 2]!]!;
    // Winding is derived from the desired normal rather than assumed, so the
    // plan→world y/−z mirror can't silently invert a face.
    pushTriangle(floor, p3(pa, 0), p3(pb, 0), p3(pc, 0), [0, 1, 0], [
      [pa.x, pa.y],
      [pb.x, pb.y],
      [pc.x, pc.y],
    ]);
    pushTriangle(ceiling, p3(pa, height), p3(pb, height), p3(pc, height), [0, -1, 0], [
      [pa.x, pa.y],
      [pb.x, pb.y],
      [pc.x, pc.y],
    ]);
  }

  // --- bounds & center ---
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, -p.y);
    maxZ = Math.max(maxZ, -p.y);
  }

  const triangleCount =
    wallShells.reduce((sum, w) => sum + w.mesh.indices.length / 3, 0) +
    floor.indices.length / 3 +
    ceiling.indices.length / 3;

  return {
    walls: wallShells,
    floor,
    ceiling,
    height,
    floorArea: polygonArea(inner),
    center: [(minX + maxX) / 2, height / 2, (minZ + maxZ) / 2],
    bounds: { min: [minX, 0, minZ], max: [maxX, height, maxZ] },
    triangleCount,
  };
}
