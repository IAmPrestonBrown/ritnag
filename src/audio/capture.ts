import { MicSource, toPcm16 } from "./pcm";

/**
 * Mic → AudioWorklet → mono PCM16 binary frames on the events WebSocket. Raw PCM (not WebM) so the
 * server can cut out any turn's audio by timestamp and verify the owner's voice.
 */
export class MicCapture {
  private mic: MicSource | null = null;
  private socket: WebSocket | null = null;
  /**
   * Push-to-talk gate. Closed = the mic stays open but silence of the same length is sent, so the
   * transcription stream and its timestamps carry on unchanged and only held speech is heard.
   */
  gate = true;
  /** Mic level 0..1 (RMS of each ~85 ms block, before the gate), for the level meter. */
  onLevel: ((level: number) => void) | null = null;

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
    this.socket = socket;
    mic.onFrames = (f) => {
      if (this.onLevel) {
        let sum = 0;
        for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
        this.onLevel(Math.min(1, Math.sqrt(sum / f.length) * 4));
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(toPcm16(this.gate ? f : new Float32Array(f.length)).buffer);
    };
  }

  /**
   * "Owner speaking" / "Guest speaking" (null = automatic). Sent on the audio socket, so the server
   * knows exactly which audio it covers. Shown in the transcript as a manual assignment.
   */
  assign(role: "owner" | "guest" | null, personId: string | null = null) {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "speaker.assign", role, personId }));
  }

  stop(socket: WebSocket | null) {
    if (!this.mic) return;
    this.mic.onFrames = null;
    void this.mic.stop();
    this.mic = null;
    this.socket = null;
    this.onLevel?.(0);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "mic.stop" }));
  }
}
