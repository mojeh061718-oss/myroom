# Golden rooms

The pipeline's regression suite (docs/05 §9, docs/09 M4). Every pipeline change
runs `pnpm test:golden`; a room that misses its tier's
target, or that got worse than `baseline.json`, fails the run.

**There are no fixtures in this repository yet, so the suite currently certifies
nothing.** That is not an oversight to be worked around — see below.

## What a fixture is

```
fixtures/golden-rooms/<room-name>/
  plan.json      the room as drawn, in the RoomPlan schema (packages/schema)
  photos/        the capture set: one per wall, plus corner shots
  scan.ply       optional; a room with one is scored at the LiDAR tier
  truth.json     hand-labelled ground truth (see below)
  measured.json  stage-3 output from a vision-tier run, written by the runner
```

`truth.json`:

```json
{
  "room": "living-room-01",
  "tier": "photo",
  "objects": [
    { "category": "sofa", "position": { "x": 1.2, "y": 0, "z": -0.55 },
      "size": { "w": 2.14, "d": 0.92, "h": 0.84 } }
  ]
}
```

Positions are the object's footprint centre with `y` as its base elevation —
the same convention the `Scene` document uses. Categories come from the
taxonomy in `packages/catalog`.

## Why these cannot be generated

docs/05 §9 asks for "≥ 5 fixture rooms (**real measured rooms**: photos + LiDAR
+ hand-labeled ground truth)". Every number the suite reports — position error
in centimetres, size error as a percentage, detection recall — is a comparison
against a tape measure. Synthesizing a fixture would mean generating the photos
from the same assumptions the pipeline makes, and the suite would then measure
nothing but its own consistency while reporting numbers that read like accuracy.

A room becomes a fixture when someone photographs it, scans it if they can, and
measures its contents by hand. Until then the honest output of this suite is
"certified nothing", which is what it prints.

## Running it

```
pnpm test:golden                          # score every fixture
pnpm test:golden -- --update-baseline     # accept new numbers
pnpm test:golden -- --require-fixtures    # fail if there are none
```

The scoring itself is unit-tested in `packages/recon/test/golden.test.ts`, so
the harness is known to work before there is anything to run it on.
