import WebSocket from "ws";
import { openDeepgram } from "./deepgram";

/**
 * A live transcription stream. Messages are delivered in Deepgram's live shape (Results /
 * UtteranceEnd) so the turn assembler, echo filter and ring buffer work the same for any provider.
 */
export interface SttStream {
  readonly name: "deepgram" | "speechmatics";
  /** Raw mono PCM16 in capture order; buffered until the provider is ready. */
  send(chunk: Buffer): void;
  /** Flush and close. `fast` closes right away (server shutting down) so the provider frees the session. */
  end(fast?: boolean): void;
}

export interface SttHandlers {
  onMessage(msg: unknown): void;
  onReady(): void;
  onFail(message: string): void;
  onClosed(code: number): void;
}

export interface SpeakerEnrollment {
  label: string;
  speaker_identifiers: string[];
}

export const speechmaticsConfigured = () => Boolean(process.env.SPEECHMATICS_API_KEY);

/** Speechmatics when it's configured (better diarization + enrolled speakers), unless STT_PROVIDER says otherwise. */
export function sttProvider(): "deepgram" | "speechmatics" {
  const forced = process.env.STT_PROVIDER;
  if (forced === "deepgram" || forced === "speechmatics") return forced;
  return speechmaticsConfigured() ? "speechmatics" : "deepgram";
}

export function openStt(sampleRate: number, h: SttHandlers, enrolled: SpeakerEnrollment[]): SttStream {
  return sttProvider() === "speechmatics" ? openSpeechmatics(sampleRate, h, enrolled) : openDeepgramStream(sampleRate, h);
}

// ---------------------------------------------------------------------------

function openDeepgramStream(sampleRate: number, h: SttHandlers): SttStream {
  const ws = openDeepgram(sampleRate);
  const pending: Buffer[] = [];
  let lastAudioAt = Date.now();
  ws.on("open", () => {
    for (const c of pending.splice(0)) ws.send(c);
    h.onReady();
  });
  ws.on("message", (data) => h.onMessage(JSON.parse(data.toString())));
  ws.on("unexpected-response", (_q, res) => h.onFail(`Deepgram rejected the connection (HTTP ${res.statusCode}). Check DEEPGRAM_API_KEY.`));
  ws.on("error", (err) => h.onFail(`Deepgram error: ${err.message}`));
  ws.on("close", (code) => h.onClosed(code));
  // Deepgram closes idle streams; the worklet normally keeps data flowing, this covers gaps.
  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN && Date.now() - lastAudioAt > 4000) ws.send(JSON.stringify({ type: "KeepAlive" }));
  }, 4000);
  return {
    name: "deepgram",
    send(chunk) {
      lastAudioAt = Date.now();
      if (ws.readyState === ws.OPEN) ws.send(chunk);
      else pending.push(chunk);
    },
    end(fast) {
      clearInterval(keepAlive);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      if (fast) ws.close();
      else setTimeout(() => ws.close(), 800).unref();
    },
  };
}

// ---------------------------------------------------------------------------

const SM_URL = () => process.env.SPEECHMATICS_RT_URL || "wss://eu.rt.speechmatics.com/v2";

interface SmResult {
  type: string;
  start_time: number;
  end_time: number;
  alternatives?: { content: string; speaker?: string }[];
}

/** Speechmatics AddTranscript / AddPartialTranscript → Deepgram-shaped Results. Pure, for tests. */
export function smToResults(msg: { message: string; metadata?: { start_time: number; end_time: number; transcript: string }; results?: SmResult[] }) {
  const words: { word: string; punctuated_word: string; start: number; end: number; speaker: string }[] = [];
  for (const r of msg.results ?? []) {
    const alt = r.alternatives?.[0];
    if (!alt) continue;
    if (r.type === "word") {
      words.push({ word: alt.content.toLowerCase(), punctuated_word: alt.content, start: r.start_time, end: r.end_time, speaker: alt.speaker ?? "UU" });
    } else if (r.type === "punctuation" && words.length) {
      words[words.length - 1]!.punctuated_word += alt.content;
    }
  }
  const start = msg.metadata?.start_time ?? words[0]?.start ?? 0;
  const end = msg.metadata?.end_time ?? words.at(-1)?.end ?? start;
  return {
    type: "Results" as const,
    is_final: msg.message === "AddTranscript",
    speech_final: false, // Speechmatics signals the end of a turn separately (EndOfUtterance)
    start,
    duration: end - start,
    channel: { alternatives: [{ transcript: (msg.metadata?.transcript ?? words.map((w) => w.punctuated_word).join(" ")).trim(), words }] },
  };
}

function openSpeechmatics(sampleRate: number, h: SttHandlers, enrolled: SpeakerEnrollment[]): SttStream {
  const ws = new WebSocket(SM_URL(), { headers: { Authorization: `Bearer ${process.env.SPEECHMATICS_API_KEY}` } });
  const pending: Buffer[] = [];
  let started = false;
  let seq = 0;
  let sentBytes = 0;
  const debug = process.env.SPEECHMATICS_DEBUG === "1";
  // a handshake that never completes would leave the mic "connecting" forever: fail into the reconnect path.
  // Generous: on a hotspot the handshake measured 0.5–11 s and still worked.
  const startTimer = setTimeout(() => {
    if (started) return;
    h.onFail("Speechmatics didn't start within 20 s (network?).");
    ws.terminate();
  }, 20_000);
  startTimer.unref();
  const audioSec = () => sentBytes / 2 / sampleRate;
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        message: "StartRecognition",
        audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: sampleRate },
        transcription_config: {
          language: "en",
          // Must match the operating point the voiceprints were made with (enrollment uses "enhanced"):
          // with "standard" the enrolled owner came back as a generic S1 label.
          operating_point: process.env.SPEECHMATICS_OPERATING_POINT || "enhanced",
          diarization: "speaker",
          enable_partials: true,
          max_delay: Number(process.env.SPEECHMATICS_MAX_DELAY || 0.7),
          // "flexible" may hold finals longer to format entities; a live conversation wants them on time
          max_delay_mode: "fixed",
          conversation_config: { end_of_utterance_silence_trigger: Number(process.env.SPEECHMATICS_EOU_SEC || 0.6) },
          speaker_diarization_config: {
            prefer_current_speaker: true,
            ...(enrolled.length ? { speakers: enrolled } : {}),
            ...(process.env.SPEECHMATICS_SPEAKER_SENSITIVITY ? { speaker_sensitivity: Number(process.env.SPEECHMATICS_SPEAKER_SENSITIVITY) } : {}),
          },
        },
      }),
    );
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    switch (msg.message) {
      case "RecognitionStarted":
        started = true;
        clearTimeout(startTimer);
        for (const c of pending.splice(0)) {
          ws.send(c);
          seq++;
          sentBytes += c.length;
        }
        h.onReady();
        break;
      case "AddPartialTranscript":
      case "AddTranscript":
        if (debug && msg.message === "AddTranscript")
          console.log(`[sm] final  lag ${(audioSec() - (msg.metadata?.end_time ?? 0)).toFixed(2)}s "${(msg.metadata?.transcript ?? "").trim().slice(0, 50)}"`);
        h.onMessage(smToResults(msg));
        break;
      case "EndOfUtterance":
        if (debug) console.log(`[sm] EOU    at audio ${audioSec().toFixed(2)}s (utterance ended ${msg.metadata?.end_time ?? "?"})`);
        h.onMessage({ type: "UtteranceEnd" });
        break;
      case "AudioAdded":
        break;
      default:
        // EndOfTranscript, SpeakersResult and future message types are informational, not failures
        if (debug) console.log(`[sm] ${msg.message}`);
        break;
      case "Error":
        if (debug) console.log(`[sm] Error ${JSON.stringify(msg)}`);
        h.onFail(`Speechmatics: ${msg.type}: ${msg.reason}`);
        break;
      case "Info":
        if (debug) console.log(`[sm] Info ${JSON.stringify(msg)}`);
        break;
      case "Warning":
        console.warn(`[imp] speechmatics warning: ${msg.type}: ${msg.reason}`);
        break;
    }
  });
  ws.on("close", () => clearTimeout(startTimer));
  ws.on("unexpected-response", (_q, res) => h.onFail(`Speechmatics rejected the connection (HTTP ${res.statusCode}). Check SPEECHMATICS_API_KEY.`));
  ws.on("error", (err) => h.onFail(`Speechmatics error: ${err.message}`));
  ws.on("close", (code) => h.onClosed(code));
  return {
    name: "speechmatics",
    send(chunk) {
      if (started && ws.readyState === ws.OPEN) {
        ws.send(chunk);
        seq++;
        sentBytes += chunk.length;
      } else pending.push(chunk);
    },
    end(fast) {
      if (ws.readyState === ws.OPEN && started) ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: seq }));
      if (fast || ws.readyState === ws.CONNECTING) return void ws.terminate();
      // EndOfTranscript arrives after the final results; close shortly after either way.
      setTimeout(() => ws.close(), 1500).unref();
    },
  };
}
