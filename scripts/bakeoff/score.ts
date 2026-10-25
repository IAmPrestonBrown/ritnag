/** Pure bake-off logic: segmenting, matching predictions to ground truth, certainty sweeps. */

export interface TimedWord {
  start: number;
  end: number;
  speaker: string;
  content: string;
}

export interface Segment {
  clip: string;
  i: number;
  start: number;
  end: number;
  text: string;
  /** Speechmatics' own diarization label for the segment, as a labeling hint. */
  smLabel: string;
  /** Ground truth: a person's name, "other" (an unenrolled voice), or "skip" (overlap/noise). Filled by a human. */
  truth: string | null;
}

/** Group words into turns: a new segment on a speaker change or a pause longer than `gapSec`. */
export function segmentWords(clip: string, words: TimedWord[], gapSec = 0.8): Segment[] {
  const out: Segment[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    const first = cur[0];
    const last = cur.at(-1);
    if (first && last) {
      out.push({
        clip,
        i: out.length,
        start: first.start,
        end: last.end,
        text: cur.map((w) => w.content).join(" ").replace(/\s+([.,!?])/g, "$1"),
        smLabel: majority(cur.map((w) => [w.speaker, w.end - w.start] as const)) ?? "UU",
        truth: null,
      });
    }
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (prev.speaker !== w.speaker || w.start - prev.end > gapSec)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

/** Label with the most total weight (e.g. speech time). */
export function majority(items: readonly (readonly [string, number])[]): string | null {
  const t = new Map<string, number>();
  for (const [k, v] of items) t.set(k, (t.get(k) ?? 0) + Math.max(v, 0.01));
  let best: string | null = null;
  let bestV = -1;
  for (const [k, v] of t) if (v > bestV) [best, bestV] = [k, v];
  return best;
}

/** The speaker label covering most of [start, end] among the given words. */
export function labelForSpan(words: TimedWord[], start: number, end: number): string | null {
  const overlaps = words
    .map((w) => [w.speaker, Math.min(end, w.end) - Math.max(start, w.start)] as const)
    .filter(([, o]) => o > 0);
  return overlaps.length ? majority(overlaps) : null;
}

export type Outcome = "correct" | "wrong" | "generic";

/**
 * Score one prediction. `predicted` null = the system declined to name anyone (generic answer).
 * Truth "other" (a voice nobody enrolled) is correct only if the system stays generic.
 */
export function outcome(truth: string, predicted: string | null): Outcome {
  if (predicted === null) return truth === "other" ? "correct" : "generic";
  return predicted === truth ? "correct" : "wrong";
}

export interface Tally {
  n: number;
  correct: number;
  wrong: number;
  generic: number;
  /** Turns by someone else that were attributed to the owner: the dangerous error. */
  ownerFalseAccepts: number;
  /** Owner turns correctly attributed to the owner. */
  ownerHits: number;
  ownerTurns: number;
}

export function tally(rows: { truth: string; predicted: string | null }[], owner: string): Tally {
  const t: Tally = { n: 0, correct: 0, wrong: 0, generic: 0, ownerFalseAccepts: 0, ownerHits: 0, ownerTurns: 0 };
  for (const r of rows) {
    t.n++;
    t[outcome(r.truth, r.predicted)]++;
    if (r.truth === owner) {
      t.ownerTurns++;
      if (r.predicted === owner) t.ownerHits++;
    } else if (r.predicted === owner) t.ownerFalseAccepts++;
  }
  return t;
}

export interface Scored {
  truth: string;
  /** Similarity to each enrolled person, e.g. { Preston: 0.81, Leon: 0.64 }. */
  scores: Record<string, number>;
}

/**
 * Certainty gate over embedding scores: name the best match only if its score clears `minScore`
 * and beats the runner-up by at least `minMargin`; otherwise answer generically.
 */
export function gatedPrediction(scores: Record<string, number>, minScore: number, minMargin: number): string | null {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best) return null;
  const margin = best[1] - (second?.[1] ?? 0);
  return best[1] >= minScore && margin >= minMargin ? best[0] : null;
}

export const pct = (x: number, n: number) => (n ? `${Math.round((100 * x) / n)}%` : "—");
