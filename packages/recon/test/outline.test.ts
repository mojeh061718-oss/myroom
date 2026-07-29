import { existsSync, readFileSync } from "node:fs";

import { isSimplePolygon, polygonArea } from "@myroom/geometry";
import { describe, expect, it } from "vitest";

import { findHorizontalPlanes, findPrincipalAngle, measureFootprint, triangleFacets } from "../src/mesh.js";
import { traceFloorOutline } from "../src/outline.js";

/**
 * A scan should *build* the room, not correct one drawn by hand.
 *
 * Drawing a room on a phone is the fiddliest thing the app asks for, and a scan
 * is a measurement — so the scan produces the plan and the person tidies it.
 * That also removes scan-to-plan registration entirely (the scan is the plan)
 * and stops the shape being forced into a rectangle, which is what defeats an
 * open-plan space that runs from a play area into a kitchen.
 */

const SQ_FT = 10.7639;
const CELL = 0.15;

/** Occupancy cells covering an axis-aligned rectangle, in metres. */
function rectangleCells(width: number, depth: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let x = 0; x <= width; x += CELL) {
    for (let y = 0; y <= depth; y += CELL) cells.push([x, y]);
  }
  return cells;
}

/** An L: the full rectangle minus a bite out of one corner. */
function lShapedCells(width: number, depth: number, biteW: number, biteD: number): [number, number][] {
  return rectangleCells(width, depth).filter(([x, y]) => !(x > width - biteW && y > depth - biteD));
}

describe("a scan traces its own floor plan", () => {
  it("traces a rectangle back to a rectangle", () => {
    const ring = traceFloorOutline(rectangleCells(4.9, 3.9), 0);
    expect(ring).not.toBeNull();
    expect(isSimplePolygon(ring!)).toBe(true);
    expect(ring!.length).toBeGreaterThanOrEqual(4);
    expect(ring!.length).toBeLessThanOrEqual(6);
    expect(polygonArea(ring!)).toBeGreaterThan(4.9 * 3.9 * 0.8);
    expect(polygonArea(ring!)).toBeLessThan(4.9 * 3.9 * 1.25);
  });

  it("keeps an L-shape an L, instead of boxing it", () => {
    const width = 6.0;
    const depth = 5.0;
    const ring = traceFloorOutline(lShapedCells(width, depth, 2.2, 2.0), 0);
    expect(ring).not.toBeNull();
    expect(isSimplePolygon(ring!)).toBe(true);
    const area = polygonArea(ring!);
    const boundingBox = width * depth;
    const trueArea = boundingBox - 2.2 * 2.0;
    // The whole point: nearer the L's area than the box around it.
    expect(Math.abs(area - trueArea)).toBeLessThan(Math.abs(area - boundingBox));
    expect(area).toBeLessThan(boundingBox * 0.92);
  });

  it("bridges the holes furniture leaves in the floor", () => {
    // A rectangle with a sofa-sized patch of missing floor in the middle.
    const cells = rectangleCells(5, 4).filter(([x, y]) => !(x > 1.5 && x < 3.5 && y > 1.5 && y < 2.6));
    const ring = traceFloorOutline(cells, 0);
    expect(ring).not.toBeNull();
    // The hole must not become a notch in the outline.
    expect(polygonArea(ring!)).toBeGreaterThan(5 * 4 * 0.85);
  });

  it("discards a sliver seen through a doorway", () => {
    const room = rectangleCells(5, 4);
    const sliver: [number, number][] = [];
    for (let y = 0; y < 1; y += CELL) sliver.push([12 + y, y]);
    const ring = traceFloorOutline([...room, ...sliver], 0);
    expect(ring).not.toBeNull();
    const xs = ring!.map((p) => p.x);
    expect(Math.max(...xs)).toBeLessThan(8);
  });

  it("declines rather than inventing a room from nothing", () => {
    expect(traceFloorOutline([], 0)).toBeNull();
    expect(traceFloorOutline([[0, 0], [0.15, 0]], 0)).toBeNull();
  });

  it("produces walls long enough to be worth editing", () => {
    const ring = traceFloorOutline(rectangleCells(4.9, 3.9), 0)!;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0.3);
    }
  });

  it("keeps a genuinely angled wall inside its own footprint", () => {
    // A room with a 45° corner cut traces as a staircase of cell steps. The
    // old finisher turned staircases into spikes (snap + re-intersect shoots
    // near-parallel corners metres away); the collapse must stay simple and
    // never leave the cells it came from.
    const cells = rectangleCells(6, 5).filter(([x, y]) => x + y < 8.5);
    const ring = traceFloorOutline(cells, 0);
    expect(ring).not.toBeNull();
    expect(isSimplePolygon(ring!)).toBe(true);
    for (const p of ring!) {
      expect(p.x).toBeGreaterThan(-0.5);
      expect(p.x).toBeLessThan(6.5);
      expect(p.y).toBeGreaterThan(-0.5);
      expect(p.y).toBeLessThan(5.5);
    }
    // The cut corner must actually be cut, not boxed back in.
    const area = polygonArea(ring!);
    expect(area).toBeLessThan(6 * 5 * 0.98);
    expect(area).toBeGreaterThan((6 * 5 - (2.5 * 2.5) / 2) * 0.85);
  });
});

const POSITIONS = "/tmp/sv_positions.bin";
const INDICES = "/tmp/sv_indices.bin";
describe.skipIf(!existsSync(POSITIONS) || !existsSync(INDICES))("the real scan traces its own plan", () => {
  function context() {
    const positions = new Float32Array(readFileSync(POSITIONS).buffer);
    const indices = new Uint32Array(readFileSync(INDICES).buffer);
    const facets = triangleFacets(positions, indices);
    const planes = findHorizontalPlanes(facets)!;
    const footprint = measureFootprint(facets, planes, findPrincipalAngle(facets)!);
    return { facets, planes, footprint };
  }
  function outline() {
    // Cells are already in the room's own frame, so no further rotation.
    return traceFloorOutline(context().footprint.cells, 0);
  }

  it("produces a simple, editable outline", () => {
    const ring = outline();
    expect(ring).not.toBeNull();
    expect(isSimplePolygon(ring!)).toBe(true);
    expect(ring!.length).toBeGreaterThanOrEqual(4);
    expect(ring!.length).toBeLessThanOrEqual(12);
  });

  it("never leaves its own occupancy — the dart regression", () => {
    // The first shipped outline of this scan had a plausible area (212 sq ft)
    // and a 36-foot wall: a dart whose vertices sat metres outside the floor,
    // because snapped near-parallel walls were re-intersected far away. Area
    // asserts can't see that; containment can.
    const { footprint } = context();
    const xs = footprint.cells.map((c) => c[0]);
    const ys = footprint.cells.map((c) => c[1]);
    const pad = 0.5;
    const bounds = {
      minX: Math.min(...xs) - pad,
      maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad,
      maxY: Math.max(...ys) + pad,
    };
    for (const p of outline()!) {
      expect(p.x).toBeGreaterThan(bounds.minX);
      expect(p.x).toBeLessThan(bounds.maxX);
      expect(p.y).toBeGreaterThan(bounds.minY);
      expect(p.y).toBeLessThan(bounds.maxY);
    }
  });

  it("encloses what the walls enclose", () => {
    // The owner's separate hand drawing said 208 sq ft; the scan's wall bands
    // enclose ~285 — the drawing under-measured the open-plan run. What this
    // pins is the measurement staying near the walls, tight enough that a
    // collapse to a corridor or a bloat past the walls both fail.
    const sqFt = polygonArea(outline()!) * SQ_FT;
    expect(sqFt).toBeGreaterThan(240);
    expect(sqFt).toBeLessThan(330);
  });
});
