import { getAgentByName } from "agents";
import type { SearchProfile } from "./agents/weekend-scout-agent";
import type { AgentRpc, ScoutRpc, TeamRpc } from "./rpc";
import type { AgentId, Env } from "./types";

export const AGENT_IDS: AgentId[] = ["uptime", "scout"];

export function isAgentId(x: string): x is AgentId {
  return (AGENT_IDS as string[]).includes(x);
}

/** getAgentByName's generics recurse over the SDK Agent class; call it through a loose signature. */
const byName = getAgentByName as unknown as (ns: unknown, name: string) => Promise<unknown>;

export async function agentStub(env: Env, id: AgentId): Promise<AgentRpc> {
  return (await byName(id === "uptime" ? env.UPTIME : env.SCOUT, "main")) as AgentRpc;
}
export async function scoutStub(env: Env): Promise<ScoutRpc> {
  return (await byName(env.SCOUT, "main")) as ScoutRpc;
}
export function teamStub(env: Env): TeamRpc {
  return env.TEAM.get(env.TEAM.idFromName("main")) as unknown as TeamRpc;
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function bearerOk(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  return timingSafeEqual(m[1].trim(), token);
}

async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

/** /admin/* — every route requires `Authorization: Bearer ORCHESTRATOR_TOKEN`. */
export async function handleAdmin(request: Request, env: Env, path: string[]): Promise<Response> {
  if (!(await bearerOk(request, env.ORCHESTRATOR_TOKEN))) return json({ error: "unauthorized" }, 401);
  const method = request.method;
  const team = teamStub(env);

  // /admin/agents
  if (path[0] === "agents" && path.length === 1 && method === "GET") {
    const statuses = await Promise.all(AGENT_IDS.map(async (id) => (await agentStub(env, id)).getStatus()));
    const queues = await Promise.all(AGENT_IDS.map(async (id) => (await agentStub(env, id)).listQueue("open", 50)));
    const charters = await Promise.all(AGENT_IDS.map(async (id) => (await agentStub(env, id)).getCharter()));
    const configs = await Promise.all(AGENT_IDS.map(async (id) => (await agentStub(env, id)).listConfig()));
    return json({
      generatedAt: Date.now(),
      agents: Object.fromEntries(AGENT_IDS.map((id, i) => [id, { ...statuses[i], queue: queues[i], charter: { version: charters[i].version, override: charters[i].override }, config: configs[i] }])),
      feedback: { new: await team.listFeedback("new", 50) },
      state: await team.getState()
    });
  }

  // /admin/team/*
  if (path[0] === "team") {
    if (path[1] === "state" && method === "GET") return json(await team.getState());
    if (path[1] === "state" && method === "PUT") {
      const b = await body<Record<string, unknown>>(request);
      await team.putState((b.memory as Record<string, unknown> | undefined) ?? b);
      return json({ ok: true });
    }
    if (path[1] === "log" && method === "GET") return json(await team.listLog(Number(new URL(request.url).searchParams.get("limit") ?? 50)));
    if (path[1] === "log" && method === "POST") {
      const b = await body<{ action?: string; target?: string; detail?: string; actor?: string }>(request);
      if (!b.action) return json({ error: "action required" }, 400);
      return json({ id: await team.addLog(b.actor ?? "orchestrator", b.action, b.target ?? null, b.detail ?? null) });
    }
    if (path[1] === "feedback" && path.length === 2 && method === "GET") return json(await team.listFeedback(new URL(request.url).searchParams.get("status") ?? undefined, 100));
    if (path[1] === "feedback" && path.length === 2 && method === "POST") {
      const b = await body<{ text?: string; source?: string; author?: string }>(request);
      if (!b.text) return json({ error: "text required" }, 400);
      return json(await team.addFeedback(b.source ?? "cli", b.author ?? "yuke", b.text));
    }
    if (path[1] === "feedback" && path[3] === "apply" && method === "POST") {
      const b = await body<{ detail?: string; status?: "applied" | "ignored" }>(request);
      return json({ ok: await team.resolveFeedback(Number(path[2]), b.status ?? "applied", b.detail ?? null) });
    }
    return json({ error: "not found" }, 404);
  }

  // /admin/agents/:id/...
  if (path[0] === "agents" && path[1] && isAgentId(path[1])) {
    const id = path[1];
    const agent = await agentStub(env, id);
    const sub = path[2];
    if (sub === "queue" && method === "POST") {
      const b = await body<{ task?: string; priority?: number }>(request);
      if (!b.task) return json({ error: "task required" }, 400);
      const item = await agent.queueAdd(b.task, b.priority ?? 5, "orchestrator");
      await team.addLog("orchestrator", "queue.add", id, b.task.slice(0, 200));
      return json(item);
    }
    if (sub === "queue" && path[3] && method === "DELETE") {
      const ok = await agent.queueDrop(Number(path[3]));
      await team.addLog("orchestrator", "queue.drop", id, path[3]);
      return json({ ok });
    }
    if (sub === "reassign" && method === "POST") {
      const b = await body<{ queueId?: number; to?: string }>(request);
      if (!b.queueId || !b.to || !isAgentId(b.to)) return json({ error: "queueId and to (agent id) required" }, 400);
      const item = await agent.queueTake(Number(b.queueId));
      if (!item) return json({ error: "queue item not found" }, 404);
      const target = await agentStub(env, b.to);
      const created = await target.queueAdd(item.task, item.priority, `reassign:${id}`);
      await team.addLog("orchestrator", "queue.reassign", `${id}→${b.to}`, item.task.slice(0, 200));
      return json({ moved: created });
    }
    if (sub === "tick" && method === "POST") {
      const b = await body<{ reason?: string }>(request);
      const reason = b.reason ?? "orchestrator";
      if (new URL(request.url).searchParams.get("async") === "1") {
        await team.addLog("orchestrator", "tick.async", id, reason);
        return json(await agent.forceTickAsync(reason), 202);
      }
      const r = await agent.forceTick(reason);
      await team.addLog("orchestrator", "tick", id, `${r.status} steps=${r.steps} next=${r.nextWakeSeconds}s`);
      return json(r);
    }
    if (sub === "pause" && method === "POST") {
      const b = await body<{ reason?: string }>(request);
      await team.addLog("orchestrator", "pause", id, b.reason ?? null);
      return json(await agent.pause(b.reason ?? "paused by orchestrator"));
    }
    if (sub === "resume" && method === "POST") {
      await team.addLog("orchestrator", "resume", id, null);
      return json(await agent.resume());
    }
    if (sub === "ensure" && method === "POST") return json({ nextTickAt: await agent.ensureScheduled() });
    if (sub === "config" && method === "GET") return json(await agent.listConfig());
    if (sub === "config" && method === "PATCH") {
      const b = await body<Record<string, unknown>>(request);
      if (!Object.keys(b).length) return json({ error: "empty patch" }, 400);
      const applied = await agent.setConfig(b, "orchestrator");
      await team.addLog("orchestrator", "config.patch", id, Object.keys(b).join(","));
      return json({ applied, config: await agent.listConfig() });
    }
    if (sub === "profile" && id === "scout" && (method === "PATCH" || method === "PUT")) {
      const b = await body<Record<string, unknown>>(request);
      const scout = await scoutStub(env);
      const r = await scout.setProfile(b as Partial<SearchProfile>, "orchestrator");
      await team.addLog("orchestrator", "profile.patch", id, `v${r.version}: ${Object.keys(b).join(",")}`);
      return json(r);
    }
    if (sub === "charter" && method === "GET") return json(await agent.getCharter());
    if (sub === "charter" && (method === "PUT" || method === "DELETE")) {
      const b = method === "PUT" ? await body<{ text?: string; reason?: string }>(request) : { text: null as string | null, reason: "reset" };
      if (method === "PUT" && !b.text) return json({ error: "text required" }, 400);
      const r = await agent.setCharter(b.text ?? null, b.reason ?? "", "orchestrator");
      await team.addLog("orchestrator", method === "PUT" ? "charter.override" : "charter.reset", id, `v${r.version}: ${b.reason ?? ""}`);
      return json(r);
    }
    if (sub === "runs" && path[3] && method === "GET") {
      const run = await agent.getRun(Number(path[3]));
      return run ? json({ ...run, transcript: run.transcript ? JSON.parse(run.transcript) : null }) : json({ error: "not found" }, 404);
    }
    if (sub === "rate" && id === "scout" && method === "POST") {
      const b = await body<{ candidateId?: number; rating?: "up" | "down"; reason?: string }>(request);
      if (!b.candidateId || !b.rating) return json({ error: "candidateId and rating required" }, 400);
      const scout = await scoutStub(env);
      return json(await scout.rate(Number(b.candidateId), b.rating, b.reason ?? null));
    }
    if (sub === "candidates" && id === "scout" && method === "GET") {
      const scout = await scoutStub(env);
      return json(await scout.listCandidates(new URL(request.url).searchParams.get("status") ?? undefined, 100));
    }
  }
  return json({ error: "not found" }, 404);
}
