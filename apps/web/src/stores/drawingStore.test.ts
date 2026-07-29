import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { RoomPlanSchema, wallLength } from "@myroom/schema";
import { useDrawing } from "./drawingStore.js";
import { emptyPlan } from "./projectsStore.js";
import { putProject } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";

async function freshBoard() {
  const id = uuidv7();
  const now = new Date().toISOString();
  await putProject({ id, name: "Test room", createdAt: now, updatedAt: now, plan: emptyPlan(), thumbnailSvg: null });
  const ok = await useDrawing.getState().loadProject(id);
  expect(ok).toBe(true);
  return id;
}

/** Draw the 6.2 × 4.8 rectangle from docs/01 §5 and close it. */
function drawRectangle() {
  const s = useDrawing.getState();
  expect(s.addChainPoint({ x: 0, y: 4.8 })).toBe("added");
  expect(s.addChainPoint({ x: 6.2, y: 4.8 })).toBe("added");
  expect(s.addChainPoint({ x: 6.2, y: 0 })).toBe("added");
  expect(s.addChainPoint({ x: 0, y: 0 })).toBe("added");
  expect(s.addChainPoint({ x: 0, y: 4.8 })).toBe("closed");
}

describe("drawingStore (docs/04 acceptance)", () => {
  beforeEach(async () => {
    await freshBoard();
  });

  it("draws and closes a 4-wall room with area, labels and schema validity", () => {
    drawRectangle();
    const { plan, heightSheetOpen } = useDrawing.getState();
    expect(plan.closed).toBe(true);
    expect(plan.floorArea).toBeCloseTo(29.76, 3);
    expect(plan.walls.map((w) => w.label).sort()).toEqual(["A", "B", "C", "D"]);
    // Wall A must be the northernmost (the y=4.8 edge drawn first).
    const a = plan.walls.find((w) => w.label === "A")!;
    expect(wallLength(plan, a)).toBeCloseTo(6.2, 6);
    expect(heightSheetOpen).toBe(true);
    expect(() => RoomPlanSchema.parse(plan)).not.toThrow();
  });

  it("rejects too-short walls and self-intersections at input time", () => {
    const s = useDrawing.getState();
    s.addChainPoint({ x: 0, y: 0 });
    s.addChainPoint({ x: 4, y: 0 });
    expect(useDrawing.getState().addChainPoint({ x: 4.1, y: 0 })).toBe("rejected"); // 0.1 m < 0.3 m
    expect(useDrawing.getState().rejection?.reason).toBe("tooShort");
    useDrawing.getState().addChainPoint({ x: 4, y: 3 });
    expect(useDrawing.getState().addChainPoint({ x: 2, y: -2 })).toBe("rejected"); // crosses wall 1
    expect(useDrawing.getState().rejection?.reason).toBe("selfIntersect");
  });

  it("typed dimension re-solves the wall keeping the shared vertex fixed", () => {
    drawRectangle();
    const plan = useDrawing.getState().plan;
    const wall = plan.walls[0]!; // 6.2 m north wall drawn from (0,4.8)→(6.2,4.8)
    const startBefore = plan.vertices.find((v) => v.id === wall.start)!;
    expect(useDrawing.getState().setTypedLength(wall.id, 6.0)).toBe(true);
    const after = useDrawing.getState().plan;
    const startAfter = after.vertices.find((v) => v.id === wall.start)!;
    expect(startAfter.x).toBe(startBefore.x);
    expect(startAfter.y).toBe(startBefore.y);
    expect(wallLength(after, after.walls.find((w) => w.id === wall.id)!)).toBeCloseTo(6.0, 9);
    // area recomputed
    expect(after.floorArea).not.toBeCloseTo(29.76, 3);
  });

  it("adds, slides, resizes and deletes openings with overlap rejection", () => {
    drawRectangle();
    const s = useDrawing.getState;
    const wall = s().plan.walls[0]!;
    expect(s().addOpening(wall.id, "door", 1.5)).toBe(true);
    expect(s().addOpening(wall.id, "window", 3.5)).toBe(true);
    let openings = s().plan.walls[0]!.openings;
    expect(openings).toHaveLength(2);
    const door = openings.find((o) => o.kind === "door")!;
    // slide the door into the window → rejected
    expect(s().updateOpening(wall.id, door.id, { offset: 3.2 }, true)).toBe(false);
    expect(s().rejection?.reason).toBe("openingOverlap");
    // legal slide + resize
    expect(s().updateOpening(wall.id, door.id, { offset: 0.2 }, true)).toBe(true);
    expect(s().updateOpening(wall.id, door.id, { width: 0.92 }, true)).toBe(true);
    // swing toggle
    expect(s().updateOpening(wall.id, door.id, { swing: "right" }, true)).toBe(true);
    s().deleteOpening(wall.id, door.id);
    openings = s().plan.walls[0]!.openings;
    expect(openings).toHaveLength(1);
    expect(() => RoomPlanSchema.parse(s().plan)).not.toThrow();
  });

  it("undo/redo covers every mutation type (docs/04 §7)", () => {
    const s = useDrawing.getState;
    drawRectangle();
    const closedPlan = structuredClone(s().plan);

    const wallA = s().plan.walls[0]!;
    s().setHeights(2.7); // 1
    s().setTypedLength(wallA.id, 6.0); // 2
    s().addOpening(wallA.id, "door", 1.5); // 3
    const door = s().plan.walls[0]!.openings[0]!;
    s().updateOpening(wallA.id, door.id, { offset: 2.0 }, true); // 4
    s().setWallThickness(wallA.id, 0.2); // 5
    s().splitWall(s().plan.walls[1]!.id); // 6
    const afterAll = structuredClone(s().plan);

    // Unwind everything back to the freshly closed room.
    for (let i = 0; i < 6; i++) s().undo();
    expect(s().plan).toEqual(closedPlan);
    // Replay everything.
    for (let i = 0; i < 6; i++) s().redo();
    expect(s().plan).toEqual(afterAll);
    // Undo all the way to the empty board.
    while (s().canUndo()) s().undo();
    expect(s().plan.vertices).toHaveLength(0);
    expect(s().plan.walls).toHaveLength(0);
    expect(s().plan.closed).toBe(false);
  });

  it("moveVertex preserves connected-endpoint integrity and relabels", () => {
    drawRectangle();
    const s = useDrawing.getState;
    const wallA = s().plan.walls[0]!;
    const v = s().plan.vertices.find((x) => x.id === wallA.start)!;
    s().moveVertex(v.id, { x: v.x - 0.5, y: v.y + 0.3 }, true);
    const after = s().plan;
    // still a closed, valid plan with 4 walls; both walls sharing v moved with it
    expect(after.closed).toBe(true);
    expect(() => RoomPlanSchema.parse(after)).not.toThrow();
    expect(after.floorArea).not.toBeCloseTo(29.76, 3);
  });

  it("deleting a wall reopens the room into one editable chain", () => {
    drawRectangle();
    const s = useDrawing.getState;
    const wallB = s().plan.walls[1]!;
    s().deleteWall(wallB.id);
    const after = s().plan;
    expect(after.closed).toBe(false);
    expect(after.walls).toHaveLength(3);
    expect(after.floorArea).toBeNull();
    // remaining walls form one open chain (each wall's end is the next one's start)
    for (let i = 0; i + 1 < after.walls.length; i++) {
      expect(after.walls[i]!.end).toBe(after.walls[i + 1]!.start);
    }
  });

  it("serialize → deserialize round-trips the plan identically (docs/04 §7)", () => {
    drawRectangle();
    const s = useDrawing.getState;
    s().addOpening(s().plan.walls[2]!.id, "window", 2.0);
    const plan = s().plan;
    const roundTripped = RoomPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(roundTripped).toEqual(plan);
  });
});
