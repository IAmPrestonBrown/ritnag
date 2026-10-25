import type { Alert, Person } from "../shared/schemas";

const CHIME_NOTES_HZ = [880, 1320];
const CHIME_NOTE_SEC = 0.14;
const CHIME_GAIN = 0.15;

export function alertNotice(alert: Alert, people: Person[]): { title: string; body: string } {
  const name = people.find((p) => p.id === alert.personId)?.name ?? "Someone";
  return { title: `${name} needs you`, body: alert.reason };
}

// One shared context, created on a click so the browser lets it play when an alert arrives later.
let audio: AudioContext | null = null;

/** Call from a click: unlocks the chime and asks once for notifications, so alerts reach an owner in another window. */
export function primeAlerts(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch (err) {
    console.warn("Alert chime:", (err as Error).message);
  }
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  Notification.requestPermission().catch((err: Error) => console.warn("Notification permission:", err.message));
}

/** Two short rising notes: loud enough for headphones, too short to sound like speech to the mic. */
function chime(): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    if (ctx.state === "suspended") console.warn("Alert chime: audio is locked until the page is clicked");
    void ctx.resume();
    CHIME_NOTES_HZ.forEach((hz, i) => {
      const start = ctx.currentTime + i * CHIME_NOTE_SEC;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(CHIME_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + CHIME_NOTE_SEC);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + CHIME_NOTE_SEC);
    });
  } catch (err) {
    console.warn("Alert chime:", (err as Error).message);
  }
}

/** Gets the owner's attention: always a chime, plus a system notification when Ritnag isn't in front. */
export function notifyAlert(alert: Alert, people: Person[]): void {
  chime();
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.hasFocus()) return;
  const { title, body } = alertNotice(alert, people);
  try {
    const n = new Notification(title, { body, tag: alert.id });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (err) {
    console.warn("Alert notification:", (err as Error).message);
  }
}
