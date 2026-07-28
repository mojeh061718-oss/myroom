import { PillButton } from "./PillButton.js";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** docs/02 §8 ConfirmDialog(destructive) — delete requires confirm (docs/01 §4). */
export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel }: Props) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2 className="type-title" style={{ margin: "0 0 8px" }}>
          {title}
        </h2>
        <p style={{ margin: "0 0 20px", color: "var(--text-dim)" }}>{body}</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <PillButton variant="ghost" onClick={onCancel}>
            Cancel
          </PillButton>
          <PillButton variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </PillButton>
        </div>
      </div>
    </div>
  );
}
