# Changelog

All notable changes to My Room Sandbox. Milestones follow
[`docs/09-roadmap.md`](docs/09-roadmap.md); each ships tagged, with a demo
recording against its acceptance criteria.

## [2.3.2] — Boxes the size of the things they are

**Ships:** the fix for "the models are producing WAY too big of boxes":
measured sizes now come from each object's dense core, and a named object
snaps its implausible axes to the category's real proportions.

### Fixed — measured size accuracy

- **Extents come from the dense core, not the halo.** A couch drags along
  a welded fringe — a toy against it, a blanket corner, merged clutter —
  and min/max boxing measured couches four feet deep and six feet tall.
  The footprint is now the columns that actually hold geometry, and the
  height is what most of those columns top out at, so a lamp poking up
  behind a couch no longer becomes couch height.
- **A name overrides an implausible measurement.** Naming a box (picker,
  photo pass, or dimension guess) keeps each measured axis when it is
  plausible for that category (0.6–1.5× nominal — real furniture varies)
  and snaps it to the category's size when it is not, orientation-
  agnostically. Renaming always snaps from the pristine measurement, never
  from a prior snap. On the reference scan this is what pushed dimension
  fits over the catalog threshold: the two couches now build as actual
  sofa models at couch scale instead of six-foot-tall boxes.

## [2.3.1] — A named box builds as the thing it is

**Ships:** the fix for "the items just import as boxes and not representing
what I have" — the catalog's 96 CC0 models and per-category massings were
already there; what was missing was names to route boxes to them.

### Added — name it in the review

- **Every review row has a "what is this?" picker** (common furniture
  first, full taxonomy behind it). A named box builds as a real catalog
  model when its measured size fits one, or as the category's shaped
  massing — a sofa with a back and arms, a shelf with shelves — never a
  grey block. The person standing in the room is the best classifier the
  app has.

### Fixed — measured sizes match reality

- **Cluster extents are percentiles now, not min/max.** A stray toy on a
  couch or a wisp of wall fringe used to make it measure ceiling-tall, and
  a ceiling-tall couch matches nothing — not the dimension guesser, not a
  catalog model. Trimming the top few per cent is the difference between
  "Sofa" and "Scanned item".
- **Dimension-only guessing is restricted to ordinary household things.**
  Loosening its gates re-labelled the kitchen island a grand piano within
  one run — a cluttered island IS piano-proportioned; priors are what rule
  the piano out. Rare categories now require the photo-informed AI pass or
  the user's own word; ties within a family (sofa vs loveseat) are safe to
  call and no longer blocked.

## [2.3.0] — Ask, don't guess

**Ships:** the owner's proposal verbatim: "what if we eliminate this
guessing game by making the app ask — does your layout look correct?"

### Added — confirm and correct

- **The review now asks the layout question first**: your walls, as the
  scan measured them, with an Adjust walls button straight into the drawing
  board where every corner is draggable. Corrections stick — the scan stays
  attached, and on build the furniture is re-registered against the walls
  you fixed (scan refinement only ever applies uniform scale and ceiling
  height, so it cannot fight a dragged corner).
- **"+ Add an item"** in the review, for the things the scan missed — a
  generic box joins the list ticked, lands mid-room, and gets named with
  Swap and dragged home like anything else.
- **With an API key, your room photos join the AI pass.** Photos are far
  better evidence than normal-shaded scan crops, so they now (1) improve
  the naming of detected boxes and (2) come back with a "missing" list —
  significant furniture visible in the photo that detection never boxed —
  which is appended mid-room, announced, and draggable. Photos are
  downscaled and re-encoded on device; an undecodable photo is skipped,
  and every failure path still returns the measured boxes.

## [2.2.3] — The items are the items

**Ships:** the fix for "those items are not accurate": the reference scan
went from six unrecognisable blobs to thirteen objects that read like the
room's actual inventory.

### Fixed — scanned-object detection

- **Against-wall furniture existed only as its distance from a wall.** A
  blanket 28 cm exclusion zone erased the fridge, the console, the shelf
  runs and the kitchen nook — most of a lived-in room stands against its
  walls. The zone now drops only wall-height vertical surface (the wall
  itself); furniture standing in it survives.
- **Adjacent objects merged into review-proof blobs** (the reference scan
  listed a 6'×5'×6'4" "object"). Merged clusters are now split at the
  density valleys of their own footprint, recursively; a continuous run
  with no valley — 17 feet of shelving — is bisected into sections a person
  can actually tick or untick.
- **Geometry beyond the walls is no longer furniture.** Clusters are
  clipped to the room polygon, which the chamfered boundaries made matter:
  scanned clutter past a diagonal wall used to pull boxes across it.
- Smaller minimums so basket- and bin-sized things survive; objects sitting
  on counters keep their measured base height (a microwave is a box 2'2"
  up, not a floor cabinet).

## [2.2.2] — The boundary the owner could see, followed

**Ships:** the owner's annotated correction — "I see clearly the real
outline… it doesn't seem like you are noticing it" — turned into geometry.

### Added — corner chamfers from wall evidence

- **The outline now follows a boundary that visibly cuts a corner.** The
  reference scan has a wall-height line running diagonally across the top
  of the plan with a strip of scanned clutter beyond it; occupancy filling
  can't see it (there is geometry on both sides), so the outline squared
  over it. Each convex corner now fits a line to the tall cells in its
  pocket (vertical-surface coverage of the wall band, deterministic pairwise
  search + PCA refit) and cuts along the strongest hypothesis that lands as
  a valid chamfer.
- **The owner's own rule tells walls from wardrobes**: a cut only happens
  when there is essentially no real floor beyond the line — beyond a
  boundary the space stops; behind tall furniture the floor proves the room
  continues. A knee-high play fence doesn't cut (not wall-height), scattered
  tall clutter doesn't cut (no straight run), and the alcove stays room.
- On the reference scan the plan now carries the drawn diagonal into the
  notch and an evidence-backed chamfer at the far corner: 8 walls, ~256 ft²
  enclosed, every wall on a visible band.

## [2.2.1] — The walls land where the walls are

**Ships:** the fix for the owner's real Scaniverse scan coming back as a
212 ft² dart with a 36-foot wall, validated against that exact file.

### Fixed — scan wall extraction

- **The outline finisher could shoot corners metres outside the room.**
  Douglas–Peucker → snap-to-axes → re-intersect-neighbours re-corners two
  near-parallel walls at their far-away intersection; the reference scan's
  L-shaped room came back as a dart whose area looked plausible and whose
  shape was garbage. Replaced with rectilinear simplification on the traced
  grid boundary itself: merge collinear runs, then collapse each too-short
  wall by sliding the shorter neighbour onto the longer one's line. Vertices
  only ever adopt coordinates other vertices already have, so the outline
  can never leave its own occupancy — asserted now, on the real scan.
- **Furniture below 2'7" was invisible to the room's footprint.** Occupancy
  counted visible floor plus a wall band above 0.8 m, so a sofa against a
  wall bit a bay out of the outline. Everything below the ceiling now counts
  as interior evidence — furniture proves the volume it stands in.
- **A symmetric room registered flipped or not by floating-point luck.**
  A rectangle fits its own scan at θ and θ+180° with identical wall
  residual. Near-ties now break toward the smaller rotation — deterministic,
  and exactly right for scan-first plans, where identity is the truth.
- **One upload, not two**: importing a scan on the drawing board now keeps
  the file as the project's scan, so the build step finds the furniture in
  it without asking again. The processing screen's review step is covered by
  the RoomPlan e2e (it previously raced past the review and hung CI).

## [2.2.0] — The scan lands where the room is

**Ships:** the fix for "nothing was placed right": scanned furniture is
registered onto the drawn plan instead of dropped in the scanner's own
coordinate frame, a review step where you tick the objects to keep, and
optional AI naming of what the scan found.

### Fixed — scan placement

- **Scan-measured objects landed in the scanner's session frame**, which is
  rotated and shifted arbitrarily relative to the drawn plan — so every box
  was placed wrong, then wall-snap and collision-shuffle scattered them
  further. The worker's 2D wall-to-plan ICP (`register.py`) is now ported to
  TS and runs on the device: candidate rotations from wall-heading pairs,
  point-to-segment ICP, closed-form 2D Kabsch. Seeds are transformed through
  the registration (position and yaw) before assembly, and registrations
  worse than 0.5 m residual are refused with a note rather than trusted.
- **`assembleScene` no longer second-guesses the scan**: scan-measured
  objects are pinned — no wall snap, no collision relocation. The scan
  already knows where the sofa is; overlaps like a rug under a table are
  real, not errors.

### Added — review what it found

- **A review step between scan and build**: the detected objects are drawn
  as numbered boxes over the plan, and each is tickable — tap a box on the
  plan or its row in the list to keep or drop it. "Build my room (N items)"
  builds exactly what's ticked.
- **Optional AI naming**: paste an Anthropic API key in Settings and small
  rendered crops of the scan (normal-shaded, clipped per object) are sent in
  one batched request to name what it found — fridge, sofa, floor lamp —
  against the catalog taxonomy, with measured sizes as evidence. Strictly
  local-first: the key lives on this device only, no key means no request,
  and any failure falls back to unnamed "Scanned item" boxes.

## [2.1.0] — Every input reads, every dimension lands, and the room finally looks warm

**Ships:** the owner's four complaints, fixed at the root: dimension entry
that means what the label says, a scan importer that reads every format it
advertises, user-model import, and the lighting overhaul the M6 polish pass
deferred.

### Fixed — dimensions & walls

- **A bare typed number meant metres in a feet-labelled app.** Typing "12"
  against a wall labelled 12'4" produced a 39 ft wall; typing "9" for a 9 ft
  ceiling was silently discarded by the metric 2–6 m guard.
  `parseLength`/`parseDisplayLength` now take the display unit; explicit
  suffixes still win. The Units row in Settings has an actual ft/m control,
  and the load-time force-override to "ft" is gone.
- **Typing a length sheared a closed room into a trapezoid** — asserted as
  intended by the golden-path spec. `resolveLoopWallLength` propagates the
  correction around the loop (perpendicular walls translate, the first
  parallel wall absorbs the delta); a rectangle stays a rectangle, and the
  e2e now asserts the exact grown area.
- Grid snap was dead at the opening zoom (60 px/m < the 1:50 threshold), so
  dragged rooms landed on 13'2¾"-style lengths. The board opens at 80 px/m.
- Wall thickness: a proper sheet in inches/mm replaces the `window.prompt`
  that displayed mm and parsed metres. Dimension fields commit valid entries
  on blur, re-shake on repeated bad input, and explain out-of-range heights.
  Slow drags no longer register as taps; undo restores the active tool.

### Fixed — scanning

- **Point-cloud PLY parses on the device** — the worker's numpy pipeline
  (RANSAC wall fit, occupancy outline, voxel clustering) ported to TS. The
  app's own help text steered Polycam/Scaniverse users into PLY and then
  rejected every such file.
- **Draco GLB decodes** using the decoder that was already vendored; the
  refusal cited a CDN constraint that no longer existed. **LAS** parses in
  pure TS; LAZ and E57 name the export switch to flip. **USDZ** is unzipped:
  an embedded RoomPlan JSON or mesh is used, ASCII USDA parses, binary USDC
  gets an actionable message.
- **A scan that can't line up wall-for-wall still corrects the ceiling
  height**, and says what it kept. **Scan-measured furniture is no longer
  thrown away**: unnamed boxes become low-confidence "Scanned item" objects
  (swap to name them) instead of the room falling back to invented demo
  furniture — and the lidar badge is earned by those measurements.
- A configured-but-unreachable API falls back to the on-device pipeline
  with a warning instead of dead-ending the build.

### Added — model import

- **Any common 3D file becomes a first-class object**: GLB/GLTF/OBJ/STL/
  FBX/USDZ via Add → Import (or drag-and-drop), normalized once (grounded,
  unit-heuristic scaled, re-exported to GLB) into a device-local assets
  store. Confirm sheet shows real-world size and triangle count; imports
  move, duplicate, undo, version and swap like catalog furniture.

### Changed — lighting & graphics

- Warm procedural environment replaces the neutral RoomEnvironment; key
  light aims through the wall with the most glazing; hemisphere + cool
  bounce replace the flat ambient; PCSS soft shadows at the higher tiers.
- **Contact shadows are live** — `frames={1}` had frozen them at mount, so
  dragged furniture left its shadow behind.
- The quality governor's shadow-map and AO knobs are actually wired now
  (they only ever changed pixel ratio); the never-implemented
  environment-resolution knob is retired.
- Procedural wood/tile/carpet floor textures and a wall roughness map at
  true world scale, zero downloads. Ceilings receive shadows. Lamps glow
  and cast real light (capped at four point lights). Selection is a soft
  accent halo. Tutorial steps 2–5 got real animated vignettes.

All within the docs/06 §8 budgets — the sandbox and edit-mode suites pass
against the new rig on the same ≤300k-triangle / ≤150-draw-call assertions.

## [2.0.0] — Reconstruction Pipeline 2.0: the pipeline runs on the device you have

**Ships:** the removal of a hardware requirement that was never real, a tier
chosen per device, and a licence-gated generative surface kept strictly outside
the reconstruction path.

### The bug this release exists for

`workers/vision/myroom_vision/detect.py` refused to start stage 1 unless
`torch.cuda.is_available()`, and hardcoded `.to("cuda")` on the model and its
inputs. That made an NVIDIA card a hard requirement for the app's headline
feature, and every downstream "partial" mark in this file traces back to it.

It was a mistake, not a constraint. PyTorch's default device is the CPU; CUDA is
one optional backend among CUDA, Metal, XPU, ROCm and CPU. The pipeline's models
are 25–150 M parameters, and a reconstruction is a handful of photos. `docs/03`
§8 already required the pipeline to run on a laptop without a GPU — the code
just did not honour it.

Measured on the four-core, GPU-less container this repository's CI runs in:

| Model | Task | Device | Time |
|---|---|---|---|
| Depth Anything V2 Small | stage 2 depth, one room photo | CPU | 12.4 s |
| SD 1.5 + ControlNet-depth + LoRA | 512×512 restyle, 8 steps | CPU | 106 s |

### Added

- **`workers/vision/device.py`** — backend selection: CUDA, then Metal (MPS),
  then Intel XPU, then CPU. CPU is the documented floor, not a failure mode. An
  explicit `MYROOM_VISION_DEVICE` override is honoured or raises, rather than
  silently downgrading underneath the operator.
- **`workers/vision/depth.py`** — stage 2's metric depth, resized back to the
  photo's own resolution so stage 1's masks line up pixel for pixel.
- **`apps/web/src/lib/inference/device.ts`** — the device tier. WebGPU ships
  enabled by default in Safari on iOS 26, backed by Metal, so a phone GPU is
  reachable from this PWA. Falls to wasm, then to the service. **There is no
  "unsupported device" outcome**, and `e2e/inference-tier.spec.ts` pins that.
- **The privacy screen states which tier ran**, because "where do my photos go"
  has a different true answer per device and cannot be static copy.
- **`workers/diffusion`** — restyle renders for docs/06 §6, with a licence gate
  for model weights that the npm dependency gate cannot see. Explicitly *not*
  part of reconstruction; see docs/05 §11.

### Fixed

Found by an audit fan-out across every pipeline segment. Each of these was
reproduced against running code before it was touched; one further claim — a
"critical" hole in ear-clipping triangulation — did not reproduce, and its repro
is kept as a regression test rather than recorded here as a bug.

- **Anyone could sign in as anyone.** `POST /v1/auth/magic-link` returned the
  sign-in token in its response body unless `NODE_ENV` was exactly
  `"production"`, and nothing in this repository sets `NODE_ENV` — no
  Dockerfile, and a bare `tsx src/server.ts` start script. Reproduced end to
  end: an unauthenticated request with a stranger's address returned their
  token, which redeemed for a valid session. The same gate selected the
  hardcoded signing secret and dropped `Secure` from the session cookie. The
  default is now inverted — absent configuration means production behaviour.
- **JSON uploads were destroyed on arrival.** The catch-all body parser was
  registered as `"*"`, which Fastify consults only for types its built-in
  parsers decline, so `application/json` bodies reached the blob route already
  parsed and were stored as the fifteen bytes `[object Object]`. Browsers set
  `File.type` to `application/json` for a `.json` file, so this hit RoomPlan
  JSON — docs/05 §2's "gold input" — on the default path.
- **Every scanned object was a quarter-turn out.** RoomPlan yaw was read off
  column 0 of the transform instead of column 2, a constant +π/2 error measured
  across five angles.
- **A scan silently rescaled plans it should have queried.** `applyRefinements`
  never consulted the `needsReview` flag it computed, rescaling a 6.20 m wall to
  6.94 m while the notes told the user "we left your drawing alone" —
  contradicting docs/05 §2 and itself.
- **Splitting a wall deleted doors and windows across the split point.** Both
  halves filtered on "lies wholly within me", so a straddling opening belonged
  to neither.
- **Four detections in five could not be matched.** Stage 1 emitted the
  detector's raw prompt as the category while stage 4 keys on taxonomy ids; only
  69 of 368 prompts coincide, so correctly recognised objects fell through to
  parametric placeholders.
- **Stage 0 emitted a format string its own schema rejects.** A RoomPlan `.json`
  sidecar parsed correctly and then failed output validation.

### Changed

- **docs/05 is now 2.0.** §1a describes the three tiers; §9 states that accuracy
  is a property of the inputs rather than the hardware; §10 drops on-device
  reconstruction from the non-goals, since WebGPU is what it was waiting for.
- **The stage-1 test asserted the bug.** `test_stages.py` skipped unless the
  worker had a GPU, so the CUDA gate had a test defending it. Replaced with a
  regression test that a runtime-equipped worker with no GPU reports itself
  ready.

### Not met

- **Golden fixture rooms still do not exist**, so every accuracy number in
  docs/05 §9 remains a target rather than a measurement. Nothing in this release
  changes that: faster inference does not substitute for a tape measure.
- **The BullMQ consumer is still unwritten.** `StageWorkers` remains the seam.
- **The device tier's ONNX graphs are not yet exported.** `device.ts` selects the
  tier and the privacy surface reports it; the in-browser model execution behind
  it is scaffolded, not shipped.
- **Restyle is off by default and unverified at quality.** It has been run end to
  end on CPU against a synthetic render; it has not been run against a real
  sandbox render, and no one has judged whether the output is good.

## [0.6.0-m6] — Milestone M6: Polish & Premium *(partial — see Not met)*

**Ships:** the finish, and the checks that keep it finished.

### Added

**Accessibility, as tests** (docs/02 §9 — ship-blocking) — axe across home,
tutorial, drawing board, capture, scan upload and the sandbox; a Dynamic Type
run at 135% asserting no horizontal overflow and no control under 40 px; a
keyboard-only path from launch to the drawing board; and a token-level contrast
test covering both themes without rendering either.

**Auto quality stepping** (docs/06 §8) — rolling FPS steps quality down through
pixel ratio → shadow map → AO → environment resolution and back up when headroom
returns, quick to fall and slow to climb so it cannot flap. Manual
Auto / Best / Battery-saver override in settings.

**Privacy, kept** (docs/01 §12, docs/03 §7) — a real storage-purge job with a
completion audit and an overdue check against the 24-hour promise; deleting a
project now also deletes its photos from the device; and a plain-language page
of five promises, each of which is a behaviour implemented in this repository.

**Motion & haptics** (docs/02 §5) — a light tick per completed pipeline stage
and a success tick on the room reveal, the checkmark draw-on, and the error
shake. All of it honours `prefers-reduced-motion`, and haptics are silently
absent where the Vibration API is.

**"Your room is ready"** — notification permission is requested at the first
processing run and nowhere else; if the user leaves the screen, they're told when
the room is done.

**2× share renders** (docs/09 M6) — the export re-renders at twice the pixel
ratio and restores the previous one, so a share image isn't limited to the
phone's screen.

**Localization scaffold** (docs/09 M6) — a typed string catalogue with named
(not concatenated) parameters, primary-subtag locale matching, and a
`missingKeys` check so a new catalogue can be diffed against English.

### Verified

- Lighthouse on the built PWA, mobile-throttled: **accessibility 100** (target
  95), best practices 100, SEO 91, and **performance 87** on a developer
  container. The same build scores **70** on a shared GitHub runner, because
  Lighthouse throttles the CPU 4× on top of whatever the host already is — so CI
  gates the machine-independent categories and reports performance without
  gating it. Neither machine is the iPhone 12-class device docs/09 M6 names, so
  the ≥ 85 target should be read as *not yet verified on target hardware*.
- 48 web unit tests, 28 API tests, 24 pytest cases, and a Playwright suite
  covering the golden path, the reconstruct path and the accessibility checklist.

### Fixed

Four real accessibility violations, found by the audit rather than by review:
`user-scalable=no` disabled pinch zoom app-wide; the primary button was 3.2:1
white-on-blue; the light theme's dim text, amber and success green were all under
their bars; the tutorial dots claimed a 44 px hit area through an overlay that
measured 10 px to anything reading element boxes; and no document had a `<main>`
landmark.

A pre-existing E2E failure on the desktop viewport: the self-crossing test aimed
its final click at a point the board's own snapping moved, so the wall it drew
didn't cross anything. It now aims along an exact 45° from the last vertex,
where every snap is a no-op. The drawing board itself has not changed since M1;
only the test was wrong.

Also a pre-existing flaky property test, which asserted that the northernmost
wall by "first index wins" gets label A while `labelWalls` breaks that tie
west-most. A symmetric room genuinely has two northernmost walls.

### Not met

- **The 60-second demo video is the stated definition of done, and there is no
  video.** docs/09 M6: "the doc-01 couple scenario filmed as a 60-second demo
  with zero cuts and zero workarounds — this video is the definition of done."
  That scenario ends in a room reconstructed from photographs, which needs the
  GPU tier this environment does not have. By the blueprint's own criterion, M6
  is not done.
- **Tutorial T2–T5 final animations and the splash room-loop video** are not
  produced; T1's animation and the current tutorial copy stand in.
- **Web Push proper** (VAPID keys, a service-worker `push` handler, a server that
  sends it) is not implemented — the notification is local to the device.
- **The low-end device lab pass** (2 GB Android, the 30 fps floor) has not been
  run; there is no device lab here. The quality policy is unit-tested, the
  thresholds it uses are not measured against real hardware.
- **Localization is scaffolded, not finished.** The privacy page, the accuracy
  badge and the reconstruction copy read from the catalogue; splash, tutorial,
  home, the drawing board and the sandbox still hold their strings inline.

## [0.5.0-m5] — Milestone M5: LiDAR *(partial — see Not met)*

**Ships:** the optional scan upload that upgrades accuracy.

### Added

**S5 — scan upload** (docs/01 §7) — drag-and-drop or file picker for `.usdz`,
`.json`, `.ply`, `.glb`, `.e57` and `.las`, validated by extension *and* magic
bytes before a byte is uploaded, with expandable "how do I get a scan?" cards
for RoomPlan apps, Polycam, Scaniverse and 3d Scanner App. Skippable in one tap.

**Parsed preview** — a RoomPlan export is parsed on the device and drawn over
the drawn plan, to the same scale, so "is this the right room?" is answered
before anything is uploaded and while still offline.

**Stage 0 — scan parse** (`workers/vision`, docs/05 §2) — RoomPlan JSON parsing,
PLY reading (ASCII and binary), RANSAC wall fitting with a one-sided test that
tells a wall from the flat front of a wardrobe, voxel clustering for seed boxes,
and 2D ICP registration against the drawn outline with per-wall length
comparison.

**Plan refinement** (`packages/recon/refine.ts`) — corrections that preserve the
closed polygon the user drew are applied (a consistent scale error, and the
ceiling height); anything else is reported for the user to decide, because
correcting one wall of a closed polygon moves its neighbours and there is no one
right way to absorb that. Disagreements over 0.4 m are always surfaced, never
silently applied (docs/05 §2).

**Seed-box fusion** (`packages/recon/fuse.ts`, docs/05 §5) — the scan wins
geometry, the photo keeps the class and the colours it sampled. Objects the scan
named and the photos missed join the room, so **a RoomPlan export furnishes a
room on its own, with no GPU anywhere in the path**. An unnamed box corrects an
object the photos did name, but never becomes an object with a guessed class.

**Accuracy badge, end to end** — `Sketch` → `Photo-calibrated` → `LiDAR-verified`
is driven by what actually happened: the LiDAR tier is claimed only when a scan
was read and used, not when a file was uploaded.

### Verified

- 34 unit tests in `packages/recon` and 24 pytest cases in `workers/vision`.
- E2E: a RoomPlan export corrects the room's scale and ceiling height, furnishes
  it from its own measurements, and lands on the LiDAR-verified badge.
- Registration recovers a known rotation and translation to under a centimetre;
  a 60 cm wall disagreement is flagged for review and a 5% uniform error is
  applied without touching the drawing.

### Not met

- **No stock-iPhone round trip.** docs/09 M5 asks for a RoomPlan export from a
  real iPhone Pro to round-trip with zero manual fixes. The exports tested here
  are synthesized to Apple's documented `CapturedRoom` shape; a real device
  export has not been through it.
- **`.e57`, `.las`/`.laz` are accepted and stored but not parsed.** The upload
  path validates them; Stage 0 reads RoomPlan JSON and PLY.
- **The ±2 cm / ±5 cm LiDAR-verified accuracy targets are unverified** — the
  golden-room suite has no fixture rooms (see M4 below).

## [0.4.0-m4] — Milestone M4: Reconstruct *(partial — see Not met)*

**Ships:** the capture-to-room path, everything in it that does not need a GPU.

### Added

**S4 — guided capture** (docs/01 §6) — the plan generates the shot list: one
photo per wall to proceed, a wide shot per opposing corner pair offered,
close-ups unlimited. Each photo gets an on-device quality check (variance of the
Laplacian for focus, mean luma for exposure) whose verdict is *advice, never a
block*, and is tagged to a wall with one tap on the mini-plan. Photos stay on the
device until a reconstruction needs them, and are deleted with the project.

**S6 — processing** (docs/01 §8) — driven entirely by the pipeline's own events:
stage checklist, objects announced by name and size as they land, partial results
and a way into the room on failure. Never a dead end.

**Pipeline contracts** (`packages/schema`) — capture plan, photo quality, and
every stage artifact (detection, camera solve, measured object, catalog match,
scan parse), plus the job record and the SSE event union. JSON Schema is
generated from these and the Python workers validate against it.

**Stage 4 — catalog match** and **stage 6 — assembly** (`packages/recon`) —
ranking by dimension fit within each model's allowed scale bounds, runners-up
kept for the swap sheet, and a parametric placeholder rather than a forced match;
then dedupe by 3D IoU, support and collision resolution, wall snapping, and the
`Scene` write. Both are pure operations over the TypeScript catalog and geometry
(DECISIONS.md §18).

**Vision workers** (`workers/vision`) — stage 2's EXIF intrinsics, depth rescale
against the plan's known wall distance, and back-projection; stage 3's
floor-aligned oriented boxes with outlier trimming; stage 5's Lab k-means
palettes with the illumination divided out in linear space. Stage 1 imports
safely without weights and raises an actionable error naming the models to
deploy. The detection vocabulary is generated from `packages/catalog`, so the
classes the detector can name and the classes the app can place cannot drift.

**API** (`apps/api`) — presigned uploads with checksum and magic-byte validation
on completion, the reconstruct orchestrator with the full docs/05 §8 fallback
table, resumable SSE progress (`Last-Event-ID` replays what a backgrounded phone
missed), scene GET/PUT with ETag concurrency, versions, share tokens, and catalog
search. 10 reconstructions per project per day.

**"Wrong item?"** (docs/01 §9, docs/05 §6) — the object card shows the
pipeline's confidence and the runners-up it stored, so swapping is one tap with
no search. Objects placed from a wall tag rather than a solved camera pose get an
amber outline.

**Golden-room harness** (docs/05 §9) — position/size error, detection recall over
major furniture, match quality, and a baseline check that blocks a change making
any room worse. Scored on the 90th percentile, not the median: a median inside
15 cm with a quarter of the room a metre out is not "positions ± 15 cm".

### Not met

These are the reasons this milestone is marked partial. None is a design
decision; each is a thing this environment cannot do.

- **No GPU inference.** Stages 1 and 2's model-backed halves — Grounding DINO,
  SAM 2, Depth Anything V2 — are not running anywhere in this repository's CI or
  in the staging build. The code path exists and refuses loudly rather than
  returning nothing.

  > **Corrected in 2.0 — this entry was wrong about its own cause.** The stages
  > were not blocked by the absence of a GPU. They were blocked by
  > `detect.py` gating on `torch.cuda.is_available()` and hardcoding
  > `.to("cuda")`, which turned one optional PyTorch backend into a hard
  > requirement. PyTorch's default device is the CPU, and these models are
  > small. On the same GPU-less container that produced this entry, Depth
  > Anything V2 Small now returns a correct depth map for a room photo in
  > **12.4 s**. See the 2.0 entry below.
- **No golden fixture rooms, so no accuracy numbers.** docs/05 §9 requires
  ≥ 5 real measured rooms with hand-labelled ground truth. Those are tape-measure
  measurements of physical rooms; synthesizing them would produce numbers that
  read like accuracy while measuring nothing but our own assumptions. The suite
  reports that it certified nothing (`fixtures/golden-rooms/README.md`).
  **Every accuracy claim in docs/05 §9 is therefore unverified.**
- **No queue-driven worker dispatch.** docs/03 §4's BullMQ-over-Valkey consumer
  is not written; the orchestrator calls its stage driver in-process. The seam
  (`StageWorkers`) is the interface the consumer would implement.
- **The demo stage driver is not a detector.** Where no worker tier is
  configured — including the staging build — a typical room is laid out from the
  floor plan, and every surface that shows it says so. With no photos uploaded it
  produces nothing rather than furnishing a room nobody photographed.
- **The fault-injection matrix and the "< 3 min wall-clock" end-to-end target**
  are untested for the same reason: there is no end-to-end run with real models.

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

**Compare & share** (docs/06 §6) — A/B compare renders two versions from an
identical camera and composites them under a draggable slider; share exports
the current view as a PNG. Both read back the live canvas, so there is no
second offscreen pipeline to keep in sync.

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
- **Share *links* are not implemented.** Render export and A/B compare are;
  the read-only share URL needs the API's share-token endpoint (docs/03 §3) —
  *the endpoint landed in 0.4.0-m4; the client still exports a render only.*
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
