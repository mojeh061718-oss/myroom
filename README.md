# My Room Sandbox

*Your room. Reimagined.*

**My Room Sandbox** is a premium, iOS-feeling progressive web app that turns a hand-drawn wall outline, a handful of photos, and (optionally) a LiDAR scan into a perfectly scaled, fully **editable** 3D sandbox of a real room. Move the couch across the room, paint the walls sage green, rehang the gallery wall — and see every idea visualized at true scale before touching a single real object.

## Status: M1–M3 complete, M4–M6 partial, pipeline at 2.0

The installable PWA, the drawing board, 3D extrusion, the full manual editor,
guided photo capture, scan upload, the reconstruction pipeline, and the M6
polish pass are built. **The one thing this repository cannot do is
listed in [`CHANGELOG.md`](CHANGELOG.md): the golden-room accuracy fixtures,
which are tape-measure measurements of real rooms.** Every accuracy target in
docs/05 §9 is therefore unverified, and the app says so where it matters.

The vision stages no longer require a GPU. They pick a backend per device —
CUDA, Apple Metal, Intel XPU, or CPU on the server; WebGPU, wasm, or the service
on the client — and there is no device the pipeline refuses to run on. See
[docs/05 §1a](docs/05-reconstruction-pipeline.md) and the 2.0 entry in the
changelog.

```bash
pnpm install
pnpm dev:web       # the app at http://localhost:5173
pnpm dev:api       # API at http://localhost:8787
pnpm test          # unit tests across every package
pnpm test:e2e      # Playwright: golden path, reconstruct path, accessibility
pnpm test:golden   # golden-room accuracy suite (no fixtures yet — says so)
pnpm lint:licenses

cd workers/vision && pip install -e ".[dev]" && python -m pytest -q
```

**Repository layout** (docs/03 §2):

| Path | Contains |
|---|---|
| `apps/web` | The PWA: splash, tutorial, home, drawing board, capture, scan upload, processing, 3D sandbox |
| `apps/api` | Fastify API: auth, projects, uploads, the reconstruct orchestrator, SSE progress, scenes, versions, sharing |
| `packages/schema` | zod schemas + generated JSON Schema — the single source of truth for every data shape |
| `packages/geometry` | Wall/polygon/unit math, shell extrusion, object snapping |
| `packages/catalog` | Object taxonomy (187 categories) and the CC0 asset pipeline |
| `packages/recon` | Catalog matching, scene assembly, scan parsing and refinement, golden-room scoring |
| `workers/vision` | Python pipeline stages: scan parse, camera/depth solve, measurement, appearance, device selection |
| `workers/diffusion` | Restyle renders (docs/06 §6) and the model-weight licence gate — opt-in, never bundled |
| `fixtures/golden-rooms` | Where the accuracy fixtures go, and why they can't be generated |

Judgment calls made where the specification was silent are recorded in
[`DECISIONS.md`](DECISIONS.md).

## Start here

📘 **[BLUEPRINT.md](BLUEPRINT.md)** — the master document: vision, the core architectural principle, locked technology decisions, and the reading order.

## The specification set

The blueprint is normative — it is built as written, not reinterpreted.

| Doc | Covers |
|---|---|
| [01 · Product & Flows](docs/01-product-and-flows.md) | Every screen and state: splash → skippable tutorial → wall drawing → guided photos → optional LiDAR → processing → 3D sandbox → edit mode → versions & sharing |
| [02 · Design System](docs/02-design-system.md) | The premium iOS visual language: type, color, glass surfaces, motion, haptics, components, accessibility |
| [03 · Architecture](docs/03-architecture.md) | PWA client, Node API, Python vision workers, job queue, offline-first sync, privacy |
| [04 · Drawing Board](docs/04-drawing-board-spec.md) | The 2D wall editor: CAD-grade snapping, typed dimensions, doors/windows, validation |
| [05 · Reconstruction Pipeline](docs/05-reconstruction-pipeline.md) | Photos & LiDAR → discrete editable objects: detection, metric scale solving, catalog matching, appearance, fallbacks, accuracy tiers |
| [06 · Sandbox & Editing](docs/06-sandbox-and-editing.md) | The 3D scene: navigation, constrained drag, painting, materials, undo/versions/compare/share, performance budgets |
| [07 · Data Model](docs/07-data-model.md) | JSON schemas for every entity; accepted upload formats; storage & migrations |
| [08 · Open-Source Stack](docs/08-open-source-stack.md) | Every library and CC0 asset source, with licenses and a CI license gate |
| [09 · Roadmap](docs/09-roadmap.md) | Six milestones — each one shippable — with acceptance criteria |

## The one principle

> **The room is rebuilt from discrete objects, never delivered as a fused scan.**

Scans and photogrammetry produce welded meshes you can look at but not edit. My Room Sandbox instead *recognizes* what's in the room and *rebuilds* it from clean, movable 3D pieces — because editing your room is the whole point.

## Tech at a glance

TypeScript · React + Vite PWA · three.js (react-three-fiber) · Node/Fastify + BullMQ · Python vision workers (Grounding DINO, SAM 2, Depth Anything V2, Open3D) · Apple RoomPlan & point-cloud LiDAR ingestion · CC0 asset catalog (Poly Haven, ambientCG, Quaternius, Kenney)
