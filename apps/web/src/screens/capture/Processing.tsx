import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  STAGE_LABELS,
  planToShell,
  type JobEvent,
  type JobStage,
} from "@myroom/schema";
import { getProject, listUploads, putProject, type LocalProject } from "../../lib/db.js";
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
 */

const VISIBLE_STAGES: JobStage[] = ["detect-segment", "depth-scale", "match-texture", "scene-assemble"];

interface FoundObject {
  label: string;
  width: number;
  x: number;
  z: number;
}

export function Processing() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<LocalProject | null>(null);
  const [stage, setStage] = useState<JobStage>("queued");
  const [found, setFound] = useState<FoundObject[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const controller = new AbortController();

    void (async () => {
      const found = await getProject(id);
      if (!found) {
        navigate("/", { replace: true });
        return;
      }
      setProject(found);
      // Asked here and nowhere else: the reason is on screen, and the user is
      // about to have a reason to leave (docs/03 §5).
      void requestNotificationPermission();
      const uploads = await listUploads(id);

      // Stage 0 first (docs/05 §2): a scan corrects the plan the rest of the
      // pipeline measures against, so it has to happen before anything else.
      let plan = found.plan;
      let refined = false;
      let seeds: Awaited<ReturnType<typeof refineFromScan>>["seeds"] = [];
      if (uploads.some((u) => u.kind === "lidar")) {
        setStage("lidar-parse");
        const result = await refineFromScan(found.plan, uploads);
        plan = result.plan;
        refined = result.refined;
        seeds = result.seeds;
        setWarnings((current) => [...current, ...result.notes]);
        if (plan !== found.plan) {
          await putProject({ ...found, plan, updatedAt: new Date().toISOString() });
          setProject({ ...found, plan });
        }
      }

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
          scanParsed: refined,
          seeds,
          onEvent,
          signal: controller.signal,
        });
        setDemo(result.demo);
        notifyRoomReady(found.name);
        await putProject({
          ...found,
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
            ...(found.versions ?? []),
          ],
        });
      } catch (failure) {
        if ((failure as Error).name === "AbortError") return;
        setError((failure as Error).message);
      }
    })();

    return () => controller.abort();
  }, [id, navigate]);

  const shell = useMemo(() => (project ? planToShell(project.plan) : null), [project]);
  const finished = stage === "done";
  const reachedIndex = VISIBLE_STAGES.indexOf(stage);

  return (
    <main className="processing" data-testid="processing">
      <h1 className="type-title">{finished ? t("recon.ready") : t("recon.building")}</h1>

      <div className="processing-stage" aria-live="polite">
        {project && (
          <MiniPlan plan={project.plan} size={220} doneWallLabels={project.plan.walls.map((w) => w.label)} />
        )}
        <ul className="processing-found" data-testid="processing-found">
          {found.map((object, i) => (
            <li key={`${object.label}-${i}`} className="processing-found-item">
              {t("recon.found", { label: object.label, size: object.width.toFixed(1) })}
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
          {shell ? `${shell.floorArea.toFixed(1)} m² · ${project?.plan.walls.length} walls · ` : ""}
          {t("recon.leaveHint")}
        </p>
      </footer>
    </main>
  );
}
