import { describe, expect, it } from "vitest";
import { TurnAssembler, addMutedTime, mostlyDuringPlayback, type AssembledTurn, type DgWord, type Span } from "../server/turnAssembler";

const words = (speaker: number, start: number, text: string): DgWord[] =>
  text.split(" ").map((w, i) => ({ word: w.toLowerCase(), punctuated_word: w, start: start + i * 0.3, end: start + i * 0.3 + 0.25, speaker }));

const results = (ws: DgWord[], opts: { is_final: boolean; speech_final?: boolean }) => ({
  type: "Results",
  start: ws[0]!.start,
  duration: ws.at(-1)!.end - ws[0]!.start,
  is_final: opts.is_final,
  speech_final: opts.speech_final ?? false,
  channel: { alternatives: [{ transcript: ws.map((w) => w.punctuated_word).join(" "), words: ws }] },
});

function make() {
  const turns: AssembledTurn[] = [];
  const partials: string[] = [];
  const a = new TurnAssembler("conn", (t) => turns.push(t), (_l, t) => partials.push(t), 10_000);
  return { a, turns, partials };
}

describe("TurnAssembler", () => {
  it("treats interim results as display-only", () => {
    const { a, turns, partials } = make();
    a.handle(results(words(0, 0, "Did you"), { is_final: false }));
    expect(partials).toEqual(["Did you"]);
    expect(turns).toHaveLength(0);
  });

  it("assembles final segments until speech_final", () => {
    const { a, turns } = make();
    a.handle(results(words(1, 0, "Did you push"), { is_final: true }));
    expect(turns).toHaveLength(0);
    a.handle(results(words(1, 1, "the frontend PR?"), { is_final: true, speech_final: true }));
    expect(turns).toEqual([expect.objectContaining({ speakerLabel: "spk1", text: "Did you push the frontend PR?" })]);
  });

  it("flushes on UtteranceEnd", () => {
    const { a, turns } = make();
    a.handle(results(words(0, 0, "Yes it's pushed."), { is_final: true }));
    a.handle({ type: "UtteranceEnd" });
    expect(turns.map((t) => t.text)).toEqual(["Yes it's pushed."]);
  });

  it("splits a real handoff, including a short reply after a pause", () => {
    const { a, turns } = make();
    // "Is it up?" ends at 0.85 s; "Yes." starts at 1.4 s
    a.handle(results([...words(1, 0, "Is it up?"), ...words(0, 1.4, "Yes.")], { is_final: true, speech_final: true }));
    expect(turns.map((t) => [t.speakerLabel, t.text])).toEqual([
      ["spk1", "Is it up?"],
      ["spk0", "Yes."],
    ]);
  });

  it("splits two substantial runs from different speakers", () => {
    const { a, turns } = make();
    a.handle(
      results([...words(1, 0, "Did you push the PR?"), ...words(0, 1.6, "Yes it is pushed.")], { is_final: true, speech_final: true }),
    );
    expect(turns.map((t) => t.speakerLabel)).toEqual(["spk1", "spk0"]);
  });

  it("absorbs a one-word label flicker in the middle of a sentence", () => {
    const { a, turns } = make();
    const ws = words(0, 0, "This is the dumbest thing I ever seen.");
    ws[6]!.speaker = 2; // "ever" mislabeled
    a.handle(results(ws, { is_final: true, speech_final: true }));
    expect(turns.map((t) => [t.speakerLabel, t.text])).toEqual([["spk0", "This is the dumbest thing I ever seen."]]);
  });

  it("absorbs a trailing flicker word with no pause before it", () => {
    const { a, turns } = make();
    const ws = words(0, 0, "Spit the shit out already");
    ws[4]!.speaker = 1;
    a.handle(results(ws, { is_final: true, speech_final: true }));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.speakerLabel).toBe("spk0");
  });

  it("attributes a merged turn to the speaker with the most speech time", () => {
    const { a, turns } = make();
    const ws = words(1, 0, "Is the frontend code up yet?");
    ws[0]!.speaker = 0; // first word flickers to the owner's label
    a.handle(results(ws, { is_final: true, speech_final: true }));
    expect(turns.map((t) => t.speakerLabel)).toEqual(["spk1"]);
  });

  it("ignores a replayed final segment", () => {
    const { a, turns } = make();
    const seg = results(words(1, 0, "Is it up?"), { is_final: true, speech_final: true });
    a.handle(seg);
    a.handle(seg);
    expect(turns).toHaveLength(1);
  });

  it("gives a turn a stable provider event id", () => {
    const { a, turns } = make();
    a.handle(results(words(2, 3.5, "Hello there."), { is_final: true, speech_final: true }));
    expect(turns[0]!.providerEventId).toBe("conn:3.500:2");
  });
});

describe("echo suppression by capture time", () => {
  it("drops a turn spoken while the imp was talking, even if transcribed after", () => {
    const spans: Span[] = [];
    addMutedTime(spans, 10, 10.1);
    addMutedTime(spans, 10.1, 13); // contiguous chunks merge
    expect(spans).toEqual([[10, 13]]);
    expect(mostlyDuringPlayback(spans, 10.2, 12.9)).toBe(true); // the imp's own line
    expect(mostlyDuringPlayback(spans, 12.8, 13.2)).toBe(true); // its tail, within the pad
    expect(mostlyDuringPlayback(spans, 13.05, 14.8)).toBe(false); // someone starting right as it stops
    expect(mostlyDuringPlayback(spans, 14, 16)).toBe(false); // someone speaking afterwards
    expect(mostlyDuringPlayback(spans, 9, 11)).toBe(false); // half before it started: keep
  });

  it("forgets old spans", () => {
    const spans: Span[] = [[0, 1]];
    addMutedTime(spans, 200, 201);
    expect(spans).toEqual([[200, 201]]);
  });
});

describe("word-level echo filter", () => {
  it("keeps the visitor's question when Deepgram glues it to the imp's echo", () => {
    const turns: AssembledTurn[] = [];
    const spans: Span[] = [[0, 2.0]]; // the imp was talking until 2.0 s
    const a = new TurnAssembler("c", (t) => turns.push(t), () => {}, 10_000, (w) => mostlyDuringPlayback(spans, w.start, w.end));
    // "That's the one." (echo) then "Is it up?" (Bob), one utterance with one speaker label
    a.handle(results([...words(1, 1.0, "That's the one."), ...words(1, 2.2, "Is it up?")], { is_final: true, speech_final: true }));
    expect(turns.map((t) => t.text)).toEqual(["Is it up?"]);
  });
});

describe("Speechmatics adapter", () => {
  it("turns AddTranscript into assembler results with string speaker labels", async () => {
    const { smToResults } = await import("../server/providers/stt");
    const turns: AssembledTurn[] = [];
    const a = new TurnAssembler("c", (t) => turns.push(t), () => {}, 10_000);
    const word = (content: string, start: number, speaker: string) => ({ type: "word", start_time: start, end_time: start + 0.3, alternatives: [{ content, speaker }] });
    a.handle(
      smToResults({
        message: "AddTranscript",
        metadata: { start_time: 0, end_time: 2, transcript: "Is it up? Yes." },
        results: [word("Is", 0, "S1"), word("it", 0.35, "S1"), word("up", 0.7, "S1"), { type: "punctuation", start_time: 1, end_time: 1, alternatives: [{ content: "?" }] }, word("Yes", 1.6, "owner"), { type: "punctuation", start_time: 1.9, end_time: 1.9, alternatives: [{ content: "." }] }],
      }),
    );
    a.handle({ type: "UtteranceEnd" }); // from Speechmatics EndOfUtterance
    expect(turns.map((t) => [t.speakerLabel, t.text])).toEqual([
      ["S1", "Is it up?"],
      ["owner", "Yes."],
    ]);
  });
});
