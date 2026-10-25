import { fetchSpeech, post } from "../api";
import { canChooseSpeaker, chosenSpeaker } from "./devices";

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
      // Tell the server no audio is coming (a network failure never reaches its TTS-error path),
      // so the imp and the mic gate leave "thinking". A repeat "ended" is a no-op there.
      if (this.current === responseId) {
        this.current = null;
        void post("/api/playback", { responseId, phase: "ended" });
      }
      throw err;
    }
    if (this.current !== responseId) return; // superseded or stopped while synthesizing
    this.url = URL.createObjectURL(blob);
    const audio = new Audio(this.url);
    this.audio = audio;
    await routeToSpeaker(audio);
    if (this.current !== responseId) return; // stopped while switching outputs
    audio.onplaying = () => {
      this.onSpeaking(true, text);
      void post("/api/playback", { responseId, phase: "started" });
    };
    const done = () => this.finish(responseId);
    audio.onended = done;
    audio.onerror = done;
    try {
      await audio.play();
    } catch (err) {
      done();
      // usually autoplay policy: the page needs a click before audio may play
      throw new Error(`playback blocked (${(err as Error).name}). Click anywhere on the page, then try again.`);
    }
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

/**
 * Sends the imp's voice to the output picked for the room, so a visitor hears it while the owner wears
 * headphones. If that output is gone (unplugged speaker), it falls back to the system default.
 */
async function routeToSpeaker(audio: HTMLAudioElement) {
  const sink = chosenSpeaker();
  if (!sink || !canChooseSpeaker()) return;
  try {
    await audio.setSinkId(sink);
  } catch (err) {
    console.warn(`Imp speaker unavailable (${(err as Error).name}); using the system default output`);
  }
}
