import type { ServerEvent } from "../shared/events";

/**
 * End-of-question to first-audio timing, one log line per spoken reply.
 *
 *   speechEnd ──stt──> finalized ──decide──> decided ──tts──> ttsReady ──play──> playbackStarted
 *
 * "stt" includes Deepgram endpointing, the turn assembler's silence wait and owner voice scoring;
 * "decide" includes any wait behind an earlier turn (decisions run single-file) plus retrieval;
 * "play" is the browser fetching, decoding and starting the clip. All times are server wall-clock ms.
 */
export const LATENCY_TARGET_MS = 4000;
const MAX_TRACKED = 200;
const MAX_TEXT = 48;

export interface Marks {
  speechEnd?: number;
  finalized?: number;
  decided?: number;
  ttsReady?: number;
  playbackStarted?: number;
}

export interface LatencyBreakdown {
  sttMs: number | null;
  decideMs: number | null;
  ttsMs: number | null;
  playMs: number | null;
  totalMs: number | null;
  withinTarget: boolean | null;
}

/**
 * Wall-clock time of a point in the audio stream. Deepgram word times count samples received, and
 * audio arrives in real time, so a word that ended `lag` seconds of audio ago ended about `lag` s ago.
 */
export function streamTimeToWall(streamSec: number, streamNowSec: number, nowMs: number): number {
  return nowMs - Math.max(0, streamNowSec - streamSec) * 1000;
}

const span = (from?: number, to?: number) => (from === undefined || to === undefined ? null : Math.max(0, to - from));

export function breakdown(m: Marks): LatencyBreakdown {
  const totalMs = span(m.speechEnd, m.playbackStarted);
  return {
    sttMs: span(m.speechEnd, m.finalized),
    decideMs: span(m.finalized, m.decided),
    ttsMs: span(m.decided, m.ttsReady),
    playMs: span(m.ttsReady ?? m.decided, m.playbackStarted),
    totalMs,
    withinTarget: totalMs === null ? null : totalMs < LATENCY_TARGET_MS,
  };
}

const secs = (ms: number | null) => (ms === null ? "?" : `${(ms / 1000).toFixed(1)}s`);

export function formatLatency(text: string, source: string, b: LatencyBreakdown): string {
  const quote = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  const verdict = b.withinTarget === null ? "" : b.withinTarget ? " OK" : " SLOW";
  return (
    `[latency] ${source} "${quote}" stt ${secs(b.sttMs)} · decide ${secs(b.decideMs)} · tts ${secs(b.ttsMs)} · ` +
    `play ${secs(b.playMs)} = ${secs(b.totalMs)}${verdict} (<${LATENCY_TARGET_MS / 1000}s)`
  );
}

interface TrackedTurn {
  text: string;
  source: string;
  marks: Marks;
}

/** Collects marks from pipeline events. Bounded, so turns that never speak don't accumulate. */
export class LatencyTrace {
  private turns = new Map<string, TrackedTurn>();
  private responseTurn = new Map<string, string>();
  // TTS can finish before its decision is linked; hold the mark until it is
  private earlyTts = new Map<string, number>();

  constructor(private readonly maxTracked = MAX_TRACKED) {}

  /** Picks the turn and decision marks out of the session's event stream. */
  observe(e: ServerEvent, at: number) {
    if (e.type === "transcript.final") {
      const u = e.utterance;
      this.turn(u.id, { text: u.text, source: u.source, speechEnd: u.endedAt, finalized: at });
    } else if (e.type === "decision.completed" && e.decision.responseId) {
      this.decided(e.decision.turnId, e.decision.responseId, at);
    }
  }

  turn(turnId: string, t: { text: string; source: string; speechEnd: number; finalized: number }) {
    remember(this.turns, turnId, { text: t.text, source: t.source, marks: { speechEnd: t.speechEnd, finalized: t.finalized } }, this.maxTracked);
  }

  decided(turnId: string, responseId: string, at: number) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.marks.decided = at;
    const tts = this.earlyTts.get(responseId);
    if (tts !== undefined) turn.marks.ttsReady = tts;
    this.earlyTts.delete(responseId);
    remember(this.responseTurn, responseId, turnId, this.maxTracked);
  }

  ttsReady(responseId: string, at: number) {
    const turn = this.turnFor(responseId);
    if (turn) turn.marks.ttsReady = at;
    else remember(this.earlyTts, responseId, at, this.maxTracked);
  }

  /** The finished log line, or null if this reply wasn't traced (or was already reported). */
  playbackStarted(responseId: string, at: number): string | null {
    const turnId = this.responseTurn.get(responseId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    this.responseTurn.delete(responseId);
    if (!turnId || !turn) return null;
    this.turns.delete(turnId);
    return formatLatency(turn.text, turn.source, breakdown({ ...turn.marks, playbackStarted: at }));
  }

  private turnFor(responseId: string) {
    const turnId = this.responseTurn.get(responseId);
    return turnId ? this.turns.get(turnId) : undefined;
  }
}

/** Map insert that drops the oldest entry once full (Maps iterate in insertion order). */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}
