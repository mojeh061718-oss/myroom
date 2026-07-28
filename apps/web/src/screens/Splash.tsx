import { useEffect } from "react";

interface Props {
  /** app hydration state — the splash simply holds if the app isn't ready (docs/01 §2) */
  ready: boolean;
  onDone: () => void;
}

/** S0 — Splash & brand moment. Auto-advances after 1.8 s or on tap; never a spinner. */
export function Splash({ ready, onDone }: Props) {
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, [ready, onDone]);

  return (
    <div className="splash" onClick={ready ? onDone : undefined} data-testid="splash">
      <h1 className="splash-name type-display-xl">My Room Sandbox</h1>
      <p className="splash-sub type-label">Your room. Reimagined.</p>
    </div>
  );
}
