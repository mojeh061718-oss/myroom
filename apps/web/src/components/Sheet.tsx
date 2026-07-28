import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** dismissable defaults true; the wall-height sheet requires a choice */
  dismissable?: boolean;
  children: ReactNode;
  labelledBy?: string;
}

/** docs/02 §4 bottom sheet: grabber, spring-in, drag-to-dismiss. */
export function Sheet({ open, onClose, dismissable = true, children, labelledBy }: Props) {
  const startY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={dismissable ? onClose : undefined} />
      <div
        ref={sheetRef}
        className="sheet glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onPointerDown={(e) => {
          startY.current = e.clientY;
        }}
        onPointerMove={(e) => {
          if (startY.current === null || !sheetRef.current) return;
          const dy = Math.max(0, e.clientY - startY.current);
          sheetRef.current.style.transform = `translateY(${dy}px)`;
        }}
        onPointerUp={(e) => {
          if (startY.current === null || !sheetRef.current) return;
          const dy = e.clientY - startY.current;
          sheetRef.current.style.transform = "";
          startY.current = null;
          if (dy > 120 && dismissable) onClose();
        }}
      >
        <div className="sheet-grabber" aria-hidden />
        {children}
      </div>
    </>
  );
}
