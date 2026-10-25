import { MicSource, toPcm16 } from "./pcm";

/**
 * Mic → AudioWorklet → mono PCM16 binary frames on the events WebSocket. Raw PCM (not WebM) so the
 * server can cut out any turn's audio by timestamp and verify the owner's voice.
 */
export class MicCapture {
  private mic: MicSource | null = null;

  get active() {
    return this.mic !== null;
  }

  get deviceLabel() {
    return this.mic?.deviceLabel ?? "";
  }

  async start(socket: WebSocket) {
    if (this.mic) return;
    const mic = new MicSource();
    this.mic = mic;
    try {
      await mic.start();
    } catch (err) {
      this.mic = null;
      await mic.stop();
      throw err;
    }
    // Announce the real rate before any audio so Deepgram is opened with matching parameters.
    socket.send(JSON.stringify({ type: "mic.start", encoding: "linear16", sampleRate: mic.sampleRate }));
    mic.onFrames = (f) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(toPcm16(f).buffer);
    };
  }

  stop(socket: WebSocket | null) {
    if (!this.mic) return;
    void this.mic.stop();
    this.mic = null;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "mic.stop" }));
  }
}
