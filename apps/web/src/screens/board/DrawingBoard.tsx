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
import { formatArea, formatLength, parseDisplayLength } from "@myroom/geometry";
import { decodeScanMesh, parseMeshScan, sniffScanFormat } from "@myroom/recon";
import { OBJECT_CATEGORIES } from "@myroom/catalog";
import { usableFloorArea, wallLength } from "@myroom/schema";
import { useDrawing, type Tool } from "../../stores/drawingStore.js";
import { useSettings } from "../../stores/settingsStore.js";
import { useToasts } from "../../components/Toast.js";
import { SegmentedControl } from "../../components/SegmentedControl.js";
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

const REJECTION_COPY = {
  tooShort: 'Walls need to be at least 12" long',
  selfIntersect: "Walls can't cross each other",
  openingOverlap: "Openings can't overlap or hang off the wall",
  invalid: "That doesn't work here",
} as const;

function HeightSheet() {
  const open = useDrawing((s) => s.heightSheetOpen);
  const setOpen = useDrawing((s) => s.setHeightSheetOpen);
  const setHeights = useDrawing((s) => s.setHeights);
  const unit = useSettings((s) => s.displayUnit);
  const [custom, setCustom] = useState("");

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
          const m = parseDisplayLength(custom);
          if (m !== null && m >= 2 && m <= 6) choose(m);
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
          onChange={(e) => setCustom(e.target.value)}
          aria-label="Custom wall height"
        />
        <PillButton type="submit" variant="primary">
          Set
        </PillButton>
      </form>
    </Sheet>
  );
}

function ContextPill() {
  const selection = useDrawing((s) => s.selection);
  const plan = useDrawing((s) => s.plan);
  const unit = useSettings((s) => s.displayUnit);
  const [lengthDraft, setLengthDraft] = useState<string | null>(null);
  const state = useDrawing.getState;

  useEffect(() => setLengthDraft(null), [selection]);

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
              const m = parseDisplayLength(lengthDraft);
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
          onClick={() => {
            const t = prompt("Wall thickness (m, 0.05–0.5)", String(wall.thickness));
            const m = t ? parseDisplayLength(t) : null;
            if (m !== null) state().setWallThickness(wall.id, m);
          }}
        >
          <span className="type-metric">{Math.round(wall.thickness * 1000)}</span>
          <span>mm</span>
        </button>
        <button className="icon-button" aria-label="Delete wall" onClick={() => state().deleteWall(wall.id)} data-testid="delete-wall">
          <Trash2 size={18} />
          <span>Delete</span>
        </button>
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
              const m = parseDisplayLength(lengthDraft);
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
        const bytes = new Uint8Array(await file.arrayBuffer());
        const format = sniffScanFormat(bytes.subarray(0, 64));
        if (format !== "glb" && format !== "ply") {
          setImportNote(
            format === "roomplan-json"
              ? "That's a RoomPlan file — add it on the scan step after drawing, and it'll correct your walls."
              : "We can read GLB scans on the device. In Scaniverse: Share → Export Model → GLB.",
          );
          return;
        }

        const decoded = decodeScanMesh(bytes, format);
        if (!decoded.ok) {
          setImportNote(decoded.reason);
          return;
        }
        if (decoded.indices.length < 300) {
          setImportNote("That scan is a point cloud with no surfaces in it — export it as GLB instead.");
          return;
        }

        const parsed = parseMeshScan(decoded.positions, decoded.indices, format, {
          categories: OBJECT_CATEGORIES,
        });
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
        const pieces = parsed.seedBoxes.length;
        const ceiling =
          parsed.ceilingHeight !== null
            ? `, ${formatLength(parsed.ceilingHeight, settings.displayUnit)} ceiling`
            : "";
        const found =
          pieces > 0
            ? ` It also found ${pieces} thing${pieces === 1 ? "" : "s"} in the room — add photos next and we'll place them.`
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
    [settings.displayUnit],
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
    showToast(REJECTION_COPY[rejection.reason]);
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
            accept=".glb,.ply,.json,model/gltf-binary"
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
