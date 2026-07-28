# Implementation Decisions

Decisions made where [`BLUEPRINT.md`](BLUEPRINT.md) and [`docs/`](docs/) left a
detail genuinely unspecified. Per the build instructions, each is the *smallest*
choice consistent with the blueprint's principles, and each is recorded here for
review. Nothing in this file reopens a locked decision (BLUEPRINT §3).

Format: **what was unspecified → what we chose → why → what would change it.**

---

## M1 — Draw

### 1. Ceiling support type for mounted objects

**Unspecified.** `PlacedObject.support` is `floor | wall | surface` (docs/07 §4),
but the blueprint's own detection vocabulary includes **pendant** lights
(docs/05 §3).
A pendant is not on the floor, not on a wall, and not on another object's
surface — it has no legal anchor. Users also need ceiling fans, chandeliers and
hanging plants.

**Chosen.** Added `"ceiling"` as a fourth `support` value in `packages/schema`,
with the invariant that a ceiling object has no `parentObjectId`. Ceiling items
carry a `mountHeight` (meters from floor to object center) quoted against the
default 2.44 m ceiling and re-anchored to the room's real ceiling on placement.

**Why.** The alternative — forcing pendants to be `wall` items with a fake
`wallId` — would corrupt the wall-drag behavior in docs/06 §3 (wall items slide
*along their wall* and corner-hop) and misplace them in the accessible object
list. A fourth support type is smaller than distorting an existing one, and it
keeps every such object individually selectable and editable (BLUEPRINT §2).

**Would change it.** If M3 drag behavior shows ceiling items are better modeled
as `surface` children of a synthetic ceiling object.

### 2. Object taxonomy is data, shared by three consumers

**Unspecified.** docs/05 §3 sizes the detection vocabulary ("~120 classes") and
lists examples; docs/06 §5 needs catalog categories; docs/05 §6 needs a
parametric placeholder per category. No single list is given.

**Chosen.** One taxonomy in `packages/catalog/src/taxonomy.ts` (183 categories,
grouped for the catalog browser), typed by `ObjectCategory` in
`packages/schema`. Each entry carries support type, typical real-world size in
meters, material slots, face slot, collision exemption, and detection prompts
(including synonyms: "couch" → `sofa`, "footstool" → `ottoman`, "cupboard" →
`cabinet`).

**Why.** Rule 4 of the build brief: data shapes come from `packages/schema`.
Deriving the detection vocabulary, the placeholder table, and the catalog tree
from one list keeps them from drifting — a detected class that has no category
would otherwise silently violate "never omit a detected object" (docs/05 §6).

**Would change it.** M4 may prompt Grounding DINO with a high-value subset for
latency; that becomes a flag on the category, not a second list.

### 3. Default support for TVs

**Unspecified.** docs/06 §3 groups TVs with wall items ("frames, shelves,
TVs"), but plenty of TVs stand on a console.

**Chosen.** `tv` defaults to `wall` support with a photo-face slot; a
`media-console` category exists to stand one on. Reconstruction overrides this
per detected object anyway (docs/05 §5 measures support from geometry).

**Why.** It matches the one place the blueprint states a preference, and the
docs/06 §3 `surface` → `floor` transfer already lets users move it.

### 4. Plan persistence is write-through, not debounced

**Unspecified.** docs/03 §6 says IndexedDB is write-primary and docs/01 §12 says
"kill the app at any moment; reopen exactly where you were," without naming a
write cadence.

**Chosen.** Every command writes to IndexedDB immediately. Drag *previews* do
not persist; only the committed command does.

**Why.** A debounce window is precisely the interval in which a killed app loses
work. Plan documents are a few KB, so there is no cost worth the risk.

### 5. Wall labels are recomputed server-side

**Unspecified.** docs/04 §5 says walls are auto-labeled A, B, C… clockwise from
the northernmost wall; it does not say who owns the labels once a plan is sent
to the API.

**Chosen.** `PUT /v1/projects/:id/plan` recomputes labels and floor area from
the geometry (`labelWallsForPlan` in `packages/schema`) rather than trusting the
submitted values.

**Why.** Labels drive the guided-capture shot list (docs/04 §6.2) and every
downstream mini-plan. A stale or hand-edited client would otherwise
desynchronize the labels from the geometry, mis-tagging photos and poisoning the
scale anchor.

### 6. Store interface ahead of PostgreSQL

**Unspecified.** docs/08 §2 locks Drizzle + PostgreSQL; docs/09 M1 asks only for
"auth + project CRUD API" in weeks 1–4.

**Chosen.** Routes depend on a `Store` interface; M1 ships the in-memory
implementation, so contract tests and the golden path run with no services. The
Drizzle/PostgreSQL implementation lands with the hosted deployment and touches
no route code.

**Why.** docs/03 §8 makes "full local pipeline runs on a laptop"
non-negotiable. This is the same principle applied one milestone earlier.

**Would change it.** Nothing — this is a scheduling decision, not a technology
one. PostgreSQL remains the locked choice.

### 7. Auth: magic link first, passkeys alongside

**Unspecified.** docs/03 §3 names passkeys primary with email magic-link
fallback, but does not sequence them.

**Chosen.** M1 implements the magic-link flow and the shared session cookie
(httpOnly JWT via `jose`). Passkeys (`@simplewebauthn/server`, docs/08 §2) mint
the *same* cookie and land before the hosted launch.

**Why.** Both factors terminate at one session representation, so adding
passkeys changes no route code. Shipping the fallback first keeps M1's
acceptance criteria testable without a WebAuthn-capable test rig.

### 8. Board interaction details not covered by docs/04

**Unspecified.** A few concrete interaction bindings.

**Chosen.**
- Zoom range 1:200–1:10 (docs/04 §2) is implemented as 19–378 CSS px/m, the
  equivalent at 96 dpi.
- Grid minor lines (0.1 m) appear at ≥ 55 px/m; grid *snap* (0.05 m) engages at
  ≥ 75 px/m, the 1:50 threshold docs/04 §4.5 specifies.
- Dimension labels are click-through while the Door/Window/Measure tools are
  active, so a label never blocks placing an opening on the wall beneath it.
- Deleting a wall from a closed room reopens it into a single editable chain
  rather than leaving a broken loop.

**Why.** Each is the minimum needed to make a documented behavior actually
reachable by touch.

---

## Deferred to their own milestones

These are **not** decisions — they are blueprint items whose milestone has not
started. Recorded so their absence is not mistaken for an omission.

| Item | Lands in |
|---|---|
| 3D shell extrusion, opening CSG, sandbox viewer | M2 (docs/09) |
| CC0 catalog assets, edit mode, versions/compare/share | M3 |
| Photo capture, upload pipeline, vision workers, golden-room fixtures | M4 |
| LiDAR ingestion and accuracy-tier wiring | M5 |
| Tutorial T2–T5 final animations, splash room-loop video, a11y audit | M6 |

`workers/vision/` and the catalog *asset* pipeline are scaffolded but empty for
this reason; the taxonomy above is the part M4 and M3 will build against.
