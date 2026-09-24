import { DurableObject } from "cloudflare:workers";
import type { BoardStatus, DeliverableRow, Env, EventRow, GoalRow, LiveStatus, ProgressRow, ProgressSnapshot, ReviewRow, Role, SpendSummary, TaskRow, TaskStatus, WorkerRow } from "./types";
import { json, readJson, secondsToUtcMidnight, utcDayStart } from "./util";

/** OpenCode Go usage windows in USD (the workers' model provider). */
const GO_CAPS = { fiveHour: 12, week: 30, month: 60 };
const DEFAULT_PACE_USD_PER_DAY = 1.6; // 80 % of Go's $60/month
const DEFAULT_TASK_COST_USD = 0.1;
const FILES_MAX_BYTES = 800_000;
const FILES_MAX_COUNT = 200;
const MEMORY_MAX_BYTES = 16_000;
const STATUS_CACHE_MS = 60_000;
/** Cloudflare free-tier daily Durable Object limits; the board degrades gracefully before hitting them. */
const CF_ROWS_READ_LIMIT = 5_000_000;
const CF_ROWS_WRITTEN_LIMIT = 100_000;
const CF_READ_SOFT_LIMIT = 4_500_000;
const METER_FLUSH_MS = 60_000;
/** Live progress snapshots: one small row per task, overwritten on every post (a worker posts at most every 30 s); no index, so a post writes one row. */
const PROGRESS_MAX_EVENTS = 30;
const PROGRESS_MAX_BYTES = 12_000;
const PROGRESS_KEEP_MS = 3 * 86_400_000;
const TERMINAL: TaskStatus[] = ["accepted", "rejected", "cancelled"];

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || d);
const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");
const leaseMs = (t: Pick<TaskRow, "max_minutes">) => Math.max(45, t.max_minutes + 15) * 60_000;

/**
 * The task board: goals → tasks → deliverables → reviews. One instance ("main").
 * The Worker authenticates and forwards requests here with an `x-board-role` header.
 * Every query is bounded (indexes + LIMIT); nothing prunes per request (free-tier row budget).
 */
export class Board extends DurableObject<Env> {
  private statusCache: { at: number; body: string } | null = null;
  /** Row-read/write meter (Cloudflare free-tier budget). Pending deltas are flushed to kv about once a minute. */
  private meterPending = { reads: 0, writes: 0 };
  private meterStored: { day: string; reads: number; writes: number; at: number } | null = null;
  /** Set by requests that arrive every few seconds (progress posts): the meter may then flush once a minute instead of per request. */
  private meterLazy = false;
  private meterFlushedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  // ---- sql helpers ----
  private q<T>(sql: string, ...params: (string | number | null)[]): T[] {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const rows = cursor.toArray() as unknown as T[];
    this.meterPending.reads += cursor.rowsRead;
    this.meterPending.writes += cursor.rowsWritten;
    return rows;
  }
  private one<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.q<T>(sql, ...params)[0];
  }
  /** Execute a write and return rowsWritten. Note: the count includes index rows, so test it with `> 0`, never `=== 1`. */
  private run(sql: string, ...params: (string | number | null)[]): number {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    cursor.toArray();
    this.meterPending.reads += cursor.rowsRead;
    this.meterPending.writes += cursor.rowsWritten;
    return cursor.rowsWritten;
  }
  private today(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
  }
  /** Today's row usage: the flushed total plus what this isolate has done since. */
  private meterToday(now = Date.now()) {
    const day = this.today(now);
    if (!this.meterStored || this.meterStored.day !== day || now - this.meterStored.at > METER_FLUSH_MS) {
      const stored = this.kvJson<{ reads: number; writes: number }>(`meter:${day}`) ?? { reads: 0, writes: 0 };
      this.meterStored = { day, reads: stored.reads, writes: stored.writes, at: now };
    }
    return { day, reads: this.meterStored.reads + this.meterPending.reads, writes: this.meterStored.writes + this.meterPending.writes };
  }
  /**
   * Flush after every request that touched rows: the DO can be evicted within seconds, so buffering would undercount.
   * Exception: progress posts arrive every 20–30 s per worker and keep the object alive, so they flush at most once a minute
   * (one kv write instead of one per post; a rare eviction loses a few counts of the meter, nothing else).
   */
  private flushMeter(now = Date.now()) {
    if (this.meterPending.reads + this.meterPending.writes === 0) return;
    if (this.meterLazy && now - this.meterFlushedAt < METER_FLUSH_MS) {
      this.meterLazy = false;
      return;
    }
    this.meterLazy = false;
    const m = this.meterToday(now);
    this.kvSet(`meter:${m.day}`, JSON.stringify({ reads: m.reads + 1, writes: m.writes + 1 }));
    this.meterStored = { day: m.day, reads: m.reads, writes: m.writes, at: now };
    this.meterPending = { reads: 0, writes: 0 };
    this.meterFlushedAt = now;
  }
  /** Spend is kept as running totals per UTC day and month so pacing never sums the spend table. */
  private addSpend(now: number, taskId: number, attempt: number, usd: number, tokens: number) {
    this.run("INSERT INTO spend(ts, task_id, attempt, usd, tokens) VALUES (?, ?, ?, ?, ?)", now, taskId, attempt, usd, tokens);
    for (const key of [`spend:day:${this.today(now)}`, `spend:month:${this.today(now).slice(0, 7)}`]) {
      const cur = this.kvJson<{ usd: number; tokens: number; tasks: number }>(key) ?? { usd: 0, tokens: 0, tasks: 0 };
      this.kvSet(key, JSON.stringify({ usd: cur.usd + usd, tokens: cur.tokens + tokens, tasks: cur.tasks + 1 }));
    }
  }
  private kvGet(key: string): string | null {
    return this.one<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value ?? null;
  }
  private kvSet(key: string, value: string | null) {
    if (value === null) this.run("DELETE FROM kv WHERE key = ?", key);
    else this.run("INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, Date.now());
  }
  private kvJson<T>(key: string): T | null {
    const v = this.kvGet(key);
    if (!v) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  private touch() {
    this.statusCache = null;
  }
  private event(actor: string, kind: string, taskId: number | null, text: string) {
    this.run("INSERT INTO events(ts, actor, kind, task_id, text) VALUES (?, ?, ?, ?, ?)", Date.now(), actor, kind, taskId, text.slice(0, 500));
  }

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', done_when TEXT, min_ready INTEGER NOT NULL DEFAULT 4,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        spec TEXT NOT NULL, acceptance TEXT NOT NULL, deps TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'ts', status TEXT NOT NULL DEFAULT 'ready',
        priority INTEGER NOT NULL DEFAULT 5, attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, max_minutes INTEGER NOT NULL DEFAULT 30,
        worker_id TEXT, lease_until INTEGER, claimed_at INTEGER, submitted_at INTEGER, finished_at INTEGER,
        cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0, last_error TEXT, review_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_status_prio ON tasks(status, priority, id);
      CREATE INDEX IF NOT EXISTS tasks_status_updated ON tasks(status, updated_at);
      CREATE INDEX IF NOT EXISTS tasks_goal_status ON tasks(goal_id, status);
      CREATE TABLE IF NOT EXISTS deliverables (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, report TEXT NOT NULL,
        files TEXT NOT NULL, bytes INTEGER NOT NULL, nfiles INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
        session_id TEXT, worker_id TEXT, created_at INTEGER NOT NULL, UNIQUE(task_id, attempt));
      CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, verdict TEXT NOT NULL,
        notes TEXT, who TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reviews_task ON reviews(task_id, id);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, task_id INTEGER, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, host TEXT, version TEXT, task_id INTEGER, last_seen INTEGER NOT NULL, note TEXT,
        tasks_done INTEGER NOT NULL DEFAULT 0, tasks_failed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, task_id INTEGER, attempt INTEGER, usd REAL NOT NULL, tokens INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS spend_ts ON spend(ts);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (task_id INTEGER PRIMARY KEY, attempt INTEGER NOT NULL, worker_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      DROP INDEX IF EXISTS progress_updated;
    `);
    // additive migrations (SQLite has no ADD COLUMN IF NOT EXISTS)
    try {
      this.ctx.storage.sql.exec("ALTER TABLE deliverables ADD COLUMN session_url TEXT");
    } catch {}
    try {
      this.ctx.storage.sql.exec("ALTER TABLE goals ADD COLUMN catalog_size INTEGER");
    } catch {}
  }

  // ---- entry ----
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = (request.headers.get("x-board-role") ?? "public") as Role;
    const p = url.pathname.split("/").filter(Boolean);
    const m = request.method;
    try {
      // public
      if (m === "GET" && p[0] === "api" && p[1] === "status") return this.status();
      if (m === "GET" && p[0] === "api" && p[1] === "live") return this.live(Date.now());
      if (m === "GET" && p[0] === "api" && p[1] === "tasks" && !p[2]) return json(this.listTasks(url));
      if (m === "GET" && p[0] === "api" && p[1] === "tasks" && p[2] && p[3] === "progress") return this.progressDetail(Number(p[2]));
      if (m === "GET" && p[0] === "api" && p[1] === "tasks" && p[2]) return this.taskDetail(Number(p[2]));

      if (p[0] === "manager") {
        if (role !== "manager") return json({ error: "forbidden" }, 403);
        return await this.manager(request, url, p.slice(1));
      }
      if (p[0] === "worker") {
        if (role !== "worker") return json({ error: "forbidden" }, 403);
        return await this.worker(request, url, p.slice(1));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("board error", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    } finally {
      try {
        this.flushMeter();
      } catch {}
    }
  }

  // ---- public ----
  private status(): Response {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.at < STATUS_CACHE_MS) return new Response(this.statusCache.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    this.sweepLeases(now);
    const goals = this.q<GoalRow>("SELECT * FROM goals ORDER BY id");
    const countRows = this.q<{ goal_id: string; status: string; n: number }>("SELECT goal_id, status, COUNT(*) AS n FROM tasks GROUP BY goal_id, status");
    const counts: Record<string, number> = {};
    const perGoal: Record<string, Record<string, number>> = {};
    for (const r of countRows) {
      counts[r.status] = (counts[r.status] ?? 0) + r.n;
      (perGoal[r.goal_id] ??= {})[r.status] = r.n;
    }
    const workers = this.q<WorkerRow & { task_key: string | null }>("SELECT w.*, t.key AS task_key FROM workers w LEFT JOIN tasks t ON t.id = w.task_id ORDER BY w.id");
    const ready = this.q<BoardStatus["ready"][number]>("SELECT id, key, title, goal_id, priority, created_at, deps FROM tasks WHERE status = 'ready' ORDER BY priority, id LIMIT 20");
    const running = this.q<BoardStatus["running"][number]>("SELECT id, key, title, worker_id, claimed_at, lease_until, attempt, status, max_minutes, goal_id FROM tasks WHERE status IN ('claimed','running') ORDER BY claimed_at LIMIT 10");
    const reviewQueue = this.q<BoardStatus["reviewQueue"][number]>("SELECT id, key, title, submitted_at, attempt, goal_id FROM tasks WHERE status = 'review' ORDER BY submitted_at LIMIT 20");
    const recentAccepted = this.q<BoardStatus["recentAccepted"][number]>("SELECT id, key, title, finished_at, cost_usd, attempt, goal_id FROM tasks WHERE status = 'accepted' ORDER BY updated_at DESC LIMIT 12");
    const blocked = this.q<BoardStatus["blocked"][number]>("SELECT id, key, title, last_error, attempt, goal_id FROM tasks WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 10");
    const acceptedToday = Number(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'accepted' AND updated_at >= ?", utcDayStart(now))?.n ?? 0);
    const events = this.q<EventRow>("SELECT * FROM events ORDER BY id DESC LIMIT 60");
    const progress: Record<string, ProgressSnapshot> = {};
    for (const r of running) {
      const snap = this.progressFor(r.id);
      if (snap) progress[String(r.id)] = snap;
    }
    const lock = Number(this.kvGet("manager:lock_until") ?? 0);
    const body: BoardStatus = {
      generatedAt: now,
      goals: goals.map((g) => ({ ...g, counts: perGoal[g.id] ?? {} })),
      counts,
      workers,
      ready,
      running,
      reviewQueue,
      recentAccepted,
      blocked,
      acceptedToday,
      spend: this.spendSummary(now),
      needsHuman: this.kvJson<{ ts: number; text: string }[]>("needs_human") ?? [],
      events,
      progress,
      manager: { lastRunAt: this.kvGet("manager:last_run_at") ? Number(this.kvGet("manager:last_run_at")) : null, lockedUntil: lock > now ? lock : null },
      cloudflare: { ...this.meterToday(now), readLimit: CF_ROWS_READ_LIMIT, writeLimit: CF_ROWS_WRITTEN_LIMIT }
    };
    const text = JSON.stringify(body, null, 2);
    this.statusCache = { at: now, body: text };
    return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }

  private listTasks(url: URL) {
    const status = url.searchParams.get("status");
    const goal = url.searchParams.get("goal");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const cols = "id, goal_id, key, title, kind, status, priority, attempt, max_attempts, max_minutes, worker_id, lease_until, submitted_at, finished_at, cost_usd, steps, last_error, updated_at";
    if (status && goal) return this.q<Partial<TaskRow>>(`SELECT ${cols} FROM tasks WHERE status = ? AND goal_id = ? ORDER BY priority, id LIMIT ?`, status, goal, limit);
    if (status) return this.q<Partial<TaskRow>>(`SELECT ${cols} FROM tasks WHERE status = ? ORDER BY priority, id LIMIT ?`, status, limit);
    if (goal) return this.q<Partial<TaskRow>>(`SELECT ${cols} FROM tasks WHERE goal_id = ? ORDER BY id DESC LIMIT ?`, goal, limit);
    return this.q<Partial<TaskRow>>(`SELECT ${cols} FROM tasks ORDER BY id DESC LIMIT ?`, limit);
  }

  private taskDetail(id: number): Response {
    const task = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!task) return json({ error: "not found" }, 404);
    const reviews = this.q<ReviewRow>("SELECT * FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 20", id);
    const d = this.one<DeliverableRow>("SELECT * FROM deliverables WHERE task_id = ? ORDER BY attempt DESC LIMIT 1", id);
    const deliverable = d ? { ...d, files: JSON.parse(d.files) as Record<string, string> } : null;
    return json({ task: { ...task, deps: JSON.parse(task.deps) as number[] }, reviews, deliverable, progress: this.progressFor(id) });
  }

  /** The last progress snapshot a worker posted for this task (one primary-key read), or null. */
  private progressFor(taskId: number): ProgressSnapshot | null {
    const r = this.one<ProgressRow>("SELECT * FROM progress WHERE task_id = ?", taskId);
    if (!r) return null;
    try {
      return { ...(JSON.parse(r.body) as Omit<ProgressSnapshot, "updated_at">), updated_at: r.updated_at };
    } catch {
      return null;
    }
  }

  /** GET /api/tasks/:id/progress — the task's state plus its live snapshot; what the task page polls while the task runs. */
  private progressDetail(id: number): Response {
    const task = this.one<Pick<TaskRow, "id" | "key" | "status" | "worker_id" | "attempt" | "claimed_at" | "lease_until">>("SELECT id, key, status, worker_id, attempt, claimed_at, lease_until FROM tasks WHERE id = ?", id);
    if (!task) return json({ error: "not found" }, 404);
    return json({ generatedAt: Date.now(), task, progress: this.progressFor(id) });
  }

  /** GET /api/live — workers, tasks in progress and their snapshots. Uncached (a few row reads); the Workers view polls it. */
  private live(now: number): Response {
    const workers = this.q<WorkerRow & { task_key: string | null }>("SELECT w.*, t.key AS task_key FROM workers w LEFT JOIN tasks t ON t.id = w.task_id ORDER BY w.id");
    const running = this.q<LiveStatus["running"][number]>("SELECT id, key, title, worker_id, claimed_at, lease_until, attempt, status, max_minutes, goal_id FROM tasks WHERE status IN ('claimed','running') ORDER BY claimed_at LIMIT 10");
    const progress: Record<string, ProgressSnapshot> = {};
    for (const r of running) {
      const snap = this.progressFor(r.id);
      if (snap) progress[String(r.id)] = snap;
    }
    const body: LiveStatus = { generatedAt: now, workers, running, progress };
    return json(body);
  }

  // ---- spend / pace ----
  private spendSummary(now: number): SpendSummary {
    const dayTotals = (ts: number) => this.kvJson<{ usd: number; tokens: number; tasks: number }>(`spend:day:${this.today(ts)}`) ?? { usd: 0, tokens: 0, tasks: 0 };
    const today = dayTotals(now);
    const todayUsd = today.usd;
    const todayTasks = today.tasks;
    let weekUsd = 0;
    const days: SpendSummary["days"] = [];
    for (let d = 0; d < 7; d++) {
      const ts = now - d * 86_400_000;
      const t = dayTotals(ts);
      weekUsd += t.usd;
      days.push({ day: this.today(ts), usd: t.usd, tasks: t.tasks });
    }
    const monthUsd = (this.kvJson<{ usd: number }>(`spend:month:${this.today(now).slice(0, 7)}`) ?? { usd: 0 }).usd;
    const fiveHourUsd = Number(this.one<{ s: number }>("SELECT COALESCE(SUM(usd), 0) AS s FROM spend WHERE ts >= ?", now - 5 * 3600_000)?.s ?? 0);
    const pace = Number(this.kvGet("pace_usd_per_day") ?? DEFAULT_PACE_USD_PER_DAY);
    const inflight = Number(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('claimed','running')")?.n ?? 0);
    const avg = Number(this.one<{ a: number | null }>("SELECT AVG(usd) AS a FROM (SELECT usd FROM spend ORDER BY id DESC LIMIT 10)")?.a ?? 0) || DEFAULT_TASK_COST_USD;
    const inflightEstimateUsd = inflight * avg;
    let pacing: SpendSummary["pacing"] = null;
    if (fiveHourUsd >= 0.9 * GO_CAPS.fiveHour) pacing = { reason: `Go 5-hour window at 90% ($${fiveHourUsd.toFixed(2)} of $${GO_CAPS.fiveHour})`, retryAfterS: 900 };
    else if (weekUsd >= 0.9 * GO_CAPS.week) pacing = { reason: `Go weekly window at 90% ($${weekUsd.toFixed(2)} of $${GO_CAPS.week})`, retryAfterS: 3600 };
    else if (monthUsd >= 0.9 * GO_CAPS.month) pacing = { reason: `Go monthly window at 90% ($${monthUsd.toFixed(2)} of $${GO_CAPS.month})`, retryAfterS: 3600 };
    else if (todayUsd + inflightEstimateUsd >= pace) pacing = { reason: `daily pace $${pace.toFixed(2)} reached ($${todayUsd.toFixed(2)} spent + $${inflightEstimateUsd.toFixed(2)} in flight); resumes 00:00 UTC`, retryAfterS: Math.min(900, secondsToUtcMidnight(now)) };
    return { todayUsd, fiveHourUsd, weekUsd, monthUsd, todayTasks, paceUsdPerDay: pace, inflightEstimateUsd, pacing, days };
  }

  /** Return expired claimed/running tasks to `ready` (lazy; called from claim and status). */
  private sweepLeases(now: number) {
    const expired = this.q<{ id: number; key: string; worker_id: string | null }>("SELECT id, key, worker_id FROM tasks WHERE status IN ('claimed','running') AND lease_until < ? LIMIT 20", now);
    for (const t of expired) {
      this.run("UPDATE tasks SET status = 'ready', worker_id = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status IN ('claimed','running')", `lease expired (worker ${t.worker_id ?? "?"})`, now, t.id);
      if (t.worker_id) this.run("UPDATE workers SET task_id = NULL WHERE id = ? AND task_id = ?", t.worker_id, t.id);
      this.event("board", "lease.expired", t.id, `${t.key}: lease expired, back to ready`);
      this.touch();
    }
  }

  private needsHumanAdd(text: string) {
    const list = this.kvJson<{ ts: number; text: string }[]>("needs_human") ?? [];
    list.push({ ts: Date.now(), text: text.slice(0, 300) });
    this.kvSet("needs_human", JSON.stringify(list.slice(-20)));
  }

  /** Full JSON dump for daily backups (called once a day from the VM). */
  private exportAll(): Response {
    const now = Date.now();
    return json({
      exportedAt: now,
      goals: this.q<GoalRow>("SELECT * FROM goals ORDER BY id"),
      tasks: this.q<TaskRow>("SELECT * FROM tasks ORDER BY id LIMIT 5000"),
      deliverables: this.q<DeliverableRow>("SELECT * FROM deliverables ORDER BY id LIMIT 2000").map((d) => ({ ...d, files: JSON.parse(d.files) })),
      reviews: this.q<ReviewRow>("SELECT * FROM reviews ORDER BY id LIMIT 5000"),
      events: this.q<EventRow>("SELECT * FROM events ORDER BY id DESC LIMIT 1000"),
      workers: this.q<WorkerRow>("SELECT * FROM workers"),
      spend: this.q<{ ts: number; task_id: number; attempt: number; usd: number; tokens: number }>("SELECT ts, task_id, attempt, usd, tokens FROM spend WHERE ts >= ? ORDER BY id", now - 40 * 86_400_000),
      kv: Object.fromEntries(this.q<{ key: string; value: string }>("SELECT key, value FROM kv").map((r) => [r.key, r.value]))
    });
  }

  // ---- worker API ----
  private async worker(request: Request, url: URL, p: string[]): Promise<Response> {
    const m = request.method;
    const now = Date.now();
    if (m === "GET" && p[0] === "export") return this.exportAll();
    if (m === "POST" && p[0] === "claim") return this.claim(await readJson(request), now);
    if (m === "POST" && p[0] === "heartbeat") return this.heartbeat(await readJson(request), now);
    if (p[0] === "tasks" && p[1]) {
      const id = Number(p[1]);
      const task = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
      if (!task) return json({ error: "not found" }, 404);
      if (m === "GET" && p[2] === "bundle") {
        if (task.status !== "accepted") return json({ error: "task not accepted", status: task.status }, 409);
        const d = this.one<DeliverableRow>("SELECT * FROM deliverables WHERE task_id = ? ORDER BY attempt DESC LIMIT 1", id);
        if (!d) return json({ error: "no deliverable" }, 404);
        return json({ task_id: id, key: task.key, kind: task.kind, attempt: d.attempt, report: d.report, files: JSON.parse(d.files) });
      }
      const body = await readJson<Record<string, unknown>>(request);
      const workerId = str(body.worker_id, 80);
      const holder = task.worker_id === workerId && (task.status === "claimed" || task.status === "running");
      if (!holder) return json({ error: "not the lease holder or task not in progress", status: task.status, worker_id: task.worker_id }, 409);
      if (body.attempt !== undefined && num(body.attempt) !== task.attempt) return json({ error: "attempt mismatch", attempt: task.attempt }, 409);
      if (m === "POST" && p[2] === "start") {
        this.run("UPDATE tasks SET status = 'running', lease_until = ?, updated_at = ? WHERE id = ?", now + leaseMs(task), now, id);
        this.run("UPDATE workers SET task_id = ?, last_seen = ?, note = ? WHERE id = ?", id, now, `running ${task.key}`, workerId);
        this.touch();
        return json({ ok: true, lease_until: now + leaseMs(task) });
      }
      if (m === "POST" && p[2] === "progress") return this.progress(task, workerId, body, now);
      if (m === "POST" && p[2] === "submit") return this.submit(task, workerId, body, now);
      if (m === "POST" && p[2] === "fail") return this.fail(task, workerId, body, now);
      if (m === "POST" && p[2] === "release") {
        const reason = str(body.reason, 300) || "released";
        this.run("UPDATE tasks SET status = 'ready', worker_id = NULL, lease_until = NULL, attempt = MAX(0, attempt - 1), last_error = ?, updated_at = ? WHERE id = ?", reason, now, id);
        this.run("UPDATE workers SET task_id = NULL, last_seen = ?, note = ? WHERE id = ?", now, `released ${task.key}`, workerId);
        this.event(`worker:${workerId}`, "task.release", id, `${task.key}: released (${reason})`);
        this.touch();
        return json({ ok: true });
      }
    }
    return json({ error: "not found" }, 404);
  }

  private upsertWorker(id: string, host: string | null, version: string | null, note: string | null, now: number) {
    this.run(
      "INSERT INTO workers(id, host, version, task_id, last_seen, note) VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET host = COALESCE(excluded.host, workers.host), version = COALESCE(excluded.version, workers.version), last_seen = excluded.last_seen, note = COALESCE(excluded.note, workers.note)",
      id,
      host,
      version,
      now,
      note
    );
  }

  private claim(body: Record<string, unknown>, now: number): Response {
    const workerId = str(body.worker_id, 80);
    if (!workerId) return json({ error: "worker_id required" }, 400);
    const meter = this.meterToday(now);
    if (meter.reads > CF_READ_SOFT_LIMIT) {
      const reason = `Cloudflare daily row-read budget nearly used (${meter.reads.toLocaleString()} of ${CF_ROWS_READ_LIMIT.toLocaleString()}); resumes 00:00 UTC`;
      return json({ task: null, reason, retry_after_s: secondsToUtcMidnight(now), pacing: true });
    }
    this.sweepLeases(now);
    this.upsertWorker(workerId, str(body.host, 120) || null, str(body.version, 40) || null, null, now);
    const spend = this.spendSummary(now);
    if (spend.pacing) {
      this.run("UPDATE workers SET note = ? WHERE id = ?", `pacing: ${spend.pacing.reason}`, workerId);
      return json({ task: null, reason: spend.pacing.reason, retry_after_s: spend.pacing.retryAfterS, pacing: true });
    }
    const candidates = this.q<TaskRow>("SELECT t.* FROM tasks t JOIN goals g ON g.id = t.goal_id WHERE t.status = 'ready' AND g.status = 'active' ORDER BY t.priority, t.id LIMIT 20");
    let waiting = 0;
    for (const c of candidates) {
      const deps = (JSON.parse(c.deps) as number[]).filter((d) => Number.isInteger(d));
      if (deps.length) {
        const rows = this.q<{ id: number; status: TaskStatus }>(`SELECT id, status FROM tasks WHERE id IN (${deps.map(() => "?").join(",")})`, ...deps);
        const dead = rows.find((r) => r.status === "cancelled" || r.status === "rejected" || r.status === "blocked");
        if (dead || rows.length < deps.length) {
          const why = dead ? `dependency #${dead.id} is ${dead.status}` : "a dependency does not exist";
          this.run("UPDATE tasks SET status = 'blocked', last_error = ?, updated_at = ? WHERE id = ? AND status = 'ready'", why, now, c.id);
          this.event("board", "task.blocked", c.id, `${c.key}: ${why}`);
          this.touch();
          continue;
        }
        if (rows.some((r) => r.status !== "accepted")) {
          waiting++;
          continue;
        }
      }
      const lease = leaseMs(c);
      const w = this.run("UPDATE tasks SET status = 'claimed', worker_id = ?, lease_until = ?, attempt = attempt + 1, claimed_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'ready'", workerId, now + lease, now, now, c.id);
      if (w === 0) continue;
      this.run("UPDATE workers SET task_id = ?, note = ? WHERE id = ?", c.id, `claimed ${c.key}`, workerId);
      const task = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", c.id)!;
      this.event(`worker:${workerId}`, "task.claim", c.id, `${c.key}: claimed (attempt ${task.attempt})`);
      const reviews = this.q<Pick<ReviewRow, "attempt" | "verdict" | "notes" | "created_at">>("SELECT attempt, verdict, notes, created_at FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 3", c.id);
      const depInfo = deps.map((d) => this.one<{ id: number; key: string; kind: string; attempt: number }>("SELECT id, key, kind, attempt FROM tasks WHERE id = ?", d)).filter(Boolean);
      const prev = task.attempt > 1 ? this.one<DeliverableRow>("SELECT * FROM deliverables WHERE task_id = ? AND attempt < ? ORDER BY attempt DESC LIMIT 1", c.id, task.attempt) : undefined;
      const previous = prev ? { attempt: prev.attempt, report: prev.report, files: JSON.parse(prev.files) as Record<string, string> } : null;
      this.touch();
      return json({ task: { ...task, deps }, reviews, deps: depInfo, previous, lease_until: now + lease });
    }
    const reason = candidates.length ? (waiting ? `${waiting} ready task(s) waiting on dependencies` : "no claimable task") : "no ready tasks";
    this.run("UPDATE workers SET note = ? WHERE id = ?", `idle: ${reason}`, workerId);
    return json({ task: null, reason, retry_after_s: 60, pacing: false });
  }

  private heartbeat(body: Record<string, unknown>, now: number): Response {
    const workerId = str(body.worker_id, 80);
    if (!workerId) return json({ error: "worker_id required" }, 400);
    this.upsertWorker(workerId, str(body.host, 120) || null, str(body.version, 40) || null, str(body.note, 200) || null, now);
    const taskId = body.task_id === undefined || body.task_id === null ? null : num(body.task_id);
    if (taskId !== null) {
      const task = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
      if (!task || task.worker_id !== workerId || (task.status !== "claimed" && task.status !== "running")) return json({ error: "lease lost", status: task?.status ?? "missing" }, 409);
      const until = now + leaseMs(task);
      this.run("UPDATE tasks SET lease_until = ?, updated_at = ? WHERE id = ?", until, now, taskId);
      this.run("UPDATE workers SET task_id = ? WHERE id = ?", taskId, workerId);
      return json({ ok: true, lease_until: until });
    }
    return json({ ok: true });
  }

  /**
   * POST /worker/tasks/:id/progress — the worker's live snapshot of the running session (step, tool, tokens, cost, last ~30 events).
   * One row per task, overwritten; no event, no status-cache invalidation (the page's live view polls /api/live instead).
   */
  private progress(task: TaskRow, workerId: string, body: Record<string, unknown>, now: number): Response {
    const kinds = ["step", "tool", "text", "error"];
    const events = (Array.isArray(body.events) ? (body.events as unknown[]).slice(-PROGRESS_MAX_EVENTS) : []).map((e) => {
      const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = { t: Math.max(0, Math.round(num(o.t))), k: kinds.includes(String(o.k)) ? String(o.k) : "text", n: Math.max(0, Math.round(num(o.n))) };
      if (typeof o.tool === "string") out.tool = o.tool.slice(0, 40);
      if (typeof o.title === "string") out.title = o.title.slice(0, 120);
      if (typeof o.status === "string") out.status = o.status.slice(0, 20);
      if (typeof o.text === "string") out.text = o.text.slice(0, 200);
      return out;
    });
    const phase = ["running", "done", "failed"].includes(String(body.phase)) ? String(body.phase) : "running";
    const count = (v: unknown) => Math.max(0, Math.round(num(v)));
    const snap = {
      worker_id: workerId,
      attempt: task.attempt,
      phase,
      step: count(body.step),
      tools: count(body.tools),
      elapsed_s: count(body.elapsed_s),
      tokens_in: count(body.tokens_in),
      tokens_out: count(body.tokens_out),
      tokens_cached: count(body.tokens_cached),
      cost_usd: Math.max(0, num(body.cost_usd)),
      last_tool: str(body.last_tool, 40) || null,
      last_text: str(body.last_text, 200) || null,
      session_id: str(body.session_id, 80) || null,
      session_url: /^https:\/\//.test(str(body.session_url, 300)) ? str(body.session_url, 300) : null,
      events
    };
    let text = JSON.stringify(snap);
    while (text.length > PROGRESS_MAX_BYTES && snap.events.length) {
      snap.events.shift();
      text = JSON.stringify(snap);
    }
    this.meterLazy = true;
    this.run(
      "INSERT INTO progress(task_id, attempt, worker_id, done, updated_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET attempt = excluded.attempt, worker_id = excluded.worker_id, done = excluded.done, updated_at = excluded.updated_at, body = excluded.body",
      task.id,
      task.attempt,
      workerId,
      phase === "running" ? 0 : 1,
      now,
      text
    );
    return json({ ok: true, bytes: text.length });
  }

  private submit(task: TaskRow, workerId: string, body: Record<string, unknown>, now: number): Response {
    const files = (body.files && typeof body.files === "object" ? body.files : {}) as Record<string, unknown>;
    const entries = Object.entries(files).filter(([k, v]) => typeof k === "string" && typeof v === "string").slice(0, FILES_MAX_COUNT) as [string, string][];
    const filesJson = JSON.stringify(Object.fromEntries(entries));
    if (filesJson.length > FILES_MAX_BYTES) return json({ error: `files too large (${filesJson.length} bytes > ${FILES_MAX_BYTES})` }, 413);
    const report = str(body.report, 60_000) || "(no report)";
    const steps = num(body.steps);
    const cost = Math.max(0, num(body.cost_usd));
    const tin = num(body.tokens_in);
    const tout = num(body.tokens_out);
    const tcached = num(body.tokens_cached);
    this.run(
      "INSERT INTO deliverables(task_id, attempt, report, files, bytes, nfiles, truncated, steps, session_id, session_url, worker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, attempt) DO UPDATE SET report = excluded.report, files = excluded.files, bytes = excluded.bytes, nfiles = excluded.nfiles, truncated = excluded.truncated, steps = excluded.steps, session_id = excluded.session_id, session_url = excluded.session_url, worker_id = excluded.worker_id, created_at = excluded.created_at",
      task.id,
      task.attempt,
      report,
      filesJson,
      filesJson.length,
      entries.length,
      body.truncated ? 1 : 0,
      steps,
      str(body.session_id, 80) || null,
      /^https:\/\//.test(str(body.session_url, 300)) ? str(body.session_url, 300) : null,
      workerId,
      now
    );
    this.run(
      "UPDATE tasks SET status = 'review', submitted_at = ?, lease_until = NULL, cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, tokens_cached = tokens_cached + ?, steps = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      now,
      cost,
      tin,
      tout,
      tcached,
      steps,
      now,
      task.id
    );
    if (cost > 0 || tin + tout > 0) this.addSpend(now, task.id, task.attempt, cost, tin + tout);
    this.run("UPDATE workers SET task_id = NULL, last_seen = ?, note = ?, tasks_done = tasks_done + 1 WHERE id = ?", now, `submitted ${task.key}`, workerId);
    this.event(`worker:${workerId}`, "task.submit", task.id, `${task.key}: submitted for review (${entries.length} files, ${steps} steps, $${cost.toFixed(3)})`);
    this.touch();
    return json({ ok: true, status: "review", attempt: task.attempt });
  }

  private fail(task: TaskRow, workerId: string, body: Record<string, unknown>, now: number): Response {
    const error = str(body.error, 500) || "failed";
    const cost = Math.max(0, num(body.cost_usd));
    const tokens = num(body.tokens_in) + num(body.tokens_out);
    const exhausted = task.attempt >= task.max_attempts;
    const status = exhausted ? "blocked" : "ready";
    this.run("UPDATE tasks SET status = ?, worker_id = NULL, lease_until = NULL, cost_usd = cost_usd + ?, last_error = ?, updated_at = ? WHERE id = ?", status, cost, error, now, task.id);
    if (cost > 0 || tokens > 0) this.addSpend(now, task.id, task.attempt, cost, tokens);
    this.run("UPDATE workers SET task_id = NULL, last_seen = ?, note = ?, tasks_failed = tasks_failed + 1 WHERE id = ?", now, `failed ${task.key}`, workerId);
    this.event(`worker:${workerId}`, "task.fail", task.id, `${task.key}: attempt ${task.attempt} failed → ${status}: ${error.slice(0, 200)}`);
    if (exhausted) this.needsHumanAdd(`Task #${task.id} ${task.key} blocked after ${task.attempt} attempts: ${error.slice(0, 160)}`);
    this.touch();
    return json({ ok: true, status });
  }

  // ---- manager API ----
  private async manager(request: Request, url: URL, p: string[]): Promise<Response> {
    const m = request.method;
    const now = Date.now();
    if (p[0] === "goals" && m === "PUT") {
      const body = await readJson<unknown>(request);
      const list = (Array.isArray(body) ? body : (body as { goals?: unknown[] })?.goals ?? []) as Record<string, unknown>[];
      let n = 0;
      const seen: string[] = [];
      for (const g of list) {
        const id = str(g.id, 40);
        if (!id) continue;
        seen.push(id);
        this.run(
          "INSERT INTO goals(id, title, body, done_when, min_ready, catalog_size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, done_when = excluded.done_when, min_ready = excluded.min_ready, catalog_size = excluded.catalog_size, status = excluded.status, updated_at = excluded.updated_at",
          id,
          str(g.title, 200) || id,
          str(g.body, 60_000),
          str(g.done_when, 2000) || null,
          Math.max(0, Math.min(50, num(g.min_ready, 4))),
          g.catalog_size === undefined || g.catalog_size === null ? null : Math.max(0, Math.min(10_000, num(g.catalog_size))),
          ["active", "paused", "done"].includes(String(g.status)) ? String(g.status) : "active",
          now,
          now
        );
        n++;
      }
      const paused: string[] = [];
      if (seen.length) {
        for (const g of this.q<{ id: string }>(`SELECT id FROM goals WHERE status = 'active' AND id NOT IN (${seen.map(() => "?").join(",")})`, ...seen)) {
          this.run("UPDATE goals SET status = 'paused', updated_at = ? WHERE id = ?", now, g.id);
          this.event("manager", "goal.paused", null, `goal ${g.id} is no longer in GOALS.md; paused (its ready tasks stay on the board but are not handed out)`);
          paused.push(g.id);
        }
      }
      this.touch();
      return json({ upserted: n, paused });
    }
    if (p[0] === "tasks" && !p[1] && m === "GET") return json(this.listTasks(url));
    if (p[0] === "tasks" && !p[1] && m === "POST") return this.createTasks(await readJson<unknown>(request), now);
    if (p[0] === "tasks" && p[1] && m === "GET") return this.taskDetail(Number(p[1]));
    if (p[0] === "tasks" && p[1] && m === "PATCH") return this.patchTask(Number(p[1]), await readJson(request), now);
    if (p[0] === "tasks" && p[1] && p[2] === "review" && m === "POST") return this.review(Number(p[1]), await readJson(request), now);
    if (p[0] === "review-queue" && m === "GET") {
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") ?? 1)));
      const tasks = this.q<TaskRow>("SELECT * FROM tasks WHERE status = 'review' ORDER BY submitted_at LIMIT ?", limit);
      return json(
        tasks.map((t) => {
          const d = this.one<DeliverableRow>("SELECT * FROM deliverables WHERE task_id = ? AND attempt = ?", t.id, t.attempt);
          return { task: { ...t, deps: JSON.parse(t.deps) }, deliverable: d ? { ...d, files: JSON.parse(d.files) } : null, reviews: this.q<ReviewRow>("SELECT * FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 5", t.id) };
        })
      );
    }
    if (p[0] === "memory" && m === "GET") return json({ memory: this.kvJson("manager:memory"), lastRunAt: this.kvGet("manager:last_run_at") ? Number(this.kvGet("manager:last_run_at")) : null });
    if (p[0] === "memory" && m === "PUT") {
      const body = await readJson<{ memory?: unknown }>(request);
      const text = JSON.stringify(body.memory ?? body);
      if (text.length > MEMORY_MAX_BYTES) return json({ error: `memory too large (${text.length} > ${MEMORY_MAX_BYTES})` }, 413);
      this.kvSet("manager:memory", text);
      this.kvSet("manager:last_run_at", String(now));
      this.touch();
      return json({ ok: true, bytes: text.length });
    }
    if (p[0] === "pace" && m === "GET") return json({ usd_per_day: Number(this.kvGet("pace_usd_per_day") ?? DEFAULT_PACE_USD_PER_DAY), spend: this.spendSummary(now) });
    if (p[0] === "pace" && m === "PUT") {
      const body = await readJson<{ usd_per_day?: unknown }>(request);
      const v = num(body.usd_per_day);
      if (!(v >= 0.05 && v <= 10)) return json({ error: "usd_per_day must be between 0.05 and 10" }, 400);
      this.kvSet("pace_usd_per_day", String(v));
      this.event("manager", "pace.set", null, `daily pace set to $${v.toFixed(2)}`);
      this.touch();
      return json({ ok: true, usd_per_day: v });
    }
    if (p[0] === "needs-human" && m === "GET") return json(this.kvJson("needs_human") ?? []);
    if (p[0] === "needs-human" && m === "POST") {
      const body = await readJson<{ text?: unknown }>(request);
      const text = str(body.text, 300);
      if (!text) return json({ error: "text required" }, 400);
      this.needsHumanAdd(text);
      this.event("manager", "needs-human", null, text);
      this.touch();
      return json({ ok: true });
    }
    if (p[0] === "needs-human" && m === "DELETE") {
      const list = this.kvJson<{ ts: number; text: string }[]>("needs_human") ?? [];
      const idx = p[1] !== undefined ? Number(p[1]) : NaN;
      const next = Number.isInteger(idx) ? list.filter((_, i) => i !== idx) : [];
      this.kvSet("needs_human", JSON.stringify(next));
      this.touch();
      return json({ ok: true, remaining: next.length });
    }
    if (p[0] === "events" && m === "GET") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      const since = Number(url.searchParams.get("since_id") ?? 0);
      return json(this.q<EventRow>("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?", since, limit));
    }
    if (p[0] === "event" && m === "POST") {
      const body = await readJson<{ kind?: unknown; text?: unknown; task_id?: unknown; actor?: unknown }>(request);
      const text = str(body.text, 500);
      if (!text) return json({ error: "text required" }, 400);
      this.event(str(body.actor, 40) || "manager", str(body.kind, 40) || "note", body.task_id === undefined ? null : num(body.task_id), text);
      if (str(body.kind, 40) === "run") this.kvSet("manager:last_run_at", String(now));
      this.touch();
      return json({ ok: true });
    }
    if (p[0] === "wake" && m === "POST") {
      // The Worker fires the routine; the board only guards against double wakes and keeps the record.
      const body = await readJson<{ who?: unknown; reason?: unknown; configured?: unknown }>(request);
      const who = str(body.who, 40) || "human";
      const reason = str(body.reason, 200) || "no reason given";
      const lock = Number(this.kvGet("manager:lock_until") ?? 0);
      if (lock > now) return json({ error: "the manager is running right now; it will pick up your change before it finishes", locked_until: lock }, 409);
      const last = Number(this.kvGet("manager:last_wake") ?? 0);
      if (now - last < 5 * 60_000) return json({ error: `the manager was woken ${Math.round((now - last) / 1000)} s ago; wait a few minutes`, last_wake: last }, 429);
      this.kvSet("manager:last_wake", String(now));
      this.event(who, "manager.wake", null, body.configured ? `wake requested (${reason})` : `wake requested (${reason}) but no instant trigger is configured; the next scheduled run is at :13 or :43 (see manager/ROUTINE.md)`);
      this.touch();
      return json({ ok: true });
    }
    if (p[0] === "lock" && m === "POST") {
      const body = await readJson<{ ttl_s?: unknown }>(request);
      const until = Number(this.kvGet("manager:lock_until") ?? 0);
      if (until > now) return json({ error: "locked", locked_until: until }, 409);
      const ttl = Math.min(3600, Math.max(60, num(body.ttl_s, 1500)));
      this.kvSet("manager:lock_until", String(now + ttl * 1000));
      return json({ ok: true, locked_until: now + ttl * 1000 });
    }
    if (p[0] === "lock" && m === "DELETE") {
      this.kvSet("manager:lock_until", null);
      return json({ ok: true });
    }
    if (p[0] === "export" && m === "GET") return this.exportAll();
    if (p[0] === "meter" && m === "GET") return json({ ...this.meterToday(now), readLimit: CF_ROWS_READ_LIMIT, writeLimit: CF_ROWS_WRITTEN_LIMIT });
    if (p[0] === "prune" && m === "POST") {
      const events = this.run("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)");
      const spend = this.run("DELETE FROM spend WHERE ts < ?", now - 40 * 86_400_000);
      const deliverables = this.run(
        "DELETE FROM deliverables WHERE created_at < ? AND id NOT IN (SELECT d.id FROM deliverables d JOIN tasks t ON t.id = d.task_id WHERE t.status = 'accepted' AND d.attempt = t.attempt)",
        now - 14 * 86_400_000
      );
      const progress = this.run("DELETE FROM progress WHERE updated_at < ?", now - PROGRESS_KEEP_MS);
      this.touch();
      return json({ ok: true, deleted: { events, spend, deliverables, progress } });
    }
    return json({ error: "not found" }, 404);
  }

  private createTasks(body: unknown, now: number): Response {
    const list = (Array.isArray(body) ? body : (body as { tasks?: unknown[] })?.tasks ?? []) as Record<string, unknown>[];
    if (!list.length) return json({ error: "expected an array of tasks" }, 400);
    const created: { id: number; key: string }[] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const t of list.slice(0, 50)) {
      const key = str(t.key, 120).trim();
      const goalId = str(t.goal_id, 40);
      if (!key || !goalId || !str(t.title, 200) || !str(t.spec) || !str(t.acceptance)) {
        skipped.push({ key: key || "(missing key)", reason: "key, goal_id, title, spec and acceptance are required" });
        continue;
      }
      if (!this.one<{ id: string }>("SELECT id FROM goals WHERE id = ?", goalId)) {
        skipped.push({ key, reason: `unknown goal ${goalId}` });
        continue;
      }
      const depIds: number[] = [];
      let depError: string | null = null;
      for (const d of (Array.isArray(t.deps) ? t.deps : []) as unknown[]) {
        const row = typeof d === "number" ? this.one<{ id: number }>("SELECT id FROM tasks WHERE id = ?", d) : this.one<{ id: number }>("SELECT id FROM tasks WHERE key = ?", String(d));
        if (!row) {
          depError = `unknown dependency ${String(d)}`;
          break;
        }
        depIds.push(row.id);
      }
      if (depError) {
        skipped.push({ key, reason: depError });
        continue;
      }
      const kind = ["ts", "py", "check", "other"].includes(String(t.kind)) ? String(t.kind) : "ts";
      if (this.one<{ id: number }>("SELECT id FROM tasks WHERE key = ?", key)) {
        skipped.push({ key, reason: "duplicate key" });
        continue;
      }
      const w = this.run(
        "INSERT INTO tasks(goal_id, key, title, spec, acceptance, deps, kind, status, priority, attempt, max_attempts, max_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0, ?, ?, ?, ?)",
        goalId,
        key,
        str(t.title, 200),
        str(t.spec, 20_000),
        str(t.acceptance, 8_000),
        JSON.stringify(depIds),
        kind,
        Math.max(1, Math.min(9, num(t.priority, 5))),
        Math.max(1, Math.min(6, num(t.max_attempts, 3))),
        Math.max(5, Math.min(120, num(t.max_minutes, 30))),
        now,
        now
      );
      if (w > 0) created.push({ id: Number(this.one<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0), key });
      else skipped.push({ key, reason: "insert failed" });
    }
    if (created.length) this.event("manager", "tasks.create", null, `created ${created.length} task(s): ${created.map((c) => c.key).join(", ")}`.slice(0, 500));
    this.touch();
    return json({ created, skipped });
  }

  private patchTask(id: number, body: Record<string, unknown>, now: number): Response {
    const task = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!task) return json({ error: "not found" }, 404);
    const inProgress = task.status === "claimed" || task.status === "running";
    if (inProgress && !body.force) return json({ error: "task is in progress; pass force:true to edit anyway", status: task.status }, 409);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const setStr = (col: string, v: unknown, max: number) => {
      if (typeof v === "string") {
        sets.push(`${col} = ?`);
        params.push(v.slice(0, max));
      }
    };
    setStr("title", body.title, 200);
    setStr("spec", body.spec, 20_000);
    setStr("acceptance", body.acceptance, 8_000);
    if (body.priority !== undefined) {
      sets.push("priority = ?");
      params.push(Math.max(1, Math.min(9, num(body.priority, 5))));
    }
    if (body.max_minutes !== undefined) {
      sets.push("max_minutes = ?");
      params.push(Math.max(5, Math.min(120, num(body.max_minutes, 30))));
    }
    if (body.max_attempts !== undefined) {
      sets.push("max_attempts = ?");
      params.push(Math.max(1, Math.min(6, num(body.max_attempts, 3))));
    }
    if (Array.isArray(body.deps)) {
      const ids = (body.deps as unknown[]).map((d) => (typeof d === "number" ? d : this.one<{ id: number }>("SELECT id FROM tasks WHERE key = ?", String(d))?.id)).filter((x): x is number => Number.isInteger(x));
      sets.push("deps = ?");
      params.push(JSON.stringify(ids));
    }
    if (typeof body.status === "string") {
      const target = body.status as TaskStatus;
      if (!["cancelled", "ready", "blocked"].includes(target)) return json({ error: "status may be cancelled, ready or blocked" }, 400);
      if (task.status === "accepted") return json({ error: "accepted tasks are final" }, 409);
      sets.push("status = ?", "worker_id = NULL", "lease_until = NULL");
      params.push(target);
      const newMax = body.max_attempts !== undefined ? Math.max(1, Math.min(6, num(body.max_attempts, 3))) : task.max_attempts;
      if (target === "ready" && task.attempt >= newMax) {
        sets.push("max_attempts = ?");
        params.push(task.attempt + 1);
      }
      if (target === "cancelled") {
        sets.push("finished_at = ?");
        params.push(now);
      }
    }
    if (!sets.length) return json({ error: "nothing to change" }, 400);
    sets.push("updated_at = ?");
    params.push(now, id);
    this.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params);
    this.event("manager", "task.patch", id, `${task.key}: ${Object.keys(body).filter((k) => k !== "force").join(", ")}`);
    this.touch();
    return json({ ok: true, task: this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id) });
  }

  private review(id: number, body: Record<string, unknown>, now: number): Response {
    const task = this.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!task) return json({ error: "not found" }, 404);
    if (task.status !== "review") return json({ error: "task is not in review", status: task.status }, 409);
    const verdict = body.verdict === "accept" ? "accept" : body.verdict === "reject" ? "reject" : null;
    if (!verdict) return json({ error: "verdict must be accept or reject" }, 400);
    const notes = str(body.notes, 4000) || null;
    const who = str(body.who, 40) || "manager";
    this.run("INSERT INTO reviews(task_id, attempt, verdict, notes, who, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, task.attempt, verdict, notes, who, now);
    if (verdict === "accept") {
      this.run("UPDATE tasks SET status = 'accepted', finished_at = ?, review_notes = ?, worker_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ?", now, notes, now, id);
      this.event(who, "task.accept", id, `${task.key}: accepted${notes ? ` — ${notes.slice(0, 160)}` : ""}`);
      this.touch();
      return json({ ok: true, status: "accepted" });
    }
    const exhausted = Boolean(body.final) || task.attempt >= task.max_attempts;
    const status = exhausted ? "blocked" : "ready";
    this.run("UPDATE tasks SET status = ?, review_notes = ?, worker_id = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?", status, notes, exhausted ? "rejected: attempts exhausted" : null, now, id);
    this.event(who, "task.reject", id, `${task.key}: rejected (attempt ${task.attempt}) → ${status}${notes ? ` — ${notes.slice(0, 160)}` : ""}`);
    if (exhausted) this.needsHumanAdd(`Task #${id} ${task.key} blocked after ${task.attempt} rejected attempt(s): ${(notes ?? "").slice(0, 140)}`);
    this.touch();
    return json({ ok: true, status });
  }
}

export const isTerminal = (s: TaskStatus) => TERMINAL.includes(s);
