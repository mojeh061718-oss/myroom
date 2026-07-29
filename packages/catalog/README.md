# packages/catalog

Catalog manifest + asset pipeline scripts (docs/07 §5, docs/08 §5). The ~600-item
CC0 launch catalog is built in **Milestone M3**; this package is scaffolded early so
the monorepo layout (docs/03 §2) is stable.

Rules that will be enforced by the asset pipeline here:

- Bundled assets are **CC0 only** (Poly Haven, ambientCG, Quaternius, Kenney,
  commissioned-CC0). Never CC-BY / CC-BY-NC (docs/08 §5).
- Catalog GLBs ≤ 15k tris, Draco + KTX2 compressed (docs/06 §8, docs/07 §5).
- Every manifest entry records `license` + `source` (docs/07 §5).
