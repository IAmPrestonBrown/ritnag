import { describe, expect, it } from "vitest";
import { gatedPrediction, labelForSpan, outcome, segmentWords, tally } from "../scripts/bakeoff/score";
import { parseWav } from "../scripts/bakeoff/wav";
import { wavFromPcm16 } from "../server/voice/recordings";

const w = (speaker: string, start: number, end: number, content = "x") => ({ speaker, start, end, content });

describe("bake-off scoring", () => {
  it("segments on speaker change and on long pauses", () => {
    const segs = segmentWords("c.wav", [w("S1", 0, 0.3, "Is"), w("S1", 0.35, 0.6, "it"), w("S2", 0.9, 1.2, "Yes"), w("S2", 2.5, 2.8, "Later")]);
    expect(segs.map((s) => [s.smLabel, s.text, s.start, s.end])).toEqual([
      ["S1", "Is it", 0, 0.6],
      ["S2", "Yes", 0.9, 1.2],
      ["S2", "Later", 2.5, 2.8],
    ]);
    expect(segs.every((s) => s.truth === null)).toBe(true);
  });

  it("maps a time span to the label covering most of it", () => {
    const words = [w("Preston", 0, 1), w("Leon", 1, 1.2), w("Preston", 1.2, 2)];
    expect(labelForSpan(words, 0, 2)).toBe("Preston");
    expect(labelForSpan(words, 1.0, 1.15)).toBe("Leon");
    expect(labelForSpan(words, 5, 6)).toBeNull();
  });

  it("generic is right only for unenrolled voices", () => {
    expect(outcome("other", null)).toBe("correct");
    expect(outcome("Leon", null)).toBe("generic");
    expect(outcome("Leon", "Preston")).toBe("wrong");
  });

  it("counts others taken as the owner separately", () => {
    const t = tally(
      [
        { truth: "Preston", predicted: "Preston" },
        { truth: "Leon", predicted: "Preston" },
        { truth: "Leon", predicted: null },
        { truth: "other", predicted: null },
      ],
      "Preston",
    );
    expect(t).toMatchObject({ n: 4, correct: 2, wrong: 1, generic: 1, ownerHits: 1, ownerTurns: 1, ownerFalseAccepts: 1 });
  });

  it("the certainty gate needs both a high score and a clear margin", () => {
    expect(gatedPrediction({ Preston: 0.8, Leon: 0.78 }, 0.5, 0.1)).toBeNull(); // close call
    expect(gatedPrediction({ Preston: 0.8, Leon: 0.5 }, 0.5, 0.1)).toBe("Preston");
    expect(gatedPrediction({ Preston: 0.45, Leon: 0.1 }, 0.5, 0.1)).toBeNull(); // nobody is a good match
  });

  it("reads WAVs with extra chunks before data, and the recorder's own WAVs", () => {
    const plain = wavFromPcm16(new Int16Array([1, -2, 3]), 16000);
    expect(parseWav(plain)).toMatchObject({ sampleRate: 16000, pcm: new Int16Array([1, -2, 3]) });
    // insert an odd-sized "LIST" chunk after fmt (word-aligned, so 1 pad byte)
    const extra = Buffer.concat([Buffer.from("LIST"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc"), Buffer.from([0])]);
    const withChunk = Buffer.concat([plain.subarray(0, 36), extra, plain.subarray(36)]);
    withChunk.writeUInt32LE(withChunk.length - 8, 4);
    expect(Array.from(parseWav(withChunk).pcm)).toEqual([1, -2, 3]);
  });
});
