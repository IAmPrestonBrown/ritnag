import { describe, expect, it } from "vitest";
import { validateDecision, type ExecContext } from "../server/executor";
import type { Decision } from "../shared/schemas";

const decision = (over: Partial<Decision>): Decision =>
  ({
    action: "WAIT",
    speakerCheck: { addressesOwner: false, selfIdentifiedAs: null },
    isQuestion: true,
    isImportant: false,
    isActionRequest: false,
    banter: false,
    memoryIds: [],
    factualAnswer: null,
    spokenText: "You'll have to ask the owner that one.",
    memoryProposal: null,
    identityProposal: null,
    alertReason: null,
    ...over,
  }) as Decision;

const visitor = (focusMode: boolean): ExecContext => ({
  role: "visitor",
  ownerCertain: false,
  utteranceId: "u_1",
  speakerPersonId: null,
  ownerPersonId: null,
  activeMemories: [],
  knownUtteranceIds: new Set(),
  focusMode,
  now: 0,
});

describe("visitor WAIT in focus mode", () => {
  it("alerts the owner when the model calls an unanswered question important but picks WAIT", () => {
    // "Where are your keys? I need them right now." with nothing in memory
    const effect = validateDecision(decision({ isImportant: true, alertReason: "Needs the keys now" }), visitor(true));
    expect(effect).toMatchObject({ kind: "alert", reason: "Needs the keys now" });
  });

  it("still only deflects an ordinary unanswered question", () => {
    expect(validateDecision(decision({}), visitor(true))).toMatchObject({ kind: "wait", spokenText: "You'll have to ask the owner that one." });
  });

  it("never interrupts the owner outside focus mode, important or not", () => {
    expect(validateDecision(decision({ isImportant: true }), visitor(false))).toMatchObject({ kind: "wait", spokenText: null });
  });

  it("stays silent for room chatter that isn't a question", () => {
    expect(validateDecision(decision({ isQuestion: false, isImportant: true }), visitor(true))).toMatchObject({ kind: "wait", spokenText: null });
  });
});
