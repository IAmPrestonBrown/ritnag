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
import { VoiceOnboarding } from "./components/VoiceOnboarding";
import { decisionDetails } from "./stage";
import { notifyAlert, primeAlerts } from "./notify";
import { Toasts, useToasts } from "./components/Toasts";
import { useDirector } from "./director";
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
  // Before any early return: hooks must run in the same order every render.
  const thinkingCaption = useThinkingCaption(!speaking && deciding);
  const [lastDecision, setLastDecision] = useState<DecisionSummary | null>(null);
  const [partial, setPartial] = useState<{ speakerLabel: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const director = useDirector({
    onPartial: setPartial,
    onThinking: setDeciding,
    onNotice: toasts.push,
    onError: (m) => setError(m),
  });
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
      switch (e.type) {
        case "snapshot":
          generation.current = e.snapshot.session.generation;
          people.current = e.snapshot.people;
          setSnapshot(e.snapshot);
          break;
        case "state.changed":
          setImpState(e.state);
          setDeciding(e.state === "thinking");
          if (e.caption) setCaption(e.caption);
          break;
        case "transcript.partial":
          setPartial({ speakerLabel: e.speakerLabel, text: e.text });
          break;
        case "transcript.final":
          setPartial(null);
          break;
        case "decision.completed":
          setLastDecision(e.decision);
          setDeciding(false);
          break;
        case "speech.ready":
          setCaption(e.text);
          player.current?.play(e.responseId, e.text).catch((err: Error) => setError(`Voice: ${err.message}`));
          break;
        case "alert.created":
          notifyAlert(e.alert, people.current);
          break;
        case "notice":
          toasts.push(e.notice);
          break;
        case "error":
          setError(e.message);
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

  // Mouth flaps only while audio is actually playing.
  useEffect(() => {
    if (!speaking) return setMouthOpen(false);
    const t = setInterval(() => setMouthOpen((o) => !o), 130);
    return () => clearInterval(t);
  }, [speaking]);

  if (!hasToken) {
    return (
      <main className="gate">
        <h1>Ritnag</h1>
        <p>Open the link the server printed in the terminal (it includes the workspace token).</p>
      </main>
    );
  }
  if (!rawSnapshot) return <main className="gate">Connecting to Ritnag…</main>;
  // Director rows (scripted intro) appear in the panels exactly like heard speech.
  const snapshot = director.overlay(rawSnapshot);

  // Enrollment phrases must not reach the live pipeline (they include questions).
  const openOnboarding = () => {
    stopMic();
    setOnboarding(true);
  };
  const voice = snapshot.session.voice;

  const shownState: ImpState = speaking ? "speaking" : impState;
  const recalled = lastDecision?.memoryIds.map((id) => snapshot.memories.find((m) => m.id === id)).filter((m) => m !== undefined) ?? [];
  const asker = lastDecision?.personId ? snapshot.people.find((p) => p.id === lastDecision.personId) : undefined;
  // Plain-English "why" for the audience; the technical line stays in normal mode.
  const receipt = !lastDecision
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
  const openAlerts = snapshot.alerts.filter((a) => !a.acknowledgedAt).length;
  // A running director script looks live.
  const listening = snapshot.session.listening || director.active;
  const needsAttention = !connected || Boolean(snapshot.index.lastError);
  const statusText = !connected ? "Reconnecting…" : listening ? "Listening" : micOn ? "Connecting…" : "Not listening";

  return (
    <main className={`app ${openAlerts ? "has-alert" : ""} ${demo ? "demo" : ""}`}>
      <header className="topbar">
        <div className="brand">Ritnag</div>
        <span className={`status-chip ${listening ? "live" : ""} ${!connected ? "bad" : ""}`}>{statusText}</span>
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
        {error && (
          <div className="banner err">
            <span>{error}</span>
            <button className="small" onClick={() => setError(null)}>
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
            {thinkingCaption ?? caption ?? "Waiting for an interruption."}
          </p>
          <p className="receipt" title={lastDecision ? `${lastDecision.action} · ${decisionDetails(lastDecision).join(" · ")}` : undefined}>
            {!thinkingCaption && receipt ? receipt : "\u00a0"}
          </p>
          <PrimaryControls
            snapshot={snapshot}
            micOn={micOn || director.active}
            speaking={speaking}
            onToggleMic={() => void toggleMic()}
            onStopSpeaking={() => player.current?.stop()}
          />
          <WhoJustAsked snapshot={snapshot} />
        </section>
        <SideTabs snapshot={snapshot} highlight={lastDecision?.memoryIds ?? []} partial={partial} />
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
          director={director}
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
