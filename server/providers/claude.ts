import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Decision } from "../../shared/schemas";

export const anthropicModel = () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;
// Bounded: a hung request fails into the operator's Retry instead of leaving the imp "thinking". The SDK
// retries dropped connections and 429/5xx (twice, with short backoff); the session's 25 s deadline caps it all.
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 10_000);
export const getClient = () => (client ??= new Anthropic({ timeout: CLAUDE_TIMEOUT_MS, maxRetries: 2 }));

type Effort = "low" | "medium" | "high";

/**
 * One bounded structured-output call. Retries once on unparseable output;
 * never returns partially parsed data.
 */
/** Token usage of the most recent decision (for latency/caching diagnostics). */
export let lastUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null = null;

export async function claudeDecide(system: string, user: string): Promise<Decision> {
  const effort = (process.env.ANTHROPIC_EFFORT as Effort) || "low";
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const model = anthropicModel();
      // Haiku has no server-side refusal fallback; other current models route declines automatically.
      const fallback = model.includes("haiku")
        ? {}
        : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
      // One bounded classification + one-liner: thinking adds ~1 s and buys nothing here.
      // Haiku accepts disabled thinking at effort <= high; other current models reject it.
      const thinking = model.includes("haiku") ? { thinking: { type: "disabled" as const } } : {};
      const response = await getClient().beta.messages.parse({
        model,
        max_tokens: 2000,
        ...fallback,
        ...thinking,
        // The instructions are identical on every turn: cache them so each call only processes the new turn.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { effort, format: betaZodOutputFormat(Decision) },
      });
      lastUsage = response.usage;
      if (response.stop_reason === "refusal") throw new Error("Claude declined this turn");
      if (!response.parsed_output) throw new Error(`Unparseable decision (stop_reason=${response.stop_reason})`);
      // Local validation on top of the provider's schema enforcement.
      return Decision.parse(response.parsed_output);
    } catch (err) {
      lastError = err;
      // API errors were already retried by the SDK where that helps; only unparseable output is retried here
      if (err instanceof Anthropic.APIError) break;
    }
  }
  throw lastError;
}

/** One short free-text reply (the spoken day report). Same model; no thinking on Haiku. */
export async function claudeText(system: string, user: string, maxTokens = 300): Promise<string> {
  const model = anthropicModel();
  const thinking = model.includes("haiku") ? { thinking: { type: "disabled" as const } } : {};
  const response = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    ...thinking,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined the report");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
  if (!text) throw new Error("empty report");
  return text;
}
