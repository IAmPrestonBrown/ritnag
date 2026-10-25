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
