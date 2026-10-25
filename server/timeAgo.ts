const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
/** Past this, "last week" stretches the truth; say the days instead. */
const LAST_WEEK_MAX = 11 * DAY;

const plural = (n: number, one: string, unit: string) => (n === 1 ? `${one} ${unit} ago` : `${n} ${unit}s ago`);

/** How long ago, in the words Ritnag would say it ("yesterday", "last week"), so Claude never does date math. */
export function timeAgo(then: number, now: number): string {
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "a", "minute");
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "an", "hour");
  if (elapsed < 2 * DAY) return "yesterday";
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)} days ago`;
  if (elapsed < LAST_WEEK_MAX) return "last week";
  if (elapsed < 2 * WEEK) return `${Math.floor(elapsed / DAY)} days ago`;
  if (elapsed < 2 * MONTH) return `${Math.floor(elapsed / WEEK)} weeks ago`;
  return `${Math.floor(elapsed / MONTH)} months ago`;
}
