import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PcmRing, analyzeTake } from "../server/voice/pcm";
import { calibrateThresholds, normalize, type PcmTake, type SpeakerVerifier } from "../server/voice/verifier";
import { resolveOwner, type ResolveInput } from "../server/voice/resolver";
import { OwnerVoice, enrollmentPrompts } from "../server/voice/ownerVoice";

const RATE = 16_000;

/** Silence, then a tone of `freq` Hz for `sec` seconds, then silence. */
const tone = (freq: number, sec: number, amp = 0.3, rate = RATE) => {
  const pad = Math.round(rate * 0.5);
  const n = Math.round(rate * sec);
  const out = new Float32Array(pad * 2 + n);
  for (let i = 0; i < n; i++) out[pad + i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};

describe("PcmRing", () => {
  it("slices by stream time", () => {
    const r = new PcmRing(10, 10);
    r.append(Int16Array.from({ length: 30 }, (_, i) => i * 100));
    const s = r.slice(1, 2)!;
    expect(s.length).toBe(10);
    expect(Math.round(s[0]! * 32768)).toBe(1000);
  });

  it("reassembles samples split across network chunks", () => {
    const r = new PcmRing(10, 10);
    const bytes = Buffer.from(Int16Array.from([1000, -2000, 3000, -4000]).buffer);
    r.appendBytes(bytes.subarray(0, 3));
    r.appendBytes(bytes.subarray(3, 5));
    r.appendBytes(bytes.subarray(5));
    expect(Array.from(r.slice(0, 1)!, (x) => Math.round(x * 32768))).toEqual([1000, -2000, 3000, -4000]);
  });

  it("wraps around and clamps to what's still buffered", () => {
    const r = new PcmRing(10, 2); // 20 samples
    r.append(Int16Array.from({ length: 25 }, (_, i) => i));
    expect(r.durationSec).toBe(2.5);
    const s = r.slice(0, 2.5)!; // first 0.5 s was overwritten
    expect(s.length).toBe(20);
    expect(Math.round(s[0]! * 32768)).toBe(5);
    expect(Math.round(s.at(-1)! * 32768)).toBe(24);
    expect(r.slice(3, 4)).toBeNull();
  });
});

describe("analyzeTake", () => {
  it("accepts a clear take", () => {
    const a = analyzeTake(tone(220, 3), RATE);
    expect(a.speechSec).toBeGreaterThan(2.5);
    expect(a.issues).toEqual([]);
  });

  it("rejects short, quiet, and clipped takes", () => {
    expect(analyzeTake(tone(220, 1), RATE).issues).toContain("too_short");
    expect(analyzeTake(tone(220, 3, 0.005), RATE).issues).toContain("too_quiet");
    expect(analyzeTake(tone(220, 3, 1.5).map((x) => Math.max(-1, Math.min(1, x))), RATE).issues).toContain("clipped");
  });
});

describe("calibrateThresholds", () => {
  const defaults = { accept: 0.62, reject: 0.45 };

  it("keeps defaults with no evidence", () => {
    expect(calibrateThresholds(defaults, { selfScore: null, impostorScore: null })).toEqual({ thresholds: defaults, warning: null });
  });

  it("tightens around an impostor score and never loosens", () => {
    const r = calibrateThresholds(defaults, { selfScore: 0.85, impostorScore: 0.55 });
    expect(r.thresholds).toEqual({ accept: 0.7, reject: 0.6 });
    expect(r.warning).toBeNull();
    expect(calibrateThresholds(defaults, { selfScore: 0.9, impostorScore: 0.1 }).thresholds).toEqual(defaults);
  });

  it("warns when the owner can't pass or the voices overlap", () => {
    expect(calibrateThresholds(defaults, { selfScore: 0.5, impostorScore: null }).warning).toBe("self_below_accept");
    expect(calibrateThresholds(defaults, { selfScore: 0.7, impostorScore: 0.65 }).warning).toBe("not_separable");
  });
});

describe("resolveOwner", () => {
  const profile = { thresholds: { accept: 0.62, reject: 0.45 }, minScorableSec: 1.2 };
  const speech = (over: Partial<ResolveInput>): ResolveInput => ({
    source: "speech",
    asOwner: false,
    profile,
    score: null,
    durationSec: 2,
    speakerLabel: "spk0",
    calibratedOwnerLabel: null,
    verifiedOwnerLabels: [],
    ...over,
  });

  it("typed input follows the explicit owner flag", () => {
    expect(resolveOwner(speech({ source: "typed", asOwner: true }))).toMatchObject({ isOwner: true, ownerCertain: true, basis: "typed" });
  });

  it("without a profile, falls back to the calibrated label", () => {
    const r = resolveOwner(speech({ profile: null, calibratedOwnerLabel: "spk0", score: 0.1 }));
    expect(r).toMatchObject({ isOwner: true, ownerCertain: true, basis: "label" });
  });

  it("with a profile, the calibrated label grants nothing", () => {
    expect(resolveOwner(speech({ calibratedOwnerLabel: "spk0", score: 0.2 })).isOwner).toBe(false);
  });

  it("accepts, rejects, and leaves the middle uncertain", () => {
    expect(resolveOwner(speech({ score: 0.8 }))).toMatchObject({ isOwner: true, ownerCertain: true, basis: "voice" });
    expect(resolveOwner(speech({ score: 0.3 }))).toMatchObject({ isOwner: false, basis: "voice" });
    expect(resolveOwner(speech({ score: 0.5 }))).toMatchObject({ isOwner: false, basis: "none" });
  });

  it("a short or borderline turn rides on the last two verified owner turns, uncertainly", () => {
    const sticky = speech({ score: null, durationSec: 0.6, verifiedOwnerLabels: ["spk1", "spk0", "spk0"] });
    expect(resolveOwner(sticky)).toMatchObject({ isOwner: true, ownerCertain: false, basis: "stickiness" });
    expect(resolveOwner({ ...sticky, verifiedOwnerLabels: ["spk0", "spk1"] }).isOwner).toBe(false);
    // A clear reject is not overridden by stickiness.
    expect(resolveOwner({ ...sticky, score: 0.2, durationSec: 2 }).isOwner).toBe(false);
  });

  it("a high score on a too-short turn doesn't verify on its own", () => {
    expect(resolveOwner(speech({ score: 0.9, durationSec: 0.8 })).isOwner).toBe(false);
  });
});

/** Embedding = the take's dominant pitch on a circle, so "voices" are tones and similarity is controllable. */
class ToneVerifier implements SpeakerVerifier {
  readonly engine = "test/tone";
  readonly defaults = { thresholds: { accept: 0.62, reject: 0.45 }, minScorableSec: 1.2 };
  async load() {}
  async embed({ pcm, sampleRate }: PcmTake) {
    let crossings = 0;
    for (let i = 1; i < pcm.length; i++) if (pcm[i - 1]! <= 0 && pcm[i]! > 0) crossings++;
    const freq = crossings / (pcm.length / sampleRate);
    const angle = (freq / 1000) * Math.PI;
    return normalize([Math.cos(angle), Math.sin(angle)]);
  }
}

describe("OwnerVoice enrollment", () => {
  const setup = () => {
    const path = join(mkdtempSync(join(tmpdir(), "imp-voice-")), "owner-voice.json");
    return { voice: new OwnerVoice(new ToneVerifier(), path, "Preston"), path };
  };

  const enrollAll = async (voice: OwnerVoice, freq = 200) => {
    const { enrollmentId, prompts } = await voice.startEnrollment();
    prompts.forEach((_, i) => expect(voice.addSample(enrollmentId, i, { pcm: tone(freq, 3.5), sampleRate: RATE }).ok).toBe(true));
    return { enrollmentId, ...(await voice.finishEnrollment(enrollmentId)) };
  };

  it("prompts include the owner's name and demo-distance takes", () => {
    const prompts = enrollmentPrompts("Preston");
    expect(prompts[0]!.text).toContain("Preston");
    expect(prompts.filter((p) => p.distance).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a bad take and won't finish without enough speech", async () => {
    const { voice } = setup();
    const { enrollmentId } = await voice.startEnrollment();
    expect(voice.addSample(enrollmentId, 0, { pcm: tone(200, 0.8), sampleRate: RATE })).toMatchObject({ ok: false, issues: ["too_short"] });
    await expect(voice.finishEnrollment(enrollmentId)).rejects.toThrow(/Need/);
  });

  it("builds an embedding-only profile, verifies the owner, and rejects someone else", async () => {
    const { voice, path } = setup();
    const r = await enrollAll(voice);
    expect(r.selfScore).toBeGreaterThan(0.99);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(
      ["calibration", "createdAt", "embedding", "engine", "minScorableSec", "speechSec", "takes", "thresholds"].sort(),
    );
    expect(voice.activeProfile()).not.toBeNull();
    expect((await voice.verifyTest({ pcm: tone(205, 2), sampleRate: RATE }, "self")).decision).toBe("accept");
    expect((await voice.verifyTest({ pcm: tone(1400, 2), sampleRate: RATE }, "impostor")).decision).toBe("reject");
    expect(voice.status().calibration?.impostorScore).not.toBeNull();
    const turn = await voice.scoreTurn(tone(200, 2), RATE);
    expect(turn!.score).toBeGreaterThan(0.99);
  });

  it("a teammate who'd have passed is reported, then the thresholds tighten past them and persist", async () => {
    const { voice, path } = setup();
    await enrollAll(voice);
    const r = await voice.verifyTest({ pcm: tone(600, 2), sampleRate: RATE }, "impostor"); // cos ≈ 0.72
    expect(r.decision).toBe("accept"); // against the defaults: this teammate would have got through
    expect(r.thresholds.reject).toBeGreaterThan(r.score);
    expect(r.warning).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).thresholds).toEqual(r.thresholds);
    // The owner still passes the tightened bar.
    expect((await voice.verifyTest({ pcm: tone(200, 2), sampleRate: RATE }, "self")).decision).toBe("accept");
  });

  it("warns when a teammate is indistinguishable", async () => {
    const { voice } = setup();
    await enrollAll(voice);
    const r = await voice.verifyTest({ pcm: tone(205, 2), sampleRate: RATE }, "impostor");
    expect(r.warning).toBe("not_separable");
  });

  it("delete removes the file and turns verification off", async () => {
    const { voice, path } = setup();
    await enrollAll(voice);
    voice.deleteProfile();
    expect(existsSync(path)).toBe(false);
    expect(voice.activeProfile()).toBeNull();
    expect(voice.status().enrolled).toBe(false);
    expect(await voice.scoreTurn(tone(200, 2), RATE)).toBeNull();
  });

  it("reloads the profile from disk on restart", async () => {
    const { voice, path } = setup();
    await enrollAll(voice);
    const again = new OwnerVoice(new ToneVerifier(), path, "Preston");
    expect(again.status().enrolled).toBe(true);
    expect(again.activeProfile()).toBeNull(); // until the model is loaded
    await again.prepare();
    expect(again.activeProfile()).not.toBeNull();
  });
});
