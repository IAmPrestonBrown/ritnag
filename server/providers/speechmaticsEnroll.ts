import type { PcmTake } from "../voice/verifier";
import { transcribe } from "./speechmaticsClip";

/**
 * Speechmatics voiceprint ("speaker identifiers") for one person, from their enrollment takes.
 * Takes at the same sample rate are joined into one clip; the identifiers come from the dominant
 * diarized speaker, so a stray background voice in a take doesn't become part of the print.
 */
export async function speechmaticsVoiceprint(takes: PcmTake[]): Promise<string[]> {
  const byRate = new Map<number, Float32Array[]>();
  for (const t of takes) byRate.set(t.sampleRate, [...(byRate.get(t.sampleRate) ?? []), t.pcm]);
  const ids: string[] = [];
  for (const [sampleRate, parts] of byRate) {
    const gap = new Float32Array(Math.round(sampleRate * 0.4));
    const joined = parts.flatMap((p) => [p, gap]);
    const pcm = new Int16Array(joined.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of joined) for (let i = 0; i < p.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(p[i]! * 32767)));
    const r = await transcribe({ sampleRate, pcm }, { getSpeakers: true });
    const words = new Map<string, number>();
    for (const w of r.words) words.set(w.speaker, (words.get(w.speaker) ?? 0) + 1);
    const main = [...words].sort((a, b) => b[1] - a[1])[0]?.[0];
    const sp = r.speakers.find((s) => s.label === main) ?? r.speakers[0];
    if (sp) ids.push(...sp.speaker_identifiers);
  }
  return ids;
}
