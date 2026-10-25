import { cartesiaConfigured, synthesize } from "./providers/cartesia";
import type { Tone } from "../shared/schemas";

/**
 * Instant reactions: a short in-character noise the moment a guest finishes a question, while the
 * real answer is still being decided (~2-3 s). Synthesized once at startup, so playing one costs
 * nothing and starts in a fraction of a second. They carry no facts and no names.
 */
const LINES: Record<Tone, string[]> = {
  neutral: ["Hmm.", "Let me see."],
  friendly: ["Ooh, okay.", "Oh, good one."],
  playful: ["Oh, here we go.", "Ha, okay, okay."],
  sarcastic: ["Oh, wow.", "Mm-hm. Sure."],
  annoyed: ["Ugh.", "Again?"],
  savage: ["Oh my god.", "Seriously?"],
  flirty: ["Oh, hey you.", "Mm, hi there."],
};

export interface Reaction {
  key: string;
  text: string;
  tone: Tone;
}

export class ReactionBank {
  private clips = new Map<string, Reaction & { audio: Buffer }>();
  private lastKey = new Map<Tone, string>();

  /** Synthesizes every line in the background; reactions switch on as clips arrive. */
  async warm(concurrency = 3) {
    if (!cartesiaConfigured()) return;
    const jobs = (Object.entries(LINES) as [Tone, string[]][]).flatMap(([tone, lines]) =>
      lines.map((text, i) => ({ key: `${tone}:${i}`, text, tone })),
    );
    const t0 = Date.now();
    const worker = async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        try {
          const { audio } = await synthesize(job.text, job.tone);
          this.clips.set(job.key, { ...job, audio });
        } catch (err) {
          console.warn(`[imp] reaction "${job.text}" not synthesized:`, err instanceof Error ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`[imp] ${this.clips.size} instant reactions ready in ${Date.now() - t0}ms`);
  }

  /** A clip for this tone (falls back to neutral), avoiding an immediate repeat. */
  pick(tone: Tone): Reaction | null {
    const options = [...this.clips.values()].filter((c) => c.tone === tone);
    const pool = options.length ? options : [...this.clips.values()].filter((c) => c.tone === "neutral");
    if (!pool.length) return null;
    const fresh = pool.filter((c) => c.key !== this.lastKey.get(tone));
    const c = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))]!;
    this.lastKey.set(tone, c.key);
    return { key: c.key, text: c.text, tone: c.tone };
  }

  audio(key: string): Buffer | undefined {
    return this.clips.get(key)?.audio;
  }
}
