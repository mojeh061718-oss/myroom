import { useEffect, useRef, useState } from "react";
import { parseDisplayLength } from "@myroom/geometry";

interface Props {
  x: number;
  y: number;
  initial: string;
  onCommit: (meters: number) => void;
  onCancel: () => void;
}

/**
 * Tappable dimension field (docs/04 §4): parses "3.76", "3.76m", "376cm",
 * "12'4\"", "12ft 4in". Typed dimensions beat drawn ones.
 */
export function DimensionInputOverlay({ x, y, initial, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial.trim());
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const meters = parseDisplayLength(value);
    if (meters === null) {
      setInvalid(true);
      return;
    }
    onCommit(meters);
  };

  return (
    <div className="dimension-input-overlay" style={{ left: x, top: y }}>
      <input
        ref={ref}
        data-testid="dimension-input"
        className={invalid ? "shake" : undefined}
        value={value}
        inputMode="text"
        aria-label="Wall length"
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
      />
    </div>
  );
}
