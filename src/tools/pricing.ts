/** OpenCode Go pricing for deepseek-v4.1-flash (per 1M tokens), https://opencode.ai/data/deepseek/deepseek-v4.1-flash */
export const PRICE = { input: 0.21, output: 0.84, cacheRead: 0.021 };
/** Go's allowance windows, in USD. */
export const GO_CAPS = { fiveHour: 12, week: 30, month: 60 };

/** DeepSeek peak pricing: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday → 2×. */
export function peakMultiplier(ts = Date.now()): number {
  const d = new Date(ts);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();
  if (dow === 0 || dow === 6) return 1;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 2 : 1;
}

export function costUsd(inputTokens: number, outputTokens: number, cacheReadTokens = 0, ts = Date.now()): number {
  const m = peakMultiplier(ts);
  const uncached = Math.max(0, inputTokens - cacheReadTokens);
  return (m * (uncached * PRICE.input + cacheReadTokens * PRICE.cacheRead + outputTokens * PRICE.output)) / 1_000_000;
}
