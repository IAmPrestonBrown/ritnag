import { useCallback, useRef, useState } from "react";
import type { Notice } from "../../shared/events";

const SHOW_MS = 4500;
const MAX = 4;

const LABEL: Record<Notice["kind"], string> = {
  person: "New person",
  question: "Question",
  repeat: "Repeat",
  name: "Recognized",
};

interface Toast extends Notice {
  id: number;
  leaving: boolean;
}

/** Pop-ups for the room's big moments. Newest on top; each drains a time bar, then slides out. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((n: Notice) => {
    const id = nextId.current++;
    setToasts((ts) => [{ ...n, id, leaving: false }, ...ts].slice(0, MAX));
  }, []);
  const leave = useCallback((id: number) => setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t))), []);
  const remove = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  return { toasts, push, leave, remove };
}

export function Toasts({ toasts, onLeave, onRemove }: { toasts: Toast[]; onLeave: (id: number) => void; onRemove: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}${t.leaving ? " leaving" : ""}`}
          onClick={() => onLeave(t.id)}
          onAnimationEnd={(e) => e.animationName === "toast-out" && onRemove(t.id)}
        >
          <span className="toast-kind">{LABEL[t.kind]}</span>
          <span className="toast-title">{t.title}</span>
          {t.detail && <span className="toast-detail">{t.detail}</span>}
          <span
            className="toast-timer"
            style={{ animationDuration: `${SHOW_MS}ms` }}
            onAnimationEnd={(e) => {
              e.stopPropagation();
              onLeave(t.id);
            }}
          />
        </div>
      ))}
    </div>
  );
}
