import { describe, expect, it } from "vitest";
import { LATENCY_TARGET_MS, LatencyTrace, breakdown, formatLatency, streamTimeToWall } from "../server/latency";
import { JsonMemoryStore } from "../server/memory";
import { Session, TYPED_CONNECTION, type MemoryIndex } from "../server/session";
import type { ServerEvent } from "../shared/events";
import type { Decision } from "../shared/schemas";

describe("streamTimeToWall", () => {
  it("places a stream timestamp behind now by how much audio arrived after it", () => {
    // 10.0 s of audio received so far; the turn ended at 8.5 s of stream time
    expect(streamTimeToWall(8.5, 10, 50_000)).toBe(48_500);
  });

  it("never returns a time in the future", () => {
    expect(streamTimeToWall(10.2, 10, 50_000)).toBe(50_000);
  });
});

describe("breakdown", () => {
  it("splits end-of-speech to first audio into stages", () => {
    const b = breakdown({ speechEnd: 0, finalized: 1300, decided: 2900, ttsReady: 3600, playbackStarted: 3800 });
    expect(b).toEqual({ sttMs: 1300, decideMs: 1600, ttsMs: 700, playMs: 200, totalMs: 3800, withinTarget: true });
  });

  it("flags a reply slower than the target", () => {
    const b = breakdown({ speechEnd: 0, finalized: 1500, decided: 4000, ttsReady: 4700, playbackStarted: 5000 });
    expect(b.totalMs).toBe(5000);
    expect(b.withinTarget).toBe(false);
  });

  it("leaves missing stages null instead of inventing them", () => {
    const b = breakdown({ speechEnd: 0, finalized: 1000, decided: 2500, playbackStarted: 3000 });
    expect(b.ttsMs).toBeNull();
    expect(b.playMs).toBe(500); // measured from the decision when TTS timing is missing
    expect(b.totalMs).toBe(3000);
  });

  it("has no total without both ends", () => {
    const b = breakdown({ finalized: 1000, decided: 2500 });
    expect(b.totalMs).toBeNull();
    expect(b.withinTarget).toBeNull();
  });
});

describe("formatLatency", () => {
  it("prints every stage, the total and the verdict", () => {
    const line = formatLatency("Is the frontend code up yet?", "speech", breakdown({
      speechEnd: 0, finalized: 1300, decided: 2900, ttsReady: 3600, playbackStarted: 3800,
    }));
    expect(line).toBe(
      `[latency] speech "Is the frontend code up yet?" stt 1.3s · decide 1.6s · tts 0.7s · play 0.2s = 3.8s OK (<${LATENCY_TARGET_MS / 1000}s)`,
    );
  });

  it("marks a slow reply and shows unknown stages as ?", () => {
    const line = formatLatency("x".repeat(80), "speech", breakdown({ speechEnd: 0, finalized: 1000, decided: 4500, playbackStarted: 5000 }));
    expect(line).toContain(`"${"x".repeat(47)}…"`);
    expect(line).toContain("tts ?");
    expect(line).toContain("= 5.0s SLOW");
  });
});

describe("LatencyTrace", () => {
  const scenario = () => {
    const t = new LatencyTrace();
    t.turn("u1", { text: "Did you push it?", source: "speech", speechEnd: 1000, finalized: 2200 });
    return t;
  };

  it("reports a turn once its reply starts playing", () => {
    const t = scenario();
    t.decided("u1", "r1", 3800);
    t.ttsReady("r1", 4500);
    expect(t.playbackStarted("r1", 4700)).toBe(
      `[latency] speech "Did you push it?" stt 1.2s · decide 1.6s · tts 0.7s · play 0.2s = 3.7s OK (<4s)`,
    );
  });

  it("accepts TTS finishing before the decision is linked", () => {
    const t = scenario();
    t.ttsReady("r1", 4500);
    t.decided("u1", "r1", 3800);
    expect(t.playbackStarted("r1", 4700)).toContain("tts 0.7s");
  });

  it("reports each reply only once", () => {
    const t = scenario();
    t.decided("u1", "r1", 3800);
    t.playbackStarted("r1", 4700);
    expect(t.playbackStarted("r1", 4800)).toBeNull();
  });

  it("ignores speech it never saw decided (e.g. the Test voice button)", () => {
    const t = new LatencyTrace();
    t.ttsReady("test", 100);
    expect(t.playbackStarted("test", 200)).toBeNull();
  });

  it("forgets the oldest turns past its cap", () => {
    const t = new LatencyTrace(2);
    for (const id of ["a", "b", "c"]) t.turn(id, { text: id, source: "typed", speechEnd: 0, finalized: 0 });
    t.decided("a", "ra", 10);
    t.decided("c", "rc", 10);
    expect(t.playbackStarted("ra", 20)).toBeNull();
    expect(t.playbackStarted("rc", 20)).not.toBeNull();
  });
});

describe("LatencyTrace fed by a real Session", () => {
  const emptyIndex: MemoryIndex = {
    search: async () => [],
    upsert: async () => true,
    remove: async () => {},
    rebuild: async () => true,
    getStatus: () => ({ configured: true, ready: true, docCount: 0, lastError: null, lastPushAt: null, pushPending: false }),
  };
  const alert: Decision = {
    action: "ALERT_OWNER",
    speakerCheck: { addressesOwner: false, selfIdentifiedAs: null },
    isQuestion: true,
    isImportant: true,
    isActionRequest: true,
    memoryIds: [],
    factualAnswer: null,
    spokenText: "Hang on, getting Preston.",
    memoryProposal: null,
    identityProposal: null,
    alertReason: "Approval request",
  };

  it("times a spoken reply from the end of the question to playback start", async () => {
    // Arrange
    let clock = 0;
    const trace = new LatencyTrace();
    const events: ServerEvent[] = [];
    const session = new Session(
      new JsonMemoryStore(null),
      async () => {
        clock = 3800; // decision returns 1.6 s after the turn was finalized
        return alert;
      },
      emptyIndex,
      {
        ownerName: "Preston",
        emit: (e) => {
          events.push(e);
          trace.observe(e, clock);
        },
        now: () => clock,
        speechGuardMs: 50,
      },
    );

    // Act: the question ended at 1.0 s and the assembler finalized it at 2.2 s
    clock = 2200;
    await session.ingest({
      text: "Can you approve the production rollback?",
      speakerLabel: "guest-A",
      connectionId: TYPED_CONNECTION,
      providerEventId: "e1",
      source: "typed",
      endedAt: 1000,
    });
    await session.idle();
    const ready = events.find((e) => e.type === "speech.ready");
    if (ready?.type !== "speech.ready") throw new Error("no speech queued");
    trace.ttsReady(ready.responseId, 4500);
    const line = trace.playbackStarted(ready.responseId, 4700);

    // Assert
    expect(line).toBe(
      `[latency] typed "Can you approve the production rollback?" stt 1.2s · decide 1.6s · tts 0.7s · play 0.2s = 3.7s OK (<4s)`,
    );
  });
});
