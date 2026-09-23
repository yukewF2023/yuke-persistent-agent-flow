import { tool, type ToolSet } from "ai";
import { z } from "zod";
import charter from "../../charters/uptime.md";
import { BaseAgent, type Observation, type TickCtx } from "./base-agent";
import { checkUrl, countedFetch, mapChunked, type UrlCheck } from "../tools/http";
import type { WorkItem } from "../types";

interface Target {
  url: string;
  expect?: string | null;
}
interface TargetRow {
  url: string;
  expect: string | null;
  last_status: number | null;
  last_ok: number | null;
  last_latency_ms: number | null;
  last_checked: number | null;
  last_changed: number | null;
  consecutive_failures: number;
  last_error: string | null;
  baseline_latency_ms: number | null;
}
interface ProbeRow {
  url: string;
  ts: number;
  status: number;
  ttfb_ms: number;
  total_ms: number;
  bytes: number;
}

const CHECK_EVERY_MS = 60_000;
const PROBE_EVERY_MS = 30_000;
const REPORT_EVERY_MS = 3600_000;

export class UptimeAgent extends BaseAgent {
  readonly agentId = "uptime" as const;
  readonly displayName = "Uptime agent";
  readonly baseCharter = charter;
  readonly defaultMonthlyBudgetUsd = 12;

  protected ensureExtraSchema() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS targets (
      url TEXT PRIMARY KEY, expect TEXT, last_status INTEGER, last_ok INTEGER, last_latency_ms INTEGER, last_checked INTEGER,
      last_changed INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, baseline_latency_ms INTEGER);
      CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, ts INTEGER NOT NULL, status INTEGER, ttfb_ms INTEGER, total_ms INTEGER, bytes INTEGER);
      CREATE INDEX IF NOT EXISTS probes_url_ts ON probes(url, ts DESC);`);
  }

  targets(): Target[] {
    const fromConfig = this.getConfig<Target[]>("targets");
    if (fromConfig && Array.isArray(fromConfig) && fromConfig.length) return fromConfig;
    try {
      return JSON.parse(this.env.UPTIME_TARGETS) as Target[];
    } catch {
      return [];
    }
  }
  setTargets(list: Target[], actor = "agent") {
    const clean = list.filter((t) => t && typeof t.url === "string" && /^https?:\/\//.test(t.url)).map((t) => ({ url: t.url.trim(), expect: t.expect ?? null }));
    this.setConfig({ targets: clean }, actor);
    return clean;
  }
  targetRows(): TargetRow[] {
    return this.sql<TargetRow>`SELECT * FROM targets ORDER BY url`;
  }

  protected extraStatus() {
    const report = this.kvJson<Record<string, unknown>>("latency_report");
    return {
      targets: this.targetRows().map((t) => ({ url: t.url, ok: t.last_ok === 1, status: t.last_status, latency_ms: t.last_latency_ms, failures: t.consecutive_failures, since_change: t.last_changed })),
      cleanStreak: Number(this.kvGet("clean_streak") ?? 0),
      checksToday: Number(this.kvGet(`checks:${new Date().toISOString().slice(0, 10)}`) ?? 0),
      probesToday: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM probes WHERE ts >= ${Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")}`[0]?.n ?? 0),
      latencyReport: report
    };
  }
  protected memoryDigestExtra() {
    const rows = this.targetRows();
    if (!rows.length) return [];
    const down = rows.filter((r) => r.last_ok === 0);
    return [`Targets: ${rows.length} watched, ${down.length} down${down.length ? ` (${down.map((d) => new URL(d.url).host).join(", ")})` : ""}, clean streak ${this.kvGet("clean_streak") ?? 0}, checks today ${this.kvGet(`checks:${new Date().toISOString().slice(0, 10)}`) ?? 0}.`];
  }

  protected plannableActions() {
    return ["check_all", "deep_probe", "latency_report", "review"];
  }
  protected idleLabel(): string {
    const now = Date.now();
    const c = Math.max(0, Math.round((CHECK_EVERY_MS - (now - Number(this.kvGet("last_check_at") ?? 0))) / 1000));
    const p = Math.max(0, Math.round((PROBE_EVERY_MS - (now - Number(this.kvGet("last_probe_at") ?? 0))) / 1000));
    return `watching 6 apps · next check in ${c}s · next deep probe in ${p}s`;
  }
  protected hasDueWork(): boolean {
    const now = Date.now();
    return now - Number(this.kvGet("last_check_at") ?? 0) >= CHECK_EVERY_MS || now - Number(this.kvGet("last_probe_at") ?? 0) >= PROBE_EVERY_MS || this.kvGet("review_pending") === "1";
  }

  // ---- worklist seeding: always something to do, paced so the apps are not hammered ----
  protected seedWork(ctx: TickCtx) {
    const now = Date.now();
    const lastCheck = Number(this.kvGet("last_check_at") ?? 0);
    const lastProbe = Number(this.kvGet("last_probe_at") ?? 0);
    const lastReport = Number(this.kvGet("last_report_at") ?? 0);
    if (now - lastCheck >= CHECK_EVERY_MS) this.addWork("code", "check_all", null, 2);
    if (now - lastProbe >= PROBE_EVERY_MS) {
      const targets = this.targets();
      if (targets.length) {
        const i = Number(this.kvGet("probe_idx") ?? 0) % targets.length;
        this.addWork("code", "deep_probe", { url: targets[i].url }, 4);
      }
    }
    if (now - lastReport >= REPORT_EVERY_MS) this.addWork("code", "latency_report", null, 6);
    const sinceThink = Number(this.kvGet("checks_since_think") ?? 0);
    if (this.kvGet("review_pending") === "1" || sinceThink >= 8) this.addWork("think", "review", null, 3);
    void ctx;
  }

  protected async runCode(action: string, args: Record<string, unknown>, ctx: TickCtx): Promise<string> {
    if (action === "check_all") return this.checkAll(ctx);
    if (action === "deep_probe") return this.deepProbe(String(args.url ?? ""), ctx);
    if (action === "latency_report") return this.latencyReport();
    throw new Error(`unknown code action ${action}`);
  }

  private async checkAll(ctx: TickCtx): Promise<string> {
    const targets = this.targets();
    const checks = await mapChunked(targets, 5, (t) => checkUrl(ctx.fetch, t.url, t.expect ?? null));
    const now = Date.now();
    const rows = new Map(this.targetRows().map((r) => [r.url, r]));
    const known = new Set(targets.map((t) => t.url));
    for (const url of rows.keys()) if (!known.has(url)) this.sql`DELETE FROM targets WHERE url = ${url}`;
    let down = 0;
    let changed = 0;
    const summary: string[] = [];
    checks.forEach((c: UrlCheck, i) => {
      const prev = rows.get(c.url);
      const prevOk = prev?.last_ok === null || prev?.last_ok === undefined ? null : prev.last_ok === 1;
      const failures = c.ok ? 0 : (prev?.consecutive_failures ?? 0) + 1;
      const okFlipped = prevOk !== null && prevOk !== c.ok;
      const baseline = prev?.baseline_latency_ms ?? null;
      const host = new URL(c.url).host;
      if (!c.ok) down++;
      if (okFlipped) changed++;
      if (okFlipped && !c.ok) this.addNote("change", `DOWN: ${host} (${c.error ?? `http ${c.status}`})`, `${c.url} → status ${c.status}, ${c.latency_ms} ms`, ctx.runId || null, { url: c.url, status: c.status });
      if (okFlipped && c.ok) this.addNote("change", `RECOVERED: ${host} after ${prev?.consecutive_failures ?? "?"} failed checks`, `${c.url} → status ${c.status}, ${c.latency_ms} ms`, ctx.runId || null, { url: c.url, status: c.status });
      if (prevOk === null && !c.ok) this.addNote("change", `DOWN: ${host} (${c.error ?? `http ${c.status}`}) on first check`, c.url, ctx.runId || null, { url: c.url, status: c.status });
      const newBaseline = c.ok ? (baseline === null ? c.latency_ms : Math.round(baseline * 0.8 + c.latency_ms * 0.2)) : baseline;
      this.sql`INSERT INTO targets(url, expect, last_status, last_ok, last_latency_ms, last_checked, last_changed, consecutive_failures, last_error, baseline_latency_ms)
        VALUES (${c.url}, ${targets[i].expect ?? null}, ${c.status}, ${c.ok ? 1 : 0}, ${c.latency_ms}, ${now}, ${okFlipped || !prev ? now : (prev.last_changed ?? now)}, ${failures}, ${c.error}, ${newBaseline})
        ON CONFLICT(url) DO UPDATE SET expect = excluded.expect, last_status = excluded.last_status, last_ok = excluded.last_ok, last_latency_ms = excluded.last_latency_ms,
        last_checked = excluded.last_checked, last_changed = excluded.last_changed, consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error, baseline_latency_ms = excluded.baseline_latency_ms`;
      summary.push(`${host}:${c.status}/${c.latency_ms}ms${c.ok ? "" : "✗"}`);
    });
    const streak = down === 0 && changed === 0 ? Number(this.kvGet("clean_streak") ?? 0) + 1 : 0;
    this.kvSet("clean_streak", String(streak));
    this.kvSet("last_check_at", String(now));
    const day = new Date(now).toISOString().slice(0, 10);
    this.kvSet(`checks:${day}`, String(Number(this.kvGet(`checks:${day}`) ?? 0) + 1));
    this.kvSet("checks_since_think", String(Number(this.kvGet("checks_since_think") ?? 0) + 1));
    this.kvSet("last_check", JSON.stringify({ at: now, down, changed, streak, targets: checks.map((c) => ({ url: c.url, ok: c.ok, status: c.status, latency_ms: c.latency_ms, error: c.error })) }));
    if (changed || down) this.kvSet("review_pending", "1");
    return `${targets.length - down}/${targets.length} ok${down ? `, ${down} down` : ""}${changed ? `, ${changed} changed` : ""} · ${summary.join(" ")}`;
  }

  private async deepProbe(url: string, ctx: TickCtx): Promise<string> {
    const t0 = Date.now();
    let status = 0;
    let ttfb = 0;
    let bytes = 0;
    try {
      const res = await countedFetch({ ...ctx.fetch, timeoutMs: 15_000 }, url, { headers: { "user-agent": "yuke-persistent-agent-flow/uptime-probe" } });
      ttfb = Date.now() - t0;
      status = res.status;
      bytes = (await res.arrayBuffer()).byteLength;
    } catch (err) {
      return `probe ${new URL(url).host} failed: ${String((err as Error).message).slice(0, 80)}`;
    }
    const total = Date.now() - t0;
    this.sql`INSERT INTO probes(url, ts, status, ttfb_ms, total_ms, bytes) VALUES (${url}, ${t0}, ${status}, ${ttfb}, ${total}, ${bytes})`;
    this.sql`DELETE FROM probes WHERE ts < ${t0 - 2 * 86_400_000}`;
    this.kvSet("last_probe_at", String(t0));
    this.kvSet("probe_idx", String(Number(this.kvGet("probe_idx") ?? 0) + 1));
    const hist = this.sql<{ ttfb_ms: number; bytes: number }>`SELECT ttfb_ms, bytes FROM probes WHERE url = ${url} ORDER BY ts DESC LIMIT 20`;
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
    const medTtfb = med(hist.map((h) => h.ttfb_ms));
    const medBytes = med(hist.map((h) => h.bytes));
    let flag = "";
    if (hist.length >= 5 && ttfb > 3 * medTtfb && ttfb > 1500) {
      flag = ` ⚠ ttfb ${ttfb}ms vs median ${medTtfb}ms`;
      this.kvSet("review_pending", "1");
    }
    if (hist.length >= 5 && medBytes > 0 && Math.abs(bytes - medBytes) / medBytes > 0.3) {
      flag += ` ⚠ size ${bytes}B vs median ${medBytes}B`;
      this.kvSet("review_pending", "1");
    }
    return `${new URL(url).host} ${status} ttfb ${ttfb}ms total ${total}ms ${bytes}B${flag}`;
  }

  private latencyReport(): string {
    const since = Date.now() - 86_400_000;
    const rows = this.sql<ProbeRow>`SELECT url, ts, status, ttfb_ms, total_ms, bytes FROM probes WHERE ts > ${since}`;
    const byUrl = new Map<string, number[]>();
    for (const r of rows) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r.ttfb_ms]);
    const report: Record<string, { n: number; median_ms: number; p95_ms: number }> = {};
    for (const [url, xs] of byUrl) {
      const s = [...xs].sort((a, b) => a - b);
      report[new URL(url).host] = { n: s.length, median_ms: s[Math.floor(s.length / 2)], p95_ms: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
    }
    this.kvSet("latency_report", JSON.stringify({ at: Date.now(), hours: 24, hosts: report }));
    this.kvSet("last_report_at", String(Date.now()));
    return `24h latency: ${Object.entries(report).map(([h, r]) => `${h} med ${r.median_ms}ms p95 ${r.p95_ms}ms (${r.n})`).join("; ") || "no probes yet"}`;
  }

  protected async thinkContext(item: WorkItem, _ctx: TickCtx): Promise<Observation> {
    this.kvSet("checks_since_think", "0");
    this.kvSet("review_pending", null);
    const last = this.kvJson<Record<string, unknown>>("last_check");
    const report = this.kvJson<Record<string, unknown>>("latency_report");
    const recentChanges = this.listNotes(5, "change").map((n) => ({ at: new Date(n.ts).toISOString(), title: n.title }));
    if (item.action === "manager_task") {
      return { mode: "manager_task", data: { task: item.args, targets: this.targets(), last_check: last }, hints: ["Do the task with set_targets / check_url, then queue_complete or queue_drop, then finish."] };
    }
    return {
      mode: "review",
      data: { last_check: last, latency_report_24h: report, recent_changes: recentChanges, targets: this.targetRows().map((t) => ({ host: new URL(t.url).host, ok: t.last_ok === 1, failures: t.consecutive_failures, baseline_ms: t.baseline_latency_ms, last_ms: t.last_latency_ms })) },
      hints: ["Only write a note if there is a real pattern (flapping, creeping latency, long outage). Otherwise just finish with a one-line summary."]
    };
  }

  protected agentTools(ctx: TickCtx): ToolSet {
    return {
      check_url: tool({
        description: "Re-check one URL right now (status, latency, optional expected text).",
        inputSchema: z.object({ url: z.string().url(), expect: z.string().max(100).optional() }),
        execute: async ({ url, expect }) => (ctx.budget.remaining < 2 ? { error: "fetch budget exhausted this segment" } : checkUrl(ctx.fetch, url, expect ?? null))
      }),
      set_targets: tool({
        description: "Replace the full watched target list (for manager tasks like 'add target X'). Include existing targets you want to keep.",
        inputSchema: z.object({ targets: z.array(z.object({ url: z.string().url(), expect: z.string().max(100).nullable().optional() })).min(1).max(30) }),
        execute: async ({ targets }) => ({ targets: this.setTargets(targets, "agent") })
      })
    };
  }
}
