import WebSocket from "ws";
/** Mono PCM16 clip. */
export interface Wav {
  sampleRate: number;
  pcm: Int16Array;
}

export interface SmWord {
  content: string;
  start: number;
  end: number;
  /** Enrolled label (e.g. "Preston"), generic diarization label ("S1"), or "UU" (unknown). */
  speaker: string;
}

export interface SmSpeaker {
  label: string;
  speaker_identifiers: string[];
}

export interface SmResult {
  words: SmWord[];
  speakers: SmSpeaker[];
}

const URL = process.env.SPEECHMATICS_RT_URL || "wss://eu.rt.speechmatics.com/v2";
const CHUNK_BYTES = 16_384;
const MAX_UNACKED = 16; // flow control: the server acks each chunk with AudioAdded

/**
 * One Speechmatics realtime session over a whole clip, sent faster than real time with flow control.
 * With `enrolled`, words from those voices come back tagged with their labels; otherwise S1/S2/….
 */
type Opts = { enrolled?: SmSpeaker[]; getSpeakers?: boolean; sensitivity?: number };

/**
 * Free-tier accounts allow very few concurrent sessions, and a just-closed session can still count
 * for a moment, so retry quota errors with backoff instead of failing the whole run.
 */
export async function transcribe(wav: Wav, opts: Opts = {}): Promise<SmResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transcribeOnce(wav, opts);
    } catch (err) {
      if (!/quota_exceeded/.test(String(err)) || attempt >= 6) throw err;
      const wait = 1500 * 2 ** attempt;
      console.log(`  (Speechmatics concurrency limit; retrying in ${(wait / 1000).toFixed(1)}s)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function transcribeOnce(wav: Wav, opts: Opts) {
  const key = process.env.SPEECHMATICS_API_KEY;
  if (!key) throw new Error("SPEECHMATICS_API_KEY is not set in .env");
  return new Promise<SmResult>((resolve, reject) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${key}` } });
    const audio = Buffer.from(wav.pcm.buffer, wav.pcm.byteOffset, wav.pcm.byteLength);
    const words: SmWord[] = [];
    let speakers: SmSpeaker[] = [];
    let sent = 0;
    let acked = 0;
    let offset = 0;
    let ended = false;

    const pump = () => {
      while (offset < audio.length && sent - acked < MAX_UNACKED) {
        ws.send(audio.subarray(offset, offset + CHUNK_BYTES));
        offset += CHUNK_BYTES;
        sent++;
      }
      if (offset >= audio.length && !ended) {
        ended = true;
        ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: sent }));
      }
    };

    ws.on("unexpected-response", (_q, res) => reject(new Error(`Speechmatics rejected the connection (HTTP ${res.statusCode})`)));
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          message: "StartRecognition",
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: wav.sampleRate },
          transcription_config: {
            language: "en",
            operating_point: "enhanced",
            diarization: "speaker",
            speaker_diarization_config: {
              ...(opts.getSpeakers ? { get_speakers: true } : {}),
              ...(opts.enrolled?.length ? { speakers: opts.enrolled } : {}),
              ...(opts.sensitivity !== undefined ? { speaker_sensitivity: opts.sensitivity } : {}),
            },
          },
        }),
      );
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      switch (msg.message) {
        case "RecognitionStarted":
          pump();
          break;
        case "AudioAdded":
          acked = Math.max(acked, msg.seq_no ?? acked + 1);
          pump();
          break;
        case "AddTranscript":
          for (const r of msg.results ?? []) {
            const alt = r.alternatives?.[0];
            if (r.type === "word" && alt) words.push({ content: alt.content, start: r.start_time, end: r.end_time, speaker: alt.speaker ?? "UU" });
            else if (r.type === "punctuation" && alt && words.length) words[words.length - 1]!.content += alt.content;
          }
          break;
        case "SpeakersResult":
          speakers = msg.speakers ?? [];
          break;
        case "Error":
          reject(new Error(`Speechmatics: ${msg.type}: ${msg.reason}`));
          ws.close();
          break;
        case "EndOfTranscript":
          ws.close();
          resolve({ words, speakers });
          break;
      }
    });
    ws.on("close", () => resolve({ words, speakers })); // no-op if already resolved
  });
}
