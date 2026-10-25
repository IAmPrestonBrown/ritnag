import { readFileSync } from "node:fs";

export interface Wav {
  sampleRate: number;
  /** Mono PCM16 (multi-channel input is downmixed). */
  pcm: Int16Array;
}

/** Minimal RIFF/WAVE reader: walks chunks (macOS `say` and others add extra ones before `data`). */
export function parseWav(buf: Buffer): Wav {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (format !== 1 || bits !== 16) throw new Error(`unsupported WAV (format ${format}, ${bits}-bit); need PCM16`);
      const frames = Math.floor(Math.min(size, buf.length - body) / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buf.readInt16LE(body + (i * channels + c) * 2);
        pcm[i] = Math.round(sum / channels);
      }
      if (!sampleRate) throw new Error("WAV has no fmt chunk before data");
      return { sampleRate, pcm };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}

export const readWav = (path: string) => parseWav(readFileSync(path));

export const toFloat = (pcm: Int16Array) => Float32Array.from(pcm, (s) => s / 32768);

/** Samples for [startSec, endSec), clamped. */
export function sliceSec(w: Wav, startSec: number, endSec: number): Int16Array {
  const a = Math.max(0, Math.floor(startSec * w.sampleRate));
  const b = Math.min(w.pcm.length, Math.ceil(endSec * w.sampleRate));
  return w.pcm.subarray(a, Math.max(a, b));
}
