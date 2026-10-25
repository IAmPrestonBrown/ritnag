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

/**
 * Turns Deepgram's stream into complete per-speaker turns.
 * - Interim results are display-only (onPartial).
 * - Final segments accumulate until speech_final, UtteranceEnd, or a silence timeout.
 * - A segment containing several speakers is split by speaker run, not assigned to its first word.
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

    if (alt.words?.length) this.words.push(...alt.words);
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
    let run: DgWord[] = [];
    const emit = () => {
      const first = run[0];
      const last = run.at(-1);
      if (!first || !last) return;
      const text = run.map((w) => w.punctuated_word ?? w.word).join(" ").trim();
      if (text) {
        this.onTurn({
          speakerLabel: label(first.speaker),
          text,
          providerEventId: `${this.connectionId}:${first.start.toFixed(3)}:${first.speaker ?? 0}`,
          startSec: first.start,
          endSec: last.end,
        });
      }
      run = [];
    };
    for (const w of words) {
      if (run.length && run[0]!.speaker !== w.speaker) emit();
      run.push(w);
    }
    emit();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
  }
}
