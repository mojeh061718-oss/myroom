import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { Box, ChevronLeft, Eye, Layers, Pencil } from "lucide-react";
import { formatArea, formatLength, type ShellGeometry } from "@myroom/geometry";
import { planToShell } from "@myroom/schema";
import { getProject, type LocalProject } from "../../lib/db.js";
import { useSettings } from "../../stores/settingsStore.js";
import { PillButton } from "../../components/PillButton.js";
import { SegmentedControl } from "../../components/SegmentedControl.js";
import { Shell, type Finishes } from "./Shell.js";
import { Lighting } from "./Lighting.js";
import { CameraRig, type ViewMode } from "./CameraRig.js";
import "./sandbox.css";

/** M2 defaults; M3's paint tools write these into the Scene document. */
const DEFAULT_FINISHES: Finishes = {
  wallColors: {},
  defaultWallColor: "#EDE9E3",
  floorColor: "#B99A72",
  ceilingColor: "#F4F2EC",
};

function AccuracyBadge({ tier }: { tier: "sketch" | "photo" | "lidar" }) {
  const label =
    tier === "lidar" ? "LiDAR-verified" : tier === "photo" ? "Photo-calibrated" : "Sketch";
  return (
    <span className={`accuracy-badge ${tier}`} data-testid="accuracy-badge" title="How precise this room is">
      <span className="dot" aria-hidden />
      {label}
    </span>
  );
}

/** docs/06 §7 — the scene as a list, for non-pointer navigation. */
function SceneObjectList({ shell, unit }: { shell: ShellGeometry; unit: "m" | "ft" }) {
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
      </ul>
    </nav>
  );
}

/** S7 — Sandbox Viewer (docs/01 §9). */
export function Sandbox() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const unit = useSettings((s) => s.displayUnit);
  const [project, setProject] = useState<LocalProject | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<ViewMode>("dollhouse");
  const [wallFade, setWallFade] = useState(true);

  useEffect(() => {
    if (!id) return;
    void getProject(id).then((p) => {
      setProject(p ?? null);
      setLoaded(true);
    });
  }, [id]);

  const shell = useMemo(() => (project ? planToShell(project.plan) : null), [project]);

  if (loaded && (!project || !shell)) {
    return (
      <div className="sandbox-empty">
        <h1 className="type-title" style={{ margin: 0 }}>
          {project ? "This room isn't closed yet" : "Room not found"}
        </h1>
        <p style={{ color: "var(--text-dim)", maxWidth: 380, margin: 0 }}>
          {project
            ? "Finish drawing the walls so they form a closed loop, and your room will build itself here."
            : "This room doesn't exist on this device."}
        </p>
        <PillButton
          variant="primary"
          onClick={() => navigate(project ? `/p/${id}/draw` : "/")}
          data-testid="sandbox-empty-action"
        >
          {project ? "Back to the drawing board" : "Back to home"}
        </PillButton>
      </div>
    );
  }

  return (
    <div className="sandbox" data-testid="sandbox">
      {shell && (
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          onCreated={({ gl, scene }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping; // docs/02 §7
            gl.toneMappingExposure = 1.05;
            scene.background = new THREE.Color("#0E0F12");
            // Exposed so the perf budget (docs/06 §8) can be asserted in tests.
            const w = window as unknown as Record<string, unknown>;
            w.__myroomRenderer = gl;
            w.__myroomScene = scene;
          }}
        >
          <CameraRig shell={shell} view={view} />
          <Lighting shell={shell} />
          <Shell
            shell={shell}
            finishes={DEFAULT_FINISHES}
            dollhouse={view !== "inside"}
            wallFade={wallFade && view === "dollhouse"}
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
        <span
          className="type-label project-name"
          style={{ maxWidth: "30vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {project?.name}
        </span>
        <div className="spacer" />
        {/* Honest accuracy signal (docs/01 §12.3): plan only ⇒ Sketch. */}
        <AccuracyBadge tier="sketch" />
      </div>

      {shell && <SceneObjectList shell={shell} unit={unit} />}

      <div className="sandbox-bottombar glass" role="toolbar" aria-label="View options">
        <span title="Edit mode arrives in Milestone M3">
          <PillButton variant="primary" disabled data-testid="edit-button">
            <Pencil size={18} /> Edit
          </PillButton>
        </span>
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
          {view === "plan" ? <Layers size={20} /> : wallFade ? <Eye size={20} /> : <Box size={20} />}
          <span>Walls</span>
        </button>
      </div>
    </div>
  );
}
