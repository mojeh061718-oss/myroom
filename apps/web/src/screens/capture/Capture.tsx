import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { capturePlanFor, missingWallShots, type CaptureShot } from "@myroom/schema";
import { getProject, listUploads, putUpload, deleteUpload, type LocalProject, type LocalUpload } from "../../lib/db.js";
import { measurePhotoQuality } from "../../lib/photoQuality.js";
import { uuidv7 } from "../../lib/uuid.js";
import { PillButton } from "../../components/PillButton.js";
import { useToasts } from "../../components/Toast.js";
import { MiniPlan } from "./MiniPlan.js";
import "./capture.css";

/**
 * S4 — guided photo capture (docs/01 §6).
 *
 * The plan drives the shot list: one photo per wall to proceed, corner shots
 * offered, close-ups unlimited. Every photo gets an instant quality check whose
 * verdict is advice, never a block, and every photo is tagged to a wall with
 * one tap on the mini-plan.
 */
export function Capture() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const showToast = useToasts((s) => s.show);
  const [project, setProject] = useState<LocalProject | null>(null);
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [activeShot, setActiveShot] = useState<CaptureShot | null>(null);
  const [busy, setBusy] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const found = await getProject(id);
      if (!found) {
        navigate("/", { replace: true });
        return;
      }
      setProject(found);
      setUploads(await listUploads(id));
    })();
  }, [id, navigate]);

  const capture = useMemo(() => (project ? capturePlanFor(project.plan) : null), [project]);
  const photos = uploads.filter((u) => u.kind === "photo");
  const taggedWalls = [...new Set(photos.map((p) => p.wallLabel).filter((l): l is string => Boolean(l)))];
  const missing = project ? missingWallShots(project.plan, taggedWalls) : [];
  const wallShots = capture?.shots.filter((s) => s.kind === "wall") ?? [];
  const nextShot = activeShot ?? wallShots.find((s) => missing.includes(s.wallLabels[0] ?? "")) ?? null;
  const activeWallId = project?.plan.walls.find((w) => w.label === nextShot?.wallLabels[0])?.id ?? null;

  const addFiles = async (files: FileList | null, wallLabel: string | null) => {
    if (!files?.length || !project) return;
    setBusy(true);
    try {
      const added: LocalUpload[] = [];
      for (const file of Array.from(files)) {
        let quality = null;
        try {
          quality = await measurePhotoQuality(file);
        } catch {
          // A format the browser can't decode still uploads — the pipeline
          // reads more formats than canvas does (HEIC, most notably).
          quality = null;
        }
        const upload: LocalUpload = {
          id: uuidv7(),
          projectId: project.id,
          kind: "photo",
          filename: file.name || `wall-${wallLabel ?? "x"}.jpg`,
          wallLabel,
          shotId: nextShot?.id ?? null,
          blob: file,
          quality,
          createdAt: new Date().toISOString(),
          remoteId: null,
        };
        await putUpload(upload);
        added.push(upload);
      }
      // One toast for the batch: each card already carries its own advice, and
      // eight identical toasts would bury the photos they're about.
      const flagged = added.filter((u) => u.quality?.advice);
      if (flagged.length === 1) showToast(flagged[0]!.quality!.advice!);
      else if (flagged.length > 1) showToast(`${flagged.length} of those could be better — see the notes below.`);
      setUploads((current) => [...current, ...added]);
      setActiveShot(null);
    } finally {
      setBusy(false);
      if (cameraInput.current) cameraInput.current.value = "";
      if (libraryInput.current) libraryInput.current.value = "";
    }
  };

  const remove = async (upload: LocalUpload) => {
    await deleteUpload(upload.id);
    setUploads((current) => current.filter((u) => u.id !== upload.id));
  };

  const retag = async (upload: LocalUpload, wallLabel: string) => {
    const next = { ...upload, wallLabel };
    await putUpload(next);
    setUploads((current) => current.map((u) => (u.id === upload.id ? next : u)));
  };

  if (!project || !capture) return <div className="capture" />;

  const photographed = project.plan.walls.length - missing.length;

  return (
    <div className="capture" data-testid="capture">
      <header className="capture-head">
        <button className="back" onClick={() => navigate(`/p/${id}/draw`)} aria-label="Back to the floor plan">
          ‹
        </button>
        <h1 className="type-title">Photograph the room</h1>
      </header>

      <div className="capture-guide">
        <MiniPlan
          plan={project.plan}
          activeWallId={activeWallId}
          doneWallLabels={taggedWalls}
          onPickWall={(wallId) => {
            const wall = project.plan.walls.find((w) => w.id === wallId);
            const shot = wallShots.find((s) => s.wallLabels[0] === wall?.label);
            if (shot) setActiveShot(shot);
          }}
        />
        <div className="capture-prompt">
          <p className="type-body" data-testid="capture-prompt">
            {nextShot?.prompt ?? "Every wall is photographed. Add close-ups of anything you care about, or continue."}
          </p>
          <p className="type-metric capture-progress" data-testid="capture-progress">
            {photographed} of {project.plan.walls.length} walls photographed
          </p>
        </div>
      </div>

      <div className="capture-actions">
        {/* `capture="environment"` opens the camera on a phone and falls back to
            the file picker everywhere else — one control, both paths. */}
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid="capture-camera-input"
          onChange={(e) => void addFiles(e.target.files, nextShot?.wallLabels[0] ?? null)}
        />
        <input
          ref={libraryInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="capture-library-input"
          onChange={(e) => void addFiles(e.target.files, nextShot?.wallLabels[0] ?? null)}
        />
        <PillButton variant="primary" onClick={() => cameraInput.current?.click()} disabled={busy}>
          Take photo
        </PillButton>
        <PillButton onClick={() => libraryInput.current?.click()} disabled={busy}>
          Choose from library
        </PillButton>
      </div>

      {photos.length > 0 && (
        <ul className="capture-strip" data-testid="capture-strip">
          {photos.map((photo) => (
            <li key={photo.id} className={`capture-thumb ${photo.quality?.verdict ?? "good"}`}>
              <Thumb upload={photo} />
              <div className="capture-thumb-meta">
                <select
                  aria-label={`Which wall is ${photo.filename} of?`}
                  value={photo.wallLabel ?? ""}
                  data-testid={`retag-${photo.id}`}
                  onChange={(e) => void retag(photo, e.target.value)}
                >
                  <option value="">Untagged</option>
                  {project.plan.walls.map((wall) => (
                    <option key={wall.id} value={wall.label}>
                      Wall {wall.label}
                    </option>
                  ))}
                </select>
                <button className="capture-remove" onClick={() => void remove(photo)} aria-label={`Remove ${photo.filename}`}>
                  Remove
                </button>
              </div>
              {photo.quality?.advice && <p className="capture-advice">{photo.quality.advice}</p>}
            </li>
          ))}
        </ul>
      )}

      <footer className="capture-foot">
        <PillButton
          variant="primary"
          data-testid="capture-continue"
          onClick={() => navigate(`/p/${id}/scan`)}
        >
          {missing.length === 0 ? "Continue" : `Continue anyway (${missing.length} wall${missing.length > 1 ? "s" : ""} missing)`}
        </PillButton>
        <p className="type-caption capture-privacy">
          Your photos stay on this device until you build the room, and are used only to build <em>your</em> room.
        </p>
      </footer>
    </div>
  );
}

function Thumb({ upload }: { upload: LocalUpload }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(upload.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [upload.blob]);
  return url ? <img src={url} alt={upload.wallLabel ? `Wall ${upload.wallLabel}` : upload.filename} /> : <div className="capture-thumb-blank" />;
}
