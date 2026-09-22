import { tool, type ToolSet } from "ai";
import { z } from "zod";
import charter from "../../charters/uptime.md";
import { BaseAgent, type Observation, type TickCtx } from "./base-agent";
import { checkUrl, mapChunked, type UrlCheck } from "../tools/http";

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

export class UptimeAgent extends BaseAgent {
  readonly agentId = "uptime" as const;
  readonly displayName = "Uptime agent";
  readonly baseCharter = charter;
  wakeBounds = { min: 120, max: 6 * 3600 };

  protected ensureExtraSchema() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS targets (
      url TEXT PRIMARY KEY, expect TEXT, last_status INTEGER, last_ok INTEGER, last_latency_ms INTEGER, last_checked INTEGER,
      last_changed INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, baseline_latency_ms INTEGER)`);
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
    return {
      targets: this.targetRows().map((t) => ({ url: t.url, ok: t.last_ok === 1, status: t.last_status, latency_ms: t.last_latency_ms, failures: t.consecutive_failures, since_change: t.last_changed })),
      cleanStreak: Number(this.kvGet("clean_streak") ?? 0)
    };
  }
  protected memoryDigestExtra() {
    const rows = this.targetRows();
    if (!rows.length) return [];
    const down = rows.filter((r) => r.last_ok === 0);
    return [`Targets: ${rows.length} watched, ${down.length} down${down.length ? ` (${down.map((d) => new URL(d.url).host).join(", ")})` : ""}, clean streak ${this.kvGet("clean_streak") ?? 0}.`];
  }

  private async checkAll(ctx: TickCtx, targets: Target[]) {
    return mapChunked(targets, 5, (t) => checkUrl(ctx.fetch, t.url, t.expect ?? null));
  }

  protected async observe(ctx: TickCtx): Promise<Observation> {
    const targets = this.targets();
    const checks = await this.checkAll(ctx, targets);
    const now = Date.now();
    const rows = new Map(this.targetRows().map((r) => [r.url, r]));
    const known = new Set(targets.map((t) => t.url));
    for (const url of rows.keys()) if (!known.has(url)) this.sql`DELETE FROM targets WHERE url = ${url}`;

    let downCount = 0;
    let changedCount = 0;
    let recovered = 0;
    const out = checks.map((c: UrlCheck, i) => {
      const prev = rows.get(c.url);
      const prevOk = prev?.last_ok === null || prev?.last_ok === undefined ? null : prev.last_ok === 1;
      const failures = c.ok ? 0 : (prev?.consecutive_failures ?? 0) + 1;
      const okFlipped = prevOk !== null && prevOk !== c.ok;
      const statusChanged = prev?.last_status !== null && prev?.last_status !== undefined && prev.last_status !== c.status;
      const baseline = prev?.baseline_latency_ms ?? null;
      const latencySpike = c.ok && baseline !== null && baseline > 0 && c.latency_ms > 3 * baseline && c.latency_ms > 1500;
      const changed = okFlipped || (statusChanged && !c.ok);
      if (!c.ok) downCount++;
      if (changed) changedCount++;
      const host = new URL(c.url).host;
      if (okFlipped && !c.ok) this.addNote("change", `DOWN: ${host} (${c.error ?? `http ${c.status}`})`, `${c.url} → status ${c.status}, ${c.latency_ms} ms`, ctx.runId, { url: c.url, status: c.status });
      if (okFlipped && c.ok) {
        recovered++;
        this.addNote("change", `RECOVERED: ${host} after ${prev?.consecutive_failures ?? "?"} failed checks`, `${c.url} → status ${c.status}, ${c.latency_ms} ms`, ctx.runId, { url: c.url, status: c.status });
      }
      if (prevOk === null && !c.ok) this.addNote("change", `DOWN: ${host} (${c.error ?? `http ${c.status}`}) on first check`, c.url, ctx.runId, { url: c.url, status: c.status });
      const newBaseline = c.ok ? (baseline === null ? c.latency_ms : Math.round(baseline * 0.8 + c.latency_ms * 0.2)) : baseline;
      this.sql`INSERT INTO targets(url, expect, last_status, last_ok, last_latency_ms, last_checked, last_changed, consecutive_failures, last_error, baseline_latency_ms)
        VALUES (${c.url}, ${targets[i].expect ?? null}, ${c.status}, ${c.ok ? 1 : 0}, ${c.latency_ms}, ${now}, ${changed || !prev ? now : (prev.last_changed ?? now)}, ${failures}, ${c.error}, ${newBaseline})
        ON CONFLICT(url) DO UPDATE SET expect = excluded.expect, last_status = excluded.last_status, last_ok = excluded.last_ok, last_latency_ms = excluded.last_latency_ms,
        last_checked = excluded.last_checked, last_changed = excluded.last_changed, consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error, baseline_latency_ms = excluded.baseline_latency_ms`;
      return {
        url: c.url,
        ok: c.ok,
        status: c.status,
        latency_ms: c.latency_ms,
        error: c.error,
        changed,
        previously_ok: prevOk,
        consecutive_failures: failures,
        latency_spike: latencySpike,
        down_since: !c.ok && prev && prev.last_ok === 0 ? prev.last_changed : null
      };
    });
    const streak = downCount === 0 && changedCount === 0 ? Number(this.kvGet("clean_streak") ?? 0) + 1 : 0;
    this.kvSet("clean_streak", String(streak));
    ctx.scratch.downCount = downCount;
    ctx.scratch.recovered = recovered;
    ctx.scratch.streak = streak;
    return {
      mode: "check",
      data: { checked_at: new Date(now).toISOString(), targets: out, down_count: downCount, changed_count: changedCount, recovered_count: recovered, clean_streak: streak },
      hints: downCount ? [`${downCount} target(s) down — wake policy says 300s.`] : [`All ok; clean streak ${streak}.`]
    };
  }

  protected agentTools(ctx: TickCtx): ToolSet {
    return {
      check_url: tool({
        description: "Re-check one URL right now (status, latency, optional expected text).",
        inputSchema: z.object({ url: z.string().url(), expect: z.string().max(100).optional() }),
        execute: async ({ url, expect }) => {
          if (ctx.budget.remaining < 2) return { error: "fetch budget exhausted this tick" };
          return checkUrl(ctx.fetch, url, expect ?? null);
        }
      }),
      set_targets: tool({
        description: "Replace the full watched target list (use for manager queue items like 'add target X'). Include existing targets you want to keep.",
        inputSchema: z.object({ targets: z.array(z.object({ url: z.string().url(), expect: z.string().max(100).nullable().optional() })).min(1).max(30) }),
        execute: async ({ targets }) => ({ targets: this.setTargets(targets, "agent") })
      })
    };
  }

  protected defaultWake(_obs: Observation, ctx: TickCtx): number {
    const down = Number(ctx.scratch.downCount ?? 0);
    const recovered = Number(ctx.scratch.recovered ?? 0);
    const streak = Number(ctx.scratch.streak ?? 0);
    if (down > 0) return 300;
    if (recovered > 0) return 900;
    return streak >= 6 ? 3600 : 1800;
  }
}
