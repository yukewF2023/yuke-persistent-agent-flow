/** Worker bindings and secrets. */
export interface Env {
  BOARD: DurableObjectNamespace;
  /** Bearer token for /manager/* (the Claude manager routine and humans). */
  ORCHESTRATOR_TOKEN: string;
  /** Bearer token for /worker/* (the DeepSeek worker processes). */
  WORKER_TOKEN: string;
  /** Optional: fine-grained GitHub PAT (contents: read/write on GITHUB_REPO) that lets the /goals page commit GOALS.md. */
  GITHUB_TOKEN?: string;
  /** owner/name of the repository the manager clones (wrangler.jsonc vars). */
  GITHUB_REPO?: string;
  /** Branch the manager reads (default main). */
  GITHUB_BRANCH?: string;
  /** Optional: the manager routine's API-trigger endpoint (…/routines/<id>/fire) and its bearer token, for the wake button. */
  MANAGER_FIRE_URL?: string;
  MANAGER_FIRE_TOKEN?: string;
}

export type Role = "public" | "manager" | "worker";

export type TaskStatus = "ready" | "claimed" | "running" | "review" | "accepted" | "rejected" | "blocked" | "cancelled";
export type TaskKind = "ts" | "py" | "check" | "other";

export interface GoalRow {
  id: string;
  title: string;
  body: string;
  done_when: string | null;
  min_ready: number;
  status: "active" | "paused" | "done";
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: number;
  goal_id: string;
  key: string;
  title: string;
  spec: string;
  acceptance: string;
  deps: string; // JSON number[]
  kind: TaskKind;
  status: TaskStatus;
  priority: number;
  attempt: number;
  max_attempts: number;
  max_minutes: number;
  worker_id: string | null;
  lease_until: number | null;
  claimed_at: number | null;
  submitted_at: number | null;
  finished_at: number | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  steps: number;
  last_error: string | null;
  review_notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeliverableRow {
  id: number;
  task_id: number;
  attempt: number;
  report: string;
  files: string; // JSON {path: content}
  bytes: number;
  nfiles: number;
  truncated: number;
  steps: number;
  session_id: string | null;
  /** Public transcript link when session sharing is enabled on the worker VM. */
  session_url: string | null;
  worker_id: string | null;
  created_at: number;
}

/** One entry of a worker's live progress feed (the last ~30 opencode events of the running task). */
export interface ProgressEvent {
  /** seconds since the session started */
  t: number;
  k: "step" | "tool" | "text" | "error";
  /** step number at the time of the event */
  n: number;
  tool?: string;
  title?: string;
  status?: string;
  text?: string;
}

/** Live progress snapshot a worker posts for its running task (overwritten, never appended). */
export interface ProgressSnapshot {
  worker_id: string;
  attempt: number;
  phase: "running" | "done" | "failed";
  step: number;
  tools: number;
  elapsed_s: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_usd: number;
  last_tool: string | null;
  last_text: string | null;
  session_id: string | null;
  session_url: string | null;
  events: ProgressEvent[];
  /** set by the board */
  updated_at: number;
}

export interface ProgressRow {
  task_id: number;
  attempt: number;
  worker_id: string;
  done: number;
  updated_at: number;
  body: string; // JSON ProgressSnapshot without updated_at
}

export interface ReviewRow {
  id: number;
  task_id: number;
  attempt: number;
  verdict: "accept" | "reject";
  notes: string | null;
  who: string;
  created_at: number;
}

export interface EventRow {
  id: number;
  ts: number;
  actor: string;
  kind: string;
  task_id: number | null;
  text: string;
}

export interface WorkerRow {
  id: string;
  host: string | null;
  version: string | null;
  task_id: number | null;
  last_seen: number;
  note: string | null;
  tasks_done: number;
  tasks_failed: number;
}

export interface SpendSummary {
  todayUsd: number;
  fiveHourUsd: number;
  weekUsd: number;
  monthUsd: number;
  todayTasks: number;
  paceUsdPerDay: number;
  inflightEstimateUsd: number;
  pacing: { reason: string; retryAfterS: number } | null;
  /** the last 7 UTC days, today first */
  days: { day: string; usd: number; tasks: number }[];
}

/** Shape of GET /api/live: what the Workers view needs, uncached and cheap (a handful of row reads). */
export interface LiveStatus {
  generatedAt: number;
  workers: (WorkerRow & { task_key: string | null })[];
  running: Pick<TaskRow, "id" | "key" | "title" | "worker_id" | "claimed_at" | "lease_until" | "attempt" | "status">[];
  progress: Record<string, ProgressSnapshot>;
}

/** Shape of GET /api/status (also what the status page renders). */
export interface BoardStatus {
  generatedAt: number;
  goals: (GoalRow & { counts: Record<string, number> })[];
  counts: Record<string, number>;
  workers: (WorkerRow & { task_key: string | null })[];
  /** the next ready tasks in claim order (priority, id), at most 20 */
  ready: Pick<TaskRow, "id" | "key" | "title" | "goal_id" | "priority" | "created_at" | "deps">[];
  running: Pick<TaskRow, "id" | "key" | "title" | "worker_id" | "claimed_at" | "lease_until" | "attempt" | "status">[];
  reviewQueue: Pick<TaskRow, "id" | "key" | "title" | "submitted_at" | "attempt">[];
  recentAccepted: Pick<TaskRow, "id" | "key" | "title" | "finished_at" | "cost_usd" | "attempt">[];
  blocked: Pick<TaskRow, "id" | "key" | "title" | "last_error" | "attempt">[];
  spend: SpendSummary;
  needsHuman: { ts: number; text: string }[];
  events: EventRow[];
  /** live snapshots of the tasks in progress, keyed by task id (as posted by the workers; at most one per running task) */
  progress: Record<string, ProgressSnapshot>;
  manager: { lastRunAt: number | null; lockedUntil: number | null };
  /** Durable Object row usage today against the free-tier limits. */
  cloudflare: { day: string; reads: number; writes: number; readLimit: number; writeLimit: number };
}
