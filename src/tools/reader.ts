import { countedFetch, type FetchCtx } from "./http";

/** Fetch a page as clean markdown via Jina Reader. Capped to keep prompts small. */
export async function readPage(ctx: FetchCtx, url: string, maxChars = 12_000): Promise<string> {
  const res = await countedFetch({ ...ctx, timeoutMs: 15_000 }, `https://r.jina.ai/${url}`, {
    headers: { accept: "text/plain", "x-return-format": "markdown" }
  });
  if (!res.ok) throw new Error(`reader ${res.status} for ${url}`);
  const text = await res.text();
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}
