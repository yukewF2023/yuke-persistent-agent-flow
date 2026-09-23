import { tool, type ToolSet } from "ai";
import { z } from "zod";
import charter from "../../charters/weekend-scout.md";
import { BaseAgent, type Observation, type TickCtx } from "./base-agent";
import { tavilySearch } from "../tools/search";
import { readPage } from "../tools/reader";
import { notify } from "../tools/notify";
import { fmtInZone, nextDelivery, partsInZone, upcomingWeekends } from "../tools/time";
import type { WorkItem } from "../types";

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
interface PageRow {
  id: number;
  url: string;
  url_norm: string;
  fetched_at: number;
  text: string;
  source: string;
  status: string;
}
interface SearchRow {
  id: number;
  query: string;
  ts: number;
  hits: string;
  status: string;
}

const DELIVER_EARLY_MS = 10 * 60_000;
const SOURCE_REFRESH_MS = 6 * 3600_000;
const TIDY_EVERY_MS = 3600_000;
const DELIVERY_CHECK_MS = 5 * 60_000;
const PLAN_EVERY_MS = 2 * 3600_000;

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
  readonly defaultMonthlyBudgetUsd = 30;

  protected ensureExtraSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, url_norm TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        when_start TEXT, when_end TEXT, place TEXT, price REAL, category TEXT, summary TEXT, source TEXT, first_seen INTEGER NOT NULL,
        score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', recommended_at INTEGER);
      CREATE INDEX IF NOT EXISTS candidates_status ON candidates(status, when_start);
      CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL, rating TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, url_norm TEXT NOT NULL, fetched_at INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new');
      CREATE INDEX IF NOT EXISTS pages_norm ON pages(url_norm, fetched_at DESC);
      CREATE TABLE IF NOT EXISTS searches (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, ts INTEGER NOT NULL, hits TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new');
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
    return this.profile().tavily_daily_cap ?? 33;
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
    this.activity("candidate", `new candidate: ${c.title} (${c.when_start ?? "?"})`);
    return { id, created: true, status: "new" as const };
  }
  listCandidates(status?: string, limit = 50): Candidate[] {
    return status ? this.sql<Candidate>`SELECT * FROM candidates WHERE status = ${status} ORDER BY when_start ASC, score DESC LIMIT ${limit}` : this.sql<Candidate>`SELECT * FROM candidates ORDER BY id DESC LIMIT ${limit}`;
  }
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
  getPicks(limit = 3) {
    return this.listNotes(limit, "recommendation").map((n) => {
      const meta = (n.meta ? JSON.parse(n.meta) : {}) as { candidate_ids?: number[]; whys?: Record<string, string> };
      const picks = (meta.candidate_ids ?? [])
        .map((id) => this.sql<Candidate>`SELECT * FROM candidates WHERE id = ${id}`[0])
        .filter(Boolean)
        .map((c) => {
          const r = this.sql<{ rating: string; reason: string | null }>`SELECT rating, reason FROM feedback WHERE candidate_id = ${c.id} ORDER BY id DESC LIMIT 1`[0];
          return { id: c.id, title: c.title, url: c.url, when_start: c.when_start, when_end: c.when_end, place: c.place, price: c.price, category: c.category, summary: c.summary, why: meta.whys?.[String(c.id)] ?? null, rating: r?.rating ?? null, rating_reason: r?.reason ?? null };
        });
      return { note: { id: n.id, ts: n.ts, title: n.title, body: n.body }, picks };
    });
  }
  setProfile(patch: Partial<SearchProfile>, actor = "orchestrator") {
    const merged = { ...(this.getConfig<Partial<SearchProfile>>("search_profile") ?? {}), ...patch };
    this.setConfig({ search_profile: merged }, actor);
    const v = Number(this.kvGet("profile_version") ?? 0) + 1;
    this.kvSet("profile_version", String(v));
    return { version: v, profile: this.profile() };
  }

  protected extraStatus() {
    const p = this.profile();
    const counts = Object.fromEntries(this.sql<{ status: string; n: number }>`SELECT status, COUNT(*) AS n FROM candidates GROUP BY status`.map((r) => [r.status, r.n]));
    return {
      profileVersion: Number(this.kvGet("profile_version") ?? 0),
      profile: { home: p.home, radius_min: p.radius_min, categories: p.categories, keywords: p.keywords, exclusions: p.exclusions, budget_max_usd: p.budget_max_usd, deliver: p.deliver, tz: p.tz },
      candidates: counts,
      pagesUnextracted: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM pages WHERE status = 'new'`[0]?.n ?? 0),
      searchesToday: this.tavilyUsed(p.tz),
      tavily: { usedToday: this.tavilyUsed(p.tz), dailyCap: this.tavilyCap() },
      nextDeliveryAt: this.kvGet("due_delivery_at") ? Number(this.kvGet("due_delivery_at")) : null,
      lastDeliveryAt: this.kvGet("last_delivery_at") ? Number(this.kvGet("last_delivery_at")) : null,
      ratings: this.ratings(10)
    };
  }
  protected memoryDigestExtra() {
    const lines: string[] = [];
    const rs = this.ratings(8);
    if (rs.length) lines.push("Recent ratings: " + rs.map((r) => `${r.rating === "up" ? "👍" : "👎"} ${r.title}${r.reason ? ` (${r.reason})` : ""}`).join("; "));
    const rec = this.sql<{ title: string }>`SELECT title FROM candidates WHERE status = 'recommended' ORDER BY recommended_at DESC LIMIT 12`;
    if (rec.length) lines.push("Already recommended (do not repeat): " + rec.map((r) => r.title).join("; "));
    const known = this.sql<{ title: string; when_start: string | null }>`SELECT title, when_start FROM candidates WHERE status = 'new' ORDER BY when_start LIMIT 15`;
    if (known.length) lines.push("Candidate pool: " + known.map((k) => `${k.title} (${k.when_start ?? "?"})`).join("; "));
    return lines;
  }

  protected plannableActions() {
    return ["search", "read_page", "refresh_source", "expire_and_tidy", "check_delivery", "triage", "extract", "plan"];
  }
  protected idleLabel(): string {
    const p = this.profile();
    const gap = Math.ceil(86_400_000 / Math.max(1, this.tavilyCap()));
    const s = Math.max(0, Math.round((gap - (Date.now() - Number(this.kvGet("last_search_at") ?? 0))) / 1000));
    const due = this.kvGet("due_delivery_at") ? fmtInZone(Number(this.kvGet("due_delivery_at")), p.tz) : "?";
    return `curating · next search in ${Math.round(s / 60)} min · searches today ${this.tavilyUsed(p.tz)}/${this.tavilyCap()} · next delivery ${due}`;
  }

  // ---- worklist seeding ----
  protected seedWork(_ctx: TickCtx) {
    const p = this.profile();
    const now = Date.now();
    if (now - Number(this.kvGet("last_tidy_at") ?? 0) >= TIDY_EVERY_MS) this.addWork("code", "expire_and_tidy", null, 3);
    if (now - Number(this.kvGet("last_delivery_check_at") ?? 0) >= DELIVERY_CHECK_MS) this.addWork("code", "check_delivery", null, 1);
    // pages waiting for extraction → think
    for (const pg of this.sql<{ id: number }>`SELECT id FROM pages WHERE status = 'new' ORDER BY id LIMIT 3`) this.addWork("think", "extract", { page_id: pg.id }, 4);
    // searches waiting for triage → think
    for (const s of this.sql<{ id: number }>`SELECT id FROM searches WHERE status = 'new' ORDER BY id LIMIT 3`) this.addWork("think", "triage", { search_id: s.id }, 4);
    // curated sources, staggered
    for (const src of p.sources) {
      const last = this.sql<{ fetched_at: number }>`SELECT fetched_at FROM pages WHERE url_norm = ${normUrl(src)} ORDER BY fetched_at DESC LIMIT 1`[0]?.fetched_at ?? 0;
      if (now - last >= SOURCE_REFRESH_MS) this.addWork("code", "refresh_source", { url: src }, 5);
    }
    // paced searches from the keyword rotation
    const searchGap = Math.ceil(86_400_000 / Math.max(1, this.tavilyCap()));
    if (this.env.TAVILY_API_KEY && this.tavilyUsed(p.tz) < this.tavilyCap() && now - Number(this.kvGet("last_search_at") ?? 0) >= searchGap) {
      const planned = this.kvJson<string[]>("planned_queries") ?? [];
      const q = planned.length ? planned[0] : p.keywords[Number(this.kvGet("kw_idx") ?? 0) % Math.max(1, p.keywords.length)];
      if (q) this.addWork("code", "search", { query: q }, 5);
    }
    if (now - Number(this.kvGet("last_plan_at") ?? 0) >= PLAN_EVERY_MS) this.addWork("think", "plan", null, 6);
  }

  protected async runCode(action: string, args: Record<string, unknown>, ctx: TickCtx): Promise<string> {
    const p = this.profile();
    switch (action) {
      case "expire_and_tidy": {
        const today = this.localToday(p.tz);
        const r = this.sql`UPDATE candidates SET status = 'expired' WHERE status = 'new' AND when_start IS NOT NULL AND substr(when_start, 1, 10) < ${today}`;
        this.sql`DELETE FROM pages WHERE id NOT IN (SELECT id FROM pages ORDER BY id DESC LIMIT 200)`;
        this.sql`DELETE FROM searches WHERE id NOT IN (SELECT id FROM searches ORDER BY id DESC LIMIT 200)`;
        this.kvSet("last_tidy_at", String(Date.now()));
        void r;
        return `expired past candidates; pool: ${this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM candidates WHERE status = 'new'`[0]?.n ?? 0} new`;
      }
      case "check_delivery": {
        const now = Date.now();
        this.kvSet("last_delivery_check_at", String(now));
        const lastDelivery = Number(this.kvGet("last_delivery_at") ?? 0);
        const stored = this.kvGet("due_delivery_at") ? Number(this.kvGet("due_delivery_at")) : null;
        let due = nextDelivery(p.deliver, p.tz, now);
        if (stored !== null && stored <= now + DELIVER_EARLY_MS && stored >= now - 6 * 3600_000 && lastDelivery < stored - 3600_000) due = stored;
        this.kvSet("due_delivery_at", due ? String(due) : null);
        if (due !== null && now >= due - DELIVER_EARLY_MS && lastDelivery < due - 3600_000) {
          this.addWork("think", "deliver", null, 1);
          return `delivery due (${fmtInZone(due, p.tz)}) → queued deliver`;
        }
        return `next delivery ${due ? fmtInZone(due, p.tz) : "unset"}`;
      }
      case "refresh_source":
      case "read_page": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//.test(url)) throw new Error("bad url");
        if (ctx.budget.remaining < 3) throw new Error("fetch budget exhausted this segment");
        const r = await readPage(ctx.fetch, url, { tavilyKey: this.env.TAVILY_API_KEY, maxChars: 6000 });
        this.sql`INSERT INTO pages(url, url_norm, fetched_at, text, source, status) VALUES (${url}, ${normUrl(url)}, ${Date.now()}, ${r.content}, ${action === "refresh_source" ? "source" : "search"}, 'new')`;
        const id = Number(this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0);
        this.addWork("think", "extract", { page_id: id }, 4);
        return `read ${new URL(url).host} (${r.content.length} chars via ${r.via}) → page #${id} queued for extraction`;
      }
      case "search": {
        const query = String(args.query ?? "");
        if (!this.env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY not configured");
        if (this.tavilyUsed(p.tz) >= this.tavilyCap()) return `search cap reached (${this.tavilyCap()}/day); skipped "${query}"`;
        if (ctx.budget.remaining < 3) throw new Error("fetch budget exhausted this segment");
        this.kvSet(`tavily_used:${this.localToday(p.tz)}`, String(this.tavilyUsed(p.tz) + 1));
        this.kvSet("last_search_at", String(Date.now()));
        const planned = this.kvJson<string[]>("planned_queries") ?? [];
        if (planned[0] === query) this.kvSet("planned_queries", JSON.stringify(planned.slice(1)));
        else this.kvSet("kw_idx", String(Number(this.kvGet("kw_idx") ?? 0) + 1));
        const hits = await tavilySearch(ctx.fetch, this.env.TAVILY_API_KEY, query, { maxResults: 6 });
        this.sql`INSERT INTO searches(query, ts, hits, status) VALUES (${query}, ${Date.now()}, ${JSON.stringify(hits)}, 'new')`;
        const id = Number(this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0);
        this.addWork("think", "triage", { search_id: id }, 4);
        return `"${query}" → ${hits.length} hits → search #${id} queued for triage`;
      }
      default:
        throw new Error(`unknown code action ${action}`);
    }
  }

  protected async thinkContext(item: WorkItem, ctx: TickCtx): Promise<Observation> {
    const p = this.profile();
    const args = item.args ? (JSON.parse(item.args) as Record<string, unknown>) : {};
    const weekends = upcomingWeekends(p.tz, ctx.now);
    const common = { local_time: fmtInZone(ctx.now, p.tz), weekends, profile: { home: p.home, radius_min: p.radius_min, categories: p.categories, exclusions: p.exclusions, budget_max_usd: p.budget_max_usd } };
    if (item.action === "extract") {
      const pg = this.sql<PageRow>`SELECT * FROM pages WHERE id = ${Number(args.page_id)}`[0];
      if (pg) this.sql`UPDATE pages SET status = 'extracted' WHERE id = ${pg.id}`;
      return { mode: "extract", data: { ...common, page: pg ? { id: pg.id, url: pg.url, fetched_at: new Date(pg.fetched_at).toISOString(), text: pg.text } : null }, hints: ["Upsert up to 3 real, dated, located items from this page (candidate_upsert). If nothing usable, just finish."] };
    }
    if (item.action === "triage") {
      const s = this.sql<SearchRow>`SELECT * FROM searches WHERE id = ${Number(args.search_id)}`[0];
      if (s) this.sql`UPDATE searches SET status = 'triaged' WHERE id = ${s.id}`;
      const known = new Set(this.sql<{ url_norm: string }>`SELECT url_norm FROM pages`.map((r) => r.url_norm));
      const hits = s ? (JSON.parse(s.hits) as { title: string; url: string; snippet: string }[]).map((h) => ({ ...h, already_read: known.has(normUrl(h.url)) })) : [];
      return { mode: "triage", data: { ...common, query: s?.query, hits }, hints: ["plan_work code read_page {url} for the 1–3 most promising dated local results not already read, then finish. Don't read aggregator/list pages unless they clearly hold dated events."] };
    }
    if (item.action === "deliver") {
      const pool = this.sql<Candidate>`SELECT * FROM candidates WHERE status = 'new' AND (when_start IS NULL OR substr(when_start,1,10) <= ${weekends.nextSun}) ORDER BY score DESC, when_start ASC LIMIT 30`;
      return { mode: "deliver", data: { ...common, pool: pool.map((c) => ({ id: c.id, title: c.title, when: c.when_start, place: c.place, price: c.price, category: c.category, summary: c.summary })), recently_recommended: this.sql<{ title: string }>`SELECT title FROM candidates WHERE status = 'recommended' ORDER BY recommended_at DESC LIMIT 20`.map((r) => r.title) }, hints: [pool.length >= 3 ? "Call recommend with 5–7 picks (fewer if thin; never pad), then finish." : "Pool is thin: recommend what is real (even 2–3), plan_work a few search items for next time, then finish."] };
    }
    if (item.action === "plan") {
      this.kvSet("last_plan_at", String(ctx.now));
      const counts = Object.fromEntries(this.sql<{ status: string; n: number }>`SELECT status, COUNT(*) AS n FROM candidates GROUP BY status`.map((r) => [r.status, r.n]));
      const recentQueries = this.sql<{ query: string }>`SELECT query FROM searches ORDER BY id DESC LIMIT 12`.map((r) => r.query);
      const byCat = Object.fromEntries(this.sql<{ category: string; n: number }>`SELECT category, COUNT(*) AS n FROM candidates WHERE status = 'new' GROUP BY category`.map((r) => [r.category, r.n]));
      return { mode: "plan", data: { ...common, keywords: p.keywords, sources: p.sources, candidates: counts, pool_by_category: byCat, recent_queries: recentQueries, searches_today: `${this.tavilyUsed(p.tz)}/${this.tavilyCap()}` }, hints: ["Use set_planned_queries with 2–4 fresh, specific queries covering under-represented categories and the season (new queries only; they run automatically, paced). Optionally plan_work refresh_source for a source worth re-reading. Then finish."] };
    }
    if (item.action === "manager_task") return { mode: "manager_task", data: { ...common, task: args }, hints: ["Do the task, then queue_complete or queue_drop, then finish."] };
    return { mode: item.action, data: common, hints: [] };
  }

  protected agentTools(ctx: TickCtx): ToolSet {
    const p = this.profile();
    return {
      web_search: tool({
        description: "Immediate web search (Tavily, 1 credit, daily cap). Prefer planning `search` code items; use this only when a delivery needs more options right now.",
        inputSchema: z.object({ query: z.string().min(3).max(200) }),
        execute: async ({ query }) => {
          if (!this.env.TAVILY_API_KEY) return { error: "TAVILY_API_KEY not configured" };
          if (this.tavilyUsed(p.tz) >= this.tavilyCap()) return { error: "daily search cap reached" };
          if (ctx.budget.remaining < 3) return { error: "fetch budget exhausted this segment" };
          this.kvSet(`tavily_used:${this.localToday(p.tz)}`, String(this.tavilyUsed(p.tz) + 1));
          try {
            return { results: await tavilySearch(ctx.fetch, this.env.TAVILY_API_KEY, query, { maxResults: 6 }) };
          } catch (err) {
            return { error: String((err as Error).message).slice(0, 200) };
          }
        }
      }),
      set_planned_queries: tool({
        description: "Queue specific search queries to run automatically (paced by the daily cap). Replaces the planned list.",
        inputSchema: z.object({ queries: z.array(z.string().min(3).max(120)).min(1).max(6) }),
        execute: async ({ queries }) => {
          this.kvSet("planned_queries", JSON.stringify(queries));
          return { ok: true, planned: queries };
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
        description: "Deliver this cycle's picks: 2–7 candidate ids with a one-line why each. Writes the recommendation note, marks them recommended, pushes to the phone.",
        inputSchema: z.object({ picks: z.array(z.object({ candidate_id: z.number().int(), why: z.string().min(3).max(200) })).min(1).max(7), intro: z.string().max(200).optional() }),
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
          this.activity("deliver", `delivered ${rows.length} picks (${title})`, ctx.item?.id ?? null);
          return { ok: true, note_id: note.id, count: rows.length, pushed, next_delivery: nextDue ? fmtInZone(nextDue, p.tz) : null };
        }
      })
    };
  }
}
