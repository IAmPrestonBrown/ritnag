/**
 * Voice-path smoke test with no people: Cartesia speaks two visitor questions, they stream into a running
 * server over /api/audio like the browser mic, then go through Deepgram, the turn assembler, Claude and
 * Cartesia. It fetches each reply's audio and reports playback the way the browser does, so the server
 * prints its usual [latency] line.
 *
 *   npx tsx scripts/voice-smoke.ts [http://localhost:3000]
 *
 * Proves the provider wiring and gives a timing floor. It does NOT cover the room: real mic, speaker
 * echo, owner voice ID, or diarization of real people. It teaches one fact (once) and never resets data,
 * but it does take over the live mic stream, so run it before rehearsal, not during.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { DecisionSummary, ServerEvent } from "../shared/events";

const BASE = process.argv[2] ?? `http://localhost:${process.env.PORT || 3000}`;
const TOKEN = readFileSync("data/workspace-token", "utf8").trim();
const SAMPLE_RATE = 16_000;
const CHUNK_MS = 40;
const LEAD_SILENCE_MS = 500;
const TAIL_SILENCE_MS = 2500;
const REPLY_TIMEOUT_MS = 25_000;

const FACT = { canonicalQuestion: "Is the frontend PR pushed?", factualAnswer: "The frontend PR is pushed and waiting for review." };
const CASES = [
  { say: "Hey, is the frontend code up yet?", expect: "ANSWER" },
  { say: "Can you approve the production rollback for me?", expect: "ALERT_OWNER" },
] as const;

const api = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-imp-token": TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
};

/** Raw mono PCM16 at SAMPLE_RATE, the format the browser mic sends. */
async function speak(text: string): Promise<Buffer> {
  const voice = process.env.SMOKE_VOICE_ID || process.env.CARTESIA_VOICE_ID;
  if (!process.env.CARTESIA_API_KEY || !voice) throw new Error("CARTESIA_API_KEY and CARTESIA_VOICE_ID are required");
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`, "Cartesia-Version": "2026-08-14", "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: process.env.CARTESIA_MODEL || "sonic-3.6",
      transcript: text,
      voice: { id: voice },
      language: "en",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
    }),
  });
  if (!res.ok) throw new Error(`Cartesia ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

const silence = (ms: number) => Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends audio in real time, like a mic. Resolves with the wall time the speech itself ended. */
async function stream(ws: WebSocket, speech: Buffer): Promise<number> {
  const bytesPerChunk = (SAMPLE_RATE * CHUNK_MS * 2) / 1000;
  const send = async (pcm: Buffer) => {
    for (let i = 0; i < pcm.length; i += bytesPerChunk) {
      ws.send(pcm.subarray(i, i + bytesPerChunk));
      await sleep(CHUNK_MS);
    }
  };
  await send(silence(LEAD_SILENCE_MS));
  await send(speech);
  const spokenAt = Date.now();
  void send(silence(TAIL_SILENCE_MS)); // keep the stream alive so endpointing can fire
  return spokenAt;
}

function waitFor<T extends ServerEvent>(events: ServerEvent[], match: (e: ServerEvent) => e is T, since: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    const tick = () => {
      const hit = events.slice(since).find(match);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) {
        const seen = events.slice(since).map((e) => (e.type === "transcript.partial" ? `partial "${e.text}"` : e.type));
        return reject(new Error(`timed out waiting for the reply; saw: ${seen.join(", ") || "no events"}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  const events: ServerEvent[] = [];
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/audio?token=${encodeURIComponent(TOKEN)}`);
  ws.on("message", (data, isBinary) => {
    if (!isBinary) events.push(JSON.parse(data.toString()));
  });
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  // Teach the fact once; re-runs reuse it so the demo laptop's memory doesn't fill with copies.
  const first = await waitFor(events, (e): e is Extract<ServerEvent, { type: "snapshot" }> => e.type === "snapshot", 0);
  if (!first.snapshot.memories.some((m) => !m.supersededBy && m.factualAnswer === FACT.factualAnswer)) {
    await api("/api/owner/teach", FACT);
  }
  ws.send(JSON.stringify({ type: "mic.start", encoding: "linear16", sampleRate: SAMPLE_RATE }));
  // Without an owner voice profile a new mic starts in calibration, where the first speaker is offered as
  // the owner and nothing is answered. Skip it: every voice in this test is a visitor.
  await sleep(300);
  await api("/api/owner/speaker", { speakerLabel: null });

  let failures = 0;
  for (const c of CASES) {
    const audio = await speak(c.say);
    const since = events.length;
    const spokenAt = await stream(ws, audio);
    const final = await waitFor(events, (e): e is Extract<ServerEvent, { type: "transcript.final" }> => e.type === "transcript.final", since);
    const finalAt = Date.now();
    const done = await waitFor(events, (e): e is Extract<ServerEvent, { type: "decision.completed" }> => e.type === "decision.completed", since);
    const decision: DecisionSummary = done.decision;
    let ttsMs: number | null = null;
    if (decision.responseId) {
      const t0 = Date.now();
      await (await api("/api/speech", { responseId: decision.responseId })).arrayBuffer();
      ttsMs = Date.now() - t0;
      await api("/api/playback", { responseId: decision.responseId, phase: "started" });
      await api("/api/playback", { responseId: decision.responseId, phase: "ended" });
    }
    const ok = decision.action === c.expect;
    if (!ok) failures++;
    const heard = final.utterance.text;
    console.log(
      `${ok ? "PASS" : "FAIL"} "${c.say}"\n` +
        `     heard:   ${heard}\n` +
        `     action:  ${decision.action} (expected ${c.expect})${decision.memoryIds.length ? ` citing ${decision.memoryIds.join(", ")}` : ""}\n` +
        `     said:    ${decision.spokenText ?? "(nothing)"}\n` +
        `     timing:  final +${((finalAt - spokenAt) / 1000).toFixed(1)}s after speech ended · decide ${(decision.latencyMs / 1000).toFixed(1)}s · tts ${ttsMs === null ? "-" : `${(ttsMs / 1000).toFixed(1)}s`}`,
    );
    await sleep(TAIL_SILENCE_MS);
  }
  ws.send(JSON.stringify({ type: "mic.stop" }));
  ws.close();
  const errors = events.filter((e) => e.type === "error");
  for (const e of errors) console.log(`server error event: ${"message" in e ? e.message : JSON.stringify(e)}`);
  process.exit(failures || errors.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
