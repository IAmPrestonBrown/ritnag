import { randomUUID } from "node:crypto";
import type { MemoryStore } from "./memory";
import type { Decider, DecisionContext } from "./decision";
import { validateDecision, type Effect } from "./executor";
import type { ImpState, IndexStatus, ServerEvent, Snapshot } from "../shared/events";
import type { Memory, Person, Tone, Utterance } from "../shared/schemas";

export const TYPED_CONNECTION = "typed";
const RECENT_TURNS = 20;
const SEARCH_TOP_K = 8;
const FALLBACK_MEMORIES = 50;

/** Searchable index over memories (Moss in production). Never authoritative. */
export interface MemoryIndex {
  search(query: string, topK?: number): Promise<{ id: string; score: number }[] | null>;
  upsert(m: Memory): Promise<boolean>;
  remove(ids: string[]): Promise<void>;
  rebuild(memories: Memory[]): Promise<boolean>;
  getStatus(): IndexStatus;
}

export interface IncomingTurn {
  text: string;
  speakerLabel: string;
  connectionId: string;
  providerEventId: string;
  source: "typed" | "speech";
  asOwner?: boolean;
  startedAt?: number;
  endedAt?: number;
}

interface PendingResponse {
  text: string;
  generation: number;
  createdAt: number;
}

export interface SessionOptions {
  ownerName: string;
  emit: (e: ServerEvent) => void;
  now?: () => number;
  playbackCooldownMs?: number;
  /** Max time a speech response blocks the mic if the browser never reports playback end. */
  speechGuardMs?: number;
}

/**
 * Owns one listening session: speaker bindings, the single-flight decision queue,
 * generation guards, and half-duplex speech gating. Persistent records live in the store.
 */
export class Session {
  id = randomUUID();
  generation = 1;
  focusMode = false;
  listening = false;
  speechConnectionId: string | null = null;
  ownerSpeakerLabel: string | null = null;
  /** Owner calibration: the next speech turn proposes a label; the owner confirms it in the UI. */
  calibrating = false;
  calibrationCandidate: string | null = null;

  // `${connectionId}|${speakerLabel}` -> personId. Never persisted.
  private bindings = new Map<string, string>();
  private pendingQuestion: Utterance | null = null;
  // unidentified visitor turns awaiting "That was Bob..."; keyed by binding key
  private pendingUnknown = new Map<string, Utterance>();
  private queue: Promise<void> = Promise.resolve();
  private responses = new Map<string, PendingResponse>();
  private speakingResponseId: string | null = null;
  private mutedUntil = 0;
  private state: ImpState = "idle";
  private readonly now: () => number;

  constructor(
    private readonly store: MemoryStore,
    private readonly decider: Decider,
    private readonly index: MemoryIndex,
    private readonly opts: SessionOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ---------- connection + identity ----------

  /** A new STT connection invalidates every voice-label binding from the old one. */
  setSpeechConnection(connectionId: string | null) {
    for (const key of [...this.bindings.keys()]) if (!key.startsWith(`${TYPED_CONNECTION}|`)) this.bindings.delete(key);
    for (const key of [...this.pendingUnknown.keys()]) if (!key.startsWith(`${TYPED_CONNECTION}|`)) this.pendingUnknown.delete(key);
    this.speechConnectionId = connectionId;
    this.ownerSpeakerLabel = null;
    this.calibrating = connectionId !== null; // every new connection starts by finding the owner
    this.calibrationCandidate = null;
    this.listening = connectionId !== null;
    this.setState(this.listening ? "listening" : "idle", null);
    void this.broadcast();
  }

  startCalibration() {
    this.calibrating = true;
    this.calibrationCandidate = null;
    void this.broadcast();
  }

  setOwnerSpeaker(label: string | null) {
    this.ownerSpeakerLabel = label;
    this.calibrating = false;
    this.calibrationCandidate = null;
    if (label) this.bindings.delete(key(this.speechConnectionId ?? "", label));
    if (label && this.speechConnectionId) this.pendingUnknown.delete(key(this.speechConnectionId, label));
    void this.broadcast();
  }

  personFor(connectionId: string, label: string) {
    return this.bindings.get(key(connectionId, label)) ?? null;
  }

  async bindSpeaker(connectionId: string, label: string, personId: string | null) {
    const k = key(connectionId, label);
    if (personId) this.bindings.set(k, personId);
    else this.bindings.delete(k);
    this.pendingUnknown.delete(k);
    if (personId) {
      const ids = (await this.store.recentUtterances(this.id, 200))
        .filter((u) => u.connectionId === connectionId && u.speakerLabel === label && !u.isOwner)
        .map((u) => u.id);
      await this.store.setUtterancePerson(ids, personId);
      if (this.pendingQuestion && ids.includes(this.pendingQuestion.id)) this.pendingQuestion.personId = personId;
    }
    this.opts.emit({ type: "speaker.bound", speakerLabel: label, personId, generation: this.generation });
    await this.broadcast();
  }

  setFocus(on: boolean) {
    this.focusMode = on;
    void this.broadcast();
  }

  // ---------- lifecycle ----------

  /** Stop/Reset: bump the generation so in-flight decisions and audio are discarded. */
  async reset(opts: { wipe: boolean; everything?: boolean }) {
    this.generation += 1;
    this.responses.clear();
    this.speakingResponseId = null;
    this.mutedUntil = 0;
    this.pendingQuestion = null;
    this.pendingUnknown.clear();
    if (opts.wipe) {
      this.bindings.clear();
      this.id = randomUUID();
      await this.store.reset(opts.everything ?? false);
      await this.rebuildIndex();
    }
    this.setState(this.listening ? "listening" : "idle", null);
    await this.broadcast();
  }

  // ---------- turns ----------

  /** True while the imp's own voice could be in the mic. */
  isMuted() {
    return this.speakingResponseId !== null || this.now() < this.mutedUntil;
  }

  async ingest(turn: IncomingTurn): Promise<Utterance | null> {
    const text = turn.text.trim();
    if (!text) return null;
    // Half-duplex: speech captured while the imp talks never reaches learning or answering.
    if (turn.source === "speech" && this.isMuted()) return null;

    const isOwner =
      turn.asOwner === true || (turn.source === "speech" && this.ownerSpeakerLabel !== null && turn.speakerLabel === this.ownerSpeakerLabel);
    const now = this.now();
    const utterance = await this.store.addUtterance({
      sessionId: this.id,
      connectionId: turn.connectionId,
      providerEventId: turn.providerEventId,
      speakerLabel: turn.speakerLabel,
      personId: isOwner ? null : this.personFor(turn.connectionId, turn.speakerLabel),
      text,
      startedAt: turn.startedAt ?? now,
      endedAt: turn.endedAt ?? now,
      isOwner,
      source: turn.source,
    });
    if (!utterance) return null; // replayed provider event

    const generation = this.generation;
    this.opts.emit({ type: "transcript.final", utterance, generation });
    if (turn.source === "speech" && this.calibrating && !isOwner) {
      // Calibration phrase: propose this speaker as the owner; never learn or answer from it.
      this.calibrationCandidate = turn.speakerLabel;
      await this.broadcast();
      return utterance;
    }
    void this.broadcast();
    this.queue = this.queue.then(() => this.process(utterance, generation)).catch((err) => this.fail(err));
    return utterance;
  }

  /** Resolves when every queued decision has finished. */
  idle() {
    return this.queue;
  }

  private async process(utterance: Utterance, generation: number) {
    if (generation !== this.generation) return;
    const started = this.now();
    this.setState("thinking", null);

    const role = utterance.isOwner ? "owner" : "visitor";
    const [people, recent] = await Promise.all([
      this.store.listPeople(),
      this.store.recentUtterances(this.id, RECENT_TURNS),
    ]);
    const query = role === "owner" && this.pendingQuestion ? `${this.pendingQuestion.text}\n${utterance.text}` : utterance.text;
    const retrieval = await this.retrieve(query);
    const memories = retrieval.memories;
    const speaker = utterance.personId ? people.find((p) => p.id === utterance.personId) ?? null : null;
    const ctx: DecisionContext = {
      role,
      ownerName: this.opts.ownerName,
      focusMode: this.focusMode,
      utterance,
      speaker,
      identityCertain: role === "owner" || speaker !== null,
      people,
      memories,
      retrievalMode: retrieval.mode,
      recent,
      pendingQuestion: role === "owner" ? this.pendingQuestion : null,
      pendingUnknown: role === "owner" ? this.singlePendingUnknown() : null,
    };

    const decision = await this.decider(ctx);
    if (generation !== this.generation) return; // Stop/Reset happened mid-call

    const effect = validateDecision(decision, {
      role,
      utteranceId: utterance.id,
      speakerPersonId: utterance.personId,
      ownerPersonId: null,
      activeMemories: memories,
      knownUtteranceIds: new Set(recent.map((u) => u.id)),
      now: this.now(),
    });
    const spoken = await this.apply(effect, utterance, generation);
    if (generation !== this.generation) return;

    const responseId = spoken ? this.queueSpeech(spoken, generation) : null;
    this.opts.emit({
      type: "decision.completed",
      generation,
      decision: {
        turnId: utterance.id,
        action: effectAction(effect),
        personId: utterance.personId,
        memoryIds: effect.kind === "answer" ? effect.memoryIds : [],
        spokenText: spoken,
        responseId,
        latencyMs: this.now() - started,
        note: effect.kind === "alert" ? effect.reason : null,
        retrieval: { mode: retrieval.mode, hits: retrieval.hits },
      },
    });
    if (!responseId && this.state === "thinking") this.setState(this.listening ? "listening" : "idle", null);
    await this.broadcast();
  }

  private async apply(effect: Effect, u: Utterance, generation: number): Promise<string | null> {
    const ownerName = this.opts.ownerName;
    switch (effect.kind) {
      case "answer": {
        await this.store.incrementTimesAsked(effect.memoryIds);
        await this.store.addQuestionEvent({
          sessionId: this.id,
          utteranceId: u.id,
          personId: u.personId,
          memoryId: effect.memoryIds[0] ?? null,
          classification: "repeat",
        });
        return effect.spokenText;
      }
      case "alert": {
        await this.store.addQuestionEvent({
          sessionId: this.id,
          utteranceId: u.id,
          personId: u.personId,
          memoryId: null,
          classification: "alert",
        });
        const alert = await this.store.addAlert({
          sessionId: this.id,
          personId: u.personId,
          questionUtteranceId: u.id,
          reason: effect.reason,
        });
        if (generation !== this.generation) return null;
        this.opts.emit({ type: "alert.created", alert, generation });
        this.setState("alert", effect.reason);
        return effect.spokenText ?? `Hang on, I'm getting ${ownerName}.`;
      }
      case "wait": {
        if (u.isOwner) return effect.spokenText;
        if (effect.isQuestion) {
          await this.store.addQuestionEvent({
            sessionId: this.id,
            utteranceId: u.id,
            personId: u.personId,
            memoryId: null,
            classification: effect.spokenText ? "deflected" : "new",
          });
          // Unanswered question: the owner's next reply may answer it.
          this.pendingQuestion = u;
          if (!u.personId) this.pendingUnknown.set(key(u.connectionId, u.speakerLabel), u);
        }
        return effect.spokenText;
      }
      case "learn": {
        await this.addMemory(effect.memory, effect.supersedesId);
        const answered = this.pendingQuestion;
        this.pendingQuestion = null;
        // Ask who it was only once the exchange settles, and only for an unidentified asker.
        if (answered && !answered.personId && this.pendingUnknown.has(key(answered.connectionId, answered.speakerLabel))) {
          return "Got it. And who was that?";
        }
        return null;
      }
      case "update_person": {
        const people = await this.store.listPeople();
        let person: Person | null =
          people.find((p) => p.name.toLowerCase() === effect.name.toLowerCase()) ?? null;
        const patch = {
          relationship: effect.relationship ?? person?.relationship ?? null,
          tone: (effect.tone ?? person?.tone ?? "neutral") as Tone,
          priority: effect.priority ?? person?.priority ?? false,
        };
        person = person
          ? await this.store.updatePerson(person.id, patch)
          : await this.store.createPerson({ name: effect.name, ...patch });
        if (!person) return null;

        if (effect.refersTo === "pending_unknown") {
          const target = this.singlePendingUnknown();
          if (!target && this.pendingUnknown.size > 1) {
            return "Which one? Pick them in the speaker list.";
          }
          if (target) await this.bindSpeaker(target.connectionId, target.speakerLabel, person.id);
        }
        return effect.spokenText ?? `Noted. ${person.name}.`;
      }
    }
  }

  // ---------- memory + index ----------

  /**
   * Moss finds candidates; the local store decides what they are. Hits that no longer resolve to an
   * active record (superseded, expired, deleted) are dropped, so a stale index can't resurrect a fact.
   */
  private async retrieve(query: string) {
    const active = await this.store.listActiveMemories(this.now(), 500);
    const hits = await this.index.search(query, SEARCH_TOP_K);
    if (hits === null) {
      return {
        mode: "unavailable" as const,
        hits: [],
        memories: active.slice(0, FALLBACK_MEMORIES).map((m) => ({ ...m, score: null })),
      };
    }
    const byId = new Map(active.map((m) => [m.id, m]));
    const memories = hits.flatMap((h) => {
      const m = byId.get(h.id);
      return m ? [{ ...m, score: h.score }] : [];
    });
    return { mode: "moss" as const, hits, memories };
  }

  /** Local write first (source of truth), then index. Index failures surface in status, not as lost data. */
  async addMemory(m: Omit<Memory, "id" | "timesAsked" | "supersededBy">, supersedesId: string | null) {
    const memory = await this.store.addMemory(m, supersedesId);
    await this.index.upsert(memory);
    if (supersedesId) await this.index.remove([supersedesId]);
    await this.broadcast();
    return memory;
  }

  async rebuildIndex() {
    const ok = await this.index.rebuild(await this.store.listActiveMemories(this.now(), 10_000));
    await this.broadcast();
    return ok;
  }

  private singlePendingUnknown(): Utterance | null {
    if (this.pendingUnknown.size !== 1) return null;
    return [...this.pendingUnknown.values()][0] ?? null;
  }

  // ---------- speech gating ----------

  private queueSpeech(text: string, generation: number) {
    const responseId = randomUUID();
    this.responses.set(responseId, { text, generation, createdAt: this.now() });
    // Block mic input from the moment audio is requested, not just once it plays.
    this.speakingResponseId = responseId;
    const guard = this.opts.speechGuardMs ?? 15_000;
    setTimeout(() => {
      if (this.speakingResponseId === responseId) this.speakingResponseId = null;
    }, guard).unref?.();
    this.opts.emit({ type: "speech.ready", responseId, text, generation });
    return responseId;
  }

  /** Text for a checked, current response, or null if stale/unknown. */
  speechText(responseId: string): string | null {
    const r = this.responses.get(responseId);
    if (!r || r.generation !== this.generation) return null;
    return r.text;
  }

  playback(responseId: string, phase: "started" | "ended") {
    const r = this.responses.get(responseId);
    if (!r || r.generation !== this.generation) return;
    if (phase === "started") {
      this.speakingResponseId = responseId;
      this.setState("speaking", r.text);
    } else {
      if (this.speakingResponseId === responseId) this.speakingResponseId = null;
      this.responses.delete(responseId);
      this.mutedUntil = this.now() + (this.opts.playbackCooldownMs ?? 600);
      this.setState(this.listening ? "listening" : "idle", r.text);
    }
  }

  // ---------- events ----------

  private setState(state: ImpState, caption: string | null) {
    this.state = state;
    this.opts.emit({ type: "state.changed", state, caption, generation: this.generation });
  }

  private fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[imp] decision failed:", message);
    this.setState("error", null);
    this.opts.emit({ type: "error", message, recoverable: true });
  }

  async snapshot(): Promise<Snapshot> {
    const [people, memories, events, alerts, transcript] = await Promise.all([
      this.store.listPeople(),
      this.store.listAllMemories(),
      this.store.listQuestionEvents(),
      this.store.listAlerts(),
      this.store.recentUtterances(this.id, 50),
    ]);
    const byPerson: Record<string, number> = {};
    const byMemory: Record<string, number> = {};
    let total = 0;
    for (const e of events) {
      if (e.classification !== "repeat") continue;
      total += 1;
      if (e.personId) byPerson[e.personId] = (byPerson[e.personId] ?? 0) + 1;
      if (e.memoryId) byMemory[e.memoryId] = (byMemory[e.memoryId] ?? 0) + 1;
    }
    const bindings: Record<string, string> = {};
    for (const [k, v] of this.bindings) bindings[k] = v;
    const speechLabels = [
      ...new Set(transcript.filter((u) => u.connectionId === this.speechConnectionId).map((u) => u.speakerLabel)),
    ].sort();
    return {
      storage: this.store.kind,
      index: this.index.getStatus(),
      ownerName: this.opts.ownerName,
      session: {
        id: this.id,
        generation: this.generation,
        connectionId: this.speechConnectionId,
        focusMode: this.focusMode,
        listening: this.listening,
        ownerSpeakerLabel: this.ownerSpeakerLabel,
        bindings,
        pendingUnknownSpeaker: this.singlePendingUnknown()?.speakerLabel ?? null,
        calibration: { active: this.calibrating, candidate: this.calibrationCandidate },
        speechLabels,
      },
      people,
      memories,
      counts: { total, byPerson, byMemory },
      alerts,
      transcript,
    };
  }

  async broadcast() {
    this.opts.emit({ type: "snapshot", snapshot: await this.snapshot() });
  }
}

const key = (connectionId: string, label: string) => `${connectionId}|${label}`;

const effectAction = (e: Effect) =>
  ({ answer: "ANSWER", alert: "ALERT_OWNER", wait: "WAIT", learn: "LEARN", update_person: "UPDATE_PERSON" })[e.kind];
