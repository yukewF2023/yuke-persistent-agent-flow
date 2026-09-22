import { AGENT_IDS, agentStub, handleAdmin, isAgentId, json, scoutStub, teamStub, timingSafeEqual } from "./admin";
import { renderStatusPage } from "./status-page";
import { renderPicksPage } from "./picks-page";
import type { Env } from "./types";

export { UptimeAgent } from "./agents/uptime-agent";
export { WeekendScoutAgent } from "./agents/weekend-scout-agent";
export { TeamState } from "./team-state";

const html = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** Tiny per-isolate rate limit for the picks token (60/min). Not durable; good enough for one human. */
const picksHits: number[] = [];
function picksRateOk() {
  const now = Date.now();
  while (picksHits.length && picksHits[0] < now - 60_000) picksHits.shift();
  if (picksHits.length >= 60) return false;
  picksHits.push(now);
  return true;
}

async function picksTokenOk(request: Request, env: Env) {
  const url = new URL(request.url);
  const k = url.searchParams.get("k") ?? request.headers.get("x-picks-token") ?? "";
  return !!env.PICKS_TOKEN && k.length > 0 && (await timingSafeEqual(k, env.PICKS_TOKEN));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;
    try {
      // ---- public ----
      if (parts.length === 0 && method === "GET") {
        const now = Date.now();
        const [statuses, team] = await Promise.all([
          Promise.all(AGENT_IDS.map(async (id) => (await agentStub(env, id)).getStatus())),
          (async () => {
            const t = teamStub(env);
            const [log, state] = await Promise.all([t.listLog(15), t.getState()]);
            return { log, state };
          })()
        ]);
        return html(renderStatusPage(statuses, team.log, team.state.lastRunAt, now));
      }
      if (parts[0] === "api" && parts[1] === "status" && method === "GET") {
        const statuses = await Promise.all(AGENT_IDS.map(async (id) => (await agentStub(env, id)).getStatus()));
        const team = teamStub(env);
        return json({ generatedAt: Date.now(), agents: Object.fromEntries(statuses.map((s) => [s.id, s])), orchestrator: await team.getState(), teamLog: await team.listLog(10) });
      }
      if (parts[0] === "api" && parts[1] === "agents" && parts[2] && isAgentId(parts[2]) && method === "GET") {
        const agent = await agentStub(env, parts[2]);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (parts[3] === "notes") return json(await agent.listNotes(limit, url.searchParams.get("kind") ?? undefined));
        if (parts[3] === "runs") return json(await agent.listRuns(limit));
        if (parts[3] === "queue") return json(await agent.listQueue(url.searchParams.get("status") ?? undefined, limit));
        if (parts[3] === "charter") return json(await agent.getCharter());
        return json(await agent.getStatus());
      }
      if (parts[0] === "api" && parts[1] === "team" && parts[2] === "log" && method === "GET") {
        return json(await teamStub(env).listLog(Number(url.searchParams.get("limit") ?? 50)));
      }

      // ---- picks (token-gated) ----
      if (parts[0] === "picks" || (parts[0] === "api" && parts[1] === "picks")) {
        if (!(await picksTokenOk(request, env))) return parts[0] === "picks" ? html("<h1>401</h1><p>This page needs the private link.</p>", 401) : json({ error: "unauthorized" }, 401);
        if (!picksRateOk()) return json({ error: "slow down" }, 429);
        if (parts[0] === "picks") return html(renderPicksPage(url.searchParams.get("k") ?? ""));
        const scout = await scoutStub(env);
        if (parts.length === 2 && method === "GET") return json(await scout.getPicks(Number(url.searchParams.get("limit") ?? 3)));
        if (parts[2] === "rate" && method === "POST") {
          const b = (await request.json().catch(() => ({}))) as { candidateId?: number; rating?: "up" | "down"; reason?: string };
          if (!b.candidateId || (b.rating !== "up" && b.rating !== "down")) return json({ error: "candidateId and rating (up|down) required" }, 400);
          const r = await scout.rate(Number(b.candidateId), b.rating, b.reason ?? null);
          if (r.ok) await teamStub(env).addFeedback("picks-page", "yuke", `rated candidate #${b.candidateId} ${b.rating === "up" ? "👍" : "👎"}${b.reason ? `: ${b.reason}` : ""}`);
          return json(r);
        }
        if (parts[2] === "feedback" && method === "POST") {
          const b = (await request.json().catch(() => ({}))) as { text?: string };
          if (!b.text?.trim()) return json({ error: "text required" }, 400);
          await teamStub(env).addFeedback("picks-page", "yuke", b.text.trim());
          return json({ ok: true });
        }
        return json({ error: "not found" }, 404);
      }

      // ---- admin (bearer) ----
      if (parts[0] === "admin") return handleAdmin(request, env, parts.slice(1));

      if (parts[0] === "healthz") return json({ ok: true });
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("router error", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
