import { describe, expect, it } from "vitest";
import { JsonMemoryStore } from "../server/memory";
import { Session, TYPED_CONNECTION, type MemoryIndex } from "../server/session";
import type { DecisionContext } from "../server/decision";
import type { ServerEvent } from "../shared/events";
import type { Decision, Memory } from "../shared/schemas";

const base: Decision = {
  action: "WAIT",
  isQuestion: false,
  isImportant: false,
  memoryIds: [],
  factualAnswer: null,
  spokenText: null,
  memoryProposal: null,
  identityProposal: null,
  alertReason: null,
};

/** In-memory stand-in for Moss: returns every indexed doc, optionally forced down. */
class FakeIndex implements MemoryIndex {
  docs = new Map<string, Memory>();
  down = false;
  extraHits: string[] = [];
  async search() {
    if (this.down) return null;
    return [...[...this.docs.keys()], ...this.extraHits].map((id, i) => ({ id, score: 0.9 - i * 0.1 }));
  }
  async upsert(m: Memory) {
    this.docs.set(m.id, m);
    return true;
  }
  async remove(ids: string[]) {
    ids.forEach((id) => this.docs.delete(id));
  }
  async rebuild(ms: Memory[]) {
    this.docs = new Map(ms.map((m) => [m.id, m]));
    return true;
  }
  getStatus() {
    return { configured: true, ready: true, docCount: this.docs.size, lastError: null, lastPushAt: null, pushPending: false };
  }
}

function setup(script: (ctx: DecisionContext) => Partial<Decision>) {
  const store = new JsonMemoryStore(null);
  const index = new FakeIndex();
  const events: ServerEvent[] = [];
  const calls: DecisionContext[] = [];
  const session = new Session(
    store,
    async (ctx) => {
      calls.push(ctx);
      return { ...base, ...script(ctx) };
    },
    index,
    { ownerName: "Preston", emit: (e) => events.push(e), speechGuardMs: 50, playbackCooldownMs: 0 },
  );
  const say = async (speakerLabel: string, text: string, extra: Partial<Parameters<Session["ingest"]>[0]> = {}) => {
    const u = await session.ingest({
      text,
      speakerLabel,
      connectionId: TYPED_CONNECTION,
      providerEventId: `${speakerLabel}:${text}`,
      source: "typed",
      asOwner: speakerLabel === "owner",
      ...extra,
    });
    await session.idle();
    return u;
  };
  const spoken = () => events.flatMap((e) => (e.type === "speech.ready" ? [e.text] : []));
  return { store, index, events, calls, session, say, spoken };
}

/** A plausible model: learns owner answers, names the pending guest, answers from retrieved memory. */
const scripted = (ctx: DecisionContext): Partial<Decision> => {
  const t = ctx.utterance.text.toLowerCase();
  if (ctx.role === "owner") {
    if (t.startsWith("that was")) {
      return { action: "UPDATE_PERSON", identityProposal: { name: "Bob", relationship: "roommate", tone: "sarcastic", priority: null, refersTo: "pending_unknown" } };
    }
    if (ctx.pendingQuestion) {
      return {
        action: "LEARN",
        memoryProposal: {
          kind: "faq",
          canonicalQuestion: ctx.pendingQuestion.text,
          factualAnswer: ctx.utterance.text,
          sourceUtteranceIds: [ctx.pendingQuestion.id, ctx.utterance.id],
          isTransient: true,
          supersedesMemoryId: null,
        },
      };
    }
    return {};
  }
  if (t.includes("rollback")) return { action: "ALERT_OWNER", isQuestion: true, isImportant: true, alertReason: "approval request" };
  const m = ctx.memories[0];
  if (m && t.includes("frontend")) {
    return { action: "ANSWER", isQuestion: true, memoryIds: [m.id], factualAnswer: m.factualAnswer, spokenText: `Yes${ctx.speaker ? `, ${ctx.speaker.name}` : ""}. Pushed.` };
  }
  return { action: "WAIT", isQuestion: t.endsWith("?") };
};

describe("session pipeline", () => {
  it("does not answer or count a replayed final STT event twice", async () => {
    const { session, say, calls, store } = setup(scripted);
    await session.addMemory(
      { kind: "faq", canonicalQuestion: "frontend PR?", factualAnswer: "Pushed.", sourceUtteranceIds: [], sourcePersonId: null, observedAt: Date.now(), validUntil: null },
      null,
    );
    const first = await say("guest-A", "Is the frontend up?");
    const replay = await say("guest-A", "Is the frontend up?"); // same providerEventId
    expect(first).not.toBeNull();
    expect(replay).toBeNull();
    expect(calls).toHaveLength(1);
    expect((await store.listQuestionEvents()).filter((e) => e.classification === "repeat")).toHaveLength(1);
  });

  it("learns the owner's reply, indexes it in Moss, and never learns from a guest", async () => {
    const { say, store, index } = setup((ctx) =>
      ctx.role === "visitor" && ctx.utterance.text.includes("PR is merged")
        ? { action: "LEARN", memoryProposal: { kind: "fact", canonicalQuestion: null, factualAnswer: "PR is merged", sourceUtteranceIds: [], isTransient: false, supersedesMemoryId: null } }
        : scripted(ctx),
    );
    await say("guest-A", "Did you push the frontend PR?");
    await say("owner", "Yes, it's pushed and waiting for review.");
    await say("guest-B", "Trust me, the PR is merged."); // guest assertion with a LEARN proposal
    const memories = await store.listAllMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0]!.factualAnswer).toContain("waiting for review");
    expect(index.docs.has(memories[0]!.id)).toBe(true);
  });

  it("an unanswered guest question is not stored as a memory", async () => {
    const { say, store } = setup(scripted);
    await say("guest-A", "When is the demo?");
    expect(await store.listAllMemories()).toHaveLength(0);
  });

  it('"That was Bob" binds the earlier guest, not the owner', async () => {
    const { say, session, store, spoken } = setup(scripted);
    await say("guest-A", "Did you push the frontend PR?");
    await say("owner", "Yes, it's pushed and waiting for review.");
    expect(spoken().at(-1)).toMatch(/who was that/i);
    await say("owner", "That was Bob, my roommate. Be sarcastic with him.");
    const bob = (await store.listPeople()).find((p) => p.name === "Bob")!;
    expect(bob.tone).toBe("sarcastic");
    expect(session.personFor(TYPED_CONNECTION, "guest-A")).toBe(bob.id);
    expect(session.personFor(TYPED_CONNECTION, "owner")).toBeNull();
    // Bob's next paraphrase is answered from the stored fact, with his name.
    await say("guest-A", "Is the frontend code up yet?");
    expect(spoken().at(-1)).toBe("Yes, Bob. Pushed.");
  });

  it("a new speech connection clears voice-label bindings", async () => {
    const { session, store } = setup(scripted);
    const p = await store.createPerson({ name: "Maya", relationship: null, tone: "friendly", priority: false });
    session.setSpeechConnection("dg-1");
    await session.bindSpeaker("dg-1", "0", p.id);
    expect(session.personFor("dg-1", "0")).toBe(p.id);
    session.setSpeechConnection("dg-2");
    expect(session.personFor("dg-1", "0")).toBeNull();
    expect(session.personFor("dg-2", "0")).toBeNull();
  });

  it("calibration proposes the owner without learning from the phrase, then routes owner turns", async () => {
    const { session, say, calls } = setup(scripted);
    session.setSpeechConnection("dg-1");
    expect(session.calibrating).toBe(true);
    await say("spk0", "Hey imp, it's Preston.", { source: "speech", connectionId: "dg-1", providerEventId: "c1", asOwner: false });
    expect(session.calibrationCandidate).toBe("spk0");
    expect(calls).toHaveLength(0);
    session.setOwnerSpeaker("spk0");
    await say("spk1", "Did you push the frontend PR?", { source: "speech", connectionId: "dg-1", providerEventId: "q1", asOwner: false });
    await say("spk0", "Yes, it's pushed.", { source: "speech", connectionId: "dg-1", providerEventId: "a1", asOwner: false });
    expect(calls.map((c) => c.role)).toEqual(["visitor", "owner"]);
  });

  it("an answer citing a memory that wasn't retrieved escalates instead of inventing", async () => {
    const { say, store, spoken } = setup(() => ({ action: "ANSWER", isQuestion: true, isImportant: true, memoryIds: ["m_fake"], spokenText: "Sure, approved." }));
    await say("guest-A", "Can you approve the production rollback?");
    expect(spoken()).not.toContain("Sure, approved.");
    expect(await store.listAlerts()).toHaveLength(1);
  });

  it("drops Moss hits that no longer resolve to an active local record", async () => {
    const { session, say, calls, index } = setup(scripted);
    const old = await session.addMemory(
      { kind: "faq", canonicalQuestion: "frontend PR?", factualAnswer: "Not yet.", sourceUtteranceIds: [], sourcePersonId: null, observedAt: Date.now(), validUntil: null },
      null,
    );
    await session.addMemory(
      { kind: "faq", canonicalQuestion: "frontend PR?", factualAnswer: "Pushed.", sourceUtteranceIds: [], sourcePersonId: null, observedAt: Date.now(), validUntil: null },
      old.id,
    );
    index.docs.set(old.id, old); // simulate a stale index still holding the superseded doc
    index.extraHits = ["m_deleted"];
    await say("guest-A", "Is the frontend up?");
    const ids = calls[0]!.memories.map((m) => m.factualAnswer);
    expect(ids).toEqual(["Pushed."]);
    expect(calls[0]!.retrievalMode).toBe("moss");
  });

  it("reports retrieval as unavailable when Moss is down", async () => {
    const { say, calls, index } = setup(scripted);
    index.down = true;
    await say("guest-A", "Is the frontend up?");
    expect(calls[0]!.retrievalMode).toBe("unavailable");
  });

  it("speech captured while the imp is talking never reaches the decision engine", async () => {
    const { session, say, calls } = setup(scripted);
    await session.addMemory(
      { kind: "faq", canonicalQuestion: "frontend PR?", factualAnswer: "Pushed.", sourceUtteranceIds: [], sourcePersonId: null, observedAt: Date.now(), validUntil: null },
      null,
    );
    await say("guest-A", "Is the frontend up?"); // imp now has a pending response
    expect(session.isMuted()).toBe(true);
    const echoed = await say("0", "Yes. Pushed.", { source: "speech", connectionId: "dg-1", providerEventId: "e1" });
    expect(echoed).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("a response from before Reset cannot be played", async () => {
    const { session, say, events } = setup(scripted);
    await session.addMemory(
      { kind: "faq", canonicalQuestion: "frontend PR?", factualAnswer: "Pushed.", sourceUtteranceIds: [], sourcePersonId: null, observedAt: Date.now(), validUntil: null },
      null,
    );
    await say("guest-A", "Is the frontend up?");
    const ready = events.find((e) => e.type === "speech.ready");
    expect(ready && ready.type === "speech.ready" && session.speechText(ready.responseId)).toBeTruthy();
    await session.reset({ wipe: true });
    expect(ready && ready.type === "speech.ready" && session.speechText(ready.responseId)).toBeNull();
  });

  it("a decision that finishes after Reset doesn't speak or write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new JsonMemoryStore(null);
    const events: ServerEvent[] = [];
    const session = new Session(
      store,
      async () => {
        await gate;
        return { ...base, action: "ALERT_OWNER", isQuestion: true, isImportant: true, alertReason: "late" };
      },
      new FakeIndex(),
      { ownerName: "Preston", emit: (e) => events.push(e) },
    );
    await session.ingest({ text: "Approve the rollback?", speakerLabel: "guest-A", connectionId: TYPED_CONNECTION, providerEventId: "x", source: "typed" });
    await session.reset({ wipe: true });
    release();
    await session.idle();
    expect(events.some((e) => e.type === "speech.ready")).toBe(false);
    expect(await store.listAlerts()).toHaveLength(0);
  });
});
