import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Env } from "./types";

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind: "rate_limit" | "auth" | "other",
    public readonly status?: number
  ) {
    super(message);
  }
}

export const USER_AGENT = "yuke-persistent-agent-flow/0.1 (cloudflare-durable-object agent)";

/**
 * DeepSeek V4.1 Flash via OpenCode Go's OpenAI-compatible endpoint.
 * Go requires a stable `x-opencode-session` per conversation (one tick = one conversation)
 * and a client-specific user agent. https://opencode.ai/docs/go/#where-can-i-use-it
 */
export function makeModel(env: Env, sessionId: string) {
  const provider = createOpenAICompatible({
    name: "opencode-go",
    baseURL: env.LLM_BASE_URL,
    apiKey: env.OPENCODE_API_KEY,
    headers: { "x-opencode-session": sessionId, "user-agent": USER_AGENT }
  });
  return provider(env.LLM_MODEL);
}

/** Map any thrown error from the AI SDK into a classified LlmError. */
export function classifyLlmError(err: unknown): LlmError {
  const e = err as { statusCode?: number; status?: number; message?: string; name?: string };
  const status = e?.statusCode ?? e?.status;
  const msg = (e?.message ?? String(err)).slice(0, 500);
  if (status === 429) return new LlmError(msg, "rate_limit", status);
  if (status === 401 || status === 403) return new LlmError(msg, "auth", status);
  if (/rate limit|too many requests/i.test(msg)) return new LlmError(msg, "rate_limit", status);
  return new LlmError(msg, "other", status);
}
