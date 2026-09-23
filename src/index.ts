import { Board } from "./board";
import { renderNotFound, renderStatusPage, renderTaskPage, renderUnavailable } from "./pages";
import type { BoardStatus, Env, Role } from "./types";
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
    } else if (method !== "GET" || !(parts.length === 0 || parts[0] === "api" || parts[0] === "tasks")) {
      return json({ error: "not found" }, 404);
    }

    const stub = env.BOARD.get(env.BOARD.idFromName("main"));
    const internal = (path: string) => stub.fetch(new Request(url.origin + path, { headers: { "x-board-role": "public" } }));
    try {
      if (role === "public" && parts.length === 0) {
        const res = await internal("/api/status");
        if (!res.ok) {
          const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
          return html(renderUnavailable(err), 503);
        }
        return html(renderStatusPage((await res.json()) as BoardStatus, Date.now()));
      }
      if (role === "public" && parts[0] === "tasks" && parts[1]) {
        const res = await internal(`/api/tasks/${encodeURIComponent(parts[1])}`);
        if (res.status === 404) return html(renderNotFound(), 404);
        return html(renderTaskPage((await res.json()) as Parameters<typeof renderTaskPage>[0], Date.now()));
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
