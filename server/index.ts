import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { ZodType } from "zod";
import { JsonMemoryStore } from "./memory";
import { Session, TYPED_CONNECTION } from "./session";
import { SYSTEM_PROMPT, buildUserMessage, type Decider } from "./decision";
import { claudeDecide, anthropicModel } from "./providers/claude";
import { synthesize, cartesiaConfigured } from "./providers/cartesia";
import { MossIndex } from "./providers/moss";
import { deepgramConfigured } from "./providers/deepgram";
import { AudioRelay } from "./audioRelay";
import { loadWorkspaceToken, tokenMatches } from "./auth";
import { OwnerVoice } from "./voice/ownerVoice";
import { SherpaVerifier } from "./voice/sherpa";
import { voiceRoutes } from "./voice/routes";
import { RecordingStore, recordingRoutes } from "./voice/recordings";
import { LatencyTrace } from "./latency";
import type { Health, ServerEvent } from "../shared/events";
import {
  AckRequest,
  FocusRequest,
  IdentityConfirmRequest,
  OwnerSpeakerRequest,
  ReattributeRequest,
  SuggestionRequest,
  PersonUpdateRequest,
  PlaybackRequest,
  SpeechRequest,
  TeachRequest,
  TurnRequest,
} from "../shared/schemas";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const OWNER_NAME = process.env.OWNER_NAME || "Preston";
const root = resolve(import.meta.dirname, "..");
const isProd = process.env.NODE_ENV === "production";

const token = loadWorkspaceToken(resolve(root, "data/workspace-token"));
const store = new JsonMemoryStore(resolve(root, "data/imp-memory.json"));

const clients = new Set<WebSocket>();

// Synthesis starts the moment a reply is decided, in parallel with the event reaching the browser.
type Clip = { audio: Buffer; contentType: string };
const clips = new Map<string, Promise<Clip>>();
const latency = new LatencyTrace();
const startSynthesis = (responseId: string, text: string, tone: Parameters<typeof synthesize>[1]) => {
  if (!cartesiaConfigured() || clips.has(responseId)) return;
  const t0 = Date.now();
  const p = synthesize(text, tone).then((c) => {
    latency.ttsReady(responseId, Date.now());
    console.log(`[imp] tts ready in ${Date.now() - t0}ms (${tone})`);
    return c;
  });
  p.catch(() => {}); // surfaced when the browser requests it
  clips.set(responseId, p);
  setTimeout(() => clips.delete(responseId), 60_000).unref();
};

const emit = (e: ServerEvent) => {
  latency.observe(e, Date.now()); // the timing line prints when playback starts (see /api/playback)
  if (e.type === "speech.ready") startSynthesis(e.responseId, e.text, e.tone);
  const msg = JSON.stringify(e);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
};

const decider: Decider = async (ctx) => {
  const t0 = Date.now();
  const d = await claudeDecide(SYSTEM_PROMPT, buildUserMessage(ctx));
  console.log(
    `[imp] decision ${d.action} in ${Date.now() - t0}ms (${ctx.role}: "${ctx.utterance.text.slice(0, 60)}")` +
      (d.spokenText ? ` -> "${d.spokenText}"` : ""),
  );
  return d;
};

const index = new MossIndex(() => void session.broadcast());
// Owner voice profile: local, embedding-only, deletable (docs/SPEAKER_ID.md).
const voice = new OwnerVoice(
  new SherpaVerifier(resolve(root, "data/models")),
  resolve(root, "data/owner-voice.json"),
  OWNER_NAME,
  () => void session.broadcast(), // first called from voice.init(), after session exists
);
const session = new Session(store, decider, index, {
  ownerName: OWNER_NAME,
  emit,
  voiceProfile: () => voice.activeProfile(),
  voiceStatus: () => voice.status(),
});
voice.init();
void session.rebuildIndex(); // local records -> Moss on every boot

const app = express();
app.use(express.json({ limit: "64kb" }));

const health = (): Health => ({
  ok: true,
  storage: store.kind,
  providers: {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    deepgram: deepgramConfigured(),
    cartesia: cartesiaConfigured(),
    moss: index.getStatus().configured,
  },
  model: anthropicModel(),
  voice: { enrolled: voice.status().enrolled, active: voice.activeProfile() !== null },
});
app.get("/api/health", (_req, res) => {
  res.json(health());
});

// Everything else under /api needs the workspace token.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (!tokenMatches(token, req.header("x-imp-token"))) return void res.status(401).json({ error: "bad workspace token" });
  next();
});

const body = <T,>(schema: ZodType<T>, req: Request, res: Response): T | null => {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => i.message).join("; ") });
    return null;
  }
  return r.data;
};

app.get("/api/snapshot", async (_req, res) => {
  res.json(await session.snapshot());
});

// Typed fallback: the same pipeline speech uses.
app.post("/api/turn", async (req, res) => {
  const b = body(TurnRequest, req, res);
  if (!b) return;
  const u = await session.ingest({
    text: b.text,
    speakerLabel: b.speakerLabel,
    connectionId: TYPED_CONNECTION,
    providerEventId: randomUUID(),
    source: "typed",
    asOwner: b.asOwner,
  });
  res.json({ utteranceId: u?.id ?? null });
});

app.post("/api/identity/confirm", async (req, res) => {
  const b = body(IdentityConfirmRequest, req, res);
  if (!b) return;
  let personId = b.personId;
  if (b.newPerson) personId = (await store.createPerson(b.newPerson)).id;
  await session.bindSpeaker(b.connectionId, b.speakerLabel, personId);
  res.json({ personId });
});

app.post("/api/people/update", async (req, res) => {
  const b = body(PersonUpdateRequest, req, res);
  if (!b) return;
  const { personId, ...patch } = b;
  const p = await store.updatePerson(personId, patch);
  await session.broadcast();
  res.status(p ? 200 : 404).json(p ?? { error: "no such person" });
});

app.post("/api/owner/teach", async (req, res) => {
  const b = body(TeachRequest, req, res);
  if (!b) return;
  const m = await session.addMemory(
    {
      kind: "faq",
      canonicalQuestion: b.canonicalQuestion,
      factualAnswer: b.factualAnswer,
      sourceUtteranceIds: [],
      sourcePersonId: null,
      observedAt: Date.now(),
      validUntil: null,
    },
    null,
  );
  res.json(m);
});

app.post("/api/index/rebuild", async (_req, res) => {
  const ok = await session.rebuildIndex();
  res.status(ok ? 200 : 502).json({ ok, status: index.getStatus() });
});

app.post("/api/focus", (req, res) => {
  const b = body(FocusRequest, req, res);
  if (!b) return;
  session.setFocus(b.focusMode);
  res.json({ focusMode: b.focusMode });
});

app.post("/api/alerts/acknowledge", async (req, res) => {
  const b = body(AckRequest, req, res);
  if (!b) return;
  await store.acknowledgeAlert(b.alertId);
  await session.broadcast();
  res.json({ ok: true });
});

app.post("/api/owner/calibrate", (_req, res) => {
  session.startCalibration();
  res.json({ ok: true });
});

app.post("/api/owner/speaker", async (req, res) => {
  const b = body(OwnerSpeakerRequest, req, res);
  if (!b) return;
  session.setOwnerSpeaker(b.speakerLabel);
  res.json({ ok: true });
});

app.post("/api/utterance/reattribute", async (req, res) => {
  const b = body(ReattributeRequest, req, res);
  if (!b) return;
  const u = await session.reattribute(b.utteranceId, b.asOwner);
  res.status(u ? 200 : 404).json(u ?? { error: "no such utterance in this session" });
});

app.post("/api/identity/suggestion", async (req, res) => {
  const b = body(SuggestionRequest, req, res);
  if (!b) return;
  await session.resolveSuggestion(b.connectionId, b.speakerLabel, b.accept);
  res.json({ ok: true });
});

app.use("/api/voice", voiceRoutes(voice));
app.use("/api/recordings", recordingRoutes(new RecordingStore(resolve(root, "data/recordings"))));

app.post("/api/session/stop", async (_req, res) => {
  relay?.stop();
  session.setSpeechConnection(null);
  await session.reset({ wipe: false });
  res.json({ ok: true });
});

app.post("/api/session/reset", async (req, res) => {
  await session.reset({ wipe: true, everything: req.body?.everything === true });
  res.json({ ok: true });
});

app.post("/api/speech", async (req, res) => {
  const b = body(SpeechRequest, req, res);
  if (!b) return;
  const speech = session.speechFor(b.responseId);
  if (!speech) return void res.status(410).json({ error: "stale or unknown response" });
  if (!cartesiaConfigured()) return void res.status(503).json({ error: "Cartesia not configured" });
  try {
    startSynthesis(b.responseId, speech.text, speech.tone);
    const { audio, contentType } = await clips.get(b.responseId)!;
    clips.delete(b.responseId);
    // Re-check: a Reset during synthesis must not let this play.
    if (!session.speechText(b.responseId)) return void res.status(410).json({ error: "stale response" });
    res.setHeader("Content-Type", contentType).send(audio);
  } catch (err) {
    session.playback(b.responseId, "ended");
    res.status(502).json({ error: err instanceof Error ? err.message : "TTS failed" });
  }
});

app.post("/api/speech/test", (_req, res) => {
  if (!cartesiaConfigured()) return void res.status(503).json({ error: "Cartesia not configured" });
  const responseId = session.say(`Testing, testing. ${OWNER_NAME}, I'm alive and mildly annoyed about it.`);
  res.json({ responseId });
});

app.post("/api/playback", (req, res) => {
  const b = body(PlaybackRequest, req, res);
  if (!b) return;
  if (b.phase === "started") {
    const line = latency.playbackStarted(b.responseId, Date.now());
    if (line) console.log(line);
  }
  session.playback(b.responseId, b.phase);
  res.json({ ok: true });
});

const server = createServer(app);

// One live mic at a time; a new Start replaces the old stream (and its speaker labels).
let relay: AudioRelay | null = null;

// Events go out as JSON text; the browser sends JSON control messages and binary mono PCM16 audio.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://localhost");
  if (url.pathname !== "/api/audio") return; // leave other upgrades (Vite HMR) alone
  if (!tokenMatches(token, url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    let mine: AudioRelay | null = null;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return void mine?.audio(data as Buffer);
      let msg: { type?: string; encoding?: string; sampleRate?: number };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const fail = (message: string) => ws.send(JSON.stringify({ type: "error", message, recoverable: true } satisfies ServerEvent));
      if (msg.type === "mic.start") {
        if (!deepgramConfigured()) return void fail("Deepgram not configured (DEEPGRAM_API_KEY).");
        const rate = msg.sampleRate;
        if (msg.encoding !== "linear16" || !Number.isInteger(rate) || rate! < 8000 || rate! > 96000) {
          return void fail("Unsupported mic format; reload the page.");
        }
        relay?.stop();
        mine = relay = new AudioRelay(
          session,
          emit,
          (ended) => {
            if (relay === ended) relay = null;
            if (mine === ended) mine = null;
          },
          rate!,
          voice,
        );
      } else if (msg.type === "mic.stop") {
        mine?.stop();
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      mine?.stop(); // a closed tab must not leave the mic stream "live"
    });
    void session.snapshot().then((snapshot) => ws.send(JSON.stringify({ type: "snapshot", snapshot } satisfies ServerEvent)));
  });
});

if (isProd) {
  app.use(express.static(resolve(root, "dist")));
  app.get("/{*splat}", (_req, res) => res.sendFile(resolve(root, "dist/index.html")));
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({ root, server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  app.use(vite.middlewares);
}

server.listen(PORT, HOST, () => {
  const h = health();
  console.log(`\n  Imp running → http://localhost:${PORT}/#token=${token}`);
  console.log(`  storage: local JSON (authoritative) · index: Moss ${h.providers.moss ? "configured" : "NOT configured"}`);
  console.log(`  providers: ${Object.entries(h.providers).map(([k, v]) => `${k}=${v ? "ok" : "missing"}`).join(" ")}`);
  console.log(`  model: ${h.model}`);
  console.log(`  owner voice: ${h.voice.enrolled ? "enrolled (loading model…)" : "not enrolled — enroll from the UI"}\n`);
});
