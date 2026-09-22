/** Counted, time-limited fetch used by every tool so a tick can never exceed the free-plan subrequest cap. */
export class SubrequestBudget {
  used = 0;
  constructor(public readonly cap: number) {}
  get remaining() {
    return Math.max(0, this.cap - this.used);
  }
  take(n = 1) {
    if (this.used + n > this.cap) throw new Error(`subrequest budget exhausted (${this.used}/${this.cap})`);
    this.used += n;
  }
}

export interface FetchCtx {
  budget: SubrequestBudget;
  timeoutMs?: number;
}

export async function countedFetch(ctx: FetchCtx, url: string, init: RequestInit = {}): Promise<Response> {
  ctx.budget.take(1);
  const signal = AbortSignal.timeout(ctx.timeoutMs ?? 10_000);
  return fetch(url, { ...init, signal, redirect: init.redirect ?? "follow" });
}

export interface UrlCheck {
  url: string;
  status: number;
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

/** GET a page, verify status < 400 and (optionally) that the body contains `expect`. */
export async function checkUrl(ctx: FetchCtx, url: string, expect?: string | null): Promise<UrlCheck> {
  const t0 = Date.now();
  try {
    const res = await countedFetch(ctx, url, {
      headers: { "user-agent": "yuke-persistent-agent-flow/uptime (+https://github.com/deepdotspace)" }
    });
    let ok = res.status < 400;
    let error: string | null = null;
    if (expect) {
      const body = (await res.text()).slice(0, 65_536);
      if (!body.includes(expect)) {
        ok = false;
        error = `expected text not found: ${expect}`;
      }
    } else {
      await res.body?.cancel();
    }
    if (!ok && !error) error = `http ${res.status}`;
    return { url, status: res.status, ok, latency_ms: Date.now() - t0, error };
  } catch (err) {
    return { url, status: 0, ok: false, latency_ms: Date.now() - t0, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

/** Run `fn` over items with at most `concurrency` in flight (free plan allows 6 simultaneous connections). */
export async function mapChunked<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}
