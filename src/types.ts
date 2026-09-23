/** Worker bindings and secrets. */
export interface Env {
  BOARD: DurableObjectNamespace;
  /** Bearer token for /manager/* (the Claude manager routine and humans). */
  ORCHESTRATOR_TOKEN: string;
  /** Bearer token for /worker/* (the DeepSeek worker processes). */
  WORKER_TOKEN: string;
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
  worker_id: string | null;
  created_at: number;
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
}

/** Shape of GET /api/status (also what the status page renders). */
export interface BoardStatus {
  generatedAt: number;
  goals: (GoalRow & { counts: Record<string, number> })[];
  counts: Record<string, number>;
  workers: (WorkerRow & { task_key: string | null })[];
  running: Pick<TaskRow, "id" | "key" | "title" | "worker_id" | "claimed_at" | "lease_until" | "attempt" | "status">[];
  reviewQueue: Pick<TaskRow, "id" | "key" | "title" | "submitted_at" | "attempt">[];
  recentAccepted: Pick<TaskRow, "id" | "key" | "title" | "finished_at" | "cost_usd" | "attempt">[];
  blocked: Pick<TaskRow, "id" | "key" | "title" | "last_error" | "attempt">[];
  spend: SpendSummary;
  needsHuman: { ts: number; text: string }[];
  events: EventRow[];
  manager: { lastRunAt: number | null; lockedUntil: number | null };
}
