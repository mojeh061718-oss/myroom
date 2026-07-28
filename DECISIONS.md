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

## M2 — Extrude

### 9. Analytic opening cutouts instead of CSG

**Unspecified.** docs/06 §1 says openings are "boolean-subtract[ed]" and
docs/08 §1 lists `three-bvh-csg` for that job. Neither says the subtraction must
be a general mesh boolean.

**Chosen.** Wall faces are triangulated directly by grid decomposition: collect
the opening edges along the wall and up its height, emit the cells that aren't
inside an opening, then add the reveal surfaces. No CSG library; `three-bvh-csg`
is not a dependency.

**Why.** Every opening is an axis-aligned rectangle in the wall's own frame, so
the general case never arises. The direct construction is deterministic (which
is what makes the golden geometry tests meaningful), produces clean real-world
UVs for painting in M3, and emits far fewer triangles than a boolean would —
an empty room shell renders in ~150 triangles and 8 draw calls.

**Would change it.** Curved walls or non-rectangular openings, both explicit
v1 non-goals (docs/04 §1).

### 10. Mitered wall offsets rather than overlapping boxes

**Unspecified.** docs/06 §1 says the polygon extrudes into walls at thickness
and height; it doesn't say how walls meet at corners.

**Chosen.** The interior and exterior faces are computed as mitered offset
polygons of the drawn centreline, so adjacent walls share exact corner points.

**Why.** Extruding each wall as its own box leaves overlapping corners that
z-fight and show seams from inside — visible in the very first "wow, that's my
room" moment M2 exists to deliver. Mitering also supports per-wall thickness,
which docs/04 §1 allows.

### 11. Procedural IBL before the HDRI asset

**Unspecified.** docs/02 §7 specifies a Poly Haven CC0 HDRI for image-based
lighting. M2 has no asset pipeline yet (that's M3) and no network fetch is
acceptable on a cold offline load (docs/03 §6).

**Chosen.** The environment is generated at runtime from three's built-in
`RoomEnvironment` (MIT, bundled). The curated HDRI lands in M6 with the rest of
the visual polish; swapping it changes one component.

### 12. Gradient exterior backdrop

**Unspecified.** Nothing says what is visible *through* a door or window.

**Chosen.** A large gradient backdrop sphere: dark ground, a luminous horizon
band, soft daylight above.

**Why.** Against the plain background an opening reads as a black hole punched
in the wall rather than a way outside — clearly wrong in the Inside view, where
a doorway can fill the frame. The gradient also keeps the dollhouse sitting on a
dark, premium ground rather than a bright sky.

### 13. Field of view is derived from the horizontal axis

**Unspecified.** docs/02 §7 specifies a "35 mm-equivalent default FOV" without
saying which axis, and three's `fov` is vertical.

**Chosen.** The vertical FOV is computed from the 35 mm-equivalent *horizontal*
FOV and the viewport aspect, clamped to 38°–60°.

**Why.** A fixed 38° vertical FOV becomes roughly a 19° horizontal view on a
portrait phone — a telephoto. In practice that made a doorway three metres away
fill the entire screen. Deriving from the horizontal axis keeps the framing
consistent with the intent on every aspect ratio.

### 14. The 3D route is code-split

**Unspecified.** The roadmap doesn't discuss bundling.

**Chosen.** The sandbox is a lazy route; three.js lives in its own chunk,
prefetched on idle.

**Why.** three.js roughly quadrupled the bundle. Splitting keeps the splash,
tutorial, home and drawing board at their M1 weight (docs/01 §2 cold-start
budget) while the idle prefetch preserves the docs/06 §8 "< 2 s from tap on the
project card" budget for opening a room.

---

## M3 — Furnish

### 15. Parametric geometry backs the CC0 catalog, it doesn't replace it

**Correction.** An earlier revision of this file claimed the CC0 asset sources
were unreachable from the build environment and that the catalog therefore
could not be built. **That was wrong** — I asserted it without testing. Poly
Haven's API and CDN are reachable, and the catalog has since been built from
them. The claim was published in `0.3.0-m3` before being checked; this entry
replaces it.

**Unspecified.** docs/09 M3 calls for ~600 CC0 items. The available CC0
furniture libraries do not currently hold 600 *interior* models that also meet
the docs/07 §5 budgets, and the blueprint doesn't say what to do about the
shortfall.

**Chosen.** Two tiers, with the data model already built for exactly this
(docs/07 §4: `catalogId | placeholder` are alternatives):

1. **Real CC0 models** — `packages/catalog/scripts/build-catalog.mjs` fetches
   Poly Haven's CC0 library, maps each asset to a taxonomy category by name,
   bundles glTF + textures into a Draco-compressed GLB, measures real-world
   size from the world-space bounding box, and records `license` and `source`
   per item. Anything over 15 k triangles is rejected rather than shipped.
2. **Parametric geometry** — the box/cylinder composition the blueprint
   specifies as the pipeline's fallback (docs/05 §6), covering all 183
   categories so nothing is ever unplaceable.

**Why.** Every category stays usable now, and each new batch of real models
displaces stand-ins without touching edit mode. The catalog currently holds 77
models across 36 categories — short of 600, and recorded as such.

**Would change it.** More CC0 sources (ambientCG materials, Quaternius,
Kenney) run through the same pipeline; the count is a function of how many
sources are wired up, not of the design.

### 16. New objects land in clear floor space

**Unspecified.** docs/06 §5 says placement "drops it at the tapped spot already
snapped and wall-aligned", but the catalog can also be opened without a tapped
spot.

**Chosen.** `findFreeSpot` walks candidate positions flush along each wall and
takes the first whose footprint is clear.

**Why.** Dropping everything at the room centre stacked every new piece on the
last one — visibly wrong the moment a second item is added.

### 17. Version zero is captured on first entering Edit

**Unspecified.** docs/06 §6 says "Version zero, *Original room*, is created
automatically at first reconstruction" — but reconstruction is M4, and M3 rooms
are furnished by hand.

**Chosen.** The locked "Original room" snapshot is taken the first time the user
taps Edit, capturing the room as it was before any edit.

**Why.** It preserves the guarantee that matters — an untouched state you can
always return to — a milestone before reconstruction exists to trigger it.

---

## M4 — Reconstruct

### 18. Where the pipeline's non-pixel stages run

**Unspecified.** docs/03 §4 puts every pipeline stage in a Python worker;
docs/05 §6 requires stage 4 to rank against "the CC0 catalog … build spec in
`packages/catalog`", which is a TypeScript package.

**Chosen.** Stages 0, 1, 2, 3 and 5 — scan parsing, detection, pose/depth,
measurement, appearance — stay in `workers/vision`. Stages 4 (catalog match) and
6 (assembly) run in TypeScript, in `packages/recon`, called by the orchestrator.

**Why.** Both are pure operations over the catalog manifest and the room
geometry, and both of those are TypeScript packages. Running them in Python
would mean a second copy of the catalog and a second copy of the snapping rules
in `packages/geometry` — two more things that can drift apart from what the app
actually does. Nothing that touches a pixel or a point cloud moved.

### 19. Demo reconstruction is labelled, and never invents from nothing

**Unspecified.** docs/03 §8 requires the CI golden path to run
"draw → mock-reconstruct → edit" on a laptop with no GPU, but does not say what
a *user* of a build without a worker tier should see.

**Chosen.** The CPU-only stage driver lays a typical room out from the floor
plan. Every surface that shows its output — the processing screen and the
room's own warning list — states plainly that the pieces are examples, not
objects detected in the photos. With no photos uploaded it produces nothing at
all rather than furnishing a room nobody photographed.

**Why.** The static staging build has no API, so this is the path a visitor
actually walks. Furniture presented as "what we found in your room" when nothing
looked at the room would be a lie about the user's own home — and the accuracy
badge exists precisely to keep that from happening (docs/05 §9).

### 20. Two RoomPlan parsers, for two different jobs

**Unspecified.** docs/01 §7 requires a parsed preview *before* upload; docs/05
§2 requires the authoritative parse in the worker.

**Chosen.** `workers/vision/roomplan.py` is authoritative and feeds the
pipeline. `packages/recon/scan.ts` parses the same format on the device, only to
draw the preview overlay.

**Why.** The preview has to answer "is this the right room?" in front of the
user, offline, before any bytes leave the phone. Round-tripping to a worker to
answer that would defeat the point of asking. The two are tested against the
same fixture shape, and only the worker's output enters the pipeline.

### 21. The demo path's object reveal is paced

**Unspecified.** docs/01 §8 describes silhouettes popping in "one by one" as the
pipeline reports them.

**Chosen.** The demo driver emits its object events with a short delay between
them. The stage events are not padded.

**Why.** The objects genuinely exist by then; the spacing is the reveal
animation the blueprint asks for, not a progress bar pretending to work. A real
pipeline run takes 30–120 s and needs no help looking busy.

---

## M6 — Polish

### 22. Two accent tokens, not one darker accent

**Unspecified.** docs/02 §3 gives one accent colour; docs/02 §9 requires 4.5:1
for text and 3:1 for essential UI. The single accent satisfies the second and
not the first.

**Chosen.** `--accent` keeps its value for outlines, highlights and selection;
`--accent-strong` is a darker variant used wherever white text sits on a filled
surface. Same for `--danger`.

**Why.** Darkening the one token would have dulled every highlight in the app to
fix a bar that only applies to text. Two tokens keep the design language and the
contrast requirement from trading against each other.

### 23. Quality stepping is asymmetric

**Unspecified.** docs/06 §8 says step down below threshold and "back up when
headroom returns", without saying how fast.

**Chosen.** Two consecutive bad seconds step down; six consecutive good ones
step up. A frame rate between the floor and the headroom moves nothing.

**Why.** Two seconds of stutter is already a bad experience, so falling should
be quick. A level that just failed is likely to fail again, so climbing should
be slow — and flapping between two levels is worse than sitting on the lower one.

### 24. The demo path never runs on an empty upload set

**Unspecified.** docs/03 §8 requires a mock reconstruct for CI but says nothing
about a user with no photos.

**Chosen.** With no photos, the CPU-only driver returns nothing and the room is
built empty, with a nudge into manual furnishing.

**Why.** Furnishing a room nobody photographed is a claim about someone's home
made from nothing at all. The empty accurate room is already the docs/05 §8
fallback, and it is honest.

---

## Photo reconstruction without a GPU

### Recovering the camera from the wall, not from a depth model

**Decision.** Solve the camera pose from the four corners of the wall a photo
was tagged to, then intersect rays with the room's own floor and wall planes,
instead of running metric monocular depth.

**Why.** The blueprint's stage 2/3 path needs a GPU for Depth Anything V2.
Guided capture already tells us which wall each photo shows, and the drawn plan
already knows that wall's width and the ceiling height — so every photo contains
a rectangle of known metric size. That is enough for the textbook plane-to-image
homography decomposition, which is arithmetic, not inference.

**Trade.** Depth gives every pixel a distance, so it measures an object's
front-to-back extent directly. One view of a known plane measures position,
lateral width and height, but the depth away from the camera has to come from
the matched class's catalog proportions. Each object records which of its
extents were measured, and rooms built this way never leave the "photo" tier.

**Would change it.** A second photo of the same object from a different wall
would make its depth measurable by triangulation. The shot list already produces
overlapping corner shots; nothing consumes them yet.

### A hosted multimodal model as the detector

**Decision.** Allow stage 1 to be served by a hosted multimodal model over
Bedrock, configured entirely by environment variable, as an alternative to
Grounding DINO + SAM 2 on a GPU.

**Why.** It removes the accelerator from the deployment story for anyone who
already has a model endpoint. The vocabulary sent to it is generated from the
same taxonomy that prompts Grounding DINO, so neither backend can name a class
the app cannot place.

**Trade.** No masks — boxes only, so measurement works from box edges and is
coarser. A hosted model can also decline or answer outside its instructions, so
the parser drops what it cannot use, notes defects, and treats only a reply that
is not JSON at all as fatal.

**Would change it.** If the golden-room fixtures ever exist, they decide whether
this backend meets docs/05 §9 or is a convenience tier below it.

---

## Not built, and why

These are **not** decisions — they are blueprint items this repository does not
contain. Recorded so their absence is not mistaken for an oversight. Each is
described in full, with its acceptance criterion, in `CHANGELOG.md`.

| Item | Why |
|---|---|
| GPU inference: Grounding DINO, SAM 2, Depth Anything V2 | No GPU in this environment. A no-GPU path for stages 1–3 exists — see "Photo reconstruction without a GPU" — but it is untested against real photos |
| Wiring the no-GPU photo path into the API orchestrator | The stages and their CLI are implemented and tested; the API is not hosted anywhere, so nothing calls them yet |
| Golden-room accuracy fixtures (docs/05 §9) | Tape-measure measurements of five real rooms; cannot be synthesized without inventing the numbers they exist to check |
| Queue-driven worker dispatch (BullMQ over Valkey) | The orchestrator calls its stage driver in-process; `StageWorkers` is the seam a consumer would implement |
| The 60-second demo video (docs/09 M6's definition of done) | Films a photo reconstruction, which needs the GPU tier |
| Tutorial T2–T5 final animations, splash room-loop video | Asset production |
| Low-end device lab pass (2 GB Android, 30 fps floor) | No device lab |
| Web Push proper (VAPID + server) | Needs the hosted API; the local notification works without it |

Everything above is stated in the app itself where a user could otherwise be
misled — the accuracy badge, the demo-reconstruction notice, and the golden-room
suite's "certified nothing" output.
