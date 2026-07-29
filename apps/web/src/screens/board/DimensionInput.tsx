import { useEffect, useRef, useState } from "react";
import { parseDisplayLength, type DisplayUnit } from "@myroom/geometry";

interface Props {
  x: number;
  y: number;
  initial: string;
  unit: DisplayUnit;
  onCommit: (meters: number) => void;
  onCancel: () => void;
}

/**
 * Tappable dimension field (docs/04 §4): parses "3.76", "3.76m", "376cm",
 * "12'4\"", "12ft 4in". A bare number is read in the display unit the label
 * shows. Typed dimensions beat drawn ones.
 */
export function DimensionInputOverlay({ x, y, initial, unit, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial.trim());
  const [shaking, setShaking] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const meters = parseDisplayLength(value, unit);
    if (meters === null) {
      setInvalid(true);
      setShaking(true);
      return;
    }
    onCommit(meters);
  };

  return (
    <div className="dimension-input-overlay" style={{ left: x, top: y }}>
      <input
        ref={ref}
        data-testid="dimension-input"
        className={shaking ? "shake" : undefined}
        value={value}
        inputMode="text"
        aria-label="Wall length"
        aria-invalid={invalid || undefined}
        // Clearing the class when the animation finishes lets a repeat bad
        // entry shake again instead of silently doing nothing.
        onAnimationEnd={() => setShaking(false)}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          // Dismissing the keyboard shouldn't throw away a valid entry; only
          // an unparseable or unchanged value cancels.
          if (value.trim() === initial.trim() || parseDisplayLength(value, unit) === null) {
            onCancel();
            return;
          }
          commit();
        }}
      />
    </div>
  );
}
