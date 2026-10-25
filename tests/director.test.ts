import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCRIPT, Director, parseScript } from "../src/director";
import { DirectorRequest, Timeline } from "../shared/director";
import type { Notice, Snapshot } from "../shared/events";

const real = (): Snapshot =>
  ({
    storage: "local-json",
    index: { configured: true, ready: true, docCount: 3, lastError: "billing", lastPushAt: null, pushPending: false },
    ownerName: "Preston",
    session: {
      id: "s",
      generation: 1,
      connectionId: "sm-1",
      focusMode: false,
      listening: false,
      ownerSpeakerLabel: null,
      bindings: {},
      pendingUnknownSpeaker: null,
      calibration: { active: false, candidate: null },
      suggestions: [],
      speechLabels: ["S1"],
      voice: {} as Snapshot["session"]["voice"],
    },
    people: [{ id: "p-leon", name: "Leon", relationship: null, tone: "neutral", priority: false, ownerConfiguredAt: 0 }],
    memories: [],
    counts: { total: 7, byPerson: {}, byMemory: {} },
    alerts: [],
    transcript: [{ id: "real-1", text: "a real line" }],
  }) as unknown as Snapshot;

function setup() {
  const d = new Director();
  const notices: Notice[] = [];
  const spoken: string[] = [];
  let chimes = 0;
  d.hooks = {
    notice: (n) => notices.push(n),
    speak: async (t) => void spoken.push(t),
    demo: () => {},
    chime: () => void chimes++,
    status: () => {},
  };
  return { d, notices, spoken, chimes: () => chimes };
}

describe("director script", () => {
  it("splits paragraphs into cues and parses each line, JSON lines included", () => {
    const cues = parseScript(`owner: Heads down.

guest S4: What's the wifi?
notice question: New question detected | What's the wifi?
think 900
imp savage: Read the sign.
Leon: Hi.
{"do":"tab","tab":"memory"}
nonsense line`);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual([{ do: "say", who: "owner", text: "Heads down." }]);
    expect(cues[1]).toEqual([
      { do: "say", who: "guest S4", text: "What's the wifi?" },
      { do: "notice", kind: "question", title: "New question detected", detail: "What's the wifi?" },
      { do: "think", ms: 900 },
      { do: "imp", tone: "savage", text: "Read the sign." },
      { do: "say", who: "Leon", text: "Hi." },
      { do: "tab", tab: "memory" },
    ]);
  });

  it("the example timeline in the docs is valid", () => {
    const tl = Timeline.parse(JSON.parse(readFileSync(new URL("../docs/director/example-timeline.json", import.meta.url), "utf8")));
    expect(tl.events.length).toBeGreaterThan(10);
  });

  it("the default script parses fully", () => {
    expect(parseScript(DEFAULT_SCRIPT).flat().length).toBe(DEFAULT_SCRIPT.split("\n").filter((l) => l.trim()).length);
  });
});

describe("director engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays a timeline on time: words stream in, rows land, pop-ups fire, real data stays hidden", async () => {
    const { d, notices, spoken } = setup();
    d.play({
      events: [
        { at: 0, do: "listening", on: true },
        { at: 1000, do: "say", who: "guest", text: "what is the wifi", ms: 1200 },
        { at: 2400, do: "notice", kind: "question", title: "New question detected" },
        { at: 3000, do: "imp", text: "Ask the owner.", voice: true },
      ],
    });
    expect(d.stage.isolated).toBe(true);
    expect(d.stage.playing).toBe(true);
    await vi.advanceTimersByTimeAsync(1350);
    expect(d.stage.partial).toEqual({ speakerLabel: "S2", text: "what is" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.stage.partial).toBeNull();
    expect(d.stage.rows.map((r) => r.text)).toEqual(["what is the wifi"]);
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(700);
    expect(notices.map((n) => n.title)).toEqual(["New question detected"]);
    expect(spoken).toEqual(["Ask the owner."]);
    expect(d.stage.playing).toBe(false);

    const view = d.view(real());
    expect(view.transcript.map((u) => u.text)).toEqual(["what is the wifi"]); // real line hidden
    expect(view.people).toEqual([]);
    expect(view.counts.total).toBe(0);
    expect(view.index.lastError).toBeNull(); // no "Settings (!)" in the recording
    expect(view.session.listening).toBe(true);
    expect(view.session.connectionId).toBeNull(); // no "who just spoke?" chips
  });

  it("starting mid-way shows earlier rows at once and skips earlier pop-ups", async () => {
    const { d, notices } = setup();
    d.play(
      {
        events: [
          { at: 0, do: "say", who: "owner", text: "one two three" },
          { at: 100, do: "notice", kind: "name", title: "Leon detected" },
          { at: 200, do: "memory", question: "wifi?", answer: "calhacks2026" },
          { at: 5000, do: "notice", kind: "repeat", title: "Answer repeated" },
        ],
      },
      4000,
    );
    expect(d.stage.rows.map((r) => r.text)).toEqual(["one two three"]);
    expect(d.stage.memories).toHaveLength(1);
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(notices.map((n) => n.title)).toEqual(["Answer repeated"]);
  });

  it("memory, repeat, person, alert and the receipt work together", async () => {
    const { d, chimes } = setup();
    await d.run([
      { do: "reset" },
      { do: "say", who: "owner", text: "It's calhacks2026.", ms: 0 },
      { do: "memory", id: "wifi", question: "What's the wifi password?", answer: "calhacks2026" },
      { do: "say", who: "Leon", text: "Wifi?", ms: 0 },
      { do: "repeat", memory: "wifi", who: "Leon" },
      { do: "caption", text: "checkpoint" },
    ]);
    expect(d.stage.receipt).toBe("Recalled from memory (asked 1×): “calhacks2026”");
    await d.run([
      { do: "alert", who: "Leon", question: "Can you approve the deploy?", reason: "Approval request" },
    ]);
    const view = d.view(real());
    expect(view.memories[0]!.timesAsked).toBe(1);
    expect(view.memories[0]!.sourceUtteranceIds).toEqual([view.transcript[0]!.id]); // "from “It's calhacks2026.”"
    expect(d.stage.highlight).toEqual(["wifi"]);
    expect(d.stage.receipt).toBe("Escalated to the owner: Approval request"); // the alert came last
    expect(view.counts.total).toBe(1);
    // Leon is a scripted person; isolated, so the real Leon card isn't merged in
    expect(view.people.map((p) => p.name)).toEqual(["Leon"]);
    const alert = view.alerts[0]!;
    expect(view.transcript.find((u) => u.id === alert.questionUtteranceId)?.text).toBe("Can you approve the deploy?");
    expect(alert.personId).toBe(view.people[0]!.id);
    expect(chimes()).toBe(1);
    await d.run({ do: "ack" });
    expect(d.view(real()).alerts).toEqual([]);
  });

  it("without isolation, scripted rows join the real ones and a scripted name maps to the real person", async () => {
    const { d } = setup();
    await d.run({ do: "say", who: "Leon", text: "yo", ms: 0 });
    const view = d.view(real());
    expect(view.transcript.map((u) => u.text)).toEqual(["a real line", "yo"]);
    expect(view.transcript[1]!.personId).toBe("p-leon");
    expect(view.people).toHaveLength(1);
  });

  it("while directing, only the director's own speech plays", async () => {
    const { d } = setup();
    expect(d.claimSpeech("live answer")).toBe(true); // not directing: everything plays
    await d.run({ do: "imp", text: "Scripted line." });
    expect(d.claimSpeech("live answer")).toBe(false);
    expect(d.claimSpeech("Scripted line.")).toBe(true);
    expect(d.claimSpeech("Scripted line.")).toBe(false); // once per line sent
    d.reset(false);
    expect(d.claimSpeech("live answer")).toBe(true);
  });

  it("silent imp speech moves the mouth for the given time", async () => {
    const { d, spoken } = setup();
    const done = d.run({ do: "imp", text: "Matches the recorded audio.", voice: false, ms: 2000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(d.stage.speaking).toBe(true);
    expect(d.stage.caption).toBe("Matches the recorded audio.");
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(d.stage.speaking).toBe(false);
    expect(spoken).toEqual([]);
  });

  it("stop ends playback and an awaited run doesn't hang", async () => {
    const { d } = setup();
    const done = d.run([{ do: "wait", ms: 60_000 }, { do: "caption", text: "never" }]);
    d.stop();
    await done;
    expect(d.stage.caption).toBeNull();
  });

  it("rejects malformed commands with a useful error", async () => {
    const { d } = setup();
    await expect(d.run({ do: "notice", kind: "nope", title: "x" })).rejects.toThrow();
    expect(Timeline.safeParse({ events: [{ do: "say", who: "owner", text: "hi" }] }).success).toBe(false); // needs `at`
    expect(DirectorRequest.safeParse({ timeline: { events: [{ at: 0, do: "tab", tab: "people" }] } }).success).toBe(true);
  });
});
