import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { LinearResampler, SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import { normalize, type PcmTake, type SpeakerVerifier } from "./verifier";

const MODEL_FILE = "wespeaker_en_voxceleb_resnet34_LM.onnx";
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${MODEL_FILE}`;
const MODEL_SHA256 = "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012";
const MODEL_RATE = 16_000;

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/**
 * Returns a local path to the embedding model, downloading and checksumming it on first use.
 * VOICE_MODEL_PATH points at a model you provide yourself (no checksum).
 */
export async function ensureModel(dir: string): Promise<string> {
  if (process.env.VOICE_MODEL_PATH) return process.env.VOICE_MODEL_PATH;
  const path = join(dir, MODEL_FILE);
  if (existsSync(path)) {
    if (sha256(readFileSync(path)) === MODEL_SHA256) return path;
    console.warn(`[imp] voice model checksum mismatch at ${path}; downloading again`);
  }
  mkdirSync(dir, { recursive: true });
  console.log(`[imp] downloading voice model (~26 MB) → ${path}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`voice model download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== MODEL_SHA256) throw new Error("voice model download failed its checksum");
  writeFileSync(`${path}.tmp`, buf);
  renameSync(`${path}.tmp`, path);
  return path;
}

/**
 * In-process speaker embeddings: WeSpeaker ResNet34 (VoxCeleb, English) run through sherpa-onnx.
 * No Python sidecar and no access key; about 35 ms per few-second turn on an M-series laptop.
 */
export class SherpaVerifier implements SpeakerVerifier {
  readonly engine = `sherpa-onnx/${MODEL_FILE.replace(/\.onnx$/, "")}`;
  // Cosine similarity on this model. Tightened per room by the impostor check.
  readonly defaults = { thresholds: { accept: 0.62, reject: 0.45 }, minScorableSec: 1.2 };
  private extractor: SpeakerEmbeddingExtractor | null = null;
  private sherpa: typeof import("sherpa-onnx-node") | null = null;
  private resamplers = new Map<number, LinearResampler>();
  private loading: Promise<void> | null = null;

  constructor(private readonly modelDir: string) {}

  load() {
    this.loading ??= (async () => {
      const model = await ensureModel(this.modelDir);
      this.sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as typeof import("sherpa-onnx-node");
      this.extractor = new this.sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 1, debug: false });
    })().catch((err) => {
      this.loading = null; // allow a retry
      throw err;
    });
    return this.loading;
  }

  async embed({ pcm, sampleRate }: PcmTake): Promise<number[]> {
    await this.load();
    const ex = this.extractor!;
    const stream = ex.createStream();
    stream.acceptWaveform({ sampleRate: MODEL_RATE, samples: this.to16k(pcm, sampleRate) });
    stream.inputFinished();
    if (!ex.isReady(stream)) throw new Error("audio too short to embed");
    return normalize(ex.compute(stream, false));
  }

  /** Resample here (filtered) so the native side doesn't, and doesn't log about it on every turn. */
  private to16k(pcm: Float32Array, rate: number): Float32Array {
    if (rate === MODEL_RATE) return pcm;
    let r = this.resamplers.get(rate);
    if (!r) this.resamplers.set(rate, (r = new this.sherpa!.LinearResampler(rate, MODEL_RATE)));
    r.reset(); // each slice is independent audio
    return r.flush(pcm);
  }
}
