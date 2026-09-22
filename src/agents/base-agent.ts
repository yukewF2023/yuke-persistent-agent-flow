import { Agent } from "agents";
import { generateText, hasToolCall, isStepCount, type ToolSet } from "ai";
import { classifyLlmError, makeModel } from "../llm";
import { SubrequestBudget, type FetchCtx } from "../tools/http";
import { commonTools } from "../tools/common";
import type { AgentId, AgentStatus, Env, Note, NoteKind, QueueItem, RunRow, TickResult } from "../types";

export interface Observation {
  /** Which kind of tick this is (e.g. "check", "research", "deliver", "quiet"). */
  mode: string;
  /** Compact, JSON-serialisable summary the LLM reasons over (≤ ~4 KB). */
  data: unknown;
  /** Short hints appended to the user message (e.g. "next delivery Wed 18:00"). */
  hints: string[];
}

export interface Decision {
  summary: string;
  nextWakeSeconds: number;
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
  /** Free-form per-tick scratch for subclasses (e.g. counters). */
  scratch: Record<string, unknown>;
}

const TRANSCRIPT_MAX = 16_000;
const TICK_SCHEDULE = "tick";

/**
 * A persistent agent: durable memory in SQLite, one self-set alarm at all times,
 * a bounded LLM tool loop per tick, and never-throwing error handling.
 */
export abstract class BaseAgent extends Agent<Env> {
  abstract readonly agentId: AgentId;
  abstract readonly displayName: string;
  abstract readonly baseCharter: string;

  /** Seconds. Subclasses may tighten. */
  wakeBounds = { min: 60, max: 6 * 3600 };
  /** Total fetch + LLM step budget per tick (free plan: 50 subrequests per invocation). */
  subrequestCap = 30;

  // ---- subclass contract ----
  protected abstract observe(ctx: TickCtx): Promise<Observation>;
  protected abstract agentTools(ctx: TickCtx): ToolSet;
  protected abstract defaultWake(obs: Observation, ctx: TickCtx): number;
  /** Deterministic decision when the LLM is unavailable (budget / backoff / error). */
  protected fallbackDecide(_obs: Observation, _ctx: TickCtx): void {}
  protected ensureExtraSchema(): void {}
  protected extraStatus(): Record<string, unknown> {
    return {};
  }
  /** Extra lines for the memory digest (subclass state the LLM should see every tick). */
  protected memoryDigestExtra(): string[] {
    return [];
  }
  /** Last word on the wake time (e.g. never sleep past a scheduled delivery). Runs before clamping. */
  protected adjustWake(seconds: number, _ctx: TickCtx): number {
    return seconds;
  }

  // ---- lifecycle ----
  async onStart() {
    this.ensureSchema();
    await this.ensureScheduled();
  }

  /** Schedule callback. Must never throw (a throw would trigger DO alarm retries and burn tokens). */
  async tick(payload?: { reason?: string }) {
    try {
      await this.runTick("alarm", payload?.reason ?? "scheduled");
    } catch (err) {
      console.error(`[${this.agentId}] tick crashed outside runTick`, err);
      try {
        await this.ensureScheduled(300, "crash-recovery");
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
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, trigger TEXT NOT NULL, status TEXT NOT NULL, steps INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, subrequests INTEGER DEFAULT 0, llm_ms INTEGER DEFAULT 0, wall_ms INTEGER DEFAULT 0, next_wake_s INTEGER, summary TEXT, error TEXT, transcript TEXT);
      CREATE TABLE IF NOT EXISTS seen_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, first_seen INTEGER NOT NULL, meta TEXT);
    `);
    this.ensureExtraSchema();
  }

  // ---- kv helpers ----
  kvGet(key: string): string | null {
    const row = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = ${key}`[0];
    return row?.value ?? null;
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
    return kind
      ? this.sql<Note>`SELECT * FROM notes WHERE kind = ${kind} ORDER BY id DESC LIMIT ${limit}`
      : this.sql<Note>`SELECT * FROM notes ORDER BY id DESC LIMIT ${limit}`;
  }

  // ---- queue ----
  queueAdd(task: string, priority = 5, source = "orchestrator"): QueueItem {
    const now = Date.now();
    this.sql`INSERT INTO queue(created_at, updated_at, status, priority, task, source) VALUES (${now}, ${now}, 'open', ${priority}, ${task.slice(0, 2000)}, ${source})`;
    return this.sql<QueueItem>`SELECT * FROM queue ORDER BY id DESC LIMIT 1`[0];
  }
  queueUpdate(id: number, status: QueueItem["status"], result: string | null = null): boolean {
    const before = this.sql<{ id: number }>`SELECT id FROM queue WHERE id = ${id}`[0];
    if (!before) return false;
    this.sql`UPDATE queue SET status = ${status}, result = ${result}, updated_at = ${Date.now()} WHERE id = ${id}`;
    return true;
  }
  queueDrop(id: number, reason = "dropped by orchestrator"): boolean {
    return this.queueUpdate(id, "dropped", reason);
  }
  /** Remove an item so it can be handed to another agent. Returns the item or null. */
  queueTake(id: number): QueueItem | null {
    const item = this.sql<QueueItem>`SELECT * FROM queue WHERE id = ${id}`[0];
    if (!item) return null;
    this.sql`UPDATE queue SET status = 'dropped', result = 'reassigned', updated_at = ${Date.now()} WHERE id = ${id}`;
    return item;
  }
  listQueue(status?: string, limit = 50): QueueItem[] {
    return status
      ? this.sql<QueueItem>`SELECT * FROM queue WHERE status = ${status} ORDER BY priority ASC, id ASC LIMIT ${limit}`
      : this.sql<QueueItem>`SELECT * FROM queue ORDER BY id DESC LIMIT ${limit}`;
  }

  // ---- runs ----
  listRuns(limit = 20): RunRow[] {
    limit = Math.min(Math.max(1, limit), 200);
    return this.sql<RunRow>`SELECT id, started_at, finished_at, trigger, status, steps, input_tokens, output_tokens, subrequests, llm_ms, wall_ms, next_wake_s, summary, error, NULL AS transcript FROM runs ORDER BY id DESC LIMIT ${limit}`;
  }
  getRun(id: number): RunRow | null {
    return this.sql<RunRow>`SELECT * FROM runs WHERE id = ${id}`[0] ?? null;
  }

  // ---- config / charter / memory ----
  getConfig<T = unknown>(name: string): T | null {
    return this.kvJson<T>(`config:${name}`);
  }
  setConfig(patch: Record<string, unknown>, actor = "orchestrator"): Record<string, unknown> {
    const applied: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "wakeBounds" && v && typeof v === "object") {
        const wb = v as { min?: number; max?: number };
        this.kvSet("config:wakeBounds", JSON.stringify({ min: wb.min ?? this.wakeBounds.min, max: wb.max ?? this.wakeBounds.max }));
      } else if (v === null) {
        this.kvSet(`config:${k}`, null);
      } else {
        this.kvSet(`config:${k}`, JSON.stringify(v));
      }
      applied[k] = v;
    }
    this.addNote("admin", `config updated by ${actor}: ${Object.keys(patch).join(", ")}`, null, null, { keys: Object.keys(patch) });
    return applied;
  }
  listConfig(): Record<string, unknown> {
    const rows = this.sql<{ key: string; value: string }>`SELECT key, value FROM kv WHERE key LIKE 'config:%'`;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key.slice(7)] = JSON.parse(r.value);
      } catch {
        out[r.key.slice(7)] = r.value;
      }
    }
    return out;
  }
  get effectiveWakeBounds() {
    return this.kvJson<{ min: number; max: number }>("config:wakeBounds") ?? this.wakeBounds;
  }
  getCharter(): { base: string; override: string | null; version: number; effective: string } {
    const override = this.kvGet("charter:override");
    const version = Number(this.kvGet("charter:version") ?? 0);
    return {
      base: this.baseCharter,
      override,
      version,
      effective: override ? `${this.baseCharter}\n\n## Manager override (v${version})\n${override}` : this.baseCharter
    };
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
    const rows = this.sql<{ key: string; value: string }>`SELECT key, value FROM kv WHERE key LIKE 'mem:%' ORDER BY updated_at DESC LIMIT 30`;
    return Object.fromEntries(rows.map((r) => [r.key.slice(4), r.value]));
  }

  // ---- control ----
  async pause(reason = "paused by orchestrator") {
    this.kvSet("paused", "1");
    this.addNote("admin", "paused", reason, null);
    await this.ensureScheduled();
    return this.getStatus();
  }
  async resume() {
    this.kvSet("paused", null);
    this.addNote("admin", "resumed", null, null);
    await this.ensureScheduled();
    return this.getStatus();
  }
  get paused() {
    return this.kvGet("paused") === "1";
  }
  async forceTick(reason = "manual"): Promise<TickResult> {
    return this.runTick("manual", reason);
  }
  /** Fire a tick via the scheduler without waiting for it. */
  async forceTickAsync(reason = "manual-async"): Promise<{ scheduledFor: number }> {
    const at = await this.ensureScheduled(1, reason);
    return { scheduledFor: at ?? Date.now() };
  }

  // ---- scheduling: exactly one pending "tick" schedule at all times (unless paused) ----
  async ensureScheduled(delaySeconds?: number, reason = "reschedule"): Promise<number | null> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === TICK_SCHEDULE);
    if (this.paused) {
      for (const p of pending) await this.cancelSchedule(p.id);
      this.kvSet("next_tick_at", null);
      return null;
    }
    if (delaySeconds !== undefined) {
      for (const p of pending) await this.cancelSchedule(p.id);
      const s = await this.schedule(Math.max(1, Math.round(delaySeconds)), TICK_SCHEDULE, { reason });
      const at = s.time * 1000;
      this.kvSet("next_tick_at", String(at));
      this.kvSet("tick_schedule_id", s.id);
      return at;
    }
    if (pending.length === 0) {
      const s = await this.schedule(5, TICK_SCHEDULE, { reason: "bootstrap" });
      this.kvSet("next_tick_at", String(s.time * 1000));
      this.kvSet("tick_schedule_id", s.id);
      return s.time * 1000;
    }
    pending.sort((a, b) => a.time - b.time);
    for (const p of pending.slice(1)) await this.cancelSchedule(p.id);
    this.kvSet("next_tick_at", String(pending[0].time * 1000));
    this.kvSet("tick_schedule_id", pending[0].id);
    return pending[0].time * 1000;
  }

  // ---- status ----
  async getStatus(): Promise<AgentStatus> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === TICK_SCHEDULE);
    const limit = Number(this.env.DAILY_TOKEN_BUDGET ?? 400_000);
    const lastRun = this.listRuns(1)[0];
    return {
      id: this.agentId,
      name: this.displayName,
      paused: this.paused,
      runCount: Number(this.kvGet("run_count") ?? 0),
      lastTickAt: this.kvGet("last_tick_at") ? Number(this.kvGet("last_tick_at")) : null,
      nextTickAt: pending.length ? Math.min(...pending.map((p) => p.time * 1000)) : null,
      lastSummary: this.kvGet("last_summary"),
      lastError: lastRun?.status === "error" ? lastRun.error : null,
      charterVersion: Number(this.kvGet("charter:version") ?? 0),
      budgetToday: { tokens: Number(this.kvGet(`budget:${this.today()}`) ?? 0), limit },
      queueOpen: Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM queue WHERE status = 'open'`[0]?.n ?? 0),
      pendingSchedules: pending.length,
      recentRuns: this.listRuns(8).map(({ transcript: _t, error: _e, finished_at: _f, llm_ms: _l, wall_ms: _w, ...r }) => r),
      recentNotes: this.listNotes(15),
      extra: this.extraStatus()
    };
  }

  // ---- the tick ----
  async runTick(trigger: string, reason: string): Promise<TickResult> {
    const now = Date.now();
    const lockUntil = Number(this.kvGet("lock_until") ?? 0);
    if (lockUntil > now) {
      return { runId: 0, status: "skipped", steps: 0, subrequests: 0, inputTokens: 0, outputTokens: 0, nextWakeSeconds: null, nextTickAt: null, summary: "another tick is running", error: null };
    }
    this.kvSet("lock_until", String(now + 180_000));

    if (this.paused) {
      this.kvSet("lock_until", "0");
      await this.ensureScheduled();
      return { runId: 0, status: "paused", steps: 0, subrequests: 0, inputTokens: 0, outputTokens: 0, nextWakeSeconds: null, nextTickAt: null, summary: "paused", error: null };
    }

    this.sql`INSERT INTO runs(started_at, trigger, status) VALUES (${now}, ${trigger}, 'running')`;
    const runId = Number(this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`[0]?.id ?? 0);
    const runCount = Number(this.kvGet("run_count") ?? 0) + 1;
    this.kvSet("run_count", String(runCount));
    this.kvSet("last_tick_at", String(now));

    const budget = new SubrequestBudget(this.subrequestCap);
    const ctx: TickCtx = { runId, now, trigger, reason, fetch: { budget }, budget, decision: null, scratch: {} };
    const wb = this.effectiveWakeBounds;
    const clampWake = (s: number) => Math.min(wb.max, Math.max(wb.min, Math.round(this.adjustWake(s, ctx))));

    let status: RunRow["status"] = "ok";
    let steps = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let llmMs = 0;
    let transcript: unknown = null;
    let error: string | null = null;
    let summary: string | null = null;
    let nextWake: number | null = null;

    try {
      const obs = await this.observe(ctx);
      const limit = Number(this.env.DAILY_TOKEN_BUDGET ?? 400_000);
      const spent = Number(this.kvGet(`budget:${this.today()}`) ?? 0);
      const backoffUntil = Number(this.kvGet("llm_backoff_until") ?? 0);

      if (spent >= limit || backoffUntil > now) {
        this.fallbackDecide(obs, ctx);
        status = "budget";
        summary = spent >= limit ? `daily token budget exhausted (${spent}/${limit}); deterministic fallback` : `LLM backoff until ${new Date(backoffUntil).toISOString()}; deterministic fallback`;
        nextWake = clampWake(this.defaultWake(obs, ctx));
      } else {
        try {
          const r = await this.decide(obs, ctx, runCount);
          steps = r.steps;
          inputTokens = r.inputTokens;
          outputTokens = r.outputTokens;
          llmMs = r.llmMs;
          transcript = r.transcript;
          if (ctx.decision) {
            summary = ctx.decision.summary;
            nextWake = clampWake(ctx.decision.nextWakeSeconds);
          } else {
            summary = (r.text || "model did not call finish").slice(0, 300);
            nextWake = clampWake(this.defaultWake(obs, ctx));
            error = `no finish call (finishReason=${r.finishReason})`;
          }
          this.kvSet(`budget:${this.today()}`, String(spent + inputTokens + outputTokens));
        } catch (err) {
          const le = classifyLlmError(err);
          this.fallbackDecide(obs, ctx);
          status = "error";
          error = `llm ${le.kind}${le.status ? ` ${le.status}` : ""}: ${le.message}`;
          if (le.kind === "rate_limit") this.kvSet("llm_backoff_until", String(now + 15 * 60_000));
          if (le.kind === "auth") this.addNote("error", "LLM auth failed: check OPENCODE_API_KEY", le.message, runId);
          nextWake = clampWake(Math.max(300, this.defaultWake(obs, ctx)));
          summary = "LLM call failed; deterministic fallback";
        }
      }
    } catch (err) {
      status = "error";
      error = String((err as Error)?.stack ?? err).slice(0, 1000);
      const lastWake = Number(this.kvGet("last_wake_s") ?? 600);
      nextWake = clampWake(Math.max(300, lastWake * 2));
      summary = "observe failed";
      this.addNote("error", `tick #${runCount} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`, error, runId);
    }

    const finishedAt = Date.now();
    const transcriptStr = transcript ? JSON.stringify(transcript).slice(0, TRANSCRIPT_MAX) : null;
    this.sql`UPDATE runs SET finished_at = ${finishedAt}, status = ${status}, steps = ${steps}, input_tokens = ${inputTokens}, output_tokens = ${outputTokens}, subrequests = ${budget.used + steps}, llm_ms = ${llmMs}, wall_ms = ${finishedAt - now}, next_wake_s = ${nextWake}, summary = ${summary}, error = ${error}, transcript = ${transcriptStr} WHERE id = ${runId}`;
    this.kvSet("last_summary", summary);
    this.kvSet("last_wake_s", String(nextWake ?? 600));
    this.prune();

    let nextTickAt: number | null = null;
    try {
      nextTickAt = await this.ensureScheduled(nextWake ?? 600, `after run #${runCount}`);
    } catch (err) {
      console.error(`[${this.agentId}] ensureScheduled failed`, err);
    } finally {
      this.kvSet("lock_until", "0");
    }
    console.log(`[${this.agentId}] run #${runCount} ${status} steps=${steps} sub=${budget.used} tokens=${inputTokens}/${outputTokens} next=${nextWake}s :: ${summary}`);
    return { runId, status, steps, subrequests: budget.used + steps, inputTokens, outputTokens, nextWakeSeconds: nextWake, nextTickAt, summary, error };
  }

  private prune() {
    this.sql`DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY id DESC LIMIT 2000)`;
    this.sql`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 400)`;
    this.sql`DELETE FROM queue WHERE status IN ('done','dropped') AND id NOT IN (SELECT id FROM queue ORDER BY id DESC LIMIT 300)`;
  }

  // ---- LLM decision ----
  private memoryDigest(): string {
    const notes = this.listNotes(10);
    const runs = this.listRuns(3);
    const mem = this.memories();
    const lines: string[] = [];
    lines.push("Recent notes (newest first):");
    lines.push(...(notes.length ? notes.map((n) => `- [${n.kind}] ${new Date(n.ts).toISOString().slice(0, 16)} ${n.title}`) : ["- (none yet)"]));
    lines.push("Recent runs:");
    lines.push(...(runs.length ? runs.map((r) => `- #${r.id} ${r.status} next=${r.next_wake_s ?? "?"}s :: ${r.summary ?? ""}`) : ["- (first run)"]));
    const memEntries = Object.entries(mem);
    if (memEntries.length) {
      lines.push("Remembered facts:");
      lines.push(...memEntries.map(([k, v]) => `- ${k}: ${v}`));
    }
    lines.push(...this.memoryDigestExtra());
    return lines.join("\n");
  }

  private async decide(obs: Observation, ctx: TickCtx, runCount: number) {
    const env = this.env;
    const maxSteps = Math.max(2, Math.min(20, Number(env.MAX_STEPS ?? 8)));
    const maxOutputTokens = Number(env.MAX_OUTPUT_TOKENS ?? 900);
    const wb = this.effectiveWakeBounds;
    const charter = this.getCharter().effective;
    const openQueue = this.listQueue("open", 10);

    const system = [
      `You are "${this.displayName}" (id: ${this.agentId}), a persistent agent running as a Cloudflare Durable Object. This is run #${runCount} (trigger: ${ctx.trigger}, reason: ${ctx.reason}). Now: ${new Date(ctx.now).toISOString()}.`,
      "Operating rules:",
      `- Reason over the OBSERVATION and your MEMORY. Be terse; no filler.`,
      `- You have at most ${maxSteps} tool-calling steps and a fetch budget of ${ctx.budget.remaining} more requests this tick. Tools tell you when the budget is gone.`,
      `- You MUST end by calling the \`finish\` tool with a one-line summary and next_wake_seconds between ${wb.min} and ${wb.max}. Follow the wake policy in your charter.`,
      `- Notes are public. Never put secrets, tokens, or anyone's personal data in a note. Never write "all healthy" notes; only write notes worth remembering.`,
      `- Queue items come from your manager (the orchestrator). Complete or drop them with the queue tools when done.`,
      "",
      "# Charter",
      charter,
      "",
      "# Memory",
      this.memoryDigest()
    ].join("\n");

    const user = [
      `OBSERVATION (mode=${obs.mode}):`,
      "```json",
      JSON.stringify(obs.data, null, 0).slice(0, 6000),
      "```",
      obs.hints.length ? "Hints:\n" + obs.hints.map((h) => `- ${h}`).join("\n") : "",
      openQueue.length ? "OPEN QUEUE:\n" + openQueue.map((q) => `- #${q.id} (p${q.priority}, from ${q.source}): ${q.task}`).join("\n") : "OPEN QUEUE: (empty)",
      "Decide what to do now, act with tools, then call finish."
    ]
      .filter(Boolean)
      .join("\n");

    const tools: ToolSet = { ...commonTools(this, ctx), ...this.agentTools(ctx) };
    const t0 = Date.now();
    const result = await generateText({
      model: makeModel(env, `${this.agentId}-run-${ctx.runId}`),
      system,
      prompt: user,
      tools,
      stopWhen: [isStepCount(maxSteps), hasToolCall("finish")],
      maxOutputTokens,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(120_000)
    });
    const llmMs = Date.now() - t0;
    const transcript = result.steps.map((s) => ({
      finish: s.finishReason,
      text: s.text ? s.text.slice(0, 600) : undefined,
      calls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })),
      results: s.toolResults.map((r) => ({ tool: r.toolName, output: JSON.stringify(r.output).slice(0, 500) }))
    }));
    return {
      steps: result.steps.length,
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
      llmMs,
      transcript,
      text: result.text,
      finishReason: result.finishReason
    };
  }
}
