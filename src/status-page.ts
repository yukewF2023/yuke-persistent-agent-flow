import type { AgentStatus, LogRow } from "./types";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const ago = (ts: number | null, now: number) => {
  if (!ts) return "—";
  const d = Math.round((now - ts) / 1000);
  const abs = Math.abs(d);
  const s = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : abs < 172800 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
};
const when = (ts: number | null) => (ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—");

export function renderStatusPage(agents: AgentStatus[], teamLog: LogRow[], lastOrchestratorRun: number | null, now: number): string {
  const cards = agents
    .map((a) => {
      const notes = a.recentNotes.slice(0, 12);
      const runs = a.recentRuns.slice(0, 6);
      const extra = a.extra as Record<string, unknown>;
      let extraHtml = "";
      if (a.id === "uptime" && Array.isArray(extra.targets)) {
        extraHtml = `<div class="targets">${(extra.targets as Array<{ url: string; ok: boolean; status: number | null; latency_ms: number | null }>)
          .map((t) => `<span class="pill ${t.ok ? "ok" : "bad"}" title="${esc(t.url)}">${esc(new URL(t.url).host)} · ${t.status ?? "?"} · ${t.latency_ms ?? "?"}ms</span>`)
          .join("")}</div>`;
      }
      if (a.id === "scout" && extra.candidates) {
        const c = extra.candidates as Record<string, number>;
        const tv = extra.tavily as { usedToday: number; dailyCap: number } | undefined;
        extraHtml = `<div class="kv"><span>candidates: new ${c.new ?? 0} · recommended ${c.recommended ?? 0} · expired ${c.expired ?? 0}</span><span>searches today ${tv?.usedToday ?? 0}/${tv?.dailyCap ?? "?"}</span><span>profile v${esc(extra.profileVersion)}</span><span>next delivery ${when((extra.nextDeliveryAt as number) ?? null)}</span></div>`;
      }
      return `<section class="card">
  <header><h2>${esc(a.name)} <small>${esc(a.id)}</small></h2><span class="state ${a.paused ? "paused" : "live"}">${a.paused ? "paused" : "running"}</span></header>
  <div class="kv">
    <span>ticks: <b>${a.runCount}</b></span>
    <span>last tick: <b>${ago(a.lastTickAt, now)}</b></span>
    <span>next tick: <b>${a.nextTickAt ? ago(a.nextTickAt, now) : a.paused ? "—" : "(scheduling…)"}</b></span>
    <span>tokens today: <b>${a.budgetToday.tokens.toLocaleString()}</b> / ${a.budgetToday.limit.toLocaleString()}</span>
    <span>queue open: <b>${a.queueOpen}</b></span>
    <span>charter v${a.charterVersion}</span>
  </div>
  ${a.lastSummary ? `<p class="summary">${esc(a.lastSummary)}</p>` : ""}
  ${a.lastError ? `<p class="err">${esc(a.lastError)}</p>` : ""}
  ${extraHtml}
  <h3>Recent runs</h3>
  <table><tr><th>#</th><th>when</th><th>status</th><th>steps</th><th>tokens</th><th>next</th><th>summary</th></tr>
  ${runs.map((r) => `<tr><td>${r.id}</td><td>${ago(r.started_at, now)}</td><td class="${r.status}">${r.status}</td><td>${r.steps}</td><td>${r.input_tokens + r.output_tokens}</td><td>${r.next_wake_s ?? "—"}s</td><td>${esc(r.summary ?? "")}</td></tr>`).join("")}
  </table>
  <h3>Recent notes</h3>
  <ul class="notes">${notes.map((n) => `<li><span class="kind ${n.kind}">${n.kind}</span> <time>${when(n.ts)}</time> ${esc(n.title)}${n.body && n.kind === "recommendation" ? `<pre>${esc(n.body)}</pre>` : ""}</li>`).join("") || "<li>(nothing yet)</li>"}</ul>
</section>`;
    })
    .join("\n");

  const logHtml = teamLog
    .slice(0, 15)
    .map((l) => `<li><time>${when(l.ts)}</time> <b>${esc(l.actor)}</b> ${esc(l.action)}${l.target ? ` → ${esc(l.target)}` : ""}${l.detail ? ` <span class="muted">${esc(l.detail.slice(0, 120))}</span>` : ""}</li>`)
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>Persistent agents · status</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8ee;--muted:#8b93a7;--ok:#2ecc71;--bad:#ff5c5c;--warn:#ffb347;--accent:#7aa2f7;--border:#262a36}
@media(prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--fg:#1c1f2a;--muted:#5f677a;--border:#e2e5ee}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px 16px 60px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:17px;margin:0}h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px}small{color:var(--muted);font-weight:400}
.top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:16px}.muted{color:var(--muted)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}
.card header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.state{font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid var(--border)}.state.live{color:var(--ok);border-color:var(--ok)}.state.paused{color:var(--warn);border-color:var(--warn)}
.kv{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--muted);margin:10px 0}.kv b{color:var(--fg)}
.summary{margin:6px 0;font-size:14px}.err{color:var(--bad);font-size:13px;white-space:pre-wrap}
.targets{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}.pill.ok{border-color:var(--ok);color:var(--ok)}.pill.bad{border-color:var(--bad);color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;color:var(--muted);font-weight:500}td,th{padding:3px 6px 3px 0;border-bottom:1px solid var(--border);vertical-align:top}td.ok{color:var(--ok)}td.error{color:var(--bad)}td.budget,td.paused,td.skipped{color:var(--warn)}
ul{list-style:none;padding:0;margin:0}.notes li{padding:4px 0;border-bottom:1px solid var(--border);font-size:13.5px}time{color:var(--muted);font-size:12px;margin-right:4px}
.kind{font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--border);color:var(--muted);text-transform:uppercase}.kind.change{color:var(--warn);border-color:var(--warn)}.kind.recommendation{color:var(--accent);border-color:var(--accent)}.kind.error{color:var(--bad);border-color:var(--bad)}
pre{white-space:pre-wrap;font:13px/1.45 ui-monospace,Menlo,monospace;background:var(--bg);padding:10px;border-radius:8px;margin:6px 0 0}
a{color:var(--accent)}footer{margin-top:24px;color:var(--muted);font-size:12.5px}
</style></head><body>
<div class="top"><div><h1>Persistent agents</h1><span class="muted">Two self-scheduling agents on Cloudflare Durable Objects · DeepSeek V4.1 Flash via OpenCode Go · managed by a Claude orchestrator</span></div><span class="muted">rendered ${when(now)} · auto-refresh 60s · <a href="/api/status">JSON</a></span></div>
<div class="grid">${cards}
<section class="card"><header><h2>Orchestrator <small>Claude Code routine · every 6 h</small></h2><span class="state ${lastOrchestratorRun && now - lastOrchestratorRun < 8 * 3600_000 ? "live" : "paused"}">${lastOrchestratorRun ? `last run ${ago(lastOrchestratorRun, now)}` : "no run yet"}</span></header>
<h3>Team log</h3><ul class="notes">${logHtml || "<li>(empty)</li>"}</ul></section>
</div>
<footer>How "persistent" works: each agent is a Durable Object with its own SQLite memory and exactly one pending alarm that it sets itself at the end of every tick. Nothing polls it; nothing keeps it hot. The orchestrator reads this same data over an authenticated API, tunes charters and queues, and escalates only what needs a human.</footer>
</body></html>`;
}
