import type { MemoryStore } from "./memory";

/**
 * "Give me a report on the day": what the imp handled since the start of today, for the owner.
 * The facts come from the question log; the wording comes from `reportLine` (Claude) or `plainReport`.
 */
export interface DayReport {
  ownerName: string;
  /** repeat questions answered from memory, most-asked first */
  answered: { question: string; times: number; askedBy: string[] }[];
  /** questions escalated to the owner */
  alerts: { reason: string; by: string | null; handled: boolean }[];
  /** questions nobody had an answer for (waited or deflected) */
  unanswered: number;
}

/** Owner turns that ask the imp for a recap. */
export const REPORT_REQUEST =
  /\b(report|recap|run ?down|summary|summari[sz]e|sum (?:it )?up|catch me up|fill me in|what did i miss|what(?:'s| has) (?:been )?happen(?:ed|ing))\b/i;

export async function buildDayReport(store: MemoryStore, since: number, ownerName: string): Promise<DayReport> {
  const [events, memories, people, alerts] = await Promise.all([
    store.listQuestionEvents(),
    store.listAllMemories(),
    store.listPeople(),
    store.listAlerts(),
  ]);
  const name = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? null : null);
  const today = events.filter((e) => e.createdAt >= since);
  const byMemory = new Map<string, { times: number; askedBy: Set<string> }>();
  for (const e of today) {
    if (e.classification !== "repeat" || !e.memoryId) continue;
    const m = byMemory.get(e.memoryId) ?? { times: 0, askedBy: new Set<string>() };
    m.times++;
    const n = name(e.personId);
    if (n) m.askedBy.add(n);
    byMemory.set(e.memoryId, m);
  }
  return {
    ownerName,
    answered: [...byMemory]
      .map(([id, m]) => {
        const mem = memories.find((x) => x.id === id);
        return { question: mem?.canonicalQuestion ?? mem?.factualAnswer ?? "a question", times: m.times, askedBy: [...m.askedBy] };
      })
      .sort((a, b) => b.times - a.times),
    alerts: alerts.filter((a) => a.createdAt >= since).map((a) => ({ reason: a.reason, by: name(a.personId), handled: a.acknowledgedAt !== null })),
    unanswered: today.filter((e) => e.classification === "new" || e.classification === "deflected").length,
  };
}

/** No-model fallback: plain, complete, short. */
export function plainReport(r: DayReport): string {
  if (!r.answered.length && !r.alerts.length && !r.unanswered) return `Quiet day, ${r.ownerName}. Nobody bothered you.`;
  const parts: string[] = [];
  const total = r.answered.reduce((n, a) => n + a.times, 0);
  if (total) parts.push(`I answered ${total} repeat question${total === 1 ? "" : "s"}, mostly "${r.answered[0]!.question}"`);
  if (r.alerts.length) parts.push(`flagged ${r.alerts.length} thing${r.alerts.length === 1 ? "" : "s"} for you`);
  if (r.unanswered) parts.push(`${r.unanswered} question${r.unanswered === 1 ? "" : "s"} still need you`);
  return `Hey ${r.ownerName}. ${parts.join(", ")}.`;
}

export const REPORT_SYSTEM = `You are Ritnag, a cheeky imp that fields interruptions for its owner. The owner asked for a report on the day. You get JSON of what you handled today. Speak to the owner by name in at most 45 words, plain spoken English (no lists, markdown or emoji), a little cheeky. Say what you handled (name who asked what, it's just the owner listening), and if one question kept coming up from different people, suggest one concrete fix (like posting an announcement in Slack). An alert with handled=true was already dealt with by the owner: mention it as done, never as still open. Only mention things in the JSON; never invent events.`;
