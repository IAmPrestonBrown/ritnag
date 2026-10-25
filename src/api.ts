import type { ServerEvent } from "../shared/events";

const KEY = "imp.workspaceToken";

/** Token arrives once via the URL fragment printed by the server, then lives in localStorage. */
export function workspaceToken(): string | null {
  const m = location.hash.match(/token=([\w-]+)/);
  if (m?.[1]) {
    try {
      localStorage.setItem(KEY, m[1]);
    } catch {}
    history.replaceState(null, "", location.pathname + location.search); // keep ?demo etc.
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

async function request<T>(method: string, path: string, init: { body?: BodyInit; type?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-imp-token": token ?? "" };
  if (init.type) headers["Content-Type"] = init.type;
  const res = await fetch(path, { method, headers, body: init.body });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export const del = <T = unknown>(path: string) => request<T>("DELETE", path);
export const get = <T = unknown>(path: string) => request<T>("GET", path);

/** Mono PCM16 upload (enrollment takes, verify tests). */
export function postAudio<T = unknown>(path: string, query: Record<string, string | number>, pcm16: Int16Array<ArrayBuffer>) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  return request<T>("POST", `${path}?${qs}`, { body: pcm16.buffer, type: "application/octet-stream" });
}

/** The imp's voice for one reply, streamed (plays as it arrives). */
export const speechStreamUrl = (responseId: string) =>
  `/api/speech/stream/${encodeURIComponent(responseId)}?token=${encodeURIComponent(token ?? "")}`;

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
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = () => {
    retry = null;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/api/audio?token=${encodeURIComponent(token ?? "")}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      onStatus(true);
    };
    sock.onmessage = (m) => typeof m.data === "string" && onEvent(JSON.parse(m.data));
    sock.onclose = () => {
      if (ws !== sock) return; // an older socket closing late
      onStatus(false);
      // bounded backoff: 1, 2, 4, 8 s, then every 8 s ("Reconnecting…" shows meanwhile)
      if (!closed && !retry) retry = setTimeout(open, Math.min(8000, 1000 * 2 ** attempt++));
    };
  };
  open();
  return {
    socket: () => ws,
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    },
  };
}
