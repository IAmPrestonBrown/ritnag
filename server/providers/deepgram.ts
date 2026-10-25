import WebSocket from "ws";

export const deepgramConfigured = () => Boolean(process.env.DEEPGRAM_API_KEY);

/**
 * Opens a Deepgram live connection for raw mono PCM16 from the browser's AudioWorklet.
 * Raw audio has no header, so encoding and sample_rate are both required (and must be the real rate).
 */
export function openDeepgram(sampleRate: number): WebSocket {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    diarize_model: "latest",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING_MS || "500",
    utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS || "1000",
  });
  return new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });
}
