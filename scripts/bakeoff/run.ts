/**
 * Speaker-ID bake-off (docs/WORKSTREAMS.md P1).
 *
 *   npx tsx scripts/bakeoff/run.ts label <set>   transcribe conversation clips → <set>/labels.json to fill in
 *   npx tsx scripts/bakeoff/run.ts eval  <set>   score the systems against the filled-in labels → <set>/report.md
 *
 * Options: --owner <name> (default Preston), --sensitivity <0..1> (Speechmatics speaker_sensitivity).
 * Recordings come from the "Speaker-ID test recordings (P1)" panel: data/recordings/<set>/.
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SherpaVerifier } from "../../server/voice/sherpa";
import { cosine, meanEmbedding, type OwnerProfile } from "../../server/voice/verifier";
import { transcribe, type SmSpeaker } from "./speechmatics";
import { gatedPrediction, labelForSpan, pct, segmentWords, tally, type Scored, type Segment, type Tally } from "./score";
import { readWav, sliceSec, toFloat, type Wav } from "./wav";

interface Clip {
  file: string;
  kind: "solo" | "conversation";
  speaker: string | null;
  durationSec: number;
  deviceLabel: string;
}

const root = resolve(import.meta.dirname, "../..");
const [cmd, set] = process.argv.slice(2);
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OWNER = flag("owner") ?? "Preston";
const SENSITIVITY = flag("sensitivity") !== undefined ? Number(flag("sensitivity")) : undefined;

if (!cmd || !set || !["label", "eval"].includes(cmd)) {
  console.log("usage: npx tsx scripts/bakeoff/run.ts <label|eval> <set> [--owner Preston] [--sensitivity 0.5]");
  process.exit(1);
}
const dir = join(root, "data/recordings", set);
const manifestPath = join(dir, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`no recordings at ${dir}; record some with the P1 panel first`);
const clips = JSON.parse(readFileSync(manifestPath, "utf8")) as Clip[];
const conversations = clips.filter((c) => c.kind === "conversation");
const solos = clips.filter((c) => c.kind === "solo");
const labelsPath = join(dir, "labels.json");
const wavs = new Map<string, Wav>();
const wav = (file: string) => {
  if (!wavs.has(file)) wavs.set(file, readWav(join(dir, file)));
  return wavs.get(file)!;
};

if (cmd === "label") await label();
else await evaluate();

// ---------------------------------------------------------------------------

async function label() {
  if (conversations.length === 0) throw new Error("no conversation clips in this set");
  if (existsSync(labelsPath)) {
    console.log(`${labelsPath} already exists; delete it to regenerate (your truth labels would be lost).`);
    return;
  }
  const segments: Segment[] = [];
  for (const c of conversations) {
    console.log(`transcribing ${c.file} (${c.durationSec}s)…`);
    const r = await transcribe(wav(c.file));
    segments.push(...segmentWords(c.file, r.words));
  }
  writeFileSync(labelsPath, JSON.stringify(segments, null, 2));
  console.log(`\nWrote ${segments.length} segments to ${labelsPath}`);
  console.log(`Set "truth" on each: a name (${[...new Set(solos.map((s) => s.speaker))].join(", ")}), "other", or "skip".`);
  console.log("Tip: ask Claude Code to show the segments as a numbered list and fill truth from your answers.\n");
  for (const s of segments) console.log(`${String(s.i).padStart(3)} ${s.smLabel.padEnd(4)} ${fmt(s.start)}–${fmt(s.end)}  ${s.text}`);
}

async function evaluate() {
  if (!existsSync(labelsPath)) throw new Error(`run "label ${set}" first, then fill in truth in labels.json`);
  const segs = (JSON.parse(readFileSync(labelsPath, "utf8")) as Segment[]).filter((s) => s.truth && s.truth !== "skip");
  const people = [...new Set(solos.map((s) => s.speaker!))];
  if (!people.includes(OWNER)) throw new Error(`no solo clip for the owner "${OWNER}" (have: ${people.join(", ")})`);
  if (segs.length === 0) throw new Error("no labeled segments: fill in truth in labels.json");
  const unlabeled = (JSON.parse(readFileSync(labelsPath, "utf8")) as Segment[]).filter((s) => !s.truth).length;
  console.log(`${segs.length} labeled segments (${unlabeled} unlabeled ignored); people: ${people.join(", ")}; owner: ${OWNER}\n`);

  // ---- A. sherpa embeddings: per-person centroids from solo clips (5 s chunks)
  console.log("A. local embeddings (sherpa WeSpeaker ResNet34)…");
  const verifier = new SherpaVerifier(join(root, "data/models"));
  await verifier.load();
  const centroids: Record<string, number[]> = {};
  for (const p of people) {
    const chunks: number[][] = [];
    for (const c of solos.filter((s) => s.speaker === p)) {
      const w = wav(c.file);
      for (let t = 0; t + 2 <= w.pcm.length / w.sampleRate; t += 5) {
        chunks.push(await verifier.embed({ pcm: toFloat(sliceSec(w, t, t + 5)), sampleRate: w.sampleRate }));
      }
    }
    centroids[p] = meanEmbedding(chunks);
  }
  const profilePath = join(root, "data/owner-voice.json");
  const profile = existsSync(profilePath) ? (JSON.parse(readFileSync(profilePath, "utf8")) as OwnerProfile) : null;

  const scored: (Scored & { seg: Segment; dur: number; ownerProfileScore: number | null })[] = [];
  for (const s of segs) {
    const w = wav(s.clip);
    const pcm = sliceSec(w, s.start - 0.15, s.end + 0.15);
    const dur = s.end - s.start;
    let e: number[] | null = null;
    try {
      e = await verifier.embed({ pcm: toFloat(pcm), sampleRate: w.sampleRate });
    } catch {
      // too short to embed: every system below treats it as "can't tell"
    }
    const scores: Record<string, number> = {};
    if (e) for (const p of people) scores[p] = cosine(centroids[p]!, e);
    scored.push({ truth: s.truth!, scores, seg: s, dur, ownerProfileScore: e && profile ? cosine(profile.embedding, e) : null });
  }

  // ---- B. Speechmatics realtime with enrolled speakers
  console.log("B. Speechmatics realtime speaker identification…");
  const enrollPath = join(dir, "speechmatics-enrollment.json");
  let enrolled: SmSpeaker[];
  if (existsSync(enrollPath)) {
    enrolled = JSON.parse(readFileSync(enrollPath, "utf8"));
  } else {
    enrolled = [];
    for (const p of people) {
      const ids: string[] = [];
      for (const c of solos.filter((s) => s.speaker === p)) {
        const r = await transcribe(wav(c.file), { getSpeakers: true });
        const counts = new Map<string, number>();
        for (const wd of r.words) counts.set(wd.speaker, (counts.get(wd.speaker) ?? 0) + 1);
        const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
        const sp = r.speakers.find((x) => x.label === main) ?? r.speakers[0];
        if (sp) ids.push(...sp.speaker_identifiers);
      }
      if (ids.length) enrolled.push({ label: p, speaker_identifiers: ids });
    }
    writeFileSync(enrollPath, JSON.stringify(enrolled)); // gitignored with the rest of data/
  }
  const smWords = new Map<string, Awaited<ReturnType<typeof transcribe>>["words"]>();
  for (const c of new Set(segs.map((s) => s.clip))) {
    smWords.set(c, (await transcribe(wav(c), { enrolled, sensitivity: SENSITIVITY })).words);
  }
  const names = new Set(enrolled.map((e) => e.label));
  const smPred = (s: Segment) => {
    const l = labelForSpan(smWords.get(s.clip)!, s.start, s.end);
    return l && names.has(l) ? l : null;
  };

  // ---- results
  const rows: string[] = [];
  const line = (name: string, t: Tally) =>
    rows.push(
      `| ${name} | ${t.n} | ${pct(t.correct, t.n)} | ${pct(t.wrong, t.n)} | ${pct(t.generic, t.n)} | ${t.ownerHits}/${t.ownerTurns} | **${t.ownerFalseAccepts}** |`,
    );
  const header = "| System | Turns | Right name | **Wrong name** | Generic | Owner found | **Others taken as owner** |\n|---|---|---|---|---|---|---|";

  if (profile) {
    const pred = (x: (typeof scored)[number]) =>
      x.ownerProfileScore === null || x.dur < profile.minScorableSec
        ? null
        : x.ownerProfileScore >= profile.thresholds.accept
          ? OWNER
          : null;
    line(`Current owner profile (accept ≥ ${profile.thresholds.accept})`, tally(scored.map((x) => ({ truth: x.truth, predicted: pred(x) })), OWNER));
  }
  for (const [minScore, minMargin] of [
    [0, 0],
    [0.5, 0.05],
    [0.55, 0.1],
    [0.6, 0.15],
    [0.65, 0.2],
  ] as const) {
    line(
      `Local embeddings, gate score ≥ ${minScore}, margin ≥ ${minMargin}`,
      tally(scored.map((x) => ({ truth: x.truth, predicted: gatedPrediction(x.scores, minScore, minMargin) })), OWNER),
    );
  }
  line(`Speechmatics enrolled${SENSITIVITY !== undefined ? ` (sensitivity ${SENSITIVITY})` : ""}`, tally(segs.map((s) => ({ truth: s.truth!, predicted: smPred(s) })), OWNER));

  const buckets: [string, (d: number) => boolean][] = [
    ["< 1.5 s", (d) => d < 1.5],
    ["1.5–3 s", (d) => d >= 1.5 && d < 3],
    ["≥ 3 s", (d) => d >= 3],
  ];
  const byDur = buckets.map(([name, f]) => {
    const xs = scored.filter((x) => f(x.dur));
    const sm = tally(xs.map((x) => ({ truth: x.truth, predicted: smPred(x.seg) })), OWNER);
    const local = tally(xs.map((x) => ({ truth: x.truth, predicted: gatedPrediction(x.scores, 0.55, 0.1) })), OWNER);
    return `| ${name} | ${xs.length} | ${pct(local.correct, local.n)} / ${pct(local.wrong, local.n)} | ${pct(sm.correct, sm.n)} / ${pct(sm.wrong, sm.n)} |`;
  });

  const detail = scored.map((x) => {
    const sc = Object.entries(x.scores)
      .map(([p, v]) => `${p} ${v.toFixed(2)}`)
      .join(", ");
    return `| ${x.seg.i} | ${x.truth} | ${x.dur.toFixed(1)}s | ${smPred(x.seg) ?? "generic"} | ${sc || "too short"} | ${x.seg.text.slice(0, 60)} |`;
  });

  const report = `# Speaker-ID bake-off: ${set}

${new Date().toISOString()} · owner **${OWNER}** · people ${people.join(", ")} · ${segs.length} labeled turns · mic: ${[...new Set(clips.map((c) => c.deviceLabel))].join(", ")}

"Generic" means the system declined to name anyone (the imp answers without a name or roast). For a voice nobody enrolled (truth "other"), generic counts as right. **Wrong name** and **others taken as owner** are the errors that matter.

${header}
${rows.join("\n")}

## By turn length (right / wrong)

| Length | Turns | Local (≥ 0.55, margin ≥ 0.1) | Speechmatics |
|---|---|---|---|
${byDur.join("\n")}

## Every turn

| # | Truth | Length | Speechmatics | Local scores | Text |
|---|---|---|---|---|---|
${detail.join("\n")}
`;
  writeFileSync(join(dir, "report.md"), report);
  console.log(`\n${header}\n${rows.join("\n")}\n\nFull report: ${join(dir, "report.md")}`);
}

function fmt(sec: number) {
  return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
}
