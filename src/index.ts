import { Board } from "./board";
import { renderNotFound, renderStatusPage, renderTaskLive, renderTaskPage, renderUnavailable, renderWorkersLive } from "./pages";
import type { BoardStatus, Env, LiveStatus, Role } from "./types";
import { bearerOk, html, json } from "./util";

export { Board };

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
    } else if (method !== "GET" || !(parts.length === 0 || parts[0] === "api" || parts[0] === "tasks" || parts[0] === "live")) {
      return json({ error: "not found" }, 404);
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
