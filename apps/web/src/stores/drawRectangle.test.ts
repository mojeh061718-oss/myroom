import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { RoomPlanSchema, wallLength } from "@myroom/schema";
import { formatLength } from "@myroom/geometry";
import { useDrawing } from "./drawingStore.js";
import { emptyPlan } from "./projectsStore.js";
import { putProject } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";

/**
 * Drag-out rooms (docs/04 §3): press, drag, release — one gesture, one room.
 *
 * Tapping four corners is the precise tool; a drag is what people reach for
 * first on a phone, and most rooms are rectangles.
 */

const s = () => useDrawing.getState();
const FT = 0.3048;

async function freshBoard() {
  const id = uuidv7();
  const now = new Date().toISOString();
  await putProject({ id, name: "R", createdAt: now, updatedAt: now, plan: emptyPlan(), thumbnailSvg: null });
  expect(await s().loadProject(id)).toBe(true);
}

beforeEach(freshBoard);

describe("drawRectangle", () => {
  it("builds a closed four-wall room from two opposite corners", () => {
    expect(s().drawRectangle({ x: 0, y: 0 }, { x: 12 * FT, y: 10 * FT })).toBe("closed");
    const { plan } = s();
    expect(plan.closed).toBe(true);
    expect(plan.walls).toHaveLength(4);
    expect(plan.vertices).toHaveLength(4);
    expect(RoomPlanSchema.parse(plan)).toBeTruthy();
  });

  it("gets the dimensions right whichever way the drag went", () => {
    // Bottom-right to top-left — the reverse of the natural drag.
    expect(s().drawRectangle({ x: 12 * FT, y: 10 * FT }, { x: 0, y: 0 })).toBe("closed");
    const { plan } = s();
    const lengths = plan.walls.map((w) => wallLength(plan, w)).sort((a, b) => a - b);
    expect(lengths[0]).toBeCloseTo(10 * FT, 6);
    expect(lengths[1]).toBeCloseTo(10 * FT, 6);
    expect(lengths[2]).toBeCloseTo(12 * FT, 6);
    expect(lengths[3]).toBeCloseTo(12 * FT, 6);
  });

  it("labels walls A–D like the tap-drawn path does", () => {
    s().drawRectangle({ x: 0, y: 0 }, { x: 4, y: 3 });
    expect(s().plan.walls.map((w) => w.label).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("computes floor area", () => {
    s().drawRectangle({ x: 0, y: 0 }, { x: 4, y: 3 });
    expect(s().plan.floorArea).toBeCloseTo(12, 6);
  });

  it("is a single undo step, not four", () => {
    s().drawRectangle({ x: 0, y: 0 }, { x: 4, y: 3 });
    expect(s().plan.closed).toBe(true);
    s().undo();
    // One undo returns to the empty board, rather than dismantling it wall by wall.
    expect(s().plan.closed).toBe(false);
    expect(s().plan.walls).toHaveLength(0);
  });

  it("rejects a drag too small to be a room", () => {
    expect(s().drawRectangle({ x: 0, y: 0 }, { x: 0.1, y: 0.1 })).toBe("rejected");
    expect(s().plan.walls).toHaveLength(0);
  });

  it("opens the height sheet and switches to select, like closing a chain does", () => {
    s().drawRectangle({ x: 0, y: 0 }, { x: 4, y: 3 });
    expect(s().heightSheetOpen).toBe(true);
    expect(s().tool).toBe("select");
  });
});

describe("everything the user reads is feet and inches", () => {
  it("formats a dragged room's sides in feet and inches", () => {
    s().drawRectangle({ x: 0, y: 0 }, { x: 12.5 * FT, y: 10 * FT });
    const { plan } = s();
    const shown = plan.walls.map((w) => formatLength(wallLength(plan, w), "ft"));
    for (const text of shown) {
      expect(text).toMatch(/['"]/);
      expect(text).not.toContain("m");
    }
    expect(shown).toContain("12'6\"");
    expect(shown).toContain("10'");
  });

  it("defaults new installs to feet", async () => {
    const { getSettings } = await import("../lib/db.js");
    expect((await getSettings()).displayUnit).toBe("ft");
  });
});
