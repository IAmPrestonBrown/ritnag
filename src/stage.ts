import type { DecisionSummary } from "../shared/events";

/** How often the thinking caption rotates while the imp waits on retrieval + Claude. */
export const THINKING_LINE_MS = 1000;

/** Shown in order while thinking, so the ~3 s wait reads as the character working. */
export const THINKING_LINES = [
  "Hmm…",
  "Digging through what you told me…",
  "Checking who's asked this before…",
  "Sharpening a comeback…",
];

export function thinkingLine(tick: number): string {
  return THINKING_LINES[Math.min(tick, THINKING_LINES.length - 1)] ?? "Hmm…";
}

/** "1.8 s": judges read seconds, not milliseconds. */
export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The technical-depth line under the imp: ANSWER · cited m_42 · Moss 3 hits · 1.8 s. */
export function decisionDetails(d: DecisionSummary): string[] {
  return [
    ...(d.memoryIds.length > 0 ? [`cited ${d.memoryIds.join(", ")}`] : []),
    d.retrieval.mode === "moss" ? `Moss ${d.retrieval.hits.length} ${d.retrieval.hits.length === 1 ? "hit" : "hits"}` : "Moss unavailable",
    formatLatency(d.latencyMs),
    ...(d.note ? [d.note] : []),
  ];
}
