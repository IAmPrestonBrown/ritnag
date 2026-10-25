const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
const CHUNK_MS = 200;

/** Mic → MediaRecorder (containerized WebM/Opus) → binary frames on the events WebSocket. */
export class MicCapture {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private sendChain: Promise<void> = Promise.resolve();

  get active() {
    return this.recorder !== null;
  }

  async start(socket: WebSocket) {
    if (this.recorder) return;
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error("This browser can't record WebM/Ogg Opus. Use desktop Chrome.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    socket.send(JSON.stringify({ type: "mic.start", mimeType }));
    const recorder = new MediaRecorder(this.stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      // arrayBuffer() is async; chain sends so chunks (and the WebM header) stay in order.
      this.sendChain = this.sendChain.then(async () => {
        const buf = await e.data.arrayBuffer();
        if (socket.readyState === WebSocket.OPEN) socket.send(buf);
      });
    };
    recorder.start(CHUNK_MS);
    this.recorder = recorder;
  }

  stop(socket: WebSocket | null) {
    if (!this.recorder) return;
    this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    void this.sendChain.then(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "mic.stop" }));
    });
  }
}
