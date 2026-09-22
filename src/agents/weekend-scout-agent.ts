import { tool, type ToolSet } from "ai";
import { z } from "zod";
import charter from "../../charters/weekend-scout.md";
import { BaseAgent, type Observation, type TickCtx } from "./base-agent";
import { tavilySearch } from "../tools/search";
import { readPage } from "../tools/reader";
import { ticketmasterEvents } from "../tools/ticketmaster";
import { notify } from "../tools/notify";
import { fmtInZone, nextDelivery, partsInZone, upcomingWeekends } from "../tools/time";

export interface SearchProfile {
  home: string;
  radius_min: number;
  categories: string[];
  keywords: string[];
  exclusions: string[];
  budget_max_usd: number;
  sources: string[];
  deliver: string[];
  tz: string;
  tavily_daily_cap?: number;
  research_ticks_per_day?: number;
}

export interface Candidate {
  id: number;
  url: string;
  url_norm: string;
  title: string;
  when_start: string | null;
  when_end: string | null;
  place: string | null;
  price: number | null;
  category: string | null;
  summary: string | null;
  source: string | null;
  first_seen: number;
  score: number;
  status: "new" | "recommended" | "rejected" | "expired";
  recommended_at: number | null;
}
export interface Rating {
  candidate_id: number;
  rating: "up" | "down";
  reason: string | null;
  ts: number;
}

const DELIVER_EARLY_MS = 10 * 60_000;

function normUrl(u: string) {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid|^gclid|^ref$/.test(k)) x.searchParams.delete(k);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + (x.search || "")).toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

export class WeekendScoutAgent extends BaseAgent {
  readonly agentId = "scout" as const;
  readonly displayName = "Weekend scout";
  readonly baseCharter = charter;
  wakeBounds = { min: 300, max: 12 * 3600 };

  protected ensureExtraSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, url_norm TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        when_start TEXT, when_end TEXT, place TEXT, price REAL, category TEXT, summary TEXT, source TEXT, first_seen INTEGER NOT NULL,
        score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', recommended_at INTEGER);
      CREATE INDEX IF NOT EXISTS candidates_status ON candidates(status, when_start);
      CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL, rating TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL);
    `);
  }

  profile(): SearchProfile {
    const base = JSON.parse(this.env.SCOUT_PROFILE) as SearchProfile;
    const override = this.getConfig<Partial<SearchProfile>>("search_profile");
    return { ...base, ...(override ?? {}) };
  }
  private localToday(tz: string) {
    const p = partsInZone(Date.now(), tz);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  }
  private tavilyUsed(tz: string) {
    return Number(this.kvGet(`tavily_used:${this.localToday(tz)}`) ?? 0);
  }
  private tavilyCap() {
    return this.profile().tavily_daily_cap ?? 25;
  }

  // ---- candidates ----
  candidateUpsert(c: { url: string; title: string; when_start?: string | null; when_end?: string | null; place?: string | null; price?: number | null; category?: string | null; summary?: string | null; source?: string | null; score?: number }) {
    const urlNorm = normUrl(c.url);
    const existing = this.sql<Candidate>`SELECT * FROM candidates WHERE url_norm = ${urlNorm} OR (title = ${c.title} AND when_start = ${c.when_start ?? null}) LIMIT 1`[0];
    if (existing) {
      this.sql`UPDATE candidates SET when_start = COALESCE(${c.when_start ?? null}, when_start), when_end = COALESCE(${c.when_end ?? null}, when_end), place = COALESCE(${c.place ?? null}, place), price = COALESCE(${c.price ?? null}, price), category = COALESCE(${c.category ?? null}, category), summary = COALESCE(${c.summary ?? null}, summary), score = MAX(score, ${c.score ?? 0}) WHERE id = ${existing.id}`;
      return { id: existing.id, created: false, status: existing.status };
    }
    this.sql`INSERT INTO candidates(url, url_norm, title, when_start, when_end, place, price, category, summary, source, first_seen, score) VALUES (${c.url}, ${urlNorm}, ${c.title.slice(0, 200)}, ${c.when_start ?? null}, ${c.when_end ?? null}, ${c.place ?? null}, ${c.price ?? null}, ${c.category ?? null}, ${c.summary ? c.summary.slice(0, 400) : null}, ${c.source ?? null}, ${Date.now()}, ${c.score ?? 0})`;
    const id = Number(this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0);
    return { id, created: true, status: "new" as const };
  }
  listCandidates(status?: string, limit = 50): Candidate[] {
    return status
      ? this.sql<Candidate>`SELECT * FROM candidates WHERE status = ${status} ORDER BY when_start ASC, score DESC LIMIT ${limit}`
      : this.sql<Candidate>`SELECT * FROM candidates ORDER BY id DESC LIMIT ${limit}`;
  }
  private expireOld(tz: string) {
    const today = this.localToday(tz);
    this.sql`UPDATE candidates SET status = 'expired' WHERE status = 'new' AND when_start IS NOT NULL AND substr(when_start, 1, 10) < ${today}`;
  }

  // ---- ratings (from the picks page / orchestrator) ----
  rate(candidateId: number, rating: "up" | "down", reason: string | null): { ok: boolean } {
    const c = this.sql<{ id: number; title: string }>`SELECT id, title FROM candidates WHERE id = ${candidateId}`[0];
    if (!c) return { ok: false };
    this.sql`INSERT INTO feedback(candidate_id, rating, reason, ts) VALUES (${candidateId}, ${rating}, ${reason}, ${Date.now()})`;
    this.addNote("finding", `${rating === "up" ? "👍" : "👎"} ${c.title}`, reason, null, { candidate_id: candidateId, rating });
    return { ok: true };
  }
  ratings(limit = 30): (Rating & { title: string; category: string | null })[] {
    return this.sql<Rating & { title: string; category: string | null }>`SELECT f.candidate_id, f.rating, f.reason, f.ts, c.title, c.category FROM feedback f JOIN candidates c ON c.id = f.candidate_id ORDER BY f.id DESC LIMIT ${limit}`;
  }

  /** Recent recommendation sets with their picks and ratings (for the picks page). */
  getPicks(limit = 3) {
    const notes = this.listNotes(limit, "recommendation");
    return notes.map((n) => {
      const meta = (n.meta ? JSON.parse(n.meta) : {}) as { candidate_ids?: number[]; whys?: Record<string, string> };
      const ids = meta.candidate_ids ?? [];
      const picks = ids
        .map((id) => this.sql<Candidate>`SELECT * FROM candidates WHERE id = ${id}`[0])
        .filter(Boolean)
        .map((c) => {
          const r = this.sql<{ rating: string; reason: string | null }>`SELECT rating, reason FROM feedback WHERE candidate_id = ${c.id} ORDER BY id DESC LIMIT 1`[0];
          return { id: c.id, title: c.title, url: c.url, when_start: c.when_start, when_end: c.when_end, place: c.place, price: c.price, category: c.category, summary: c.summary, why: meta.whys?.[String(c.id)] ?? null, rating: r?.rating ?? null, rating_reason: r?.reason ?? null };
        });
      return { note: { id: n.id, ts: n.ts, title: n.title, body: n.body }, picks };
    });
  }

  protected extraStatus() {
    const p = this.profile();
    const counts = Object.fromEntries(this.sql<{ status: string; n: number }>`SELECT status, COUNT(*) AS n FROM candidates GROUP BY status`.map((r) => [r.status, r.n]));
    return {
      profileVersion: Number(this.kvGet("profile_version") ?? 0),
      profile: { home: p.home, radius_min: p.radius_min, categories: p.categories, keywords: p.keywords, exclusions: p.exclusions, budget_max_usd: p.budget_max_usd, deliver: p.deliver, tz: p.tz },
      candidates: counts,
      tavily: { usedToday: this.tavilyUsed(p.tz), dailyCap: this.tavilyCap() },
      nextDeliveryAt: this.kvGet("due_delivery_at") ? Number(this.kvGet("due_delivery_at")) : null,
      lastDeliveryAt: this.kvGet("last_delivery_at") ? Number(this.kvGet("last_delivery_at")) : null,
      ratings: this.ratings(10)
    };
  }
  protected memoryDigestExtra() {
    const rs = this.ratings(10);
    const lines = [];
    if (rs.length) lines.push("Recent ratings: " + rs.map((r) => `${r.rating === "up" ? "👍" : "👎"} ${r.title}${r.reason ? ` (${r.reason})` : ""}`).join("; "));
    const rec = this.sql<{ title: string }>`SELECT title FROM candidates WHERE status = 'recommended' ORDER BY recommended_at DESC LIMIT 15`;
    if (rec.length) lines.push("Already recommended (do not repeat): " + rec.map((r) => r.title).join("; "));
    return lines;
  }
  setProfile(patch: Partial<SearchProfile>, actor = "orchestrator") {
    const current = this.getConfig<Partial<SearchProfile>>("search_profile") ?? {};
    const merged = { ...current, ...patch };
    this.setConfig({ search_profile: merged }, actor);
    const v = Number(this.kvGet("profile_version") ?? 0) + 1;
    this.kvSet("profile_version", String(v));
    return { version: v, profile: this.profile() };
  }

  // ---- mode selection ----
  private decideMode(ctx: TickCtx, p: SearchProfile): { mode: "research" | "deliver" | "quiet"; due: number | null } {
    const now = ctx.now;
    const lastDelivery = Number(this.kvGet("last_delivery_at") ?? 0);
    // The stored slot only matters when we are at (or a little past) it and have not delivered for it yet.
    const stored = this.kvGet("due_delivery_at") ? Number(this.kvGet("due_delivery_at")) : null;
    let due = nextDelivery(p.deliver, p.tz, now);
    if (stored !== null && stored <= now + DELIVER_EARLY_MS && stored >= now - 6 * 3600_000 && lastDelivery < stored - 3600_000) due = stored;
    this.kvSet("due_delivery_at", due ? String(due) : null);
    const forced = /deliver/i.test(ctx.reason);
    const dueNow = due !== null && now >= due - DELIVER_EARLY_MS && lastDelivery < due - 3600_000;
    if (forced || dueNow) return { mode: "deliver", due };
    const lp = partsInZone(now, p.tz);
    const weekday = lp.dow >= 1 && lp.dow <= 5;
    const daytime = lp.hour >= 7 && lp.hour < 22;
    const researchToday = Number(this.kvGet(`research_count:${this.localToday(p.tz)}`) ?? 0);
    const cap = p.research_ticks_per_day ?? 2;
    if (weekday && daytime && researchToday < cap && this.tavilyUsed(p.tz) < this.tavilyCap()) return { mode: "research", due };
    if (/research/i.test(ctx.reason) && this.tavilyUsed(p.tz) < this.tavilyCap()) return { mode: "research", due };
    return { mode: "quiet", due };
  }

  protected async observe(ctx: TickCtx): Promise<Observation> {
    const p = this.profile();
    this.expireOld(p.tz);
    const { mode, due } = this.decideMode(ctx, p);
    ctx.scratch.mode = mode;
    ctx.scratch.due = due;
    const weekends = upcomingWeekends(p.tz, ctx.now);
    const counts = Object.fromEntries(this.sql<{ status: string; n: number }>`SELECT status, COUNT(*) AS n FROM candidates GROUP BY status`.map((r) => [r.status, r.n]));
    const common = {
      local_time: fmtInZone(ctx.now, p.tz),
      weekends,
      next_delivery: due ? fmtInZone(due, p.tz) : null,
      tavily: { used_today: this.tavilyUsed(p.tz), cap: this.tavilyCap() },
      candidates: counts
    };
    if (mode === "research") {
      this.kvSet(`research_count:${this.localToday(p.tz)}`, String(Number(this.kvGet(`research_count:${this.localToday(p.tz)}`) ?? 0) + 1));
      const known = this.listCandidates("new", 12).map((c) => ({ id: c.id, title: c.title, when: c.when_start, category: c.category }));
      return {
        mode,
        data: { ...common, profile: { home: p.home, radius_min: p.radius_min, categories: p.categories, keywords: p.keywords, exclusions: p.exclusions, budget_max_usd: p.budget_max_usd, sources: p.sources }, known_candidates: known },
        hints: [
          "Run 4–8 web_search queries (rotate keywords, add season/holiday angles), read 2–4 promising pages, and candidate_upsert real dated events on the upcoming weekends AS YOU GO (max 3 upserts per step; never save everything in one final step).",
          "Do not upsert without a date and a place. Candidates the tool reports as already known need no further work."
        ]
      };
    }
    if (mode === "deliver") {
      const pool = this.sql<Candidate>`SELECT * FROM candidates WHERE status = 'new' AND (when_start IS NULL OR substr(when_start,1,10) <= ${weekends.nextSun}) ORDER BY score DESC, when_start ASC LIMIT 30`;
      return {
        mode,
        data: {
          ...common,
          pool: pool.map((c) => ({ id: c.id, title: c.title, when: c.when_start, place: c.place, price: c.price, category: c.category, summary: c.summary, url: c.url })),
          recently_recommended: this.sql<{ title: string }>`SELECT title FROM candidates WHERE status = 'recommended' ORDER BY recommended_at DESC LIMIT 20`.map((r) => r.title)
        },
        hints: [
          pool.length >= 3 ? "Call recommend with 5–7 picks (fewer if the pool is thin; never pad), then finish." : "Pool is thin: you may run up to 4 web_search queries first, upsert what you find, then recommend what is real, then finish.",
          "After delivering, wake for the next research window (about 43200s)."
        ]
      };
    }
    return { mode, data: common, hints: ["Quiet hours. Just finish with a wake that lands on the next research window (weekday 7:00–22:00 local) or delivery, whichever is sooner."] };
  }

  protected agentTools(ctx: TickCtx): ToolSet {
    const p = this.profile();
    return {
      web_search: tool({
        description: "Web search (Tavily). Returns up to 8 results with title, url, snippet. Costs 1 search credit; the daily cap is enforced.",
        inputSchema: z.object({ query: z.string().min(3).max(200), days: z.number().int().min(1).max(60).optional() }),
        execute: async ({ query, days }) => {
          if (!this.env.TAVILY_API_KEY) return { error: "TAVILY_API_KEY not configured" };
          const used = this.tavilyUsed(p.tz);
          if (used >= this.tavilyCap()) return { error: `daily search cap reached (${used}/${this.tavilyCap()})` };
          if (ctx.budget.remaining < 3) return { error: "fetch budget exhausted this tick" };
          this.kvSet(`tavily_used:${this.localToday(p.tz)}`, String(used + 1));
          try {
            return { results: await tavilySearch(ctx.fetch, this.env.TAVILY_API_KEY, query, { maxResults: 8, days }) };
          } catch (err) {
            return { error: String((err as Error).message).slice(0, 200) };
          }
        }
      }),
      read_page: tool({
        description: "Read a web page as text (truncated to ~12k chars). Use for event pages to get date, place, price. Costs at most 1 search credit when the page needs extraction.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          if (ctx.budget.remaining < 3) return { error: "fetch budget exhausted this tick" };
          try {
            const r = await readPage(ctx.fetch, url, { tavilyKey: this.env.TAVILY_API_KEY });
            return { url, via: r.via, content: r.content };
          } catch (err) {
            return { error: String((err as Error).message).slice(0, 200) };
          }
        }
      }),
      events_search: tool({
        description: "Structured ticketed events in Connecticut from Ticketmaster for a date range (YYYY-MM-DD). Returns [] if not configured.",
        inputSchema: z.object({ keyword: z.string().max(80).optional(), start: z.string(), end: z.string() }),
        execute: async ({ keyword, start, end }) => {
          if (ctx.budget.remaining < 3) return { error: "fetch budget exhausted this tick" };
          try {
            return { events: await ticketmasterEvents(ctx.fetch, this.env.TICKETMASTER_API_KEY, { keyword, start: `${start}T00:00:00Z`, end: `${end}T23:59:59Z` }) };
          } catch (err) {
            return { error: String((err as Error).message).slice(0, 200) };
          }
        }
      }),
      candidate_upsert: tool({
        description: "Save a concrete, dated, located activity as a candidate. Dedupes by URL or title+date. when_start as YYYY-MM-DD or YYYY-MM-DDTHH:MM.",
        inputSchema: z.object({
          url: z.string().url(),
          title: z.string().min(3).max(200),
          when_start: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/),
          when_end: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).optional(),
          place: z.string().min(2).max(160),
          price: z.number().min(0).max(5000).nullable().optional(),
          category: z.string().max(60),
          summary: z.string().max(300),
          score: z.number().min(0).max(10).default(5)
        }),
        execute: async (c) => this.candidateUpsert({ ...c, source: "scout" })
      }),
      candidate_mark: tool({
        description: "Mark a candidate rejected (bad fit) or expired.",
        inputSchema: z.object({ id: z.number().int(), status: z.enum(["rejected", "expired"]), reason: z.string().max(200).optional() }),
        execute: async ({ id, status }) => {
          this.sql`UPDATE candidates SET status = ${status} WHERE id = ${id}`;
          return { ok: true };
        }
      }),
      recommend: tool({
        description: "Deliver this cycle's picks: 3–7 candidate ids with a one-line why each. Writes the recommendation note, marks them recommended, and pushes to the phone.",
        inputSchema: z.object({
          picks: z.array(z.object({ candidate_id: z.number().int(), why: z.string().min(3).max(200) })).min(1).max(7),
          intro: z.string().max(200).optional()
        }),
        execute: async ({ picks, intro }) => {
          const rows = picks.map((pk) => ({ pk, c: this.sql<Candidate>`SELECT * FROM candidates WHERE id = ${pk.candidate_id}`[0] })).filter((x) => x.c);
          if (!rows.length) return { error: "no valid candidate ids" };
          const w = upcomingWeekends(p.tz, ctx.now);
          const title = `Weekend picks · ${w.thisSat} – ${w.thisSun}`;
          const lines = rows.map(({ pk, c }, i) => `${i + 1}. **${c.title}** — ${c.when_start ?? "date: see link"}${c.place ? `, ${c.place}` : ""}${c.price !== null && c.price !== undefined ? `, $${c.price}` : ""}\n   ${pk.why}\n   ${c.url}`);
          const body = (intro ? intro + "\n\n" : "") + lines.join("\n");
          const whys = Object.fromEntries(rows.map(({ pk }) => [String(pk.candidate_id), pk.why]));
          const note = this.addNote("recommendation", title, body, ctx.runId, { candidate_ids: rows.map((r) => r.c.id), whys });
          for (const { c } of rows) this.sql`UPDATE candidates SET status = 'recommended', recommended_at = ${ctx.now} WHERE id = ${c.id}`;
          this.kvSet("last_delivery_at", String(ctx.now));
          const nextDue = nextDelivery(p.deliver, p.tz, ctx.now + 15 * 60_000);
          this.kvSet("due_delivery_at", nextDue ? String(nextDue) : null);
          let pushed = false;
          if (ctx.budget.remaining >= 1) {
            try {
              pushed = await notify(ctx.fetch, this.env.NTFY_TOPIC, { title, body: rows.map(({ c }, i) => `${i + 1}. ${c.title} (${c.when_start ?? "?"})`).join("\n"), priority: 3 });
            } catch {}
          }
          return { ok: true, note_id: note.id, count: rows.length, pushed, next_delivery: nextDue ? fmtInZone(nextDue, p.tz) : null };
        }
      })
    };
  }

  protected defaultWake(_obs: Observation, ctx: TickCtx): number {
    const mode = ctx.scratch.mode as string;
    if (mode === "deliver") return 43_200;
    if (mode === "research") return 28_800;
    return 21_600;
  }

  protected adjustWake(seconds: number, ctx: TickCtx): number {
    const due = ctx.scratch.due as number | null;
    if (!due) return seconds;
    const untilDue = Math.max(60, Math.floor((due - DELIVER_EARLY_MS / 2 - Date.now()) / 1000));
    return Math.min(seconds, untilDue);
  }
}
