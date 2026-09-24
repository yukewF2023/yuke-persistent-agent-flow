import { Board } from "./board";
import { getFile, getRawFile, putFile } from "./github";
import { renderGoalsPage, renderNotFound, renderStatusPage, renderTaskLive, renderTaskPage, renderUnavailable, renderWakeResult, renderWorkersLive } from "./pages";
import type { BoardStatus, Env, LiveStatus, Role } from "./types";
import { bearerOk, html, json, timingSafeEqual } from "./util";

export { Board };

const githubConfig = (env: Env) => ({ token: env.GITHUB_TOKEN ?? "", repo: env.GITHUB_REPO ?? "yukewF2023/yuke-persistent-agent-flow", branch: env.GITHUB_BRANCH ?? "main", path: "GOALS.md" });
/** GET /goals is public; cache the GitHub read for 30 s per isolate so a page refresh does not spend PAT rate limit. */
let goalsCache: { at: number; sha: string | null; text: string } | null = null;

/** Board call with the manager role from inside the Worker (events, wake guard); never exposed to the request's caller. */
async function boardCall(stub: DurableObjectStub, origin: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await stub.fetch(new Request(origin + path, { method: "POST", headers: { "x-board-role": "manager", "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * Wake the manager: the board guards against double wakes and records the request; then, if the routine's API trigger is
 * configured (MANAGER_FIRE_URL + MANAGER_FIRE_TOKEN), POST to it and record the run's URL. Without it, the record is all
 * there is and the next scheduled run (or the next push to main) does the work.
 */
async function wakeManager(env: Env, stub: DurableObjectStub, origin: string, who: string, reason: string): Promise<{ ok: boolean; status: number; message: string; sessionUrl: string | null }> {
  const configured = Boolean(env.MANAGER_FIRE_URL && env.MANAGER_FIRE_TOKEN);
  const guard = await boardCall(stub, origin, "/manager/wake", { who, reason, configured });
  if (!guard.ok) return { ok: false, status: guard.status, message: String(guard.body.error ?? `wake refused (HTTP ${guard.status})`), sessionUrl: null };
  if (!configured) return { ok: false, status: 200, message: "Wake recorded, but no instant trigger is configured on the board (MANAGER_FIRE_URL / MANAGER_FIRE_TOKEN): the manager runs at :13 and :43, and after every push to main. See manager/ROUTINE.md to enable the button.", sessionUrl: null };
  try {
    const res = await fetch(env.MANAGER_FIRE_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${env.MANAGER_FIRE_TOKEN}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ text: `Woken from the board by ${who}: ${reason}. Run the normal manager loop.` })
    });
    const body = (await res.json().catch(() => ({}))) as { claude_code_session_url?: string; error?: { message?: string } };
    if (!res.ok) {
      const message = `the routine's fire endpoint answered HTTP ${res.status}: ${String(body.error?.message ?? "").slice(0, 160)}`;
      await boardCall(stub, origin, "/manager/event", { actor: who, kind: "manager.wake", text: `wake failed: ${message}` });
      return { ok: false, status: 502, message, sessionUrl: null };
    }
    const sessionUrl = body.claude_code_session_url ?? null;
    await boardCall(stub, origin, "/manager/event", { actor: who, kind: "manager.wake", text: `manager run started${sessionUrl ? `: ${sessionUrl}` : ""}` });
    return { ok: true, status: 200, message: "Manager run started; it usually finishes within about five minutes.", sessionUrl };
  } catch (err) {
    const message = `could not reach the routine's fire endpoint: ${String((err as Error)?.message ?? err)}`;
    await boardCall(stub, origin, "/manager/event", { actor: who, kind: "manager.wake", text: `wake failed: ${message}` });
    return { ok: false, status: 502, message, sessionUrl: null };
  }
}

/**
 * Thin router. Authenticates and forwards to the single Board Durable Object with an
 * `x-board-role` header the DO trusts. Public pages are rendered here from the DO's JSON.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;
    if (parts[0] === "healthz") return json({ ok: true });

    let role: Role = "public";
    if (parts[0] === "manager") {
      if (!bearerOk(request, env.ORCHESTRATOR_TOKEN)) return json({ error: "unauthorized" }, 401);
      role = "manager";
    } else if (parts[0] === "worker") {
      if (!bearerOk(request, env.WORKER_TOKEN)) return json({ error: "unauthorized" }, 401);
      role = "worker";
    } else {
      const publicGet = method === "GET" && (parts.length === 0 || ["api", "tasks", "live", "goals"].includes(parts[0]));
      const publicPost = method === "POST" && parts.length === 1 && (parts[0] === "goals" || parts[0] === "wake");
      if (!publicGet && !publicPost) return json({ error: "not found" }, 404);
    }

    const stub = env.BOARD.get(env.BOARD.idFromName("main"));
    /** Fetch from the DO for a public page; a thrown error (e.g. the free-tier read cap during DO startup) becomes an error string. */
    const internal = async (path: string): Promise<{ status: number; body: unknown; error: string | null }> => {
      try {
        const res = await stub.fetch(new Request(url.origin + path, { headers: { "x-board-role": "public" } }));
        const body = await res.json().catch(() => ({}));
        return { status: res.status, body, error: res.ok ? null : ((body as { error?: string }).error ?? `HTTP ${res.status}`) };
      } catch (err) {
        return { status: 500, body: null, error: String((err as Error)?.message ?? err) };
      }
    };
    try {
      if (role === "public" && parts.length === 0) {
        const r = await internal("/api/status");
        if (r.error) return html(renderUnavailable(r.error), 503);
        return html(renderStatusPage(r.body as BoardStatus, Date.now()));
      }
      // ---- goals editor: GOALS.md read from GitHub, committed back through the contents API ----
      if (role === "public" && parts[0] === "goals" && parts.length === 1) {
        const gh = githubConfig(env);
        const editable = Boolean(gh.token);
        const load = async () => {
          if (goalsCache && Date.now() - goalsCache.at < 30_000) return goalsCache;
          const f = editable ? await getFile(gh) : { sha: null, text: await getRawFile(gh) };
          goalsCache = { at: Date.now(), sha: f.sha, text: f.text };
          return goalsCache;
        };
        if (method === "GET") {
          const savedSha = /^[0-9a-f]{7,40}$/.test(url.searchParams.get("saved") ?? "") ? url.searchParams.get("saved") : null;
          try {
            const f = await load();
            return html(renderGoalsPage({ text: f.text, sha: f.sha, editable, ...gh, saved: savedSha ? { sha: savedSha, url: `https://github.com/${gh.repo}/commit/${savedSha}` } : null }));
          } catch (err) {
            return html(renderGoalsPage({ text: "", sha: null, editable, ...gh, loadError: String((err as Error)?.message ?? err) }), 503);
          }
        }
        const form = await request.formData();
        const token = String(form.get("token") ?? "");
        const content = String(form.get("content") ?? "").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
        const sha = String(form.get("sha") ?? "");
        const message = String(form.get("message") ?? "").trim().slice(0, 200) || "GOALS.md: edit from the board";
        const again = (error: string, status: number) => html(renderGoalsPage({ text: content, sha, editable, ...gh, error }), status);
        if (!token || !env.ORCHESTRATOR_TOKEN || !timingSafeEqual(token, env.ORCHESTRATOR_TOKEN)) return again("wrong board token", 401);
        if (!editable) return again("the board has no GITHUB_TOKEN, so it cannot commit", 503);
        if (!sha) return again("the page had no file version to compare against; reload and try again", 400);
        if (!/^## Goal [A-Za-z0-9_-]+: /m.test(content)) return again("refused: the file has no `## Goal <id>: <title>` section, which would pause every goal. Keep at least one goal section.", 400);
        try {
          const commit = await putFile(gh, sha, content, message);
          goalsCache = null;
          await boardCall(stub, url.origin, "/manager/event", { actor: "human", kind: "goals.edit", text: `GOALS.md edited from the board: ${message} → ${commit.commitUrl}` });
          return new Response(null, { status: 303, headers: { location: `/goals?saved=${encodeURIComponent(commit.commitSha)}` } });
        } catch (err) {
          return again(String((err as Error)?.message ?? err), 409);
        }
      }
      // ---- wake button (form) and CLI (bearer) ----
      if (parts[0] === "wake" && method === "POST" && role === "public") {
        const form = await request.formData();
        const token = String(form.get("token") ?? "");
        if (!token || !env.ORCHESTRATOR_TOKEN || !timingSafeEqual(token, env.ORCHESTRATOR_TOKEN)) return html(renderWakeResult({ ok: false, status: 401, message: "wrong board token" }), 401);
        const r = await wakeManager(env, stub, url.origin, "human", String(form.get("reason") ?? "").slice(0, 200) || "button on the board");
        return html(renderWakeResult(r), r.status === 200 ? 200 : r.status);
      }
      if (parts[0] === "manager" && parts[1] === "wake" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { reason?: unknown; who?: unknown };
        const r = await wakeManager(env, stub, url.origin, String(body.who ?? "cli").slice(0, 40), String(body.reason ?? "").slice(0, 200) || "scripts/board.sh wake");
        return json({ ok: r.ok, message: r.message, session_url: r.sessionUrl }, r.status === 200 ? 200 : r.status);
      }
      // HTML fragments the pages poll: the workers list and one task's live section (a few row reads each, uncached)
      if (role === "public" && parts[0] === "live" && parts[1] === "workers") {
        const r = await internal("/api/live");
        if (r.error) return html(`<li class="muted">live view unavailable: ${r.error}</li>`, 503);
        return html(renderWorkersLive(r.body as LiveStatus, Date.now(), url.searchParams.get("open") === "1"));
      }
      if (role === "public" && parts[0] === "live" && parts[1] === "tasks" && parts[2]) {
        const r = await internal(`/api/tasks/${encodeURIComponent(parts[2])}/progress`);
        if (r.error) return html(`<span class="muted">live view unavailable: ${r.error}</span>`, r.status === 404 ? 404 : 503);
        return html(renderTaskLive(r.body as Parameters<typeof renderTaskLive>[0], Date.now()));
      }
      if (role === "public" && parts[0] === "tasks" && parts[1]) {
        const r = await internal(`/api/tasks/${encodeURIComponent(parts[1])}`);
        if (r.status === 404) return html(renderNotFound(), 404);
        if (r.error) return html(renderUnavailable(r.error), 503);
        return html(renderTaskPage(r.body as Parameters<typeof renderTaskPage>[0], Date.now()));
      }
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set("x-board-role", role);
      const init: RequestInit = { method, headers };
      if (method !== "GET" && method !== "HEAD") init.body = await request.arrayBuffer();
      return await stub.fetch(new Request(request.url, init));
    } catch (err) {
      console.error("router error", err);
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
