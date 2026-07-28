import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  add,
  dist,
  formatLength,
  midpoint,
  normalize,
  perp,
  pointSegmentClosest,
  resolveSnap,
  scale,
  sub,
  type SnapResult,
  type Vec2,
} from "@myroom/geometry";
import { planLoop, wallLength, type RoomPlan, type Wall } from "@myroom/schema";
import { signedArea } from "@myroom/geometry";
import { useDrawing, chainOrigin, chainPoints, lastChainPoint } from "../../stores/drawingStore.js";
import { useSettings } from "../../stores/settingsStore.js";
import { haptic } from "../../theme/tokens.js";
import {
  clampPpm,
  planGroupTransform,
  scaleBarMeters,
  toPlan,
  toScreen,
  type Viewport,
} from "./viewport.js";
import { DimensionInputOverlay } from "./DimensionInput.js";

interface WallGeo {
  wall: Wall;
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  normal: Vec2;
  length: number;
  quad: string;
}

function wallGeometry(plan: RoomPlan): WallGeo[] {
  const byId = new Map(plan.vertices.map((v) => [v.id, v]));
  return plan.walls.flatMap((wall) => {
    const av = byId.get(wall.start);
    const bv = byId.get(wall.end);
    if (!av || !bv) return [];
    const a = { x: av.x, y: av.y };
    const b = { x: bv.x, y: bv.y };
    const dir = normalize(sub(b, a));
    const normal = perp(dir);
    const t = wall.thickness / 2;
    const p1 = add(a, scale(normal, t));
    const p2 = add(b, scale(normal, t));
    const p3 = add(b, scale(normal, -t));
    const p4 = add(a, scale(normal, -t));
    return [
      {
        wall,
        a,
        b,
        dir,
        normal,
        length: dist(a, b),
        quad: `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y} ${p4.x},${p4.y}`,
      },
    ];
  });
}

/** Grid lines for the visible plan range (docs/04 §2: 0.1 m minor / 1 m major, fading by zoom). */
function gridLines(v: Viewport, w: number, h: number) {
  const tl = toPlan({ x: 0, y: 0 }, v, w, h);
  const br = toPlan({ x: w, y: h }, v, w, h);
  const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
  const minorVisible = v.ppm >= 55;
  const step = minorVisible ? 0.1 : 1;
  const startX = Math.floor(tl.x / step) * step;
  const endX = Math.ceil(br.x / step) * step;
  const startY = Math.floor(br.y / step) * step;
  const endY = Math.ceil(tl.y / step) * step;
  const isMajor = (val: number) => Math.abs(val - Math.round(val)) < 1e-6;
  for (let x = startX; x <= endX + 1e-9; x += step) {
    lines.push({ x1: x, y1: br.y, x2: x, y2: tl.y, major: isMajor(x) });
  }
  for (let y = startY; y <= endY + 1e-9; y += step) {
    lines.push({ x1: tl.x, y1: y, x2: br.x, y2: y, major: isMajor(y) });
  }
  return lines;
}

/** How close to an edge a drag must get before the board starts scrolling. */
const EDGE_PAN_MARGIN = 56;
/** Pan speed in px/frame at the very edge, ramping down to zero at the margin. */
const EDGE_PAN_SPEED = 9;

interface DragState {
  kind: "vertex" | "opening";
  vertexId?: string;
  wallId?: string;
  openingId?: string;
  moved: boolean;
}

interface GestureState {
  startMid: Vec2;
  startDist: number;
  startViewport: Viewport;
  current: Viewport;
}

export function BoardCanvas() {
  const plan = useDrawing((s) => s.plan);
  const tool = useDrawing((s) => s.tool);
  const selection = useDrawing((s) => s.selection);
  const closedAt = useDrawing((s) => s.closedAt);
  const drawing = useDrawing.getState;
  const unit = useSettings((s) => s.displayUnit);

  const wrapRef = useRef<HTMLDivElement>(null);
  const geomRef = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [viewport, setViewport] = useState<Viewport>({ cx: 0, cy: 0, ppm: 60 });
  const [gesturing, setGesturing] = useState(false);
  const [preview, setPreview] = useState<SnapResult | null>(null);
  const [measure, setMeasure] = useState<{ a: Vec2; b: Vec2 | null } | null>(null);
  const [editingWallId, setEditingWallId] = useState<string | null>(null);

  const pointers = useRef(new Map<number, Vec2>());
  const gesture = useRef<GestureState | null>(null);
  const drag = useRef<DragState | null>(null);
  /**
   * Edge auto-pan while dragging (docs/04 §3). Without it a room can only ever
   * grow as far as the screen edge, because a finger cannot travel past it —
   * so dragging a corner "further out" was impossible on a phone. Holding near
   * an edge now scrolls the board under the pointer instead.
   */
  const edgePan = useRef<{ frame: number; at: Vec2; vx: number; vy: number } | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const shiftHeld = useRef(false);
  const tapTracker = useRef({ maxPointers: 0, startedAt: 0, moved: false });
  const lastTap = useRef({ at: 0, x: 0, y: 0 });

  // --- vertex drag, with auto-pan at the edges -----------------------------

  /** Move the dragged vertex to a screen point, under a given viewport. */
  const applyVertexDrag = (sp: Vec2, v: Viewport) => {
    const id = drag.current?.vertexId;
    if (!id) return;
    const state = drawing();
    const { w, h } = sizeRef.current;
    const raw = toPlan(sp, v, w, h);
    const others = state.plan.vertices.filter((x) => x.id !== id).map((x) => ({ x: x.x, y: x.y }));
    const snapped = resolveSnap(raw, { vertices: others, pxPerMeter: v.ppm, orthoDisabled: true });
    state.moveVertex(id, snapped.point, false);
  };

  const stopEdgePan = () => {
    if (edgePan.current) cancelAnimationFrame(edgePan.current.frame);
    edgePan.current = null;
  };

  /**
   * Pan when the pointer is held near an edge, and keep the vertex under it.
   * Speed ramps from nothing at the margin to full at the edge itself, so a
   * drag that merely passes near an edge doesn't lurch.
   */
  const updateEdgePan = (sp: Vec2) => {
    const { w, h } = sizeRef.current;
    const push = (near: number, far: number) =>
      near < EDGE_PAN_MARGIN
        ? -(1 - Math.max(0, near) / EDGE_PAN_MARGIN)
        : far < EDGE_PAN_MARGIN
          ? 1 - Math.max(0, far) / EDGE_PAN_MARGIN
          : 0;
    const vx = push(sp.x, w - sp.x) * EDGE_PAN_SPEED;
    const vy = push(sp.y, h - sp.y) * EDGE_PAN_SPEED;

    if (vx === 0 && vy === 0) return stopEdgePan();
    if (edgePan.current) {
      edgePan.current.at = sp;
      edgePan.current.vx = vx;
      edgePan.current.vy = vy;
      return;
    }

    const step = () => {
      const pan = edgePan.current;
      if (!pan || !drag.current) return stopEdgePan();
      const v = viewportRef.current;
      const next: Viewport = { ...v, cx: v.cx + pan.vx / v.ppm, cy: v.cy - pan.vy / v.ppm };
      viewportRef.current = next;
      setViewport(next);
      applyVertexDrag(pan.at, next);
      pan.frame = requestAnimationFrame(step);
    };
    edgePan.current = { at: sp, vx, vy, frame: requestAnimationFrame(step) };
  };

  useEffect(() => stopEdgePan, []);

  // --- size tracking -------------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit existing plan on first load.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.w === 0 || !plan) return;
    fitted.current = true;
    const pts = chainPoints(plan);
    if (pts.length < 2) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const spanX = Math.max(...xs) - Math.min(...xs) + 2;
    const spanY = Math.max(...ys) - Math.min(...ys) + 2;
    const ppm = clampPpm(Math.min(size.w / spanX, size.h / spanY));
    setViewport({ cx, cy, ppm });
  }, [size, plan]);

  // --- keyboard (docs/02 §9 full keyboard operation) -----------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftHeld.current = true;
      const state = drawing();
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        state.redo();
        return;
      }
      if (e.key === "Escape") {
        state.endChain();
        state.select(null);
        setPreview(null);
        setMeasure(null);
        setEditingWallId(null);
        return;
      }
      const sel = state.selection;
      if (e.key === "Enter" && sel?.kind === "wall") {
        setEditingWallId(sel.wallId);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        if (sel.kind === "wall") state.deleteWall(sel.wallId);
        if (sel.kind === "opening") state.deleteOpening(sel.wallId, sel.openingId);
        return;
      }
      // Arrow-key nudge: 5 cm, Shift = 25 cm (docs/06 §7 convention).
      if (sel?.kind === "vertex" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const stepM = e.shiftKey ? 0.25 : 0.05;
        const v = state.plan.vertices.find((x) => x.id === sel.vertexId);
        if (!v) return;
        const d: Vec2 =
          e.key === "ArrowLeft"
            ? { x: -stepM, y: 0 }
            : e.key === "ArrowRight"
              ? { x: stepM, y: 0 }
              : e.key === "ArrowUp"
                ? { x: 0, y: stepM }
                : { x: 0, y: -stepM };
        state.moveVertex(sel.vertexId, { x: v.x + d.x, y: v.y + d.y }, true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftHeld.current = false;
    };
    addEventListener("keydown", onKeyDown);
    addEventListener("keyup", onKeyUp);
    return () => {
      removeEventListener("keydown", onKeyDown);
      removeEventListener("keyup", onKeyUp);
    };
  }, [drawing]);

  // --- helpers -------------------------------------------------------------
  const screenPoint = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const snapAt = useCallback(
    (sp: Vec2): SnapResult => {
      const raw = toPlan(sp, viewport, size.w, size.h);
      const p = plan;
      const origin = p.walls.length >= 2 ? chainOrigin(p) : null;
      return resolveSnap(raw, {
        origin,
        vertices: p.vertices.map((v) => ({ x: v.x, y: v.y })),
        prev: lastChainPoint(p),
        pxPerMeter: viewport.ppm,
        orthoDisabled: shiftHeld.current,
      });
    },
    [plan, viewport, size],
  );

  const geo = useMemo(() => (plan ? wallGeometry(plan) : []), [plan]);
  const loop = useMemo(() => (plan?.closed ? planLoop(plan) : null), [plan]);
  const loopIsCCW = useMemo(() => (loop ? signedArea(loop) > 0 : false), [loop]);

  const hitTest = (sp: Vec2): ReturnType<typeof useDrawing.getState>["selection"] => {
    const p = plan;
    // vertices first (16 px)
    for (const v of p.vertices) {
      const s = toScreen(v, viewport, size.w, size.h);
      if (dist(s, sp) <= 16) return { kind: "vertex", vertexId: v.id };
    }
    // openings (16 px around their center)
    for (const g of geo) {
      for (const o of g.wall.openings) {
        const center = add(g.a, scale(g.dir, o.offset + o.width / 2));
        const s = toScreen(center, viewport, size.w, size.h);
        if (dist(s, sp) <= 18) return { kind: "opening", wallId: g.wall.id, openingId: o.id };
      }
    }
    // walls (12 px from centerline)
    const pp = toPlan(sp, viewport, size.w, size.h);
    for (const g of geo) {
      const { distance } = pointSegmentClosest(pp, g.a, g.b);
      if (distance * viewport.ppm <= Math.max(12, (g.wall.thickness / 2) * viewport.ppm + 6)) {
        return { kind: "wall", wallId: g.wall.id };
      }
    }
    return null;
  };

  // --- pointer handling ----------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const sp = screenPoint(e);
    pointers.current.set(e.pointerId, sp);
    const count = pointers.current.size;
    if (count === 1) {
      tapTracker.current = { maxPointers: 1, startedAt: Date.now(), moved: false };
    } else {
      tapTracker.current.maxPointers = Math.max(tapTracker.current.maxPointers, count);
    }

    if (count === 2) {
      // Enter pan/zoom gesture; cancel any drag.
      stopEdgePan();
      const [p1, p2] = [...pointers.current.values()];
      gesture.current = {
        startMid: midpoint(p1!, p2!),
        startDist: Math.max(10, dist(p1!, p2!)),
        startViewport: viewport,
        current: viewport,
      };
      drag.current = null;
      setGesturing(true);
      setPreview(null);
      return;
    }
    if (count > 2) return;

    if (tool === "select") {
      const hit = hitTest(sp);
      drawing().select(hit);
      if (hit?.kind === "vertex") {
        drag.current = { kind: "vertex", vertexId: hit.vertexId, moved: false };
      } else if (hit?.kind === "opening") {
        drag.current = { kind: "opening", wallId: hit.wallId, openingId: hit.openingId, moved: false };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) {
      // hover (desktop, no button)
      if (tool === "wall" && e.buttons === 0 && !plan.closed) {
        const snapped = snapAt(screenPoint(e));
        setPreview(lastChainPoint(plan) ? snapped : null);
      }
      return;
    }
    const sp = screenPoint(e);
    const prev = pointers.current.get(e.pointerId)!;
    if (dist(sp, prev) > 8) tapTracker.current.moved = true;
    pointers.current.set(e.pointerId, sp);

    if (gesture.current && pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      const g = gesture.current;
      const mid = midpoint(p1!, p2!);
      const d = Math.max(10, dist(p1!, p2!));
      const ppm = clampPpm(g.startViewport.ppm * (d / g.startDist));
      const anchor = toPlan(g.startMid, g.startViewport, size.w, size.h);
      const next: Viewport = {
        ppm,
        cx: anchor.x - (mid.x - size.w / 2) / ppm,
        cy: anchor.y + (mid.y - size.h / 2) / ppm,
      };
      g.current = next;
      // Imperative transform during the gesture — no React re-render (docs/04 §2).
      geomRef.current?.setAttribute("transform", planGroupTransform(next, size.w, size.h));
      return;
    }

    if (drag.current) {
      drag.current.moved = true;
      const state = drawing();
      if (drag.current.kind === "vertex") {
        applyVertexDrag(sp, viewport);
        updateEdgePan(sp);
      } else {
        const g = geo.find((x) => x.wall.id === drag.current!.wallId);
        const o = g?.wall.openings.find((x) => x.id === drag.current!.openingId);
        if (g && o) {
          const pp = toPlan(sp, viewport, size.w, size.h);
          const { t } = pointSegmentClosest(pp, g.a, g.b);
          const offset = Math.min(Math.max(t * g.length - o.width / 2, 0), g.length - o.width);
          state.updateOpening(g.wall.id, o.id, { offset }, false);
        }
      }
      return;
    }

    if (tool === "wall" && !plan.closed) {
      setPreview(lastChainPoint(plan) ? snapAt(sp) : null);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const sp = screenPoint(e);
    const hadGesture = gesture.current;
    pointers.current.delete(e.pointerId);

    if (hadGesture) {
      if (pointers.current.size === 0) {
        const tracker = tapTracker.current;
        setViewport(hadGesture.current);
        gesture.current = null;
        setGesturing(false);
        // Two-finger tap = undo, three-finger = redo (docs/04 §3).
        if (!tracker.moved && Date.now() - tracker.startedAt < 300) {
          if (tracker.maxPointers === 2) drawing().undo();
          if (tracker.maxPointers >= 3) drawing().redo();
        }
      }
      return;
    }

    if (drag.current) {
      stopEdgePan();
      const state = drawing();
      if (drag.current.moved) {
        if (drag.current.kind === "vertex") {
          const v = state.plan.vertices.find((x) => x.id === drag.current!.vertexId);
          if (v) state.moveVertex(v.id, { x: v.x, y: v.y }, true);
        } else {
          const wall = state.plan.walls.find((w) => w.id === drag.current!.wallId);
          const o = wall?.openings.find((x) => x.id === drag.current!.openingId);
          if (wall && o) state.updateOpening(wall.id, o.id, { offset: o.offset }, true);
        }
      }
      drag.current = null;
      return;
    }

    if (tapTracker.current.moved || tapTracker.current.maxPointers > 1) return;

    const state = drawing();
    if (tool === "wall") {
      if (state.plan.closed) return;
      // double-tap ends the chain
      const now = Date.now();
      if (now - lastTap.current.at < 320 && dist(sp, lastTap.current) < 24) {
        state.endChain();
        setPreview(null);
        lastTap.current = { at: 0, x: 0, y: 0 };
        return;
      }
      lastTap.current = { at: now, x: sp.x, y: sp.y };
      const snapped = snapAt(sp);
      const result = state.addChainPoint(snapped.point);
      if (result === "added" && snapped.kind !== "none") haptic("light");
      if (result === "closed") setPreview(null);
    } else if (tool === "door" || tool === "window") {
      const pp = toPlan(sp, viewport, size.w, size.h);
      for (const g of geo) {
        const { t, distance } = pointSegmentClosest(pp, g.a, g.b);
        if (distance * viewport.ppm <= Math.max(14, (g.wall.thickness / 2) * viewport.ppm + 8)) {
          state.addOpening(g.wall.id, tool, t * g.length);
          return;
        }
      }
    } else if (tool === "measure") {
      const pp = snapAt(sp).point;
      setMeasure((m) => (!m || m.b ? { a: pp, b: null } : { a: m.a, b: pp }));
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const sp = screenPoint(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const ppm = clampPpm(viewport.ppm * factor);
    const anchor = toPlan(sp, viewport, size.w, size.h);
    setViewport({
      ppm,
      cx: anchor.x - (sp.x - size.w / 2) / ppm,
      cy: anchor.y + (sp.y - size.h / 2) / ppm,
    });
  };

  // --- render --------------------------------------------------------------
  const px = (n: number) => n / viewport.ppm; // screen px → plan m at current zoom
  const grid = useMemo(
    () => (size.w ? gridLines(viewport, size.w, size.h) : []),
    [viewport, size],
  );
  const last = plan ? lastChainPoint(plan) : null;
  const origin = plan ? chainOrigin(plan) : null;

  // Outward direction: away from the polygon interior (closed) or +normal (open).
  // For a CCW loop the interior is left of each edge ⇒ outward = -perp(dir).
  const outward = (g: WallGeo): Vec2 => (loop && loopIsCCW ? scale(g.normal, -1) : g.normal);

  /**
   * Keep a label fully on screen. A dimension that runs off the edge is the one
   * a user most wants to read — it belongs to the wall they are stretching.
   */
  const clampToView = (s: Vec2, halfW: number, halfH: number): Vec2 => ({
    x: Math.min(Math.max(s.x, halfW + 4), Math.max(halfW + 4, size.w - halfW - 4)),
    y: Math.min(Math.max(s.y, halfH + 4), Math.max(halfH + 4, size.h - halfH - 4)),
  });

  const labelPos = (g: WallGeo, offsetPx = 22): Vec2 =>
    add(midpoint(g.a, g.b), scale(outward(g), px(offsetPx) + g.wall.thickness / 2));

  /**
   * Where the wall letter goes: just past the dimension box, measured along the
   * outward direction. The box is 68×26, so the clearance needed depends on
   * whether we're exiting it sideways or vertically.
   */
  const letterPos = (g: WallGeo): Vec2 => {
    const n = outward(g);
    const clearance = 22 + (Math.abs(n.x) * 34 + Math.abs(n.y) * 13) + 12;
    return labelPos(g, clearance);
  };

  const previewLen = preview && last ? dist(last, preview.point) : null;
  const previewAngle =
    preview && last && previewLen && previewLen > 0.01
      ? ((Math.atan2(preview.point.y - last.y, preview.point.x - last.x) * 180) / Math.PI + 360) % 360
      : null;

  if (!plan) return null;

  return (
    <div
      ref={wrapRef}
      className="board-canvas-wrap"
      data-testid="board-canvas"
      style={{ cursor: tool === "wall" ? "crosshair" : "default" }}
    >
      <svg
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <g ref={geomRef} transform={planGroupTransform(viewport, size.w, size.h)}>
          {/* grid */}
          <g>
            {grid.map((l, i) => (
              <line
                key={i}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                stroke="var(--canvas-grid)"
                strokeWidth={l.major ? px(1.2) : px(0.6)}
                opacity={l.major ? 0.9 : 0.5}
              />
            ))}
          </g>

          {/* closed-room floor fill */}
          {loop && (
            <polygon
              points={loop.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="var(--accent)"
              opacity={0.07}
            />
          )}

          {/* walls */}
          {geo.map((g) => {
            const selected = selection?.kind === "wall" && selection.wallId === g.wall.id;
            return (
              <g key={g.wall.id} data-testid={`wall-${g.wall.label}`}>
                <polygon
                  points={g.quad}
                  fill={selected ? "var(--accent)" : "var(--text-dim)"}
                  opacity={selected ? 0.9 : 0.75}
                />
                {/* openings punch visual gaps + glyphs */}
                {g.wall.openings.map((o) => {
                  const s = add(g.a, scale(g.dir, o.offset));
                  const e2 = add(g.a, scale(g.dir, o.offset + o.width));
                  const t = g.wall.thickness / 2 + px(1);
                  const q = [
                    add(s, scale(g.normal, t)),
                    add(e2, scale(g.normal, t)),
                    add(e2, scale(g.normal, -t)),
                    add(s, scale(g.normal, -t)),
                  ];
                  const openingSelected =
                    selection?.kind === "opening" && selection.openingId === o.id;
                  const hinge = o.swing === "right" ? e2 : s;
                  const swingDir = o.swing === "right" ? scale(g.dir, -1) : g.dir;
                  const arcEnd = add(hinge, scale(loopIsCCW ? scale(g.normal, -1) : g.normal, o.width));
                  return (
                    <g key={o.id} data-testid={`opening-${o.kind}`}>
                      <polygon points={q.map((p) => `${p.x},${p.y}`).join(" ")} fill="var(--bg)" />
                      {o.kind === "door" ? (
                        <>
                          <line
                            x1={hinge.x}
                            y1={hinge.y}
                            x2={arcEnd.x}
                            y2={arcEnd.y}
                            stroke={openingSelected ? "var(--accent)" : "var(--text-dim)"}
                            strokeWidth={px(1.5)}
                          />
                          <path
                            d={`M ${add(hinge, scale(swingDir, o.width)).x} ${add(hinge, scale(swingDir, o.width)).y} A ${o.width} ${o.width} 0 0 ${
                              (o.swing === "right") !== loopIsCCW ? 1 : 0
                            } ${arcEnd.x} ${arcEnd.y}`}
                            fill="none"
                            stroke={openingSelected ? "var(--accent)" : "var(--text-dim)"}
                            strokeWidth={px(1)}
                            strokeDasharray={`${px(4)} ${px(3)}`}
                          />
                        </>
                      ) : (
                        <>
                          <line x1={q[0]!.x} y1={q[0]!.y} x2={q[1]!.x} y2={q[1]!.y} stroke={openingSelected ? "var(--accent)" : "var(--text-dim)"} strokeWidth={px(1.5)} />
                          <line x1={q[3]!.x} y1={q[3]!.y} x2={q[2]!.x} y2={q[2]!.y} stroke={openingSelected ? "var(--accent)" : "var(--text-dim)"} strokeWidth={px(1.5)} />
                          <line
                            x1={add(s, scale(g.dir, 0)).x}
                            y1={s.y}
                            x2={e2.x}
                            y2={e2.y}
                            stroke={openingSelected ? "var(--accent)" : "var(--text-dim)"}
                            strokeWidth={px(1)}
                          />
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* chain preview */}
          {preview && last && tool === "wall" && !plan.closed && (
            <g>
              <line
                x1={last.x}
                y1={last.y}
                x2={preview.point.x}
                y2={preview.point.y}
                stroke="var(--accent)"
                strokeWidth={px(2)}
                strokeDasharray={`${px(6)} ${px(4)}`}
              />
              {preview.guides.map((gd, i) => (
                <line
                  key={i}
                  x1={gd.axis === "v" ? gd.through.x : preview.point.x - px(400)}
                  y1={gd.axis === "v" ? gd.through.y - px(400) : gd.through.y}
                  x2={gd.axis === "v" ? gd.through.x : preview.point.x + px(400)}
                  y2={gd.axis === "v" ? gd.through.y + px(400) : gd.through.y}
                  stroke="var(--accent)"
                  strokeWidth={px(1)}
                  strokeDasharray={`${px(3)} ${px(3)}`}
                  opacity={0.6}
                />
              ))}
            </g>
          )}

          {/* vertices */}
          {plan.vertices.map((v) => {
            const isOrigin = origin && v.x === origin.x && v.y === origin.y && !plan.closed;
            const isSelected = selection?.kind === "vertex" && selection.vertexId === v.id;
            const closureHot = isOrigin && preview?.kind === "closure";
            return (
              <g key={v.id} className={closedAt ? "closure-pulse" : undefined}>
                {closureHot && (
                  <circle cx={v.x} cy={v.y} r={px(14)} fill="var(--accent)" opacity={0.25} />
                )}
                <circle
                  cx={v.x}
                  cy={v.y}
                  r={px(isSelected ? 8 : 6)}
                  fill={isSelected ? "var(--accent)" : "var(--surface-solid)"}
                  stroke={isOrigin ? "var(--accent-warm)" : "var(--accent)"}
                  strokeWidth={px(2)}
                />
              </g>
            );
          })}

          {/* measure */}
          {measure?.b && (
            <line
              x1={measure.a.x}
              y1={measure.a.y}
              x2={measure.b.x}
              y2={measure.b.y}
              stroke="var(--accent-warm)"
              strokeWidth={px(1.5)}
              strokeDasharray={`${px(5)} ${px(4)}`}
            />
          )}
          {measure && !measure.b && (
            <circle cx={measure.a.x} cy={measure.a.y} r={px(4)} fill="var(--accent-warm)" />
          )}
        </g>

        {/* screen-space overlay (hidden while gesturing) */}
        {!gesturing && size.w > 0 && (
          <g>
            {/* dimension labels — click-through while placing openings/measuring */}
            {geo.map((g) => {
              const s = clampToView(toScreen(labelPos(g), viewport, size.w, size.h), 34, 13);
              const selected = selection?.kind === "wall" && selection.wallId === g.wall.id;
              const labelsInteractive = tool === "wall" || tool === "select";
              return (
                <g key={g.wall.id} style={labelsInteractive ? undefined : { pointerEvents: "none" }}>
                  <rect
                    x={s.x - 34}
                    y={s.y - 13}
                    width={68}
                    height={26}
                    rx={7}
                    fill="var(--surface-solid)"
                    stroke={selected ? "var(--accent)" : "var(--surface-border)"}
                    style={{ cursor: "pointer" }}
                    data-testid={`dim-label-${g.wall.label}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      drawing().select({ kind: "wall", wallId: g.wall.id });
                      setEditingWallId(g.wall.id);
                    }}
                  />
                  <text
                    x={s.x}
                    y={s.y + 4.5}
                    textAnchor="middle"
                    fill="var(--text)"
                    fontSize={12.5}
                    fontFamily="var(--font-mono)"
                    style={{ pointerEvents: "none" }}
                  >
                    {formatLength(g.length, unit)}
                  </text>
                  {plan.closed &&
                    (() => {
                      const l = toScreen(letterPos(g), viewport, size.w, size.h);
                      return (
                        <text
                          x={l.x}
                          y={l.y + 4}
                          textAnchor="middle"
                          fill="var(--text-dim)"
                          fontSize={11}
                          style={{ pointerEvents: "none" }}
                        >
                          {g.wall.label}
                        </text>
                      );
                    })()}
                </g>
              );
            })}

            {/* live dimension + angle while drawing */}
            {preview && last && previewLen !== null && previewLen > 0.01 && tool === "wall" && (
              (() => {
                const s = toScreen(preview.point, viewport, size.w, size.h);
                return (
                  <g style={{ pointerEvents: "none" }}>
                    <text x={s.x + 16} y={s.y - 10} fill="var(--text)" fontSize={13} fontFamily="var(--font-mono)">
                      {formatLength(previewLen, unit)}
                    </text>
                    {previewAngle !== null && (
                      <text x={s.x + 16} y={s.y + 8} fill="var(--text-dim)" fontSize={11.5} fontFamily="var(--font-mono)">
                        {previewAngle.toFixed(1)}°
                      </text>
                    )}
                  </g>
                );
              })()
            )}

            {/* measure result */}
            {measure?.b &&
              (() => {
                const mid = midpoint(measure.a, measure.b);
                const s = toScreen(mid, viewport, size.w, size.h);
                return (
                  <text
                    x={s.x}
                    y={s.y - 8}
                    textAnchor="middle"
                    fill="var(--accent-warm)"
                    fontSize={13}
                    fontFamily="var(--font-mono)"
                    style={{ pointerEvents: "none" }}
                  >
                    {formatLength(dist(measure.a, measure.b), unit)}
                  </text>
                );
              })()}
          </g>
        )}
      </svg>

      {/* scale bar */}
      <div className="scale-bar">
        <div className="bar" style={{ width: scaleBarMeters(viewport.ppm, unit) * viewport.ppm }} />
        <span className="type-metric" style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>
          {formatLength(scaleBarMeters(viewport.ppm, unit), unit)}
        </span>
      </div>

      {editingWallId &&
        (() => {
          const g = geo.find((x) => x.wall.id === editingWallId);
          if (!g) return null;
          const s = toScreen(labelPos(g), viewport, size.w, size.h);
          return (
            <DimensionInputOverlay
              key={editingWallId}
              x={s.x}
              y={s.y}
              initial={formatLength(g.length, unit).replace(/ .*$/, unit === "m" ? "" : "")}
              onCommit={(meters) => {
                drawing().setTypedLength(editingWallId, meters);
                setEditingWallId(null);
              }}
              onCancel={() => setEditingWallId(null)}
            />
          );
        })()}
    </div>
  );
}
