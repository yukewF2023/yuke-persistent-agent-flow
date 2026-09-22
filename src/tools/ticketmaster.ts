import { countedFetch, type FetchCtx } from "./http";

export interface TmEvent {
  name: string;
  url: string;
  date: string | null;
  time: string | null;
  venue: string | null;
  city: string | null;
  price_min: number | null;
  category: string | null;
}

/** Ticketmaster Discovery API (free key, 5,000 calls/day). Returns [] when no key is configured. */
export async function ticketmasterEvents(
  ctx: FetchCtx,
  apiKey: string | undefined,
  opts: { keyword?: string; start: string; end: string; stateCode?: string; size?: number }
): Promise<TmEvent[]> {
  if (!apiKey) return [];
  const q = new URLSearchParams({
    apikey: apiKey,
    stateCode: opts.stateCode ?? "CT",
    startDateTime: opts.start,
    endDateTime: opts.end,
    size: String(opts.size ?? 20),
    sort: "date,asc"
  });
  if (opts.keyword) q.set("keyword", opts.keyword);
  const res = await countedFetch(ctx, `https://app.ticketmaster.com/discovery/v2/events.json?${q}`);
  if (!res.ok) throw new Error(`ticketmaster ${res.status}`);
  const data = (await res.json()) as {
    _embedded?: {
      events?: Array<{
        name: string;
        url: string;
        dates?: { start?: { localDate?: string; localTime?: string } };
        _embedded?: { venues?: Array<{ name?: string; city?: { name?: string } }> };
        priceRanges?: Array<{ min?: number }>;
        classifications?: Array<{ segment?: { name?: string }; genre?: { name?: string } }>;
      }>;
    };
  };
  return (data._embedded?.events ?? []).map((e) => ({
    name: e.name,
    url: e.url,
    date: e.dates?.start?.localDate ?? null,
    time: e.dates?.start?.localTime ?? null,
    venue: e._embedded?.venues?.[0]?.name ?? null,
    city: e._embedded?.venues?.[0]?.city?.name ?? null,
    price_min: e.priceRanges?.[0]?.min ?? null,
    category: e.classifications?.[0]?.genre?.name ?? e.classifications?.[0]?.segment?.name ?? null
  }));
}
