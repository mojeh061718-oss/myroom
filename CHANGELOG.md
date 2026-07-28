# Changelog

All notable changes to My Room Sandbox. Milestones follow
[`docs/09-roadmap.md`](docs/09-roadmap.md); each ships tagged, with a demo
recording against its acceptance criteria.

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

### Notes

- Judgment calls where the specification was silent are recorded in
  [`DECISIONS.md`](DECISIONS.md) — most notably a fourth `support` value,
  `ceiling`, without which the blueprint's own vocabulary (pendant lights) and
  ceiling fans have no legal anchor.
- The docs/09 M1 acceptance item "drawing a room takes < 90 s for a first-timer
  (hallway-test 5 users)" is a moderated usability test and has **not** been
  run; it needs five human participants.
