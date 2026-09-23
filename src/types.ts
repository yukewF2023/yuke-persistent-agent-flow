/** Bindings + vars + secrets. Extends the wrangler-generated Cloudflare.Env (DO namespaces stay untyped there; see rpc.ts). */
export interface Env extends Cloudflare.Env {
  OPENCODE_API_KEY: string;
  ORCHESTRATOR_TOKEN: string;
  PICKS_TOKEN: string;
  TAVILY_API_KEY?: string;
  NTFY_TOPIC?: string;
  TICKETMASTER_API_KEY?: string;
}

export type AgentId = "uptime" | "scout";

export type NoteKind = "change" | "finding" | "recommendation" | "thought" | "error" | "admin";

export interface Note {
  id: number;
  ts: number;
  kind: NoteKind;
  title: string;
  body: string | null;
  run_id: number | null;
  meta: string | null;
}

export interface QueueItem {
  id: number;
  created_at: number;
  updated_at: number;
  status: "open" | "doing" | "done" | "dropped";
  priority: number;
  task: string;
  source: string;
  result: string | null;
}

export interface RunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  trigger: string;
  status: "ok" | "error" | "skipped" | "paused" | "budget" | "running";
  steps: number;
  input_tokens: number;
  output_tokens: number;
  subrequests: number;
  llm_ms: number;
  wall_ms: number;
  next_wake_s: number | null;
  summary: string | null;
  error: string | null;
  transcript: string | null;
  cost_usd: number;
  work_item: string | null;
}

export interface TickResult {
  runId: number;
  status: RunRow["status"];
  steps: number;
  subrequests: number;
  inputTokens: number;
  outputTokens: number;
  nextWakeSeconds: number | null;
  nextTickAt: number | null;
  summary: string | null;
  error: string | null;
  thinks: number;
  costUsd: number;
}

export interface WorkItem {
  id: number;
  kind: "code" | "think";
  action: string;
  args: string | null;
  priority: number;
  status: "open" | "doing" | "done" | "failed";
  source: string;
  created_at: number;
  started_at: number | null;
  done_at: number | null;
  result: string | null;
}

export interface ActivityRow {
  id: number;
  ts: number;
  kind: string;
  text: string;
  work_id: number | null;
  cost_usd: number;
}

export interface SpendWindows {
  fiveHourUsd: number;
  weekUsd: number;
  monthUsd: number;
  todayUsd: number;
  todayTokens: number;
}

export interface AgentStatus {
  id: AgentId;
  name: string;
  paused: boolean;
  runCount: number;
  lastTickAt: number | null;
  nextTickAt: number | null;
  lastSummary: string | null;
  lastError: string | null;
  charterVersion: number;
  budgetToday: { tokens: number; limit: number };
  queueOpen: number;
  pendingSchedules: number;
  segmentCount: number;
  workingNow: string | null;
  workOpen: number;
  workDoneToday: number;
  thinksToday: number;
  spend: SpendWindows;
  governor: { monthlyBudgetUsd: number; burstUsd: number; bucketUsd: number; waitUntil: number | null; avgThinkUsd: number };
  recentRuns: Pick<RunRow, "id" | "started_at" | "status" | "steps" | "input_tokens" | "output_tokens" | "subrequests" | "next_wake_s" | "summary" | "trigger" | "cost_usd" | "work_item">[];
  recentNotes: Note[];
  recentActivity: ActivityRow[];
  extra: Record<string, any>;
}

export interface FeedbackRow {
  id: number;
  ts: number;
  source: string;
  author: string;
  text: string;
  status: "new" | "applied" | "ignored";
  applied_detail: string | null;
}

export interface LogRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}
