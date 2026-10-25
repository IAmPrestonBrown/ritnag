import { describe, expect, it } from "vitest";
import { THINKING_LINES, formatLatency, thinkingLine } from "../src/components/thinking";

describe("thinking caption", () => {
  it("rotates through every line and wraps around", () => {
    const seen = THINKING_LINES.map((_, i) => thinkingLine(i));
    expect(new Set(seen).size).toBe(THINKING_LINES.length);
    expect(thinkingLine(THINKING_LINES.length)).toBe(thinkingLine(0));
  });
});

describe("formatLatency", () => {
  it.each([
    [1840, "1.8 s"],
    [950, "0.9 s"],
    [12_345, "12.3 s"],
    [0, "0.0 s"],
  ])("shows %i ms as %s", (ms, shown) => {
    expect(formatLatency(ms)).toBe(shown);
  });
});
