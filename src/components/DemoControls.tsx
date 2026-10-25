import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../shared/events";
import { get, post } from "../api";
import type { MicCapture } from "../audio/capture";
import type { PushToTalk } from "../pushToTalk";

/** The two hold-to-talk buttons that replace "Start listening" under the imp in push-to-talk. */
export function HoldToTalk({ ptt, ownerName, guestName, speaking, onStopSpeaking }: { ptt: PushToTalk; ownerName: string; guestName: string | null; speaking: boolean; onStopSpeaking: () => void }) {
  const hold = (role: "owner" | "guest", label: string) => (
    <button
      className={`hold ${role} ${ptt.holding === role ? "held" : ""}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        ptt.press(role);
      }}
      onPointerUp={ptt.release}
      onPointerCancel={ptt.release}
      onLostPointerCapture={ptt.release}
      title={`Hold while ${label} talks (or hold ${role === "owner" ? "O" : "G"})`}
    >
      {ptt.holding === role ? "Listening…" : label}
    </button>
  );
  return (
    <div className="controls">
      {hold("owner", ownerName)}
      {hold("guest", guestName ?? "Guest")}
      {speaking && (
        <button className="ghost" onClick={onStopSpeaking}>
          Stop talking
        </button>
      )}
    </div>
  );
}

/** Small mic level bar next to "Listening". Updated straight from the capture, no re-render per block. */
export function MicMeter({ mic }: { mic: MicCapture }) {
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
    <span className="meter" title="Mic level" aria-hidden>
      <span ref={bar} />
    </span>
  );
}

interface Check {
  configured: boolean;
  ok: boolean | null;
  ms: number | null;
  detail: string | null;
}
type Health = Record<"claude" | "cartesia" | "moss" | "speechmatics" | "deepgram", Check>;
interface Readiness {
  ready: boolean;
  mode: "learn" | "prepared" | null;
  memories: number;
  problems: string[];
}

/** Settings → Demo: how input works, resetting between judges, typed input, and a real provider check. */
export function DemoSettings({
  snapshot,
  ptt,
  onRestartListening,
  onError,
}: {
  snapshot: Snapshot;
  ptt: PushToTalk;
  onRestartListening: () => void;
  onError: (message: string) => void;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [starting, setStarting] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const [typed, setTyped] = useState("");
  const isDemo = snapshot.profile === "demo";

  useEffect(() => {
    if (isDemo) void get<Readiness>("/api/demo/ready").then(setReadiness).catch(() => {});
  }, [isDemo]);

  const startFresh = async (mode: "learn" | "prepared") => {
    ptt.release();
    setStarting(true);
    setReadiness(null);
    try {
      let r = await post<Readiness>("/api/demo/start", { mode });
      // a cold Moss index can take a moment: wait (bounded) until it matches the records
      for (let i = 0; i < 10 && !r.ready && r.problems.every((p) => !/configured/.test(p)); i++) {
        await new Promise((res) => setTimeout(res, 500));
        r = await get<Readiness>("/api/demo/ready");
      }
      setReadiness(r);
    } catch (err) {
      onError(`Start fresh demo: ${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

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

  const send = (asOwner: boolean) => {
    const text = typed.trim();
    if (!text) return;
    // same pipeline as speech; shown as "typed" in the transcript
    post("/api/turn", { text, speakerLabel: asOwner ? "owner" : "guest-A", asOwner })
      .then(() => setTyped(""))
      .catch((err: Error) => onError(`Typed input: ${err.message}`));
  };

  return (
    <div className="stack">
      <div className="field">
        <span className="muted">input</span>
        <button className={`small ${ptt.mode === "ptt" ? "on" : ""}`} onClick={() => ptt.setMode("ptt")}>
          Push-to-talk
        </button>
        <button className={`small ${ptt.mode === "continuous" ? "on" : ""}`} onClick={() => ptt.setMode("continuous")}>
          Continuous
        </button>
      </div>
      {ptt.mode === "continuous" && (
        <div className="field">
          <span className="muted">speaker</span>
          {([null, "owner", "guest"] as const).map((role) => (
            <button key={role ?? "auto"} className={`small ${ptt.pinned === role ? "on" : ""}`} onClick={() => ptt.setPinned(role)}>
              {role === null ? "voice ID" : role === "owner" ? "owner" : "guest"}
            </button>
          ))}
        </div>
      )}
      <label className="field">
        <span className="muted">guest is</span>
        <select value={ptt.guestId} onChange={(e) => ptt.setGuestId(e.target.value)}>
          <option value="">unknown</option>
          {snapshot.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small-print">
        Hold a name under the imp (or O / G) while that person talks. Those lines are marked "manual" in the transcript.
      </p>

      <div className="field">
        <span className="muted">reset</span>
        <button className="small" disabled={!isDemo || starting} onClick={() => void startFresh("learn")}>
          Learn live
        </button>
        <button className="small" disabled={!isDemo || starting} onClick={() => void startFresh("prepared")}>
          Prepared (Bob)
        </button>
        <button className="small" onClick={onRestartListening} title="New transcription session; memories stay">
          Restart listening
        </button>
      </div>
      <p className={`small-print ${readiness && !readiness.ready ? "error" : "muted"}`}>
        {!isDemo
          ? "Fresh demo works in the demo profile only (npm run demo), so everyday data is never wiped."
          : starting
            ? "Resetting…"
            : readiness
              ? readiness.ready
                ? `Ready. ${readiness.mode === "prepared" ? "Sample guest Bob (sarcastic) and one sample memory." : readiness.mode === "learn" ? "No memories yet." : `${readiness.memories} memories.`}`
                : `Not ready: ${readiness.problems.join(" ")}`
              : ""}
      </p>

      <div className="field">
        <span className="muted">type</span>
        <input value={typed} placeholder="Type what was said…" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(false)} />
        <button className="small" disabled={!typed.trim()} onClick={() => send(false)}>
          as guest
        </button>
        <button className="small" disabled={!typed.trim()} onClick={() => send(true)}>
          as owner
        </button>
      </div>

      <div className="field">
        <span className="muted">providers</span>
        <button className="small" disabled={checking} onClick={() => void check()}>
          {checking ? "Checking…" : "Check providers"}
        </button>
        {health &&
          (Object.entries(health) as [keyof Health, Check][])
            .filter(([, c]) => c && typeof c === "object" && "configured" in c && c.configured)
            .map(([name, c]) => (
              <span key={name} className={c.ok ? "muted" : "error"} title={c.detail ?? ""}>
                {name} {c.ok ? "✓" : "✗"}
              </span>
            ))}
      </div>
    </div>
  );
}
