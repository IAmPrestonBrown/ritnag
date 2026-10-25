import { useCallback, useEffect, useRef, useState } from "react";
import type { MicCapture } from "./audio/capture";

export type Role = "owner" | "guest";
export type InputMode = "ptt" | "continuous";

const MODE_KEY = "imp.demoInput";
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * Demo Mode input. Push-to-talk keeps the mic open but sends silence unless Owner or Guest is held (buttons,
 * or the O / G keys); the held role is sent to the server as a manual identity for exactly that audio.
 * Continuous listens all the time, either on voice ID or with a role pinned. Outside Demo Mode: open mic,
 * automatic identity.
 */
export function usePushToTalk(mic: MicCapture, micOn: boolean, enabled: boolean) {
  const [mode, setMode] = useState<InputMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "continuous" ? "continuous" : "ptt";
    } catch {
      return "ptt";
    }
  });
  const [holding, setHolding] = useState<Role | null>(null);
  const [pinned, setPinned] = useState<Role | null>(null); // continuous mode
  const [guestId, setGuestId] = useState("");
  const holdingRef = useRef<Role | null>(null);
  const ptt = enabled && mode === "ptt";

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
  }, [mode]);

  // keep the capture gate and the server's identity in step with the mode
  useEffect(() => {
    if (!enabled) {
      mic.gate = true;
      mic.assign(null);
      return;
    }
    mic.gate = !ptt || holdingRef.current !== null;
    mic.assign(ptt ? holdingRef.current : pinned, null);
  }, [enabled, ptt, pinned, mic, micOn]);

  const press = useCallback(
    (role: Role) => {
      if (!ptt || !micOn || holdingRef.current) return;
      holdingRef.current = role;
      setHolding(role);
      mic.assign(role, role === "guest" ? guestId || null : null); // before the audio it labels
      mic.gate = true;
    },
    [ptt, micOn, mic, guestId],
  );
  const release = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = null;
    setHolding(null);
    mic.gate = false;
    mic.assign(null);
  }, [mic]);

  useEffect(() => {
    if (!ptt) return;
    const down = (e: KeyboardEvent) => {
      if (e.repeat || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
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
  }, [ptt, press, release]);

  return { mode, setMode, ptt, holding, press, release, pinned, setPinned, guestId, setGuestId };
}

export type PushToTalk = ReturnType<typeof usePushToTalk>;
