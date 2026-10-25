import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type {
  Alert,
  Memory,
  Person,
  QuestionEvent,
  Tone,
  Utterance,
} from "../shared/schemas";

// Authoritative persistence for people, transcripts, and memories. Moss only indexes memories.
export interface MemoryStore {
  readonly kind: "local-json";
  listPeople(): Promise<Person[]>;
  createPerson(p: { name: string; relationship: string | null; tone: Tone; toneNote?: string | null; priority: boolean }): Promise<Person>;
  updatePerson(id: string, patch: Partial<Pick<Person, "name" | "relationship" | "tone" | "toneNote" | "priority">>): Promise<Person | null>;

  listActiveMemories(now: number, limit?: number): Promise<Memory[]>;
  listAllMemories(): Promise<Memory[]>;
  addMemory(m: Omit<Memory, "id" | "timesAsked" | "supersededBy">, supersedesId: string | null): Promise<Memory>;
  incrementTimesAsked(ids: string[]): Promise<void>;

  /** Returns null if (connectionId, providerEventId) was already stored. */
  addUtterance(u: Omit<Utterance, "id">): Promise<Utterance | null>;
  setUtterancePerson(ids: string[], personId: string): Promise<void>;
  updateUtterance(
    id: string,
    patch: Partial<Pick<Utterance, "isOwner" | "personId" | "ownerSuspect" | "ownerCertain" | "ownerBasis">>,
  ): Promise<Utterance | null>;
  recentUtterances(sessionId: string, limit: number): Promise<Utterance[]>;

  /** Returns null if a question event for this utterance already exists. */
  addQuestionEvent(e: Omit<QuestionEvent, "id" | "createdAt">): Promise<QuestionEvent | null>;
  listQuestionEvents(): Promise<QuestionEvent[]>;

  addAlert(a: Omit<Alert, "id" | "createdAt" | "acknowledgedAt">): Promise<Alert>;
  acknowledgeAlert(id: string): Promise<void>;
  listAlerts(): Promise<Alert[]>;

  /** Wipes conversation data for a known demo state. People survive unless `everything`. */
  reset(everything: boolean): Promise<void>;
}

interface JsonData {
  people: Person[];
  memories: Memory[];
  utterances: Utterance[];
  questionEvents: QuestionEvent[];
  alerts: Alert[];
}

const empty = (): JsonData => ({ people: [], memories: [], utterances: [], questionEvents: [], alerts: [] });

/** Server-side JSON file, written atomically. The source of truth. */
export class JsonMemoryStore implements MemoryStore {
  readonly kind = "local-json" as const;
  private data: JsonData;

  constructor(private readonly path: string | null) {
    this.data = path && existsSync(path) ? { ...empty(), ...JSON.parse(readFileSync(path, "utf8")) } : empty();
    // Records from before speaker ID: owner turns then came from typed input or a calibrated label.
    this.data.utterances = this.data.utterances.map((u) => ({
      ...u,
      ownerCertain: u.ownerCertain ?? u.isOwner,
      ownerBasis: u.ownerBasis ?? (u.isOwner ? (u.source === "typed" ? "typed" : "label") : "none"),
      ownerScore: u.ownerScore ?? null,
    }));
  }

  private save() {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  async listPeople() {
    return [...this.data.people];
  }

  async createPerson(p: { name: string; relationship: string | null; tone: Tone; toneNote?: string | null; priority: boolean }) {
    const person: Person = { id: `p_${randomUUID().slice(0, 8)}`, ...p, ownerConfiguredAt: Date.now() };
    this.data.people.push(person);
    this.save();
    return person;
  }

  async updatePerson(id: string, patch: Partial<Pick<Person, "name" | "relationship" | "tone" | "toneNote" | "priority">>) {
    const person = this.data.people.find((p) => p.id === id);
    if (!person) return null;
    Object.assign(person, patch, { ownerConfiguredAt: Date.now() });
    this.save();
    return { ...person };
  }

  async listActiveMemories(now: number, limit = 50) {
    return this.data.memories
      .filter((m) => !m.supersededBy && (m.validUntil === null || m.validUntil > now))
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, limit);
  }

  async listAllMemories() {
    return [...this.data.memories];
  }

  async addMemory(m: Omit<Memory, "id" | "timesAsked" | "supersededBy">, supersedesId: string | null) {
    const memory: Memory = { ...m, id: `m_${randomUUID().slice(0, 8)}`, timesAsked: 0, supersededBy: null };
    if (supersedesId) {
      const old = this.data.memories.find((x) => x.id === supersedesId);
      if (old) {
        old.supersededBy = memory.id;
        memory.timesAsked = old.timesAsked;
      }
    }
    this.data.memories.push(memory);
    this.save();
    return memory;
  }

  async incrementTimesAsked(ids: string[]) {
    for (const m of this.data.memories) if (ids.includes(m.id)) m.timesAsked += 1;
    this.save();
  }

  async addUtterance(u: Omit<Utterance, "id">) {
    const dup = this.data.utterances.some(
      (x) => x.connectionId === u.connectionId && x.providerEventId === u.providerEventId,
    );
    if (dup) return null;
    const utterance: Utterance = { ...u, id: `u_${randomUUID().slice(0, 8)}` };
    this.data.utterances.push(utterance);
    this.save();
    return utterance;
  }

  async setUtterancePerson(ids: string[], personId: string) {
    for (const u of this.data.utterances) if (ids.includes(u.id)) u.personId = personId;
    this.save();
  }

  async updateUtterance(
    id: string,
    patch: Partial<Pick<Utterance, "isOwner" | "personId" | "ownerSuspect" | "ownerCertain" | "ownerBasis">>,
  ) {
    const u = this.data.utterances.find((x) => x.id === id);
    if (!u) return null;
    Object.assign(u, patch);
    this.save();
    return { ...u };
  }

  async recentUtterances(sessionId: string, limit: number) {
    return this.data.utterances.filter((u) => u.sessionId === sessionId).slice(-limit);
  }

  async addQuestionEvent(e: Omit<QuestionEvent, "id" | "createdAt">) {
    if (this.data.questionEvents.some((x) => x.utteranceId === e.utteranceId)) return null;
    const ev: QuestionEvent = { ...e, id: `q_${randomUUID().slice(0, 8)}`, createdAt: Date.now() };
    this.data.questionEvents.push(ev);
    this.save();
    return ev;
  }

  async listQuestionEvents() {
    return [...this.data.questionEvents];
  }

  async addAlert(a: Omit<Alert, "id" | "createdAt" | "acknowledgedAt">) {
    const alert: Alert = { ...a, id: `a_${randomUUID().slice(0, 8)}`, createdAt: Date.now(), acknowledgedAt: null };
    this.data.alerts.push(alert);
    this.save();
    return alert;
  }

  async acknowledgeAlert(id: string) {
    const a = this.data.alerts.find((x) => x.id === id);
    if (a && !a.acknowledgedAt) a.acknowledgedAt = Date.now();
    this.save();
  }

  async listAlerts() {
    return [...this.data.alerts];
  }

  async reset(everything: boolean) {
    this.data = { ...empty(), people: everything ? [] : this.data.people };
    this.save();
  }
}
