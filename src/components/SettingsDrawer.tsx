import { useEffect, useState, type ReactNode } from "react";
import type { Snapshot } from "../../shared/events";
import { post } from "../api";
import { MicPicker } from "./MicPicker";
import { SpeakerPicker } from "./SpeakerPicker";
import { RecordClips } from "./RecordClips";
import { VoicePanel } from "./VoiceOnboarding";
import { AdvancedControls, DebugDrawer, SpeakerMap } from "./SessionControls";
import { DEFAULT_SCRIPT, director, loadScript, parseScript, saveScript, useStage } from "../director";
import { DemoSettings } from "./DemoControls";
import type { PushToTalk } from "../pushToTalk";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/**
 * Everything technical, out of the way: audio devices, owner voice, provider status, typed input and
 * dev tools. Opened from the gear in the top bar; Esc or the backdrop closes it.
 */
export function SettingsDrawer({
  snapshot,
  connected,
  micOn,
  micLabel,
  demo,
  onDemo,
  ptt,
  onRestartListening,
  onEnroll,
  onClose,
  onError,
}: {
  snapshot: Snapshot;
  connected: boolean;
  micOn: boolean;
  micLabel: string;
  demo: boolean;
  onDemo: (on: boolean) => void;
  ptt: PushToTalk;
  onRestartListening: () => void;
  onEnroll: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const idx = snapshot.index;
  const voice = snapshot.session.voice;
  const status: [string, boolean, string][] = [
    ["Server", connected, connected ? "connected" : "reconnecting…"],
    [
      "Speech-to-text",
      snapshot.session.stt?.state === "connected",
      !snapshot.session.stt || snapshot.session.stt.state === "off" ? "off" : `${snapshot.session.stt.provider} · ${snapshot.session.stt.state}${snapshot.session.stt.detail ? ` · ${snapshot.session.stt.detail}` : ""}`,
    ],
    ["Memory search (Moss)", idx.configured && idx.ready && !idx.lastError, !idx.configured ? "not configured" : idx.lastError ? idx.lastError : idx.ready ? `${idx.docCount} docs${idx.pushPending ? " · syncing" : ""}` : "starting…"],
    ["Owner voice", voice.active, voice.active ? "verifying" : voice.enrolled ? "loading…" : "not enrolled"],
  ];

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>Settings</h2>
          <button className="small" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        <Section title="Audio">
          <div className="stack">
            <MicPicker live={micOn} inUse={micLabel} />
            <SpeakerPicker />
            <p className="muted small-print">Wearing headphones? Send the imp's voice to a room speaker; alerts stay in your headphones.</p>
          </div>
        </Section>

        {demo && (
          <Section title="Demo">
            <DemoSettings snapshot={snapshot} ptt={ptt} onRestartListening={onRestartListening} onError={onError} />
          </Section>
        )}

        <Section title="Status">
          <ul className="status-list">
            {status.map(([name, ok, detail]) => (
              <li key={name}>
                <span className={`dot ${ok ? "ok" : "bad"}`} aria-hidden="true" />
                <span>{name}</span>
                <span className="muted">{detail}</span>
              </li>
            ))}
          </ul>
          {idx.configured && (
            <button className="small" onClick={() => post("/api/index/rebuild").catch((e: Error) => onError(e.message))}>
              Rebuild memory index
            </button>
          )}
        </Section>

        <Section title="Owner voice">
          <VoicePanel snapshot={snapshot} onEnroll={onEnroll} />
        </Section>

        {snapshot.session.connectionId && snapshot.session.speechLabels.length > 0 && (
          <Section title="Voices this session">
            <SpeakerMap snapshot={snapshot} />
          </Section>
        )}

        <Section title="Session">
          <AdvancedControls snapshot={snapshot} />
          <label className="toggle">
            <input type="checkbox" checked={demo} onChange={(e) => onDemo(e.target.checked)} /> Projector mode <span className="muted">(D)</span>
          </label>
        </Section>

        <Section title="Director (scripted intro)">
          <DirectorControls />
        </Section>

        <Section title="Developer">
          <DebugDrawer snapshot={snapshot} />
          <RecordClips listening={micOn} />
        </Section>
      </aside>
    </div>
  );
}

/** The hand-driven text script (N = next cue). Timelines and agents use the same commands; see docs/DIRECTOR.md. */
function DirectorControls() {
  const stage = useStage();
  const [script, setScript] = useState(loadScript);
  const edit = (s: string) => {
    setScript(s);
    saveScript(s);
  };
  return (
    <>
      <p className="muted">
        Press <kbd>N</kbd> for the next cue (one paragraph). Rows, pop-ups and the imp's lines play on the real UI; nothing is heard or
        decided. Cue {stage.cue} of {parseScript(script).length}
        {stage.playing ? ` · timeline playing (${Math.round((stage.position ?? 0) / 1000)} s)` : ""}.
      </p>
      <textarea className="director-script" rows={10} spellCheck={false} value={script} onChange={(e) => edit(e.target.value)} />
      <div className="row">
        <button className="small" onClick={() => director.reset(true)}>
          Clean stage
        </button>
        <button className="small" onClick={() => director.reset(false)}>
          Back to live
        </button>
        <button className="small" onClick={() => edit(DEFAULT_SCRIPT)}>
          Default script
        </button>
      </div>
    </>
  );
}
