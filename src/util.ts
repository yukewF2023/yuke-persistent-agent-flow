/** Small helpers shared by the router, the Durable Object and the pages. */

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}

export function html(s: string, status = 200): Response {
  return new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function bearerOk(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  return timingSafeEqual(m[1].trim(), token);
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export const ago = (ts: number | null | undefined, now: number) => {
  if (!ts) return "—";
  const d = Math.round((now - ts) / 1000);
  const abs = Math.abs(d);
  const s = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : abs < 172800 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
};

export const when = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—");

export const usd = (n: number | null | undefined, digits = 2) => `$${Number(n ?? 0).toFixed(digits)}`;

/** Start of the current UTC day / month as epoch ms. */
export function utcDayStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
export function utcMonthStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function secondsToUtcMidnight(now = Date.now()): number {
  return Math.max(60, Math.ceil((utcDayStart(now) + 86_400_000 - now) / 1000));
}
