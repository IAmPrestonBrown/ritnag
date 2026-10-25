import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClipQuery, RecordingStore, wavFromPcm16 } from "../server/voice/recordings";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "imp-rec-"));
  dirs.push(d);
  return d;
};

describe("recordings", () => {
  it("writes a valid mono PCM16 WAV header and samples", () => {
    const wav = wavFromPcm16(new Int16Array([0, 1000, -1000, 32767]), 48000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.readInt16LE(44 + 2 * 2)).toBe(-1000);
  });

  it("rejects names that could escape the recordings folder", () => {
    for (const set of ["../etc", "a/b", ".hidden", "", "x".repeat(41)]) {
      expect(ClipQuery.safeParse({ set, kind: "conversation", sampleRate: 48000 }).success).toBe(false);
    }
    expect(ClipQuery.safeParse({ set: "bakeoff-1", kind: "solo", speaker: "../x", sampleRate: 48000 }).success).toBe(false);
    expect(ClipQuery.safeParse({ set: "bakeoff-1", kind: "solo", sampleRate: 48000 }).success).toBe(false); // solo needs speaker
    expect(ClipQuery.safeParse({ set: "bakeoff-1", kind: "solo", speaker: "Leon", sampleRate: "48000" }).success).toBe(true);
  });

  it("saves clips and keeps a manifest per set", () => {
    const root = tmp();
    const store = new RecordingStore(root);
    const pcm = new Int16Array(48000 * 2);
    const a = store.save({ set: "s1", kind: "solo", speaker: "Leon", sampleRate: 48000, device: "MacBook Air Microphone" }, pcm);
    store.save({ set: "s1", kind: "conversation", sampleRate: 48000, device: "MacBook Air Microphone" }, pcm);
    expect(a).toMatchObject({ kind: "solo", speaker: "Leon", durationSec: 2 });
    expect(readFileSync(join(root, "s1", a.file)).length).toBe(44 + pcm.length * 2);
    expect(store.sets()).toEqual([{ set: "s1", clips: [expect.objectContaining({ speaker: "Leon" }), expect.objectContaining({ kind: "conversation", speaker: null })] }]);
  });
});
