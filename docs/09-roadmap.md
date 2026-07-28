# 09 · Roadmap & Milestones

Six milestones, sequenced so that **every milestone ends with a shippable, demonstrably useful product**. The riskiest work (the vision pipeline) lands on a foundation that already delights users as a manual room planner — if M4 slips, M1–M3 is still a real product.

Estimates assume a team of 4–5 (2 frontend/3D, 1 backend, 1 ML, 1 design-engineer). Adjust proportionally; keep the *order*.

---

## M1 — Draw (weeks 1–4)

**Ships:** installable PWA where users draw, validate, and save accurate wall plans.

- Monorepo, CI, design tokens + core components in Storybook ([`02-design-system.md`](02-design-system.md))
- Splash, tutorial shell (T1 content only; T2–T5 placeholders), Projects Home
- Full drawing board per [`04-drawing-board-spec.md`](04-drawing-board-spec.md): walls, openings, snapping, typed dimensions, units toggle, undo/redo, validation
- Local persistence (IndexedDB) + auth + project CRUD API

**Acceptance:** doc 04 §7 criteria pass; PWA installs on iOS/Android; drawing a room takes < 90 s for a first-timer (hallway-test 5 users).

## M2 — Extrude (weeks 5–7)

**Ships:** drawn plans become navigable 3D rooms. The first "wow" moment.

- `packages/geometry` shell extrusion + opening CSG; sandbox viewer with dollhouse/inside cameras, wall fade, 2D/3D toggle
- "Warm realistic-lite" lighting rig (HDRI + key + contact shadows + ACES)
- Wall-height sheet; scene loads from plan deterministically

**Acceptance:** any valid plan renders a correct, beautiful shell in < 2 s; 60 fps on reference devices (empty room); golden-image tests green.

## M3 — Furnish (weeks 8–13)

**Ships:** the full manual editor — already a genuinely useful room-design product.

- Launch catalog v1 (~600 CC0 items through the asset pipeline: ≤ 15 k tris, Draco+KTX2, manifest per doc 07 §5)
- Edit mode complete per [`06-sandbox-and-editing.md`](06-sandbox-and-editing.md): constrained drag (floor/wall/surface), snapping, live measurements, paint (walls/floor/objects, eyedropper), catalog browse + "fits here", duplicate/delete/swap
- Undo/redo command stack persisted; versions + compare + share renders/links
- Offline editing; scene sync with ETag; accessibility object-list path

**Acceptance:** doc 06 §9 criteria pass end-to-end (minus reconstruction: the "original room" is hand-furnished); performance budget (doc 06 §8) met on the device matrix.

## M4 — Reconstruct (weeks 14–21) · *the headline*

**Ships:** photos → furnished room, automatically.

- Guided capture + upload flow (doc 01 §6), presigned uploads, quality checks
- Worker tier + queue plumbing (doc 03 §4) with SSE-driven Processing screen
- Pipeline stages 1–6 per [`05-reconstruction-pipeline.md`](05-reconstruction-pipeline.md): detect/segment, camera-scale solve, measurement, catalog match, appearance, assembly — **including every fallback in doc 05 §8**
- **Golden-room regression suite built first** (doc 05 §9) — 5 measured fixture rooms; suite gates all pipeline merges
- "Wrong item?" swap sheet fed by stored runners-up; lowConfidence styling

**Acceptance:** photo-calibrated tier hits doc 05 §9 targets on the golden rooms (positions ± 15 cm, sizes ± 10%, detection recall ≥ 85% on major furniture); zero dead-end failures across the fault-injection matrix (bad photos, no detections, worker timeouts); end-to-end draw→photos→room in < 3 min wall-clock for a typical living room.

## M5 — LiDAR (weeks 22–25)

**Ships:** the optional scan upload that upgrades accuracy.

- LiDAR upload form + format validation + parsed-preview overlay (doc 01 §7)
- Stage 0 parsers: RoomPlan JSON/USDZ first, then PLY/GLB, then E57/LAS (doc 05 §2); plan refinement with disagreement prompts; seed-box fusion in measurement
- Accuracy badge tiers wired end-to-end

**Acceptance:** LiDAR-verified tier hits doc 05 §9 targets on golden rooms with scans (shell ± 2 cm, objects ± 5 cm/5%); a RoomPlan export from a stock iPhone Pro round-trips to a correct room with zero manual fixes.

## M6 — Polish & Premium (weeks 26–30)

**Ships:** the finish that makes it feel like a flagship iOS app.

- Tutorial T2–T5 final animations (rendered with the real engine); splash room-loop video
- Motion/haptics full pass per doc 02 §5; empty states, error states, edge-case copy
- 2× share renders with screenshot extras; compare slider polish; Web Push "room ready"
- Performance hardening: auto quality stepping tuning, load-time budget enforcement, low-end device lab pass
- Accessibility audit (doc 02 §9 ship-blockers), localization scaffold (strings externalized; en launch)
- Privacy: deletion purge audit, plain-language policy surfaces

**Acceptance:** Lighthouse PWA ≥ 95 / Performance ≥ 85 on mid-range hardware; full a11y checklist green; the doc-01 couple scenario filmed as a 60-second demo with zero cuts and zero workarounds — this video is the definition of done.

---

## Cross-milestone rules

1. **The golden path stays green.** From M2 onward, the Playwright E2E (draw → build → edit) runs on every merge; breaking it blocks merge.
2. **Budgets are tests.** Performance (doc 06 §8), asset (doc 07 §5), and accuracy (doc 05 §9) budgets are CI checks, not aspirations.
3. **License gate from day one** (doc 08 §7).
4. **No milestone ships silently.** Each ends with a tagged release, a changelog, and a demo recording against the acceptance criteria.

## Post-v1 candidates (explicitly deferred)

Multi-room / whole-home projects · curved walls · real-product shopping integration (the `commerce` extension point, doc 07) · real-time collaboration · AR view-in-room (WebXR) · on-device reconstruction (WebGPU) · scan-quality photogrammetry tier (COLMAP + gsplat, doc 08 §3).
