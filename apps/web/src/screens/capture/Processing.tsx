import { useEffect, useMemo, useRef, useState } from "react";
import { formatArea, formatLength } from "@myroom/geometry";
import { useSettings } from "../../stores/settingsStore.js";
import { useNavigate, useParams } from "react-router-dom";
import {
  STAGE_LABELS,
  planLoop,
  planToShell,
  type JobEvent,
  type JobStage,
  type RoomPlan,
} from "@myroom/schema";
import { SCANNED_ITEM_LABEL, type ScanSeedObject } from "@myroom/recon";
import { getCategory, OBJECT_CATEGORIES } from "@myroom/catalog";
import { getProject, listUploads, putProject, type LocalProject, type LocalUpload } from "../../lib/db.js";
import { DEMO_NOTICE, reconstruct, refineFromScan } from "../../lib/reconstruct.js";
import { PillButton } from "../../components/PillButton.js";
import { haptic } from "../../theme/tokens.js";
import { t } from "../../i18n/index.js";
import { notifyRoomReady, requestNotificationPermission } from "../../lib/notify.js";
import { MiniPlan } from "./MiniPlan.js";
import "./capture.css";

/**
 * S6 — Processing (docs/01 §8).
 *
 * The wait is the screen: the drawn plan comes alive as the pipeline reports,
 * with a stage checklist and each found object announced by name and size. It
 * is fully backgroundable, and a failure shows partial results rather than a
 * dead end (docs/05 §8).
 *
 * When a scan measured objects, the flow pauses at a review step: the found
 * items drawn over the plan, each tickable, so the user confirms the layout
 * and the item list BEFORE the room is built (docs/05 §8's "the user decides"
 * principle, applied to contents).
 */

const VISIBLE_STAGES: JobStage[] = ["detect-segment", "depth-scale", "match-texture", "scene-assemble"];

interface FoundObject {
  label: string;
  width: number;
  x: number;
  z: number;
}

const seedLabel = (seed: ScanSeedObject): string =>
  (seed.category && getCategory(seed.category)?.label) ?? SCANNED_ITEM_LABEL;

/**
 * The review's "what is this?" picker. Dimensions can only name the obvious;
 * the person standing in the room knows the rest — and a named box builds as
 * the right shape (a matched catalog model, or the category's massing)
 * instead of a grey block.
 */
const COMMON_CATEGORY_IDS = [
  "sofa",
  "sectional",
  "loveseat",
  "armchair",
  "ottoman",
  "bench",
  "coffee-table",
  "side-table",
  "console-table",
  "dining-table",
  "dining-chair",
  "desk",
  "office-chair",
  "tv",
  "bookshelf",
  "wall-shelf-unit",
  "cabinet",
  "dresser",
  "wardrobe",
  "nightstand",
  "bed",
  "bunk-bed",
  "crib",
  "fridge",
  "range",
  "microwave",
  "washer",
  "dryer",
  "floor-lamp",
  "desk-lamp",
  "rug",
  "trash-can",
  "storage-trunk",
  "potted-plant",
  "coat-rack",
  "mirror",
  "stool",
];
const COMMON_CATEGORIES = COMMON_CATEGORY_IDS.map((id) => getCategory(id)).filter(
  (c): c is NonNullable<ReturnType<typeof getCategory>> => Boolean(c),
);
const OTHER_CATEGORIES = OBJECT_CATEGORIES.filter((c) => !COMMON_CATEGORY_IDS.includes(c.id)).sort((a, b) =>
  a.label.localeCompare(b.label),
);

/**
 * The plan with the scanned objects drawn on it, each tappable to keep or
 * drop. World (x, z) → plan (x, −z); plan +y is north, SVG +y is down.
 */
function SeedReviewPlan({
  plan,
  seeds,
  keep,
  onToggle,
  size = 260,
}: {
  plan: RoomPlan;
  seeds: readonly ScanSeedObject[];
  keep: readonly boolean[];
  onToggle: (index: number) => void;
  size?: number;
}) {
  const loop = planLoop(plan);
  if (!loop || loop.length < 3) return null;
  const xs = loop.map((p) => p.x);
  const ys = loop.map((p) => p.y);
  const minX = Math.min(...xs) - 0.3;
  const maxX = Math.max(...xs) + 0.3;
  const minY = Math.min(...ys) - 0.3;
  const maxY = Math.max(...ys) + 0.3;
  const scale = 100 / Math.max(maxX - minX, maxY - minY, 0.1);
  const px = (x: number, y: number) => [(x - minX) * scale, (maxY - y) * scale] as const;
  const path = loop.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x, p.y)[0].toFixed(1)},${px(p.x, p.y)[1].toFixed(1)}`).join(" ") + " Z";

  return (
    <svg
      viewBox={`0 0 ${(maxX - minX) * scale} ${(maxY - minY) * scale}`}
      width={size}
      height={size}
      role="group"
      aria-label="Objects found in your scan — tap one to keep or drop it"
      data-testid="seed-review-plan"
    >
      <path d={path} fill="rgba(76,141,255,0.08)" stroke="var(--accent)" strokeWidth={1.6} strokeLinejoin="round" />
      {seeds.map((seed, i) => {
        const [cx, cy] = px(seed.position.x, -seed.position.z);
        const w = seed.size.w * scale;
        const d = seed.size.d * scale;
        const kept = keep[i] ?? true;
        // World yaw θ (CCW about +Y) is CCW in plan space; SVG y points down,
        // so the on-screen rotation is −θ.
        const deg = (-(seed.rotationY * 180) / Math.PI).toFixed(1);
        return (
          <g key={i} transform={`translate(${cx.toFixed(1)},${cy.toFixed(1)}) rotate(${deg})`}>
            <rect
              x={-w / 2}
              y={-d / 2}
              width={w}
              height={d}
              rx={1.2}
              fill={kept ? "rgba(95,191,140,0.35)" : "rgba(150,150,150,0.12)"}
              stroke={kept ? "#5FBF8C" : "var(--text-dim)"}
              strokeWidth={kept ? 1.4 : 0.8}
              strokeDasharray={kept ? undefined : "2 2"}
              style={{ cursor: "pointer" }}
              data-testid={`seed-box-${i}`}
              onClick={() => onToggle(i)}
            >
              <title>{seedLabel(seed)}</title>
            </rect>
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={5}
              fill="var(--text)"
              pointerEvents="none"
            >
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface ReviewState {
  seeds: ScanSeedObject[];
  keep: boolean[];
}

export function Processing() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const unit = useSettings((s) => s.displayUnit);
  const [project, setProject] = useState<LocalProject | null>(null);
  const [stage, setStage] = useState<JobStage>("queued");
  const [found, setFound] = useState<FoundObject[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [naming, setNaming] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const started = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const pending = useRef<{ project: LocalProject; plan: RoomPlan; uploads: LocalUpload[]; refined: boolean } | null>(null);

  const runReconstruction = async (
    base: LocalProject,
    plan: RoomPlan,
    uploads: LocalUpload[],
    scanParsed: boolean,
    seeds: ScanSeedObject[],
  ) => {
    const onEvent = (event: JobEvent) => {
      if (event.type === "stage") {
        // docs/02 §5: a light tick as each stage completes, success on the
        // room reveal. Silently absent where the Vibration API isn't.
        setStage((current) => {
          if (current !== event.stage) haptic(event.stage === "done" ? "success" : "light");
          return event.stage;
        });
      }
      if (event.type === "object") {
        setFound((current) => [
          ...current,
          { label: event.label, width: event.size.w, x: event.position.x, z: event.position.z },
        ]);
      }
      if (event.type === "warning") setWarnings((current) => [...current, event.message]);
      if (event.type === "error") setError(event.message);
    };

    try {
      const result = await reconstruct({
        projectId: id,
        plan,
        uploads,
        scanParsed,
        seeds,
        onEvent,
        signal: controllerRef.current?.signal,
      });
      setDemo(result.demo);
      notifyRoomReady(base.name);
      await putProject({
        ...base,
        plan,
        updatedAt: new Date().toISOString(),
        scene: result.scene,
        versions: [
          // Version zero is the room as built, locked forever (docs/01 §11).
          {
            id: result.scene.id,
            name: "Original room",
            scene: structuredClone(result.scene),
            createdAt: new Date().toISOString(),
            locked: true,
          },
          ...(base.versions ?? []),
        ],
      });
    } catch (failure) {
      if ((failure as Error).name === "AbortError") return;
      setError((failure as Error).message);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;

    void (async () => {
      const loaded = await getProject(id);
      if (!loaded) {
        navigate("/", { replace: true });
        return;
      }
      setProject(loaded);
      // Asked here and nowhere else: the reason is on screen, and the user is
      // about to have a reason to leave (docs/03 §5).
      void requestNotificationPermission();
      const uploads = await listUploads(id);

      // Stage 0 first (docs/05 §2): a scan corrects the plan the rest of the
      // pipeline measures against, so it has to happen before anything else.
      let base = loaded;
      let plan = loaded.plan;
      let refined = false;
      let seeds: ScanSeedObject[] = [];
      if (uploads.some((u) => u.kind === "lidar")) {
        setStage("lidar-parse");
        const result = await refineFromScan(loaded.plan, uploads);
        plan = result.plan;
        refined = result.refined;
        seeds = result.seeds;
        setWarnings((current) => [...current, ...result.notes]);
        if (plan !== loaded.plan) {
          base = { ...loaded, plan, updatedAt: new Date().toISOString() };
          await putProject(base);
          setProject(base);
        }

        // Optional AI naming: only with the user's own key, only when the
        // scan left objects unnamed, and never a blocker — any failure keeps
        // the measured boxes.
        const apiKey = useSettings.getState().anthropicKey;
        if (apiKey && result.scanMesh && seeds.some((s) => s.category === null)) {
          setNaming(true);
          // Lazy: the Anthropic SDK only ever loads for users who set a key.
          const { nameScannedObjects } = await import("../../lib/aiNaming.js");
          const named = await nameScannedObjects({
            apiKey,
            scanSeeds: result.scanSeeds,
            scanMesh: result.scanMesh,
            // Room photos see what normal-shaded crops can't — and what the
            // scan's clustering missed entirely.
            photos: uploads.filter((u) => u.kind === "photo").slice(0, 2).map((u) => u.blob),
          });
          seeds = seeds.map((seed, i) =>
            seed.category === null && named.categories[i] ? { ...seed, category: named.categories[i] } : seed,
          );
          if (named.missing.length > 0) {
            // Photo-spotted items have no measured position — line them up
            // mid-room, clearly announced, for the user to drag into place.
            const centre = planToShell(plan)?.center ?? [0, 0, 0];
            seeds = [
              ...seeds,
              ...named.missing.map((m, i) => ({
                category: m.category,
                position: {
                  x: centre[0] + ((i % 3) - 1) * 0.9,
                  y: 0,
                  z: centre[2] + (Math.floor(i / 3) - 0.5) * 0.9,
                },
                rotationY: 0,
                size: m.size,
              })),
            ];
            setWarnings((current) => [
              ...current,
              `${named.missing.length} more item${named.missing.length === 1 ? "" : "s"} spotted in your photos — lined up mid-room, drag them where they go.`,
            ]);
          }
          const note = named.note;
          if (note) setWarnings((current) => [...current, note]);
          setNaming(false);
        }

        if (controller.signal.aborted) return;

        // The scan found things: confirm the layout and the item list before
        // the room is built. The user picks what to keep.
        if (seeds.length > 0) {
          pending.current = { project: base, plan, uploads, refined };
          setReview({ seeds, keep: seeds.map(() => true) });
          return;
        }
      }

      await runReconstruction(base, plan, uploads, refined, seeds);
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, navigate]);

  const confirmReview = () => {
    const state = pending.current;
    if (!state || !review) return;
    const kept = review.seeds.filter((_, i) => review.keep[i]);
    setReview(null);
    haptic("light");
    void runReconstruction(state.project, state.plan, state.uploads, state.refined, kept);
  };

  /**
   * The scan missed something the user can see from where they stand — a
   * fan, a lamp, the trash can. A generic box mid-room beats re-scanning:
   * name it with Swap and drag it home once the room is built.
   */
  const addReviewItem = () => {
    const state = pending.current;
    const centre: readonly [number, number, number] = (state && planToShell(state.plan)?.center) || [0, 0, 0];
    haptic("light");
    setReview((r) => {
      if (!r) return r;
      const added = r.seeds.length;
      return {
        seeds: [
          ...r.seeds,
          {
            category: null,
            position: {
              x: centre[0] + ((added % 3) - 1) * 0.5,
              y: 0,
              z: centre[2] + ((Math.floor(added / 3) % 3) - 1) * 0.5,
            },
            rotationY: 0,
            size: { w: 0.6, d: 0.6, h: 0.9 },
          },
        ],
        keep: [...r.keep, true],
      };
    });
  };

  const shell = useMemo(() => (project ? planToShell(project.plan) : null), [project]);
  const finished = stage === "done";
  const reachedIndex = VISIBLE_STAGES.indexOf(stage);

  return (
    <main className="processing" data-testid="processing">
      <h1 className="type-title">
        {review ? "Here's what your scan found" : finished ? t("recon.ready") : t("recon.building")}
      </h1>

      {naming && (
        <p className="type-caption" aria-live="polite" data-testid="naming-progress">
          Naming what the scan found…
        </p>
      )}

      {review && project ? (
        <div className="seed-review" data-testid="seed-review">
          <SeedReviewPlan
            plan={project.plan}
            seeds={review.seeds}
            keep={review.keep}
            onToggle={(index) =>
              setReview((r) => r && { ...r, keep: r.keep.map((k, i) => (i === index ? !k : k)) })
            }
          />
          {/* The layout question first — no point reviewing furniture inside
              the wrong walls. Corner-fixing is the drawing board's whole job,
              and the scan stays attached, so coming back re-checks everything
              against the corrected walls. */}
          <div className="seed-review-walls">
            <p className="type-caption" style={{ margin: 0 }}>
              Does your layout look correct? These are your walls as the scan measured them
              {project.plan.walls.length > 0 ? ` (${project.plan.walls.length} walls)` : ""}. If a corner is off,
              adjust it — your corrections stick, and the furniture is re-checked against your walls.
            </p>
            <PillButton
              variant="secondary"
              data-testid="review-adjust-walls"
              onClick={() => navigate(`/p/${id}/draw`)}
            >
              Adjust walls
            </PillButton>
          </div>
          <p className="type-caption" style={{ margin: 0 }}>
            {review.seeds.length} object{review.seeds.length === 1 ? "" : "s"} measured from your scan, drawn where
            they were found. Untick anything you don't want in the room — everything stays movable afterwards.
          </p>
          <ul className="seed-review-list">
            {review.seeds.map((seed, i) => (
              <li key={i}>
                <div className="seed-review-item">
                  <label className="seed-review-tick">
                    <input
                      type="checkbox"
                      checked={review.keep[i] ?? true}
                      data-testid={`seed-keep-${i}`}
                      aria-label={`Keep ${seedLabel(seed)} ${i + 1}`}
                      onChange={() =>
                        setReview((r) => r && { ...r, keep: r.keep.map((k, j) => (j === i ? !k : k)) })
                      }
                    />
                    <span className="seed-review-number">{i + 1}</span>
                  </label>
                  <select
                    className="seed-review-pick"
                    value={seed.category ?? ""}
                    data-testid={`seed-name-${i}`}
                    aria-label={`What is item ${i + 1}?`}
                    onChange={(e) =>
                      setReview(
                        (r) =>
                          r && {
                            ...r,
                            seeds: r.seeds.map((s, j) =>
                              j === i ? { ...s, category: e.target.value || null } : s,
                            ),
                          },
                      )
                    }
                  >
                    <option value="">What is this?</option>
                    <optgroup label="Common">
                      {COMMON_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Everything else">
                      {OTHER_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <span className="type-caption seed-review-dims">
                    {formatLength(seed.size.w, unit)} × {formatLength(seed.size.d, unit)} ×{" "}
                    {formatLength(seed.size.h, unit)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <PillButton variant="primary" data-testid="review-build" onClick={confirmReview}>
              Build my room ({review.keep.filter(Boolean).length} item
              {review.keep.filter(Boolean).length === 1 ? "" : "s"})
            </PillButton>
            <PillButton variant="ghost" data-testid="review-add-item" onClick={addReviewItem}>
              + Add an item
            </PillButton>
            <PillButton
              variant="ghost"
              onClick={() =>
                setReview((r) => {
                  if (!r) return r;
                  const all = r.keep.every(Boolean);
                  return { ...r, keep: r.keep.map(() => !all) };
                })
              }
            >
              {review.keep.every(Boolean) ? "Untick all" : "Keep all"}
            </PillButton>
          </div>
        </div>
      ) : (
        <>
          <div className="processing-stage" aria-live="polite">
            {project && (
              <MiniPlan plan={project.plan} size={220} doneWallLabels={project.plan.walls.map((w) => w.label)} />
            )}
            <ul className="processing-found" data-testid="processing-found">
              {found.map((object, i) => (
                <li key={`${object.label}-${i}`} className="processing-found-item">
                  {t("recon.found", { label: object.label, size: formatLength(object.width, unit) })}
                </li>
              ))}
            </ul>
          </div>

          <ol className="processing-stages">
            {VISIBLE_STAGES.map((s, i) => {
              const state = finished || (reachedIndex > i && reachedIndex !== -1) ? "done" : stage === s ? "active" : "waiting";
              return (
                <li key={s} className={`processing-step ${state}`} data-testid={`stage-${s}`}>
                  <span className="processing-tick" aria-hidden>
                    {state === "done" ? "✓" : state === "active" ? "•" : ""}
                  </span>
                  {STAGE_LABELS[s]}
                </li>
              );
            })}
          </ol>
        </>
      )}

      {/* Shown the moment the demo path announces itself, and never when the
          objects came from a scan or from a real worker run. */}
      {(demo || warnings.includes(DEMO_NOTICE)) && (
        <p className="processing-demo" data-testid="processing-demo">
          {DEMO_NOTICE}
        </p>
      )}

      {warnings.filter((w) => w !== DEMO_NOTICE).length > 0 && (
        <ul className="processing-warnings" data-testid="processing-warnings">
          {warnings
            .filter((w) => w !== DEMO_NOTICE)
            .map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
        </ul>
      )}

      {error && (
        <div className="processing-error shake" data-testid="processing-error">
          <p>{error}</p>
          {/* Never a dead end: the shell is exact whatever the pipeline did. */}
          <PillButton onClick={() => navigate(`/p/${id}`)}>{t("recon.openAnyway")}</PillButton>
        </div>
      )}

      <footer className="processing-foot">
        <PillButton
          variant="primary"
          disabled={!finished}
          data-testid="processing-open"
          onClick={() => navigate(`/p/${id}`)}
        >
          {finished ? t("recon.open") : t("recon.building")}
        </PillButton>
        <p className="type-caption">
          {shell ? `${formatArea(shell.floorArea, unit)} · ${project?.plan.walls.length} walls · ` : ""}
          {t("recon.leaveHint")}
        </p>
      </footer>
    </main>
  );
}
