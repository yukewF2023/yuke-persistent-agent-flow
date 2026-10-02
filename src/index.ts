import { Board } from "./board";
import { getFile, getRawFile, putFile } from "./github";
import type { Env, Project, Role } from "./types";
import { bearerOk, json, readJson } from "./util";

export { Board };

const githubConfig = (env: Env) => ({ token: env.GITHUB_TOKEN ?? "", repo: env.GITHUB_REPO ?? "yukewF2023/yuke-persistent-agent-flow", branch: env.GITHUB_BRANCH ?? "main", path: "GOALS.md" });
/** Board call with the manager role from inside the Worker (events, wake guard); never exposed to the request's caller. */
async function boardCall(stub: DurableObjectStub, origin: string, path: string, body: unknown, method = "POST"): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await stub.fetch(new Request(origin + path, { method, headers: { "x-board-role": "manager", "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** POST to a Claude Code routine's API trigger (…/routines/<id>/fire). Returns the run's URL, or why the run did not start. */
async function fireRoutine(fireUrl: string, token: string, text: string): Promise<{ ok: true; sessionUrl: string | null } | { ok: false; message: string }> {
  try {
    const res = await fetch(fireUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    const body = (await res.json().catch(() => ({}))) as { claude_code_session_url?: string; error?: { message?: string } };
    if (!res.ok) return { ok: false, message: `the routine's fire endpoint answered HTTP ${res.status}: ${String(body.error?.message ?? "").slice(0, 160)}` };
    return { ok: true, sessionUrl: body.claude_code_session_url ?? null };
  } catch (err) {
    return { ok: false, message: `could not reach the routine's fire endpoint: ${String((err as Error)?.message ?? err)}` };
  }
}

/**
 * Start the project builder for an approved project: fire its routine (BUILDER_FIRE_URL + BUILDER_FIRE_TOKEN) and record the
 * run on the project. The builder finds the project on the board itself, so the payload carries no idea text. Without the
 * trigger, or when the fire fails, the project stays `approved` with a note saying why; the project page offers to try again.
 */
async function startBuilder(env: Env, stub: DurableObjectStub, origin: string, id: number): Promise<void> {
  const note = (body: Record<string, unknown>) => boardCall(stub, origin, `/manager/projects/${id}`, { actor: "board", ...body }, "PATCH");
  if (!env.BUILDER_FIRE_URL || !env.BUILDER_FIRE_TOKEN) {
    await note({ note: "waiting: the builder's trigger is not configured on the board (BUILDER_FIRE_URL / BUILDER_FIRE_TOKEN), so nothing starts by itself. See docs/PROJECTS.md." });
    return;
  }
  const r = await fireRoutine(env.BUILDER_FIRE_URL, env.BUILDER_FIRE_TOKEN, `Project P${id} was approved on the board. Read builder/PROMPT.md and follow it.`);
  await note(r.ok ? { session_url: r.sessionUrl ?? "", note: "builder run started" } : { note: `the builder did not start: ${r.message}` });
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
  const r = await fireRoutine(env.MANAGER_FIRE_URL!, env.MANAGER_FIRE_TOKEN!, `Woken from the board by ${who}: ${reason}. Run the normal manager loop.`);
  if (!r.ok) {
    await boardCall(stub, origin, "/manager/event", { actor: who, kind: "manager.wake", text: `wake failed: ${r.message}` });
    return { ok: false, status: 502, message: r.message, sessionUrl: null };
  }
  await boardCall(stub, origin, "/manager/event", { actor: who, kind: "manager.wake", text: `manager run started${r.sessionUrl ? `: ${r.sessionUrl}` : ""}` });
  return { ok: true, status: 200, message: "Manager run started; it usually finishes within about five minutes.", sessionUrl: r.sessionUrl };
}

/**
 * Thin router. Authenticates and forwards to the single Board Durable Object with an `x-board-role` header the DO trusts.
 *
 * Nothing here is public. People see the board through the DeepSpace app (agent-board), which signs them in and calls
 * /app/* and GET /api/* with APP_TOKEN; the manager and builder routines use /manager/* (and the same read-only /api/*)
 * with ORCHESTRATOR_TOKEN; the VM workers use /worker/* with WORKER_TOKEN. Every other request gets a bare 404.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;
    let role: Role = "public";
    if (parts[0] === "manager") {
      if (!bearerOk(request, env.ORCHESTRATOR_TOKEN)) return json({ error: "unauthorized" }, 401);
      role = "manager";
    } else if (parts[0] === "worker") {
      if (!bearerOk(request, env.WORKER_TOKEN)) return json({ error: "unauthorized" }, 401);
      role = "worker";
    } else if (parts[0] === "app") {
      if (!bearerOk(request, env.APP_TOKEN)) return json({ error: "unauthorized" }, 401);
      role = "app";
    } else if (parts[0] === "api" && method === "GET") {
      // the read-only JSON, for the app (on behalf of the signed-in owner) and for the manager's and builder's scripts
      if (!bearerOk(request, env.APP_TOKEN) && !bearerOk(request, env.ORCHESTRATOR_TOKEN)) return json({ error: "unauthorized" }, 401);
    } else return json({ error: "not found" }, 404);

    const stub = env.BOARD.get(env.BOARD.idFromName("main"));
    /** Read the DO's JSON from inside the Worker; a thrown error (e.g. the free-tier read cap during DO startup) becomes an error string. */
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
      // ---- /app/*: what the signed-in human does, called by the DeepSpace app with its own token. JSON in, JSON out. ----
      if (role === "app") {
        const body = method === "GET" ? {} : await readJson<Record<string, unknown>>(request);
        const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
        /** who clicked, as the app verified it (an email); recorded as the event's actor */
        const who = text(body.who, 40).trim() || "owner";
        const gh = githubConfig(env);
        if (parts[1] === "config" && method === "GET")
          return json({ builderReady: Boolean(env.BUILDER_FIRE_URL && env.BUILDER_FIRE_TOKEN), goalsEditable: Boolean(gh.token), wakeConfigured: Boolean(env.MANAGER_FIRE_URL && env.MANAGER_FIRE_TOKEN), repo: gh.repo, branch: gh.branch });
        if (parts[1] === "projects" && !parts[2] && method === "POST") {
          const r = await boardCall(stub, url.origin, "/manager/projects", { doc_id: text(body.doc, 40), version: Number(body.version ?? 0), row: text(body.row, 12), idea: text(body.idea, 4000), notes: text(body.notes, 2000).replace(/\r\n?/g, "\n"), actor: who });
          if (!r.ok) return json(r.body, r.status);
          const id = Number((r.body.project as { id?: number } | undefined)?.id ?? 0);
          await startBuilder(env, stub, url.origin, id);
          return json({ ok: true, id });
        }
        if (parts[1] === "projects" && parts[2] && method === "POST") {
          const id = Number(parts[2]);
          const cur = await internal(`/api/projects/${id}`);
          if (cur.error) return json({ error: cur.error }, cur.status === 404 ? 404 : 503);
          const project = cur.body as Project;
          const patch = (b: Record<string, unknown>) => boardCall(stub, url.origin, `/manager/projects/${id}`, { actor: who, ...b }, "PATCH");
          const action = text(body.action, 20);
          if (action === "rebuild" && ["approved", "building", "failed"].includes(project.status)) {
            await patch({ status: "approved", note: "build requested from the board" });
            await startBuilder(env, stub, url.origin, id);
          } else if (action === "merged" && project.status === "ready") {
            await patch({ status: "active", note: "merged; running in Cowork" });
          } else if (action === "result" && !["done", "dropped"].includes(project.status)) {
            const result = text(body.result, 300).trim();
            if (result.length < 3) return json({ error: "Write one line saying what happened, so the idea bank can record it." }, 400);
            await patch({ status: body.outcome === "dropped" ? "dropped" : "done", result });
          } else return json({ error: "That action does not fit the project's current state. Reload the page." }, 409);
          return json({ ok: true, project: (await internal(`/api/projects/${id}`)).body });
        }
        if (parts[1] === "goals" && !parts[2] && method === "GET") {
          try {
            const f = gh.token ? await getFile(gh) : { sha: null, text: await getRawFile(gh) };
            return json({ text: f.text, sha: f.sha, editable: Boolean(gh.token), repo: gh.repo, branch: gh.branch, path: gh.path });
          } catch (err) {
            return json({ error: String((err as Error)?.message ?? err) }, 503);
          }
        }
        if (parts[1] === "goals" && !parts[2] && method === "PUT") {
          const content = text(body.content, 200_000).replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
          const sha = text(body.sha, 80);
          const message = text(body.message, 200).trim() || "GOALS.md: edit from the board";
          if (!gh.token) return json({ error: "the board has no GITHUB_TOKEN, so it cannot commit" }, 503);
          if (!sha) return json({ error: "no file version to compare against; reload and try again" }, 400);
          if (!/^## Goal [A-Za-z0-9_-]+: /m.test(content)) return json({ error: "refused: the file has no `## Goal <id>: <title>` section, which would pause every goal. Keep at least one goal section." }, 400);
          try {
            const commit = await putFile(gh, sha, content, message);
            await boardCall(stub, url.origin, "/manager/event", { actor: who, kind: "goals.edit", text: `GOALS.md edited from the board: ${message} → ${commit.commitUrl}` });
            return json({ ok: true, commitSha: commit.commitSha, commitUrl: commit.commitUrl });
          } catch (err) {
            return json({ error: String((err as Error)?.message ?? err) }, 409);
          }
        }
        if (parts[1] === "wake" && method === "POST") {
          const r = await wakeManager(env, stub, url.origin, who, text(body.reason, 200) || "button on the board");
          return json({ ok: r.ok, message: r.message, session_url: r.sessionUrl }, r.status === 200 ? 200 : r.status);
        }
        return json({ error: "not found" }, 404);
      }
      // ---- wake from the CLI (scripts/board.sh wake) ----
      if (parts[0] === "manager" && parts[1] === "wake" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { reason?: unknown; who?: unknown };
        const r = await wakeManager(env, stub, url.origin, String(body.who ?? "cli").slice(0, 40), String(body.reason ?? "").slice(0, 200) || "scripts/board.sh wake");
        return json({ ok: r.ok, message: r.message, session_url: r.sessionUrl }, r.status === 200 ? 200 : r.status);
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
