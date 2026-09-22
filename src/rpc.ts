import type { AgentStatus, FeedbackRow, LogRow, Note, QueueItem, RunRow, TickResult } from "./types";
import type { Candidate, Rating, SearchProfile } from "./agents/weekend-scout-agent";

/**
 * Narrow RPC views of the Durable Object classes. The Worker talks to agents through these
 * instead of DurableObjectStub<Class> (whose mapped types over the SDK's Agent class are too deep for tsc).
 */
export interface AgentRpc {
  getStatus(): Promise<AgentStatus>;
  listNotes(limit?: number, kind?: string): Promise<Note[]>;
  listRuns(limit?: number): Promise<RunRow[]>;
  getRun(id: number): Promise<RunRow | null>;
  listQueue(status?: string, limit?: number): Promise<QueueItem[]>;
  queueAdd(task: string, priority?: number, source?: string): Promise<QueueItem>;
  queueDrop(id: number, reason?: string): Promise<boolean>;
  queueTake(id: number): Promise<QueueItem | null>;
  pause(reason?: string): Promise<AgentStatus>;
  resume(): Promise<AgentStatus>;
  forceTick(reason?: string): Promise<TickResult>;
  forceTickAsync(reason?: string): Promise<{ scheduledFor: number }>;
  ensureScheduled(delaySeconds?: number, reason?: string): Promise<number | null>;
  setConfig(patch: Record<string, unknown>, actor?: string): Promise<Record<string, unknown>>;
  listConfig(): Promise<Record<string, unknown>>;
  getCharter(): Promise<{ base: string; override: string | null; version: number; effective: string }>;
  setCharter(text: string | null, reason: string, actor?: string): Promise<{ version: number }>;
}

export interface ScoutRpc extends AgentRpc {
  setProfile(patch: Partial<SearchProfile>, actor?: string): Promise<{ version: number; profile: SearchProfile }>;
  rate(candidateId: number, rating: "up" | "down", reason: string | null): Promise<{ ok: boolean }>;
  listCandidates(status?: string, limit?: number): Promise<Candidate[]>;
  ratings(limit?: number): Promise<(Rating & { title: string; category: string | null })[]>;
  getPicks(limit?: number): Promise<
    Array<{
      note: { id: number; ts: number; title: string; body: string | null };
      picks: Array<{ id: number; title: string; url: string; when_start: string | null; when_end: string | null; place: string | null; price: number | null; category: string | null; summary: string | null; why: string | null; rating: string | null; rating_reason: string | null }>;
    }>
  >;
}

export interface TeamRpc {
  getState(): Promise<{ memory: Record<string, any> | null; lastRunAt: number | null }>;
  putState(memory: Record<string, any>): Promise<void>;
  addLog(actor: string, action: string, target: string | null, detail: string | null): Promise<number>;
  listLog(limit?: number): Promise<LogRow[]>;
  addFeedback(source: string, author: string, text: string): Promise<FeedbackRow>;
  listFeedback(status?: string, limit?: number): Promise<FeedbackRow[]>;
  resolveFeedback(id: number, status: "applied" | "ignored", detail: string | null): Promise<boolean>;
}
