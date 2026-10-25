import type { VoiceThresholds } from "../../shared/events";

export interface PcmTake {
  pcm: Float32Array;
  sampleRate: number;
}

export interface SpeakerVerifier {
  /** Profiles aren't portable across engines; a profile from another engine counts as not enrolled. */
  readonly engine: string;
  readonly defaults: { thresholds: VoiceThresholds; minScorableSec: number };
  /** Loads the model. Safe to call repeatedly. */
  load(): Promise<void>;
  /** Unit-length speaker embedding for one stretch of mono audio. */
  embed(take: PcmTake): Promise<number[]>;
}

export interface OwnerProfile {
  engine: string;
  /** Mean of the enrollment takes' unit embeddings, renormalized. */
  embedding: number[];
  thresholds: VoiceThresholds;
  /** Turns shorter than this are "too short to score". */
  minScorableSec: number;
  createdAt: number;
  takes: number;
  speechSec: number;
  calibration: {
    /** Leave-one-out score of the enrollment takes (optimistic). */
    enrollSelfScore: number;
    /** Owner saying a fresh phrase after enrollment. */
    selfScore: number | null;
    /** A teammate saying the same phrase. */
    impostorScore: number | null;
  };
}

export const normalize = (v: ArrayLike<number>): number[] => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const k = n > 0 ? 1 / Math.sqrt(n) : 0;
  return Array.from(v, (x) => x * k);
};

export const cosine = (a: number[], b: number[]) => {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    x += a[i]! * a[i]!;
    y += b[i]! * b[i]!;
  }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

export const meanEmbedding = (embeddings: number[][]): number[] => {
  const dim = embeddings[0]?.length ?? 0;
  const sum = new Array<number>(dim).fill(0);
  for (const e of embeddings) for (let i = 0; i < dim; i++) sum[i]! += e[i]!;
  return normalize(sum);
};

/** Average score of each take against a profile built from the other takes. */
export function leaveOneOutScore(embeddings: number[][]): number {
  if (embeddings.length < 2) return 1;
  let total = 0;
  for (let i = 0; i < embeddings.length; i++) {
    total += cosine(meanEmbedding(embeddings.filter((_, j) => j !== i)), embeddings[i]!);
  }
  return total / embeddings.length;
}

export type CalibrationWarning = "self_below_accept" | "not_separable" | null;

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Thresholds only ever tighten from the engine defaults. An impostor score pushes reject above it and
 * keeps accept well clear of it. The owner's own score never loosens anything; if it falls below
 * accept, the fix is re-enrolling closer to demo conditions, so we report it instead.
 */
export function calibrateThresholds(
  defaults: VoiceThresholds,
  evidence: { selfScore: number | null; impostorScore: number | null },
): { thresholds: VoiceThresholds; warning: CalibrationWarning } {
  let { accept, reject } = defaults;
  const { selfScore, impostorScore } = evidence;
  if (impostorScore !== null) {
    reject = Math.max(reject, impostorScore + 0.05);
    accept = Math.max(accept, impostorScore + 0.15);
  }
  accept = Math.min(0.95, Math.max(accept, reject + 0.08));
  reject = Math.min(reject, accept - 0.08);
  let warning: CalibrationWarning = null;
  if (impostorScore !== null && impostorScore >= reject) warning = "not_separable"; // capped: can't clear them
  else if (selfScore !== null && impostorScore !== null && selfScore - impostorScore < 0.1) warning = "not_separable";
  else if (selfScore !== null && selfScore < accept) warning = "self_below_accept";
  return { thresholds: { accept: round(accept), reject: round(reject) }, warning };
}

export type ScoreDecision = "accept" | "reject" | "uncertain";

export const decide = (score: number, t: VoiceThresholds): ScoreDecision =>
  score >= t.accept ? "accept" : score <= t.reject ? "reject" : "uncertain";
