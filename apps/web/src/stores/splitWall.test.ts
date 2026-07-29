import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { wallLength } from "@myroom/schema";
import { useDrawing } from "./drawingStore.js";
import { emptyPlan } from "./projectsStore.js";
import { putProject } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";

/**
 * Splitting a wall must not throw away the user's doors and windows.
 *
 * The original filters kept an opening only if it lay wholly in one half
 * (`offset + width <= half`) or wholly in the other (`offset >= half`). An
 * opening straddling the split point satisfied neither and was dropped from
 * both — silent loss of work the user had explicitly placed, with no undo
 * entry naming it.
 */

const s = () => useDrawing.getState();

async function freshBoard() {
  const id = uuidv7();
  const now = new Date().toISOString();
  await putProject({
    id,
    name: "Test room",
    createdAt: now,
    updatedAt: now,
    plan: emptyPlan(),
    thumbnailSvg: null,
  });
  expect(await s().loadProject(id)).toBe(true);
  return id;
}

/** A 4 m × 4 m room, so every wall is exactly 4 m and `half` is exactly 2 m. */
function drawSquare() {
  expect(s().addChainPoint({ x: 0, y: 4 })).toBe("added");
  expect(s().addChainPoint({ x: 4, y: 4 })).toBe("added");
  expect(s().addChainPoint({ x: 4, y: 0 })).toBe("added");
  expect(s().addChainPoint({ x: 0, y: 0 })).toBe("added");
  expect(s().addChainPoint({ x: 0, y: 4 })).toBe("closed");
}

function totalOpenings() {
  return s().plan.walls.reduce((n, w) => n + w.openings.length, 0);
}

describe("splitWall keeps the openings the user placed", () => {
  beforeEach(async () => {
    await freshBoard();
    drawSquare();
  });

  it("keeps an opening that straddles the split point", () => {
    const wall = s().plan.walls[0]!;
    expect(wallLength(s().plan, wall)).toBeCloseTo(4, 6);

    // A 1.2 m window centred at 2.1 m spans 1.5–2.7 m on a 4 m wall: across
    // the 2.0 m midpoint.
    expect(s().addOpening(wall.id, "window", 2.1)).toBe(true);
    expect(totalOpenings()).toBe(1);

    s().splitWall(wall.id);

    expect(totalOpenings()).toBe(1);
    const kept = s().plan.walls.flatMap((w) => w.openings)[0]!;
    expect(kept.kind).toBe("window");
    expect(kept.width).toBeCloseTo(1.2, 6);
  });

  it("keeps an opening lying exactly on the split point", () => {
    const wall = s().plan.walls[0]!;
    // A 0.82 m door centred exactly on the 2.0 m midpoint.
    expect(s().addOpening(wall.id, "door", 2.0)).toBe(true);
    s().splitWall(wall.id);
    expect(totalOpenings()).toBe(1);
  });

  it("still keeps openings that fall cleanly in one half", () => {
    const wall = s().plan.walls[0]!;
    expect(s().addOpening(wall.id, "window", 0.85)).toBe(true); // 0.25–1.45
    expect(s().addOpening(wall.id, "window", 3.15)).toBe(true); // 2.55–3.75
    expect(totalOpenings()).toBe(2);

    s().splitWall(wall.id);
    expect(totalOpenings()).toBe(2);

    // Each lands on its own half, and the far one is rebased onto it.
    const halves = s().plan.walls.filter((w) => w.openings.length > 0);
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      const length = wallLength(s().plan, half);
      for (const opening of half.openings) {
        expect(opening.offset).toBeGreaterThanOrEqual(0);
        expect(opening.offset + opening.width).toBeLessThanOrEqual(length + 1e-9);
      }
    }
  });

  it("never leaves an opening hanging off the end of its wall", () => {
    const wall = s().plan.walls[0]!;
    expect(s().addOpening(wall.id, "window", 2.5)).toBe(true); // 1.9–3.1
    s().splitWall(wall.id);

    for (const w of s().plan.walls) {
      const length = wallLength(s().plan, w);
      for (const o of w.openings) {
        expect(o.offset).toBeGreaterThanOrEqual(0);
        expect(o.offset + o.width).toBeLessThanOrEqual(length + 1e-9);
      }
    }
  });

  it("splitting twice does not accumulate losses", () => {
    const wall = s().plan.walls[0]!;
    expect(s().addOpening(wall.id, "window", 2.1)).toBe(true);
    s().splitWall(wall.id);
    expect(totalOpenings()).toBe(1);

    const carrier = s().plan.walls.find((w) => w.openings.length > 0)!;
    s().splitWall(carrier.id);
    expect(totalOpenings()).toBe(1);
  });
});
