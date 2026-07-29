# 04 · Drawing Board Specification (2D Wall Editor)

The drawing board is where every project starts: the user draws **only the walls**, and everything downstream (photo guidance, reconstruction anchoring, 3D shell) hangs off this plan. It must feel effortless for a first-timer yet behave with real CAD discipline underneath.

**Open-source references (study before building):** `cvdlab/react-planner` (MIT) for tool/state architecture, `furnishup/blueprint3d` (MIT) for the wall→3D pipeline, and Sweet Home 3D (GPL — *reference for UX conventions only, no code reuse*) for snapping/dimension ergonomics. Conventions below follow these established patterns deliberately.

---

## 1. Model (what a drawing *is*)

The board edits a `RoomPlan` document ([`07-data-model.md`](07-data-model.md) §2):

- **Vertices** — 2D points in meters, plan coordinate system (origin = first drawn point, +X east, +Y north).
- **Walls** — straight segments between two vertices, with `thickness` (default 0.115 m interior) and `height` (project-level default, per-wall override).
- **Openings** — doors/windows attached to a wall at `offset` (m from wall start) + `width` + `sillHeight`/`headHeight`.
- The room is valid when walls form **one closed, simple (non-self-intersecting) polygon**. v1 scope: one room per project, straight walls only (curved walls and multi-room are explicit non-goals for v1; the schema reserves fields for both).

All geometry code lives in `packages/geometry` — shared verbatim with the 3D extruder and the reconstruction anchoring step. **The plan is the single source of truth for scale.**

## 2. Canvas & rendering

- SVG scene graph (walls, labels, grid as layers) inside a pan/zoom viewport; pointer-events unified for touch/mouse/stylus.
- **Grid:** 0.1 m minor / 1 m major lines (`canvas-grid` token), fading by zoom level. Scale bar pinned bottom-left; zoom range 1:200 → 1:10.
- Walls render as double-line segments with thickness fill; selected wall gets accent stroke + endpoint handles; vertices render as draggable dots at ≥ 44 px touch size regardless of zoom.
- 60 fps pan/zoom on mid-range phones: throttle re-render to `requestAnimationFrame`, memoize per-wall paths, no React re-render during gesture (imperative transform on the viewport group).

## 3. Tools

| Tool | Behavior |
|---|---|
| **Wall** (default) | Tap-tap or drag to place segments; each new wall chains from the last endpoint. Live dimension label follows the cursor. Double-tap / Esc ends the chain. |
| **Select** | Tap wall/vertex/opening → selection + context pill (dimension field, delete, split wall, thickness). Drag vertices to reshape; walls move with connected-endpoint integrity (no tearing). |
| **Door / Window** | Tap a wall → opening placed at tap point, drag to slide along the wall, handles to resize width. Doors get swing-direction toggle (rendered as the conventional quarter-arc). Defaults: door 0.82 × 2.03 m; window 1.2 m wide, sill 0.9 m, head 2.1 m. |
| **Measure** | Tap two points → temporary dimension line (mono `metric` style). Not persisted. |
| **Undo / Redo** | Command stack; every mutation is a command. Two-finger-tap = undo (iOS convention), three-finger = redo. |

## 4. Snapping & input discipline (the CAD core)

Priority order when multiple snaps compete (highest wins):

1. **Closure snap** — pointer within 0.25 m (screen-adjusted) of the chain's origin vertex → snap and close the room. Haptic tick + pulse animation.
2. **Endpoint/vertex snap** — existing vertices, radius 12 px screen-space.
3. **Ortho snap** — angles lock to 0°/45°/90° when within 4°; hold a modifier (two-finger rest on touch, Shift on desktop) to disable.
4. **Alignment guides** — dashed guide when an endpoint aligns horizontally/vertically with any existing vertex (± 6 px).
5. **Grid snap** — 0.05 m increments, only when zoomed in past 1:50.

Additional discipline:

- **Typed dimensions beat drawn ones.** Tapping any dimension label opens a numeric field; input parses `3.76`, `3.76m`, `376cm`, `12'4"`, `12ft 4in`. The wall re-solves keeping the *other* endpoint fixed (or the shared vertex, if mid-chain).
- **Unit system:** meters internally, always; display toggle m ↔ ft/in in the top bar (persisted per user). Rounding: display cm to 1 decimal, inches to nearest ¼".
- Angle readout appears near the cursor while drawing (`90.0°`), matching dimension-label styling.
- Minimum wall length 0.3 m (shorter attempts snap to neighbors or are rejected with a shake).

## 5. Validation & the path forward

- Live validation badge: *Open* (n walls) → *Closed ✓* with computed floor area ("29.8 m² / 321 ft²").
- Self-intersection is prevented at input time (candidate wall segment is intersection-tested before commit; offending placement shakes + shows the conflict).
- **"Next: add photos →"** enables only on a closed, valid plan. On proceed: the wall-height sheet (default 2.44 m / 8 ft; presets 2.4 / 2.7 / 3.0 m; custom field), then walls are auto-labeled **A, B, C…** clockwise from the northernmost wall — these labels drive the guided photo capture and appear in the mini-plan everywhere downstream.

## 6. Why this must be solid: the plan's downstream jobs

1. **Scale anchor.** Reconstruction solves camera poses and object sizes *against these wall dimensions* ([`05-reconstruction-pipeline.md`](05-reconstruction-pipeline.md) §4). A sloppy editor that lets users draw un-editable or ambiguous plans poisons everything downstream.
2. **Capture director.** Wall labels + lengths generate the guided photo shot list.
3. **3D shell.** The polygon extrudes directly into the sandbox room shell with openings punched through ([`06-sandbox-and-editing.md`](06-sandbox-and-editing.md) §2).
4. **LiDAR registration target.** Scan geometry is registered (2D ICP) against this polygon; the user's drawing is corrected, not discarded, when a scan is present.

## 7. Acceptance criteria

- A first-time user can draw a closed 4-wall room, correct one wall to an exact typed length, add a door and a window, and proceed — in under 90 seconds, touch-only, no tutorial.
- Property-based tests in `packages/geometry`: polygon closure, simple-polygon validation, dimension re-solve (typed length preserves the correct fixed endpoint), unit parsing round-trips.
- Ortho + endpoint + closure snapping all function at every zoom level; snapping radii are screen-space (constant finger effort regardless of zoom).
- Plan survives full serialize → deserialize → re-render identically (golden-file tests on sample plans: rectangle, L-shape, 6-wall irregular).
- Undo/redo covers every mutation including opening placement and typed-dimension edits.
