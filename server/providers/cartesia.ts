import type { Tone } from "../../shared/schemas";

const CARTESIA_VERSION = "2026-08-14";

/** Delivery follows the owner's chosen tone for the listener (Cartesia emotion + pace). */
const DELIVERY: Record<Tone, { emotion?: string; speed: number; volume?: number }> = {
  neutral: { speed: 1.05 },
  friendly: { emotion: "happy", speed: 1.05 },
  playful: { emotion: "excited", speed: 1.08 },
  sarcastic: { emotion: "sarcastic", speed: 1.05 },
  annoyed: { emotion: "angry", speed: 1.12 },
  savage: { emotion: "outraged", speed: 1.1, volume: 1.3 },
};

export const cartesiaConfigured = () => Boolean(process.env.CARTESIA_API_KEY && process.env.CARTESIA_VOICE_ID);

/** One short, complete MP3 clip. Streaming can come later once playback is reliable. */
export async function synthesize(text: string, tone: Tone = "neutral"): Promise<{ audio: Buffer; contentType: string }> {
  const delivery = DELIVERY[tone];
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
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
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Cartesia TTS ${res.status}: ${detail}`);
  }
  return { audio: Buffer.from(await res.arrayBuffer()), contentType: "audio/mpeg" };
}
