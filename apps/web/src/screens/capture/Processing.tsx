import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  STAGE_LABELS,
  planToShell,
  type JobEvent,
  type JobStage,
} from "@myroom/schema";
import { getProject, listUploads, putProject, type LocalProject } from "../../lib/db.js";
import { DEMO_NOTICE, hasApi, reconstruct } from "../../lib/reconstruct.js";
import { PillButton } from "../../components/PillButton.js";
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
      const uploads = await listUploads(id);

      const onEvent = (event: JobEvent) => {
        if (event.type === "stage") setStage(event.stage);
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
          plan: found.plan,
          uploads,
          onEvent,
          signal: controller.signal,
        });
        setDemo(result.demo);
        await putProject({
          ...found,
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
    <div className="processing" data-testid="processing">
      <h1 className="type-title">{finished ? "Your room is ready" : "Building your room…"}</h1>

      <div className="processing-stage" aria-live="polite">
        {project && (
          <MiniPlan plan={project.plan} size={220} doneWallLabels={project.plan.walls.map((w) => w.label)} />
        )}
        <ul className="processing-found" data-testid="processing-found">
          {found.map((object, i) => (
            <li key={`${object.label}-${i}`} className="processing-found-item">
              Found: {object.label} · {object.width.toFixed(1)} m
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

      {(demo || !hasApi) && (
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
        <div className="processing-error" data-testid="processing-error">
          <p>{error}</p>
          {/* Never a dead end: the shell is exact whatever the pipeline did. */}
          <PillButton onClick={() => navigate(`/p/${id}`)}>Open the room anyway</PillButton>
        </div>
      )}

      <footer className="processing-foot">
        <PillButton
          variant="primary"
          disabled={!finished}
          data-testid="processing-open"
          onClick={() => navigate(`/p/${id}`)}
        >
          {finished ? "See your room" : "Building…"}
        </PillButton>
        <p className="type-caption">
          {shell ? `${shell.floorArea.toFixed(1)} m² · ${project?.plan.walls.length} walls` : ""} · You can leave this
          screen; we'll keep going.
        </p>
      </footer>
    </div>
  );
}
