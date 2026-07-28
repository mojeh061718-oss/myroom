import { create } from "zustand";

interface ToastItem {
  id: number;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  show: (message: string) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 3200);
  },
}));

export function ToastRegion() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.message}
        </div>
      ))}
    </div>
  );
}
