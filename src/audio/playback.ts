import { post, speechStreamUrl } from "../api";
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
    // Streamed: the element starts playing on the first chunk instead of waiting for the whole clip.
    const audio = new Audio(speechStreamUrl(responseId));
    audio.preload = "auto";
    this.audio = audio;
    await routeToSpeaker(audio);
    if (this.current !== responseId) return; // stopped while switching outputs
    audio.onplaying = () => {
      this.onSpeaking(true, text);
      void post("/api/playback", { responseId, phase: "started" });
    };
    const done = () => this.finish(responseId);
    audio.onended = done;
    audio.onerror = done; // stream failed (TTS error, stale reply): finish() tells the server no audio is coming
    try {
      await audio.play();
    } catch (err) {
      done();
      if ((err as Error).name === "NotAllowedError") {
        throw new Error("playback blocked by the browser. Click anywhere on the page, then try again.");
      }
      throw new Error("the voice couldn't be played (speech synthesis failed or the reply went stale).");
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
