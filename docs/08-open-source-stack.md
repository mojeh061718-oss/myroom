# 08 · Open-Source Stack & Licensing

Every dependency and asset source, with license and role. **Policy:** runtime dependencies must be MIT / Apache-2.0 / BSD / ISC (or CC0 for assets). GPL/AGPL is acceptable only for *isolated server-side tools we don't link against* — and each such case is flagged below. Bundled content (catalog models, textures, HDRIs) must be **CC0 only** so we can redistribute freely inside scene bundles.

> Verify every license at adoption time against the pinned version — licenses occasionally change between releases. Add a `license-checker` step to CI that fails on anything outside the allowlist.

---

## 1. Frontend

| Dependency | License | Role |
|---|---|---|
| React 18, React Router | MIT | App framework, routing |
| Vite | MIT | Build tool |
| TypeScript | Apache-2.0 | Language |
| three.js | MIT | 3D engine |
| @react-three/fiber, @react-three/drei | MIT | Declarative three.js + helpers (ContactShadows, useGLTF, Environment) |
| three-mesh-bvh | MIT | Fast raycasting for selection/snapping |
| three-bvh-csg | MIT | Boolean subtraction of wall openings |
| Zustand | MIT | State stores |
| zod | MIT | Schema definitions (`packages/schema`) |
| Workbox | MIT | Service worker / PWA caching |
| Lucide icons | ISC | Iconography |
| idb | ISC | IndexedDB wrapper |
| culori | MIT | Color math (Lab k-means display side, palette tools) |

## 2. Backend (Node)

| Dependency | License | Role |
|---|---|---|
| Fastify | MIT | HTTP API |
| BullMQ | MIT | Job queue (Redis) |
| Redis | RSALv2/SSPL dual (≥ 7.4) — **or Valkey (BSD-3)** | Queue + pub/sub. **Decision: deploy Valkey** to stay on the allowlist |
| PostgreSQL | PostgreSQL License (BSD-like) | Metadata |
| Drizzle ORM | Apache-2.0 | DB access |
| jose | MIT | JWT/session tokens |
| @simplewebauthn/server | MIT | Passkey auth |
| sharp | Apache-2.0 | Image transcode (HEIC→JPEG), thumbnails |
| web-push | MIT/Apache-2.0 | VAPID push notifications |

Object storage: any S3-compatible service. Self-hosted dev uses **MinIO (AGPL-3.0)** — acceptable as an unlinked standalone service in dev/CI; production uses a managed S3-compatible provider, so no AGPL obligation attaches to our code.

## 3. Vision workers (Python)

| Dependency | License | Role |
|---|---|---|
| PyTorch | BSD-3 | Inference runtime |
| Grounding DINO (IDEA-Research) | Apache-2.0 | Open-vocabulary object detection |
| SAM 2 (Meta) | Apache-2.0 | Segmentation masks |
| Depth Anything V2 | Apache-2.0 (small/base variants — **verify: the *large* variant is CC-BY-NC; do not ship it**) | Metric monocular depth |
| OpenCLIP | MIT | Image embeddings for catalog matching |
| Open3D | MIT | Point clouds: plane fitting, clustering, ICP registration |
| pye57 | MIT | E57 parsing |
| laspy | BSD-2 | LAS/LAZ parsing |
| trimesh | MIT | Mesh wrangling, GLB IO |
| TinyUSDZ | MIT | RoomPlan USDZ parsing (no Pixar USD build needed) |
| OpenCV (opencv-python) | Apache-2.0 | Image ops, PnP pose solve |
| scikit-learn | BSD-3 | k-means palette extraction |

**Deliberately avoided:** YOLO/ultralytics (AGPL-3.0), OpenMVS (AGPL-3.0), Inria gaussian-splatting reference (non-commercial). COLMAP (BSD-3) is license-fine but unused in v1 — the semantic pipeline doesn't need SfM; keep it in mind for a future "scan-quality" tier alongside gsplat (Apache-2.0).

## 4. Asset pipeline & tooling

| Tool | License | Role |
|---|---|---|
| glTF-Transform | MIT | Catalog GLB optimization: Draco, KTX2/Basis, prune, dedupe |
| Draco | Apache-2.0 | Mesh compression |
| Basis Universal / KTX-Software | Apache-2.0 | Texture compression |
| Playwright | Apache-2.0 | E2E tests |
| Vitest | MIT | Unit tests |
| fast-check | MIT | Property-based geometry tests (doc 04 §7) |
| Storybook | MIT | Component workshop (doc 02 §8) |
| OpenTelemetry SDKs | Apache-2.0 | Tracing |

## 5. CC0 content sources (bundled assets)

| Source | License | What we take |
|---|---|---|
| **Poly Haven** (polyhaven.com) | CC0 | HDRIs (lighting), PBR textures, some furniture/prop models |
| **ambientCG** (ambientcg.com) | CC0 | Floor/wall PBR material library (woods, tiles, carpets, plasters) |
| **Quaternius** (quaternius.com) | CC0 | Furniture model fill-ins (retopologized/restyled through our asset pipeline to match the catalog aesthetic) |
| **Kenney** (kenney.nl) | CC0 | Props/decor fill-ins |
| Commissioned models | CC0 (work-for-hire, released CC0) | Gap-filling the ~600-item launch catalog where CC0 sources lack coverage (quality bar: doc 07 §5 budgets) |

Rules: record `source` + `license` per catalog item in the manifest (doc 07 §5); courtesy attribution in-app on an "Assets" credits screen even though CC0 doesn't require it; **never** bundle CC-BY/CC-BY-NC content — attribution/NC obligations don't survive our redistribution model.

## 6. Formats & standards

| Standard | Role |
|---|---|
| glTF 2.0 (GLB) + Draco + KTX2 extensions | Runtime 3D delivery format |
| Apple RoomPlan export (USDZ + JSON) | First-class LiDAR input (doc 05 §2) |
| PLY, E57 (ASTM E2807), LAS/LAZ | Point-cloud inputs |
| Web App Manifest, Service Worker, Web Push (VAPID), WebAuthn | PWA + auth platform standards |
| RFC 9457 problem+json | API errors |

## 7. CI license gate

`pnpm licenses`-based checker (JS) + `pip-licenses` (Python) run in CI with allowlist `MIT, Apache-2.0, BSD-2, BSD-3, ISC, CC0, PostgreSQL, Python-2.0, Unlicense, 0BSD`. Anything else fails the build and requires an explicit, documented exemption in this file.
