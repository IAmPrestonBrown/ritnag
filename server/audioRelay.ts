import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { openDeepgram } from "./providers/deepgram";
import { TurnAssembler, type AssembledTurn } from "./turnAssembler";
import { PcmRing } from "./voice/pcm";
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
        this.turns = this.turns.then(() => this.deliver(turn)).catch((err) => console.error("[imp] turn delivery failed", err));
      },
      (speakerLabel, text) => {
        if (session.isMuted()) return; // don't show the imp transcribing itself
        emit({ type: "transcript.partial", speakerLabel, text, generation: session.generation });
      },
      Number(process.env.TURN_SILENCE_MS || 1200),
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
    this.ring.appendBytes(chunk);
    if (this.dg.readyState === this.dg.OPEN) this.dg.send(chunk);
    else this.pending.push(chunk);
  }

  /** Score the turn's own audio (when there's a profile and it's long enough), then hand it to the session. */
  private async deliver(turn: AssembledTurn) {
    const durationSec = turn.endSec - turn.startSec;
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
