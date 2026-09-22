import { DurableObject } from "cloudflare:workers";
import type { Env, FeedbackRow, LogRow } from "./types";

/**
 * Team-level state shared by the orchestrator and the humans:
 * the feedback mailbox, the orchestrator's memory, and an action log.
 */
export class TeamState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  private q<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...params).toArray() as unknown as T[];
  }

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS log_ts ON log(ts DESC);
      CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', applied_detail TEXT);
      CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, ts);
    `);
  }

  // ---- kv ----
  getValue(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }
  setValue(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      Date.now()
    );
  }
  getState(): { memory: Record<string, any> | null; lastRunAt: number | null } {
    const mem = this.getValue("orchestrator:memory");
    const last = this.getValue("orchestrator:last_run_at");
    return { memory: mem ? JSON.parse(mem) : null, lastRunAt: last ? Number(last) : null };
  }
  putState(memory: Record<string, any>) {
    this.setValue("orchestrator:memory", JSON.stringify(memory));
    this.setValue("orchestrator:last_run_at", String(Date.now()));
    this.addLog("orchestrator", "state.put", null, null);
  }

  // ---- log ----
  addLog(actor: string, action: string, target: string | null, detail: string | null): number {
    this.ctx.storage.sql.exec("INSERT INTO log(ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", Date.now(), actor, action, target, detail);
    this.ctx.storage.sql.exec("DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT 500)");
    return Number(this.ctx.storage.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").toArray()[0]?.id ?? 0);
  }
  listLog(limit = 50): LogRow[] {
    return this.q<LogRow>("SELECT * FROM log ORDER BY id DESC LIMIT ?", Math.min(limit, 500));
  }

  // ---- feedback mailbox ----
  addFeedback(source: string, author: string, text: string): FeedbackRow {
    this.ctx.storage.sql.exec("INSERT INTO feedback(ts, source, author, text) VALUES (?, ?, ?, ?)", Date.now(), source, author, text.slice(0, 4000));
    const row = this.q<FeedbackRow>("SELECT * FROM feedback ORDER BY id DESC LIMIT 1")[0];
    this.addLog(author, "feedback.add", source, text.slice(0, 200));
    return row;
  }
  listFeedback(status?: string, limit = 50): FeedbackRow[] {
    return status
      ? this.q<FeedbackRow>("SELECT * FROM feedback WHERE status = ? ORDER BY id DESC LIMIT ?", status, limit)
      : this.q<FeedbackRow>("SELECT * FROM feedback ORDER BY id DESC LIMIT ?", limit);
  }
  resolveFeedback(id: number, status: "applied" | "ignored", detail: string | null): boolean {
    const r = this.ctx.storage.sql.exec("UPDATE feedback SET status = ?, applied_detail = ? WHERE id = ?", status, detail, id);
    if (r.rowsWritten > 0) this.addLog("orchestrator", `feedback.${status}`, String(id), detail);
    return r.rowsWritten > 0;
  }
}
