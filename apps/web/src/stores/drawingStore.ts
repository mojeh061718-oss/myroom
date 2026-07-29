import { create } from "zustand";
import {
  chainSegmentConflicts,
  dist,
  isSimplePolygon,
  resolveLoopWallLength,
  resolveWallLength,
  indexToLabel,
  signedArea,
  type Vec2,
} from "@myroom/geometry";
import type { Opening, RoomPlan, Wall } from "@myroom/schema";
import { labelWallsForPlan, planLoop, wallLength } from "@myroom/schema";
import { uuidv7 } from "../lib/uuid.js";
import { getProject, putProject, type LocalProject } from "../lib/db.js";
import { haptic } from "../theme/tokens.js";

export const MIN_WALL_LENGTH = 0.3;
export const DEFAULT_THICKNESS = 0.115;
export const DEFAULT_HEIGHT = 2.44;
export const DOOR_DEFAULTS = { width: 0.82, sillHeight: 0, headHeight: 2.03 };
export const WINDOW_DEFAULTS = { width: 1.2, sillHeight: 0.9, headHeight: 2.1 };

export type Tool = "room" | "wall" | "select" | "door" | "window" | "measure";

export type Selection =
  | { kind: "wall"; wallId: string }
  | { kind: "vertex"; vertexId: string }
  | { kind: "opening"; wallId: string; openingId: string }
  | null;

/**
 * Every mutation is a command (docs/04 §3): a named, serializable
 * { before, after } plan snapshot pair — trivially invertible, so undo/redo
 * covers every mutation including opening placement and typed-dimension edits.
 */
interface Command {
  label: string;
  before: RoomPlan;
  after: RoomPlan;
  /** The tool that was active when the command ran, so undo can restore it —
   * undoing a room closure otherwise leaves the board on "select" and looking
   * unresponsive. */
  tool: Tool;
}

export interface RejectionInfo {
  reason: "tooShort" | "selfIntersect" | "openingOverlap" | "invalid";
  at: number;
}

interface DrawingState {
  projectId: string | null;
  projectName: string;
  projectCreatedAt: string;
  plan: RoomPlan;
  undoStack: Command[];
  redoStack: Command[];
  tool: Tool;
  selection: Selection;
  /** open chain = vertex ids in draw order; [] when not drawing */
  chainActive: boolean;
  /** set when the last input was rejected — drives the shake animation */
  rejection: RejectionInfo | null;
  /** closure pulse animation trigger */
  closedAt: number | null;
  heightSheetOpen: boolean;
  /** plan snapshot at drag start, so the eventual command's `before` is pre-drag */
  dragBaseline: RoomPlan | null;

  loadProject: (id: string) => Promise<boolean>;
  setTool: (tool: Tool) => void;
  select: (selection: Selection) => void;

  startOrContinueChain: () => Vec2 | null;
  /** Build the room from a scan's traced floor outline. */
  buildFromOutline: (points: readonly Vec2[], ceilingHeight: number | null) => "added" | "closed" | "rejected";
  /** Drag out a whole rectangular room from two opposite corners. */
  drawRectangle: (a: Vec2, b: Vec2) => "added" | "closed" | "rejected";
  addChainPoint: (p: Vec2) => "added" | "closed" | "rejected";
  endChain: () => void;

  moveVertex: (vertexId: string, p: Vec2, commit: boolean) => void;
  deleteWall: (wallId: string) => void;
  splitWall: (wallId: string) => void;
  setWallThickness: (wallId: string, thickness: number) => void;
  setTypedLength: (wallId: string, meters: number) => boolean;

  addOpening: (wallId: string, kind: "door" | "window", centerOffset: number) => boolean;
  updateOpening: (wallId: string, openingId: string, patch: Partial<Opening>, commit: boolean) => boolean;
  deleteOpening: (wallId: string, openingId: string) => void;
  setHeights: (defaultHeight: number) => void;
  setHeightSheetOpen: (open: boolean) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

function vertexById(plan: RoomPlan, id: string) {
  return plan.vertices.find((v) => v.id === id);
}

function chainOrder(plan: RoomPlan): string[] {
  // Walls are stored in draw order; the open chain is start of wall 0 … end of last wall.
  if (plan.walls.length === 0) return plan.vertices.map((v) => v.id);
  const ids = [plan.walls[0]!.start];
  for (const w of plan.walls) ids.push(w.end);
  return ids;
}

/**
 * The closed loop's vertex ids in wall order (edge i runs ids[i] → ids[i+1],
 * wrapping), or null when the walls don't form one clean cycle in array order.
 */
function orderedLoopIds(plan: RoomPlan): string[] | null {
  const n = plan.walls.length;
  if (n < 3) return null;
  for (let i = 0; i < n; i++) {
    if (plan.walls[i]!.end !== plan.walls[(i + 1) % n]!.start) return null;
  }
  return plan.walls.map((w) => w.start);
}

export function chainPoints(plan: RoomPlan): Vec2[] {
  return chainOrder(plan)
    .map((id) => vertexById(plan, id))
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .map((v) => ({ x: v.x, y: v.y }));
}

export function lastChainPoint(plan: RoomPlan): Vec2 | null {
  if (plan.closed || plan.walls.length === 0) {
    const only = plan.vertices[plan.vertices.length - 1];
    return plan.closed || !only ? null : { x: only.x, y: only.y };
  }
  const last = plan.walls[plan.walls.length - 1]!;
  const v = vertexById(plan, last.end);
  return v ? { x: v.x, y: v.y } : null;
}

export function chainOrigin(plan: RoomPlan): Vec2 | null {
  if (plan.closed || plan.walls.length === 0) return null;
  const v = vertexById(plan, plan.walls[0]!.start);
  return v ? { x: v.x, y: v.y } : null;
}

/** Recompute derived fields (area, wall labels) after any geometry change. */
function refreshDerived(plan: RoomPlan): RoomPlan {
  if (!plan.closed) return { ...plan, floorArea: null };
  return labelWallsForPlan(plan);
}

/** A closed plan must stay a simple polygon; open plans must not self-cross. */
function planGeometryValid(plan: RoomPlan): boolean {
  if (plan.closed) {
    const loop = planLoop(plan);
    return loop !== null && isSimplePolygon(loop);
  }
  const pts = chainPoints(plan);
  for (let i = 0; i + 1 < pts.length; i++) {
    if (chainSegmentConflicts(pts.slice(0, i + 1), pts[i]!, pts[i + 1]!)) return false;
  }
  return true;
}

function openingsValid(wall: Wall, length: number): boolean {
  const sorted = [...wall.openings].sort((a, b) => a.offset - b.offset);
  let prevEnd = 0;
  for (const o of sorted) {
    if (o.offset < -1e-9 || o.offset + o.width > length + 1e-9) return false;
    if (o.offset < prevEnd - 1e-9) return false;
    prevEnd = o.offset + o.width;
  }
  return true;
}

function allOpeningsValid(plan: RoomPlan): boolean {
  return plan.walls.every((w) => openingsValid(w, wallLength(plan, w)));
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let flushPersist: (() => void) | null = null;

// Never lose work (docs/01 §12): a pending debounced write must survive
// navigation/kill — flush it the moment the page starts going away.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushPersist?.());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist?.();
  });
}

export const useDrawing = create<DrawingState>((set, get) => {
  const write = () => {
    clearTimeout(persistTimer);
    flushPersist = null;
    const { projectId, projectName, projectCreatedAt, plan } = get();
    if (!projectId || !plan) return;
    const project: LocalProject = {
      id: projectId,
      name: projectName,
      createdAt: projectCreatedAt,
      updatedAt: new Date().toISOString(),
      plan,
      thumbnailSvg: planThumbnail(plan),
    };
    void putProject(project);
  };

  /**
   * Persist continuously (docs/01 §12 "never lose work"). Every command writes
   * immediately — plan documents are a few KB, and a debounce window is exactly
   * the moment a killed app loses work. (Drag previews don't persist; only
   * their commit does.)
   */
  const persist = write;

  const commit = (label: string, after: RoomPlan): void => {
    const before = get().dragBaseline ?? get().plan;
    set({
      plan: after,
      undoStack: [...get().undoStack, { label, before, after, tool: get().tool }],
      redoStack: [],
      dragBaseline: null,
    });
    persist();
  };

  const reject = (reason: RejectionInfo["reason"]): "rejected" => {
    set({ rejection: { reason, at: Date.now() } });
    return "rejected";
  };

  return {
    projectId: null,
    projectName: "",
    projectCreatedAt: "",
    plan: null as unknown as RoomPlan,
    undoStack: [],
    redoStack: [],
    tool: "room",
    selection: null,
    chainActive: false,
    rejection: null,
    closedAt: null,
    heightSheetOpen: false,
    dragBaseline: null,

    loadProject: async (id) => {
      const project = await getProject(id);
      if (!project) return false;
      set({
        projectId: id,
        projectName: project.name,
        projectCreatedAt: project.createdAt,
        plan: project.plan,
        undoStack: [],
        redoStack: [],
        tool: project.plan.closed ? "select" : "room",
        selection: null,
        chainActive: false,
        rejection: null,
        closedAt: null,
      });
      return true;
    },

    setTool: (tool) => set({ tool, selection: null }),
    select: (selection) => set({ selection }),

    startOrContinueChain: () => {
      const { plan } = get();
      if (plan.closed) return null;
      set({ chainActive: true });
      return lastChainPoint(plan);
    },

    /**
     * Drag out a rectangular room in one gesture (docs/04 §3).
     *
     * Tapping a vertex at a time is the precise tool, but most rooms are
     * rectangles and most people reach for a drag first. This builds the whole
     * closed room from two opposite corners, as a single undo entry — five
     * `addChainPoint` calls would leave five of them, and undo would take the
     * room apart wall by wall rather than putting the user back where they
     * started.
     *
     * Winding is normalised so wall A is always the northernmost edge,
     * whichever direction the drag went, which is what `refreshDerived`'s
     * geometric relabelling expects (docs/04 §5).
     */
    /**
     * Build the whole room from a scan's traced outline (docs/05 §2).
     *
     * This is the scan-first path: a LiDAR scan is a measurement, and drawing a
     * room on a phone is the fiddliest thing the app asks anyone to do — so the
     * scan produces the plan and the person tidies it, rather than the other
     * way round. It also means there is no scan-to-plan registration step,
     * because the scan *is* the plan.
     *
     * Replaces whatever is on the board as a single undo entry, so one tap of
     * undo puts the user back where they were if the trace is wrong.
     */
    buildFromOutline: (points, ceilingHeight) => {
      if (points.length < 3) return "rejected";
      const { plan } = get();

      // Anticlockwise, so wall labelling and the shell's interior normals agree
      // with every hand-drawn plan (docs/04 §5).
      const ring = signedArea(points) < 0 ? [...points].reverse() : points;

      const vertices = ring.map((p) => ({ id: uuidv7(), x: p.x, y: p.y }));
      const height = ceilingHeight !== null && ceilingHeight > 1.8 && ceilingHeight < 6 ? ceilingHeight : DEFAULT_HEIGHT;
      const walls: Wall[] = vertices.map((v, i) => ({
        id: uuidv7(),
        label: indexToLabel(i),
        start: v.id,
        end: vertices[(i + 1) % vertices.length]!.id,
        thickness: DEFAULT_THICKNESS,
        height,
        openings: [],
      }));

      let next: RoomPlan = { ...plan, vertices, walls, closed: true, source: "scan" };
      const loop = planLoop(next);
      if (!loop || !isSimplePolygon(loop)) return reject("selfIntersect");
      next = refreshDerived(next);
      commit("Build room from scan", next);
      // The height came from the scan, so do not ask for it again.
      set({ chainActive: false, closedAt: Date.now(), heightSheetOpen: ceilingHeight === null, tool: "select" });
      haptic("success");
      return "closed";
    },

    drawRectangle: (a, b) => {
      const { plan } = get();
      if (plan.closed) return "rejected";

      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (maxX - minX < MIN_WALL_LENGTH || maxY - minY < MIN_WALL_LENGTH) return reject("tooShort");

      // Clockwise from the north-west corner, so the first wall runs along the
      // top edge before relabelling confirms it.
      const corners = [
        { x: minX, y: maxY },
        { x: maxX, y: maxY },
        { x: maxX, y: minY },
        { x: minX, y: minY },
      ];
      const vertices = corners.map((c) => ({ id: uuidv7(), x: c.x, y: c.y }));
      const walls: Wall[] = vertices.map((v, i) => ({
        id: uuidv7(),
        label: indexToLabel(i),
        start: v.id,
        end: vertices[(i + 1) % vertices.length]!.id,
        thickness: DEFAULT_THICKNESS,
        height: DEFAULT_HEIGHT,
        openings: [],
      }));

      let next: RoomPlan = { ...plan, vertices, walls, closed: true };
      const loop = planLoop(next);
      if (!loop || !isSimplePolygon(loop)) return reject("selfIntersect");
      next = refreshDerived(next);
      commit("Draw room", next);
      set({ chainActive: false, closedAt: Date.now(), heightSheetOpen: true, tool: "select" });
      haptic("medium");
      return "closed";
    },

    addChainPoint: (p) => {
      const { plan } = get();
      if (plan.closed) return "rejected";
      const last = lastChainPoint(plan);
      const origin = chainOrigin(plan);

      // First point of the room: just a vertex, no wall yet.
      if (!last) {
        const v = { id: uuidv7(), x: p.x, y: p.y };
        commit("Place first point", { ...plan, vertices: [...plan.vertices, v] });
        set({ chainActive: true });
        return "added";
      }

      const closing = origin !== null && plan.walls.length >= 2 && dist(p, origin) < 1e-9;
      const target = closing ? origin! : p;

      if (dist(last, target) < MIN_WALL_LENGTH) return reject("tooShort");
      const pts = chainPoints(plan);
      if (chainSegmentConflicts(pts, last, target)) return reject("selfIntersect");

      const chain = chainOrder(plan);
      const lastId = chain[chain.length - 1]!;

      if (closing) {
        const originId = plan.walls[0]!.start;
        const wall: Wall = {
          id: uuidv7(),
          label: indexToLabel(plan.walls.length),
          start: lastId,
          end: originId,
          thickness: DEFAULT_THICKNESS,
          height: DEFAULT_HEIGHT,
          openings: [],
        };
        let closedPlan: RoomPlan = { ...plan, walls: [...plan.walls, wall], closed: true };
        const loop = planLoop(closedPlan);
        if (!loop || !isSimplePolygon(loop)) return reject("selfIntersect");
        closedPlan = refreshDerived(closedPlan);
        commit("Close room", closedPlan);
        set({ chainActive: false, closedAt: Date.now(), heightSheetOpen: true, tool: "select" });
        haptic("medium");
        return "closed";
      }

      const v = { id: uuidv7(), x: target.x, y: target.y };
      const wall: Wall = {
        id: uuidv7(),
        label: indexToLabel(plan.walls.length),
        start: lastId,
        end: v.id,
        thickness: DEFAULT_THICKNESS,
        height: DEFAULT_HEIGHT,
        openings: [],
      };
      commit("Draw wall", { ...plan, vertices: [...plan.vertices, v], walls: [...plan.walls, wall] });
      return "added";
    },

    endChain: () => set({ chainActive: false }),

    moveVertex: (vertexId, p, commitMove) => {
      const { plan } = get();
      const next: RoomPlan = {
        ...plan,
        vertices: plan.vertices.map((v) => (v.id === vertexId ? { ...v, x: p.x, y: p.y } : v)),
      };
      if (!planGeometryValid(next) || !allOpeningsValid(next)) {
        if (commitMove) reject("selfIntersect");
        return;
      }
      // Walls sharing this vertex move with it — connected-endpoint integrity is
      // inherent to the vertex-reference model (docs/04 §3 "no tearing").
      const short = next.walls.some((w) => wallLength(next, w) < MIN_WALL_LENGTH - 1e-9);
      if (short) {
        if (commitMove) reject("tooShort");
        return;
      }
      if (commitMove) {
        commit("Move vertex", refreshDerived(next));
      } else {
        set({ plan: refreshDerived(next), dragBaseline: get().dragBaseline ?? plan });
      }
    },

    deleteWall: (wallId) => {
      const { plan } = get();
      const wall = plan.walls.find((w) => w.id === wallId);
      if (!wall) return;
      let next: RoomPlan = { ...plan, walls: plan.walls.filter((w) => w.id !== wallId), closed: false, floorArea: null };
      // Reopening the loop: reorder the remaining walls into one chain when possible
      if (plan.closed) {
        const after = plan.walls.filter((w) => w.id !== wallId);
        const idx = plan.walls.findIndex((w) => w.id === wallId);
        const reordered = [...after.slice(idx), ...after.slice(0, idx)];
        next = { ...next, walls: reordered };
      }
      // Drop orphaned vertices.
      const used = new Set(next.walls.flatMap((w) => [w.start, w.end]));
      next = { ...next, vertices: next.vertices.filter((v) => used.has(v.id) || next.walls.length === 0) };
      if (next.walls.length === 0) next = { ...next, vertices: [] };
      commit("Delete wall", next);
      set({ selection: null });
    },

    splitWall: (wallId) => {
      const { plan } = get();
      const idx = plan.walls.findIndex((w) => w.id === wallId);
      const wall = plan.walls[idx];
      if (!wall) return;
      const a = vertexById(plan, wall.start)!;
      const b = vertexById(plan, wall.end)!;
      const mid = { id: uuidv7(), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const half = wallLength(plan, wall) / 2;
      // Each opening goes to the half containing its centre, rebased onto that
      // half and clamped to fit. Filtering on "lies wholly within a half"
      // instead would drop anything straddling the midpoint from both halves —
      // a door the user placed would simply disappear, with the undo entry
      // still reading "Split wall". Clamping a straddling opening changes its
      // position by at most half its width; deleting it loses it entirely.
      const rebase = (o: Opening, base: number): Opening => {
        const width = Math.min(o.width, half);
        return { ...o, width, offset: Math.min(Math.max(o.offset - base, 0), half - width) };
      };
      const centreOf = (o: Opening) => o.offset + o.width / 2;

      const first: Wall = {
        ...wall,
        end: mid.id,
        openings: wall.openings.filter((o) => centreOf(o) <= half).map((o) => rebase(o, 0)),
      };
      // Labels are recomputed below (closed: geometric relabel; open: draw order).
      const second: Wall = {
        ...wall,
        id: uuidv7(),
        start: mid.id,
        openings: wall.openings.filter((o) => centreOf(o) > half).map((o) => rebase(o, half)),
      };
      const walls = [...plan.walls.slice(0, idx), first, second, ...plan.walls.slice(idx + 1)];
      const next = refreshDerived({
        ...plan,
        vertices: [...plan.vertices, mid],
        walls: walls.map((w, i) => (plan.closed ? w : { ...w, label: indexToLabel(i) })),
      });
      commit("Split wall", next);
    },

    setWallThickness: (wallId, thickness) => {
      const { plan } = get();
      const t = Math.min(0.5, Math.max(0.05, thickness));
      commit("Set wall thickness", {
        ...plan,
        walls: plan.walls.map((w) => (w.id === wallId ? { ...w, thickness: t } : w)),
      });
    },

    setTypedLength: (wallId, meters) => {
      const { plan } = get();
      const idx = plan.walls.findIndex((w) => w.id === wallId);
      const wall = plan.walls[idx];
      if (!wall || meters < MIN_WALL_LENGTH) {
        reject("tooShort");
        return false;
      }

      // Typed dimensions beat drawn ones (docs/04 §4). On a closed loop the
      // correction propagates so the room keeps its shape — typing "12'" on a
      // rectangle's wall must not shear it into a trapezoid. When the shape
      // can't be preserved (diagonal walls), fall back to sliding just the
      // edited wall's end vertex.
      if (plan.closed) {
        const chained = orderedLoopIds(plan);
        if (chained) {
          const edgeIndex = chained.indexOf(wall.start);
          const loop = chained.map((id) => {
            const v = vertexById(plan, id)!;
            return { x: v.x, y: v.y };
          });
          const solvedLoop = edgeIndex >= 0 ? resolveLoopWallLength(loop, edgeIndex, meters) : null;
          if (solvedLoop) {
            const byId = new Map(chained.map((id, i) => [id, solvedLoop[i]!]));
            const next: RoomPlan = {
              ...plan,
              vertices: plan.vertices.map((v) => {
                const p = byId.get(v.id);
                return p ? { ...v, x: p.x, y: p.y } : v;
              }),
            };
            if (planGeometryValid(next) && allOpeningsValid(next)) {
              commit("Set wall length", refreshDerived(next));
              return true;
            }
          }
        }
      }

      const a = vertexById(plan, wall.start)!;
      const b = vertexById(plan, wall.end)!;
      const solved = resolveWallLength({ x: a.x, y: a.y }, { x: b.x, y: b.y }, meters, "start");
      const moved = { ...b, x: solved.end.x, y: solved.end.y };
      const next: RoomPlan = {
        ...plan,
        vertices: plan.vertices.map((v) => (v.id === moved.id ? moved : v)),
      };
      if (!planGeometryValid(next) || !allOpeningsValid(next)) {
        reject("selfIntersect");
        return false;
      }
      commit("Set wall length", refreshDerived(next));
      return true;
    },

    addOpening: (wallId, kind, centerOffset) => {
      const { plan } = get();
      const wall = plan.walls.find((w) => w.id === wallId);
      if (!wall) return false;
      const length = wallLength(plan, wall);
      const defaults = kind === "door" ? DOOR_DEFAULTS : WINDOW_DEFAULTS;
      const width = Math.min(defaults.width, Math.max(0.1, length - 0.1));
      const offset = Math.min(Math.max(centerOffset - width / 2, 0), length - width);
      const opening: Opening = {
        id: uuidv7(),
        kind,
        offset,
        width,
        sillHeight: defaults.sillHeight,
        headHeight: Math.min(defaults.headHeight, wall.height),
        swing: kind === "door" ? "left" : null,
      };
      const candidate: Wall = { ...wall, openings: [...wall.openings, opening] };
      if (!openingsValid(candidate, length)) {
        reject("openingOverlap");
        return false;
      }
      commit(`Add ${kind}`, {
        ...plan,
        walls: plan.walls.map((w) => (w.id === wallId ? candidate : w)),
      });
      set({ selection: { kind: "opening", wallId, openingId: opening.id } });
      return true;
    },

    updateOpening: (wallId, openingId, patch, commitChange) => {
      const { plan } = get();
      const wall = plan.walls.find((w) => w.id === wallId);
      if (!wall) return false;
      const length = wallLength(plan, wall);
      const candidate: Wall = {
        ...wall,
        openings: wall.openings.map((o) => (o.id === openingId ? { ...o, ...patch } : o)),
      };
      if (!openingsValid(candidate, length)) {
        if (commitChange) reject("openingOverlap");
        return false;
      }
      const next = { ...plan, walls: plan.walls.map((w) => (w.id === wallId ? candidate : w)) };
      if (commitChange) {
        commit("Edit opening", next);
      } else {
        set({ plan: next, dragBaseline: get().dragBaseline ?? plan });
      }
      return true;
    },

    deleteOpening: (wallId, openingId) => {
      const { plan } = get();
      commit("Delete opening", {
        ...plan,
        walls: plan.walls.map((w) =>
          w.id === wallId ? { ...w, openings: w.openings.filter((o) => o.id !== openingId) } : w,
        ),
      });
      set({ selection: null });
    },

    setHeights: (defaultHeight) => {
      const { plan } = get();
      const h = Math.min(6, Math.max(2, defaultHeight));
      commit("Set wall height", {
        ...plan,
        walls: plan.walls.map((w) => ({ ...w, height: h })),
      });
    },
    setHeightSheetOpen: (heightSheetOpen) => set({ heightSheetOpen }),

    undo: () => {
      const { undoStack, redoStack } = get();
      const cmd = undoStack[undoStack.length - 1];
      if (!cmd) return;
      set({
        plan: cmd.before,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, cmd],
        selection: null,
        chainActive: false,
        tool: cmd.tool,
      });
      persist();
    },
    redo: () => {
      const { undoStack, redoStack } = get();
      const cmd = redoStack[redoStack.length - 1];
      if (!cmd) return;
      set({
        plan: cmd.after,
        undoStack: [...undoStack, cmd],
        redoStack: redoStack.slice(0, -1),
        selection: null,
      });
      persist();
    },
    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,
  };
});

/** Tiny SVG poster of the plan for the Projects Home card. */
export function planThumbnail(plan: RoomPlan): string | null {
  const pts = plan.closed ? planLoop(plan) : chainPoints(plan);
  if (!pts || pts.length < 2) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 0.1);
  const h = Math.max(maxY - minY, 0.1);
  const scale = 100 / Math.max(w, h);
  const path = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${((p.x - minX) * scale).toFixed(1)},${((maxY - p.y) * scale).toFixed(1)}`)
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 ${w * scale + 20} ${h * scale + 20}"><path d="${path}${plan.closed ? " Z" : ""}" fill="${plan.closed ? "rgba(76,141,255,0.15)" : "none"}" stroke="#4C8DFF" stroke-width="4" stroke-linejoin="round"/></svg>`;
}
