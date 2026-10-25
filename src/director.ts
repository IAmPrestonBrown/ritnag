import { useSyncExternalStore } from "react";
import type { ImpState, Notice, Snapshot } from "../shared/events";
import type { Alert, Memory, Person, Tone, Utterance } from "../shared/schemas";
import { DirectorCommand, Timeline, type DirectorRequest, type DirectorStatus, type TimedCommand } from "../shared/director";

/**
 * Director mode: a script drives the whole screen so a recorded demo looks live, but nothing is heard
 * or decided. Commands are defined in shared/director.ts and documented in docs/DIRECTOR.md.
 *
 * Three ways in, all the same commands:
 *   - press N to run the next cue of the text script in Settings → Director (hand-driven intro)
 *   - window.ritnag.run(...) / .play(timeline) from the page (Puppeteer, Claude in Chrome)
 *   - POST /api/director or `npm run director` (the server relays it to every open page)
 */

// ---------- text script (Settings → Director) ----------

export const DEFAULT_SCRIPT = `owner: Okay, heads down. Demo's due in an hour.

guest: Hey, what's the wifi password?
notice person: New person detected | Unknown voice · S2
notice question: New question detected | Hey, what's the wifi password?

owner: It's calhacks2026. Now let me work.

Leon: Yo, what's the wifi password?
notice name: Leon detected
think 1400
notice repeat: Answer repeated · 2× | Yo, what's the wifi password?
imp sarcastic: It's calhacks2026. He literally just said it.`;

const TONES = new Set<string>(["neutral", "friendly", "playful", "sarcastic", "annoyed", "savage", "flirty"]);
const KINDS = new Set<string>(["person", "question", "repeat", "name"]);

/** Script text → cues (paragraphs) of commands. Lines that aren't commands are skipped. Pure, for tests. */
export function parseScript(script: string): DirectorCommand[][] {
  return script
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((l) => parseLine(l.trim())).filter((c): c is DirectorCommand => c !== null))
    .filter((cue) => cue.length > 0);
}

function parseLine(line: string): DirectorCommand | null {
  if (!line || line.startsWith("#")) return null;
  if (line.startsWith("{")) {
    // any JSON command on its own line
    try {
      const r = DirectorCommand.safeParse(JSON.parse(line));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }
  const timed = /^(think|wait)\s+(\d+)$/i.exec(line);
  if (timed) return { do: timed[1]!.toLowerCase() as "think" | "wait", ms: Number(timed[2]) };
  const m = /^([^:]+):\s*(.+)$/.exec(line);
  if (!m) return null;
  const [head, rest] = [m[1]!.trim(), m[2]!.trim()];
  const parts = head.split(/\s+/);
  const first = parts[0]!.toLowerCase();
  if (first === "imp") {
    const tone = (parts[1] ?? "").toLowerCase();
    return { do: "imp", tone: (TONES.has(tone) ? tone : "sarcastic") as Tone, text: rest };
  }
  if (first === "notice") {
    const kind = (parts[1] ?? "").toLowerCase();
    if (!KINDS.has(kind)) return null;
    const [title, detail] = rest.split("|").map((s) => s.trim());
    return { do: "notice", kind: kind as Notice["kind"], title: title!, detail: detail || null };
  }
  return { do: "say", who: head, text: rest };
}

const SCRIPT_KEY = "imp.directorScript";
export function loadScript() {
  try {
    return localStorage.getItem(SCRIPT_KEY) ?? DEFAULT_SCRIPT;
  } catch {
    return DEFAULT_SCRIPT;
  }
}
export function saveScript(s: string) {
  try {
    localStorage.setItem(SCRIPT_KEY, s);
  } catch {}
}

// ---------- the stage ----------

export type Tab = "memory" | "people" | "transcript";

export interface Stage {
  /** Something ran since the last reset: the director owns the screen and live events are ignored. */
  active: boolean;
  /** Real data hidden; only scripted rows/people/memories/alerts show. */
  isolated: boolean;
  playing: boolean;
  position: number | null;
  lastEvent: number | null;
  rows: Utterance[];
  people: Person[];
  memories: Memory[];
  alerts: Alert[];
  repeats: number;
  byPerson: Record<string, number>;
  partial: { speakerLabel: string; text: string } | null;
  thinking: boolean;
  /** silent imp speech (voice:false) in progress */
  speaking: boolean;
  caption: string | null;
  receipt: string | null;
  state: ImpState | null;
  listening: boolean | null;
  focus: boolean | null;
  tab: Tab | null;
  highlight: string[];
  error: string | null;
  /** text-script cue index */
  cue: number;
}

const EMPTY: Stage = {
  active: false,
  isolated: false,
  playing: false,
  position: null,
  lastEvent: null,
  rows: [],
  people: [],
  memories: [],
  alerts: [],
  repeats: 0,
  byPerson: {},
  partial: null,
  thinking: false,
  speaking: false,
  caption: null,
  receipt: null,
  state: null,
  listening: null,
  focus: null,
  tab: null,
  highlight: [],
  error: null,
  cue: 0,
};

export interface DirectorHooks {
  notice(n: Notice): void;
  /** Real voice: ask the server to synthesize; the page plays it when speech.ready arrives. */
  speak(text: string, tone: Tone): Promise<void>;
  demo(on: boolean): void;
  chime(): void;
  status(s: DirectorStatus): void;
}

const WORD_MS = 330; // about how fast people talk
const IMP_WORD_MS = 380;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export class Director {
  stage: Stage = EMPTY;
  hooks: DirectorHooks | null = null;
  private listeners = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private sleepers = new Set<() => void>();
  /** bumps on reset/stop so in-flight streams and sleeps stop touching the stage */
  private epoch = 0;
  private seq = 0;
  private busy = false;
  private positionTimer: ReturnType<typeof setInterval> | null = null;
  /** imp lines sent to the server for real speech; only their speech.ready is played while directing */
  private expected = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getStage = () => this.stage;

  private set(patch: Partial<Stage>) {
    this.stage = { ...this.stage, active: true, ...patch };
    this.changed();
  }
  private changed() {
    for (const fn of this.listeners) fn();
    this.hooks?.status(this.status());
  }

  status(): DirectorStatus {
    const s = this.stage;
    return { active: s.active, isolated: s.isolated, playing: s.playing, position: s.position, lastEvent: s.lastEvent, rows: s.rows.length, updatedAt: this.now() };
  }

  private later(ms: number, fn: () => void) {
    const epoch = this.epoch;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (epoch === this.epoch) fn();
    }, ms);
    this.timers.add(t);
  }
  private sleep(ms: number) {
    // resolves early on stop/reset, so an awaited run() never hangs; callers check the epoch after
    return new Promise<void>((r) => {
      const wake = () => {
        clearTimeout(t);
        this.timers.delete(t);
        this.sleepers.delete(wake);
        r();
      };
      const t = setTimeout(wake, ms);
      this.timers.add(t);
      this.sleepers.add(wake);
    });
  }
  private cancelTimers() {
    this.epoch++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const wake of [...this.sleepers]) wake();
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = null;
    this.busy = false;
  }

  /** Should the page play this live speech.ready? While directing, only the director's own lines. */
  claimSpeech(text: string): boolean {
    if (!this.stage.active) return true;
    const n = this.expected.get(text);
    if (!n) return false;
    if (n > 1) this.expected.set(text, n - 1);
    else this.expected.delete(text);
    return true;
  }

  // ---------- entry points ----------

  /** Back to live (isolate:false), or to an empty scripted stage with real data hidden (isolate:true). */
  reset(isolate = false) {
    this.cancelTimers();
    this.expected.clear();
    this.stage = { ...EMPTY, active: isolate, isolated: isolate };
    this.changed();
  }

  /** Stop playback; what's on screen stays. */
  stop() {
    this.cancelTimers();
    this.set({ playing: false, position: null, partial: null, thinking: false, speaking: false });
  }

  /** Run commands in order; a `say`, `wait`, `think {ms}` or silent `imp` finishes before the next starts. */
  async run(input: unknown) {
    const list = (Array.isArray(input) ? input : [input]).map((c) => DirectorCommand.parse(c));
    let epoch = this.epoch;
    for (const c of list) {
      if (epoch !== this.epoch) return; // stopped or reset from elsewhere
      await this.exec(c);
      if (c.do === "reset") epoch = this.epoch;
    }
  }

  /** Run the next text-script cue (the N key). */
  async nextCue(script: string) {
    const cues = parseScript(script);
    const i = this.stage.cue;
    if (i >= cues.length || this.busy) return;
    this.busy = true;
    this.set({ cue: i + 1 });
    let epoch = this.epoch;
    try {
      for (const c of cues[i]!) {
        if (epoch !== this.epoch) return;
        await this.exec(c);
        if (c.do === "reset") {
          epoch = this.epoch;
          this.set({ cue: i + 1 });
        }
      }
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }

  /**
   * Play a timeline: each event fires at its `at` (ms after start). from (ms) starts mid-way: earlier
   * rows, cards and settings appear instantly; earlier pop-ups, sounds and pauses are skipped.
   */
  play(input: unknown, from = 0) {
    const tl = Timeline.parse(input);
    const events = tl.events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i);
    this.reset(tl.isolate ?? true);
    for (const { e, i } of events) if (e.at < from) this.instant(e, i);
    const start = this.now() - from;
    this.set({ playing: true, position: from });
    this.positionTimer = setInterval(() => {
      this.stage = { ...this.stage, position: this.now() - start };
      this.hooks?.status(this.status());
    }, 500);
    const pending = events.filter(({ e }) => e.at >= from);
    let left = pending.length;
    const epoch = this.epoch;
    const finished = () => {
      if (--left > 0 || epoch !== this.epoch) return;
      if (this.positionTimer) clearInterval(this.positionTimer);
      this.positionTimer = null;
      this.set({ playing: false, position: null });
    };
    if (!pending.length) {
      left = 1;
      finished();
    }
    for (const { e, i } of pending) {
      this.later(e.at - from, () => {
        this.set({ lastEvent: i });
        this.exec(stripAt(e)).catch((err) => console.warn("[director]", err)).finally(finished);
      });
    }
  }

  /** A request relayed by the server (POST /api/director). */
  handle(req: DirectorRequest) {
    if (req.stop) return this.stop();
    if (req.timeline) return this.play(req.timeline, req.from ?? 0);
    if (req.commands) this.run(req.commands).catch((err) => console.warn("[director]", err));
  }

  // ---------- commands ----------

  /** A command's end state without its animation or sound (for starting a timeline mid-way). */
  private instant(e: TimedCommand, i: number) {
    const c = stripAt(e);
    switch (c.do) {
      case "notice":
      case "wait":
      case "think":
      case "partial":
        return;
      case "say":
        return this.addRow(c.who, c.text, c.label);
      case "imp":
        return this.set({ caption: c.text, lastEvent: i });
      case "alert":
        return void this.exec({ ...c, quiet: true });
      default:
        return void this.exec(c).catch(() => {});
    }
  }

  private async exec(c: DirectorCommand): Promise<void> {
    const epoch = this.epoch;
    switch (c.do) {
      case "reset":
        return this.reset(c.isolate ?? true);
      case "wait":
        return this.sleep(c.ms);
      case "say": {
        if (c.ms === 0) return this.addRow(c.who, c.text, c.label); // lands at once, no streaming
        const w = words(c.text);
        const step = (c.ms ?? w.length * WORD_MS) / Math.max(w.length, 1);
        const shown = this.speakerShown(c.who, c.label);
        for (let i = 1; i <= w.length; i++) {
          if (epoch !== this.epoch) return;
          this.set({ partial: { speakerLabel: shown, text: w.slice(0, i).join(" ") } });
          await this.sleep(step);
        }
        if (epoch !== this.epoch) return;
        this.set({ partial: null });
        this.addRow(c.who, c.text, c.label);
        return;
      }
      case "partial":
        return this.set({ partial: c.text === null ? null : { speakerLabel: this.speakerShown(c.who, c.label), text: c.text } });
      case "think":
        if (c.on === false) return this.set({ thinking: false });
        this.set({ thinking: true });
        if (c.ms === undefined) return;
        await this.sleep(c.ms);
        if (epoch === this.epoch) this.set({ thinking: false });
        return;
      case "imp": {
        if (c.voice === false) {
          this.set({ thinking: false, caption: c.text, speaking: true });
          await this.sleep(c.ms ?? words(c.text).length * IMP_WORD_MS + 300);
          if (epoch === this.epoch) this.set({ speaking: false });
          return;
        }
        this.expected.set(c.text, (this.expected.get(c.text) ?? 0) + 1);
        this.set({ thinking: false, caption: c.text });
        await this.hooks?.speak(c.text, c.tone ?? "sarcastic");
        return;
      }
      case "caption":
        return this.set({ caption: c.text });
      case "receipt":
        return this.set({ receipt: c.text });
      case "state":
        return this.set({ state: c.state });
      case "notice":
        this.hooks?.notice({ kind: c.kind, title: c.title, detail: c.detail ?? null });
        return this.set({});
      case "alert": {
        // the alert quotes a transcript line: the given question (added as said by `who`), or who's last line
        if (c.question) this.addRow(c.who ?? "guest", c.question);
        const line = [...this.stage.rows].reverse().find((u) => (c.who ? this.rowIsWho(u, c.who) : !u.isOwner));
        const alert: Alert = {
          id: `director-alert-${++this.seq}`,
          sessionId: "director",
          personId: line?.personId ?? null,
          questionUtteranceId: line?.id ?? "",
          reason: c.reason,
          createdAt: this.now(),
          acknowledgedAt: null,
        };
        this.set({ alerts: [...this.stage.alerts, alert], receipt: `Escalated to the owner: ${c.reason}` });
        if (!c.quiet) this.hooks?.chime();
        return;
      }
      case "ack":
        return this.set({ alerts: [] });
      case "memory": {
        const id = c.id ?? `director-m-${++this.seq}`;
        const m: Memory = {
          id,
          kind: c.question ? "faq" : "fact",
          canonicalQuestion: c.question ?? null,
          factualAnswer: c.answer,
          sourceUtteranceIds: c.from === "ui" ? [] : this.stage.rows.slice(-1).map((u) => u.id),
          sourcePersonId: null,
          observedAt: this.now(),
          validUntil: null,
          supersededBy: null,
          timesAsked: c.timesAsked ?? 0,
          context: c.context ?? null,
        };
        // like a live LEARN; a later `receipt` command overrides it
        return this.set({ memories: [...this.stage.memories.filter((x) => x.id !== id), m], ...(c.from === "ui" ? {} : { receipt: "Learned a new memory" }) });
      }
      case "repeat": {
        const needle = c.memory.toLowerCase();
        const m =
          this.stage.memories.find((x) => x.id === c.memory) ??
          [...this.stage.memories].reverse().find((x) => `${x.canonicalQuestion ?? ""} ${x.factualAnswer}`.toLowerCase().includes(needle));
        if (!m) throw new Error(`repeat: no director memory matches "${c.memory}"`);
        const person = c.who ? this.personFor(c.who) : null;
        const byPerson = { ...this.stage.byPerson };
        if (person) byPerson[person.id] = (byPerson[person.id] ?? 0) + 1;
        return this.set({
          memories: this.stage.memories.map((x) => (x.id === m.id ? { ...x, timesAsked: x.timesAsked + 1 } : x)),
          repeats: this.stage.repeats + 1,
          byPerson,
          highlight: [m.id],
          receipt: `Recalled from memory${person ? ` (asked ${byPerson[person.id]}×)` : ""}: “${m.factualAnswer}”`,
        });
      }
      case "person":
        this.ensurePerson(c.name, { relationship: c.relationship ?? null, tone: c.tone });
        return;
      case "listening":
        return this.set({ listening: c.on });
      case "focus":
        return this.set({ focus: c.on });
      case "tab":
        return this.set({ tab: c.tab });
      case "demo":
        this.hooks?.demo(c.on);
        return this.set({});
      case "error":
        return this.set({ error: c.text });
    }
  }

  // ---------- people and rows ----------

  private parseWho(who: string, label?: string): { kind: "owner" | "guest" | "named"; label: string; name: string | null } {
    const w = who.trim();
    if (w.toLowerCase() === "owner") return { kind: "owner", label: label ?? "S1", name: null };
    const g = /^guest(?:\s+(\S+))?$/i.exec(w);
    if (g) return { kind: "guest", label: label ?? g[1] ?? "S2", name: null };
    const i = this.stage.people.findIndex((p) => p.name.toLowerCase() === w.toLowerCase());
    return { kind: "named", label: label ?? `S${(i < 0 ? this.stage.people.length : i) + 3}`, name: i < 0 ? w : this.stage.people[i]!.name };
  }

  private speakerShown(who: string, label?: string) {
    const p = this.parseWho(who, label);
    return p.name ?? p.label;
  }

  private ensurePerson(name: string, patch: { relationship?: string | null; tone?: Tone } = {}): Person {
    const existing = this.stage.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const person: Person = {
      id: existing?.id ?? `director-p-${slug(name)}`,
      name: existing?.name ?? name,
      relationship: patch.relationship !== undefined ? patch.relationship : existing?.relationship ?? null,
      tone: patch.tone ?? existing?.tone ?? "neutral",
      priority: false,
      ownerConfiguredAt: existing?.ownerConfiguredAt ?? this.now(),
    };
    this.set({ people: existing ? this.stage.people.map((p) => (p.id === person.id ? person : p)) : [...this.stage.people, person] });
    return person;
  }

  private personFor(who: string): Person | null {
    const p = this.parseWho(who);
    return p.kind === "named" ? this.ensurePerson(p.name!) : null;
  }

  private rowIsWho(u: Utterance, who: string) {
    const p = this.parseWho(who);
    if (p.kind === "owner") return u.isOwner;
    if (p.kind === "guest") return !u.isOwner && !u.personId && u.speakerLabel === p.label;
    return u.personId === this.stage.people.find((x) => x.name === p.name)?.id;
  }

  private addRow(who: string, text: string, label?: string) {
    const p = this.parseWho(who, label);
    const person = p.kind === "named" ? this.ensurePerson(p.name!) : null;
    const now = this.now();
    const owner = p.kind === "owner";
    const row: Utterance = {
      id: `director-u-${++this.seq}`,
      sessionId: "director",
      connectionId: "director",
      providerEventId: `director-${this.seq}`,
      speakerLabel: p.label,
      personId: person?.id ?? null,
      text,
      startedAt: now - words(text).length * WORD_MS,
      endedAt: now,
      isOwner: owner,
      ownerCertain: owner,
      ownerBasis: owner ? "enrolled" : "none",
      ownerScore: null,
      source: "speech",
    };
    this.set({ rows: [...this.stage.rows, row] });
  }

  // ---------- what the page shows ----------

  /** The snapshot the panels render: real data plus scripted data, or scripted data only when isolated. */
  view(real: Snapshot): Snapshot {
    const s = this.stage;
    if (!s.active) return real;
    const base: Snapshot = s.isolated
      ? {
          ...real,
          index: { ...real.index, lastError: null, ready: true },
          session: {
            ...real.session,
            connectionId: null,
            bindings: {},
            pendingUnknownSpeaker: null,
            calibration: { active: false, candidate: null },
            suggestions: [],
            speechLabels: [],
            listening: false,
          },
          people: [],
          memories: [],
          alerts: [],
          transcript: [],
          counts: { total: 0, byPerson: {}, byMemory: {} },
        }
      : real;
    // a scripted name that's already a real person shows as that person
    const realId = new Map(s.people.map((p) => [p.id, base.people.find((q) => q.name.toLowerCase() === p.name.toLowerCase())?.id]));
    const remap = (id: string | null) => (id && realId.get(id)) || id;
    const byPerson = { ...base.counts.byPerson };
    for (const [k, v] of Object.entries(s.byPerson)) byPerson[remap(k)!] = (byPerson[remap(k)!] ?? 0) + v;
    return {
      ...base,
      session: {
        ...base.session,
        focusMode: s.focus ?? base.session.focusMode,
        listening: s.listening ?? (s.isolated || base.session.listening),
      },
      transcript: [...base.transcript, ...s.rows.map((u) => ({ ...u, personId: remap(u.personId) }))],
      people: [...base.people, ...s.people.filter((p) => !realId.get(p.id))],
      memories: [...base.memories, ...s.memories],
      alerts: [...base.alerts, ...s.alerts.map((a) => ({ ...a, personId: remap(a.personId) }))],
      counts: { total: base.counts.total + s.repeats, byPerson, byMemory: base.counts.byMemory },
    };
  }
}

function stripAt(e: TimedCommand): DirectorCommand {
  const { at: _at, ...c } = e;
  return c as DirectorCommand;
}

/** The page's one director. */
export const director = new Director();

export function useStage() {
  return useSyncExternalStore(director.subscribe, director.getStage);
}
