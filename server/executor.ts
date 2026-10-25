import type { Decision, Memory, Tone } from "../shared/schemas";

const TRANSIENT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SPOKEN_CHARS = 280;

export type Effect =
  | { kind: "wait"; spokenText: string | null; isQuestion: boolean }
  | { kind: "answer"; memoryIds: string[]; spokenText: string }
  | { kind: "alert"; reason: string; spokenText: string | null }
  | {
      kind: "learn";
      memory: Omit<Memory, "id" | "timesAsked" | "supersededBy">;
      supersedesId: string | null;
    }
  | {
      kind: "update_person";
      name: string;
      relationship: string | null;
      tone: Tone | null;
      priority: boolean | null;
      refersTo: "pending_unknown" | "named_existing";
      spokenText: string | null;
    };

export interface ExecContext {
  role: "owner" | "visitor";
  utteranceId: string;
  speakerPersonId: string | null;
  ownerPersonId: string | null;
  activeMemories: Memory[];
  knownUtteranceIds: Set<string>;
  now: number;
}

const clip = (s: string | null) => {
  const t = s?.trim();
  if (!t) return null;
  return t.length > MAX_SPOKEN_CHARS ? `${t.slice(0, MAX_SPOKEN_CHARS - 1)}…` : t;
};

/**
 * Turns a model proposal into a permitted effect. The model suggests; this decides.
 * Anything not allowed for the turn's role, or not backed by real records, degrades to WAIT/ALERT.
 */
export function validateDecision(d: Decision, ctx: ExecContext): Effect {
  const wait = (spoken: string | null = null): Effect => ({ kind: "wait", spokenText: clip(spoken), isQuestion: d.isQuestion });

  if (ctx.role === "visitor") {
    switch (d.action) {
      case "ANSWER": {
        const active = new Set(ctx.activeMemories.map((m) => m.id));
        const ids = [...new Set(d.memoryIds)];
        const spoken = clip(d.spokenText);
        if (ids.length === 0 || !ids.every((id) => active.has(id)) || !spoken) {
          // Unsupported answer: escalate if it mattered, otherwise stay quiet. Never speak an unbacked claim.
          return d.isImportant
            ? { kind: "alert", reason: d.alertReason ?? "Question the imp couldn't support from memory", spokenText: null }
            : wait();
        }
        return { kind: "answer", memoryIds: ids, spokenText: spoken };
      }
      case "ALERT_OWNER":
        return { kind: "alert", reason: d.alertReason?.trim() || "Needs the owner", spokenText: clip(d.spokenText) };
      case "WAIT":
        return wait(d.spokenText);
      default:
        // LEARN / UPDATE_PERSON from a guest are never honored.
        return wait();
    }
  }

  switch (d.action) {
    case "LEARN": {
      const p = d.memoryProposal;
      if (!p || !p.factualAnswer.trim()) return wait();
      const sources = new Set(p.sourceUtteranceIds.filter((id) => ctx.knownUtteranceIds.has(id)));
      sources.add(ctx.utteranceId); // the owner's own turn always backs an owner-taught fact
      const supersedes =
        p.supersedesMemoryId && ctx.activeMemories.some((m) => m.id === p.supersedesMemoryId) ? p.supersedesMemoryId : null;
      return {
        kind: "learn",
        supersedesId: supersedes,
        memory: {
          kind: p.kind,
          canonicalQuestion: p.canonicalQuestion?.trim() || null,
          factualAnswer: p.factualAnswer.trim(),
          sourceUtteranceIds: [...sources],
          sourcePersonId: ctx.ownerPersonId,
          observedAt: ctx.now,
          validUntil: p.isTransient ? ctx.now + TRANSIENT_TTL_MS : null,
        },
      };
    }
    case "UPDATE_PERSON": {
      const p = d.identityProposal;
      if (!p || !p.name.trim()) return wait();
      return {
        kind: "update_person",
        name: p.name.trim(),
        relationship: p.relationship?.trim() || null,
        tone: p.tone,
        priority: p.priority,
        refersTo: p.refersTo,
        spokenText: clip(d.spokenText),
      };
    }
    case "WAIT":
      return wait(d.spokenText);
    default:
      // Owner turns don't produce answers or alerts.
      return wait();
  }
}
