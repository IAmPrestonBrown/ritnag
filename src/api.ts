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
