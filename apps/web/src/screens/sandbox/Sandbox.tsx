import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { Check, ChevronLeft, Eye, History, Palette, Pencil, Plus, Redo2, Share2, Undo2 } from "lucide-react";
import { findFreeSpot, formatArea, formatLength, type ShellGeometry, type SnapWall } from "@myroom/geometry";
import { getCatalogItem, getCategory } from "@myroom/catalog";
import type { PlacedObject } from "@myroom/schema";
import { useSettings } from "../../stores/settingsStore.js";
import { useScene } from "../../stores/sceneStore.js";
import { useToasts } from "../../components/Toast.js";
import { PillButton } from "../../components/PillButton.js";
import { SegmentedControl } from "../../components/SegmentedControl.js";
import { Sheet } from "../../components/Sheet.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Shell } from "./Shell.js";
import { Lighting } from "./Lighting.js";
import { CameraRig, type ViewMode } from "./CameraRig.js";
import { PlacedObjects, type DragFeedback } from "./PlacedObjects.js";
import { CatalogSheet, ColorSheet, FLOOR_MATERIALS, ImportConfirmSheet, ObjectSheet } from "./EditSheets.js";
import { IMPORT_ACCEPT, loadModelFiles, storeModel, type LoadedModel } from "../../lib/importModel.js";
import { listAssets, type LocalAsset } from "../../lib/db.js";
import { CompareSlider } from "./Compare.js";
import { QualityGovernor } from "./QualityGovernor.js";
import { AccuracyBadge } from "../../components/AccuracyBadge.js";
import "./sandbox.css";

/** docs/06 §7 — the scene as a list, for non-pointer navigation. */
function SceneObjectList({
  shell,
  objects,
  unit,
  onSelect,
}: {
  shell: ShellGeometry;
  objects: readonly PlacedObject[];
  unit: "m" | "ft";
  onSelect: (id: string) => void;
}) {
  const wallOf = (o: PlacedObject) =>
    o.wallId ? ` on wall ${shell.walls.find((w) => w.wallId === o.wallId)?.label ?? "?"}` : "";
  return (
    <nav className="scene-a11y-list" aria-label="Room contents">
      <h2 className="type-label">Room contents</h2>
      <ul>
        <li tabIndex={0}>
          Floor — {formatArea(shell.floorArea, unit)}, ceiling height {formatLength(shell.height, unit)}
        </li>
        {shell.walls.map((w) => (
          <li key={w.wallId} tabIndex={0}>
            Wall {w.label} — {formatLength(w.length, unit)} wide, {formatLength(w.height, unit)} tall
          </li>
        ))}
        {objects.map((o) => (
          <li key={o.id}>
            <button onClick={() => onSelect(o.id)}>
              {o.label} — {formatLength(o.size.w, unit)} wide{wallOf(o)}. Select to edit.
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** S7/S8 — Sandbox Viewer and Edit Mode (docs/01 §9–10). */
export function Sandbox() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const unit = useSettings((s) => s.displayUnit);
  const quality = useSettings((s) => s.quality);
  const showToast = useToasts((s) => s.show);
  const scene = useScene((s) => s.scene);
  const shell = useScene((s) => s.shell);
  const projectName = useScene((s) => s.projectName);
  const editing = useScene((s) => s.editing);
  const selectedId = useScene((s) => s.selectedId);
  const versions = useScene((s) => s.versions);
  const undoLen = useScene((s) => s.undoStack.length);
  const redoLen = useScene((s) => s.redoStack.length);
  const store = useScene.getState;

  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState<ViewMode>("dollhouse");
  const [wallFade, setWallFade] = useState(true);
  const [drag, setDrag] = useState<DragFeedback | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [paintTarget, setPaintTarget] = useState<"walls" | "floor" | null>(null);
  const [objectSheetOpen, setObjectSheetOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [compare, setCompare] = useState<{
    before: string;
    after: string;
    beforeName: string;
    afterName: string;
  } | null>(null);
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<LoadedModel | null>(null);
  const [myModels, setMyModels] = useState<LocalAsset[]>([]);

  /**
   * Grab the current frame. `preserveDrawingBuffer` keeps the buffer readable
   * after the draw, which is what makes both share renders and A/B compare
   * possible without a second offscreen pipeline.
   */
  const captureFrame = async (scale = 1): Promise<string | null> => {
    const gl = (
      window as unknown as {
        __myroomRenderer?: {
          domElement: HTMLCanvasElement;
          getPixelRatio: () => number;
          setPixelRatio: (v: number) => void;
          setSize: (w: number, h: number, updateStyle?: boolean) => void;
        };
      }
    ).__myroomRenderer;
    if (!gl) return null;

    // A 2× export (docs/09 M6) re-renders at twice the pixel ratio and puts it
    // back afterwards — the share image shouldn't be limited to whatever the
    // phone's screen happens to be.
    const original = gl.getPixelRatio();
    if (scale !== 1) {
      gl.setPixelRatio(Math.min(4, original * scale));
      const { clientWidth, clientHeight } = gl.domElement;
      gl.setSize(clientWidth, clientHeight, false);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const data = gl.domElement.toDataURL("image/png");
    if (scale !== 1) {
      gl.setPixelRatio(original);
      const { clientWidth, clientHeight } = gl.domElement;
      gl.setSize(clientWidth, clientHeight, false);
    }
    return data;
  };

  /** docs/06 §6, docs/09 M6 — export the current view as a 2× image. */
  const shareRender = async () => {
    const data = await captureFrame(2);
    if (!data) return;
    const link = document.createElement("a");
    link.href = data;
    link.download = `${(projectName || "my-room").replace(/\s+/g, "-").toLowerCase()}.png`;
    link.click();
    showToast("Render saved");
  };

  /** docs/06 §6 — render two versions from an identical camera, then slide. */
  const compareVersions = async (aId: string, bId: string) => {
    const s = store();
    const a = s.versions.find((v) => v.id === aId);
    const b = s.versions.find((v) => v.id === bId);
    if (!a || !b) return;
    const current = s.scene;
    setVersionsOpen(false);

    // Swap the document, capture, swap again — the camera never moves, so the
    // only difference between the two frames is the design itself.
    useScene.setState({ scene: a.scene, selectedId: null });
    const beforeImg = await captureFrame();
    useScene.setState({ scene: b.scene, selectedId: null });
    const afterImg = await captureFrame();
    useScene.setState({ scene: current });

    if (beforeImg && afterImg) {
      setCompare({ before: beforeImg, after: afterImg, beforeName: a.name, afterName: b.name });
    }
  };

  useEffect(() => {
    if (!id) return;
    void useScene
      .getState()
      .load(id)
      .then((ok) => {
        setMissing(!ok);
        setLoaded(true);
      });
    void listAssets(id).then(setMyModels);
  }, [id]);

  const selected = useMemo(
    () => scene?.objects.find((o) => o.id === selectedId) ?? null,
    [scene, selectedId],
  );

  // Keyboard path (docs/06 §7): arrows nudge, R rotates, Delete removes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const s = store();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
        return;
      }
      const obj = s.scene?.objects.find((o) => o.id === s.selectedId);
      if (!obj || !s.editing) return;
      const step = e.shiftKey ? 0.25 : 0.05;
      if (e.key === "ArrowLeft") s.updateObject(obj.id, { position: { ...obj.position, x: obj.position.x - step } }, true);
      if (e.key === "ArrowRight") s.updateObject(obj.id, { position: { ...obj.position, x: obj.position.x + step } }, true);
      if (e.key === "ArrowUp") s.updateObject(obj.id, { position: { ...obj.position, z: obj.position.z - step } }, true);
      if (e.key === "ArrowDown") s.updateObject(obj.id, { position: { ...obj.position, z: obj.position.z + step } }, true);
      if (e.key.toLowerCase() === "r") s.updateObject(obj.id, { rotationY: obj.rotationY + Math.PI / 4 }, true);
      if (e.key === "Delete" || e.key === "Backspace") s.deleteObject(obj.id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [store]);

  if (loaded && (missing || !shell)) {
    return (
      <div className="sandbox-empty">
        <h1 className="type-title" style={{ margin: 0 }}>
          {missing ? "Room not found" : "This room isn't closed yet"}
        </h1>
        <p style={{ color: "var(--text-dim)", maxWidth: 380, margin: 0 }}>
          {missing
            ? "This room doesn't exist on this device."
            : "Finish drawing the walls so they form a closed loop, and your room will build itself here."}
        </p>
        <PillButton variant="primary" onClick={() => navigate(missing ? "/" : `/p/${id}/draw`)} data-testid="sandbox-empty-action">
          {missing ? "Back to home" : "Back to the drawing board"}
        </PillButton>
      </div>
    );
  }

  /** Drop new objects at the room centre; the catalog's "fits here" uses the room. */
  const roomClearance = shell
    ? {
        w: shell.bounds.max[0] - shell.bounds.min[0],
        d: shell.bounds.max[2] - shell.bounds.min[2],
      }
    : null;

  const addFromCatalog = (categoryId: string, catalogId?: string) => {
    if (!shell) return;
    const category = getCategory(categoryId);
    const s = store();
    if (swapFor) {
      s.swapObject(swapFor, categoryId, catalogId);
      setSwapFor(null);
      setCatalogOpen(false);
      return;
    }
    const y =
      category?.support === "wall" || category?.support === "ceiling"
        ? (category.mountHeight ?? shell.height / 2)
        : 0;

    // Land it in clear floor space, wall-aligned (docs/06 §5) — dropping every
    // new piece on the room centre would stack them on top of each other.
    const snapWalls: SnapWall[] = shell.walls.map((w) => ({
      wallId: w.wallId,
      start: [w.start[0], w.start[2]],
      end: [w.end[0], w.end[2]],
      inwardNormal: [w.inwardNormal[0], w.inwardNormal[2]],
      thickness: w.thickness,
    }));
    // A real model's measured size beats the category's typical size.
    const model = catalogId ? getCatalogItem(catalogId) : undefined;
    const size = model?.nativeSize ?? category?.defaultSize ?? { w: 0.5, d: 0.5, h: 0.5 };
    const spot =
      category?.support === "floor"
        ? findFreeSpot(
            snapWalls,
            (useScene.getState().scene?.objects ?? []).map((o) => ({
              position: { x: o.position.x, z: o.position.z },
              size: o.size,
              rotationY: o.rotationY,
              collisionExempt: o.collisionExempt,
            })),
            size,
            [shell.center[0], shell.center[2]],
          )
        : { x: shell.center[0], z: shell.center[2], rotationY: 0 };

    const newId = s.addObject(
      categoryId,
      { x: spot.x, y, z: spot.z },
      {
        rotationY: spot.rotationY,
        ...(model
          ? { catalogId: model.id, placeholder: null, label: model.name, size: { ...model.nativeSize } }
          : {}),
      },
    );
    // Wall and ceiling items must land on a real anchor, never float free.
    if (category?.support === "wall" && shell.walls[0]) {
      const wall = shell.walls[0];
      s.updateObject(
        newId,
        {
          wallId: wall.wallId,
          position: {
            x: (wall.start[0] + wall.end[0]) / 2 + wall.inwardNormal[0] * (wall.thickness / 2),
            y,
            z: (wall.start[2] + wall.end[2]) / 2 + wall.inwardNormal[2] * (wall.thickness / 2),
          },
          rotationY: Math.atan2(wall.inwardNormal[0], wall.inwardNormal[2]),
        },
        true,
      );
    }
    setCatalogOpen(false);
    showToast(`${category?.label ?? "Object"} added — drag to place it`);
  };

  /** Place a stored imported model in clear floor space (docs/06 §5). */
  const placeImported = (asset: { id: string; name: string; nativeSize: { w: number; d: number; h: number } }) => {
    if (!shell) return;
    const snapWalls: SnapWall[] = shell.walls.map((w) => ({
      wallId: w.wallId,
      start: [w.start[0], w.start[2]],
      end: [w.end[0], w.end[2]],
      inwardNormal: [w.inwardNormal[0], w.inwardNormal[2]],
      thickness: w.thickness,
    }));
    const spot = findFreeSpot(
      snapWalls,
      (useScene.getState().scene?.objects ?? []).map((o) => ({
        position: { x: o.position.x, z: o.position.z },
        size: o.size,
        rotationY: o.rotationY,
        collisionExempt: o.collisionExempt,
      })),
      asset.nativeSize,
      [shell.center[0], shell.center[2]],
    );
    store().addImported(asset, { x: spot.x, y: 0, z: spot.z });
    setCatalogOpen(false);
    showToast(`${asset.name} added — drag to place it`);
  };

  const handleImportFiles = async (files: File[]) => {
    if (files.length === 0) return;
    try {
      setPendingImport(await loadModelFiles(files));
    } catch (error) {
      showToast((error as Error).message);
    }
  };

  const confirmImport = async (size: { w: number; d: number; h: number }) => {
    if (!pendingImport || !id) return;
    try {
      const asset = await storeModel(pendingImport, id, size);
      setMyModels((prev) => [asset, ...prev]);
      placeImported(asset);
    } catch (error) {
      showToast(`We couldn't save that model (${(error as Error).message}).`);
    } finally {
      setPendingImport(null);
    }
  };

  return (
    <main
      className="sandbox"
      data-testid="sandbox"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        e.preventDefault();
        void handleImportFiles(files);
      }}
    >
      {shell && scene && (
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{
            antialias: true,
            powerPreference: "high-performance",
            // Required to read the canvas back for share renders and compare.
            preserveDrawingBuffer: true,
          }}
          onCreated={({ gl, scene: threeScene }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping; // docs/02 §7
            gl.toneMappingExposure = 1.05;
            threeScene.background = new THREE.Color("#0E0F12");
            const w = window as unknown as Record<string, unknown>;
            w.__myroomRenderer = gl;
            w.__myroomScene = threeScene;
          }}
          onPointerMissed={() => store().select(null)}
        >
          <CameraRig shell={shell} view={view} />
          {/* Steps quality down when the frame rate falls, and back up when
              headroom returns (docs/06 §8). */}
          <QualityGovernor preference={quality} />
          <Lighting shell={shell} />
          <Shell
            shell={shell}
            finishes={{
              wallColors: Object.fromEntries(
                Object.entries(scene.finishes.walls).map(([k, v]) => [k, v.color ?? "#EDE9E3"]),
              ),
              defaultWallColor: "#EDE9E3",
              floorColor: scene.finishes.floor.color ?? "#B99A72",
              ceilingColor: scene.finishes.ceiling.color ?? "#F4F2EC",
            }}
            dollhouse={view !== "inside"}
            wallFade={wallFade && view === "dollhouse"}
          />
          <PlacedObjects
            objects={scene.objects}
            shell={shell}
            editing={editing}
            selectedId={selectedId}
            onSelect={(oid) => {
              store().select(oid);
              if (oid && editing) setObjectSheetOpen(true);
            }}
            onMove={(oid, patch, commit) => store().updateObject(oid, patch, commit)}
            onDragFeedback={setDrag}
          />
        </Canvas>
      )}

      {!loaded && (
        <div className="sandbox-loading">
          <span className="type-label">Building your room…</span>
        </div>
      )}

      <div className="sandbox-topbar">
        <button
          className="icon-button glass"
          style={{ borderRadius: "var(--radius-pill)" }}
          aria-label="Back to projects"
          onClick={() => navigate("/")}
        >
          <ChevronLeft size={22} />
        </button>
        <span className="type-label project-name" style={{ maxWidth: "26vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {editing ? "Editing" : ""}
        </span>
        <div className="spacer" />
        {editing && (
          <>
            <button className="icon-button" aria-label="Undo" data-testid="undo" disabled={undoLen === 0} onClick={() => store().undo()}>
              <Undo2 size={20} />
            </button>
            <button className="icon-button" aria-label="Redo" data-testid="redo" disabled={redoLen === 0} onClick={() => store().redo()}>
              <Redo2 size={20} />
            </button>
          </>
        )}
        <AccuracyBadge tier={scene?.provenance.tier ?? "sketch"} />
      </div>

      {drag && (
        <div className={`drag-readout ${drag.colliding ? "colliding" : ""}`} data-testid="drag-readout">
          {drag.distances.map((d) => (
            <span key={d.label} className="metric">
              {d.label} {formatLength(d.distance, unit)}
            </span>
          ))}
          {drag.snapped && <span className="snap">{drag.snapped}</span>}
          {drag.colliding && <span className="snap">Overlapping</span>}
        </div>
      )}

      {shell && scene && (
        <SceneObjectList
          shell={shell}
          objects={scene.objects}
          unit={unit}
          onSelect={(oid) => {
            store().select(oid);
            if (editing) setObjectSheetOpen(true);
          }}
        />
      )}

      <div className="sandbox-bottombar glass" role="toolbar" aria-label={editing ? "Edit tools" : "View options"}>
        {!editing ? (
          <>
            <PillButton
              variant="primary"
              data-testid="edit-button"
              onClick={() => {
                store().setEditing(true);
                // Version zero is captured the first time the room is edited,
                // so "Original room" always exists to return to (docs/06 §6).
                if (useScene.getState().versions.length === 0) store().saveVersion("Original room");
              }}
            >
              <Pencil size={18} /> Edit
            </PillButton>
            <SegmentedControl
              ariaLabel="Camera view"
              options={[
                { value: "dollhouse", label: "Dollhouse" },
                { value: "inside", label: "Inside" },
                { value: "plan", label: "2D" },
              ]}
              value={view}
              onChange={(v) => setView(v)}
            />
            <button
              className={`icon-button ${wallFade ? "active" : ""}`}
              aria-label="Fade near walls"
              aria-pressed={wallFade}
              data-testid="wall-fade-toggle"
              onClick={() => setWallFade((f) => !f)}
              disabled={view !== "dollhouse"}
            >
              <Eye size={20} />
              <span>Walls</span>
            </button>
            <button className="icon-button" aria-label="Versions" data-testid="versions-button" onClick={() => setVersionsOpen(true)}>
              <History size={20} />
              <span>Versions</span>
            </button>
            <button className="icon-button" aria-label="Share a render" data-testid="share-button" onClick={() => void shareRender()}>
              <Share2 size={20} />
              <span>Share</span>
            </button>
          </>
        ) : (
          <>
            <PillButton
              variant="primary"
              data-testid="done-button"
              onClick={() => {
                store().setEditing(false);
                setObjectSheetOpen(false);
              }}
            >
              <Check size={18} /> Done
            </PillButton>
            <button className="icon-button" aria-label="Add furniture" data-testid="add-button" onClick={() => setCatalogOpen(true)}>
              <Plus size={20} />
              <span>Add</span>
            </button>
            <button className="icon-button" aria-label="Paint walls" data-testid="paint-walls" onClick={() => setPaintTarget("walls")}>
              <Palette size={20} />
              <span>Walls</span>
            </button>
            <button className="icon-button" aria-label="Change floor" data-testid="paint-floor" onClick={() => setPaintTarget("floor")}>
              <Palette size={20} />
              <span>Floor</span>
            </button>
            <button
              className="icon-button"
              aria-label="Selected object"
              data-testid="object-button"
              disabled={!selected}
              onClick={() => setObjectSheetOpen(true)}
            >
              <Pencil size={20} />
              <span>Object</span>
            </button>
          </>
        )}
      </div>

      <CatalogSheet
        open={catalogOpen}
        title={swapFor ? "Swap for…" : "Add to the room"}
        fitsWithin={roomClearance}
        onPick={addFromCatalog}
        onImport={swapFor ? undefined : () => importInput.current?.click()}
        myModels={swapFor ? undefined : myModels}
        onPickModel={placeImported}
        onClose={() => {
          setCatalogOpen(false);
          setSwapFor(null);
        }}
      />

      <input
        ref={importInput}
        type="file"
        accept={IMPORT_ACCEPT}
        multiple
        hidden
        data-testid="import-model-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void handleImportFiles(files);
        }}
      />

      <ImportConfirmSheet
        model={pendingImport}
        unit={unit}
        onConfirm={(size) => void confirmImport(size)}
        onCancel={() => setPendingImport(null)}
      />

      <ColorSheet
        open={paintTarget === "walls"}
        title="Paint the walls"
        onPick={(color) => {
          store().paintWall("all", color);
          setPaintTarget(null);
          showToast("All walls painted");
        }}
        onClose={() => setPaintTarget(null)}
      />

      <ColorSheet
        open={paintTarget === "floor"}
        title="Choose a floor"
        swatches={FLOOR_MATERIALS}
        onPick={(color) => {
          store().paintFloor(color);
          setPaintTarget(null);
        }}
        onClose={() => setPaintTarget(null)}
      />

      <ObjectSheet
        object={objectSheetOpen ? selected : null}
        unit={unit}
        onClose={() => setObjectSheetOpen(false)}
        onPaintSlot={(slot, color) => selected && store().paintObjectSlot(selected.id, slot, color)}
        onDuplicate={() => {
          if (selected) store().duplicateObject(selected.id);
          setObjectSheetOpen(false);
        }}
        onDelete={() => {
          if (selected) setConfirmDelete(selected.id);
          setObjectSheetOpen(false);
        }}
        onSwap={() => {
          if (selected) setSwapFor(selected.id);
          setObjectSheetOpen(false);
          setCatalogOpen(true);
        }}
        onPickRunnerUp={(catalogId) => {
          // The runners-up were computed during matching, so this swap needs no
          // search and no round trip (docs/05 §6).
          const item = getCatalogItem(catalogId);
          if (selected && item) store().swapObject(selected.id, item.category, item.id);
          setObjectSheetOpen(false);
        }}
        onResize={(scale) => {
          if (!selected) return;
          store().updateObject(
            selected.id,
            {
              size: {
                w: selected.size.w * scale,
                d: selected.size.d * scale,
                h: selected.size.h * scale,
              },
            },
            true,
          );
        }}
        onRotate={() => {
          if (selected) store().updateObject(selected.id, { rotationY: selected.rotationY + Math.PI / 4 }, true);
        }}
      />

      <Sheet open={versionsOpen} onClose={() => setVersionsOpen(false)} labelledBy="versions-title">
        <h2 id="versions-title" className="type-title" style={{ margin: 0 }}>
          Versions
        </h2>
        <p className="type-caption" style={{ margin: "4px 0 0" }}>
          Snapshots of this room. "Original room" is locked and always restorable.
        </p>
        <div className="version-strip" data-testid="version-strip">
          {versions.length === 0 && <p className="type-caption">No versions yet — save one to compare ideas.</p>}
          {versions.map((v) => (
            <div key={v.id} className="version-row">
              <button
                className="grow type-label"
                data-testid={`restore-${v.name.replace(/\s+/g, "-")}`}
                onClick={() => {
                  store().restoreVersion(v.id);
                  setVersionsOpen(false);
                  showToast(`Restored "${v.name}"`);
                }}
              >
                {v.name} {v.locked && <span className="type-caption">· locked</span>}
              </button>
              <button
                className={`chip ${compareFrom === v.id ? "active" : ""}`}
                data-testid={`compare-${v.name.replace(/\s+/g, "-")}`}
                aria-label={compareFrom === v.id ? `Cancel comparing ${v.name}` : `Compare ${v.name} with…`}
                onClick={() => {
                  if (compareFrom === null) setCompareFrom(v.id);
                  else if (compareFrom === v.id) setCompareFrom(null);
                  else {
                    const from = compareFrom;
                    setCompareFrom(null);
                    void compareVersions(from, v.id);
                  }
                }}
              >
                {compareFrom === null ? "Compare" : compareFrom === v.id ? "Cancel" : "vs. this"}
              </button>
              {!v.locked && (
                <button className="icon-button" aria-label={`Delete ${v.name}`} onClick={() => store().deleteVersion(v.id)}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <PillButton
          variant="primary"
          style={{ marginTop: 14, width: "100%" }}
          data-testid="save-version"
          onClick={() => {
            const name = prompt("Name this version", `Option ${versions.length}`);
            if (name?.trim()) {
              store().saveVersion(name.trim());
              showToast(`Saved "${name.trim()}"`);
            }
          }}
        >
          Save this version
        </PillButton>
      </Sheet>

      {compare && (
        <CompareSlider
          before={compare.before}
          after={compare.after}
          beforeName={compare.beforeName}
          afterName={compare.afterName}
          onClose={() => setCompare(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove this object?"
        body="You can undo straight afterwards if you change your mind."
        confirmLabel="Remove"
        onConfirm={() => {
          if (confirmDelete) store().deleteObject(confirmDelete);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </main>
  );
}
