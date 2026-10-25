import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Decision } from "../../shared/schemas";

export const anthropicModel = () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

type Effort = "low" | "medium" | "high";

/**
 * One bounded structured-output call. Retries once on unparseable output;
 * never returns partially parsed data.
 */
export async function claudeDecide(system: string, user: string): Promise<Decision> {
  const effort = (process.env.ANTHROPIC_EFFORT as Effort) || "low";
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await getClient().beta.messages.parse({
        model: anthropicModel(),
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort, format: betaZodOutputFormat(Decision) },
      });
      if (response.stop_reason === "refusal") throw new Error("Claude declined this turn");
      if (!response.parsed_output) throw new Error(`Unparseable decision (stop_reason=${response.stop_reason})`);
      // Local validation on top of the provider's schema enforcement.
      return Decision.parse(response.parsed_output);
    } catch (err) {
      lastError = err;
      if (err instanceof Anthropic.APIError && err.status !== undefined && err.status < 500 && err.status !== 429) break;
    }
  }
  throw lastError;
}
