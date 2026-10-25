import type { ServerEvent } from "../shared/events";

const KEY = "imp.workspaceToken";

/** Token arrives once via the URL fragment printed by the server, then lives in localStorage. */
export function workspaceToken(): string | null {
  const m = location.hash.match(/token=([\w-]+)/);
  if (m?.[1]) {
    try {
      localStorage.setItem(KEY, m[1]);
    } catch {}
    history.replaceState(null, "", location.pathname);
    return m[1];
  }
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const token = workspaceToken();
export const hasToken = token !== null;

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-imp-token": token ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchSpeech(responseId: string): Promise<Blob> {
  const res = await fetch("/api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-imp-token": token ?? "" },
    body: JSON.stringify({ responseId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `speech ${res.status}`);
  return res.blob();
}

export function connectEvents(onEvent: (e: ServerEvent) => void, onStatus: (open: boolean) => void) {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/audio?token=${encodeURIComponent(token ?? "")}`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (m) => typeof m.data === "string" && onEvent(JSON.parse(m.data));
    ws.onclose = () => {
      onStatus(false);
      if (!closed) setTimeout(open, 1000);
    };
  };
  open();
  return {
    socket: () => ws,
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}
