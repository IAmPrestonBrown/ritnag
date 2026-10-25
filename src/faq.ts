import type { Memory } from "../shared/schemas";

/** Asked at least this many times before it counts as a frequently asked question. */
export const FAQ_MIN_ASKS = 2;
const FAQ_LIMIT = 5;

/** The FAQ bank: live memories people keep asking about, most asked first. */
export function mostAsked(memories: Memory[], now: number, limit = FAQ_LIMIT): Memory[] {
  return memories
    .filter((m) => !m.supersededBy && (m.validUntil === null || m.validUntil > now) && m.timesAsked >= FAQ_MIN_ASKS)
    .sort((a, b) => b.timesAsked - a.timesAsked)
    .slice(0, limit);
}
