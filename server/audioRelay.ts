import { randomUUID } from "node:crypto";
import { openStt, sttProvider, type SpeakerEnrollment, type SttStream } from "./providers/stt";
import { TurnAssembler, addMutedTime, mostlyDuringPlayback, type AssembledTurn, type Span } from "./turnAssembler";
import { PcmRing } from "./voice/pcm";
import { streamTimeToWall } from "./latency";
import type { Session } from "./session";
import type { ServerEvent } from "../shared/events";

const RING_SECONDS = 60;
// a flaky network can take several tries (backoff 1, 2, 4, 8, 8… s: about 45 s in all)
const MAX_RECONNECTS = 8;
const SLICE_PAD_SEC = 0.15;

/** Scores one turn's audio against the owner profile (OwnerVoice in production). */
export interface TurnScorer {
  scoreTurn(pcm: Float32Array, sampleRate: number): Promise<{ score: number; ms: number } | null>;
  activeProfile(): { minScorableSec: number } | null;
  /** Enrolled voiceprints for a provider that identifies speakers itself (Speechmatics); empty if none. */
  providerEnrollment(): SpeakerEnrollment[];
}

/** The label Speechmatics puts on words from the enrolled owner. */
export const OWNER_LABEL = "owner";
/** Enrolled visitors get the label `person_<personId>`: Speechmatics recognizing them binds them. */
export const PERSON_LABEL = "person_";
/** A turn the operator marked "Guest speaking" that the provider had filed under the owner's voice. */
export const MANUAL_GUEST_LABEL = "guest";
// audio kept per voice for learning its voiceprint (enough for a solid print, bounded memory)
const VOICE_CLIP_MAX_SEC = 30;

/**
 * One live microphone stream: browser PCM16 -> Deepgram -> turn assembler -> owner voice score -> session.
 * The last minute of audio stays in a ring buffer so each assembled turn can be sliced out and verified.
 * A new relay means a new connectionId, which clears speaker bindings (labels don't carry over).
 */
export class AudioRelay {
  readonly connectionId = randomUUID();
  private stt: SttStream;
  private readonly enrolled: SpeakerEnrollment[];
  private reconnects = 0;
  /** True when the provider was given the owner's voiceprint, so its "owner" label is an identification. */
  private readonly ownerEnrolled: boolean;
  private assembler: TurnAssembler;
  private ring: PcmRing;
  // turns reach the session in order even though scoring is async
  private turns: Promise<void> = Promise.resolve();
  // stream-time spans when the imp was speaking (or cooling down); turns spoken then are its own echo
  private mutedSpans: Span[] = [];
  private droppedEcho: string[] = [];
  private closed = false;
  // each visitor voice's recent turns, for learning a voiceprint when the owner names them
  private labelAudio = new Map<string, Float32Array[]>();
  // operator's "Owner speaking" / "Guest speaking" presses, in stream time (newest last, bounded)
  private assignments: { start: number; end: number | null; role: "owner" | "guest"; personId: string | null }[] = [];
  // a demo reset: turns that ended before this stream time belong to the previous run
  private discardBeforeSec = 0;

  constructor(
    private readonly session: Session,
    private readonly emit: (e: ServerEvent) => void,
    private readonly onEnded: (relay: AudioRelay) => void,
    private readonly sampleRate: number,
    private readonly voice: TurnScorer,
    /** Visitors' voiceprints (labels PERSON_LABEL + id), recognized alongside the owner. */
    visitors: SpeakerEnrollment[] = [],
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
        if (session.isPlaying()) return; // don't show the imp transcribing itself
        emit({ type: "transcript.partial", speakerLabel, text, generation: session.generation });
      },
      // Speechmatics ends turns itself (EndOfUtterance) and its finals can arrive >1 s apart, so a short
      // timer would cut sentences into fragments; the timer is only a fallback there.
      Number(process.env.TURN_SILENCE_MS || (sttProvider() === "speechmatics" ? 3000 : 1200)),
      // Echo filter per word, by when it was captured: Deepgram can glue the tail of the imp's reply
      // onto the start of a visitor's next question in one utterance, so whole-turn checks fail.
      (w) => {
        const echo = mostlyDuringPlayback(this.mutedSpans, w.start, w.end);
        if (echo) this.droppedEcho.push(w.punctuated_word ?? w.word);
        return echo;
      },
    );

    this.enrolled = [...voice.providerEnrollment(), ...visitors];
    this.stt = this.connect();
    this.ownerEnrolled = this.stt.name === "speechmatics" && this.enrolled.some((e) => e.label === OWNER_LABEL);
  }

  /**
   * Opens the transcription stream. Word times from a new provider session start at 0, so they're
   * shifted by where that session began in our stream: the ring buffer and echo spans keep one clock.
   */
  private connect(): SttStream {
    const offset = this.ring.durationSec;
    const reconnecting = this.stt !== undefined;
    if (reconnecting) {
      // a new provider session numbers speakers from scratch: old label → person bindings are void
      this.session.clearSpeechBindings(this.connectionId);
      this.emit({ type: "error", message: "Transcription reconnected: speaker names were cleared. Reconfirm who's who (or use Owner/Guest speaking).", recoverable: true });
    }
    this.session.setStt(reconnecting ? "reconnecting" : "connecting", sttProvider());
    const shift = (msg: unknown) => {
      const m = msg as { type?: string; start?: number; channel?: { alternatives?: { words?: { start: number; end: number }[] }[] } };
      if (offset && m.type === "Results") {
        if (typeof m.start === "number") m.start += offset;
        for (const w of m.channel?.alternatives?.[0]?.words ?? []) {
          w.start += offset;
          w.end += offset;
        }
      }
      return m;
    };
    const stream = openStt(
      this.sampleRate,
      {
        onReady: () => {
          this.reconnects = 0;
          if (stream === this.stt) this.session.setStt("connected", stream.name);
          console.log(
            `[imp] ${stream.name} connected (${this.connectionId.slice(0, 8)})` +
              (stream.name === "speechmatics" ? ` · enrolled: ${this.enrolled.map((e) => e.label).join(", ") || "none"}` : ""),
          );
        },
        onMessage: (msg) => {
          if (stream !== this.stt) return; // a replaced session's late messages
          try {
            this.assembler.handle(shift(msg) as Parameters<TurnAssembler["handle"]>[0]);
          } catch (err) {
            console.error("[imp] bad transcription message", err);
          }
        },
        onFail: (message) => stream === this.stt && this.retryOrFail(message),
        onClosed: (code) => {
          if (stream === this.stt && !this.closed) this.retryOrFail(`Transcription disconnected (code ${code}).`);
        },
      },
      this.enrolled,
    );
    return stream;
  }

  /** Transient provider trouble (session limit, dropped socket) reconnects instead of ending listening. */
  private retryOrFail(message: string) {
    if (this.closed) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      return this.fail(`${message} Start listening again; speakers need re-confirming.`);
    }
    const wait = Math.min(8000, 1000 * 2 ** this.reconnects++);
    this.session.setStt("reconnecting", this.stt.name, `${message} Retry ${this.reconnects}/${MAX_RECONNECTS} in ${wait / 1000} s`);
    console.warn(`[imp] ${message} Reconnecting in ${wait / 1000}s (attempt ${this.reconnects}/${MAX_RECONNECTS}).`);
    const old = this.stt;
    old.end(true);
    setTimeout(() => {
      if (this.closed || this.stt !== old) return;
      this.assembler.flush(); // finish whatever the old session had
      this.stt = this.connect();
    }, wait).unref();
  }

  /**
   * Forward audio in order and keep a copy. Deepgram's word times count samples it received, so
   * nothing may be dropped or the ring buffer and the transcript drift apart.
   */
  audio(chunk: Buffer) {
    if (this.closed) return;
    const at = this.ring.durationSec;
    this.ring.appendBytes(chunk);
    // Only real playback time: the post-playback cooldown is for late-arriving transcripts, and
    // counting it here would swallow someone who starts talking the moment the imp stops.
    if (this.session.isPlaying()) addMutedTime(this.mutedSpans, at, this.ring.durationSec);
    // echo spans older than the ring buffer can't matter any more (keeps an all-day session bounded)
    if (this.mutedSpans.length > 50) this.mutedSpans = this.mutedSpans.filter(([, end]) => end > this.ring.durationSec - RING_SECONDS);
    // While the imp's own voice is playing, the provider gets silence of the same length instead of
    // the mic. Those words would be dropped as echo anyway, and transcribing them made Speechmatics
    // fall 5-9 s behind in rehearsal. Same sample count, so timestamps stay aligned with the ring.
    this.stt.send(this.session.isPlaying() ? Buffer.alloc(chunk.length) : chunk);
  }

  /** Score the turn's own audio (when there's a profile and it's long enough), then hand it to the session. */
  private async deliver(turn: AssembledTurn, times: { startedAt: number; endedAt: number }) {
    const durationSec = turn.endSec - turn.startSec;
    if (turn.endSec <= this.discardBeforeSec) return void console.log(`[imp] dropped a turn from before the reset: "${turn.text.slice(0, 50)}"`);
    const manual = this.assignmentAt((turn.startSec + turn.endSec) / 2);
    if (manual?.role === "guest" && (turn.speakerLabel === OWNER_LABEL || turn.speakerLabel === this.session.ownerSpeakerLabel)) {
      // the operator says this was a guest: never file it under the owner's label
      turn = { ...turn, speakerLabel: MANUAL_GUEST_LABEL };
    }
    if (manual?.role === "guest" && manual.personId && this.session.personFor(this.connectionId, turn.speakerLabel) !== manual.personId) {
      await this.session.bindSpeaker(this.connectionId, turn.speakerLabel, manual.personId);
    }
    // Deepgram finalizes a second or so after the words, so a "muted?" check on arrival misses the
    // tail of the imp's own reply. Judge by when the audio was actually captured instead.
    if (this.droppedEcho.length) {
      console.log(`[imp] filtered own speech from the mic: "${this.droppedEcho.join(" ").slice(0, 80)}"`);
      this.droppedEcho = [];
    }
    let ownerScore: number | null = null;
    const profile = this.voice.activeProfile();
    if (profile && durationSec >= profile.minScorableSec && !this.session.isPlaying()) {
      const pcm = this.ring.slice(turn.startSec - SLICE_PAD_SEC, turn.endSec + SLICE_PAD_SEC);
      const r = pcm ? await this.voice.scoreTurn(pcm, this.sampleRate) : null;
      if (r) {
        ownerScore = r.score;
        console.log(`[imp] voice ${r.score.toFixed(3)} in ${r.ms}ms (${turn.speakerLabel}, ${durationSec.toFixed(1)}s)`);
      }
    }
    const ownerLabel = this.ownerEnrolled && turn.speakerLabel === OWNER_LABEL;
    if (!ownerLabel && !this.session.isPlaying()) this.keepVoiceAudio(turn.speakerLabel, turn.startSec, turn.endSec);
    // Speechmatics recognized an enrolled visitor: bind the label to them (shown as "<name> detected").
    if (turn.speakerLabel.startsWith(PERSON_LABEL)) {
      const personId = turn.speakerLabel.slice(PERSON_LABEL.length);
      if (this.session.personFor(this.connectionId, turn.speakerLabel) !== personId) {
        await this.session.bindSpeaker(this.connectionId, turn.speakerLabel, personId, { auto: true });
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
      // Speechmatics names the enrolled owner itself, judging the whole conversation, not one clip.
      providerOwner: this.ownerEnrolled ? turn.speakerLabel === OWNER_LABEL : null,
      echoFiltered: true,
      ...(manual ? { manualRole: manual.role } : {}),
    });
  }

  private keepVoiceAudio(label: string, startSec: number, endSec: number) {
    const pcm = this.ring.slice(startSec, endSec);
    if (!pcm) return;
    const clips = [...(this.labelAudio.get(label) ?? []), pcm];
    let total = clips.reduce((n, c) => n + c.length, 0);
    while (clips.length > 1 && total > VOICE_CLIP_MAX_SEC * this.sampleRate) total -= clips.shift()!.length;
    this.labelAudio.set(label, clips);
  }

  /** One voice's recent audio in this connection, for its voiceprint. */
  voiceAudio(label: string): { takes: { pcm: Float32Array; sampleRate: number }[]; seconds: number } {
    const clips = this.labelAudio.get(label) ?? [];
    return { takes: clips.map((pcm) => ({ pcm, sampleRate: this.sampleRate })), seconds: clips.reduce((n, c) => n + c.length, 0) / this.sampleRate };
  }

  /**
   * The operator pressed (role) or released (null) "Owner speaking" / "Guest speaking". Audio and this
   * message share one socket, so the stream position now is exactly where the press happened.
   */
  assign(role: "owner" | "guest" | null, personId: string | null = null) {
    const now = this.ring.durationSec;
    const open = this.assignments.at(-1);
    if (open && open.end === null) open.end = now;
    if (role) this.assignments.push({ start: now, end: null, role, personId });
    if (this.assignments.length > 100) this.assignments.splice(0, this.assignments.length - 100);
  }

  private assignmentAt(sec: number) {
    // a little slack: transcription word times and the press can be a few hundred ms apart
    return [...this.assignments].reverse().find((a) => sec >= a.start - 0.3 && sec <= (a.end ?? Infinity) + 0.5) ?? null;
  }

  /** Demo reset: forget words in flight and anything said before now. */
  discardPending() {
    this.assembler.discard();
    this.discardBeforeSec = this.ring.durationSec;
    this.droppedEcho = [];
  }

  /** Server going down: close the provider session immediately. */
  shutdown() {
    this.closed = true;
    this.stt.end(true);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.session.stt.state !== "failed") this.session.setStt("off", this.stt.name);
    this.stt.end();
    this.onEnded(this);
    // Give Deepgram a moment to return final results and flush them while the owner label still
    // applies; only then end the connection (unless a newer relay already replaced it).
    setTimeout(() => {
      this.assembler.flush();
      this.assembler.dispose();
      if (this.session.speechConnectionId === this.connectionId) this.session.setSpeechConnection(null);
    }, 800).unref();
  }

  private fail(message: string) {
    if (this.closed) return;
    this.session.setStt("failed", this.stt.name, message);
    console.error(`[imp] ${message}`);
    this.emit({ type: "error", message, recoverable: true });
    this.stop();
  }
}
