import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { openDeepgram } from "./providers/deepgram";
import { TurnAssembler } from "./turnAssembler";
import type { Session } from "./session";
import type { ServerEvent } from "../shared/events";

const KEEPALIVE_MS = 4000;

/**
 * One live microphone stream: browser WebM/Opus chunks -> Deepgram -> turn assembler -> session.
 * A new relay means a new connectionId, which clears speaker bindings (labels don't carry over).
 */
export class AudioRelay {
  readonly connectionId = randomUUID();
  private dg: WebSocket;
  private pending: Buffer[] = [];
  private assembler: TurnAssembler;
  private keepAlive: NodeJS.Timeout;
  private lastAudioAt = Date.now();
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly emit: (e: ServerEvent) => void,
    private readonly onEnded: (relay: AudioRelay) => void,
  ) {
    session.setSpeechConnection(this.connectionId);
    this.assembler = new TurnAssembler(
      this.connectionId,
      (turn) => {
        void session.ingest({
          text: turn.text,
          speakerLabel: turn.speakerLabel,
          connectionId: this.connectionId,
          providerEventId: turn.providerEventId,
          source: "speech",
        });
      },
      (speakerLabel, text) => {
        if (session.isMuted()) return; // don't show the imp transcribing itself
        emit({ type: "transcript.partial", speakerLabel, text, generation: session.generation });
      },
      Number(process.env.TURN_SILENCE_MS || 1200),
    );

    this.dg = openDeepgram();
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

    // Deepgram closes idle streams; MediaRecorder normally keeps data flowing, this covers gaps.
    this.keepAlive = setInterval(() => {
      if (this.dg.readyState === this.dg.OPEN && Date.now() - this.lastAudioAt > KEEPALIVE_MS) {
        this.dg.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_MS);
  }

  /** Forward audio in order. The first chunk carries the WebM header, so nothing may be dropped. */
  audio(chunk: Buffer) {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    if (this.dg.readyState === this.dg.OPEN) this.dg.send(chunk);
    else this.pending.push(chunk);
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
