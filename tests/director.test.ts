import { describe, expect, it } from "vitest";
import { DEFAULT_SCRIPT, parseScript } from "../src/director";

describe("director script", () => {
  it("splits paragraphs into cues and parses each line", () => {
    const cues = parseScript(`owner: Heads down.

guest S4: What's the wifi?
notice question: New question detected | What's the wifi?
think 900
imp savage: Read the sign.
Leon: Hi.
nonsense line`);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual([{ kind: "say", who: "owner", label: "S1", name: null, text: "Heads down." }]);
    const [guest, notice, think, imp, leon] = cues[1]!;
    expect(guest).toMatchObject({ kind: "say", who: "guest", label: "S4" });
    expect(notice).toEqual({ kind: "notice", notice: { kind: "question", title: "New question detected", detail: "What's the wifi?" } });
    expect(think).toEqual({ kind: "think", ms: 900 });
    expect(imp).toEqual({ kind: "imp", tone: "savage", text: "Read the sign." });
    expect(leon).toMatchObject({ kind: "say", who: "named", name: "Leon", text: "Hi." });
    expect(cues[1]).toHaveLength(5);
  });

  it("the default script parses fully", () => {
    const cues = parseScript(DEFAULT_SCRIPT);
    expect(cues.length).toBeGreaterThan(2);
    expect(cues.flat().length).toBe(DEFAULT_SCRIPT.split("\n").filter((l) => l.trim()).length);
  });
});
