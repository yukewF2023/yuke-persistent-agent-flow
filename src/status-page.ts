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
      const notes = a.recentNotes.slice(0, 8);
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
      const sp = a.spend;
      const g = a.governor;
      const share = g.monthlyBudgetUsd / 60;
      const bar = (label: string, v: number, cap: number) => `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${v / cap > 0.8 ? "hot" : ""}" style="width:${Math.min(100, (100 * v) / cap).toFixed(1)}%"></div></div><b>$${v.toFixed(2)} / $${cap.toFixed(0)}</b></div>`;
      const act = a.recentActivity.slice(0, 14);
      return `<section class="card">
  <header><h2>${esc(a.name)} <small>${esc(a.id)}</small></h2><span class="state ${a.paused ? "paused" : "live"}">${a.paused ? "paused" : "working"}</span></header>
  <p class="now"><span class="dot"></span>${esc(a.workingNow ?? "starting…")} <span class="muted">· last activity ${ago(a.recentActivity[0]?.ts ?? a.lastTickAt, now)}</span></p>
  <div class="kv">
    <span>segments: <b>${a.segmentCount}</b></span>
    <span>work done today: <b>${a.workDoneToday}</b></span>
    <span>think steps today: <b>${a.thinksToday}</b></span>
    <span>open worklist: <b>${a.workOpen}</b></span>
    <span>manager queue: <b>${a.queueOpen}</b></span>
    <span>charter v${a.charterVersion}</span>
  </div>
  <div class="bars">
    ${bar("today", sp.todayUsd, g.monthlyBudgetUsd / 30)}
    ${bar("5 h", sp.fiveHourUsd, 12 * share)}
    ${bar("week", sp.weekUsd, 30 * share)}
    ${bar("month", sp.monthUsd, g.monthlyBudgetUsd)}
    <div class="muted small">pace: $${g.monthlyBudgetUsd}/month budget · think ≈ $${g.avgThinkUsd.toFixed(4)} · bucket $${g.bucketUsd.toFixed(3)}${g.waitUntil && g.waitUntil > now ? ` · pacing until ${ago(g.waitUntil, now)}` : ""} · tokens today ${sp.todayTokens.toLocaleString()}</div>
  </div>
  ${a.lastError ? `<p class="err">${esc(a.lastError)}</p>` : ""}
  ${extraHtml}
  <h3>Live activity</h3>
  <ul class="notes act">${act.map((x) => `<li><time>${when(x.ts)}</time> <span class="kind ${x.kind}">${x.kind}</span> ${esc(x.text)}${x.cost_usd ? ` <span class="muted">$${x.cost_usd.toFixed(4)}</span>` : ""}</li>`).join("") || "<li>(nothing yet)</li>"}</ul>
  <h3>Recent think steps</h3>
  <table><tr><th>#</th><th>when</th><th>item</th><th>status</th><th>steps</th><th>tokens</th><th>cost</th><th>summary</th></tr>
  ${runs.map((r) => `<tr><td>${r.id}</td><td>${ago(r.started_at, now)}</td><td>${esc((r.work_item ?? "").slice(0, 28))}</td><td class="${r.status}">${r.status}</td><td>${r.steps}</td><td>${r.input_tokens + r.output_tokens}</td><td>$${(r.cost_usd ?? 0).toFixed(4)}</td><td>${esc(r.summary ?? "")}</td></tr>`).join("")}
  </table>
  <h3>Notes</h3>
  <ul class="notes">${notes.map((n) => `<li><span class="kind ${n.kind}">${n.kind}</span> <time>${when(n.ts)}</time> ${esc(n.title)}${n.body && n.kind === "recommendation" ? `<pre>${esc(n.body)}</pre>` : ""}</li>`).join("") || "<li>(nothing yet)</li>"}</ul>
</section>`;
    })
    .join("\n");

  const logHtml = teamLog
    .slice(0, 15)
    .map((l) => `<li><time>${when(l.ts)}</time> <b>${esc(l.actor)}</b> ${esc(l.action)}${l.target ? ` → ${esc(l.target)}` : ""}${l.detail ? ` <span class="muted">${esc(l.detail.slice(0, 120))}</span>` : ""}</li>`)
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20">
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
.now{margin:8px 0 4px;font-size:14.5px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:6px;box-shadow:0 0 0 0 var(--ok);animation:pulse 1.6s infinite}@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(46,204,113,.5)}70%{box-shadow:0 0 0 8px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}
.bars{margin:8px 0 4px}.bar{display:grid;grid-template-columns:44px 1fr 96px;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin:3px 0}.bar b{color:var(--fg);font-weight:500;text-align:right}.track{height:7px;background:var(--border);border-radius:99px;overflow:hidden}.fill{height:100%;background:var(--accent);border-radius:99px}.fill.hot{background:var(--warn)}.small{font-size:11.5px}
.act li{font-size:12.5px}.kind.code{color:var(--muted)}.kind.think{color:var(--accent);border-color:var(--accent)}.kind.deliver,.kind.candidate{color:var(--ok);border-color:var(--ok)}
</style></head><body>
<div class="top"><div><h1>Persistent agents</h1><span class="muted">Two self-scheduling agents on Cloudflare Durable Objects · DeepSeek V4.1 Flash via OpenCode Go · managed by a Claude orchestrator</span></div><span class="muted">rendered ${when(now)} · auto-refresh 20s · <a href="/api/status">JSON</a></span></div>
<div class="grid">${cards}
<section class="card"><header><h2>Orchestrator <small>Claude Code routine · every 6 h</small></h2><span class="state ${lastOrchestratorRun && now - lastOrchestratorRun < 8 * 3600_000 ? "live" : "paused"}">${lastOrchestratorRun ? `last run ${ago(lastOrchestratorRun, now)}` : "no run yet"}</span></header>
<h3>Team log</h3><ul class="notes">${logHtml || "<li>(empty)</li>"}</ul></section>
</div>
<footer>How it works: each agent is a Durable Object with its own SQLite memory running a never-ending work loop — segments of work chained back to back with a one-second alarm between them. Code work (fetching, probing, reading, ranking) runs nonstop and costs nothing; model steps (DeepSeek V4.1 Flash via OpenCode Go) are paced by a spend governor so each agent tracks its monthly dollar budget. The orchestrator (Claude, every 6 h) reads this same data over an authenticated API, reviews think transcripts, tunes charters, budgets and worklists, and escalates only what needs a human.</footer>
</body></html>`;
}
