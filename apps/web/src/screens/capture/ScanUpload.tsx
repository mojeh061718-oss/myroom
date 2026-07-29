import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { planLoop } from "@myroom/schema";
import { checkScanFile, parseRoomPlanJson, SCAN_EXTENSIONS, type RoomPlanPreview } from "@myroom/recon";
import { getProject, listUploads, putUpload, deleteUpload, type LocalProject, type LocalUpload } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";
import { PillButton } from "../../components/PillButton.js";
import { AccuracyBadge } from "../../components/AccuracyBadge.js";
import "./capture.css";

/**
 * S5 — LiDAR upload (docs/01 §7). Optional, skippable in one tap, and honest
 * about what it buys: the accuracy badge moves from Photo-calibrated to
 * LiDAR-verified only when a scan actually parses.
 */

const HELP = [
  {
    app: "Apple RoomPlan apps (iPhone/iPad Pro)",
    body: "RoomPlan-based scanners export a .usdz with a companion .json. The .json is the best input — it already contains walls and furniture boxes. The .usdz works too when it has that JSON (or a mesh) inside.",
  },
  {
    app: "Polycam",
    body: "Export → Point Cloud (.ply) or Mesh (.glb). Either works — both are read right here on your device, Draco-compressed GLB included.",
  },
  {
    app: "Scaniverse",
    body: "Share → Export Model → GLB or PLY. Choose the highest detail your phone offers.",
  },
  {
    app: "3d Scanner App",
    body: "Share → Export → PLY or LAS. Skip the textured mesh — we only need geometry. (E57 and compressed LAZ can't be read on the device — pick PLY or LAS instead.)",
  },
];

export function ScanUpload() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<LocalProject | null>(null);
  const [scan, setScan] = useState<LocalUpload | null>(null);
  const [preview, setPreview] = useState<RoomPlanPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [openHelp, setOpenHelp] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const found = await getProject(id);
      if (!found) {
        navigate("/", { replace: true });
        return;
      }
      setProject(found);
      const uploads = await listUploads(id);
      setScan(uploads.find((u) => u.kind === "lidar") ?? null);
    })();
  }, [id, navigate]);

  const accept = async (file: File | undefined) => {
    if (!file || !project) return;
    setProblem(null);
    setPreview(null);

    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const check = checkScanFile(file.name, file.size, head);
    if (!check.ok) {
      setProblem(check.reason);
      return;
    }

    // Parse before uploading: a preview that shows the wrong room is the whole
    // point of this screen (docs/01 §7).
    if (check.format === "roomplan-json") {
      const parsed = parseRoomPlanJson(await file.text());
      if (!parsed) {
        setProblem("That JSON isn't a RoomPlan export — it has no walls in it.");
        return;
      }
      setPreview(parsed);
    }

    const upload: LocalUpload = {
      id: uuidv7(),
      projectId: project.id,
      kind: "lidar",
      filename: file.name,
      wallLabel: null,
      shotId: null,
      blob: file,
      quality: null,
      createdAt: new Date().toISOString(),
      remoteId: null,
    };
    if (scan) await deleteUpload(scan.id);
    await putUpload(upload);
    setScan(upload);
  };

  if (!project) return <div className="capture" />;

  return (
    <main className="capture" data-testid="scan-upload">
      <header className="capture-head">
        <button className="back" onClick={() => navigate(`/p/${id}/capture`)} aria-label="Back to photos">
          ‹
        </button>
        <h1 className="type-title">Have a 3D scan?</h1>
      </header>

      <p className="type-body" style={{ margin: 0 }}>
        It makes your room noticeably more accurate. Completely optional.
      </p>
      <AccuracyBadge tier={scan ? "lidar" : "photo"} />

      <input
        ref={input}
        type="file"
        accept={SCAN_EXTENSIONS.join(",")}
        hidden
        data-testid="scan-input"
        onChange={(e) => void accept(e.target.files?.[0])}
      />

      <div
        className="scan-drop"
        data-testid="scan-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void accept(e.dataTransfer.files?.[0]);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        {scan ? (
          <>
            <strong>{scan.filename}</strong>
            <span className="type-caption">{(scan.blob.size / 1024 / 1024).toFixed(1)} MB · ready</span>
          </>
        ) : (
          <>
            <strong>Drop a scan here, or choose a file</strong>
            <span className="type-caption">.usdz · .json · .ply · .glb · .e57 · .las — up to 500 MB</span>
          </>
        )}
      </div>

      {problem && (
        <p className="processing-demo" data-testid="scan-problem">
          {problem}
        </p>
      )}

      {preview && <ScanPreview project={project} preview={preview} />}

      <details className="scan-help">
        <summary>How do I get a scan?</summary>
        {HELP.map((entry) => (
          <div key={entry.app} className="scan-help-card">
            <button
              className="scan-help-title"
              aria-expanded={openHelp === entry.app}
              onClick={() => setOpenHelp(openHelp === entry.app ? null : entry.app)}
            >
              {entry.app}
            </button>
            {openHelp === entry.app && <p className="type-caption">{entry.body}</p>}
          </div>
        ))}
      </details>

      <footer className="capture-foot">
        <PillButton variant="primary" data-testid="scan-continue" onClick={() => navigate(`/p/${id}/processing`)}>
          {scan ? "Build my room" : "Continue without a scan"}
        </PillButton>
        {scan && (
          <button
            className="capture-remove"
            onClick={async () => {
              await deleteUpload(scan.id);
              setScan(null);
              setPreview(null);
            }}
          >
            Remove this scan
          </button>
        )}
      </footer>
    </main>
  );
}

/**
 * The parsed scan drawn over the drawn plan, both to the same scale. Two
 * outlines that don't overlap mean the scan is of a different room — which the
 * user can see instantly and we could only guess at.
 */
function ScanPreview({ project, preview }: { project: LocalProject; preview: RoomPlanPreview }) {
  const loop = planLoop(project.plan);
  if (!loop) return null;

  const points = [
    ...loop.map((p) => [p.x, p.y] as [number, number]),
    ...preview.walls.flatMap((w) => [w.start, w.end]),
  ];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = 120 / Math.max(maxX - minX, maxY - minY, 0.1);
  const px = (p: [number, number]) => [(p[0] - minX) * scale, (maxY - p[1]) * scale] as const;

  return (
    <div className="scan-preview" data-testid="scan-preview">
      <svg
        viewBox={`-10 -10 ${(maxX - minX) * scale + 20} ${(maxY - minY) * scale + 20}`}
        width={200}
        height={200}
        role="img"
        aria-label="Your scan drawn over your floor plan"
      >
        <path
          d={loop.map((p, i) => `${i === 0 ? "M" : "L"}${px([p.x, p.y])[0]},${px([p.x, p.y])[1]}`).join(" ") + " Z"}
          fill="rgba(76,141,255,0.12)"
          stroke="#4C8DFF"
          strokeWidth={3}
        />
        {preview.walls.map((wall, i) => (
          <line
            key={i}
            x1={px(wall.start)[0]}
            y1={px(wall.start)[1]}
            x2={px(wall.end)[0]}
            y2={px(wall.end)[1]}
            stroke="#5FBF8C"
            strokeWidth={3}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <p className="type-caption">
        {preview.walls.length} walls and {preview.objectCount} objects in the scan
        {preview.ceilingHeight ? `, ceiling ${preview.ceilingHeight.toFixed(2)} m` : ""}. Green is the scan, blue is what
        you drew — we'll line them up and only ask about big disagreements.
      </p>
    </div>
  );
}
