import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionSummary, Snapshot } from "../../shared/events";
import { get, post } from "../api";
import type { MicCapture } from "../audio/capture";

type Role = "owner" | "guest";
type InputMode = "ptt" | "continuous";

interface Check {
  configured: boolean;
  ok: boolean | null;
  ms: number | null;
  detail: string | null;
}
interface Health {
  checkedAt: number;
  claude: Check;
  cartesia: Check;
  moss: Check;
  speechmatics: Check;
  deepgram: Check;
}
interface Readiness {
  ready: boolean;
  profile: "demo" | "everyday";
  mode: "learn" | "prepared" | null;
  memories: number;
  indexed: number;
  problems: string[];
}

const MODE_KEY = "imp.demoInput";
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * Demo Mode: one screen for running the demo in a loud room. Push-to-talk with explicit "Owner speaking" /
 * "Guest speaking" (manual identity, shown as such), live status for every provider, typed fallback through
 * the same pipeline, and a scoped "Start fresh demo" that waits until the demo index is consistent.
 */
export function DemoPanel({
  snapshot,
  mic,
  micOn,
  micLabel,
  speaking,
  partial,
  lastDecision,
  onToggleMic,
  onRestartListening,
  onStopSpeaking,
  onError,
}: {
  snapshot: Snapshot;
  mic: MicCapture;
  micOn: boolean;
  micLabel: string;
  speaking: boolean;
  partial: { speakerLabel: string; text: string } | null;
  lastDecision: DecisionSummary | null;
  onToggleMic: () => void;
  onRestartListening: () => void;
  onStopSpeaking: () => void;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<InputMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "continuous" ? "continuous" : "ptt";
    } catch {
      return "ptt";
    }
  });
  const [holding, setHolding] = useState<Role | null>(null);
  const [assigned, setAssigned] = useState<Role | null>(null); // continuous mode
  const [guestId, setGuestId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [starting, setStarting] = useState<"learn" | "prepared" | null>(null);
  const [typed, setTyped] = useState("");
  const holdingRef = useRef<Role | null>(null);

  // the gate follows the input mode: push-to-talk hears only while a button is held
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    mic.gate = mode === "continuous" || holdingRef.current !== null;
    mic.assign(mode === "continuous" ? assigned : holdingRef.current, null);
  }, [mode, assigned, mic, micOn]);
  // leaving Demo Mode: back to normal open-mic, automatic identity
  useEffect(
    () => () => {
      mic.gate = true;
      mic.assign(null);
    },
    [mic],
  );

  const guestPerson = guestId || null;
  const press = useCallback(
    (role: Role) => {
      if (!micOn || holdingRef.current) return;
      holdingRef.current = role;
      setHolding(role);
      mic.assign(role, role === "guest" ? guestPerson : null); // before the audio it labels
      mic.gate = true;
    },
    [mic, micOn, guestPerson],
  );
  const release = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = null;
    setHolding(null);
    mic.gate = false;
    mic.assign(null);
  }, [mic]);

  // O / G held = owner / guest speaking (push-to-talk); ignored while typing
  useEffect(() => {
    if (mode !== "ptt") return;
    const down = (e: KeyboardEvent) => {
      if (e.repeat || isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      if (e.key === "o" || e.key === "O") press("owner");
      if (e.key === "g" || e.key === "G") press("guest");
    };
    const up = (e: KeyboardEvent) => {
      if ((e.key === "o" || e.key === "O") && holdingRef.current === "owner") release();
      if ((e.key === "g" || e.key === "G") && holdingRef.current === "guest") release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [mode, press, release]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await get<Health>("/api/health/check"));
    } catch (err) {
      onError(`Provider check: ${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  }, [onError]);
  useEffect(() => {
    void check();
    void get<Readiness>("/api/demo/ready").then(setReadiness).catch(() => {});
  }, [check]);

  const startFresh = async (m: "learn" | "prepared") => {
    release();
    setStarting(m);
    setReadiness(null);
    try {
      let r = await post<Readiness>("/api/demo/start", { mode: m });
      // the demo index rebuilds asynchronously on a cold start: wait (bounded) until it matches
      for (let i = 0; i < 10 && !r.ready && r.problems.every((p) => !/configured/.test(p)); i++) {
        await new Promise((res) => setTimeout(res, 500));
        r = await get<Readiness>("/api/demo/ready");
      }
      setReadiness(r);
      void check();
    } catch (err) {
      onError(`Start fresh demo: ${(err as Error).message}`);
    } finally {
      setStarting(null);
    }
  };

  const sendTyped = async (role: Role) => {
    const text = typed.trim();
    if (!text) return;
    try {
      // same pipeline as speech: memory, Moss retrieval, Claude, Cartesia. Shown as "typed".
      await post("/api/turn", { text, speakerLabel: role === "owner" ? "owner" : "guest-A", asOwner: role === "owner" });
      setTyped("");
    } catch (err) {
      onError(`Typed input: ${(err as Error).message}`);
    }
  };

  const nameOf = (u: Snapshot["transcript"][number]) =>
    u.isOwner ? snapshot.ownerName : snapshot.people.find((p) => p.id === u.personId)?.name ?? `Guest (${u.speakerLabel})`;
  const rows = snapshot.transcript.slice(-6);
  const last = snapshot.transcript.at(-1);
  const stt = snapshot.session.stt;
  const sttText = !stt || stt.state === "off" ? "off" : `${stt.provider} · ${stt.state}`;
  const r = lastDecision?.retrieval;
  const recalled = lastDecision?.memoryIds.map((id) => snapshot.memories.find((m) => m.id === id)).filter((m) => m !== undefined)[0];
  const blocked = starting !== null;

  return (
    <section className="card demo-panel" aria-label="Demo controls">
      <div className="demo-head">
        <strong>Demo Mode</strong>
        <span className="muted">
          {snapshot.profile === "demo" ? "demo records (separate from everyday data)" : "everyday data: run `npm run demo` for resettable demo records"}
        </span>
      </div>

      <div className="demo-status">
        <StatusRow label="Mic" ok={micOn} text={micOn ? micLabel || "on" : "off"}>
          <MicMeter mic={mic} />
        </StatusRow>
        <StatusRow label="Speech-to-text" ok={stt?.state === "connected"} warn={stt?.state === "connecting" || stt?.state === "reconnecting"} text={sttText} title={stt?.detail ?? undefined} />
        <StatusRow label="Playback" ok={true} text={speaking ? "speaking" : "idle"}>
          {speaking && (
            <button className="small" onClick={onStopSpeaking}>
              Stop speaking
            </button>
          )}
        </StatusRow>
        <StatusRow
          label="Retrieval"
          ok={r ? r.mode === "moss" : null}
          text={!r ? "no question yet" : r.mode === "moss" ? `Moss ran · ${r.hits.length} hit${r.hits.length === 1 ? "" : "s"}` : `fallback: ${r.fallbackReason ?? "Moss unavailable"}`}
        />
        <div className="demo-providers">
          {health ? (
            (["claude", "cartesia", "moss", "speechmatics", "deepgram"] as const)
              .filter((k) => health[k].configured)
              .map((k) => (
                <span key={k} className={`prov ${health[k].ok ? "ok" : "bad"}`} title={health[k].detail ?? ""}>
                  {k} {health[k].ok ? `connected${health[k].ms !== null ? ` ${health[k].ms}ms` : ""}` : `failed: ${health[k].detail}`}
                </span>
              ))
          ) : (
            <span className="muted">checking providers…</span>
          )}
          <button className="small" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check providers"}
          </button>
        </div>
      </div>

      <div className="demo-input">
        <div className="seg" role="radiogroup" aria-label="Input mode">
          <button className={mode === "ptt" ? "on" : ""} onClick={() => setMode("ptt")}>
            Push-to-talk
          </button>
          <button className={mode === "continuous" ? "on" : ""} onClick={() => setMode("continuous")}>
            Continuous
          </button>
        </div>
        {!micOn ? (
          <button className="primary big" onClick={onToggleMic}>
            Turn on the mic
          </button>
        ) : mode === "ptt" ? (
          <div className="ptt">
            {(["owner", "guest"] as const).map((role) => (
              <button
                key={role}
                className={`ptt-btn ${role} ${holding === role ? "held" : ""}`}
                disabled={blocked}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  press(role);
                }}
                onPointerUp={release}
                onPointerCancel={release}
                onLostPointerCapture={release}
              >
                {holding === role ? "Listening… release to send" : `Hold: ${role === "owner" ? `${snapshot.ownerName} (owner)` : "Guest"} speaking`}
                <small>{role === "owner" ? "or hold O" : "or hold G"}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="seg" role="radiogroup" aria-label="Who is speaking">
            {([null, "owner", "guest"] as const).map((role) => (
              <button key={role ?? "auto"} className={assigned === role ? "on" : ""} onClick={() => setAssigned(role)}>
                {role === null ? "Automatic (voice ID)" : role === "owner" ? "Owner speaking" : "Guest speaking"}
              </button>
            ))}
          </div>
        )}
        {micOn && (
          <label className="guest-pick">
            Guest is
            <select value={guestId} onChange={(e) => setGuestId(e.target.value)}>
              <option value="">unknown (let the owner name them)</option>
              {snapshot.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="muted">manual identity is labeled "manual" in the transcript</span>
          </label>
        )}
      </div>

      <div className="demo-now">
        {partial ? (
          <>
            <span className="who">
              {holding === "owner" ? snapshot.ownerName : holding === "guest" ? snapshot.people.find((p) => p.id === guestId)?.name ?? "Guest" : partial.speakerLabel}
              {holding && <span className="tag warn">manual</span>}
            </span>{" "}
            <span className="what">{partial.text}…</span>
          </>
        ) : last ? (
          <>
            <span className="who">
              {nameOf(last)}
              {last.source === "typed" ? <span className="tag">typed</span> : last.ownerBasis === "manual" ? <span className="tag warn">manual</span> : null}
            </span>{" "}
            <span className="what">{last.text}</span>
          </>
        ) : (
          <span className="muted">Nobody has spoken yet.</span>
        )}
      </div>

      {recalled && (
        <div className="demo-recalled">
          <span className="muted">Retrieved memory</span> {recalled.canonicalQuestion && <span className="q">{recalled.canonicalQuestion}</span>}{" "}
          <strong>{recalled.factualAnswer}</strong>
          {recalled.context === "prepared example" && <span className="tag">prepared example</span>}
        </div>
      )}

      <ol className="demo-transcript">
        {rows.map((u) => (
          <li key={u.id} className={u.isOwner ? "owner" : ""}>
            <span className="who">
              {nameOf(u)}
              {u.source === "typed" ? <span className="tag">typed</span> : u.ownerBasis === "manual" ? <span className="tag warn">manual</span> : null}
            </span>
            <span className="what">{u.text}</span>
          </li>
        ))}
      </ol>

      <div className="demo-typed">
        <input
          value={typed}
          placeholder="Typed fallback: type what was said"
          disabled={blocked}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void sendTyped("guest")}
        />
        <button disabled={blocked || !typed.trim()} onClick={() => void sendTyped("guest")}>
          Guest asks
        </button>
        <button disabled={blocked || !typed.trim()} onClick={() => void sendTyped("owner")}>
          Owner says
        </button>
      </div>

      <div className="demo-reset">
        <span className="muted">Start fresh demo:</span>
        <button disabled={blocked || snapshot.profile !== "demo"} onClick={() => void startFresh("learn")}>
          {starting === "learn" ? "Resetting…" : "A · Learn live"}
        </button>
        <button disabled={blocked || snapshot.profile !== "demo"} onClick={() => void startFresh("prepared")}>
          {starting === "prepared" ? "Resetting…" : "B · Prepared example (Bob)"}
        </button>
        <button disabled={blocked} onClick={onRestartListening} title="New transcription session; memories are kept">
          Restart listening
        </button>
        {readiness && (
          <span className={`ready ${readiness.ready ? "ok" : "bad"}`}>
            {readiness.ready
              ? `Ready · ${readiness.mode === "prepared" ? "prepared example: Bob (sample, sarcastic) + 1 sample memory" : readiness.mode === "learn" ? "learn live: no memories" : `${readiness.memories} memories`}`
              : `Not ready: ${readiness.problems.join(" ")}`}
          </span>
        )}
      </div>
    </section>
  );
}

function StatusRow({
  label,
  ok,
  warn,
  text,
  title,
  children,
}: {
  label: string;
  ok: boolean | null;
  warn?: boolean;
  text: string;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="status-row" title={title}>
      <span className={`dot ${warn ? "warn" : ok === null ? "" : ok ? "ok" : "bad"}`} />
      <span className="label">{label}</span>
      <span className="text">{text}</span>
      {children}
    </div>
  );
}

/** Level meter driven straight from the capture callback (no React re-render per audio block). */
function MicMeter({ mic }: { mic: MicCapture }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    mic.onLevel = (level) => {
      if (bar.current) bar.current.style.transform = `scaleX(${level.toFixed(3)})`;
    };
    return () => {
      mic.onLevel = null;
    };
  }, [mic]);
  return (
    <span className="meter" aria-hidden>
      <span ref={bar} />
    </span>
  );
}
