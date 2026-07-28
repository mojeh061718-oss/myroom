# workers/vision

Python 3.11 reconstruction workers (docs/03 §4, docs/05).

```
pip install -e ".[dev]"          # CPU stages + tests
pip install -e ".[dev,models]"   # adds torch/transformers for stages 1–2 on a GPU
pip install -e ".[dev,bedrock]"  # adds boto3 for stages 1–3 through a hosted model
python -m pytest -q
```

The workers validate every artifact against the JSON Schemas generated from
`packages/schema`, and take their detection vocabulary from the taxonomy
exported by `packages/catalog`. Generate both before running the tests:

```
pnpm --filter @myroom/schema generate:jsonschema
pnpm --filter @myroom/catalog build:taxonomy
```

## What runs where

| Stage | Module | Status |
|---|---|---|
| 0 · scan parse | `stage0_scan`, `roomplan`, `pointcloud`, `register` | implemented, tested |
| 1 · detect & segment | `detect` | needs GPU + weights; raises `ModelsUnavailable` otherwise |
| 1 · detect (no GPU) | `bedrock` | boxes from a hosted multimodal model; no masks |
| 2 · camera & scale | `solve` | intrinsics, depth rescale and back-projection implemented; the layout estimation that feeds the pose solve needs the model tier |
| 2–3 · pose & measure (no GPU) | `place`, `photo_pipeline` | implemented, tested |
| 3 · measurement | `measure` | implemented, tested |
| 4 · catalog match | — | TypeScript, `packages/recon` |
| 5 · appearance | `appearance` | implemented, tested |
| 6 · assembly | — | TypeScript, `packages/recon` |

Stages 4 and 6 are pure operations over the catalog manifest and the room
geometry, both of which are TypeScript packages; running them here would mean a
second copy of the catalog. See `DECISIONS.md` → "Where the pipeline's non-pixel
stages run".

## The no-GPU photo path

Stages 1–3 have a second implementation that needs no GPU and no model weights,
for deployments that have a hosted multimodal model but no accelerator:

* `bedrock` asks the model for labelled boxes **and** the four corners of the
  wall the photo was tagged to. Only the network call touches AWS; everything
  that can be wrong is a pure function the tests drive directly.
* `place` recovers the camera pose from that wall — a rectangle whose width the
  drawn plan already knows and whose height is the ceiling height — and then
  intersects rays with the room's own floor and wall planes.

```
pip install -e ".[dev,bedrock]"

# AWS credentials come from boto3's normal chain — an IAM role, `aws configure`,
# or these two variables. They are never read from a file in this repository.
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

export MYROOM_BEDROCK_MODEL_ID=...      # the model or inference-profile id
export MYROOM_BEDROCK_REGION=...        # the region it is enabled in

python -m myroom_vision.photo_pipeline \
  --plan example-plan.json --wall A --photo wall-a.jpg
```

`example-plan.json` is a 4 m × 3 m rectangle with a 2.4 m ceiling and walls
A–D. Two numbers have to be true for the answer to mean anything: the length of
the wall in the photo, and the ceiling height — everything is solved against
that rectangle. Edit them to match the room you photograph, stand back far
enough that all four of that wall's corners are in frame, and pass its label.

What it measures honestly, and what it does not:

| Extent | Floor-standing object | Wall mount |
|---|---|---|
| position | measured (floor ray) | measured (wall ray) |
| width | measured | measured |
| height | measured | measured |
| depth / thickness | **assumed** from the catalog | **assumed** from the catalog |

Depth away from the camera is the one extent a single view cannot see; it is
listed in each object's `measured` field so nothing downstream mistakes it for
an observation. Rooms built this way stay in the **photo** accuracy tier. A
photo whose wall corners are not all visible places nothing and says so, rather
than guessing a pose and putting furniture through a wall.

## Queue wiring

The stages above are libraries. The BullMQ consumer that pulls jobs from Valkey
and calls them (docs/03 §4) is **not implemented yet** — today the API's
orchestrator calls its CPU-only driver in-process, which is what dev and CI use.
See `CHANGELOG.md` for the M4 gap list.

## Licensing

Runtime dependencies are numpy (BSD-3) and jsonschema (MIT). The `models` extra
adds torch (BSD-3), transformers (Apache-2.0) and pillow (HPND) — all on the
docs/08 §7 allowlist. Model weights: Grounding DINO (Apache-2.0) and SAM 2
(Apache-2.0).
