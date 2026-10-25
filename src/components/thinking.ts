import { useEffect, useState } from "react";

/** Shown while a decision is in flight, so a 2-3 s wait reads as work, not lag. */
export const THINKING_LINES = ["Hmm…", "Checking my notes…", "Digging through memory…", "One sec…"];
const ROTATE_MS = 900;

export const thinkingLine = (tick: number) => THINKING_LINES[tick % THINKING_LINES.length]!;

/** 1840 → "1.8 s". */
export const formatLatency = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A rotating "hmm…" caption while `active`, else null. Starts from the first line each time. */
export function useThinkingCaption(active: boolean): string | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), ROTATE_MS);
    return () => {
      clearInterval(id);
      setTick(0);
    };
  }, [active]);
  return active ? thinkingLine(tick) : null;
}
