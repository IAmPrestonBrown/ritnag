import type { DecisionSummary } from "../shared/events";
import { formatLatency } from "./components/thinking";

/** The technical-depth line under the imp: ANSWER · cited m_42 · Moss 3 hits · 1.8 s. */
export function decisionDetails(d: DecisionSummary): string[] {
  return [
    ...(d.memoryIds.length > 0 ? [`cited ${d.memoryIds.join(", ")}`] : []),
    d.retrieval.mode === "moss" ? `Moss ${d.retrieval.hits.length} ${d.retrieval.hits.length === 1 ? "hit" : "hits"}` : "Moss unavailable",
    formatLatency(d.latencyMs),
    ...(d.note ? [d.note] : []),
  ];
}
