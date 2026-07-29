import { useEffect, useRef, useState } from "react";
import { PillButton } from "../../components/PillButton.js";

/**
 * A/B compare (docs/06 §6): two versions rendered from an identical camera,
 * composited under a slider. Both frames are captured from the live renderer
 * without moving the camera, so the only difference on screen is the design.
 */
export function CompareSlider({
  before,
  after,
  beforeName,
  afterName,
  onClose,
}: {
  before: string;
  after: string;
  beforeName: string;
  afterName: string;
  onClose: () => void;
}) {
  const [split, setSplit] = useState(50);
  const [wrapWidth, setWrapWidth] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapWidth(el.clientWidth));
    ro.observe(el);
    setWrapWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const setFromPointer = (clientX: number) => {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return;
    setSplit(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  };

  return (
    <div className="compare-overlay" data-testid="compare-overlay">
      <div
        className="compare-stage"
        ref={wrap}
        onPointerDown={(e) => setFromPointer(e.clientX)}
        onPointerMove={(e) => e.buttons === 1 && setFromPointer(e.clientX)}
      >
        <img src={after} alt={afterName} className="compare-img" />
        <div className="compare-clip" style={{ width: `${split}%` }}>
          {/* The clipped copy keeps the stage's full width so both frames stay
              pixel-registered as the split moves. */}
          <div style={{ position: "absolute", inset: 0, width: wrapWidth || "100%" }}>
            <img src={before} alt={beforeName} className="compare-img" />
          </div>
        </div>
        <div className="compare-handle" style={{ left: `${split}%` }} aria-hidden />
        <span className="compare-label left">{beforeName}</span>
        <span className="compare-label right">{afterName}</span>
      </div>

      <input
        className="compare-range"
        type="range"
        min={0}
        max={100}
        value={split}
        aria-label={`Compare ${beforeName} with ${afterName}`}
        data-testid="compare-range"
        onChange={(e) => setSplit(Number(e.target.value))}
      />
      <PillButton variant="primary" onClick={onClose} data-testid="compare-close">
        Done
      </PillButton>
    </div>
  );
}
