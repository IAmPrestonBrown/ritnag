import WebSocket from "ws";

export const deepgramConfigured = () => Boolean(process.env.DEEPGRAM_API_KEY);

/**
 * Opens a Deepgram live connection for containerized browser audio (WebM/Opus).
 * Containerized audio must NOT carry encoding/sample_rate; Deepgram reads the header.
 */
export function openDeepgram(): WebSocket {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
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
