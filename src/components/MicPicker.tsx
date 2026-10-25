import { useEffect, useState } from "react";
import { listMics, preferredMic, rememberMic, type MicDevice } from "../audio/devices";

/** Which input to use. Remembered per browser; applies the next time listening or enrollment starts. */
export function MicPicker({ live, inUse }: { live: boolean; inUse: string }) {
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [all, pick] = await Promise.all([listMics(), preferredMic()]);
      setMics(all);
      setSelected(pick?.deviceId ?? "");
    } catch {
      setNote("mic access blocked");
    }
  };

  useEffect(() => {
    // Only enumerate once permission exists, so loading the page doesn't trigger a mic prompt.
    void navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => {
        if (p.state === "granted") void refresh();
      })
      .catch(() => {});
    const onChange = () => void refresh();
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, []);

  return (
    <label className="mic-picker" title={inUse ? `In use: ${inUse}` : "Microphone"}>
      <span className="muted">mic</span>
      <select
        value={selected}
        onMouseDown={() => mics.length === 0 && void refresh()}
        onFocus={() => mics.length === 0 && void refresh()}
        onChange={(e) => {
          rememberMic(e.target.value);
          setSelected(e.target.value);
          setNote(live ? "restart listening to switch" : null);
        }}
      >
        {mics.length === 0 && <option value="">{inUse || "choose…"}</option>}
        {mics.map((m) => (
          <option key={m.deviceId} value={m.deviceId}>
            {m.label || "Unnamed mic"}
          </option>
        ))}
      </select>
      {note && <span className="muted small-print">{note}</span>}
    </label>
  );
}
