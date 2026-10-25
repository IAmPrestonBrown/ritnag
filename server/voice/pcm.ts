/** Raw PCM16 bytes (little-endian) → Int16 samples. Copies if the buffer isn't 2-byte aligned. */
export function toInt16(buf: Buffer): Int16Array {
  const n = buf.byteLength >> 1;
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, n);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function int16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}

/**
 * Mono PCM16 ring buffer indexed by stream time (seconds since the first sample appended).
 * Deepgram word timestamps use the same clock because it receives exactly these samples, in order.
 */
export class PcmRing {
  private buf: Int16Array;
  private written = 0; // samples ever appended
  private carry: Buffer | null = null; // odd trailing byte of the last network chunk

  constructor(
    readonly sampleRate: number,
    seconds = 60,
  ) {
    this.buf = new Int16Array(Math.ceil(sampleRate * seconds));
  }

  get durationSec() {
    return this.written / this.sampleRate;
  }

  /** Raw little-endian PCM16 bytes as they arrive; a sample split across chunks is reassembled. */
  appendBytes(bytes: Buffer) {
    let b = this.carry ? Buffer.concat([this.carry, bytes]) : bytes;
    this.carry = null;
    if (b.length % 2) {
      this.carry = Buffer.from(b.subarray(b.length - 1));
      b = b.subarray(0, b.length - 1);
    }
    if (b.length) this.append(toInt16(b));
  }

  append(chunk: Int16Array) {
    const cap = this.buf.length;
    const src = chunk.length > cap ? chunk.subarray(chunk.length - cap) : chunk;
    const start = (this.written + chunk.length - src.length) % cap;
    const first = Math.min(src.length, cap - start);
    this.buf.set(src.subarray(0, first), start);
    if (first < src.length) this.buf.set(src.subarray(first), 0);
    this.written += chunk.length;
  }

  /** Float samples for [startSec, endSec], clamped to what is still buffered; null if none of it is. */
  slice(startSec: number, endSec: number): Float32Array | null {
    const cap = this.buf.length;
    const oldest = Math.max(0, this.written - cap);
    const from = Math.max(oldest, Math.floor(startSec * this.sampleRate));
    const to = Math.min(this.written, Math.ceil(endSec * this.sampleRate));
    if (to <= from) return null;
    const out = new Float32Array(to - from);
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(from + i) % cap]! / 32768;
    return out;
  }
}

export type TakeIssue = "too_short" | "too_quiet" | "clipped" | "noisy";

export interface TakeAnalysis {
  durationSec: number;
  /** Time spent clearly above the take's own noise floor. */
  speechSec: number;
  snrDb: number;
  speechDbfs: number;
  issues: TakeIssue[];
}

const FRAME_SEC = 0.03;
export const MIN_TAKE_SPEECH_SEC = 2;
const MIN_SPEECH_DBFS = -42;
const MIN_SNR_DB = 15;
const MAX_CLIP_FRACTION = 0.002;

/**
 * Quality check for one enrollment take: net speech time, level, SNR against the quiet
 * parts of the same take, and clipping. "noisy" is a warning; the other issues reject the take.
 */
export function analyzeTake(pcm: Float32Array, sampleRate: number): TakeAnalysis {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const db: number[] = [];
  let clipped = 0;
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) {
      const s = pcm[j]!;
      sum += s * s;
      if (Math.abs(s) >= 0.99) clipped++;
    }
    db.push(10 * Math.log10(sum / frame + 1e-12));
  }
  const durationSec = pcm.length / sampleRate;
  if (db.length === 0) return { durationSec, speechSec: 0, snrDb: 0, speechDbfs: -120, issues: ["too_short", "too_quiet"] };

  const sorted = [...db].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.1)]!;
  const gate = Math.max(noise + 10, MIN_SPEECH_DBFS - 10);
  const speech = db.filter((d) => d > gate).sort((a, b) => a - b);
  const speechDbfs = speech.length ? speech[Math.floor(speech.length / 2)]! : -120;
  const speechSec = speech.length * FRAME_SEC;
  const snrDb = speech.length ? speechDbfs - noise : 0;

  const issues: TakeIssue[] = [];
  if (speechSec < MIN_TAKE_SPEECH_SEC) issues.push("too_short");
  if (speechDbfs < MIN_SPEECH_DBFS) issues.push("too_quiet");
  if (clipped / pcm.length > MAX_CLIP_FRACTION) issues.push("clipped");
  if (speech.length && snrDb < MIN_SNR_DB) issues.push("noisy");
  return { durationSec, speechSec, snrDb, speechDbfs, issues };
}
