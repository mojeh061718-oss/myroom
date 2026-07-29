import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  DoorOpen,
  MousePointer2,
  Pencil,
  Redo2,
  Ruler,
  Scissors,
  RectangleHorizontal,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { formatArea, formatLength, parseDisplayLength, type DisplayUnit } from "@myroom/geometry";
import { parseMeshScan, parsePointCloudScan, SCAN_EXTENSIONS } from "@myroom/recon";
import { OBJECT_CATEGORIES } from "@myroom/catalog";
import { decodeScanFile } from "../../lib/scanDecode.js";
import { listUploads, putUpload, deleteUpload, type LocalUpload } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";
import { usableFloorArea, wallLength } from "@myroom/schema";
import { useDrawing, type Tool } from "../../stores/drawingStore.js";
import { useSettings } from "../../stores/settingsStore.js";
import { useToasts } from "../../components/Toast.js";
import { PillButton } from "../../components/PillButton.js";
import { Sheet } from "../../components/Sheet.js";
import { BoardCanvas } from "./BoardCanvas.js";
import "./board.css";

const TOOLS: { id: Tool; label: string; icon: typeof Pencil }[] = [
  { id: "room", label: "Room", icon: Square },
  { id: "wall", label: "Wall", icon: Pencil },
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "door", label: "Door", icon: DoorOpen },
  { id: "window", label: "Window", icon: RectangleHorizontal },
  { id: "measure", label: "Measure", icon: Ruler },
];

function rejectionCopy(reason: "tooShort" | "selfIntersect" | "openingOverlap" | "invalid", unit: DisplayUnit): string {
  switch (reason) {
    case "tooShort":
      // MIN_WALL_LENGTH is 0.3 m; the friendly figure in each unit.
      return unit === "ft" ? 'Walls need to be at least 12" long' : "Walls need to be at least 0.3 m long";
    case "selfIntersect":
      return "Walls can't cross each other";
    case "openingOverlap":
      return "Openings can't overlap or hang off the wall";
    default:
      return "That doesn't work here";
  }
}

function HeightSheet() {
  const open = useDrawing((s) => s.heightSheetOpen);
  const setOpen = useDrawing((s) => s.setHeightSheetOpen);
  const setHeights = useDrawing((s) => s.setHeights);
  const unit = useSettings((s) => s.displayUnit);
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  // docs/04 §5: default 2.44 m / 8 ft; presets 2.4 / 2.7 / 3.0 m; custom field.
  // Whole feet, so the label the user taps is the number the wall reads back.
  // The old metric presets rendered as 7'10½", 8'10¼" and 9'10" — technically
  // correct and useless to anyone building a room in feet.
  // `id` is what the test hooks address: keying them off the metre value made
  // every preset change a rename across five E2E specs.
  const presets = [
    { id: "8ft", m: 8 * 0.3048, standard: true },
    { id: "9ft", m: 9 * 0.3048, standard: false },
    { id: "10ft", m: 10 * 0.3048, standard: false },
    { id: "12ft", m: 12 * 0.3048, standard: false },
  ].map((p) => ({ ...p, label: p.standard ? `${formatLength(p.m, unit)} (standard)` : formatLength(p.m, unit) }));

  const choose = (m: number) => {
    setHeights(m);
    setOpen(false);
  };

  return (
    <Sheet open={open} onClose={() => setOpen(false)} labelledBy="height-sheet-title">
      <h2 id="height-sheet-title" className="type-title" style={{ margin: 0 }}>
        How tall are your walls?
      </h2>
      <p className="type-caption" style={{ margin: "4px 0 0" }}>
        One height for the whole room — you can refine per wall later.
      </p>
      <div className="height-presets">
        {presets.map((p) => (
          <PillButton key={p.label} onClick={() => choose(p.m)} data-testid={`height-${p.id}`}>
            {p.label}
          </PillButton>
        ))}
      </div>
      <form
        style={{ display: "flex", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const m = parseDisplayLength(custom, unit);
          if (m === null) {
            setCustomError("We couldn't read that height — try something like " + (unit === "ft" ? `9' or 9'6"` : "2.6 m"));
            return;
          }
          if (m < 2 || m > 6) {
            setCustomError(`Wall heights go from ${formatLength(2, unit)} to ${formatLength(6, unit)}`);
            return;
          }
          setCustomError(null);
          choose(m);
        }}
      >
        <input
          className="metric-field"
          style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--surface-border)",
            borderRadius: "var(--radius-sm)",
            minHeight: 44,
            padding: "0 12px",
          }}
          placeholder={unit === "ft" ? `Custom — e.g. 9'6"` : "Custom — e.g. 2.6 m"}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setCustomError(null);
          }}
          aria-label="Custom wall height"
          aria-invalid={customError !== null || undefined}
        />
        <PillButton type="submit" variant="primary">
          Set
        </PillButton>
      </form>
      {customError && (
        <p className="type-caption" role="alert" style={{ margin: "6px 0 0", color: "var(--danger)" }}>
          {customError}
        </p>
      )}
    </Sheet>
  );
}

/** Wall thickness in the display unit's small denomination: mm, or inches. */
function formatThickness(meters: number, unit: DisplayUnit): string {
  if (unit === "m") return `${Math.round(meters * 1000)} mm`;
  const quarters = Math.round(meters / 0.0254 / 0.25);
  const whole = Math.floor(quarters / 4);
  const frac = quarters % 4;
  const fracStr = frac === 0 ? "" : frac === 1 ? "¼" : frac === 2 ? "½" : "¾";
  return `${whole === 0 && fracStr ? "" : whole}${fracStr}"`;
}

/**
 * Wall thickness editor (docs/04 §3): presets for the common builds plus a
 * custom field. A bare number is millimetres in metric, inches in ft-mode —
 * the same denomination the button shows.
 */
function ThicknessSheet({
  open,
  current,
  unit,
  onClose,
  onSet,
}: {
  open: boolean;
  current: number;
  unit: DisplayUnit;
  onClose: () => void;
  onSet: (meters: number) => void;
}) {
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCustom("");
      setError(null);
    }
  }, [open]);

  const presets = [0.1, 0.14, 0.2];

  const submit = () => {
    const s = custom.trim().replace(/″/g, '"').replace(/¼/g, ".25").replace(/½/g, ".5").replace(/¾/g, ".75");
    const numeric = /^(\d+(?:[.,]\d+)?|[.,]\d+)\s*(mm|cm|m|"|in|inches)?$/i.exec(s);
    if (!numeric) {
      setError(`Try a number of ${unit === "ft" ? "inches" : "millimetres"} — like ${unit === "ft" ? "6" : "150"}`);
      return;
    }
    const value = parseFloat(numeric[1]!.replace(",", "."));
    const suffix = numeric[2]?.toLowerCase();
    const meters =
      suffix === "mm" ? value / 1000
      : suffix === "cm" ? value / 100
      : suffix === "m" ? value
      : suffix === '"' || suffix === "in" || suffix === "inches" ? value * 0.0254
      : unit === "ft" ? value * 0.0254
      : value / 1000;
    if (meters < 0.05 || meters > 0.5) {
      setError(`Thickness goes from ${formatThickness(0.05, unit)} to ${formatThickness(0.5, unit)}`);
      return;
    }
    onSet(meters);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy="thickness-sheet-title">
      <h2 id="thickness-sheet-title" className="type-title" style={{ margin: 0 }}>
        Wall thickness
      </h2>
      <p className="type-caption" style={{ margin: "4px 0 0" }}>
        Currently {formatThickness(current, unit)}
      </p>
      <div className="height-presets">
        {presets.map((m) => (
          <PillButton key={m} data-testid={`thickness-${Math.round(m * 1000)}`} onClick={() => { onSet(m); onClose(); }}>
            {formatThickness(m, unit)}
          </PillButton>
        ))}
      </div>
      <form
        style={{ display: "flex", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="metric-field"
          style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--surface-border)",
            borderRadius: "var(--radius-sm)",
            minHeight: 44,
            padding: "0 12px",
          }}
          placeholder={unit === "ft" ? `Custom — inches, e.g. 6` : "Custom — mm, e.g. 150"}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setError(null);
          }}
          aria-label="Custom wall thickness"
          aria-invalid={error !== null || undefined}
          data-testid="thickness-custom"
        />
        <PillButton type="submit" variant="primary">
          Set
        </PillButton>
      </form>
      {error && (
        <p className="type-caption" role="alert" style={{ margin: "6px 0 0", color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </Sheet>
  );
}

function ContextPill() {
  const selection = useDrawing((s) => s.selection);
  const plan = useDrawing((s) => s.plan);
  const unit = useSettings((s) => s.displayUnit);
  const [lengthDraft, setLengthDraft] = useState<string | null>(null);
  const [thicknessOpen, setThicknessOpen] = useState(false);
  const state = useDrawing.getState;

  useEffect(() => {
    setLengthDraft(null);
    setThicknessOpen(false);
  }, [selection]);

  if (!selection || !plan) return null;

  if (selection.kind === "wall") {
    const wall = plan.walls.find((w) => w.id === selection.wallId);
    if (!wall) return null;
    const length = wallLength(plan, wall);
    return (
      <div className="context-pill glass" data-testid="context-pill">
        <input
          className="metric-field"
          aria-label={`Wall ${wall.label} length`}
          value={lengthDraft ?? formatLength(length, unit)}
          onFocus={(e) => {
            setLengthDraft(formatLength(length, unit));
            e.target.select();
          }}
          onChange={(e) => setLengthDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && lengthDraft) {
              const m = parseDisplayLength(lengthDraft, unit);
              if (m !== null) state().setTypedLength(wall.id, m);
              setLengthDraft(null);
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") setLengthDraft(null);
          }}
        />
        <button className="icon-button" aria-label="Split wall" onClick={() => state().splitWall(wall.id)}>
          <Scissors size={18} />
          <span>Split</span>
        </button>
        <button
          className="icon-button"
          aria-label="Wall thickness"
          data-testid="thickness-button"
          onClick={() => setThicknessOpen(true)}
        >
          <span className="type-metric">{formatThickness(wall.thickness, unit)}</span>
          <span>thick</span>
        </button>
        <button className="icon-button" aria-label="Delete wall" onClick={() => state().deleteWall(wall.id)} data-testid="delete-wall">
          <Trash2 size={18} />
          <span>Delete</span>
        </button>
        <ThicknessSheet
          open={thicknessOpen}
          current={wall.thickness}
          unit={unit}
          onClose={() => setThicknessOpen(false)}
          onSet={(m) => state().setWallThickness(wall.id, m)}
        />
      </div>
    );
  }

  if (selection.kind === "opening") {
    const wall = plan.walls.find((w) => w.id === selection.wallId);
    const opening = wall?.openings.find((o) => o.id === selection.openingId);
    if (!wall || !opening) return null;
    return (
      <div className="context-pill glass" data-testid="context-pill">
        <input
          className="metric-field"
          aria-label="Opening width"
          value={lengthDraft ?? formatLength(opening.width, unit)}
          onFocus={(e) => {
            setLengthDraft(formatLength(opening.width, unit));
            e.target.select();
          }}
          onChange={(e) => setLengthDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && lengthDraft) {
              const m = parseDisplayLength(lengthDraft, unit);
              if (m !== null) state().updateOpening(wall.id, opening.id, { width: m }, true);
              setLengthDraft(null);
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") setLengthDraft(null);
          }}
        />
        {opening.kind === "door" && (
          <button
            className="icon-button"
            aria-label="Toggle door swing"
            data-testid="swing-toggle"
            onClick={() =>
              state().updateOpening(wall.id, opening.id, { swing: opening.swing === "left" ? "right" : "left" }, true)
            }
          >
            <DoorOpen size={18} style={{ transform: opening.swing === "right" ? "scaleX(-1)" : undefined }} />
            <span>{opening.swing === "right" ? "Right" : "Left"}</span>
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Delete opening"
          data-testid="delete-opening"
          onClick={() => state().deleteOpening(wall.id, opening.id)}
        >
          <Trash2 size={18} />
          <span>Delete</span>
        </button>
      </div>
    );
  }

  return null;
}

/** S3 — Drawing Board (docs/01 §5, docs/04). */
export function DrawingBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const loadProject = useDrawing((s) => s.loadProject);
  const plan = useDrawing((s) => s.plan);
  const projectName = useDrawing((s) => s.projectName);
  const tool = useDrawing((s) => s.tool);
  const setTool = useDrawing((s) => s.setTool);

  /**
   * Publish the top bar's real height so overlays can sit below it.
   *
   * The bar wraps: at <= 620px the "Next: add photos" button takes a full-width
   * second row, which made it about twice the 72px the hint had hardcoded, so
   * the two drew on top of each other.
   *
   * A callback ref rather than useRef + useEffect, because this screen renders
   * a placeholder while it loads the project: on first mount the top bar does
   * not exist, so an effect with [] deps saw a null ref, bailed, and never ran
   * again once the real bar appeared. That is exactly how the first attempt at
   * this fix failed — measured 72px, hint still overlapping.
   */
  const settings = useSettings();
  /**
   * Import a LiDAR scan and let it build the room (docs/05 §2).
   *
   * The scan-first path. A scan is a measurement and drawing a room on a phone
   * is the fiddliest thing this app asks for, so the scan produces the plan and
   * the person tidies it. Everything runs on the device: the file never leaves
   * it, and there is no server involved.
   */
  const scanInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  const importScan = useCallback(
    async (file: File) => {
      setImporting(true);
      setImportNote(null);
      try {
        const geometry = await decodeScanFile(file);
        if (geometry.kind === "error") {
          setImportNote(`We couldn't read that scan: ${geometry.reason}.`);
          return;
        }
        if (geometry.kind === "roomplan-json") {
          setImportNote("That's a RoomPlan file — add it on the scan step after drawing, and it'll correct your walls.");
          return;
        }

        const parsed =
          geometry.kind === "mesh"
            ? parseMeshScan(geometry.positions, geometry.indices, geometry.format, { categories: OBJECT_CATEGORIES })
            : parsePointCloudScan(geometry.positions, geometry.format, { categories: OBJECT_CATEGORIES });
        if (!parsed.parsed || parsed.walls.length < 3) {
          setImportNote(parsed.failure ?? "We couldn't find a room in that scan.");
          return;
        }

        // Centre the room on the origin, so it lands where the viewport is
        // looking rather than wherever the scanner happened to start.
        const points = parsed.walls.map((w) => w.start);
        const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const centred = points.map((p) => ({ x: p.x - cx, y: p.y - cy }));

        const result = useDrawing.getState().buildFromOutline(centred, parsed.ceilingHeight);
        if (result !== "closed") {
          setImportNote("That scan traced a shape we couldn't turn into a room. Try drawing it instead.");
          return;
        }

        // Keep the file as this project's scan, so the build step reads the
        // furniture out of it without asking for the same upload twice.
        if (id) {
          const existing = await listUploads(id);
          for (const upload of existing) {
            if (upload.kind === "lidar") await deleteUpload(upload.id);
          }
          const upload: LocalUpload = {
            id: uuidv7(),
            projectId: id,
            kind: "lidar",
            filename: file.name,
            wallLabel: null,
            shotId: null,
            blob: file,
            quality: null,
            createdAt: new Date().toISOString(),
            remoteId: null,
          };
          await putUpload(upload);
        }

        const pieces = parsed.seedBoxes.length;
        const ceiling =
          parsed.ceilingHeight !== null
            ? `, ${formatLength(parsed.ceilingHeight, settings.displayUnit)} ceiling`
            : "";
        const found =
          pieces > 0
            ? ` It also found ${pieces} thing${pieces === 1 ? "" : "s"} in the room — you'll pick which ones to keep before we build.`
            : "";
        setImportNote(
          `Measured from your scan: ${parsed.walls.length} walls${ceiling}. Drag any corner to adjust.${found}`,
        );
      } catch (error) {
        setImportNote(`We couldn't read that file (${(error as Error).message}).`);
      } finally {
        setImporting(false);
      }
    },
    [settings.displayUnit, id],
  );

  const measureTopbar = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!element) return;
    const publish = () => {
      const host = element.parentElement;
      if (host) host.style.setProperty("--board-topbar-h", `${element.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    observerRef.current = observer;
  }, []);
  const observerRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  const rejection = useDrawing((s) => s.rejection);
  const undoLen = useDrawing((s) => s.undoStack.length);
  const redoLen = useDrawing((s) => s.redoStack.length);
  const showToast = useToasts((s) => s.show);
  const [missing, setMissing] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    void loadProject(id).then((ok) => setMissing(!ok));
  }, [id, loadProject]);

  useEffect(() => {
    if (!rejection) return;
    setShakeKey(rejection.at);
    showToast(rejectionCopy(rejection.reason, useSettings.getState().displayUnit));
  }, [rejection, showToast]);

  const wallCount = plan?.walls.length ?? 0;
  const badge = useMemo(() => {
    if (!plan) return null;
    if (plan.closed && plan.floorArea != null) {
      return { closed: true, text: `Closed ✓ · ${formatArea(usableFloorArea(plan) ?? plan.floorArea, settings.displayUnit)}` };
    }
    return { closed: false, text: `Open · ${wallCount} wall${wallCount === 1 ? "" : "s"}` };
  }, [plan, wallCount, settings.displayUnit]);

  if (missing) {
    return (
      <div className="stub-screen">
        <p>This room doesn't exist on this device.</p>
        <PillButton onClick={() => navigate("/")}>Back to home</PillButton>
      </div>
    );
  }
  if (!plan) return null;

  const state = useDrawing.getState;

  return (
    <div className="board" data-testid="drawing-board">
      <div key={shakeKey} className={shakeKey ? "shake-wrap shake" : "shake-wrap"}>
        <BoardCanvas />
      </div>

      <div className="board-topbar" ref={measureTopbar}>
        <button className="icon-button glass" style={{ borderRadius: "var(--radius-pill)" }} aria-label="Back to projects" onClick={() => navigate("/")}>
          <ChevronLeft size={22} />
        </button>
        <span className="type-label" style={{ maxWidth: "26vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {projectName}
        </span>
        <div className="spacer" />
        <div className={`validation-badge ${badge?.closed ? "closed" : ""}`} data-testid="validation-badge">
          {badge?.text}
        </div>
        <span
          className="primary-action"
          title={plan.closed ? undefined : "Close your room to continue — join the last wall back to the first point"}
        >
          <PillButton
            variant="primary"
            disabled={!plan.closed}
            data-testid="next-button"
            onClick={() => navigate(`/p/${id}/capture`)}
          >
            Next: add photos →
          </PillButton>
        </span>
      </div>

      {wallCount === 0 && (
        <>
          <div className="board-hint" data-testid="board-hint">
            Drag out your room — or import a scan and we'll measure it for you.
          </div>
          <div className="board-import">
            <PillButton
              variant="secondary"
              data-testid="import-scan"
              disabled={importing}
              onClick={() => scanInputRef.current?.click()}
            >
              {importing ? "Reading your scan…" : "Import a LiDAR scan"}
            </PillButton>
          </div>
          <input
            ref={scanInputRef}
            type="file"
            accept={SCAN_EXTENSIONS.join(",")}
            style={{ display: "none" }}
            data-testid="scan-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importScan(file);
            }}
          />
        </>
      )}

      {/* Outside the empty-board block on purpose: a successful import fills
          the board, which would unmount this and take the confirmation with
          it — so the user would see the room appear with no word on what was
          measured, or worse, an error they never got to read. */}
      {importNote && (
        <p className="board-import-note floating" data-testid="import-note">
          {importNote}
        </p>
      )}

      <div className="board-toolbar glass" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`icon-button ${tool === t.id ? "active" : ""}`}
            aria-label={t.label}
            aria-pressed={tool === t.id}
            data-testid={`tool-${t.id}`}
            onClick={() => setTool(t.id)}
          >
            <t.icon size={20} />
            <span>{t.label}</span>
          </button>
        ))}
        <button className="icon-button" aria-label="Undo" data-testid="undo" disabled={undoLen === 0} onClick={() => state().undo()}>
          <Undo2 size={20} />
          <span>Undo</span>
        </button>
        <button className="icon-button" aria-label="Redo" data-testid="redo" disabled={redoLen === 0} onClick={() => state().redo()}>
          <Redo2 size={20} />
          <span>Redo</span>
        </button>
      </div>

      <ContextPill />
      <HeightSheet />
    </div>
  );
}
