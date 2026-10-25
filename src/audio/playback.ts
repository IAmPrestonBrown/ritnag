import { fetchSpeech, post } from "../api";

/** Plays one response at a time; reports real playback start/end so the avatar and mic gate follow actual audio. */
export class Player {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private current: string | null = null;

  constructor(private readonly onSpeaking: (speaking: boolean, text: string | null) => void) {}

  async play(responseId: string, text: string) {
    this.stop();
    this.current = responseId;
    let blob: Blob;
    try {
      blob = await fetchSpeech(responseId);
    } catch (err) {
      if (this.current === responseId) this.current = null;
      throw err;
    }
    if (this.current !== responseId) return; // superseded or stopped while synthesizing
    this.url = URL.createObjectURL(blob);
    const audio = new Audio(this.url);
    this.audio = audio;
    audio.onplaying = () => {
      this.onSpeaking(true, text);
      void post("/api/playback", { responseId, phase: "started" });
    };
    const done = () => this.finish(responseId);
    audio.onended = done;
    audio.onerror = done;
    await audio.play().catch(done);
  }

  private finish(responseId: string) {
    if (this.current !== responseId) return;
    this.current = null;
    this.audio = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.onSpeaking(false, null);
    void post("/api/playback", { responseId, phase: "ended" });
  }

  stop() {
    if (!this.current) return;
    const id = this.current;
    this.audio?.pause();
    this.finish(id);
  }
}
