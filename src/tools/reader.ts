import { countedFetch, type FetchCtx } from "./http";

/** Crude but dependency-free HTML → text: drop scripts/styles/nav, strip tags, collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => `${text} (${href})`)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/**
 * Read a page as text. Direct fetch + HTML stripping first (free); if the page is blocked or
 * JS-rendered (too little text), fall back to Tavily Extract (1 credit per call, up to 5 urls).
 */
export async function readPage(ctx: FetchCtx, url: string, opts: { tavilyKey?: string; maxChars?: number } = {}): Promise<{ content: string; via: "direct" | "tavily" }> {
  const maxChars = opts.maxChars ?? 7_000;
  const clip = (t: string) => (t.length > maxChars ? t.slice(0, maxChars) + "\n…[truncated]" : t);
  let direct = "";
  try {
    const res = await countedFetch({ ...ctx, timeoutMs: 12_000 }, url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; yuke-persistent-agent-flow/0.1; +https://github.com/deepdotspace)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" }
    });
    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      const raw = (await res.text()).slice(0, 600_000);
      direct = /html/i.test(ct) ? htmlToText(raw) : raw;
    }
  } catch {}
  if (direct.length >= 600 || !opts.tavilyKey) {
    if (!direct) throw new Error(`could not read ${url}`);
    return { content: clip(direct), via: "direct" };
  }
  const res = await countedFetch({ ...ctx, timeoutMs: 20_000 }, "https://api.tavily.com/extract", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.tavilyKey}` },
    body: JSON.stringify({ urls: [url], extract_depth: "basic", format: "markdown" })
  });
  if (!res.ok) {
    if (direct) return { content: clip(direct), via: "direct" };
    throw new Error(`extract ${res.status} for ${url}`);
  }
  const data = (await res.json()) as { results?: Array<{ url: string; raw_content?: string }>; failed_results?: unknown[] };
  const text = data.results?.[0]?.raw_content ?? "";
  if (!text && !direct) throw new Error(`no content for ${url}`);
  return text ? { content: clip(text), via: "tavily" } : { content: clip(direct), via: "direct" };
}
