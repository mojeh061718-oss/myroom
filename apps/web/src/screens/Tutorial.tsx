import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PillButton } from "../components/PillButton.js";
import { useSettings } from "../stores/settingsStore.js";

/**
 * T1–T5 — Tutorial (docs/01 §3). Skip is always visible top-right on every
 * step; page dots allow jumping. Completing OR skipping sets tutorialSeen.
 * M1 ships T1 content only; T2–T5 are placeholders (docs/09 M1) whose final
 * animations land in M6.
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

function PlaceholderDemo({ index }: { index: number }) {
  return (
    <div
      className="card"
      style={{ width: "100%", maxWidth: 420, aspectRatio: "4 / 3", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <span className="type-caption">Demo animation — coming with the finished engine (M6) · step {index + 1}</span>
    </div>
  );
}

export function Tutorial() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const setTutorialSeen = useSettings((s) => s.setTutorialSeen);

  const finish = () => {
    setTutorialSeen(true);
    navigate("/", { replace: true });
  };

  const current = STEPS[step]!;
  return (
    <div className="tutorial" data-testid="tutorial">
      <PillButton variant="ghost" className="tutorial-skip" onClick={finish} data-testid="tutorial-skip">
        Skip
      </PillButton>
      <div className="tutorial-demo">{step === 0 ? <T1Demo /> : <PlaceholderDemo index={step} />}</div>
      <h2 className="type-display-l" style={{ margin: "0 0 8px", textAlign: "center" }}>
        {current.title}
      </h2>
      <p style={{ margin: 0, textAlign: "center", color: "var(--text-dim)" }}>{current.sentence}</p>
      <div className="tutorial-dots" role="tablist" aria-label="Tutorial steps">
        {STEPS.map((s, i) => (
          <button key={s.title} aria-current={i === step} aria-label={`Step ${i + 1}: ${s.title}`} onClick={() => setStep(i)} />
        ))}
      </div>
      <PillButton
        variant="primary"
        style={{ alignSelf: "center", minWidth: 200 }}
        onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))}
      >
        {step === STEPS.length - 1 ? "Start drawing" : "Next"}
      </PillButton>
    </div>
  );
}
