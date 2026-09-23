import { Agent } from "agents";
import { generateText, hasToolCall, isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { classifyLlmError, makeModel } from "../llm";
import { SubrequestBudget, type FetchCtx } from "../tools/http";
import { commonTools } from "../tools/common";
import { GO_CAPS, costUsd } from "../tools/pricing";
import type { AgentId, AgentStatus, Env, Note, NoteKind, QueueItem, RunRow, TickResult, WorkItem, ActivityRow, SpendWindows } from "../types";

export interface Observation {
  mode: string;
  data: unknown;
  hints: string[];
}
export interface Decision {
  summary: string;
  reason: string;
}
export interface TickCtx {
  runId: number;
  now: number;
  trigger: string;
  reason: string;
  fetch: FetchCtx;
  budget: SubrequestBudget;
  decision: Decision | null;
  scratch: Record<string, unknown>;
  /** The work item this think step is executing. */
  item: WorkItem | null;
}

const TRANSCRIPT_MAX = 16_000;
const LOOP_SCHEDULE = "loop";
/** One loop segment: bounded by wall time and the free-plan subrequest cap, then re-armed 1 s later. */
const SEGMENT_WALL_MS = 110_000;
const SEGMENT_SUBREQUESTS = 40;
const THINK_MIN_REMAINING = 8;

interface TranscriptStep {
  finish: string;
  text?: string;
  calls: { tool: string; input: unknown }[];
  results: { tool: string; output: string }[];
}
function compactTranscript(steps: TranscriptStep[]): string {
  const size = (s: TranscriptStep[]) => JSON.stringify(s).length;
  let cur = steps.map((s) => ({ ...s, calls: s.calls.map((c) => ({ ...c })), results: s.results.map((r) => ({ ...r })) }));
  if (size(cur) <= TRANSCRIPT_MAX) return JSON.stringify(cur);
  for (const limit of [250, 120, 60]) {
    cur = cur.map((s) => ({ ...s, results: s.results.map((r) => ({ tool: r.tool, output: r.output.slice(0, limit) })), calls: s.calls.map((c) => ({ tool: c.tool, input: JSON.stringify(c.input).slice(0, limit) })), text: s.text?.slice(0, limit) }));
    if (size(cur) <= TRANSCRIPT_MAX) return JSON.stringify(cur);
  }
  while (cur.length > 1 && size(cur) > TRANSCRIPT_MAX) cur = [{ finish: "truncated", calls: [], results: [], text: `[${steps.length - cur.length + 1} earlier steps dropped]` }, ...cur.slice(2)];
  return JSON.stringify(cur);
}

/**
 * A persistent worker: a never-ending work loop over a self-maintained worklist.
 * Code items (fetch, parse, rank…) run continuously and cost nothing; think items call the model,
 * paced by a spend governor so the month tracks a dollar budget line. State lives in SQLite;
 * each segment re-arms the next one 1 s later, so the loop survives eviction and errors.
 */
export abstract class BaseAgent extends Agent<Env> {
  abstract readonly agentId: AgentId;
  abstract readonly displayName: string;
  abstract readonly baseCharter: string;
  /** Default share of the monthly Go allowance this agent may spend (USD). Overridable via config:governor. */
  abstract readonly defaultMonthlyBudgetUsd: number;

  /** Cheap check whether seedWork would add anything; subclasses override to avoid empty segments counting as work. */
  protected hasDueWork(): boolean {
    return true;
  }

  // ---- subclass contract ----
  /** Called whenever the open worklist is empty: enqueue the next round of work. Must always add ≥1 item. */
  protected abstract seedWork(ctx: TickCtx): void;
  /** Execute a code work item (no model). Return a one-line result for the activity feed. */
  protected abstract runCode(action: string, args: Record<string, unknown>, ctx: TickCtx): Promise<string>;
  /** Build the compact observation a think step reasons over. */
  protected abstract thinkContext(item: WorkItem, ctx: TickCtx): Promise<Observation>;
  protected abstract agentTools(ctx: TickCtx): ToolSet;
  protected ensureExtraSchema(): void {}
  protected extraStatus(): Record<string, unknown> {
    return {};
  }
  protected memoryDigestExtra(): string[] {
    return [];
  }
  /** Actions the model may plan for itself. Anything else (e.g. clock-driven `deliver`) is reserved for code/seedWork. */
  protected plannableActions(): string[] {
    return [];
  }
  /** What to show while no work item is due (e.g. "watching: next check in 40s"). */
  protected idleLabel(): string {
    return "waiting for the next scheduled work";
  }
  /** Seconds to wait when nothing is due. Kept ≥ 30 s so the free plan's daily row-write cap is respected. */
  protected idleSeconds(): number {
    return 30;
  }

  // ---- lifecycle ----
  async onStart() {
    this.ensureSchema();
    // First wake on the loop model: replace any legacy long-delay alarm with an immediate loop start.
    if (this.kvGet("loop_model") !== "2") {
      this.kvSet("loop_model", "2");
      this.kvSet("lock_until", "0");
      await this.ensureScheduled(2, "loop-model-migration");
      return;
    }
    await this.ensureScheduled();
  }
  /** Legacy schedule callback name from the tick model; old alarms still resolve. */
  async tick(payload?: { reason?: string }) {
    return this.loop(payload);
  }
  /** Schedule callback. Never throws. */
  async loop(payload?: { reason?: string }) {
    try {
      await this.runSegment("alarm", payload?.reason ?? "loop");
    } catch (err) {
      console.error(`[${this.agentId}] segment crashed`, err);
      try {
        await this.ensureScheduled(5, "crash-recovery");
      } catch {}
    }
  }

  // ---- schema ----
  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, run_id INTEGER, meta TEXT);
      CREATE INDEX IF NOT EXISTS notes_ts ON notes(ts DESC);
      CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 5, task TEXT NOT NULL, source TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, trigger TEXT NOT NULL, status TEXT NOT NULL, steps INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, subrequests INTEGER DEFAULT 0, llm_ms INTEGER DEFAULT 0, wall_ms INTEGER DEFAULT 0, next_wake_s INTEGER, summary TEXT, error TEXT, transcript TEXT, cost_usd REAL DEFAULT 0, work_item TEXT);
      CREATE TABLE IF NOT EXISTS seen_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, first_seen INTEGER NOT NULL, meta TEXT);
      CREATE TABLE IF NOT EXISTS work (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, action TEXT NOT NULL, args TEXT, priority INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'self', created_at INTEGER NOT NULL, started_at INTEGER, done_at INTEGER, result TEXT);
      CREATE INDEX IF NOT EXISTS work_open ON work(status, priority, id);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, work_id INTEGER, cost_usd REAL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts DESC);
      CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, usd REAL NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, run_id INTEGER);
      CREATE INDEX IF NOT EXISTS spend_ts ON spend(ts);
    `);
    // migrations for rows created before the loop model
    try {
      this.ctx.storage.sql.exec("ALTER TABLE runs ADD COLUMN cost_usd REAL DEFAULT 0");
    } catch {}
    try {
      this.ctx.storage.sql.exec("ALTER TABLE runs ADD COLUMN work_item TEXT");
    } catch {}
    this.ensureExtraSchema();
  }

  // ---- kv ----
  kvGet(key: string): string | null {
    return this.sql<{ value: string }>`SELECT value FROM kv WHERE key = ${key}`[0]?.value ?? null;
  }
  kvSet(key: string, value: string | null) {
    if (value === null) {
      this.sql`DELETE FROM kv WHERE key = ${key}`;
      return;
    }
    this.sql`INSERT INTO kv(key, value, updated_at) VALUES (${key}, ${value}, ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  }
  kvJson<T>(key: string): T | null {
    const v = this.kvGet(key);
    if (!v) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ---- notes ----
  addNote(kind: NoteKind, title: string, body: string | null, runId: number | null, meta: unknown = null): { id: number; deduped: boolean } {
    title = title.slice(0, 200);
    if (kind === "change" || kind === "error") {
      const cutoff = Date.now() - 30 * 60_000;
      const dup = this.sql<{ id: number }>`SELECT id FROM notes WHERE title = ${title} AND kind = ${kind} AND ts > ${cutoff} LIMIT 1`[0];
      if (dup) return { id: dup.id, deduped: true };
    }
    this.sql`INSERT INTO notes(ts, kind, title, body, run_id, meta) VALUES (${Date.now()}, ${kind}, ${title}, ${body ? body.slice(0, 4000) : null}, ${runId}, ${meta ? JSON.stringify(meta) : null})`;
    const id = this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0;
    return { id: Number(id), deduped: false };
  }
  listNotes(limit = 30, kind?: string): Note[] {
    limit = Math.min(Math.max(1, limit), 200);
    return kind ? this.sql<Note>`SELECT * FROM notes WHERE kind = ${kind} ORDER BY id DESC LIMIT ${limit}` : this.sql<Note>`SELECT * FROM notes ORDER BY id DESC LIMIT ${limit}`;
  }

  // ---- manager queue (tasks from the orchestrator) ----
  queueAdd(task: string, priority = 5, source = "orchestrator"): QueueItem {
    const now = Date.now();
    this.sql`INSERT INTO queue(created_at, updated_at, status, priority, task, source) VALUES (${now}, ${now}, 'open', ${priority}, ${task.slice(0, 2000)}, ${source})`;
    this.addWork("think", "manager_task", { task, priority }, Math.min(priority, 3), source);
    return this.sql<QueueItem>`SELECT * FROM queue ORDER BY id DESC LIMIT 1`[0];
  }
  queueUpdate(id: number, status: QueueItem["status"], result: string | null = null): boolean {
    if (!this.sql<{ id: number }>`SELECT id FROM queue WHERE id = ${id}`[0]) return false;
    this.sql`UPDATE queue SET status = ${status}, result = ${result}, updated_at = ${Date.now()} WHERE id = ${id}`;
    return true;
  }
  queueDrop(id: number, reason = "dropped by orchestrator"): boolean {
    return this.queueUpdate(id, "dropped", reason);
  }
  queueTake(id: number): QueueItem | null {
    const item = this.sql<QueueItem>`SELECT * FROM queue WHERE id = ${id}`[0];
    if (!item) return null;
    this.sql`UPDATE queue SET status = 'dropped', result = 'reassigned', updated_at = ${Date.now()} WHERE id = ${id}`;
    return item;
  }
  listQueue(status?: string, limit = 50): QueueItem[] {
    return status ? this.sql<QueueItem>`SELECT * FROM queue WHERE status = ${status} ORDER BY priority ASC, id ASC LIMIT ${limit}` : this.sql<QueueItem>`SELECT * FROM queue ORDER BY id DESC LIMIT ${limit}`;
  }

  // ---- worklist ----
  addWork(kind: "code" | "think", action: string, args: Record<string, unknown> | null = null, priority = 5, source = "self", dedupe = true): number {
    const argsStr = args ? JSON.stringify(args) : null;
    if (dedupe) {
      const dup = argsStr
        ? this.sql<{ id: number }>`SELECT id FROM work WHERE status IN ('open','doing') AND action = ${action} AND args = ${argsStr} LIMIT 1`[0]
        : this.sql<{ id: number }>`SELECT id FROM work WHERE status IN ('open','doing') AND action = ${action} AND args IS NULL LIMIT 1`[0];
      if (dup) return dup.id;
    }
    this.sql`INSERT INTO work(kind, action, args, priority, source, created_at) VALUES (${kind}, ${action}, ${argsStr}, ${priority}, ${source}, ${Date.now()})`;
    return Number(this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0);
  }
  listWork(status = "open", limit = 50): WorkItem[] {
    return this.sql<WorkItem>`SELECT * FROM work WHERE status = ${status} ORDER BY priority ASC, id ASC LIMIT ${limit}`;
  }
  private nextWork(kind?: "code" | "think"): WorkItem | null {
    return (kind
      ? this.sql<WorkItem>`SELECT * FROM work WHERE status = 'open' AND kind = ${kind} ORDER BY priority ASC, id ASC LIMIT 1`
      : this.sql<WorkItem>`SELECT * FROM work WHERE status = 'open' ORDER BY priority ASC, id ASC LIMIT 1`)[0] ?? null;
  }
  private finishWork(id: number, status: "done" | "failed", result: string) {
    this.sql`UPDATE work SET status = ${status}, done_at = ${Date.now()}, result = ${result.slice(0, 500)} WHERE id = ${id}`;
  }
  protected activity(kind: string, text: string, workId: number | null = null, cost = 0) {
    this.sql`INSERT INTO activity(ts, kind, text, work_id, cost_usd) VALUES (${Date.now()}, ${kind}, ${text.slice(0, 300)}, ${workId}, ${cost})`;
  }
  listActivity(limit = 30): ActivityRow[] {
    return this.sql<ActivityRow>`SELECT * FROM activity ORDER BY id DESC LIMIT ${Math.min(limit, 200)}`;
  }

  // ---- runs ----
  listRuns(limit = 20): RunRow[] {
    limit = Math.min(Math.max(1, limit), 200);
    return this.sql<RunRow>`SELECT id, started_at, finished_at, trigger, status, steps, input_tokens, output_tokens, subrequests, llm_ms, wall_ms, next_wake_s, summary, error, NULL AS transcript, cost_usd, work_item FROM runs ORDER BY id DESC LIMIT ${limit}`;
  }
  getRun(id: number): RunRow | null {
    return this.sql<RunRow>`SELECT * FROM runs WHERE id = ${id}`[0] ?? null;
  }

  // ---- config / charter / memory ----
  getConfig<T = unknown>(name: string): T | null {
    return this.kvJson<T>(`config:${name}`);
  }
  setConfig(patch: Record<string, unknown>, actor = "orchestrator"): Record<string, unknown> {
    for (const [k, v] of Object.entries(patch)) this.kvSet(`config:${k}`, v === null ? null : JSON.stringify(v));
    this.addNote("admin", `config updated by ${actor}: ${Object.keys(patch).join(", ")}`, null, null, { keys: Object.keys(patch) });
    return patch;
  }
  listConfig(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.sql<{ key: string; value: string }>`SELECT key, value FROM kv WHERE key LIKE 'config:%'`) {
      try {
        out[r.key.slice(7)] = JSON.parse(r.value);
      } catch {
        out[r.key.slice(7)] = r.value;
      }
    }
    return out;
  }
  getCharter(): { base: string; override: string | null; version: number; effective: string } {
    const override = this.kvGet("charter:override");
    const version = Number(this.kvGet("charter:version") ?? 0);
    return { base: this.baseCharter, override, version, effective: override ? `${this.baseCharter}\n\n## Manager override (v${version})\n${override}` : this.baseCharter };
  }
  setCharter(text: string | null, reason: string, actor = "orchestrator"): { version: number } {
    const version = Number(this.kvGet("charter:version") ?? 0) + 1;
    this.kvSet("charter:override", text);
    this.kvSet("charter:version", String(version));
    this.addNote("admin", `charter ${text ? "override" : "reset"} v${version} by ${actor}`, reason, null, { version });
    return { version };
  }
  remember(key: string, value: string | null) {
    this.kvSet(`mem:${key.slice(0, 64)}`, value ? value.slice(0, 500) : null);
  }
  memories(): Record<string, string> {
    return Object.fromEntries(this.sql<{ key: string; value: string }>`SELECT key, value FROM kv WHERE key LIKE 'mem:%' ORDER BY updated_at DESC LIMIT 30`.map((r) => [r.key.slice(4), r.value]));
  }

  // ---- spend governor ----
  governorConfig() {
    const c = this.getConfig<{ monthly_budget_usd?: number; burst_usd?: number }>("governor") ?? {};
    return { monthlyBudgetUsd: c.monthly_budget_usd ?? this.defaultMonthlyBudgetUsd, burstUsd: c.burst_usd ?? 0.25 };
  }
  spendWindows(now = Date.now()): SpendWindows {
    const sum = (ms: number) => Number(this.sql<{ s: number }>`SELECT COALESCE(SUM(usd),0) AS s FROM spend WHERE ts > ${now - ms}`[0]?.s ?? 0);
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    return {
      fiveHourUsd: sum(5 * 3600_000),
      weekUsd: sum(7 * 86_400_000),
      monthUsd: Number(this.sql<{ s: number }>`SELECT COALESCE(SUM(usd),0) AS s FROM spend WHERE ts >= ${monthStart}`[0]?.s ?? 0),
      todayUsd: sum(now - Date.parse(this.today() + "T00:00:00Z")),
      todayTokens: Number(this.sql<{ s: number }>`SELECT COALESCE(SUM(input_tokens + output_tokens),0) AS s FROM spend WHERE ts >= ${Date.parse(this.today() + "T00:00:00Z")}`[0]?.s ?? 0)
    };
  }
  /** Token bucket in USD: refills at the monthly budget rate, capped at burst. Returns seconds to wait (0 = go). */
  private governorWait(now: number, estimateUsd: number): number {
    const { monthlyBudgetUsd, burstUsd } = this.governorConfig();
    const ratePerSec = monthlyBudgetUsd / (30 * 86_400);
    let bucket = Number(this.kvGet("gov:bucket") ?? burstUsd);
    const last = Number(this.kvGet("gov:updated") ?? now);
    bucket = Math.min(burstUsd, bucket + ((now - last) / 1000) * ratePerSec);
    this.kvSet("gov:bucket", String(bucket));
    this.kvSet("gov:updated", String(now));
    // hard caps: never exceed 90% of Go's shared windows (both agents share them, so each stays under half)
    const w = this.spendWindows(now);
    const share = monthlyBudgetUsd / GO_CAPS.month;
    if (w.fiveHourUsd > GO_CAPS.fiveHour * share * 0.9 || w.weekUsd > GO_CAPS.week * share * 0.9 || w.monthUsd > GO_CAPS.month * share * 0.9) return 900;
    if (bucket >= estimateUsd) return 0;
    return Math.ceil((estimateUsd - bucket) / ratePerSec);
  }
  private governorCharge(usd: number) {
    const bucket = Number(this.kvGet("gov:bucket") ?? 0);
    this.kvSet("gov:bucket", String(bucket - usd));
  }
  private avgThinkCost(): number {
    const r = this.sql<{ a: number }>`SELECT AVG(usd) AS a FROM (SELECT usd FROM spend ORDER BY id DESC LIMIT 10)`[0];
    return r?.a ? Number(r.a) : 0.002;
  }

  // ---- control ----
  async pause(reason = "paused by orchestrator") {
    this.kvSet("paused", "1");
    this.addNote("admin", "paused", reason, null);
    this.activity("admin", `paused: ${reason}`);
    await this.ensureScheduled();
    return this.getStatus();
  }
  async resume() {
    this.kvSet("paused", null);
    this.addNote("admin", "resumed", null, null);
    this.activity("admin", "resumed");
    await this.ensureScheduled();
    return this.getStatus();
  }
  get paused() {
    return this.kvGet("paused") === "1";
  }
  /** Run one loop segment now (used by the admin API). */
  async forceTick(reason = "manual"): Promise<TickResult> {
    return this.runSegment("manual", reason);
  }
  async forceTickAsync(reason = "manual-async"): Promise<{ scheduledFor: number }> {
    const at = await this.ensureScheduled(1, reason);
    return { scheduledFor: at ?? Date.now() };
  }

  // ---- scheduling: exactly one pending loop alarm (unless paused) ----
  async ensureScheduled(delaySeconds?: number, reason = "loop"): Promise<number | null> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === LOOP_SCHEDULE || s.callback === "tick");
    if (this.paused) {
      for (const p of pending) await this.cancelSchedule(p.id);
      this.kvSet("next_tick_at", null);
      return null;
    }
    if (delaySeconds !== undefined) {
      for (const p of pending) await this.cancelSchedule(p.id);
      const s = await this.schedule(Math.max(1, Math.round(delaySeconds)), LOOP_SCHEDULE, { reason });
      this.kvSet("next_tick_at", String(s.time * 1000));
      return s.time * 1000;
    }
    if (pending.length === 0) {
      const s = await this.schedule(2, LOOP_SCHEDULE, { reason: "bootstrap" });
      this.kvSet("next_tick_at", String(s.time * 1000));
      return s.time * 1000;
    }
    pending.sort((a, b) => a.time - b.time);
    for (const p of pending.slice(1)) await this.cancelSchedule(p.id);
    this.kvSet("next_tick_at", String(pending[0].time * 1000));
    return pending[0].time * 1000;
  }

  // ---- status ----
  async getStatus(): Promise<AgentStatus> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === LOOP_SCHEDULE);
    const lastRun = this.listRuns(1)[0];
    const gov = this.governorConfig();
    const now = Date.now();
    const bucket = Number(this.kvGet("gov:bucket") ?? gov.burstUsd);
    const ratePerSec = gov.monthlyBudgetUsd / (30 * 86_400);
    return {
      id: this.agentId,
      name: this.displayName,
      paused: this.paused,
      runCount: Number(this.kvGet("run_count") ?? 0),
      segmentCount: Number(this.kvGet("segment_count") ?? 0),
      lastTickAt: this.kvGet("last_tick_at") ? Number(this.kvGet("last_tick_at")) : null,
      nextTickAt: pending.length ? Math.min(...pending.map((p) => p.time * 1000)) : null,
      lastSummary: this.kvGet("last_summary"),
      lastError: lastRun?.status === "error" ? lastRun.error : null,
      charterVersion: Number(this.kvGet("charter:version") ?? 0),
      budgetToday: { tokens: this.spendWindows(now).todayTokens, limit: Number(this.env.DAILY_TOKEN_BUDGET ?? 400_000) },
      queueOpen: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM queue WHERE status = 'open'`[0]?.n ?? 0),
      pendingSchedules: pending.length,
      workingNow: this.kvGet("working_now"),
      workOpen: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM work WHERE status = 'open'`[0]?.n ?? 0),
      workDoneToday: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM work WHERE status = 'done' AND done_at >= ${Date.parse(this.today() + "T00:00:00Z")}`[0]?.n ?? 0),
      thinksToday: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM spend WHERE ts >= ${Date.parse(this.today() + "T00:00:00Z")}`[0]?.n ?? 0),
      spend: this.spendWindows(now),
      governor: { monthlyBudgetUsd: gov.monthlyBudgetUsd, burstUsd: gov.burstUsd, bucketUsd: Math.max(0, Math.min(gov.burstUsd, bucket + ((now - Number(this.kvGet("gov:updated") ?? now)) / 1000) * ratePerSec)), waitUntil: this.kvGet("gov:wait_until") ? Number(this.kvGet("gov:wait_until")) : null, avgThinkUsd: this.avgThinkCost() },
      recentRuns: this.listRuns(8).map(({ transcript: _t, error: _e, finished_at: _f, llm_ms: _l, wall_ms: _w, ...r }) => r),
      recentNotes: this.listNotes(15),
      recentActivity: this.listActivity(20),
      extra: this.extraStatus()
    };
  }

  // ---- the loop segment ----
  async runSegment(trigger: string, reason: string): Promise<TickResult> {
    const now = Date.now();
    const lockUntil = Number(this.kvGet("lock_until") ?? 0);
    if (lockUntil > now) return this.emptyResult("skipped", "another segment is running");
    this.kvSet("lock_until", String(now + SEGMENT_WALL_MS + 60_000));
    if (this.paused) {
      this.kvSet("lock_until", "0");
      await this.ensureScheduled();
      return this.emptyResult("paused", "paused");
    }
    const segNo = Number(this.kvGet("segment_count") ?? 0) + 1;
    if (this.nextWork() || this.hasDueWork()) {
      this.kvSet("segment_count", String(segNo));
      this.kvSet("last_tick_at", String(now));
    }
    const budget = new SubrequestBudget(SEGMENT_SUBREQUESTS);
    const ctx: TickCtx = { runId: 0, now, trigger, reason, fetch: { budget }, budget, decision: null, scratch: {}, item: null };
    let items = 0;
    let thinks = 0;
    let costSeg = 0;
    let nextDelay = 1;
    let lastSummary: string | null = null;
    try {
      while (Date.now() - now < SEGMENT_WALL_MS && budget.remaining >= 4) {
        if (!this.nextWork()) this.seedWork(ctx);
        let item = this.nextWork();
        if (!item) {
          nextDelay = this.idleSeconds();
          break;
        }
        if (item.kind === "think") {
          const wait = this.governorWait(Date.now(), this.avgThinkCost());
          if (wait > 0 || budget.remaining < THINK_MIN_REMAINING) {
            const codeItem = this.nextWork("code");
            if (codeItem) item = codeItem;
            else {
              const delay = wait > 0 ? Math.min(600, Math.max(5, wait)) : 2;
              this.kvSet("gov:wait_until", String(Date.now() + delay * 1000));
              this.kvSet("working_now", wait > 0 ? `pacing: next think in ~${delay}s to stay within $${this.governorConfig().monthlyBudgetUsd}/month` : "segment budget used; continuing in 2s");
              nextDelay = delay;
              break;
            }
          } else this.kvSet("gov:wait_until", null);
        }
        const args = item.args ? (JSON.parse(item.args) as Record<string, unknown>) : {};
        this.sql`UPDATE work SET status = 'doing', started_at = ${Date.now()} WHERE id = ${item.id}`;
        this.kvSet("working_now", `${item.kind}: ${item.action}${args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0, 80) : ""}`);
        ctx.item = item;
        try {
          if (item.kind === "code") {
            const t0 = Date.now();
            const result = await this.runCode(item.action, args, ctx);
            this.finishWork(item.id, "done", result);
            this.activity("code", `${item.action}: ${result}`.slice(0, 300), item.id);
            items++;
            void t0;
          } else {
            const r = await this.think(item, args, ctx);
            this.finishWork(item.id, r.status === "ok" ? "done" : "failed", r.summary ?? r.error ?? "");
            thinks++;
            costSeg += r.costUsd;
            lastSummary = r.summary;
            items++;
          }
        } catch (err) {
          const msg = String((err as Error)?.message ?? err).slice(0, 300);
          this.finishWork(item.id, "failed", msg);
          this.activity("error", `${item.action} failed: ${msg}`, item.id);
          this.addNote("error", `${item.action} failed: ${msg.slice(0, 120)}`, msg, null);
        }
      }
    } finally {
      this.prune();
      if (lastSummary) this.kvSet("last_summary", lastSummary);
      if (!this.kvGet("working_now")?.startsWith("pacing")) this.kvSet("working_now", nextDelay <= 2 ? "between segments" : this.idleLabel());
      try {
        await this.ensureScheduled(nextDelay, `after segment #${segNo}`);
      } catch (err) {
        console.error(`[${this.agentId}] ensureScheduled failed`, err);
      }
      this.kvSet("lock_until", "0");
    }
    console.log(`[${this.agentId}] segment #${segNo} items=${items} thinks=${thinks} sub=${budget.used} cost=$${costSeg.toFixed(4)} next=${nextDelay}s`);
    return { runId: segNo, status: "ok", steps: items, subrequests: budget.used, inputTokens: 0, outputTokens: 0, nextWakeSeconds: nextDelay, nextTickAt: this.kvGet("next_tick_at") ? Number(this.kvGet("next_tick_at")) : null, summary: `segment #${segNo}: ${items} work items, ${thinks} think steps, $${costSeg.toFixed(4)}`, error: null, thinks, costUsd: costSeg };
  }
  private emptyResult(status: TickResult["status"], summary: string): TickResult {
    return { runId: 0, status, steps: 0, subrequests: 0, inputTokens: 0, outputTokens: 0, nextWakeSeconds: null, nextTickAt: null, summary, error: null, thinks: 0, costUsd: 0 };
  }
  private prune() {
    this.sql`DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY id DESC LIMIT 2000)`;
    this.sql`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 400)`;
    this.sql`DELETE FROM queue WHERE status IN ('done','dropped') AND id NOT IN (SELECT id FROM queue ORDER BY id DESC LIMIT 300)`;
    this.sql`DELETE FROM work WHERE status IN ('done','failed') AND id NOT IN (SELECT id FROM work ORDER BY id DESC LIMIT 500)`;
    this.sql`DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 600)`;
    this.sql`DELETE FROM spend WHERE ts < ${Date.now() - 40 * 86_400_000}`;
  }

  // ---- think step (one model call with tools) ----
  private memoryDigest(): string {
    const notes = this.listNotes(8);
    const act = this.listActivity(12);
    const mem = this.memories();
    const lines: string[] = ["Recent activity (newest first):"];
    lines.push(...(act.length ? act.map((a) => `- ${new Date(a.ts).toISOString().slice(11, 16)} [${a.kind}] ${a.text.slice(0, 140)}`) : ["- (none yet)"]));
    lines.push("Recent notes:");
    lines.push(...(notes.length ? notes.map((n) => `- [${n.kind}] ${new Date(n.ts).toISOString().slice(0, 16)} ${n.title}`) : ["- (none yet)"]));
    const memEntries = Object.entries(mem);
    if (memEntries.length) lines.push("Remembered facts:", ...memEntries.map(([k, v]) => `- ${k}: ${v}`));
    lines.push(...this.memoryDigestExtra());
    return lines.join("\n");
  }

  private async think(item: WorkItem, args: Record<string, unknown>, ctx: TickCtx): Promise<{ status: "ok" | "error"; summary: string | null; error: string | null; costUsd: number }> {
    const env = this.env;
    const now = Date.now();
    this.sql`INSERT INTO runs(started_at, trigger, status, work_item) VALUES (${now}, ${ctx.trigger}, 'running', ${`${item.action} ${item.args ?? ""}`.slice(0, 200)})`;
    const runId = Number(this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0);
    const runCount = Number(this.kvGet("run_count") ?? 0) + 1;
    this.kvSet("run_count", String(runCount));
    ctx.runId = runId;
    ctx.decision = null;
    const maxSteps = Math.max(2, Math.min(12, Number(env.MAX_STEPS ?? 6)));
    const maxOutputTokens = Number(env.MAX_OUTPUT_TOKENS ?? 1500);
    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    let summary: string | null = null;
    let steps = 0;
    let inTok = 0;
    let outTok = 0;
    let cached = 0;
    let llmMs = 0;
    let transcript: string | null = null;
    let usd = 0;
    try {
      const obs = await this.thinkContext(item, ctx);
      const openQueue = this.listQueue("open", 6);
      const openWork = this.listWork("open", 8);
      const system = [
        `You are "${this.displayName}" (id: ${this.agentId}), a persistent worker agent running continuously as a Cloudflare Durable Object. This is think step #${runCount}. Now: ${new Date(now).toISOString()}.`,
        "Operating rules:",
        `- You are executing ONE work item: "${item.action}"${item.args ? ` with args ${item.args.slice(0, 300)}` : ""}. Do it, then plan follow-up work with \`plan_work\` so the loop never runs dry, then call \`finish\`.`,
        `- Be terse. At most ${maxSteps} tool steps; fetch budget left this segment: ${ctx.budget.remaining}. Tools tell you when a budget is gone. On your last step only \`finish\` is available.`,
        "- Notes are public. Never put secrets, tokens or anyone's personal data in notes. Only write notes worth remembering; never 'all healthy' notes.",
        "- Manager tasks arrive as queue items; complete or drop them with the queue tools.",
        "",
        "# Charter",
        this.getCharter().effective,
        "",
        "# Memory",
        this.memoryDigest()
      ].join("\n");
      const user = [
        `WORK ITEM: ${item.action}${item.args ? " " + item.args : ""}`,
        `OBSERVATION (mode=${obs.mode}):`,
        "```json",
        JSON.stringify(obs.data).slice(0, 7000),
        "```",
        obs.hints.length ? "Hints:\n" + obs.hints.map((h) => `- ${h}`).join("\n") : "",
        openWork.length ? "OPEN WORKLIST (next up):\n" + openWork.map((w) => `- #${w.id} ${w.kind} ${w.action} ${w.args ?? ""}`).join("\n") : "OPEN WORKLIST: (empty — you must plan_work)",
        openQueue.length ? "MANAGER QUEUE:\n" + openQueue.map((q) => `- #${q.id} (p${q.priority}, from ${q.source}): ${q.task}`).join("\n") : "",
        "Do the work item, plan follow-ups, then finish."
      ]
        .filter(Boolean)
        .join("\n");
      const tools: ToolSet = { ...commonTools(this, ctx), ...this.workTools(ctx), ...this.agentTools(ctx) };
      const t0 = Date.now();
      const result = await generateText({
        model: makeModel(env, `${this.agentId}-run-${runId}`),
        system,
        prompt: user,
        tools,
        stopWhen: [isStepCount(maxSteps), hasToolCall("finish")],
        prepareStep: ({ stepNumber }) => (stepNumber >= maxSteps - 1 ? { activeTools: ["finish"], toolChoice: { type: "tool", toolName: "finish" } } : undefined),
        maxOutputTokens,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(90_000)
      });
      llmMs = Date.now() - t0;
      steps = result.steps.length;
      inTok = result.totalUsage.inputTokens ?? 0;
      outTok = result.totalUsage.outputTokens ?? 0;
      const details = (result.totalUsage as { inputTokenDetails?: { cacheReadInputTokens?: number; cachedInputTokens?: number } }).inputTokenDetails;
      cached = details?.cacheReadInputTokens ?? details?.cachedInputTokens ?? 0;
      usd = costUsd(inTok, outTok, cached, now);
      transcript = compactTranscript(
        result.steps.map((s) => ({
          finish: s.finishReason,
          text: s.text ? s.text.slice(0, 600) : undefined,
          calls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })),
          results: s.toolResults.map((r) => ({ tool: r.toolName, output: JSON.stringify(r.output).slice(0, 500) }))
        }))
      );
      let decision = ctx.decision as Decision | null;
      if (!decision) {
        // On the forced last step the SDK records the finish call but does not execute it; recover the decision from the call.
        for (const st of result.steps) for (const c of st.toolCalls) if (c.toolName === "finish") {
          const inp = c.input as { summary?: string; reason?: string };
          if (inp?.summary) decision = { summary: String(inp.summary), reason: String(inp.reason ?? "") };
        }
      }
      summary = decision?.summary ?? (result.text || "no finish call").slice(0, 300);
      if (!decision) error = `no finish call (finishReason=${result.finishReason})`;
    } catch (err) {
      const le = classifyLlmError(err);
      status = "error";
      error = `llm ${le.kind}${le.status ? ` ${le.status}` : ""}: ${le.message}`;
      if (le.kind === "rate_limit") this.kvSet("gov:wait_until", String(Date.now() + 15 * 60_000));
      if (le.kind === "auth") this.addNote("error", "LLM auth failed: check OPENCODE_API_KEY", le.message, runId);
      this.activity("error", error.slice(0, 200), item.id);
    }
    const finishedAt = Date.now();
    this.sql`UPDATE runs SET finished_at = ${finishedAt}, status = ${status}, steps = ${steps}, input_tokens = ${inTok}, output_tokens = ${outTok}, subrequests = ${steps}, llm_ms = ${llmMs}, wall_ms = ${finishedAt - now}, summary = ${summary}, error = ${error}, transcript = ${transcript}, cost_usd = ${usd} WHERE id = ${runId}`;
    if (usd > 0) {
      this.sql`INSERT INTO spend(ts, usd, input_tokens, output_tokens, cached_tokens, run_id) VALUES (${finishedAt}, ${usd}, ${inTok}, ${outTok}, ${cached}, ${runId})`;
      this.governorCharge(usd);
    }
    this.activity("think", `${item.action}: ${summary ?? error ?? ""}`.slice(0, 300), item.id, usd);
    return { status, summary, error, costUsd: usd };
  }

  /** Tools that manage the worklist, available to every think step. */
  private workTools(ctx: TickCtx): ToolSet {
    return {
      plan_work: tool({
        description: "Add follow-up work items so the loop keeps going. kind 'code' runs without the model (see your charter for available code actions); kind 'think' brings you back for reasoning. Lower priority number = sooner.",
        inputSchema: z.object({
          items: z.array(z.object({ kind: z.enum(["code", "think"]), action: z.string().min(2).max(60), args: z.record(z.string(), z.any()).optional(), priority: z.number().int().min(1).max(9).default(5) })).min(1).max(12)
        }),
        execute: async ({ items }) => {
          const allowed = this.plannableActions();
          const added: number[] = [];
          const rejected: string[] = [];
          for (const it of items) {
            if (allowed.length && !allowed.includes(it.action)) rejected.push(`${it.action} (not plannable; allowed: ${allowed.join(", ")})`);
            else added.push(this.addWork(it.kind, it.action, it.args ?? null, it.priority, `think#${ctx.runId}`));
          }
          return { added, rejected };
        }
      }),
      drop_work: tool({
        description: "Drop an open work item that is no longer useful.",
        inputSchema: z.object({ id: z.number().int(), reason: z.string().max(200) }),
        execute: async ({ id, reason }) => {
          this.finishWork(id, "failed", `dropped: ${reason}`);
          return { ok: true };
        }
      })
    };
  }
}
