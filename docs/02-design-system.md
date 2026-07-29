# 02 · Design System — "Premium iOS, in a PWA"

The app must feel like a first-party, modern iOS app: calm, spacious, tactile, and confident. This document defines the visual language and the component inventory. It is a *system*, not a mood board — every token below is meant to land in code (`src/theme/tokens.ts` + CSS custom properties).

---

## 1. Design principles

1. **The room is the hero.** Chrome recedes: translucent bars, floating pills, edge-to-edge canvas. UI never competes with the 3D scene.
2. **One primary action per screen.** Every screen has exactly one obvious next step, styled with the accent color. Everything else is secondary.
3. **Physical, not flashy.** Motion mimics physics (springs, not ease-in-out swooshes). Haptics on meaningful events only (snap, closure, completion).
4. **Honest materials.** Glass/blur surfaces for chrome, real PBR materials in-scene. No fake drop-shadow skeuomorphism.

## 2. Typography

System font stack for native feel and zero font-download cost:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable", Roboto, "Helvetica Neue", sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", monospace; /* dimensions, measurements */
```

| Token | Size / weight / tracking | Use |
|---|---|---|
| `display-xl` | 44 px · 700 · −0.02 em | Splash app name |
| `display-l` | 34 px · 700 · −0.015 em | Home masthead, big moments |
| `title` | 22 px · 600 | Screen titles, sheet headers |
| `body` | 17 px · 400 · 1.45 line-height | Default text |
| `label` | 15 px · 500 | Buttons, tabs |
| `caption` | 13 px · 400 | Hints, timestamps, badges |
| `metric` | 15 px · 500 · mono | Dimensions ("6.20 m") — always monospace |

Type scales with iOS Dynamic Type / browser text-size settings (use `rem`, never `px`, in implementation).

## 3. Color

Dual theme; **dark is the default** (3D scenes look richer, and it reads "pro").

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg` | `#0E0F12` | `#F7F7F9` | App background |
| `surface` | `#1A1C21` @ 80% + 20 px blur | `#FFFFFF` @ 78% + 20 px blur | Bars, sheets, cards (glass) |
| `surface-solid` | `#1A1C21` | `#FFFFFF` | Where blur is unavailable/expensive |
| `text` | `#F2F3F5` | `#17181C` | Primary text |
| `text-dim` | `#9BA0AA` | `#6E7480` | Secondary text |
| `accent` | `#4C8DFF` | `#2F6FE4` | The one primary action, links, selection |
| `accent-warm` | `#FFB35C` | `#E8933A` | Accuracy badge (LiDAR tier), highlights |
| `success` | `#5ECC8F` | `#2FA36B` | Completion, quality-check pass |
| `danger` | `#FF6B6B` | `#D64545` | Delete, destructive confirm |
| `canvas-grid` | `#26282E` | `#E4E6EA` | Drawing-board grid lines |

Rules: accent appears **once per screen** as a filled element; contrast ratios ≥ 4.5:1 for text (verify both themes); wall-paint swatches in the editor are *content*, exempt from UI palette rules.

## 4. Surfaces, radius, elevation

- Radius scale: `8 / 12 / 16 / 28` px — small controls / cards / sheets / floating pills.
- Glass recipe: `backdrop-filter: blur(20px) saturate(1.4)` over `surface`; 1 px inner border at 8% white (dark) / 60% white (light). Feature-detect `backdrop-filter`; fall back to `surface-solid`.
- Elevation is expressed by blur + a single soft shadow (`0 8px 32px rgba(0,0,0,0.35)` dark), never stacked shadows.
- Bottom sheets (the workhorse container): detents at 25% / 60% / 92%, grabber handle, spring animation, drag-to-dismiss.

## 5. Motion & haptics

| Event | Motion | Haptic (where supported) |
|---|---|---|
| Screen transitions | 300 ms spring (mass 1, stiffness 260, damping 24), shared-element where natural | — |
| Wall snap / room closure | 120 ms scale-pulse on the snap point | light tick / medium tick |
| Object drag & drop | Object lifts (scale 1.03 + shadow), settles with spring | light tick on snap |
| Processing stage complete | Checkmark draw-on, 250 ms | light tick |
| Room reveal (first build) | 1.5 s establishing orbit + fade-in | success |
| Errors | 3× 60 ms horizontal shake | — |

All motion honors `prefers-reduced-motion` (crossfades only). Haptics via the Vibration API where available; silently absent elsewhere — never a feature gate.

## 6. Iconography & illustration

- Icons: **Lucide** (ISC license) at 1.75 px stroke, 24 px grid — consistent with the SF Symbols feel.
- Tutorial/empty-state illustrations: simple 3D renders made with the app's own engine and CC0 assets (dogfooding the aesthetic; no third-party illustration style to license or match).

## 7. The 3D scene's visual style — "warm realistic-lite"

This is the product's signature look. Target: *an architect's beautiful maquette of your real room* — believable, warm, obviously high-quality, but not chasing photorealism it can't hit on a phone.

- **Lighting:** single neutral-warm HDRI environment (Poly Haven, CC0) for image-based lighting + one soft directional key through the room's window openings. Baked/SSAO ambient occlusion; contact shadows under every object (drei `ContactShadows`).
- **Materials:** full PBR (metalness/roughness). Walls slightly rough matte; photo-derived colors are applied as albedo on catalog geometry.
- **Tone mapping:** ACES filmic, exposure tuned so whites stay creamy, never blown.
- **Camera:** 35 mm-equivalent default FOV; dollhouse view is a slight tilt-shift feel (gentle depth-of-field in screenshots only, never live).
- **Anti-aliasing/performance:** MSAA where available, TAA fallback; target 60 fps on iPhone 12-class, 30 fps floor on 2 GB Android devices with automatic quality stepping (pixel-ratio, shadow resolution, AO off) — see [`06-sandbox-and-editing.md`](06-sandbox-and-editing.md) §8.

## 8. Component inventory

Build once in Storybook, reuse everywhere:

`AppBar(glass)` · `BottomBar(glass)` · `PillButton(primary/secondary/ghost)` · `Sheet(detents)` · `Card(project/tutorial)` · `SegmentedControl(2D/3D, m/ft)` · `Stepper` · `ProgressStages` (processing checklist) · `AccuracyBadge(sketch/photo/lidar)` · `DimensionLabel` (tappable, mono) · `ColorSheet` (palettes + wheel + eyedropper) · `CatalogGrid` (virtualized) · `ObjectInfoCard` · `VersionStrip` · `CompareSlider` · `Toast` · `ConfirmDialog(destructive)` · `EmptyState` · `TutorialPager`

Each component ships with: dark + light rendering, reduced-motion behavior, RTL support, and a touch target ≥ 44×44 px.

## 9. Accessibility checklist (ship-blocking)

- All flows completable with VoiceOver/TalkBack; the 3D canvas exposes an accessible object list ("Sofa, 2.2 meters, against north wall — actions: move, edit, remove") as a parallel navigation path.
- Contrast ≥ 4.5:1 (text), ≥ 3:1 (essential UI); never color-only state (badges carry text).
- Full keyboard operation on desktop (drawing board: arrow-key nudge, enter-to-type-dimension; sandbox: WASD-orbit + tab-cycle objects).
- Dynamic Type up to 135% without layout breakage.
