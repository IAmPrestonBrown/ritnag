// Timed transcript of a finished video, as the starting point for a director timeline. See docs/DIRECTOR.md.
//
//   npm run director:transcribe -- video.mp4 [--out out/transcript.json]
//
// Writes <out> (utterances: speaker, start/end ms, text, words) and <out>.draft-timeline.json: one `say` per
// utterance, every speaker as "guest S<n>". Edit the draft: map speakers to owner/names, turn the imp's own
// lines into `imp` events (voice:false), and add notices, memory, repeat and alert beats.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [video, ...rest] = process.argv.slice(2);
if (!video) {
  console.error("usage: npm run director:transcribe -- <video> [--out file.json]");
  process.exit(1);
}
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = resolve(flag("--out") ?? "out/transcript.json");
mkdirSync(dirname(out), { recursive: true });
const key = process.env.DEEPGRAM_API_KEY;
if (!key) throw new Error("DEEPGRAM_API_KEY is not set (.env)");

// 16 kHz mono WAV of the soundtrack
const wav = out.replace(/\.json$/, "") + ".wav";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", wav]);

const qs = new URLSearchParams({ model: "nova-3", diarize: "true", utterances: "true", smart_format: "true", punctuate: "true", utt_split: "0.9" });
const res = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
  method: "POST",
  headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" },
  body: readFileSync(wav),
});
if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
const dg = (await res.json()) as {
  results: { utterances?: { start: number; end: number; speaker?: number; transcript: string; words: { punctuated_word?: string; word: string; start: number; end: number }[] }[] };
};

const ms = (s: number) => Math.round(s * 1000);
const utterances = (dg.results.utterances ?? []).map((u) => ({
  speaker: `S${(u.speaker ?? 0) + 1}`,
  start: ms(u.start),
  end: ms(u.end),
  text: u.transcript,
  words: u.words.map((w) => ({ w: w.punctuated_word ?? w.word, start: ms(w.start), end: ms(w.end) })),
}));
writeFileSync(out, JSON.stringify({ video: resolve(video), utterances }, null, 2));

const draft = {
  isolate: true,
  events: [
    { at: 0, do: "listening", on: true },
    { at: 0, do: "tab", tab: "transcript" },
    ...utterances.map((u) => ({ at: u.start, do: "say", who: `guest ${u.speaker}`, text: u.text, ms: Math.max(0, u.end - u.start) })),
  ],
};
const draftPath = out.replace(/\.json$/, "") + ".draft-timeline.json";
writeFileSync(draftPath, JSON.stringify(draft, null, 2));

for (const u of utterances) console.log(`${(u.start / 1000).toFixed(2).padStart(7)}–${(u.end / 1000).toFixed(2).padEnd(7)} ${u.speaker}  ${u.text}`);
console.log(`\n${utterances.length} utterances → ${out}\ndraft timeline → ${draftPath}`);
