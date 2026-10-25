import type { OwnerBasis } from "../../shared/schemas";
import type { VoiceThresholds } from "../../shared/events";

export interface OwnerResolution {
  isOwner: boolean;
  /** Only certain owner turns may teach facts or change people. */
  ownerCertain: boolean;
  basis: OwnerBasis;
  score: number | null;
}

export interface ActiveVoiceProfile {
  thresholds: VoiceThresholds;
  minScorableSec: number;
}

export interface ResolveInput {
  source: "typed" | "speech";
  asOwner: boolean;
  /** Loaded owner profile; null means no enrollment (or the model isn't ready). */
  profile: ActiveVoiceProfile | null;
  score: number | null;
  durationSec: number | null;
  speakerLabel: string;
  /** Calibrated diarization label; only consulted when there's no profile. */
  calibratedOwnerLabel: string | null;
  /** Labels of voice-verified owner turns on this connection, oldest first. */
  verifiedOwnerLabels: string[];
}

/**
 * Who is speaking, per docs/SPEAKER_ID.md §3. Voice verification is the only automatic owner signal;
 * diarization labels only carry it across short turns, and never with certainty.
 */
export function resolveOwner(i: ResolveInput): OwnerResolution {
  if (i.source === "typed") return { isOwner: i.asOwner, ownerCertain: i.asOwner, basis: "typed", score: null };

  if (!i.profile) {
    // Fallback without enrollment: calibration + manual mapping, as before.
    const isOwner = i.calibratedOwnerLabel !== null && i.speakerLabel === i.calibratedOwnerLabel;
    return { isOwner, ownerCertain: isOwner, basis: isOwner ? "label" : "none", score: null };
  }

  const { accept, reject } = i.profile.thresholds;
  const scorable = i.score !== null && (i.durationSec ?? 0) >= i.profile.minScorableSec;
  if (scorable && i.score! >= accept) return { isOwner: true, ownerCertain: true, basis: "voice", score: i.score };
  if (scorable && i.score! <= reject) return { isOwner: false, ownerCertain: false, basis: "voice", score: i.score };

  // Between thresholds, or too short to score: lean on the last two verified owner turns.
  const last = i.verifiedOwnerLabels.slice(-2);
  if (last.length === 2 && last.every((l) => l === i.speakerLabel)) {
    return { isOwner: true, ownerCertain: false, basis: "stickiness", score: i.score };
  }
  return { isOwner: false, ownerCertain: false, basis: "none", score: i.score };
}
