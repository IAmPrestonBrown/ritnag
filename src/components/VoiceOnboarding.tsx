import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot, VoiceThresholds } from "../../shared/events";
import { del, post, postAudio } from "../api";
import { MicSource, concat, rmsDbfs, toPcm16 } from "../audio/pcm";

type Step = "consent" | "mic" | "prompts" | "building" | "verify" | "impostor" | "done";

interface Prompt {
  text: string;
  distance: boolean;
}
interface Sample {
  ok: boolean;
  prompt: number;
  durationSec: number;
  speechSec: number;
  snrDb: number;
  issues: string[];
}
interface Verify {
  score: number;
  decision: "accept" | "reject" | "uncertain" | "too_short";
  thresholds: VoiceThresholds;
  warning: "self_below_accept" | "not_separable" | null;
}

const TARGET_TAKE_SEC = 5;
const MAX_TAKE_SEC = 9;
const NOISE_CHECK_SEC = 3;
const LOUD_ROOM_DBFS = -45;
const VERIFY_PHRASE = "Quick check: Ritnag, this is really me, talking to you right now.";

const ISSUE_TEXT: Record<string, string> = {
  too_short: "Too short. Read the whole sentence.",
  too_quiet: "Too quiet. Move closer or speak up.",
  clipped: "Clipping. Move back a little or lower the input gain.",
  noisy: "Noisy room. Kept, but quieter is better.",
};

const WARNING_TEXT: Record<string, string> = {
  self_below_accept: "Your own score is below the accept threshold now. Re-enroll from your demo position, or you'll mostly get “Was that you?” prompts.",
  not_separable: "Your voice and your teammate's scored too close together. Re-enroll in a quieter spot; until then most turns will be uncertain (no learning).",
};

const fmt = (x: number) => x.toFixed(2);

/** One-time owner voice enrollment (docs/SPEAKER_ID.md §4). About 90 seconds. */
export function VoiceOnboarding({ ownerName, onClose }: { ownerName: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>("consent");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(-90);
  const [clipping, setClipping] = useState(false);
  const [noiseDb, setNoiseDb] = useState<number | null>(null);
  const [enrollment, setEnrollment] = useState<{ enrollmentId: string; prompts: Prompt[] } | null>(null);
  const [current, setCurrent] = useState(0);
  const [samples, setSamples] = useState<Record<number, Sample>>({});
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<{ selfScore: number; thresholds: VoiceThresholds } | null>(null);
  const [selfTest, setSelfTest] = useState<Verify | null>(null);
  const [impostorTest, setImpostorTest] = useState<Verify | null>(null);

  const mic = useRef<MicSource | null>(null);
  const chunks = useRef<Float32Array[] | null>(null); // non-null while capturing
  const startedAt = useRef(0);
  const onStop = useRef<((pcm16: Int16Array<ArrayBuffer>, rate: number) => Promise<void>) | null>(null);
  // take handlers run after an upload, so they read samples from here rather than a stale render
  const samplesRef = useRef<Record<number, Sample>>({});
  const updateSamples = (next: Record<number, Sample>) => {
    samplesRef.current = next;
    setSamples(next);
  };

  useEffect(
    () => () => {
      void mic.current?.stop();
    },
    [],
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openMic = async () => {
    const m = new MicSource();
    await m.start();
    m.onFrames = (f) => {
      setLevel(rmsDbfs(f));
      if (!chunks.current) return;
      chunks.current.push(f);
      for (let i = 0; i < f.length; i++) if (Math.abs(f[i]!) >= 0.99) setClipping(true);
      setElapsed((performance.now() - startedAt.current) / 1000);
    };
    mic.current = m;
  };

  const beginCapture = () => {
    chunks.current = [];
    startedAt.current = performance.now();
    setElapsed(0);
    setClipping(false);
  };

  const endCapture = () => {
    const c = chunks.current ?? [];
    chunks.current = null;
    return concat(c);
  };

  const startRecording = (then: (pcm16: Int16Array<ArrayBuffer>, rate: number) => Promise<void>) => {
    onStop.current = then;
    beginCapture();
    setRecording(true);
  };

  const stopRecording = () => {
    if (!chunks.current) return;
    const pcm = endCapture();
    setRecording(false);
    const then = onStop.current;
    onStop.current = null;
    if (then && mic.current) void run(() => then(toPcm16(pcm), mic.current!.sampleRate));
  };

  // Long takes stop on their own.
  useEffect(() => {
    if (recording && elapsed >= MAX_TAKE_SEC) stopRecording();
  });

  // ---------- steps ----------

  const consent = () =>
    run(async () => {
      await openMic();
      setStep("mic");
      beginCapture();
      setTimeout(() => setNoiseDb(rmsDbfs(endCapture())), NOISE_CHECK_SEC * 1000);
    });

  const startPrompts = () =>
    run(async () => {
      const e = await post<{ enrollmentId: string; prompts: Prompt[] }>("/api/voice/enroll/start");
      setEnrollment(e);
      updateSamples({});
      setSelfTest(null);
      setImpostorTest(null);
      setCurrent(0);
      setStep("prompts");
    });

  const submitTake = (prompt: number) => async (pcm16: Int16Array<ArrayBuffer>, sampleRate: number) => {
    if (!enrollment) return;
    const s = await postAudio<Sample>("/api/voice/enroll/sample", { enrollmentId: enrollment.enrollmentId, prompt, sampleRate }, pcm16);
    const next = { ...samplesRef.current, [prompt]: s };
    updateSamples(next);
    if (s.ok) {
      const pending = enrollment.prompts.findIndex((_, i) => !next[i]?.ok);
      if (pending >= 0) setCurrent(pending);
    }
  };

  const allOk = enrollment !== null && enrollment.prompts.every((_, i) => samples[i]?.ok);

  const build = () =>
    run(async () => {
      if (!enrollment) return;
      setStep("building");
      try {
        setBuilt(await post<{ selfScore: number; thresholds: VoiceThresholds }>("/api/voice/enroll/finish", { enrollmentId: enrollment.enrollmentId }));
        setStep("verify");
      } catch (err) {
        setStep("prompts");
        throw err;
      }
    });

  const verify = (purpose: "self" | "impostor") => async (pcm16: Int16Array<ArrayBuffer>, sampleRate: number) => {
    const r = await postAudio<Verify>("/api/voice/verify-test", { purpose, sampleRate }, pcm16);
    (purpose === "self" ? setSelfTest : setImpostorTest)(r);
  };

  const close = () => {
    void mic.current?.stop();
    onClose();
  };

  // ---------- render ----------

  const meter = (
    <div className={`meter ${clipping ? "clip" : ""}`} aria-label="Input level">
      <div style={{ width: `${Math.max(0, Math.min(100, ((level + 70) / 70) * 100))}%` }} />
    </div>
  );

  const recordButton = (label: string, then: (pcm16: Int16Array<ArrayBuffer>, rate: number) => Promise<void>) =>
    recording ? (
      <button className="on" onClick={stopRecording}>
        Stop ({elapsed.toFixed(1)}s)
      </button>
    ) : (
      <button disabled={busy} onClick={() => startRecording(then)}>
        {label}
      </button>
    );

  const progress = recording && (
    <div className="take-progress">
      <div style={{ width: `${Math.min(100, (elapsed / TARGET_TAKE_SEC) * 100)}%` }} />
    </div>
  );

  let body: ReactNode;
  switch (step) {
    case "consent":
      body = (
        <>
          <h2>Teach Ritnag your voice</h2>
          <p>
            Ritnag only takes facts and settings from <strong>you</strong>. In a crowded room, live speaker labels mix people up, so
            it checks each turn against a voice profile of yours.
          </p>
          <ul>
            <li>About 90 seconds: read 8 short sentences, two of them from your demo position.</li>
            <li>
              Stored locally in <code>data/owner-voice.json</code> as a numeric profile. No raw audio is kept.
            </li>
            <li>Owner only. Visitors are never enrolled.</li>
            <li>Delete it any time from the Owner voice panel.</li>
          </ul>
          <div className="row">
            <button className="on" disabled={busy} onClick={() => void consent()}>
              Enroll my voice
            </button>
            <button onClick={close}>Not now</button>
          </div>
        </>
      );
      break;

    case "mic":
      body = (
        <>
          <h2>Mic check</h2>
          {meter}
          {noiseDb === null ? (
            <p>Stay quiet for {NOISE_CHECK_SEC} seconds while I measure the room…</p>
          ) : (
            <>
              <p>
                Room noise: <strong>{noiseDb.toFixed(0)} dBFS</strong>.{" "}
                {noiseDb > LOUD_ROOM_DBFS ? (
                  <span className="error">That's loud. Move somewhere quieter or closer to the mic if you can.</span>
                ) : (
                  <span className="ok">Good.</span>
                )}
              </p>
              <p className="muted">Say something: the bar should move well past halfway without turning red.</p>
              <div className="row">
                <button className="on" disabled={busy} onClick={() => void startPrompts()}>
                  Continue
                </button>
              </div>
            </>
          )}
        </>
      );
      break;

    case "prompts": {
      const prompts = enrollment?.prompts ?? [];
      const p = prompts[current];
      const s = samples[current];
      const firstDistance = prompts.findIndex((x) => x.distance);
      body = (
        <>
          <h2>
            Read aloud <span className="muted">({prompts.filter((_, i) => samples[i]?.ok).length}/{prompts.length})</span>
          </h2>
          <div className="chips">
            {prompts.map((x, i) => (
              <button
                key={i}
                className={`chip ${i === current ? "current" : ""} ${samples[i]?.ok ? "done" : samples[i] ? "bad" : ""}`}
                disabled={recording}
                onClick={() => setCurrent(i)}
                title={x.distance ? "From demo distance" : undefined}
              >
                {i + 1}
                {x.distance ? "↔" : ""}
              </button>
            ))}
          </div>
          {p?.distance && (
            <p className="banner calibrate">
              {current === firstDistance ? "Now from your demo position: " : ""}headphones on, leaning back, the distance you'll actually be at.
            </p>
          )}
          <blockquote className="prompt">{p?.text}</blockquote>
          {meter}
          {progress}
          <div className="row">
            {recordButton(s ? "Retake" : "Record", submitTake(current))}
            {allOk && !recording && (
              <button className="on" disabled={busy} onClick={() => void build()}>
                Build my profile
              </button>
            )}
          </div>
          {s && (
            <p className={s.ok ? "ok" : "error"}>
              {s.ok ? `Got it: ${s.speechSec.toFixed(1)}s of speech, SNR ${s.snrDb.toFixed(0)} dB.` : "Let's redo that one."}{" "}
              {s.issues.map((i) => ISSUE_TEXT[i] ?? i).join(" ")}
            </p>
          )}
        </>
      );
      break;
    }

    case "building":
      body = (
        <>
          <h2>Building your profile…</h2>
          <p className="muted">Computing the voice embedding. Your recordings are discarded afterwards.</p>
        </>
      );
      break;

    case "verify": {
      const passed = selfTest?.decision === "accept";
      body = (
        <>
          <h2>Check it's you</h2>
          {built && (
            <p className="muted">
              Profile built. Consistency across your takes: {fmt(built.selfScore)}. Accept ≥ {fmt(built.thresholds.accept)}, reject ≤{" "}
              {fmt(built.thresholds.reject)}.
            </p>
          )}
          <p>Say a fresh phrase:</p>
          <blockquote className="prompt">{VERIFY_PHRASE}</blockquote>
          {meter}
          {progress}
          <div className="row">
            {recordButton(selfTest ? "Try again" : "Record", verify("self"))}
            {passed && !recording && (
              <button className="on" onClick={() => setStep("impostor")}>
                Next: impostor check
              </button>
            )}
            {selfTest && !passed && !recording && <button onClick={() => void startPrompts()}>Re-enroll</button>}
          </div>
          {selfTest && <ScoreLine r={selfTest} expect="accept" />}
        </>
      );
      break;
    }

    case "impostor":
      body = (
        <>
          <h2>Impostor check (strongly recommended)</h2>
          <p>
            Hand the mic to a teammate. They read the same phrase, and it should land below the reject line. Their score tightens the
            thresholds for this room.
          </p>
          <blockquote className="prompt">{VERIFY_PHRASE}</blockquote>
          {meter}
          {progress}
          <div className="row">
            {recordButton(impostorTest ? "Try again" : "Record teammate", verify("impostor"))}
            {!recording && (
              <button className={impostorTest ? "on" : ""} onClick={() => setStep("done")}>
                {impostorTest ? "Finish" : "Skip"}
              </button>
            )}
          </div>
          {impostorTest && <ScoreLine r={impostorTest} expect="reject" />}
        </>
      );
      break;

    case "done": {
      const last = impostorTest ?? selfTest;
      body = (
        <>
          <h2>Done. Ritnag knows your voice.</h2>
          {last && (
            <p>
              Accept ≥ <strong>{fmt(last.thresholds.accept)}</strong>, reject ≤ <strong>{fmt(last.thresholds.reject)}</strong>. Turns in
              between, or shorter than ~1 s, count as uncertain: Ritnag won't learn from them and asks “Was that you?”.
            </p>
          )}
          {last?.warning && <p className="error">{WARNING_TEXT[last.warning]}</p>}
          <div className="row">
            <button className="on" onClick={close}>
              Close
            </button>
          </div>
        </>
      );
      break;
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Owner voice enrollment">
      <div className="modal panel">
        <button className="small close" onClick={close} aria-label="Close">
          ✕
        </button>
        <p className="muted small-print">{ownerName}'s voice profile</p>
        {body}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function ScoreLine({ r, expect }: { r: Verify; expect: "accept" | "reject" }) {
  const good = r.decision === expect;
  const words = { accept: "accepted as you", reject: "rejected (not you)", uncertain: "uncertain", too_short: "too short to score" }[r.decision];
  return (
    <>
      <p className={good ? "ok" : "error"}>
        Score {fmt(r.score)}: {words}
        {expect === "reject" && !good && r.decision !== "too_short" ? " — they'd have got through, so the thresholds were tightened" : ""}.
      </p>
      <p className="muted small-print">
        Now: accept ≥ {fmt(r.thresholds.accept)}, reject ≤ {fmt(r.thresholds.reject)}
      </p>
      {r.warning && <p className="error">{WARNING_TEXT[r.warning]}</p>}
    </>
  );
}

/** Owner voice settings: enroll, re-enroll, delete. */
export function VoicePanel({ snapshot, onEnroll }: { snapshot: Snapshot; onEnroll: () => void }) {
  const v = snapshot.session.voice;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel">
      <h2>
        Owner voice
        <span className={`pill ${v.active ? "ok" : v.enrolled ? "" : "bad"}`}>
          {v.active ? "verifying" : v.enrolled ? (v.model === "loading" ? "loading model…" : "inactive") : "not enrolled"}
        </span>
      </h2>
      {v.enrolled && v.thresholds ? (
        <p className="muted small-print">
          Enrolled {v.createdAt ? new Date(v.createdAt).toLocaleString() : ""} · accept ≥ {fmt(v.thresholds.accept)} · reject ≤{" "}
          {fmt(v.thresholds.reject)}
          {v.calibration?.impostorScore != null ? ` · impostor ${fmt(v.calibration.impostorScore)}` : " · no impostor check yet"}
        </p>
      ) : (
        <p className="muted small-print">
          Without a profile, the owner is whoever holds the calibrated speaker label, and wording checks are the only guard.
        </p>
      )}
      {v.error && <p className="error">{v.error}</p>}
      <div className="row">
        <button onClick={onEnroll}>{v.enrolled ? "Re-enroll" : "Enroll my voice"}</button>
        {v.enrolled &&
          (confirmDelete ? (
            <>
              <button
                className="danger"
                onClick={() =>
                  del("/api/voice/profile")
                    .then(() => setConfirmDelete(false))
                    .catch((e: Error) => setError(e.message))
                }
              >
                Delete profile
              </button>
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)}>Delete voice profile</button>
          ))}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
