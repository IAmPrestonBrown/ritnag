import { describe, expect, it } from "vitest";
import { TurnAssembler, type AssembledTurn, type DgWord } from "../server/turnAssembler";

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
