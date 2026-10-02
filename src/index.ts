import { Board } from "./board";
import { getFile, getRawFile, putFile } from "./github";
import { ideaRows } from "./ideas";
import { renderAgents, renderApprovePage, renderDocPage, renderGoalsPage, renderNotFound, renderProjectPage, renderStatusPage, renderTaskLive, renderTaskPage, renderUnavailable, renderWakeResult } from "./pages";
import type { BoardStatus, DocRow, Env, LiveStatus, Project, Role } from "./types";
import { bearerOk, html, json, timingSafeEqual } from "./util";

export { Board };

const githubConfig = (env: Env) => ({ token: env.GITHUB_TOKEN ?? "", repo: env.GITHUB_REPO ?? "yukewF2023/yuke-persistent-agent-flow", branch: env.GITHUB_BRANCH ?? "main", path: "GOALS.md" });
/** GET /goals is public; cache the GitHub read for 30 s per isolate so a page refresh does not spend PAT rate limit. */
let goalsCache: { at: number; sha: string | null; text: string } | null = null;

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
      const publicGet = method === "GET" && (parts.length === 0 || ["api", "tasks", "live", "goals", "docs", "projects"].includes(parts[0]));
      const publicPost = method === "POST" && parts.length === 1 && ["goals", "wake", "projects"].includes(parts[0]);
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
        if (r.error) return html(`<div class="empty">live view unavailable: ${r.error}</div>`, 503);
        return html(renderAgents(r.body as LiveStatus, Date.now(), url.searchParams.get("open") === "1"));
      }
      if (role === "public" && parts[0] === "live" && parts[1] === "tasks" && parts[2]) {
        const r = await internal(`/api/tasks/${encodeURIComponent(parts[2])}/progress`);
        if (r.error) return html(`<span class="muted">live view unavailable: ${r.error}</span>`, r.status === 404 ? 404 : 503);
        return html(renderTaskLive(r.body as Parameters<typeof renderTaskLive>[0], Date.now()));
      }
      // briefs the manager maintains: /docs/<id> renders it, /docs/<id>.md is the raw markdown
      if (role === "public" && parts[0] === "docs" && parts[1]) {
        const raw = parts[1].endsWith(".md");
        const id = raw ? parts[1].slice(0, -3) : parts[1];
        const r = await internal(`/api/docs/${encodeURIComponent(id)}`);
        if (r.status === 404) return html(renderNotFound(), 404);
        if (r.error) return html(renderUnavailable(r.error), 503);
        const doc = r.body as DocRow;
        if (raw) return new Response(doc.body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
        const idx = await internal("/api/docs");
        const projects = ideaRows(doc.body).length ? await internal("/api/projects") : null;
        return html(renderDocPage(doc, Date.now(), Array.isArray(idx.body) ? (idx.body as { id: string; title: string }[]) : [], Array.isArray(projects?.body) ? (projects.body as Project[]).filter((p) => p.doc_id === doc.id) : []));
      }
      // ---- projects: approve an idea from an idea bank, follow what the builder makes of it, record the result ----
      if (role === "public" && parts[0] === "projects") {
        const builderReady = Boolean(env.BUILDER_FIRE_URL && env.BUILDER_FIRE_TOKEN);
        const tokenOk = (token: string) => Boolean(token && env.ORCHESTRATOR_TOKEN && timingSafeEqual(token, env.ORCHESTRATOR_TOKEN));
        /** The bank and the row an approve link or form points at: by position, or by its idea text when the bank was rewritten in between. */
        const loadIdea = async (docId: string, ref: string, idea: string) => {
          const r = await internal(`/api/docs/${encodeURIComponent(docId)}`);
          if (r.error) return { doc: null, row: null, status: r.status, error: r.error };
          const doc = r.body as DocRow;
          const rows = ideaRows(doc.body);
          return { doc, row: rows.find((x) => x.ref === ref && (!idea || x.idea === idea)) ?? (idea ? rows.find((x) => x.idea === idea) : undefined) ?? null, status: 200, error: null };
        };
        const projectPage = async (id: number, extra: { flash?: string | null; error?: string | null }, status = 200) => {
          const r = await internal(`/api/projects/${id}`);
          if (r.status === 404) return html(renderNotFound(), 404);
          if (r.error) return html(renderUnavailable(r.error), 503);
          const idx = await internal("/api/docs");
          const p = r.body as Project;
          const bank = Array.isArray(idx.body) ? (idx.body as { id: string; title: string }[]).find((d) => d.id === p.doc_id) : undefined;
          return html(renderProjectPage(p, Date.now(), { builderReady, bankTitle: bank?.title ?? p.doc_id, ...extra }), status);
        };
        if (method === "GET" && parts.length === 1) return new Response(null, { status: 302, headers: { location: "/#projects" } });
        if (method === "GET" && parts[1] === "new") {
          const version = Number(url.searchParams.get("v") ?? 0);
          const v = await loadIdea(url.searchParams.get("doc") ?? "", url.searchParams.get("row") ?? "", "");
          if (!v.doc) return v.status === 404 ? html(renderNotFound(), 404) : html(renderUnavailable(v.error ?? "unavailable"), 503);
          const stale = !v.row || version !== v.doc.version;
          return html(renderApprovePage({ doc: v.doc, row: stale ? null : v.row, builderReady }), stale ? 409 : 200);
        }
        if (method === "GET") return projectPage(Number(parts[1]), { flash: url.searchParams.get("flash") });

        const form = await request.formData();
        const field = (name: string, max = 4000) => String(form.get(name) ?? "").slice(0, max);
        const action = field("action", 20) || "approve";
        if (action === "approve") {
          const notes = field("notes", 2000).replace(/\r\n?/g, "\n");
          const v = await loadIdea(field("doc", 40), field("row", 12), field("idea"));
          if (!v.doc) return v.status === 404 ? html(renderNotFound(), 404) : html(renderUnavailable(v.error ?? "unavailable"), 503);
          const again = (error: string, status: number) => html(renderApprovePage({ doc: v.doc!, row: v.row, builderReady, notes, error }), status);
          if (!v.row) return again("", 409);
          if (!tokenOk(field("token", 200))) return again("That is not the board token.", 401);
          const r = await boardCall(stub, url.origin, "/manager/projects", { doc_id: v.doc.id, version: v.doc.version, row: v.row.ref, idea: v.row.idea, notes, actor: "human" });
          if (r.status === 409 && r.body.error === "duplicate") return new Response(null, { status: 303, headers: { location: `/projects/${Number(r.body.id)}?flash=already` } });
          if (r.status === 409) return html(renderApprovePage({ doc: v.doc, row: null, builderReady }), 409);
          const id = Number((r.body.project as { id?: number } | undefined)?.id ?? 0);
          if (!r.ok || !id) return again(String(r.body.error ?? `the board answered HTTP ${r.status}`), r.ok ? 500 : r.status);
          await startBuilder(env, stub, url.origin, id);
          return new Response(null, { status: 303, headers: { location: `/projects/${id}?flash=approved` } });
        }
        const id = Number(field("id", 12));
        const cur = await internal(`/api/projects/${id}`);
        if (cur.status === 404) return html(renderNotFound(), 404);
        if (cur.error) return html(renderUnavailable(cur.error), 503);
        const project = cur.body as Project;
        if (!tokenOk(field("token", 200))) return projectPage(id, { error: "That is not the board token." }, 401);
        const patch = (body: Record<string, unknown>) => boardCall(stub, url.origin, `/manager/projects/${id}`, { actor: "human", ...body }, "PATCH");
        const done = (flash: string) => new Response(null, { status: 303, headers: { location: `/projects/${id}?flash=${flash}` } });
        if (action === "rebuild" && ["approved", "building", "failed"].includes(project.status)) {
          await patch({ status: "approved", note: "build requested from the board" });
          await startBuilder(env, stub, url.origin, id);
          return done("rebuild");
        }
        if (action === "merged" && project.status === "ready") {
          await patch({ status: "active", note: "merged; running in Cowork" });
          return done("merged");
        }
        if (action === "result" && !["done", "dropped"].includes(project.status)) {
          const outcome = field("outcome", 10) === "dropped" ? "dropped" : "done";
          const result = field("result", 300).trim();
          if (result.length < 3) return projectPage(id, { error: "Write one line saying what happened, so the idea bank can record it." }, 400);
          await patch({ status: outcome, result });
          return done("result");
        }
        return projectPage(id, { error: "That action does not fit the project's current state. Reload the page." }, 409);
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
