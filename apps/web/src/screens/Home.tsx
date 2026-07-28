import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MoreHorizontal, Plus, Settings as SettingsIcon } from "lucide-react";
import { formatArea, formatLength } from "@myroom/geometry";
import { chainPoints } from "../stores/drawingStore.js";
import { PillButton } from "../components/PillButton.js";
import { Sheet } from "../components/Sheet.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { SegmentedControl } from "../components/SegmentedControl.js";
import { useProjects } from "../stores/projectsStore.js";
import { useSettings } from "../stores/settingsStore.js";
import type { LocalProject } from "../lib/db.js";

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function projectDims(p: LocalProject, unit: "m" | "ft"): string | null {
  const pts = chainPoints(p.plan);
  if (pts.length < 2) return null;
  const w = Math.max(...pts.map((v) => v.x)) - Math.min(...pts.map((v) => v.x));
  const h = Math.max(...pts.map((v) => v.y)) - Math.min(...pts.map((v) => v.y));
  if (w < 0.01 || h < 0.01) return null;
  const dims = `${formatLength(w, unit)} × ${formatLength(h, unit)}`;
  return p.plan.closed && p.plan.floorArea ? `${dims} · ${formatArea(p.plan.floorArea, unit)}` : dims;
}

/** S2 — Projects Home (docs/01 §4). */
export function Home() {
  const navigate = useNavigate();
  const { projects, hydrated, createProject, renameProject, duplicateProject, removeProject } = useProjects();
  const settings = useSettings();
  const [menuFor, setMenuFor] = useState<LocalProject | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LocalProject | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const longPress = useRef<ReturnType<typeof setTimeout>>();

  // First launch → tutorial (skippable at every step; never auto-plays again).
  useEffect(() => {
    if (settings.hydrated && !settings.tutorialSeen) navigate("/tutorial", { replace: true });
  }, [settings.hydrated, settings.tutorialSeen, navigate]);

  const openProject = (p: LocalProject) => {
    navigate(p.plan.closed ? `/p/${p.id}` : `/p/${p.id}/draw`);
  };

  const newRoom = async () => {
    const project = await createProject();
    navigate(`/p/${project.id}/draw`);
  };

  return (
    <main className="home" data-testid="home">
      <header className="home-masthead">
        <div>
          <h1 className="type-display-l" style={{ margin: 0 }}>
            My Room Sandbox
          </h1>
          <p className="type-caption" style={{ margin: "4px 0 0" }}>
            Your room. Reimagined.
          </p>
        </div>
        <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={22} />
        </button>
      </header>

      {hydrated && projects.length === 0 && (
        <button className="card empty-state-card" onClick={newRoom} data-testid="empty-state">
          <span className="type-title">Start with your walls</span>
          <span className="type-caption">
            Draw your room's outline — don't worry about being perfect. Photos and 3D come next.
          </span>
        </button>
      )}

      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} style={{ position: "relative" }}>
            <button
              className="card project-card"
              data-testid="project-card"
              onClick={() => openProject(p)}
              onPointerDown={() => {
                longPress.current = setTimeout(() => setMenuFor(p), 500);
              }}
              onPointerUp={() => clearTimeout(longPress.current)}
              onPointerLeave={() => clearTimeout(longPress.current)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(p);
              }}
            >
              <div className="thumb" aria-hidden>
                {p.thumbnailSvg ? (
                  <div dangerouslySetInnerHTML={{ __html: p.thumbnailSvg }} style={{ width: "70%", height: "70%" }} />
                ) : (
                  <span className="type-caption">No walls yet</span>
                )}
              </div>
              <div className="meta">
                <div className="type-label">{p.name}</div>
                <div className="type-caption" style={{ marginTop: 2 }}>
                  {projectDims(p, settings.displayUnit) ?? "Empty plan"}
                </div>
                <div className="type-caption" style={{ marginTop: 2 }}>
                  {timeAgo(p.updatedAt)}
                </div>
              </div>
            </button>
            <button className="card-menu" aria-label={`Options for ${p.name}`} onClick={() => setMenuFor(p)}>
              <MoreHorizontal size={20} />
            </button>
          </div>
        ))}
      </div>

      <PillButton variant="primary" className="new-room-fab" onClick={newRoom} data-testid="new-room">
        <Plus size={20} /> New room
      </PillButton>

      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)}>
        {menuFor && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="type-title" style={{ margin: "0 0 8px" }}>
              {menuFor.name}
            </h2>
            <PillButton
              onClick={() => {
                const name = prompt("Rename room", menuFor.name);
                if (name?.trim()) void renameProject(menuFor.id, name.trim());
                setMenuFor(null);
              }}
            >
              Rename
            </PillButton>
            <PillButton
              onClick={() => {
                void duplicateProject(menuFor.id);
                setMenuFor(null);
              }}
            >
              Duplicate
            </PillButton>
            <PillButton
              variant="danger"
              onClick={() => {
                setConfirmDelete(menuFor);
                setMenuFor(null);
              }}
            >
              Delete
            </PillButton>
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this room?"
        body="The plan and everything in it will be removed. This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmDelete) void removeProject(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 className="type-title" style={{ margin: 0 }}>
            Settings
          </h2>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Units</span>
            <SegmentedControl
              ariaLabel="Measurement units"
              options={[
                { value: "m", label: "m" },
                { value: "ft", label: "ft" },
              ]}
              value={settings.displayUnit}
              onChange={settings.setDisplayUnit}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Graphics</span>
            <SegmentedControl
              ariaLabel="Graphics quality"
              options={[
                { value: "auto", label: "Auto" },
                { value: "best", label: "Best" },
                { value: "saver", label: "Saver" },
              ]}
              value={settings.quality}
              onChange={settings.setQuality}
            />
          </div>
          <button
            className="settings-link"
            data-testid="privacy-link"
            onClick={() => {
              setSettingsOpen(false);
              navigate("/privacy");
            }}
          >
            Your photos, your room — what we do with them
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Theme</span>
            <SegmentedControl
              ariaLabel="Theme"
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
              value={settings.theme}
              onChange={settings.setTheme}
            />
          </div>
          <PillButton
            onClick={() => {
              setSettingsOpen(false);
              navigate("/tutorial");
            }}
          >
            Replay tutorial
          </PillButton>
        </div>
      </Sheet>
    </main>
  );
}
