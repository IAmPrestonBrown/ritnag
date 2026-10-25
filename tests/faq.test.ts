import { describe, expect, it } from "vitest";
import { mostAsked } from "../src/faq";
import type { Memory } from "../shared/schemas";

const mem = (id: string, timesAsked: number, extra: Partial<Memory> = {}): Memory => ({
  id,
  kind: "faq",
  canonicalQuestion: `q ${id}`,
  factualAnswer: `a ${id}`,
  sourceUtteranceIds: [],
  sourcePersonId: null,
  observedAt: 0,
  validUntil: null,
  supersededBy: null,
  timesAsked,
  ...extra,
});

describe("mostAsked", () => {
  it("lists repeated memories, most asked first, and leaves out ones asked once or never", () => {
    const list = mostAsked([mem("a", 2), mem("b", 5), mem("c", 1), mem("d", 0), mem("e", 3)], 100);
    expect(list.map((m) => m.id)).toEqual(["b", "e", "a"]);
  });

  it("skips superseded and expired memories", () => {
    const list = mostAsked([mem("old", 9, { supersededBy: "new" }), mem("gone", 9, { validUntil: 50 }), mem("live", 2)], 100);
    expect(list.map((m) => m.id)).toEqual(["live"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 10 }, (_, i) => mem(`m${i}`, i + 2));
    expect(mostAsked(many, 0)).toHaveLength(5);
  });
});
