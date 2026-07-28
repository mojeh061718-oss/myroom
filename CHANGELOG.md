# Changelog

All notable changes to My Room Sandbox. Milestones follow
[`docs/09-roadmap.md`](docs/09-roadmap.md); each ships tagged, with a demo
recording against its acceptance criteria.

## [0.3.0-m3] — Milestone M3: Furnish

**Ships:** the full manual editor — a genuinely useful room-design product.

### Added

**Scene document + command pattern** (`sceneStore`) — the sandbox renders purely
from the `Scene` document (docs/07 §3). Every mutation — add, move, rotate,
resize, paint, swap, duplicate, delete, restore — records an inverse, so
undo/redo covers all of them (docs/06 §6). A whole drag gesture collapses into
one undo step. State persists to IndexedDB on every command.

**Objects** — all 183 catalog categories render as parametric geometry with
paintable material slots, selection outlines, and correct support behaviour for
floor, wall, surface and ceiling items.

**Constrained editing** (`packages/geometry/objectSnap`) — drag on the floor
plane with rotation locking parallel to the nearest wall within 8°, flush
snapping within 12 cm, room-centre guides, soft collision that tints rather
than blocks, and live distance-to-wall measurements during the drag. Wall items
slide along their wall and hop corners with a haptic tick, never detaching
(docs/06 §3). New items land in clear floor space, wall-aligned.

**Paint** (docs/06 §4) — six curated palettes plus a hex field for walls, a
floor material browser, and per-slot object recolouring.

**Catalog** (docs/06 §5) — searchable by label or detection synonym ("couch" →
Sofa, "footstool" → Ottoman, "airfryer" → Air Fryer), filterable by group, with
a size-aware "fits here" filter.

**Versions** (docs/06 §6) — named snapshots with a locked "Original room" that
can never be deleted or overwritten; restoring is itself undoable.

**Accessibility** — the object list enumerates every object and is a working
selection path; keyboard arrows nudge 5 cm (25 cm with Shift), R rotates 45°,
Delete removes.

### Verified

- 124 unit tests and 22 Playwright E2E tests.
- A seven-piece furnished room renders in 1 668 triangles and 33 draw calls
  against docs/06 §8 budgets of 300 k and 150.
- E2E covers the docs/01 §10 running example end to end: furnish, paint sage
  green, undo and redo the lot, survive a reload, and restore version zero.

**CC0 catalog** — `packages/catalog/scripts/build-catalog.mjs` builds the real
asset library from Poly Haven's CC0 collection: glTF + textures bundled into
Draco-compressed GLBs, real-world size measured from the world-space bounding
box, `license` and `source` recorded per item, and anything over the 15 k
triangle budget rejected. **77 models across 36 categories** ship in this
release and render at true scale; the Draco decoder is bundled locally rather
than fetched from a CDN, so the offline guarantee (docs/03 §6) holds.
Categories without a model yet still place their parametric stand-in.

### Corrected

An earlier draft of this changelog and of DECISIONS.md §15 stated that the CC0
asset sources were unreachable from the build environment and that the catalog
could not be built. **That was wrong** — the claim was made without testing.
The sources are reachable, and the catalog is built. Both documents have been
corrected.

### Not met

- **The catalog holds 77 models, not the ~600 docs/09 M3 asks for.** Only
  Poly Haven is wired into the pipeline so far; ambientCG, Quaternius and
  Kenney are not.
- **Compare (A/B slider) and share renders/links are not implemented** — the
  version *machinery* is there (snapshot, restore, locked version zero) but not
  the side-by-side comparison or the export.
- Frame rate on the reference device matrix is still unverified (no GPU in CI).

## [0.2.0-m2] — Milestone M2: Extrude

**Ships:** drawn plans become navigable 3D rooms — the first "wow, that's my
room's shape" moment.

### Added

**Shell generation** (`packages/geometry`) — `buildShell()` turns a RoomPlan
into walls, floor and ceiling: mitered interior/exterior offset polygons so
walls meet cleanly at corners, per-wall prisms with doors and windows cut
through both faces plus their reveals, ear-clipping triangulation for concave
(L-shaped) floors, and real-world-scale UVs ready for painting in M3. Pure and
deterministic — the same plan always yields byte-identical geometry.
`pointInPolygon` added for interior tests.

**3D sandbox** (`apps/web`, S7 per docs/01 §9) — react-three-fiber renderer with
per-wall meshes (each individually materialed, so M3 can paint them), Dollhouse
and Inside camera presets with animated transitions, a live orthographic 2D
plan view, wall fade for walls standing between the camera and the room, the
1.5 s establishing orbit on first reveal, and the accessible object-list path
(docs/06 §7).

**Lighting** — "warm realistic-lite" per docs/02 §7: procedural image-based
lighting, a soft directional key aimed through the room's largest wall, contact
shadows, ACES filmic tone mapping, and a gradient exterior backdrop so openings
read as daylight rather than voids.

### Verified

- 57 unit tests (42 geometry, 7 camera-preset, 8 store) and 12 Playwright E2E
  tests across desktop and mobile.
- Performance (docs/06 §8): an empty shell renders in ~150 triangles and 8 draw
  calls against budgets of 300 k and 150; the sandbox is interactive ~0.4 s
  after navigation against a 2 s budget. Both asserted in E2E.
- Shell geometry invariants are property-tested: normals agree with winding on
  every triangle, inward normals land inside the room for concave plans and both
  drawing directions, and openings leave no surface inside the hole.

### Notes

- Frame rate on the reference device matrix (docs/06 §8) has **not** been
  measured — the CI runner has no GPU and renders through SwiftShader. Triangle
  and draw-call budgets are enforced; the 60 fps target needs real hardware.
- Golden-*image* tests (docs/06 §9) are not in place; determinism is covered by
  golden *geometry* assertions instead, which are stable across platforms.
  Pixel goldens need a fixed GPU baseline.
- Five new M2 decisions are recorded in [`DECISIONS.md`](DECISIONS.md), notably
  analytic opening cutouts in place of CSG (`three-bvh-csg` is not a dependency)
  and a viewport-aware field of view.

## [0.1.0-m1] — Milestone M1: Draw

**Ships:** an installable PWA where users draw, validate, and save accurate wall
plans.

Demo recording: [`docs/demos/m1/`](docs/demos/m1/) — the docs/04 §7 first-time
user path (draw a closed 4-wall room → correct a wall to an exact typed length →
add a door and a window → proceed), recorded at phone size.

### Added

**Monorepo** (docs/03 §2) — `apps/web`, `apps/api`, `packages/schema`,
`packages/geometry`, `packages/catalog`, `workers/vision`; pnpm workspaces,
TypeScript strict end to end, docker-compose dev services (PostgreSQL, Valkey,
MinIO).

**`packages/geometry`** — vector/polygon math, simple-polygon validation,
wall re-solve, wall labeling (A, B, C… clockwise from northernmost), unit
parsing and formatting (`3.76`, `376cm`, `12'4"`, `12ft 4in`), and the snap
resolver with the docs/04 §4 priority stack. Property-based tests (fast-check)
cover closure, simplicity, dimension re-solve, unit round-trips, and
screen-space snapping at every zoom level.

**`packages/schema`** — zod schemas for RoomPlan, Scene, PlacedObject,
CatalogItem, ObjectCategory, Project, Version, Upload, with the docs/07
invariants enforced (opening fits its wall, openings don't overlap, closed plans
are simple polygons, cached floor area agrees with geometry, exactly one of
`catalogId`/`placeholder`). Generates JSON Schema for the Python workers; CI
fails if the generated files are stale. Migration registry per docs/07 §8.

**`packages/catalog`** — the object taxonomy: 183 categories across 16 groups,
each with support type, real-world default size in meters, material slots, face
slot, collision exemption, and open-vocabulary detection prompts with synonyms.
Feeds the M4 detection vocabulary (docs/05 §3), the parametric-placeholder
fallback (docs/05 §6), and the M3 catalog browser (docs/06 §5).

**`apps/web`** — installable PWA (Workbox service worker, maskable icons, iOS
meta), design tokens per docs/02, splash, skippable tutorial (T1 animated,
T2–T5 placeholders per docs/09 M1), Projects Home with rename/duplicate/delete,
and the **full drawing board**: pan/zoom SVG canvas with fading grid and scale
bar; Wall/Select/Door/Window/Measure tools; the complete snapping stack; typed
dimensions in metric or imperial; units toggle; live dimension and angle
readouts; validation badge with floor area; wall-height sheet; command-pattern
undo/redo over every mutation; write-through IndexedDB persistence.

**`apps/api`** — Fastify `/v1`: magic-link auth issuing httpOnly JWT sessions,
project CRUD, and `PUT /plan` validated by `packages/schema` with wall labels
and floor area recomputed server-side. RFC 9457 `problem+json` errors. Routes
depend on a `Store` interface; M1 ships the in-memory implementation.

**CI** — typecheck, unit tests, generated-schema freshness, PWA build,
Playwright golden path (desktop + mobile), and the docs/08 §7 license gate with
its own unit tests proving it rejects AGPL, GPL, SSPL, CC-BY and CC-BY-NC.

**Staging deploy** — `.github/workflows/deploy-staging.yml` publishes the PWA to
GitHub Pages on pushes to `main` and on `v*` tags. The build is subpath-aware
(`PUBLIC_BASE_PATH`), with an SPA fallback so deep links survive a reload.
Requires a one-time repository setting: **Settings → Pages → Source: GitHub
Actions**. The staging URL is then `https://<owner>.github.io/<repo>/`.

### Notes

- Judgment calls where the specification was silent are recorded in
  [`DECISIONS.md`](DECISIONS.md) — most notably a fourth `support` value,
  `ceiling`, without which the blueprint's own vocabulary (pendant lights) and
  ceiling fans have no legal anchor.
- The docs/09 M1 acceptance item "drawing a room takes < 90 s for a first-timer
  (hallway-test 5 users)" is a moderated usability test and has **not** been
  run; it needs five human participants.
- Storybook (docs/02 §8) is not yet set up; the component inventory is built and
  used by the M1 screens, but has no isolated workshop yet.
