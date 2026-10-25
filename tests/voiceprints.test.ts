import { describe, expect, it } from "vitest";
import { JsonMemoryStore } from "../server/memory";
import { Session } from "../server/session";
import type { ServerEvent } from "../shared/events";
import type { Decision } from "../shared/schemas";

const wait: Decision = {
  action: "WAIT",
  speakerCheck: { addressesOwner: false, selfIdentifiedAs: null },
  isQuestion: false,
  isImportant: false,
  isActionRequest: false,
  banter: null,
  memoryIds: [],
  factualAnswer: null,
  spokenText: null,
  memoryProposal: null,
  identityProposal: null,
  alertReason: null,
};
const index = { search: async () => [], upsert: async () => true, remove: async () => {}, rebuild: async () => true, getStatus: () => ({ configured: false, ready: false, docCount: 0, lastError: null, lastPushAt: null, pushPending: false }) };

describe("visitor voiceprints", () => {
  it("are stored per person, survive a normal reset, and are forgotten with everything", async () => {
    const store = new JsonMemoryStore(null);
    const jason = await store.createPerson({ name: "Jason", relationship: null, tone: "neutral", priority: false });
    await store.setVoiceprint(jason.id, ["id-1"]);
    await store.setVoiceprint("p_gone", ["x"]); // a deleted person's print isn't offered
    expect(await store.voiceprints()).toEqual({ [jason.id]: ["id-1"] });
    await store.reset(false);
    expect(await store.voiceprints()).toEqual({ [jason.id]: ["id-1"] });
    await store.reset(true);
    expect(await store.voiceprints()).toEqual({});
  });

  it("an owner naming a voice asks to learn it; a provider-recognized voice is announced, not re-learned", async () => {
    const store = new JsonMemoryStore(null);
    const events: ServerEvent[] = [];
    const bound: string[] = [];
    const session = new Session(store, async () => wait, index, {
      ownerName: "Leon",
      emit: (e) => events.push(e),
      onBound: (_c, label, personId) => bound.push(`${label}=${personId}`),
    });
    const jason = await store.createPerson({ name: "Jason", relationship: null, tone: "neutral", priority: false });
    session.setSpeechConnection("sm-1");
    await session.bindSpeaker("sm-1", "S3", jason.id);
    expect(bound).toEqual([`S3=${jason.id}`]);
    expect(session.boundLabels("sm-1")).toEqual([["S3", jason.id]]);

    session.setSpeechConnection("sm-2"); // next session: Speechmatics labels him itself
    events.length = 0;
    await session.bindSpeaker("sm-2", `person_${jason.id}`, jason.id, { auto: true });
    expect(bound).toHaveLength(1); // not learned again
    const n = events.find((e) => e.type === "notice");
    expect(n && n.type === "notice" && n.notice).toMatchObject({ kind: "name", title: "Jason detected", detail: "Voice recognized" });
  });
});
