import { useEffect, useRef, useState } from "react";
import { get, postAudio } from "../api";
import { MicSource, concat, rmsDbfs, toPcm16 } from "../audio/pcm";

interface Clip {
  file: string;
  kind: "solo" | "conversation";
  speaker: string | null;
  durationSec: number;
  deviceLabel: string;
}

const MAX_SEC = 180;
const TARGET = { solo: "20–30 s, one person, nobody else talking", conversation: "~2 min, talk like the demo; overlaps are fine" };
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * Speaker-ID bake-off recorder (docs/WORKSTREAMS.md P1). Uses the same MicSource as live listening
 * (same mic choice, same browser processing), so clips match what the scorer actually hears.
 */
export function RecordClips({ listening }: { listening: boolean }) {
  const [set, setSet] = useState("bakeoff-1");
  const [kind, setKind] = useState<"solo" | "conversation">("solo");
  const [speaker, setSpeaker] = useState("Preston");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(-90);
  const [clips, setClips] = useState<Clip[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const mic = useRef<MicSource | null>(null);
  const chunks = useRef<Float32Array[]>([]);
  const started = useRef(0);

  const refresh = () =>
    get<{ set: string; clips: Clip[] }[]>("/api/recordings")
      .then((all) => setClips(all.find((s) => s.set === set)?.clips ?? []))
      .catch(() => {});
  useEffect(() => void refresh(), [set]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const sec = (performance.now() - started.current) / 1000;
      setElapsed(sec);
      if (sec >= MAX_SEC) void stop();
    }, 200);
    return () => clearInterval(t);
  }, [recording]);

  const start = async () => {
    setStatus(null);
    chunks.current = [];
    const m = new MicSource();
    try {
      await m.start();
    } catch (err) {
      setStatus(`Mic: ${(err as Error).message}`);
      return;
    }
    m.onFrames = (f) => {
      chunks.current.push(f);
      setLevel(rmsDbfs(f));
    };
    mic.current = m;
    started.current = performance.now();
    setElapsed(0);
    setRecording(true);
  };

  const stop = async () => {
    const m = mic.current;
    if (!m) return;
    mic.current = null;
    setRecording(false);
    const sampleRate = m.sampleRate;
    const device = m.deviceLabel;
    await m.stop();
    const pcm = concat(chunks.current);
    chunks.current = [];
    if (pcm.length < sampleRate) return setStatus("Too short; nothing saved.");
    setStatus("Saving…");
    try {
      const c = await postAudio<Clip>(
        "/api/recordings",
        { set, kind, ...(kind === "solo" ? { speaker } : {}), sampleRate, device },
        toPcm16(pcm),
      );
      setStatus(`Saved ${c.file} (${c.durationSec}s, ${c.deviceLabel || "unknown mic"})`);
      void refresh();
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  };

  const valid = NAME.test(set) && (kind === "conversation" || NAME.test(speaker));
  const meter = Math.max(0, Math.min(100, ((level + 70) / 60) * 100));

  return (
    <details className="panel debug record-clips">
      <summary>Speaker-ID test recordings (P1)</summary>
      <p className="muted small-print">
        Saved to <code>data/recordings/{set}/</code> through the live mic path. Record a solo clip for each person and one
        natural conversation.
      </p>
      <div className="row">
        <label>
          set <input value={set} disabled={recording} onChange={(e) => setSet(e.target.value.trim())} style={{ width: "9rem" }} />
        </label>
        <label>
          <input type="radio" checked={kind === "solo"} disabled={recording} onChange={() => setKind("solo")} /> solo
        </label>
        <label>
          <input type="radio" checked={kind === "conversation"} disabled={recording} onChange={() => setKind("conversation")} />{" "}
          conversation
        </label>
        {kind === "solo" && (
          <>
            <input value={speaker} disabled={recording} onChange={(e) => setSpeaker(e.target.value.trim())} style={{ width: "8rem" }} />
            {["Preston", "Leon", "Ritvik"].map((n) => (
              <button key={n} className={`small ${speaker === n ? "on" : ""}`} disabled={recording} onClick={() => setSpeaker(n)}>
                {n}
              </button>
            ))}
          </>
        )}
      </div>
      <div className="row">
        {recording ? (
          <button className="on" onClick={() => void stop()}>
            Stop &amp; save ({elapsed.toFixed(0)}s)
          </button>
        ) : (
          <button disabled={!valid || listening} onClick={() => void start()} title={listening ? "Stop listening first" : ""}>
            Record {kind === "solo" ? `solo: ${speaker}` : "conversation"}
          </button>
        )}
        <span className="level" aria-label="input level">
          <span style={{ width: `${recording ? meter : 0}%` }} />
        </span>
        <span className="muted small-print">
          {listening ? "Stop listening first (the imp would answer)." : `Target: ${TARGET[kind]}. Max ${MAX_SEC}s.`}
        </span>
      </div>
      {status && <p className="small-print">{status}</p>}
      {clips.length > 0 && (
        <ul className="clips">
          {clips.map((c) => (
            <li key={c.file} className="small-print">
              {c.kind === "solo" ? `solo · ${c.speaker}` : "conversation"} · {c.durationSec}s · {c.deviceLabel || "unknown mic"}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
