"""My Room Sandbox reconstruction workers (docs/05).

Stage ownership (see DECISIONS.md → "Where the pipeline's non-pixel stages run"):

* Stage 0  ``stage0_scan``   — LiDAR/scan parse and registration to the drawn plan
* Stage 1  ``detect``        — open-vocabulary detection + segmentation (needs weights)
* Stage 2  ``solve``         — camera pose and metric-depth rescale
* Stage 3  ``measure``       — mask + depth → oriented bounding box
* Stage 5  ``appearance``    — dominant-colour palette from the mask crop

Stages 4 (catalog match) and 6 (assembly) run in TypeScript, in
``packages/recon``, because the catalog manifest is a TypeScript package.

Every artifact these modules emit is validated against the JSON Schema
generated from ``packages/schema`` — see :mod:`myroom_vision.schemas`.
"""

__all__ = ["schemas", "stage0_scan", "measure", "solve", "appearance", "detect"]
