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
  /** Optional: the project builder routine's API-trigger endpoint and its bearer token; approving an idea fires it. */
  BUILDER_FIRE_URL?: string;
  BUILDER_FIRE_TOKEN?: string;
  /** Bearer token for /app/* (the DeepSpace app, which signs the human in and acts for her). It can approve, record and wake; it cannot reach /manager/*. */
  APP_TOKEN?: string;
}

export type Role = "public" | "manager" | "worker" | "app";

export type TaskStatus = "ready" | "claimed" | "running" | "review" | "accepted" | "rejected" | "blocked" | "cancelled";
export type TaskKind = "ts" | "py" | "check" | "other" | "doc";

export interface GoalRow {
  id: string;
  title: string;
  body: string;
  done_when: string | null;
  min_ready: number;
  /** number of catalog items in the goal body (parsed by goals-sync), or null when the goal has no catalog */
  catalog_size: number | null;
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
  /** goal ids this worker prefers to claim from (JSON string[]), or null */
  goals: string | null;
  task_id: number | null;
  last_seen: number;
  note: string | null;
  tasks_done: number;
  tasks_failed: number;
}

/** A manager-maintained document (brief) on the board: rewritten in place, never appended. */
export interface DocMeta {
  id: string;
  title: string;
  version: number;
  updated_at: number;
  bytes: number;
  note: string | null;
}
export interface DocRow extends DocMeta {
  body: string;
  /** rows of the document's idea tables (GET /api/docs/:id only), so readers need no table parser of their own */
  idea_rows?: { table: number; index: number; ref: string; idea: string; cells: Record<string, string> }[];
  log: { ts: number; version: number; note: string | null; bytes: number }[];
}

/**
 * A project: an idea a human approved from an idea bank, which the builder routine turns into a folder in the projects repository.
 * approved → building → ready (pull request open) → active (merged, running in Cowork) → done | dropped; failed when the build broke.
 */
export type ProjectStatus = "approved" | "building" | "ready" | "active" | "done" | "dropped" | "failed";
export interface ProjectRow {
  id: number;
  /** folder name in the projects repository, set by the builder */
  slug: string | null;
  /** the idea bank the row came from, and its version when approved */
  doc_id: string;
  doc_version: number;
  /** the row's "Idea" cell as approved (the bank is rewritten later; this copy is not) */
  idea: string;
  row: string; // JSON {column: cell}
  /** what the human typed when approving */
  notes: string;
  status: ProjectStatus;
  pr_url: string | null;
  /** the builder run's transcript */
  session_url: string | null;
  /** one line recorded by the human when the project ends */
  result: string | null;
  /** the last status note (why a build failed, what the builder produced) */
  note: string | null;
  log: string; // JSON ProjectLogEntry[]
  created_at: number;
  updated_at: number;
}
export interface ProjectLogEntry {
  ts: number;
  actor: string;
  status: ProjectStatus;
  text: string;
}
/** A project as the API returns it. */
export type Project = Omit<ProjectRow, "row" | "log"> & { row: Record<string, string>; log: ProjectLogEntry[] };
export type ProjectSummary = Pick<ProjectRow, "id" | "slug" | "doc_id" | "idea" | "status" | "pr_url" | "session_url" | "result" | "note" | "created_at" | "updated_at">;

/**
 * Feedback: what the human said about one idea-bank row, or a free note to the manager. The manager acts on it in its next
 * run (the row, and a rule in the goal's taste notes when it generalises) and closes it with one line saying what it did.
 */
export type FeedbackKind = "generic" | "not_for_us" | "known" | "sharpen" | "more" | "note";
export interface FeedbackRow {
  id: number;
  who: string;
  /** the document the feedback was given on (an idea bank for a row; any document, or null, for a note) */
  doc_id: string | null;
  doc_version: number | null;
  /** the row's "Idea" cell as it stood (the bank is rewritten later; this copy is not); null for a note */
  idea: string | null;
  row: string | null; // JSON {column: cell}
  kind: FeedbackKind;
  note: string;
  status: "open" | "handled";
  /** one line from the manager: what it did with the feedback */
  outcome: string | null;
  created_at: number;
  handled_at: number | null;
}
/** A feedback item as the API returns it. */
export type Feedback = Omit<FeedbackRow, "row"> & { row: Record<string, string> | null };

export interface SpendSummary {
  todayUsd: number;
  fiveHourUsd: number;
  weekUsd: number;
  monthUsd: number;
  todayTasks: number;
  paceUsdPerDay: number;
  inflightEstimateUsd: number;
  /** "smooth": the daily pace is released hour by hour; "burst": all of it from 00:00 UTC */
  paceMode: "smooth" | "burst";
  /** how much of today's pace is released right now (equals the pace in burst mode), including any extra */
  allowedNowUsd: number;
  /** a one-day allowance a human added on top of the pace (scripts/board.sh pace-extra); released at once, gone at 00:00 UTC */
  extraTodayUsd: number;
  pacing: { reason: string; retryAfterS: number } | null;
  /** the last 7 UTC days, today first */
  days: { day: string; usd: number; tasks: number }[];
}

/** Shape of GET /api/live: what the Workers view needs, uncached and cheap (a handful of row reads). */
export interface LiveStatus {
  generatedAt: number;
  workers: (WorkerRow & { task_key: string | null })[];
  running: Pick<TaskRow, "id" | "key" | "title" | "worker_id" | "claimed_at" | "lease_until" | "attempt" | "status" | "max_minutes" | "goal_id">[];
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
  running: Pick<TaskRow, "id" | "key" | "title" | "worker_id" | "claimed_at" | "lease_until" | "attempt" | "status" | "max_minutes" | "goal_id">[];
  reviewQueue: Pick<TaskRow, "id" | "key" | "title" | "submitted_at" | "attempt" | "goal_id">[];
  recentAccepted: Pick<TaskRow, "id" | "key" | "title" | "finished_at" | "cost_usd" | "attempt" | "goal_id">[];
  blocked: Pick<TaskRow, "id" | "key" | "title" | "last_error" | "attempt" | "goal_id">[];
  /** tasks accepted since 00:00 UTC (one index-bounded count) */
  acceptedToday: number;
  /** the manager-maintained briefs (metadata only; bodies at /api/docs/<id>) */
  docs: DocMeta[];
  /** approved ideas and what became of them, newest first (at most 40) */
  projects: ProjectSummary[];
  spend: SpendSummary;
  needsHuman: { ts: number; text: string }[];
  /** feedback from the human that the manager has not handled yet (items at /api/feedback) */
  feedbackOpen: number;
  events: EventRow[];
  /** live snapshots of the tasks in progress, keyed by task id (as posted by the workers; at most one per running task) */
  progress: Record<string, ProgressSnapshot>;
  manager: { lastRunAt: number | null; lockedUntil: number | null };
  /** Durable Object row usage today against the free-tier limits. */
  cloudflare: { day: string; reads: number; writes: number; readLimit: number; writeLimit: number };
}
