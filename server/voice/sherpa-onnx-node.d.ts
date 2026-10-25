// Minimal types for the parts of sherpa-onnx-node we use (the package ships none).
declare module "sherpa-onnx-node" {
  export interface OnlineStream {
    acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number; debug?: boolean; provider?: string });
    readonly dim: number;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }
  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    flush(samples: Float32Array): Float32Array;
    reset(): void;
  }
}
