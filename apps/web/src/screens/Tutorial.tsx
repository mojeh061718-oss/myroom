import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PillButton } from "../components/PillButton.js";
import { useSettings } from "../stores/settingsStore.js";

/**
 * T1–T5 — Tutorial (docs/01 §3). Skip is always visible top-right on every
 * step; page dots allow jumping. Completing OR skipping sets tutorialSeen.
 * Each step carries its own animated vignette in the T1 style — CSS-driven,
 * aria-hidden, and frozen to a legible final frame under reduced motion.
 */

const STEPS = [
  { title: "Draw your walls", sentence: "Sketch your room with a finger — dimensions appear live as you draw." },
  { title: "Snap your room", sentence: "Photograph each wall; a guided frame shows exactly what to capture." },
  { title: "Got LiDAR? Even better", sentence: "Drop in a 3D scan and your room gets noticeably more accurate." },
  { title: "Watch it build", sentence: "Your photos become a true-scale 3D room, piece by piece." },
  { title: "Make it yours", sentence: "Drag the couch, repaint the walls — every idea visualized in seconds." },
] as const;

function T1Demo() {
  return (
    <svg viewBox="0 0 320 240" width="100%" style={{ maxWidth: 420 }} aria-hidden>
      <rect x="40" y="40" width="240" height="160" rx="2" fill="none" stroke="var(--accent)" strokeWidth="6" className="t1-outline" pathLength={1040} strokeLinejoin="round" />
      <text x="160" y="28" textAnchor="middle" fill="var(--text)" fontSize="15" fontFamily="var(--font-mono)" className="t1-dim">
        6.20 m
      </text>
      <text x="304" y="124" textAnchor="middle" fill="var(--text)" fontSize="15" fontFamily="var(--font-mono)" className="t1-dim d2">
        4.80 m
      </text>
      <circle r="12" fill="var(--accent-warm)" className="t1-pen" opacity="0.9" />
    </svg>
  );
}

/** T2 — a wall in the guided capture frame, corner brackets locking on. */
function T2Demo() {
  return (
    <svg viewBox="0 0 320 240" width="100%" style={{ maxWidth: 420 }} aria-hidden>
      {/* the wall being photographed, with a door for scale */}
      <rect x="70" y="60" width="180" height="120" fill="var(--surface-solid, #fff)" opacity="0.08" stroke="var(--text-dim)" strokeWidth="2" />
      <rect x="130" y="100" width="34" height="80" fill="none" stroke="var(--text-dim)" strokeWidth="2" />
      <rect x="196" y="92" width="34" height="30" fill="none" stroke="var(--text-dim)" strokeWidth="2" />
      {/* camera guide frame */}
      <g className="t2-frame" stroke="var(--accent)" strokeWidth="5" fill="none" strokeLinecap="round">
        <path d="M52 66 v-24 h24" />
        <path d="M268 42 h-24 M268 42 v24" transform="translate(0,0)" />
        <path d="M52 174 v24 h24" />
        <path d="M268 198 h-24 M268 198 v-24" />
      </g>
      <circle cx="160" cy="222" r="9" fill="var(--accent-warm)" className="t2-shutter" />
    </svg>
  );
}

/** T3 — a point cloud resolving into the room's outline. */
function T3Demo() {
  // Deterministic scatter around the rectangle's edges — a scan of walls.
  const dots: [number, number][] = [];
  let seed = 9;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed % 1000) / 1000;
  };
  for (let i = 0; i < 26; i++) dots.push([44 + rand() * 232, 42 + rand() * 8 - 4]);
  for (let i = 0; i < 26; i++) dots.push([44 + rand() * 232, 198 + rand() * 8 - 4]);
  for (let i = 0; i < 18; i++) dots.push([44 + rand() * 8 - 4, 42 + rand() * 156]);
  for (let i = 0; i < 18; i++) dots.push([276 + rand() * 8 - 4, 42 + rand() * 156]);
  return (
    <svg viewBox="0 0 320 240" width="100%" style={{ maxWidth: 420 }} aria-hidden>
      <g className="t3-dots" fill="var(--accent-warm)">
        {dots.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.4" style={{ animationDelay: `${(i % 13) * 90}ms` }} />
        ))}
      </g>
      <rect x="44" y="42" width="232" height="156" rx="2" fill="none" stroke="var(--accent)" strokeWidth="5" className="t3-outline" pathLength={1} strokeLinejoin="round" />
    </svg>
  );
}

/** T4 — the plan extruding into a room: walls rise from the floor plate. */
function T4Demo() {
  return (
    <svg viewBox="0 0 320 240" width="100%" style={{ maxWidth: 420 }} aria-hidden>
      {/* floor plate, isometric-ish */}
      <polygon points="160,196 268,158 160,120 52,158" fill="var(--accent)" opacity="0.16" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
      {/* rising walls */}
      <g className="t4-walls" stroke="var(--text)" strokeWidth="2.5" fill="var(--surface-solid, #fff)" fillOpacity="0.07" strokeLinejoin="round">
        <polygon points="52,158 160,120 160,52 52,90" />
        <polygon points="160,120 268,158 268,90 160,52" />
      </g>
      {/* a sofa block landing inside */}
      <g className="t4-sofa">
        <polygon points="160,178 200,164 200,150 160,164" fill="var(--accent-warm)" opacity="0.9" />
        <polygon points="160,164 200,150 200,140 160,154" fill="var(--accent-warm)" opacity="0.65" />
      </g>
    </svg>
  );
}

/** T5 — editing: the sofa slides across the room, the wall changes colour. */
function T5Demo() {
  return (
    <svg viewBox="0 0 320 240" width="100%" style={{ maxWidth: 420 }} aria-hidden>
      <rect x="44" y="42" width="232" height="156" rx="2" fill="none" stroke="var(--text-dim)" strokeWidth="3" strokeLinejoin="round" />
      {/* the wall being repainted */}
      <rect x="44" y="42" width="232" height="10" className="t5-wall" />
      {/* the sofa on the move */}
      <g className="t5-sofa">
        <rect x="0" y="0" width="64" height="30" rx="5" fill="var(--accent-warm)" />
        <rect x="0" y="-8" width="64" height="12" rx="5" fill="var(--accent-warm)" opacity="0.7" />
      </g>
      {/* palette dots */}
      <g className="t5-palette">
        <circle cx="236" cy="222" r="8" fill="#9CAF88" />
        <circle cx="258" cy="222" r="8" fill="#C97B5A" />
        <circle cx="280" cy="222" r="8" fill="#4C6E8F" />
      </g>
    </svg>
  );
}

const DEMOS = [T1Demo, T2Demo, T3Demo, T4Demo, T5Demo] as const;

export function Tutorial() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const setTutorialSeen = useSettings((s) => s.setTutorialSeen);

  const finish = () => {
    setTutorialSeen(true);
    navigate("/", { replace: true });
  };

  const current = STEPS[step]!;
  const Demo = DEMOS[step] ?? T1Demo;
  return (
    <main className="tutorial" data-testid="tutorial">
      <PillButton variant="ghost" className="tutorial-skip" onClick={finish} data-testid="tutorial-skip">
        Skip
      </PillButton>
      <div className="tutorial-demo">
        <Demo />
      </div>
      <h2 className="type-display-l" style={{ margin: "0 0 8px", textAlign: "center" }}>
        {current.title}
      </h2>
      <p style={{ margin: 0, textAlign: "center", color: "var(--text-dim)" }}>{current.sentence}</p>
      {/* A group of buttons, not a tablist: the panels aren't tabpanels, and
          claiming a role whose required children aren't there breaks the
          reading order it promises. */}
      <div className="tutorial-dots" role="group" aria-label="Tutorial steps">
        {STEPS.map((s, i) => (
          <button
            key={s.title}
            aria-current={i === step ? "step" : undefined}
            aria-label={`Step ${i + 1} of ${STEPS.length}: ${s.title}`}
            onClick={() => setStep(i)}
          />
        ))}
      </div>
      <PillButton
        variant="primary"
        style={{ alignSelf: "center", minWidth: 200 }}
        onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))}
      >
        {step === STEPS.length - 1 ? "Start drawing" : "Next"}
      </PillButton>
    </main>
  );
}
