import { preferredMic } from "./devices";

/** Same processing for live listening and enrollment, so the profile matches what gets scored. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

// Batches 128-frame render quanta into ~85 ms blocks (at 48 kHz) before posting to the main thread.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

/** Mic → AudioWorklet → mono Float32 blocks at the AudioContext's real sample rate. */
export class MicSource {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  onFrames: ((f: Float32Array) => void) | null = null;
  /** Label of the mic actually opened (e.g. "MacBook Air Microphone"). */
  deviceLabel = "";

  get sampleRate() {
    return this.ctx?.sampleRate ?? 0;
  }

  get open() {
    return this.ctx !== null;
  }

  async start() {
    if (this.ctx) return;
    const mic = await preferredMic();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...MIC_CONSTRAINTS, ...(mic ? { deviceId: { exact: mic.deviceId } } : {}) },
    });
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? mic?.label ?? "";
    const ctx = new AudioContext();
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const src = ctx.createMediaStreamSource(this.stream);
    const tap = new AudioWorkletNode(ctx, "pcm-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit", // downmix to mono
    });
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrames?.(e.data);
    // The graph must reach the destination to be pulled; a muted gain keeps it silent.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(tap).connect(mute).connect(ctx.destination);
    this.nodes = [src, tap, mute];
    await ctx.resume();
  }

  async stop() {
    this.onFrames = null;
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    await ctx?.close();
  }
}

export function toPcm16(f: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function rmsDbfs(f: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
  return 10 * Math.log10(sum / Math.max(1, f.length) + 1e-12);
}
