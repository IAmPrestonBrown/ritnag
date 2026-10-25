import { describe, expect, it } from "vitest";
import { timeAgo } from "../server/timeAgo";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("timeAgo", () => {
  it.each([
    [10_000, "just now"],
    [1 * MIN, "a minute ago"],
    [25 * MIN, "25 minutes ago"],
    [1 * HOUR, "an hour ago"],
    [5 * HOUR, "5 hours ago"],
    [30 * HOUR, "yesterday"],
    [3 * DAY, "3 days ago"],
    [8 * DAY, "last week"],
    [12 * DAY, "12 days ago"],
    [20 * DAY, "2 weeks ago"],
    [70 * DAY, "2 months ago"],
  ])("%i ms ago reads as %s", (elapsed, words) => {
    expect(timeAgo(1_000_000_000_000 - elapsed, 1_000_000_000_000)).toBe(words);
  });

  it("treats a clock skew into the future as just now", () => {
    expect(timeAgo(2_000, 1_000)).toBe("just now");
  });
});
