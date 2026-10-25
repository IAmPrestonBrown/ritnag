import { anthropicModel, getClient } from "./providers/claude";
import { CARTESIA_VERSION, cartesiaConfigured } from "./providers/cartesia";
import type { MossIndex } from "./providers/moss";

/**
 * "Configured" only means a key is set. This actually calls each provider (cheap, read-only requests,
 * bounded), so the UI can say "connected" only after a real answer.
 */
export interface ProviderCheck {
  configured: boolean;
  ok: boolean | null; // null = not configured, not checked
  ms: number | null;
  detail: string | null;
}

const TIMEOUT_MS = 6000;

async function timed(configured: boolean, run: () => Promise<string | null>): Promise<ProviderCheck> {
  if (!configured) return { configured, ok: null, ms: null, detail: "not configured" };
  const t0 = Date.now();
  try {
    const detail = await run();
    return { configured, ok: true, ms: Date.now() - t0, detail };
  } catch (err) {
    return { configured, ok: false, ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function getOk(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the key)" : ""}`);
  return null;
}

export async function checkProviders(index: MossIndex) {
  const env = process.env;
  const [claude, cartesia, moss, speechmatics, deepgram] = await Promise.all([
    timed(Boolean(env.ANTHROPIC_API_KEY), async () => {
      await getClient().models.retrieve(anthropicModel(), {}, { timeout: TIMEOUT_MS });
      return anthropicModel();
    }),
    timed(cartesiaConfigured(), () =>
      getOk(`https://api.cartesia.ai/voices/${encodeURIComponent(env.CARTESIA_VOICE_ID ?? "")}`, {
        Authorization: `Bearer ${env.CARTESIA_API_KEY}`,
        "Cartesia-Version": CARTESIA_VERSION,
      }),
    ),
    timed(Boolean(env.MOSS_PROJECT_ID && env.MOSS_PROJECT_KEY), async () => {
      // the in-process index is what answers questions: run a real query against it
      const hits = await Promise.race([index.search("health check", 1), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000))]);
      if (hits === "timeout") throw new Error("search didn't answer within 3 s");
      if (hits === null) throw new Error(index.getStatus().lastError ?? "index not ready");
      const st = index.getStatus();
      return `${st.docCount} docs${st.lastError ? ` · cloud mirror: ${st.lastError}` : ""}`;
    }),
    timed(Boolean(env.SPEECHMATICS_API_KEY), () =>
      getOk("https://asr.api.speechmatics.com/v2/jobs?limit=1", { Authorization: `Bearer ${env.SPEECHMATICS_API_KEY}` }),
    ),
    timed(Boolean(env.DEEPGRAM_API_KEY), () => getOk("https://api.deepgram.com/v1/projects", { Authorization: `Token ${env.DEEPGRAM_API_KEY}` })),
  ]);
  return { checkedAt: Date.now(), claude, cartesia, moss, speechmatics, deepgram };
}
