import { useEffect, useRef, useState } from "react";
import type { DecisionSummary, ImpState, ServerEvent, Snapshot } from "../shared/events";
import { connectEvents, hasToken, post } from "./api";
import { Player } from "./audio/playback";
import { ImpAvatar } from "./components/ImpAvatar";
import { AlertsPanel, MemoryPanel, PeoplePanel, TranscriptPanel } from "./components/Panels";
import { DebugDrawer, SessionControls } from "./components/SessionControls";

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [impState, setImpState] = useState<ImpState>("idle");
  const [caption, setCaption] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(false);
  const [lastDecision, setLastDecision] = useState<DecisionSummary | null>(null);
  const [partial, setPartial] = useState<{ speakerLabel: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const player = useRef<Player | null>(null);

  player.current ??= new Player((isSpeaking, text) => {
    setSpeaking(isSpeaking);
    if (text) setCaption(text);
  });

  useEffect(() => {
    if (!hasToken) return;
    const conn = connectEvents((e: ServerEvent) => {
      if ("generation" in e && e.generation < generation.current) return; // stale
      switch (e.type) {
        case "snapshot":
          generation.current = e.snapshot.session.generation;
          setSnapshot(e.snapshot);
          break;
        case "state.changed":
          setImpState(e.state);
          if (e.caption) setCaption(e.caption);
          if (e.state !== "error") setError(null);
          break;
        case "transcript.partial":
          setPartial({ speakerLabel: e.speakerLabel, text: e.text });
          break;
        case "transcript.final":
          setPartial(null);
          break;
        case "decision.completed":
          setLastDecision(e.decision);
          break;
        case "speech.ready":
          setCaption(e.text);
          player.current?.play(e.responseId, e.text).catch((err: Error) => setError(`Voice: ${err.message}`));
          break;
        case "error":
          setError(e.message);
          break;
      }
    }, setConnected);
    return conn.close;
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
        <h1>Imp</h1>
        <p>Open the link the server printed in the terminal (it includes the workspace token).</p>
      </main>
    );
  }
  if (!snapshot) return <main className="gate">Connecting to imp…</main>;

  const shownState: ImpState = speaking ? "speaking" : impState;
  const openAlerts = snapshot.alerts.filter((a) => !a.acknowledgedAt).length;
  const idx = snapshot.index;

  return (
    <main className={`app ${openAlerts ? "has-alert" : ""}`}>
      <header className="status">
        <strong>Imp</strong>
        <span className={`pill ${connected ? "ok" : "bad"}`}>{connected ? "connected" : "reconnecting…"}</span>
        <span className={`pill ${snapshot.session.listening ? "live" : ""}`}>
          mic {snapshot.session.listening ? "LIVE" : "off · typed input only"}
        </span>
        <span className="pill">memory: local JSON</span>
        <span className={`pill ${!idx.configured ? "bad" : idx.lastError ? "bad" : idx.ready ? "ok" : ""}`}>
          Moss {!idx.configured ? "not configured" : idx.ready ? `${idx.docCount} docs${idx.pushPending ? " · syncing" : ""}` : "not ready"}
        </span>
        {idx.configured && (
          <button className="small" onClick={() => post("/api/index/rebuild").catch((e: Error) => setError(e.message))}>
            Rebuild index
          </button>
        )}
      </header>
      {idx.lastError && <div className="banner warn">Moss: {idx.lastError}. Local memory is intact; rebuild the index to resync.</div>}
      {error && (
        <div className="banner err">
          {error} <button className="small" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="layout">
        <section className="stage">
          <ImpAvatar state={shownState} mouthOpen={mouthOpen} />
          <p className="caption">{caption ?? "Waiting for an interruption."}</p>
          {lastDecision && (
            <p className="decision muted">
              {lastDecision.action}
              {lastDecision.memoryIds.length > 0 && ` · cited ${lastDecision.memoryIds.join(", ")}`}
              {` · ${lastDecision.retrieval.mode === "moss" ? `Moss ${lastDecision.retrieval.hits.length} hits` : "Moss unavailable"}`}
              {` · ${lastDecision.latencyMs} ms`}
              {lastDecision.note && ` · ${lastDecision.note}`}
            </p>
          )}
          <SessionControls snapshot={snapshot} onStopSpeaking={() => player.current?.stop()} />
          <AlertsPanel snapshot={snapshot} />
        </section>
        <div className="side">
          <MemoryPanel snapshot={snapshot} highlight={lastDecision?.memoryIds ?? []} />
          <PeoplePanel snapshot={snapshot} />
          <TranscriptPanel snapshot={snapshot} partial={partial} />
        </div>
      </div>
      <DebugDrawer snapshot={snapshot} />
    </main>
  );
}
