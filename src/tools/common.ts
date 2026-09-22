import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { BaseAgent, TickCtx } from "../agents/base-agent";

/** Tools every agent has: notes, queue, memory, and the mandatory `finish`. All are SQL-only (no subrequests). */
export function commonTools(agent: BaseAgent, ctx: TickCtx): ToolSet {
  return {
    write_note: tool({
      description: "Record something worth remembering or surfacing to the human. kinds: change (state changed), finding (new fact), thought (reasoning worth keeping), error. Do not write 'all healthy' notes.",
      inputSchema: z.object({
        kind: z.enum(["change", "finding", "thought", "error"]),
        title: z.string().min(3).max(140),
        body: z.string().max(2000).optional()
      }),
      execute: async ({ kind, title, body }) => agent.addNote(kind, title, body ?? null, ctx.runId)
    }),
    queue_add: tool({
      description: "Add a follow-up task for yourself to handle on a later tick.",
      inputSchema: z.object({ task: z.string().min(3).max(500), priority: z.number().int().min(1).max(9).default(5) }),
      execute: async ({ task, priority }) => agent.queueAdd(task, priority, "self")
    }),
    queue_complete: tool({
      description: "Mark a queue item done, with a one-line result.",
      inputSchema: z.object({ id: z.number().int(), result: z.string().max(500) }),
      execute: async ({ id, result }) => ({ ok: agent.queueUpdate(id, "done", result) })
    }),
    queue_drop: tool({
      description: "Drop a queue item you cannot or should not do, with the reason.",
      inputSchema: z.object({ id: z.number().int(), reason: z.string().max(300) }),
      execute: async ({ id, reason }) => ({ ok: agent.queueUpdate(id, "dropped", reason) })
    }),
    remember: tool({
      description: "Store a short fact under a key so future ticks see it in Memory (overwrites). Use value null to forget.",
      inputSchema: z.object({ key: z.string().min(1).max(64), value: z.string().max(500).nullable() }),
      execute: async ({ key, value }) => {
        agent.remember(key, value);
        return { ok: true };
      }
    }),
    finish: tool({
      description: "REQUIRED last call. Summarise this tick in one line and choose when to wake next (seconds).",
      inputSchema: z.object({
        summary: z.string().min(3).max(300),
        next_wake_seconds: z.number().int().min(30).max(86_400),
        reason: z.string().max(200).default("")
      }),
      execute: async ({ summary, next_wake_seconds, reason }) => {
        ctx.decision = { summary, nextWakeSeconds: next_wake_seconds, reason };
        return { ok: true };
      }
    })
  };
}
