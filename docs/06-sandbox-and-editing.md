# 06 · 3D Sandbox & Editing

The sandbox is where users live: viewing their reconstructed room and redesigning it. Everything here renders from the `Scene` document ([`07-data-model.md`](07-data-model.md)) — the renderer holds no state of its own, so undo/redo, versions, sync, and sharing all come free from document-level operations.

Stack: three.js via `@react-three/fiber`, helpers from `@react-three/drei`, raycast acceleration via `three-mesh-bvh`. Visual style ("warm realistic-lite") is defined in [`02-design-system.md`](02-design-system.md) §7.

---

## 1. Scene graph

```
<Room>
 ├─ <Shell>            walls (extruded plan polygon, openings punched via CSG at build time),
 │                     floor, ceiling — each wall an individually-materialed mesh
 ├─ <Objects>          one <PlacedObject> per scene entry: catalog GLB instance,
 │                     per-instance albedo overrides / photo-crop face textures
 ├─ <Lighting>         HDRI environment + window-aligned directional key + ContactShadows
 └─ <Helpers>          selection outline, drag ghost, snap guides, measurement overlays
```

- Shell generation is deterministic from `RoomPlan` (shared `packages/geometry`): polygon → extrude walls at thickness/height → boolean-subtract openings → UV-unwrap walls for painting. Rebuilt whenever the plan changes; cached as geometry otherwise.
- Catalog GLBs load via drei's `useGLTF` (Draco+KTX2), instanced when duplicated, LRU-cached by the service worker for offline.

## 2. Viewing (S7 behavior)

- **Camera presets:** *Dollhouse* (orbit target = room center, ceiling hidden, gentle pitch limit 10°–85°) and *Inside* (orbit from a standing-height point, ceiling visible). Smooth animated transitions between presets; pinch zoom clamps to sane bounds in both.
- **Wall fade:** in dollhouse view, walls between camera and room center fade to 15% opacity (per-frame dot-product test) so the interior is never occluded.
- **Selection:** tap → raycast (BVH) → accent outline (postprocess outline pass) + `ObjectInfoCard`. Double-tap → focus-frame (camera eases to frame the object). Tap empty space deselects.
- **2D toggle:** orthographic top-down of the same scene — this *is* the plan view, live-synced, and objects remain selectable/draggable in it (power users rearrange faster in 2D).

## 3. Edit mode — moving things

Entering Edit (one tap) keeps the same camera but reveals the manipulation UI. All manipulation is **constraint-based, not free-floating** — this is what makes editing feel effortless instead of fiddly:

| Object support type | Drag behavior |
|---|---|
| `floor` (sofa, table, rug…) | Slides on the floor plane. Rotation handle (45° detents + free). Snaps: parallel-to-nearest-wall (within 8°), flush-against-wall (within 12 cm), aligned-with-neighbor edges, room-center guides. |
| `wall` (frames, shelves, TV…) | Slides **along its wall**; dragging past a corner hops to the adjacent wall with a haptic tick. Vertical drag adjusts height (center-height label shown, e.g. "1.45 m"). Never detaches into space. |
| `surface` (lamp on table, décor…) | Slides on its supporting surface; dragging off the edge transfers to floor with a drop animation. |

- **Collision:** soft — overlapping footprints tint the ghost amber and show the overlap outline; drop is allowed (real rooms have overlaps like rugs under sofas; rugs and wall items are collision-exempt by category flag).
- **Live measurements during drag:** distances to the two nearest walls render as dimension lines (mono `metric` style) — the feature that answers "will the sofa fit *there*?"
- Duplicate / delete / swap on every selection. Deleting is undoable like everything else.

## 4. Edit mode — paint & materials

- **Walls:** tap wall → `ColorSheet`: curated designer palettes (24 sets), full HSL wheel, hex field, and the **photo eyedropper** (pick a color from any uploaded photo — "match the cushions"). Apply to this wall / all walls. Optional finish: matte / eggshell / satin (roughness presets).
- **Floor:** material browser from the CC0 library (woods, tiles, carpets, stone — ambientCG/Poly Haven sets, pre-tiled at real-world scale so planks read correctly at room size).
- **Objects:** each catalog model exposes named material slots ("upholstery", "frame", "legs"); the recolor sheet lists them with the same color tools. Photo-face objects (art/TV/mirror) offer "replace image" from the photo library.
- Ceiling color + baseboard color are single project-level settings (kept simple deliberately).

## 5. Catalog & adding objects

- Bottom-sheet `CatalogGrid` (virtualized): categories, text search, and a **"fits here"** filter — after tapping a target spot, filter to items whose footprint fits the surrounding clearance.
- Every item shows real dimensions; placement drops it at the tapped spot already snapped and wall-aligned.
- Catalog manifest + assets ship via CDN and cache fully for offline browsing ([`03-architecture.md`](03-architecture.md) §2, §6).

## 6. Undo/redo, versions, compare, share

- **Command pattern:** every mutation (move, rotate, paint, swap, add, delete, plan edit) is a serializable command with an inverse. Session stack unlimited; stack persists with the project so undo survives reload.
- **Versions** = named full-document snapshots. Version zero, **"Original room"**, is created automatically at first reconstruction and is read-only forever. Switching versions is instant (documents are small; assets shared).
- **Compare:** render two versions from an identical camera into two targets → side-by-side or slider composite.
- **Share render:** offscreen render at 2× resolution with screenshot-only extras (depth-of-field, higher shadow samples) → JPEG/PNG export. **Share link:** read-only token URL opening the viewer (S7 without Edit) — no account needed to view.

## 7. Accessibility in 3D

The parallel non-pointer path (ship-blocking, per doc 02 §9): an accessible object list drawer enumerating every object with position summary ("Sofa — against wall B, 2.2 m wide") and action buttons (move by increments, rotate, edit color, remove). Keyboard: tab-cycle objects, arrows nudge 5 cm (Shift = 25 cm), R rotates 45°, Enter opens info card.

## 8. Performance budget (ship-blocking)

| Metric | Target |
|---|---|
| Frame rate | 60 fps iPhone 12-class / Pixel 6-class; ≥ 30 fps floor on 2 GB Android |
| Scene budget | ≤ 300 k triangles typical furnished room; catalog models ≤ 15 k tris each (enforced in the catalog asset pipeline) |
| Texture memory | ≤ 256 MB GPU; all textures KTX2/Basis, walls share one atlas |
| Draw calls | ≤ 150 (instancing for duplicates; merged static shell) |
| Load (cached) | Scene interactive < 2 s from tap on project card |

**Auto quality stepping:** monitor rolling FPS; below threshold step down pixel ratio → shadow map size → AO off → environment resolution, in that order (and back up when headroom returns). Manual override in settings ("Battery saver" / "Best quality").

## 9. Acceptance criteria

- The doc-01 §10 running example is executable end-to-end: move sofa across the room with wall-snap, repaint one wall sage green via palette, move a frame from wall B to wall C (corner-hop), create and A/B-compare two versions — all touch-only, all undoable, all persisted across an app kill.
- Renderer is a pure function of the Scene document: loading any version byte-identical document produces an identical render (golden-image tests on fixture scenes, per-platform tolerance).
- Full editing session works offline after first scene load.
- Performance budget met on the reference device matrix (iPhone 12, Pixel 6, 2 GB Android low-end, mid-range iPad, desktop Chrome/Safari).
