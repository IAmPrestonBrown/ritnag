import { useEffect, useRef, useState } from "react";
import type { DecisionSummary, ImpState, ServerEvent, Snapshot } from "../shared/events";
import { connectEvents, hasToken } from "./api";
import { Player } from "./audio/playback";
import { MicCapture } from "./audio/capture";
import { ImpAvatar } from "./components/ImpAvatar";
import { useThinkingCaption } from "./components/thinking";
import { AlertsPanel } from "./components/Panels";
import { CalibrationBar, PrimaryControls, SuggestionBar, WhoJustAsked } from "./components/SessionControls";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { SideTabs } from "./components/SideTabs";
import { HoldToTalk, MicMeter } from "./components/DemoControls";
import { usePushToTalk } from "./pushToTalk";
import { VoiceOnboarding } from "./components/VoiceOnboarding";
import { decisionDetails } from "./stage";
import { chime, notifyAlert, primeAlerts } from "./notify";
import { Toasts, useToasts } from "./components/Toasts";
import { director, loadScript, useStage } from "./director";
import { post } from "./api";
import type { Person } from "../shared/schemas";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function App() {
  const [rawSnapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [impState, setImpState] = useState<ImpState>("idle");
  const [caption, setCaption] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(false);
  // A decision is in flight. Ends at decision.completed, not at playback, so a TTS failure never hides the answer.
  const [deciding, setDeciding] = useState(false);
  // The director (scripted demo) owns the screen while stage.active; see src/director.ts.
  const stage = useStage();
  // Before any early return: hooks must run in the same order every render.
  const thinkingCaption = useThinkingCaption(stage.active ? !speaking && !stage.speaking && stage.thinking : !speaking && deciding);
  const [lastDecision, setLastDecision] = useState<DecisionSummary | null>(null);
  const [partial, setPartial] = useState<{ speakerLabel: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a failed decision the operator can re-run once (server-side dedup: nothing was written for it)
  const [retryTurnId, setRetryTurnId] = useState<string | null>(null);
  const demoDefaulted = useRef(false);
  const lastShownAt = useRef(0);
  const toasts = useToasts();
  const generation = useRef(0);
  // the event handler is registered once, so it reads people through a ref
  const people = useRef<Person[]>([]);
  const player = useRef<Player | null>(null);
  const mic = useRef(new MicCapture());
  const conn = useRef<ReturnType<typeof connectEvents> | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [micLabel, setMicLabel] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const [settings, setSettings] = useState(false);
  const [demo, setDemo] = useState(() => {
    if (new URLSearchParams(location.search).has("demo")) return true;
    try {
      return localStorage.getItem("imp.demo") === "1";
    } catch {
      return false;
    }
  });

  // Demo Mode input: push-to-talk / pinned speaker (src/pushToTalk.ts)
  const ptt = usePushToTalk(mic.current, micOn, demo);

  // Projector view: D toggles it (ignored while typing in a field).
  useEffect(() => {
    try {
      localStorage.setItem("imp.demo", demo ? "1" : "0");
    } catch {}
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "d" || e.key === "D") setDemo((d) => !d);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [demo]);

  const stopMic = () => {
    mic.current.stop(conn.current?.socket() ?? null);
    setMicOn(false);
  };
  // New transcription session (fresh speaker labels); saved memories and people are kept.
  const restartListening = async () => {
    stopMic();
    await new Promise((r) => setTimeout(r, 400));
    await toggleMic();
  };
  const toggleMic = async () => {
    if (mic.current.active) return stopMic();
    primeAlerts();
    const socket = conn.current?.socket();
    if (!socket || socket.readyState !== WebSocket.OPEN) return setError("Not connected to the Ritnag server.");
    try {
      await mic.current.start(socket); // the click also unlocks audio playback
      setMicOn(true);
      setMicLabel(mic.current.deviceLabel);
    } catch (err) {
      setError(`Microphone: ${(err as Error).message}`);
    }
  };

  player.current ??= new Player((isSpeaking, text) => {
    setSpeaking(isSpeaking);
    if (text) setCaption(text);
  });

  useEffect(() => {
    if (!hasToken) return;
    const c = connectEvents((e: ServerEvent) => {
      if ("generation" in e && e.generation < generation.current) return; // stale
      // While the director owns the screen, live activity doesn't show (its own speech still plays).
      const live = !director.stage.active;
      switch (e.type) {
        case "director":
          director.handle(e.request);
          break;
        case "snapshot":
          if (e.snapshot.session.generation !== generation.current) {
            // a reset: the previous run's reply must not keep playing, and its retries are void
            if (generation.current !== 0) player.current?.stop();
            setRetryTurnId(null);
          }
          // the demo profile opens in Demo Mode (once; D still toggles)
          if (e.snapshot.profile === "demo" && !demoDefaulted.current) {
            demoDefaulted.current = true;
            setDemo(true);
          }
          generation.current = e.snapshot.session.generation;
          people.current = e.snapshot.people;
          setSnapshot(e.snapshot);
          break;
        case "state.changed":
          if (!live) break;
          setImpState(e.state);
          setDeciding(e.state === "thinking");
          if (e.caption) setCaption(e.caption);
          break;
        case "transcript.partial":
          if (live) setPartial({ speakerLabel: e.speakerLabel, text: e.text });
          break;
        case "transcript.final":
          setPartial(null);
          break;
        case "decision.completed":
          if (!live) break;
          // a WAIT on a trailing fragment shouldn't wipe the answer the room just heard (receipt, retrieved memory)
          setLastDecision((prev) =>
            e.decision.action === "WAIT" && !e.decision.spokenText && prev && prev.action !== "WAIT" && Date.now() - lastShownAt.current < 15_000
              ? prev
              : ((lastShownAt.current = Date.now()), e.decision),
          );
          setDeciding(false);
          break;
        case "speech.ready":
          if (!director.claimSpeech(e.text)) break;
          setCaption(e.text);
          player.current?.play(e.responseId, e.text).catch((err: Error) => setError(`Voice: ${err.message}`));
          break;
        case "alert.created":
          if (live) notifyAlert(e.alert, people.current);
          break;
        case "notice":
          if (live) toasts.push(e.notice);
          break;
        case "error":
          setError(e.message);
          setRetryTurnId(e.retryTurnId ?? null);
          // the server ended the transcription stream; release the mic too
          if (/deepgram|transcription/i.test(e.message)) stopMic();
          break;
      }
    }, (open) => {
      setConnected(open);
      if (!open) stopMic(); // server closes the relay when the socket drops
    });
    conn.current = c;
    return c.close;
  }, []);

  // Director: its side effects, the N key, and window.ritnag for agents driving the page.
  useEffect(() => {
    let lastStatus = 0;
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    director.hooks = {
      notice: toasts.push,
      speak: async (text, tone) => {
        try {
          await post("/api/director/say", { text, tone });
        } catch (err) {
          console.warn("[director] voice:", (err as Error).message);
        }
      },
      demo: setDemo,
      chime,
      status: (s) => {
        // reported for GET /api/director/status, at most every 400 ms
        const send = () => {
          lastStatus = Date.now();
          statusTimer = null;
          void post("/api/director/status", director.status()).catch(() => {});
        };
        if (statusTimer) return;
        const wait = Math.max(0, 400 - (Date.now() - lastStatus));
        if (wait === 0 && !s.playing) send();
        else statusTimer = setTimeout(send, wait);
      },
    };
    const api = {
      run: (cmds: unknown) => director.run(cmds),
      play: (timeline: unknown, from = 0) => director.play(timeline, from),
      stop: () => director.stop(),
      /** isolate (default true): hide real data; reset(false) returns to the live app */
      reset: (isolate = true) => director.reset(isolate),
      live: () => director.reset(false),
      state: () => director.status(),
      stage: () => director.stage,
    };
    (window as unknown as { ritnag: typeof api }).ritnag = api;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey && !e.altKey) void director.nextCue(loadScript());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toasts.push]);

  // Keep the screen awake while listening (where supported). It doesn't keep a background tab's mic alive.
  useEffect(() => {
    if (!micOn || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const l = await (navigator as unknown as { wakeLock: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        /* not allowed right now (hidden tab, power saver): the page still works */
      }
    };
    const onVisible = () => document.visibilityState === "visible" && void acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [micOn]);

  // Mouth flaps only while audio is actually playing.
  const talking = speaking || stage.speaking;
  useEffect(() => {
    if (!talking) return setMouthOpen(false);
    const t = setInterval(() => setMouthOpen((o) => !o), 130);
    return () => clearInterval(t);
  }, [talking]);

  if (!hasToken) {
    return (
      <main className="gate">
        <h1>Ritnag</h1>
        <p>Open the link the server printed in the terminal (it includes the workspace token).</p>
      </main>
    );
  }
  if (!rawSnapshot) return <main className="gate">Connecting to Ritnag…</main>;
  // Director rows, people, memories and alerts appear in the panels exactly like live ones.
  const snapshot = director.view(rawSnapshot);

  // Enrollment phrases must not reach the live pipeline (they include questions).
  const openOnboarding = () => {
    stopMic();
    setOnboarding(true);
  };
  const voice = snapshot.session.voice;

  const openAlerts = snapshot.alerts.filter((a) => !a.acknowledgedAt).length;
  const shownState: ImpState = stage.active
    ? stage.state ?? (talking ? "speaking" : stage.thinking ? "thinking" : openAlerts ? "alert" : snapshot.session.listening ? "listening" : "idle")
    : speaking
      ? "speaking"
      : impState;
  const recalled = lastDecision?.memoryIds.map((id) => snapshot.memories.find((m) => m.id === id)).filter((m) => m !== undefined) ?? [];
  const asker = lastDecision?.personId ? snapshot.people.find((p) => p.id === lastDecision.personId) : undefined;
  // Plain-English "why" for the audience; the technical line stays in normal mode.
  const liveReceipt = !lastDecision
    ? null
    : lastDecision.action === "ANSWER" && recalled[0]
      ? `Recalled from memory${asker ? ` (asked ${snapshot.counts.byPerson[asker.id] ?? 1}×)` : ""}: “${recalled[0].factualAnswer}”`
      : lastDecision.action === "ALERT_OWNER"
        ? `Escalated to the owner: ${clip(lastDecision.note ?? "needs you", 90)}`
        : lastDecision.action === "LEARN"
          ? "Learned a new memory"
          : lastDecision.action === "UPDATE_PERSON"
            ? "Updated who's who"
            : null;
  const fellBack = lastDecision?.retrieval.mode === "unavailable" && lastDecision.action !== "WAIT";
  const receipt = stage.active ? stage.receipt : liveReceipt && fellBack ? `${liveReceipt} (Moss unavailable: searched recent memories)` : liveReceipt;
  const shownCaption = stage.active ? stage.caption : caption;
  const shownPartial = stage.active ? stage.partial : partial;
  const shownError = stage.active ? stage.error : error;
  const listening = snapshot.session.listening;
  const needsAttention = !connected || Boolean(snapshot.index.lastError);
  const statusText = !connected ? "Reconnecting…" : listening ? "Listening" : micOn ? "Connecting…" : "Not listening";

  return (
    <main className={`app ${openAlerts ? "has-alert" : ""} ${demo ? "demo" : ""}`}>
      <header className="topbar">
        <div className="brand">Ritnag</div>
        <span className={`status-chip ${listening ? "live" : ""} ${!connected ? "bad" : ""}`}>{statusText}</span>
        {micOn && !stage.active && <MicMeter mic={mic.current} />}
        {snapshot.session.focusMode && <span className="status-chip focus">Focus mode</span>}
        <div className="topbar-end">
          {!voice.enrolled && !demo && (
            <button className="link" onClick={openOnboarding}>
              Enroll your voice
            </button>
          )}
          <button
            className={`settings-button ${needsAttention ? "attention" : ""}`}
            onClick={() => setSettings(true)}
            aria-label="Settings"
            title={needsAttention ? "Settings (something needs attention)" : "Settings"}
          >
            Settings
          </button>
        </div>
      </header>

      <div className="banners">
        <CalibrationBar snapshot={snapshot} />
        <SuggestionBar snapshot={snapshot} />
        {micOn && /iphone|ipad/i.test(micLabel) && (
          <div className="banner warn">Listening through {micLabel}. Pick the laptop mic in Settings.</div>
        )}
        {shownError && (
          <div className="banner err">
            <span>{shownError}</span>
            {retryTurnId && !stage.active && (
              <button
                className="small"
                onClick={() =>
                  void post("/api/turn/retry", { utteranceId: retryTurnId })
                    .then(() => {
                      setError(null);
                      setRetryTurnId(null);
                    })
                    .catch((err: Error) => setError(err.message))
                }
              >
                Retry
              </button>
            )}
            <button className="small" onClick={() => (stage.active ? void director.run({ do: "error", text: null }) : setError(null))}>
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="layout">
        <section className="stage">
          <AlertsPanel snapshot={snapshot} />
          <ImpAvatar state={shownState} mouthOpen={mouthOpen} />
          <p className={`caption${thinkingCaption ? " thinking" : ""}`} aria-live="polite">
            {thinkingCaption ?? shownCaption ?? "Waiting for an interruption."}
          </p>
          <p className="receipt" title={lastDecision && !stage.active ? `${lastDecision.action} · ${decisionDetails(lastDecision).join(" · ")}` : undefined}>
            {!thinkingCaption && receipt ? receipt : "\u00a0"}
          </p>
          {ptt.ptt && micOn && !stage.active ? (
            <HoldToTalk
              ptt={ptt}
              ownerName={snapshot.ownerName}
              guestName={snapshot.people.find((p) => p.id === ptt.guestId)?.name ?? null}
              speaking={speaking}
              onStopSpeaking={() => player.current?.stop()}
            />
          ) : (
            <PrimaryControls
              snapshot={snapshot}
              micOn={micOn || (stage.active && listening)}
              speaking={speaking}
              onToggleMic={() => void toggleMic()}
              onStopSpeaking={() => player.current?.stop()}
            />
          )}
          <WhoJustAsked snapshot={snapshot} />
        </section>
        <SideTabs
          snapshot={snapshot}
          highlight={stage.active ? stage.highlight : lastDecision?.memoryIds ?? []}
          partial={shownPartial}
          tab={stage.tab}
        />
      </div>

      <Toasts toasts={toasts.toasts} onLeave={toasts.leave} onRemove={toasts.remove} />

      {settings && (
        <SettingsDrawer
          snapshot={snapshot}
          connected={connected}
          micOn={micOn}
          micLabel={micLabel}
          demo={demo}
          onDemo={setDemo}
          ptt={ptt}
          onRestartListening={() => void restartListening()}
          onEnroll={() => {
            setSettings(false);
            openOnboarding();
          }}
          onClose={() => setSettings(false)}
          onError={setError}
        />
      )}
      {onboarding && <VoiceOnboarding ownerName={snapshot.ownerName} onClose={() => setOnboarding(false)} />}
    </main>
  );
}
