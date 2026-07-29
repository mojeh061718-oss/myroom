# workers/vision

Python 3.11 reconstruction workers (docs/03 §4, docs/05).

```
pip install -e ".[dev]"          # geometry stages + tests, no ML runtime
pip install -e ".[dev,models]"   # adds torch/transformers for the model stages

# On a machine with no NVIDIA card, use the CPU wheel — it is ~200 MB rather
# than ~2.5 GB, and carries no nvidia-* packages at all:
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
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
| 1 · detect & segment | `detect` | runs on any backend; raises `ModelsUnavailable` only when the ML runtime is absent |
| 2 · camera & scale | `solve`, `depth` | intrinsics, depth rescale and back-projection implemented; Depth Anything V2 runs on CPU in ~12 s/photo |
| — · device selection | `device` | CUDA → Metal (MPS) → Intel XPU → CPU. CPU is the floor, not a failure |
| 3 · measurement | `measure` | implemented, tested |
| 4 · catalog match | — | TypeScript, `packages/recon` |
| 5 · appearance | `appearance` | implemented, tested |
| 6 · assembly | — | TypeScript, `packages/recon` |

Stages 4 and 6 are pure operations over the catalog manifest and the room
geometry, both of which are TypeScript packages; running them here would mean a
second copy of the catalog. See `DECISIONS.md` → "Where the pipeline's non-pixel
stages run".

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
