import type { Tone } from "../../shared/schemas";

export const CARTESIA_VERSION = "2026-08-14";

/** Delivery follows the owner's chosen tone for the listener (Cartesia emotion + pace). */
const DELIVERY: Record<Tone, { emotion?: string; speed: number; volume?: number }> = {
  neutral: { speed: 1.05 },
  friendly: { emotion: "happy", speed: 1.05 },
  playful: { emotion: "excited", speed: 1.08 },
  sarcastic: { emotion: "sarcastic", speed: 1.05 },
  annoyed: { emotion: "angry", speed: 1.12 },
  savage: { emotion: "outraged", speed: 1.1, volume: 1.3 },
  flirty: { emotion: "flirtatious", speed: 0.98 },
};

/** A hung request would otherwise leave the imp "thinking" forever; a timeout fails into the normal TTS-error path. */
const CARTESIA_TIMEOUT_MS = 10_000;

export const cartesiaConfigured = () => Boolean(process.env.CARTESIA_API_KEY && process.env.CARTESIA_VOICE_ID);

function request(text: string, tone: Tone, signal: AbortSignal) {
  const delivery = DELIVERY[tone];
  return fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: process.env.CARTESIA_MODEL || "sonic-3.6",
      transcript: text,
      voice: { id: process.env.CARTESIA_VOICE_ID },
      language: "en",
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      generation_config: {
        speed: delivery.speed,
        ...(delivery.volume ? { volume: delivery.volume } : {}),
        ...(delivery.emotion ? { emotion: delivery.emotion } : {}),
      },
    }),
  });
}

async function failed(res: Response) {
  const detail = (await res.text()).slice(0, 300);
  return new Error(`Cartesia TTS ${res.status}: ${detail}`);
}

/** One complete MP3 clip (kept for callers that need the whole file). */
export async function synthesize(text: string, tone: Tone = "neutral"): Promise<{ audio: Buffer; contentType: string }> {
  const res = await request(text, tone, AbortSignal.timeout(CARTESIA_TIMEOUT_MS));
  if (!res.ok) throw await failed(res);
  return { audio: Buffer.from(await res.arrayBuffer()), contentType: "audio/mpeg" };
}

/**
 * Streaming MP3: resolves as soon as Cartesia starts responding, so playback can begin on the first
 * chunk instead of after the whole clip. The timeout only covers getting the response started; an
 * abort `signal` (the listener went away) cancels the rest.
 */
export async function synthesizeStream(text: string, tone: Tone = "neutral", signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const started = new AbortController();
  const timer = setTimeout(() => started.abort(new Error("Cartesia didn't respond in time")), CARTESIA_TIMEOUT_MS);
  signal?.addEventListener("abort", () => started.abort(signal.reason));
  try {
    const res = await request(text, tone, started.signal);
    if (!res.ok || !res.body) throw await failed(res);
    return res.body;
  } finally {
    clearTimeout(timer);
  }
}
