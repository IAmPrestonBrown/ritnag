import type { Snapshot } from "../../shared/events";
import type { Person, Tone } from "../../shared/schemas";
import { post } from "../api";

const TONES: Tone[] = ["neutral", "friendly", "playful", "sarcastic", "annoyed", "savage"];

const speakerName = (s: Snapshot, u: Snapshot["transcript"][number]) =>
  u.isOwner ? `${s.ownerName} (owner)` : s.people.find((p) => p.id === u.personId)?.name ?? `unknown · ${u.speakerLabel}`;

export function TranscriptPanel({ snapshot, partial }: { snapshot: Snapshot; partial: { speakerLabel: string; text: string } | null }) {
  const rows = snapshot.transcript.slice(-14);
  return (
    <section className="panel">
      <h2>Transcript</h2>
      {rows.length === 0 && !partial && <p className="muted">Nothing heard yet.</p>}
      <ol className="transcript">
        {rows.map((u) => (
          <li key={u.id} className={`${u.isOwner ? "owner" : u.personId ? "known" : "unknown"}${u.ownerSuspect ? " suspect" : ""}`}>
            <span className="who">{speakerName(snapshot, u)}</span>
            <span className="what">
              {u.text}
              {u.ownerSuspect && <span className="tag warn" title="Labeled as you, but it talks to you. Not learned from.">not you?</span>}
            </span>
            <span className="row-actions">
              {u.source === "typed" ? (
                <span className="tag">typed</span>
              ) : (
                <button
                  className="small"
                  title={u.isOwner ? "This wasn't me: re-run as a visitor" : "This was me: re-run as the owner"}
                  onClick={() => void post("/api/utterance/reattribute", { utteranceId: u.id, asOwner: !u.isOwner })}
                >
                  {u.isOwner ? "not me" : "that was me"}
                </button>
              )}
            </span>
          </li>
        ))}
        {partial && (
          <li className="partial">
            <span className="who">{partial.speakerLabel}</span>
            <span className="what">{partial.text}…</span>
          </li>
        )}
      </ol>
    </section>
  );
}

export function PeoplePanel({ snapshot }: { snapshot: Snapshot }) {
  const update = (p: Person, patch: Partial<Person>) => post("/api/people/update", { personId: p.id, ...patch });
  return (
    <section className="panel">
      <h2>People</h2>
      {snapshot.people.length === 0 && <p className="muted">No one named yet. Tell the imp “That was Bob…”.</p>}
      <ul className="people">
        {snapshot.people.map((p) => (
          <li key={p.id}>
            <div className="person-head">
              <strong>{p.name}</strong>
              {p.relationship && <span className="muted"> · {p.relationship}</span>}
              <span className="count" title="Repeat questions answered for this person">
                {snapshot.counts.byPerson[p.id] ?? 0}×
              </span>
            </div>
            <div className="person-controls">
              <select value={p.tone} onChange={(e) => update(p, { tone: e.target.value as Tone })}>
                {TONES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <label>
                <input type="checkbox" checked={p.priority} onChange={(e) => update(p, { priority: e.target.checked })} /> priority
              </label>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MemoryPanel({ snapshot, highlight }: { snapshot: Snapshot; highlight: string[] }) {
  const now = Date.now();
  const active = snapshot.memories.filter((m) => !m.supersededBy && (m.validUntil === null || m.validUntil > now));
  const byId = new Map(snapshot.transcript.map((u) => [u.id, u]));
  return (
    <section className="panel">
      <h2>
        Memory <span className="muted">({active.length})</span>
        <span className="count total" title="Total repeat questions handled">{snapshot.counts.total} repeats</span>
      </h2>
      {active.length === 0 && <p className="muted">Empty. Answer a question once and it lands here.</p>}
      <ul className="memories">
        {active
          .slice()
          .reverse()
          .map((m) => (
            <li key={m.id} className={highlight.includes(m.id) ? "hit" : ""}>
              {m.canonicalQuestion && <div className="q">{m.canonicalQuestion}</div>}
              <div className="a">{m.factualAnswer}</div>
              <div className="meta">
                {m.kind} · asked {m.timesAsked}× {m.validUntil && "· expires"}{" "}
                {m.sourceUtteranceIds.length === 0
                  ? "· taught in UI"
                  : `· from “${m.sourceUtteranceIds.map((id) => byId.get(id)?.text).filter(Boolean).join(" / ").slice(0, 80)}”`}
              </div>
            </li>
          ))}
      </ul>
    </section>
  );
}

export function AlertsPanel({ snapshot }: { snapshot: Snapshot }) {
  const open = snapshot.alerts.filter((a) => !a.acknowledgedAt);
  if (open.length === 0) return null;
  const byId = new Map(snapshot.transcript.map((u) => [u.id, u]));
  return (
    <section className="panel alerts">
      <h2>Needs you</h2>
      <ul>
        {open.map((a) => (
          <li key={a.id}>
            <div>
              <strong>{snapshot.people.find((p) => p.id === a.personId)?.name ?? "Someone"}:</strong>{" "}
              “{byId.get(a.questionUtteranceId)?.text ?? "…"}”
            </div>
            <div className="muted">{a.reason}</div>
            <button onClick={() => post("/api/alerts/acknowledge", { alertId: a.id })}>Acknowledge</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
