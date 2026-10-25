import { useState } from "react";
import type { Snapshot } from "../../shared/events";
import { post } from "../api";
import { primeAlerts } from "../notify";

const TYPED_SPEAKERS = ["owner", "guest-A", "guest-B", "guest-C"];

export function SessionControls({
  snapshot,
  onStopSpeaking,
  micOn,
  onToggleMic,
}: {
  snapshot: Snapshot;
  onStopSpeaking: () => void;
  micOn: boolean;
  onToggleMic: () => void;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <div className="controls">
      <button className={micOn ? "on" : ""} onClick={onToggleMic}>
        {micOn ? "Stop listening" : "Start listening"}
      </button>
      {snapshot.session.listening && !snapshot.session.voice.active && (
        <button onClick={() => post("/api/owner/calibrate")}>Recalibrate owner</button>
      )}
      <button
        className={snapshot.session.focusMode ? "on" : ""}
        onClick={() => {
          // focus mode is when alerts matter most; ask for notifications from this click
          if (!snapshot.session.focusMode) primeAlerts();
          void post("/api/focus", { focusMode: !snapshot.session.focusMode });
        }}
      >
        Focus mode: {snapshot.session.focusMode ? "on" : "off"}
      </button>
      <button onClick={onStopSpeaking}>Stop speaking</button>
      <button onClick={() => void post("/api/speech/test")}>Test voice</button>
      {confirmReset ? (
        <>
          <button className="danger" onClick={() => post("/api/session/reset", { everything: true }).then(() => setConfirmReset(false))}>
            Wipe memory + people
          </button>
          <button onClick={() => post("/api/session/reset", {}).then(() => setConfirmReset(false))}>Keep people</button>
          <button onClick={() => setConfirmReset(false)}>Cancel</button>
        </>
      ) : (
        <button onClick={() => setConfirmReset(true)}>Reset demo</button>
      )}
    </div>
  );
}

/** Typed fallback + manual recovery controls. Clearly labeled: typed turns are not speech recognition. */
export function DebugDrawer({ snapshot }: { snapshot: Snapshot }) {
  const [speaker, setSpeaker] = useState("guest-A");
  const [text, setText] = useState("");
  const [teachQ, setTeachQ] = useState("");
  const [teachA, setTeachA] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e: Error) => setError(e.message));

  const send = () => {
    if (!text.trim()) return;
    run(post("/api/turn", { text, speakerLabel: speaker, asOwner: speaker === "owner" }));
    setText("");
  };

  const bound = (label: string) => snapshot.session.bindings[`typed|${label}`] ?? "";

  return (
    <details className="panel debug" open>
      <summary>Typed input &amp; manual controls</summary>
      <div className="row">
        <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
          {TYPED_SPEAKERS.map((s) => (
            <option key={s} value={s}>
              {s === "owner" ? `${snapshot.ownerName} (owner)` : `${s}${bound(s) ? ` = ${snapshot.people.find((p) => p.id === bound(s))?.name}` : ""}`}
            </option>
          ))}
        </select>
        <input
          value={text}
          placeholder="Type what this speaker says…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send}>Say</button>
      </div>

      <div className="row">
        <span className="muted">Correct speaker:</span>
        {TYPED_SPEAKERS.filter((s) => s !== "owner").map((label) => (
          <label key={label} className="bind">
            {label}
            <select
              value={bound(label)}
              onChange={(e) => run(post("/api/identity/confirm", { speakerLabel: label, personId: e.target.value || null }))}
            >
              <option value="">unknown</option>
              {snapshot.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="row">
        <span className="muted">Teach answer:</span>
        <input value={teachQ} placeholder="Question" onChange={(e) => setTeachQ(e.target.value)} />
        <input value={teachA} placeholder="Factual answer" onChange={(e) => setTeachA(e.target.value)} />
        <button
          onClick={() => {
            if (!teachQ.trim() || !teachA.trim()) return;
            run(post("/api/owner/teach", { canonicalQuestion: teachQ, factualAnswer: teachA }));
            setTeachQ("");
            setTeachA("");
          }}
        >
          Teach
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </details>
  );
}

/** Owner calibration: shown on every new mic connection until the owner's label is confirmed. */
export function CalibrationBar({ snapshot }: { snapshot: Snapshot }) {
  const { calibration, listening } = snapshot.session;
  if (!listening || !calibration.active) return null;
  return (
    <div className="banner calibrate">
      {calibration.candidate ? (
        <>
          Heard <strong>{calibration.candidate}</strong>. Was that you, {snapshot.ownerName}?{" "}
          <button className="small" onClick={() => post("/api/owner/speaker", { speakerLabel: calibration.candidate })}>
            Yes, that's me
          </button>{" "}
          <button className="small" onClick={() => post("/api/owner/calibrate")}>
            Try again
          </button>
        </>
      ) : (
        <>
          Calibrating: {snapshot.ownerName}, say <em>“Hey Ritnag, it's {snapshot.ownerName}.”</em>
        </>
      )}
    </div>
  );
}

/**
 * "Who just asked?": one click binds the most recent visitor's voice label to a person.
 * A manual, visible choice — the honest recovery path when diarization is shaky.
 */
export function WhoJustAsked({ snapshot }: { snapshot: Snapshot }) {
  const { connectionId, bindings } = snapshot.session;
  const last = [...snapshot.transcript].reverse().find((u) => !u.isOwner && u.source === "speech" && u.connectionId === connectionId);
  if (!connectionId || !last || snapshot.people.length === 0) return null;
  const current = bindings[`${connectionId}|${last.speakerLabel}`] ?? "";
  const bind = (personId: string | null) =>
    post("/api/identity/confirm", { connectionId, speakerLabel: last.speakerLabel, personId });
  return (
    <div className="who-chips">
      <span className="muted">Who just spoke ({last.speakerLabel})?</span>
      {snapshot.people.map((p) => (
        <button key={p.id} className={`small ${current === p.id ? "on" : ""}`} onClick={() => void bind(p.id)}>
          {p.name}
        </button>
      ))}
      <button className={`small ${current === "" ? "on" : ""}`} onClick={() => void bind(null)}>
        unknown
      </button>
    </div>
  );
}

/** "Is spk2 Bob?": a visitor named themself. Applied only on an owner click. */
export function SuggestionBar({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.session.suggestions[0];
  if (!s) return null;
  const answer = (accept: boolean) =>
    post("/api/identity/suggestion", { connectionId: s.connectionId, speakerLabel: s.speakerLabel, accept });
  return (
    <div className="banner calibrate">
      {s.speakerLabel} said they're <strong>{s.name}</strong>. Is that right?{" "}
      <button className="small" onClick={() => void answer(true)}>
        Yes, that's {s.name}
      </button>{" "}
      <button className="small" onClick={() => void answer(false)}>
        No
      </button>
    </div>
  );
}

/** Live speaker labels for this connection. Manual mapping is a recovery control, not voice recognition. */
export function SpeakerMap({ snapshot }: { snapshot: Snapshot }) {
  const { speechLabels, connectionId, ownerSpeakerLabel, bindings, voice } = snapshot.session;
  if (!connectionId || speechLabels.length === 0) return null;
  const valueFor = (label: string) =>
    label === ownerSpeakerLabel ? "__owner" : bindings[`${connectionId}|${label}`] ?? "";
  const change = (label: string, value: string) => {
    if (value === "__owner") return post("/api/owner/speaker", { speakerLabel: label });
    const unOwner = label === ownerSpeakerLabel ? post("/api/owner/speaker", { speakerLabel: null }) : Promise.resolve();
    return unOwner.then(() => post("/api/identity/confirm", { connectionId, speakerLabel: label, personId: value || null }));
  };
  return (
    <section className="panel">
      <h2>Voices this session</h2>
      <ul className="people">
        {speechLabels.map((label) => (
          <li key={label} className="person-controls">
            <span>{label}</span>
            <select value={valueFor(label)} onChange={(e) => void change(label, e.target.value)}>
              <option value="">unknown</option>
              {/* With a voice profile, owner authority comes from the voice check, never from a label. */}
              {!voice.active && <option value="__owner">{snapshot.ownerName} (owner)</option>}
              {snapshot.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <p className="muted small-print">
        Labels come from live diarization and reset when the mic reconnects.
        {voice.active && ` ${snapshot.ownerName} is recognized by voice; labels here are for visitors.`}
      </p>
    </section>
  );
}
