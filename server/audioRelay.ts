import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { openDeepgram } from "./providers/deepgram";
import { TurnAssembler, addMutedTime, mostlyDuringPlayback, type AssembledTurn, type Span } from "./turnAssembler";
import { PcmRing } from "./voice/pcm";
import { streamTimeToWall } from "./latency";
import type { Session } from "./session";
import type { ServerEvent } from "../shared/events";

const KEEPALIVE_MS = 4000;
const RING_SECONDS = 60;
const SLICE_PAD_SEC = 0.15;

/** Scores one turn's audio against the owner profile (OwnerVoice in production). */
export interface TurnScorer {
  scoreTurn(pcm: Float32Array, sampleRate: number): Promise<{ score: number; ms: number } | null>;
  activeProfile(): { minScorableSec: number } | null;
}

/**
 * One live microphone stream: browser PCM16 -> Deepgram -> turn assembler -> owner voice score -> session.
 * The last minute of audio stays in a ring buffer so each assembled turn can be sliced out and verified.
 * A new relay means a new connectionId, which clears speaker bindings (labels don't carry over).
 */
export class AudioRelay {
  readonly connectionId = randomUUID();
  private dg: WebSocket;
  private pending: Buffer[] = [];
  private assembler: TurnAssembler;
  private ring: PcmRing;
  // turns reach the session in order even though scoring is async
  private turns: Promise<void> = Promise.resolve();
  private keepAlive: NodeJS.Timeout;
  private lastAudioAt = Date.now();
  // stream-time spans when the imp was speaking (or cooling down); turns spoken then are its own echo
  private mutedSpans: Span[] = [];
  private droppedEcho: string[] = [];
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly emit: (e: ServerEvent) => void,
    private readonly onEnded: (relay: AudioRelay) => void,
    private readonly sampleRate: number,
    private readonly voice: TurnScorer,
  ) {
    this.ring = new PcmRing(sampleRate, RING_SECONDS);
    session.setSpeechConnection(this.connectionId);
    this.assembler = new TurnAssembler(
      this.connectionId,
      (turn) => {
        // Read the stream clock now, before async scoring, so wall-clock speech times stay accurate.
        const now = Date.now();
        const streamNow = this.ring.durationSec;
        const times = { startedAt: streamTimeToWall(turn.startSec, streamNow, now), endedAt: streamTimeToWall(turn.endSec, streamNow, now) };
        this.turns = this.turns.then(() => this.deliver(turn, times)).catch((err) => console.error("[imp] turn delivery failed", err));
      },
      (speakerLabel, text) => {
        if (session.isMuted()) return; // don't show the imp transcribing itself
        emit({ type: "transcript.partial", speakerLabel, text, generation: session.generation });
      },
      Number(process.env.TURN_SILENCE_MS || 1200),
      // Echo filter per word, by when it was captured: Deepgram can glue the tail of the imp's reply
      // onto the start of a visitor's next question in one utterance, so whole-turn checks fail.
      (w) => {
        const echo = mostlyDuringPlayback(this.mutedSpans, w.start, w.end);
        if (echo) this.droppedEcho.push(w.punctuated_word ?? w.word);
        return echo;
      },
    );

    this.dg = openDeepgram(sampleRate);
    this.dg.on("open", () => {
      for (const chunk of this.pending) this.dg.send(chunk);
      this.pending = [];
      console.log(`[imp] deepgram connected (${this.connectionId.slice(0, 8)})`);
    });
    this.dg.on("message", (data) => {
      try {
        this.assembler.handle(JSON.parse(data.toString()));
      } catch (err) {
        console.error("[imp] bad deepgram message", err);
      }
    });
    this.dg.on("unexpected-response", (_req, res) => {
      this.fail(`Deepgram rejected the connection (HTTP ${res.statusCode}). Check DEEPGRAM_API_KEY.`);
    });
    this.dg.on("error", (err) => this.fail(`Deepgram error: ${err.message}`));
    this.dg.on("close", (code) => {
      if (!this.closed) this.fail(`Transcription disconnected (code ${code}). Start listening again; speakers need re-confirming.`);
    });

    // Deepgram closes idle streams; the worklet normally keeps data flowing, this covers gaps.
    this.keepAlive = setInterval(() => {
      if (this.dg.readyState === this.dg.OPEN && Date.now() - this.lastAudioAt > KEEPALIVE_MS) {
        this.dg.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_MS);
  }

  /**
   * Forward audio in order and keep a copy. Deepgram's word times count samples it received, so
   * nothing may be dropped or the ring buffer and the transcript drift apart.
   */
  audio(chunk: Buffer) {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    const at = this.ring.durationSec;
    this.ring.appendBytes(chunk);
    // Only real playback time: the post-playback cooldown is for late-arriving transcripts, and
    // counting it here would swallow someone who starts talking the moment the imp stops.
    if (this.session.isSpeaking()) addMutedTime(this.mutedSpans, at, this.ring.durationSec);
    if (this.dg.readyState === this.dg.OPEN) this.dg.send(chunk);
    else this.pending.push(chunk);
  }

  /** Score the turn's own audio (when there's a profile and it's long enough), then hand it to the session. */
  private async deliver(turn: AssembledTurn, times: { startedAt: number; endedAt: number }) {
    const durationSec = turn.endSec - turn.startSec;
    // Deepgram finalizes a second or so after the words, so a "muted?" check on arrival misses the
    // tail of the imp's own reply. Judge by when the audio was actually captured instead.
    if (this.droppedEcho.length) {
      console.log(`[imp] filtered own speech from the mic: "${this.droppedEcho.join(" ").slice(0, 80)}"`);
      this.droppedEcho = [];
    }
    let ownerScore: number | null = null;
    const profile = this.voice.activeProfile();
    if (profile && durationSec >= profile.minScorableSec && !this.session.isMuted()) {
      const pcm = this.ring.slice(turn.startSec - SLICE_PAD_SEC, turn.endSec + SLICE_PAD_SEC);
      const r = pcm ? await this.voice.scoreTurn(pcm, this.sampleRate) : null;
      if (r) {
        ownerScore = r.score;
        console.log(`[imp] voice ${r.score.toFixed(3)} in ${r.ms}ms (${turn.speakerLabel}, ${durationSec.toFixed(1)}s)`);
      }
    }
    await this.session.ingest({
      text: turn.text,
      speakerLabel: turn.speakerLabel,
      connectionId: this.connectionId,
      providerEventId: turn.providerEventId,
      source: "speech",
      ...times,
      ownerScore,
      durationSec,
    });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    if (this.dg.readyState === this.dg.OPEN) this.dg.send(JSON.stringify({ type: "CloseStream" }));
    this.onEnded(this);
    // Give Deepgram a moment to return final results and flush them while the owner label still
    // applies; only then end the connection (unless a newer relay already replaced it).
    setTimeout(() => {
      this.assembler.flush();
      this.assembler.dispose();
      this.dg.close();
      if (this.session.speechConnectionId === this.connectionId) this.session.setSpeechConnection(null);
    }, 800).unref();
  }

  private fail(message: string) {
    if (this.closed) return;
    console.error(`[imp] ${message}`);
    this.emit({ type: "error", message, recoverable: true });
    this.stop();
  }
}
