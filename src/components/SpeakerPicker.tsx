import { useEffect, useState } from "react";
import { canChooseSpeaker, chosenSpeaker, listSpeakers, rememberSpeaker, resolveSpeaker, type MicDevice } from "../audio/devices";

/**
 * Where the imp's voice plays. Pick a speaker in the room (e.g. the laptop's built-in speakers) so a
 * visitor hears the answer while the owner keeps headphones on; alerts stay in the headphones.
 */
export function SpeakerPicker() {
  const [outputs, setOutputs] = useState<MicDevice[]>([]);
  const [selected, setSelected] = useState(chosenSpeaker);

  const refresh = async () => {
    try {
      const all = await listSpeakers();
      setOutputs(all);
      setSelected(resolveSpeaker(all, chosenSpeaker()));
    } catch {}
  };

  useEffect(() => {
    // Output labels only appear once mic permission exists; don't prompt just for this.
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

  if (!canChooseSpeaker()) return null; // Safari/Firefox: the voice uses the system output

  return (
    <label
      className="mic-picker"
      title="Where the imp's voice plays. Pick a speaker visitors can hear; alerts still go to your default output (headphones)."
    >
      <span className="muted">voice out</span>
      <select
        value={selected}
        onMouseDown={() => outputs.length === 0 && void refresh()}
        onFocus={() => outputs.length === 0 && void refresh()}
        onChange={(e) => {
          rememberSpeaker(e.target.value);
          setSelected(e.target.value);
        }}
      >
        <option value="">System default</option>
        {outputs.map((o) => (
          <option key={o.deviceId} value={o.deviceId}>
            {o.label || "Unnamed output"}
          </option>
        ))}
      </select>
    </label>
  );
}
