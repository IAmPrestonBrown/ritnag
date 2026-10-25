const KEY = "imp.micDeviceId";

// macOS Continuity offers a nearby iPhone as the default input; never pick one automatically.
const AVOID = /iphone|ipad|continuity/i;
const PREFER = /macbook|built-in|internal/i;

export interface MicDevice {
  deviceId: string;
  label: string;
}

const stored = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export function rememberMic(deviceId: string) {
  try {
    localStorage.setItem(KEY, deviceId);
  } catch {}
}

/** Audio inputs with real labels. Labels need mic permission, so ask once if they're blank. */
export async function listMics(): Promise<MicDevice[]> {
  const read = async () =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  let mics = await read();
  if (mics.length && mics.every((m) => !m.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    mics = await read();
  }
  return mics;
}

/**
 * The mic to open: the one the owner picked if it's still connected, else the laptop's built-in mic,
 * else any mic that isn't an iPhone. Used for both listening and voice enrollment so they match.
 */
export async function preferredMic(): Promise<MicDevice | null> {
  const mics = await listMics();
  const picked = stored();
  return (
    mics.find((m) => m.deviceId === picked) ??
    mics.find((m) => PREFER.test(m.label) && !AVOID.test(m.label)) ??
    mics.find((m) => !AVOID.test(m.label)) ??
    mics[0] ??
    null
  );
}

// ---- output: where the imp's voice plays ----
// The owner may be wearing headphones (the system default). Visitors only hear the imp if its voice
// goes to a speaker in the room, so the voice can be routed to its own output. Alerts for the owner
// (the chime in notify.ts) stay on the system default, i.e. the owner's headphones.

const SPEAKER_KEY = "imp.speakerDeviceId";

/** Chrome/Edge can route one page's audio to a chosen output; Safari/Firefox may not. */
export const canChooseSpeaker = () => typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** The output picked for the imp's voice; "" means the system default. */
export function chosenSpeaker(): string {
  try {
    return localStorage.getItem(SPEAKER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberSpeaker(deviceId: string) {
  try {
    if (deviceId) localStorage.setItem(SPEAKER_KEY, deviceId);
    else localStorage.removeItem(SPEAKER_KEY);
  } catch {}
}

/** The remembered output if it's still connected, else "" (system default). */
export function resolveSpeaker(outputs: MicDevice[], stored: string): string {
  return stored && outputs.some((o) => o.deviceId === stored) ? stored : "";
}

/** Audio outputs with real labels (labels appear once mic permission exists). */
export async function listSpeakers(): Promise<MicDevice[]> {
  return (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}
