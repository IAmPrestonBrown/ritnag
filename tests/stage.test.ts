import { describe, expect, it } from "vitest";
import type { DecisionSummary } from "../shared/events";
import { THINKING_LINES, decisionDetails, formatLatency, thinkingLine } from "../src/stage";

const decision = (over: Partial<DecisionSummary> = {}): DecisionSummary => ({
  turnId: "t1",
  action: "ANSWER",
  personId: null,
  memoryIds: ["m_42"],
  spokenText: "Friday.",
  responseId: "r1",
  latencyMs: 1840,
  note: null,
  retrieval: { mode: "moss", hits: [{ id: "m_42", score: 0.9 }, { id: "m_7", score: 0.5 }, { id: "m_9", score: 0.4 }] },
  ...over,
});

describe("stage decision line", () => {
  it("formats latency in seconds with one decimal", () => {
    expect(formatLatency(1840)).toBe("1.8 s");
    expect(formatLatency(640)).toBe("0.6 s");
  });

  it("renders cited memories, Moss hits and latency in order", () => {
    expect(decisionDetails(decision())).toEqual(["cited m_42", "Moss 3 hits", "1.8 s"]);
  });

  it("omits citations when none, singularizes one hit, appends the note", () => {
    const d = decision({ memoryIds: [], note: "low confidence", retrieval: { mode: "moss", hits: [{ id: "m_1", score: 0.3 }] } });
    expect(decisionDetails(d)).toEqual(["Moss 1 hit", "1.8 s", "low confidence"]);
  });

  it("says when Moss was unavailable", () => {
    expect(decisionDetails(decision({ retrieval: { mode: "unavailable", hits: [] } }))).toContain("Moss unavailable");
  });
});

describe("thinking caption", () => {
  it("walks the lines in order and holds on the last one", () => {
    expect(thinkingLine(0)).toBe(THINKING_LINES[0]);
    expect(thinkingLine(1)).toBe(THINKING_LINES[1]);
    expect(thinkingLine(99)).toBe(THINKING_LINES[THINKING_LINES.length - 1]);
  });
});
