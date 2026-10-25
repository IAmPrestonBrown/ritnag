import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice, NoticeKind, Snapshot } from "../shared/events";
import type { Person, Tone, Utterance } from "../shared/schemas";

/**
 * Director mode: a hand-driven script for the demo video's intro. It looks like the live app (words
 * stream in, the imp thinks, Archie really speaks, pop-ups fire), but nothing is heard or decided.
 * Press N for the next cue. A cue is one paragraph of the script; its lines run in order.
 *
 *   owner: text            the owner speaks
 *   guest: text            an unknown voice (guest S3: text picks the label)
 *   Leon: text             a named person speaks
 *   think 1200             the imp "thinks" for 1.2 s
 *   imp savage: text       the imp says this aloud (tone optional)
 *   notice question: New question detected | What's the wifi?
 *   wait 800
 */
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

const KEY = "imp.directorScript";
const TONES = new Set<string>(["neutral", "friendly", "playful", "sarcastic", "annoyed", "savage", "flirty"]);
const KINDS = new Set<string>(["person", "question", "repeat", "name"]);
const WORD_MS = 330; // about how fast people talk

export type Step =
  | { kind: "say"; who: "owner" | "guest" | "named"; label: string; name: string | null; text: string }
  | { kind: "imp"; tone: Tone; text: string }
  | { kind: "notice"; notice: Notice }
  | { kind: "think"; ms: number }
  | { kind: "wait"; ms: number };

/** Script text → cues (paragraphs) of steps. Unknown lines are skipped. Pure, for tests. */
export function parseScript(script: string): Step[][] {
  return script
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((l) => parseLine(l.trim())).filter((s): s is Step => s !== null))
    .filter((cue) => cue.length > 0);
}

function parseLine(line: string): Step | null {
  if (!line || line.startsWith("#")) return null;
  const timed = /^(think|wait)\s+(\d+)$/i.exec(line);
  if (timed) return { kind: timed[1]!.toLowerCase() as "think" | "wait", ms: Number(timed[2]) };
  const m = /^([^:]+):\s*(.+)$/.exec(line);
  if (!m) return null;
  const [head, rest] = [m[1]!.trim(), m[2]!.trim()];
  const words = head.split(/\s+/);
  const first = words[0]!.toLowerCase();
  if (first === "imp") {
    const tone = (words[1] ?? "").toLowerCase();
    return { kind: "imp", tone: (TONES.has(tone) ? tone : "sarcastic") as Tone, text: rest };
  }
  if (first === "notice") {
    const kind = (words[1] ?? "").toLowerCase();
    if (!KINDS.has(kind)) return null;
    const [title, detail] = rest.split("|").map((s) => s.trim());
    return { kind: "notice", notice: { kind: kind as NoticeKind, title: title!, detail: detail || null } };
  }
  if (first === "owner") return { kind: "say", who: "owner", label: "S1", name: null, text: rest };
  if (first === "guest") return { kind: "say", who: "guest", label: words[1] ?? "S2", name: null, text: rest };
  return { kind: "say", who: "named", label: `S${2 + (hash(head) % 6)}`, name: head, text: rest };
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadScript() {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_SCRIPT;
  } catch {
    return DEFAULT_SCRIPT;
  }
}

interface Hooks {
  onPartial(p: { speakerLabel: string; text: string } | null): void;
  onThinking(on: boolean): void;
  onNotice(n: Notice): void;
  onError(message: string): void;
}

/** Runs the script cue by cue and keeps the fake transcript rows it produced. */
export function useDirector(hooks: Hooks) {
  const [script, setScriptState] = useState(loadScript);
  const [cue, setCue] = useState(0);
  const [rows, setRows] = useState<Utterance[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const busy = useRef(false);
  const h = useRef(hooks);
  h.current = hooks;
  const cues = parseScript(script);

  const setScript = (s: string) => {
    setScriptState(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {}
  };

  const reset = useCallback(() => {
    setCue(0);
    setRows([]);
    setPeople([]);
    h.current.onPartial(null);
    h.current.onThinking(false);
  }, []);

  const run = async (step: Step) => {
    switch (step.kind) {
      case "wait":
        return sleep(step.ms);
      case "think":
        h.current.onThinking(true);
        await sleep(step.ms);
        return h.current.onThinking(false);
      case "notice":
        return h.current.onNotice(step.notice);
      case "imp":
        try {
          const { post } = await import("./api"); // lazy: api.ts reads the page URL on load
          await post("/api/director/say", { text: step.text, tone: step.tone });
        } catch (err) {
          h.current.onError(`Director: ${(err as Error).message}`);
        }
        return;
      case "say": {
        const words = step.text.split(/\s+/);
        const shownAs = step.name ?? step.label;
        for (let i = 1; i <= words.length; i++) {
          h.current.onPartial({ speakerLabel: shownAs, text: words.slice(0, i).join(" ") });
          await sleep(WORD_MS);
        }
        h.current.onPartial(null);
        let personId: string | null = null;
        if (step.name) {
          personId = `director-${step.name.toLowerCase()}`;
          const name = step.name;
          setPeople((ps) =>
            ps.some((p) => p.id === personId)
              ? ps
              : [...ps, { id: personId!, name, relationship: null, tone: "neutral", priority: false, ownerConfiguredAt: Date.now() }],
          );
        }
        const now = Date.now();
        const owner = step.who === "owner";
        setRows((rs) => [
          ...rs,
          {
            id: `director-${now}-${rs.length}`,
            sessionId: "director",
            connectionId: "director",
            providerEventId: `director-${now}`,
            speakerLabel: step.label,
            personId,
            text: step.text,
            startedAt: now - words.length * WORD_MS,
            endedAt: now,
            isOwner: owner,
            ownerCertain: owner,
            ownerBasis: owner ? "enrolled" : "none",
            ownerScore: null,
            source: "speech",
          },
        ]);
        return sleep(250); // the end-of-turn pause before anything reacts
      }
    }
  };

  const next = useCallback(async () => {
    if (busy.current || cue >= cues.length) return;
    busy.current = true;
    setCue((c) => c + 1);
    try {
      for (const step of cues[cue]!) await run(step);
    } finally {
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue, script]);

  // N: next cue. Ignored while typing (the script editor included).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey) void next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  /** The snapshot with the director's rows and people merged in, so every panel shows them. */
  const overlay = (s: Snapshot): Snapshot => {
    if (!rows.length && !people.length) return s;
    // a scripted name that's already a real person shows as that person
    const real = new Map(people.map((p) => [p.id, s.people.find((q) => q.name.toLowerCase() === p.name.toLowerCase())?.id]));
    return {
      ...s,
      transcript: [...s.transcript, ...rows.map((u) => (u.personId && real.get(u.personId) ? { ...u, personId: real.get(u.personId)! } : u))],
      people: [...s.people, ...people.filter((p) => !real.get(p.id))],
    };
  };

  return { script, setScript, cue, total: cues.length, active: cue > 0, next, reset, overlay };
}
