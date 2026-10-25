import { randomUUID } from "node:crypto";
import type { MemoryStore } from "./memory";
import type { Decider, DecisionContext } from "./decision";
import { validateDecision, type Effect } from "./executor";
import { resolveOwner, type ActiveVoiceProfile } from "./voice/resolver";
import { stripNames } from "./anonymize";
import type { ImpState, IndexStatus, ServerEvent, Snapshot, VoiceStatus } from "../shared/events";
import type { Memory, Person, Tone, Utterance } from "../shared/schemas";

export const TYPED_CONNECTION = "typed";
const RECENT_TURNS = 20;
const SEARCH_TOP_K = 8;
const FALLBACK_MEMORIES = 50;
/**
 * Turns are decided one at a time and each decision takes ~1.5-3 s, so steady chatter builds a queue
 * and every reply lands later than the last. A visitor turn that has already waited this long is
 * skipped: a late answer to an old question is worse than none. Owner turns are never skipped.
 */
const MAX_QUEUE_WAIT_MS = 4000;

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
  /** Speech only: this turn's audio scored against the owner profile (null = not scored). */
  ownerScore?: number | null;
  durationSec?: number | null;
  /**
   * Speech only, when the transcription provider was given the owner's voiceprint (Speechmatics):
   * whether it labeled this turn as the owner. null = the provider doesn't identify the owner.
   */
  providerOwner?: boolean | null;
  /**
   * The relay already removed the imp's own words by capture time. Such turns must not be dropped for
   * merely *arriving* during playback: with a slow transcription provider, a visitor's question can be
   * finalized while the imp is already answering the previous one.
   */
  echoFiltered?: boolean;
}

interface PendingResponse {
  text: string;
  tone: Tone;
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
  /** Usable owner voice profile, or null (not enrolled / model not ready): fall back to calibration. */
  voiceProfile?: () => ActiveVoiceProfile | null;
  voiceStatus?: () => VoiceStatus;
}

const NO_VOICE: VoiceStatus = {
  enrolled: false,
  active: false,
  model: "idle",
  error: null,
  engine: "",
  createdAt: null,
  thresholds: null,
  minScorableSec: null,
  calibration: null,
  enrolling: false,
};

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
  // binding key -> person a visitor named themself as; shown for one-click confirmation, never auto-applied
  private suggestions = new Map<string, { personId: string; name: string }>();
  // speaker labels of voice-verified owner turns on the current speech connection (stickiness)
  private verifiedOwnerLabels: string[] = [];
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
    for (const key of [...this.suggestions.keys()]) if (!key.startsWith(`${TYPED_CONNECTION}|`)) this.suggestions.delete(key);
    this.verifiedOwnerLabels = [];
    this.speechConnectionId = connectionId;
    this.ownerSpeakerLabel = null;
    // Without a voice profile, every new connection starts by finding the owner's label.
    this.calibrating = connectionId !== null && !this.voiceProfile();
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
    this.suggestions.delete(k);
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

  private voiceProfile() {
    return this.opts.voiceProfile?.() ?? null;
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
    this.suggestions.clear();
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

  /** True while the imp has a reply queued or playing (no cooldown): its voice may be in the mic right now. */
  isSpeaking() {
    return this.speakingResponseId !== null;
  }

  /** True while the imp's own voice could be in the mic. */
  isMuted() {
    return this.speakingResponseId !== null || this.now() < this.mutedUntil;
  }

  async ingest(turn: IncomingTurn): Promise<Utterance | null> {
    const text = turn.text.trim();
    if (!text) return null;
    // Half-duplex: speech captured while the imp talks never reaches learning or answering.
    if (turn.source === "speech" && !turn.echoFiltered && this.isMuted()) return null;

    const owner = resolveOwner({
      source: turn.source,
      asOwner: turn.asOwner === true,
      profile: turn.source === "speech" ? this.voiceProfile() : null,
      score: turn.ownerScore ?? null,
      durationSec: turn.durationSec ?? null,
      speakerLabel: turn.speakerLabel,
      calibratedOwnerLabel: this.ownerSpeakerLabel,
      verifiedOwnerLabels: turn.connectionId === this.speechConnectionId ? this.verifiedOwnerLabels : [],
      providerOwner: turn.source === "speech" ? turn.providerOwner ?? null : null,
    });
    const isOwner = owner.isOwner;
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
      ownerCertain: owner.ownerCertain,
      ownerBasis: owner.basis,
      ownerScore: owner.score,
      source: turn.source,
    });
    if (!utterance) return null; // replayed provider event
    if (owner.basis === "voice" && owner.ownerCertain && turn.connectionId === this.speechConnectionId) {
      this.verifiedOwnerLabels = [...this.verifiedOwnerLabels, turn.speakerLabel].slice(-5);
    }

    const generation = this.generation;
    this.opts.emit({ type: "transcript.final", utterance, generation });
    if (turn.source === "speech" && this.calibrating && !isOwner) {
      // Calibration phrase: propose this speaker as the owner; never learn or answer from it.
      this.calibrationCandidate = turn.speakerLabel;
      await this.broadcast();
      return utterance;
    }
    void this.broadcast();
    const enqueuedAt = this.now();
    this.queue = this.queue.then(() => this.process(utterance, generation, enqueuedAt)).catch((err) => this.fail(err));
    return utterance;
  }

  /** Resolves when every queued decision has finished. */
  idle() {
    return this.queue;
  }

  private async process(utterance: Utterance, generation: number, enqueuedAt = this.now()) {
    if (generation !== this.generation) return;
    const waited = this.now() - enqueuedAt;
    if (!(utterance.isOwner && utterance.ownerCertain) && waited > MAX_QUEUE_WAIT_MS) {
      console.log(`[imp] skipped stale turn after ${(waited / 1000).toFixed(1)} s in queue: "${utterance.text.slice(0, 60)}"`);
      return;
    }
    // Filler never reaches Claude: each call is ~1-3 s and turns are single-file, so chatter
    // would otherwise delay the next real question.
    if (!needsDecision(utterance, this.pendingQuestion !== null)) {
      console.log(`[imp] skipped filler (${utterance.isOwner ? "owner" : "visitor"}): "${utterance.text.slice(0, 60)}"`);
      return;
    }
    // Latency counts from arrival, so time spent waiting behind other turns shows on screen.
    const started = enqueuedAt;
    this.setState("thinking", null);

    // An owner turn we can't confirm (borderline voice, or a short turn carried by the label) takes the
    // visitor path: it can still be answered, neutrally, but it can't teach or rename. Routing it as the
    // owner would silently drop a guest's short question whenever diarization reused the owner's label.
    const role = utterance.isOwner && utterance.ownerCertain ? "owner" : "visitor";
    const [people, recent, asked] = await Promise.all([
      this.store.listPeople(),
      this.store.recentUtterances(this.id, RECENT_TURNS),
      this.askedBy(role === "visitor" ? utterance.personId : null),
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
      identityCertain: role === "owner" ? utterance.ownerCertain : speaker !== null,
      people,
      memories,
      retrievalMode: retrieval.mode,
      recent,
      pendingQuestion: role === "owner" ? this.pendingQuestion : null,
      pendingUnknown: role === "owner" ? this.singlePendingUnknown() : null,
      askedByThisPerson: asked.counts,
      lastAskedByThisPerson: asked.lastAt,
      now: this.now(),
    };

    const decision = await this.decider(ctx);
    if (generation !== this.generation) return; // Stop/Reset happened mid-call

    // Wording veto: a voice-labeled "owner" turn that speaks TO the owner probably isn't the owner.
    // It may not teach or rename anything; the transcript offers a one-click correction instead.
    // A manual "that was me" always wins (§2.5), so it is never re-vetoed on the re-run.
    const suspect =
      role === "owner" && utterance.source === "speech" && utterance.ownerBasis !== "manual" && decision.speakerCheck.addressesOwner;
    if (suspect) {
      utterance.ownerSuspect = true;
      await this.store.updateUtterance(utterance.id, { ownerSuspect: true });
      if (utterance.ownerBasis === "voice") {
        // A voice-accepted turn the wording vetoes must not make its label sticky for later short turns.
        const i = this.verifiedOwnerLabels.lastIndexOf(utterance.speakerLabel);
        if (i >= 0) this.verifiedOwnerLabels.splice(i, 1);
      }
    }
    await this.noteSelfIdentification(utterance, decision.speakerCheck.selfIdentifiedAs, people);

    const effect = validateDecision(suspect ? { ...decision, action: "WAIT", spokenText: null } : decision, {
      role,
      ownerCertain: utterance.isOwner && utterance.ownerCertain,
      utteranceId: utterance.id,
      speakerPersonId: utterance.personId,
      ownerPersonId: null,
      activeMemories: memories,
      knownUtteranceIds: new Set(recent.map((u) => u.id)),
      focusMode: this.focusMode,
      now: this.now(),
    });
    const line = await this.apply(effect, utterance, generation);
    if (generation !== this.generation) return;
    // Everyone stays anonymous aloud. Re-read people: apply() may have just added one.
    const others = line ? (await this.store.listPeople()).map((p) => p.name) : [];
    const spoken = line && stripNames(line, { owner: this.opts.ownerName, others });

    const tone: Tone = ctx.identityCertain && role === "visitor" ? speaker?.tone ?? "neutral" : "neutral";
    const responseId = spoken ? this.queueSpeech(spoken, generation, tone) : null;
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
        note: effect.kind === "alert" ? effect.reason : effect.kind === "wait" ? effect.blocked ?? null : null,
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
          createdAt: this.now(),
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
          createdAt: this.now(),
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
        return effect.spokenText ?? "Hang on, flagging that for the owner.";
      }
      case "wait": {
        if (u.isOwner) return effect.spokenText;
        if (effect.isQuestion) {
          await this.store.addQuestionEvent({
            sessionId: this.id,
            createdAt: this.now(),
            utteranceId: u.id,
            personId: u.personId,
            memoryId: null,
            classification: effect.spokenText ? "deflected" : "new",
          });
          // Unanswered question: the owner's next reply may answer it.
          this.pendingQuestion = u;
          if (!effect.spokenText) this.setState(this.listening ? "listening" : "idle", "Hmm. Waiting on an answer for that one.");
          // Never offer the owner's own label for "That was Bob…" binding.
          if (!u.personId && !u.isOwner) this.pendingUnknown.set(key(u.connectionId, u.speakerLabel), u);
        }
        return effect.spokenText;
      }
      case "learn": {
        await this.addMemory(effect.memory, effect.supersedesId);
        const answered = this.pendingQuestion;
        this.pendingQuestion = null;
        // Speakers stay anonymous: never ask who someone is. The owner can still volunteer it.
        void answered;
        return null;
      }
      case "update_person": {
        const people = await this.store.listPeople();
        let person: Person | null =
          people.find((p) => p.name.toLowerCase() === effect.name.toLowerCase()) ?? null;
        const patch = {
          relationship: effect.relationship ?? person?.relationship ?? null,
          tone: (effect.tone ?? person?.tone ?? "neutral") as Tone,
          toneNote: effect.toneNote ?? person?.toneNote ?? null,
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
        return effect.spokenText ?? "Noted.";
      }
    }
  }

  // ---------- identity corrections ----------

  private async noteSelfIdentification(u: Utterance, name: string | null, people: Person[]) {
    if (!name || u.isOwner || u.personId) return;
    const person = people.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    if (!person) return;
    this.suggestions.set(key(u.connectionId, u.speakerLabel), { personId: person.id, name: person.name });
  }

  async resolveSuggestion(connectionId: string, label: string, accept: boolean) {
    const k = key(connectionId, label);
    const s = this.suggestions.get(k);
    this.suggestions.delete(k);
    if (s && accept) await this.bindSpeaker(connectionId, label, s.personId);
    else await this.broadcast();
  }

  /**
   * Explicit owner UI correction: "that was me" / "not me". Re-runs the turn with the right role.
   * This is the only path besides calibration/verification by which a speech turn becomes the owner's,
   * and the only way an uncertain owner turn (borderline voice, short turn) gets learned from.
   */
  async reattribute(utteranceId: string, asOwner: boolean) {
    const u = (await this.store.recentUtterances(this.id, 500)).find((x) => x.id === utteranceId);
    if (!u) return null;
    if (u.ownerBasis === "manual" && u.isOwner === asOwner) return u; // already corrected this way
    const personId = asOwner ? null : this.personFor(u.connectionId, u.speakerLabel);
    const updated = await this.store.updateUtterance(u.id, {
      isOwner: asOwner,
      ownerCertain: asOwner,
      ownerBasis: "manual",
      ownerSuspect: false,
      personId,
    });
    if (!updated) return null;
    if (asOwner) {
      if (this.pendingQuestion?.id === u.id) this.pendingQuestion = null;
      const k = key(u.connectionId, u.speakerLabel);
      if (this.pendingUnknown.get(k)?.id === u.id) this.pendingUnknown.delete(k);
    }
    const generation = this.generation;
    await this.broadcast();
    this.queue = this.queue.then(() => this.process(updated, generation)).catch((err) => this.fail(err));
    return updated;
  }

  // ---------- memory + index ----------

  /**
   * Moss finds candidates; the local store decides what they are. Hits that no longer resolve to an
   * active record (superseded, expired, deleted) are dropped, so a stale index can't resurrect a fact.
   */
  /**
   * memoryId -> how many of this person's earlier questions it answered, and when they last asked,
   * carried forward through corrections.
   */
  private async askedBy(personId: string | null): Promise<{ counts: Record<string, number>; lastAt: Record<string, number> }> {
    if (!personId) return { counts: {}, lastAt: {} };
    const [events, all] = await Promise.all([this.store.listQuestionEvents(), this.store.listAllMemories()]);
    const supersededBy = new Map(all.map((m) => [m.id, m.supersededBy]));
    const counts: Record<string, number> = {};
    const lastAt: Record<string, number> = {};
    for (const e of events) {
      if (e.personId !== personId || !e.memoryId) continue;
      let id = e.memoryId;
      for (let next = supersededBy.get(id); next; next = supersededBy.get(id)) id = next;
      counts[id] = (counts[id] ?? 0) + 1;
      lastAt[id] = Math.max(lastAt[id] ?? 0, e.createdAt);
    }
    return { counts, lastAt };
  }

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

  /** Speaks fixed text through the normal speech path (used by the Test voice control). */
  say(text: string) {
    return this.queueSpeech(text, this.generation, "sarcastic");
  }

  private queueSpeech(text: string, generation: number, tone: Tone) {
    const responseId = randomUUID();
    this.responses.set(responseId, { text, tone, generation, createdAt: this.now() });
    // Block mic input from the moment audio is requested, not just once it plays.
    this.speakingResponseId = responseId;
    const guard = this.opts.speechGuardMs ?? 15_000;
    setTimeout(() => {
      if (this.speakingResponseId === responseId) this.speakingResponseId = null;
    }, guard).unref?.();
    this.opts.emit({ type: "speech.ready", responseId, text, tone, generation });
    return responseId;
  }

  /** Text for a checked, current response, or null if stale/unknown. */
  speechText(responseId: string): string | null {
    return this.speechFor(responseId)?.text ?? null;
  }

  speechFor(responseId: string): { text: string; tone: Tone } | null {
    const r = this.responses.get(responseId);
    if (!r || r.generation !== this.generation) return null;
    return { text: r.text, tone: r.tone };
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
        suggestions: [...this.suggestions].map(([k, v]) => {
          const [connectionId = "", speakerLabel = ""] = k.split("|");
          return { connectionId, speakerLabel, ...v };
        }),
        speechLabels,
        voice: this.opts.voiceStatus?.() ?? NO_VOICE,
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

const QUESTION_START =
  /^(who|what|when|where|why|how|which|is|are|was|were|did|do|does|can|could|will|would|should|shall|have|has|had|may|might|any|anyone)\b/i;
const REQUEST = /\b(can you|could you|would you|tell me|do you know|approve|authori[sz]e|deploy|roll ?back|merge|confirm|sign off|ship it)\b/i;
// case-sensitive on purpose: a capitalized word after "it's" is likely a name ("It's Bob")
const SELF_INTRO = /\b(?:[Ii]t'?s|[Tt]his is|I'?m|I am)\s+[A-Z]/;
const OWNER_CUE =
  /\b(that was|this is|is my|be (nice|mean|sarcastic|nicer|meaner)|roast|tease|tone|priority|annoyed|pissed|stupid|sucks|done with|remember|heads up|fyi|note that)\b/i;

/** Cheap pre-filter: does this turn need a decision call at all? Errs toward yes. */
export function needsDecision(u: Utterance, questionPending: boolean): boolean {
  const text = u.text.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (u.source === "typed") return true; // typed input is deliberate
  // Question-shaped turns always go through, whoever they're labeled as: labels are unreliable,
  // and a "visitor" question mislabeled as the owner must still be heard.
  if (text.includes("?") || QUESTION_START.test(text) || REQUEST.test(text) || SELF_INTRO.test(text)) return true;
  return u.isOwner && (questionPending || words >= 5 || OWNER_CUE.test(text));
}

const effectAction = (e: Effect) =>
  ({ answer: "ANSWER", alert: "ALERT_OWNER", wait: "WAIT", learn: "LEARN", update_person: "UPDATE_PERSON" })[e.kind];
