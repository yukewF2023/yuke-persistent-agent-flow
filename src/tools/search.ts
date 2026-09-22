import { countedFetch, type FetchCtx } from "./http";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  published?: string | null;
  score?: number;
}

/** Tavily basic search = 1 credit. Free plan: 1,000 credits / month. */
export async function tavilySearch(
  ctx: FetchCtx,
  apiKey: string,
  query: string,
  opts: { maxResults?: number; days?: number } = {}
): Promise<SearchHit[]> {
  const res = await countedFetch(ctx, "https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      topic: "general",
      max_results: Math.min(opts.maxResults ?? 8, 10),
      ...(opts.days ? { days: opts.days } : {}),
      include_answer: false,
      include_raw_content: false
    })
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string; published_date?: string; score?: number }> };
  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content ?? "").slice(0, 400),
    published: r.published_date ?? null,
    score: r.score
  }));
}
