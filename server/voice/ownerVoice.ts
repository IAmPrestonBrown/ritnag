import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { VoiceStatus } from "../../shared/events";
import { analyzeTake, type TakeAnalysis } from "./pcm";
import type { ActiveVoiceProfile } from "./resolver";
import {
  calibrateThresholds,
  cosine,
  decide,
  leaveOneOutScore,
  meanEmbedding,
  type CalibrationWarning,
  type OwnerProfile,
  type PcmTake,
  type ScoreDecision,
  type SpeakerVerifier,
} from "./verifier";

/** Six normal prompts plus two read from demo distance and posture (§4). */
export const enrollmentPrompts = (ownerName: string) => [
  { text: `Hey imp, it's ${ownerName}. I'm going to be heads-down for a while.`, distance: false },
  { text: "Did anyone push the frontend changes before the meeting this afternoon?", distance: false },
  { text: "The deploy is approved for Thursday, but only after all the tests pass.", distance: false },
  { text: "Tell Maya the slides are in the shared folder, under the demo directory.", distance: false },
  { text: "Can you remind me what time the judges are coming around tonight?", distance: false },
  { text: "My favorite part of this project is the tiny red imp with the attitude.", distance: false },
  { text: "Okay imp, I'm leaning back now. Can you still hear me clearly?", distance: true },
  { text: "If Bob asks about the wifi again, tell him it's written on the whiteboard.", distance: true },
];

const MIN_NORMAL_TAKES = 5;
const MIN_DISTANCE_TAKES = 1;
const MIN_TOTAL_SPEECH_SEC = 20;
const ENROLLMENT_TTL_MS = 30 * 60 * 1000;

interface Enrollment {
  id: string;
  startedAt: number;
  takes: Map<number, PcmTake & { analysis: TakeAnalysis; distance: boolean }>;
}

export interface SampleResult extends TakeAnalysis {
  ok: boolean;
  prompt: number;
}

export interface VerifyResult {
  score: number;
  decision: ScoreDecision | "too_short";
  thresholds: OwnerProfile["thresholds"];
  warning: CalibrationWarning;
  durationSec: number;
}

/**
 * The owner's local voice profile (data/owner-voice.json, embedding only, no audio), enrollment, and
 * per-turn scoring. One owner, one profile. Deleting it turns verification off.
 */
export class OwnerVoice {
  private profile: OwnerProfile | null = null;
  private model: VoiceStatus["model"] = "idle";
  private error: string | null = null;
  private enrollment: Enrollment | null = null;

  constructor(
    private readonly verifier: SpeakerVerifier,
    private readonly profilePath: string | null,
    private readonly ownerName: string,
    private readonly onChange: () => void = () => {},
  ) {
    if (profilePath && existsSync(profilePath)) {
      try {
        const p = JSON.parse(readFileSync(profilePath, "utf8")) as OwnerProfile;
        if (p.engine === verifier.engine) this.profile = p;
        else this.error = `Voice profile was made with ${p.engine}; re-enroll for ${verifier.engine}.`;
      } catch {
        this.error = "Voice profile file is unreadable; re-enroll.";
      }
    }
  }

  /** Loads the model in the background when a profile exists, so the first turn isn't slow. */
  init() {
    if (this.profile) void this.prepare().catch(() => {});
  }

  async prepare() {
    if (this.model === "ready") return;
    this.setModel("loading", null);
    try {
      await this.verifier.load();
      this.setModel("ready", null);
    } catch (err) {
      this.setModel("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private setModel(model: VoiceStatus["model"], error: string | null) {
    this.model = model;
    this.error = error;
    this.onChange();
  }

  /** The profile the resolver may use: enrolled and the model is loaded. */
  activeProfile(): ActiveVoiceProfile | null {
    if (!this.profile || this.model !== "ready") return null;
    return { thresholds: this.profile.thresholds, minScorableSec: this.profile.minScorableSec };
  }

  status(): VoiceStatus {
    const p = this.profile;
    return {
      enrolled: p !== null,
      active: this.activeProfile() !== null,
      model: this.model,
      error: this.error,
      engine: this.verifier.engine,
      createdAt: p?.createdAt ?? null,
      thresholds: p?.thresholds ?? null,
      minScorableSec: p?.minScorableSec ?? null,
      calibration: p?.calibration ?? null,
      enrolling: this.liveEnrollment() !== null,
    };
  }

  /** Similarity of one turn's audio to the owner, or null when there's nothing to score against. */
  async scoreTurn(pcm: Float32Array, sampleRate: number): Promise<{ score: number; ms: number } | null> {
    const p = this.profile;
    if (!p || this.model !== "ready") return null;
    const t0 = performance.now();
    try {
      const e = await this.verifier.embed({ pcm, sampleRate });
      return { score: cosine(p.embedding, e), ms: Math.round(performance.now() - t0) };
    } catch (err) {
      console.error("[imp] voice scoring failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ---------- enrollment ----------

  private liveEnrollment() {
    if (this.enrollment && Date.now() - this.enrollment.startedAt > ENROLLMENT_TTL_MS) this.enrollment = null;
    return this.enrollment;
  }

  async startEnrollment() {
    await this.prepare(); // surface a model download/load failure before the owner reads anything
    this.enrollment = { id: randomUUID(), startedAt: Date.now(), takes: new Map() };
    this.onChange();
    return { enrollmentId: this.enrollment.id, prompts: enrollmentPrompts(this.ownerName) };
  }

  private enrollmentFor(id: string) {
    const e = this.liveEnrollment();
    if (!e || e.id !== id) throw new VoiceError(409, "Enrollment expired or replaced. Start again.");
    return e;
  }

  /** Quality-checks one take. Rejected takes aren't kept; a retake of the same prompt replaces it. */
  addSample(enrollmentId: string, prompt: number, take: PcmTake): SampleResult {
    const e = this.enrollmentFor(enrollmentId);
    const prompts = enrollmentPrompts(this.ownerName);
    if (prompt >= prompts.length) throw new VoiceError(400, "No such prompt.");
    const analysis = analyzeTake(take.pcm, take.sampleRate);
    const ok = !analysis.issues.some((i) => i !== "noisy");
    if (ok) e.takes.set(prompt, { ...take, analysis, distance: prompts[prompt]!.distance });
    else e.takes.delete(prompt);
    return { ok, prompt, ...analysis };
  }

  async finishEnrollment(enrollmentId: string) {
    const e = this.enrollmentFor(enrollmentId);
    const takes = [...e.takes.values()];
    const normal = takes.filter((t) => !t.distance).length;
    const distance = takes.length - normal;
    const speechSec = takes.reduce((s, t) => s + t.analysis.speechSec, 0);
    if (normal < MIN_NORMAL_TAKES || distance < MIN_DISTANCE_TAKES || speechSec < MIN_TOTAL_SPEECH_SEC) {
      throw new VoiceError(
        400,
        `Need ${MIN_NORMAL_TAKES} prompts, ${MIN_DISTANCE_TAKES} from demo distance, and ${MIN_TOTAL_SPEECH_SEC}s of speech ` +
          `(have ${normal}, ${distance}, ${speechSec.toFixed(1)}s).`,
      );
    }
    await this.prepare();
    const embeddings = await Promise.all(takes.map((t) => this.verifier.embed(t)));
    const { defaults } = this.verifier;
    const profile: OwnerProfile = {
      engine: this.verifier.engine,
      embedding: meanEmbedding(embeddings),
      thresholds: { ...defaults.thresholds },
      minScorableSec: defaults.minScorableSec,
      createdAt: Date.now(),
      takes: takes.length,
      speechSec: Math.round(speechSec * 10) / 10,
      calibration: { enrollSelfScore: leaveOneOutScore(embeddings), selfScore: null, impostorScore: null },
    };
    this.profile = profile;
    this.enrollment = null; // audio is dropped here; only the embedding is kept
    this.save();
    this.onChange();
    return { thresholds: profile.thresholds, selfScore: profile.calibration.enrollSelfScore };
  }

  /**
   * Scores a fresh phrase against the profile. "self" and "impostor" results are stored as calibration
   * evidence and re-derive the thresholds; "check" only reports. The decision uses the thresholds as
   * they were before this test, so an impostor check shows whether the teammate would have got through.
   */
  async verifyTest(take: PcmTake, purpose: "self" | "impostor" | "check"): Promise<VerifyResult> {
    const p = this.profile;
    if (!p) throw new VoiceError(409, "No voice profile enrolled.");
    await this.prepare();
    const durationSec = take.pcm.length / take.sampleRate;
    const score = cosine(p.embedding, await this.verifier.embed(take));
    const decision = durationSec < p.minScorableSec ? "too_short" : decide(score, p.thresholds);
    let warning: CalibrationWarning = null;
    if (purpose !== "check") {
      p.calibration = { ...p.calibration, [purpose === "self" ? "selfScore" : "impostorScore"]: score };
      const calibrated = calibrateThresholds(this.verifier.defaults.thresholds, p.calibration);
      p.thresholds = calibrated.thresholds;
      warning = calibrated.warning;
      this.save();
      this.onChange();
    }
    return { score, decision, thresholds: p.thresholds, warning, durationSec };
  }

  deleteProfile() {
    this.profile = null;
    this.enrollment = null;
    if (this.profilePath) rmSync(this.profilePath, { force: true });
    this.error = null;
    this.onChange();
  }

  private save() {
    if (!this.profilePath || !this.profile) return;
    const tmp = `${this.profilePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.profile), { mode: 0o600 });
    renameSync(tmp, this.profilePath);
  }
}

export class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
