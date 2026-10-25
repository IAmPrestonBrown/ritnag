/** Minimal shape of a Deepgram live `Results` message that we rely on. */
export interface DgResults {
  type: "Results";
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel: { alternatives: { transcript: string; words?: DgWord[] }[] };
}

export interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

export interface AssembledTurn {
  speakerLabel: string;
  text: string;
  /** Stable across provider replays: connection + audio offset + speaker. */
  providerEventId: string;
  startSec: number;
  endSec: number;
}

const label = (speaker: number | undefined) => `spk${speaker ?? 0}`;

/** A run this long is a real speaker, not diarization flicker. */
const MIN_RUN_SEC = 0.8;
const MIN_RUN_WORDS = 3;
/** A pause this long before/after a short edge run suggests a genuine reply ("Yes."), not flicker. */
const HANDOFF_GAP_SEC = 0.3;

interface Run {
  speaker: number | undefined;
  words: DgWord[];
}

const runSec = (r: Run) => (r.words.at(-1)?.end ?? 0) - (r.words[0]?.start ?? 0);
const significant = (r: Run) => r.words.length >= MIN_RUN_WORDS || runSec(r) >= MIN_RUN_SEC;

/** Speaker with the most speech time across a run's words (absorbed flicker included). */
function majoritySpeaker(words: DgWord[]): number | undefined {
  const time = new Map<number | undefined, number>();
  for (const w of words) time.set(w.speaker, (time.get(w.speaker) ?? 0) + Math.max(w.end - w.start, 0.01));
  let best: number | undefined;
  let bestTime = -1;
  for (const [speaker, t] of time) if (t > bestTime) [best, bestTime] = [speaker, t];
  return best;
}

/**
 * Groups an utterance's words into speaker turns without letting single-word label flicker
 * fragment a sentence:
 * - a short run between two runs (A B A) is always flicker and is absorbed;
 * - a short run at the edge is absorbed unless a pause separates it (a real "Yes." reply);
 * - each resulting turn is attributed to the speaker with the most speech time.
 */
export function resolveRuns(words: DgWord[]): Run[] {
  let runs: Run[] = [];
  for (const w of words) {
    const last = runs.at(-1);
    if (last && last.speaker === w.speaker) last.words.push(w);
    else runs.push({ speaker: w.speaker, words: [w] });
  }

  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      if (significant(run)) continue;
      const prev = runs[i - 1];
      const next = runs[i + 1];
      const gapBefore = prev ? (run.words[0]!.start - prev.words.at(-1)!.end) : Infinity;
      const gapAfter = next ? (next.words[0]!.start - run.words.at(-1)!.end) : Infinity;
      const sandwiched = prev !== undefined && next !== undefined;
      let into: Run | undefined;
      if (sandwiched) into = gapBefore <= gapAfter ? prev : next;
      else if (prev && gapBefore < HANDOFF_GAP_SEC) into = prev;
      else if (next && gapAfter < HANDOFF_GAP_SEC) into = next;
      if (!into) continue;
      if (into === prev) prev.words.push(...run.words);
      else next!.words.unshift(...run.words);
      runs.splice(i, 1);
      changed = true;
      break;
    }
    // re-merge neighbours that now share a speaker
    const merged: Run[] = [];
    for (const r of runs) {
      const last = merged.at(-1);
      if (last && majoritySpeaker(last.words) === majoritySpeaker(r.words)) last.words.push(...r.words);
      else merged.push({ speaker: r.speaker, words: [...r.words] });
    }
    runs = merged;
  }
  return runs.map((r) => ({ speaker: majoritySpeaker(r.words), words: r.words }));
}

/**
 * Turns Deepgram's stream into complete per-speaker turns.
 * - Interim results are display-only (onPartial).
 * - Final segments accumulate until speech_final, UtteranceEnd, or a silence timeout.
 * - A segment with several speakers is split only on real handoffs; label flicker is absorbed (resolveRuns).
 * - Replayed final segments (same start/duration) are ignored.
 */
export class TurnAssembler {
  private words: DgWord[] = [];
  private seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connectionId: string,
    private readonly onTurn: (t: AssembledTurn) => void,
    private readonly onPartial: (speakerLabel: string, text: string) => void,
    private readonly silenceMs = 1200,
    /** Words to discard before assembly, e.g. the imp's own voice picked up by the mic. */
    private readonly dropWord: (w: DgWord) => boolean = () => false,
  ) {}

  handle(msg: { type?: string } & Partial<Omit<DgResults, "type">>) {
    if (msg.type === "UtteranceEnd") return this.flush();
    if (msg.type !== "Results" || !msg.channel) return;
    const alt = msg.channel.alternatives[0];
    if (!alt) return;

    if (!msg.is_final) {
      const text = alt.transcript.trim();
      if (text) this.onPartial(label(alt.words?.at(-1)?.speaker), text);
      return;
    }

    const key = `${msg.start?.toFixed(3)}:${msg.duration?.toFixed(3)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const kept = (alt.words ?? []).filter((w) => !this.dropWord(w));
    if (kept.length) this.words.push(...kept);
    if (msg.speech_final) this.flush();
    else this.armSilenceTimer();
  }

  private armSilenceTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.silenceMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const words = this.words;
    this.words = [];
    for (const run of resolveRuns(words)) {
      const first = run.words[0];
      const last = run.words.at(-1);
      if (!first || !last) continue;
      const text = run.words.map((w) => w.punctuated_word ?? w.word).join(" ").trim();
      if (!text) continue;
      this.onTurn({
        speakerLabel: label(run.speaker),
        text,
        providerEventId: `${this.connectionId}:${first.start.toFixed(3)}:${run.speaker ?? 0}`,
        startSec: first.start,
        endSec: last.end,
      });
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Stream-time spans (seconds) during which the imp was speaking or cooling down. */
export type Span = [start: number, end: number];

/**
 * True if most of a turn was spoken while the imp was talking: its own voice coming back through the
 * mic. Judged by when the audio happened, not when the transcript arrived (which can be a second later).
 */
export function mostlyDuringPlayback(spans: Span[], start: number, end: number, tailPadSec = 0.25): boolean {
  const dur = Math.max(end - start, 0.01);
  let covered = 0;
  for (const [a, b] of spans) covered += Math.max(0, Math.min(end, b + tailPadSec) - Math.max(start, a));
  return covered / dur > 0.5;
}

/** Records muted stream time, merging contiguous chunks and forgetting spans older than `keepSec`. */
export function addMutedTime(spans: Span[], start: number, end: number, keepSec = 120): Span[] {
  const last = spans.at(-1);
  if (last && start - last[1] < 0.05) last[1] = end;
  else spans.push([start, end]);
  const horizon = end - keepSec;
  while (spans.length && spans[0]![1] < horizon) spans.shift();
  return spans;
}
