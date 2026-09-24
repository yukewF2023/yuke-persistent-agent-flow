import type { BoardStatus, DeliverableRow, LiveStatus, ProgressEvent, ProgressSnapshot, ReviewRow, TaskRow } from "./types";
import { ago, dur, esc, usd, when } from "./util";

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8ee;--muted:#8b93a7;--ok:#2ecc71;--bad:#ff5c5c;--warn:#ffb347;--accent:#7aa2f7;--border:#262a36}
@media(prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--fg:#1c1f2a;--muted:#5f677a;--border:#e2e5ee}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px 16px 60px;max-width:1180px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}h3{font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px}small{color:var(--muted);font-weight:400}
.top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:16px}.muted{color:var(--muted)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;min-width:0}
.pill{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.accent{color:var(--accent);border-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;color:var(--muted);font-weight:500}td,th{padding:4px 8px 4px 0;border-bottom:1px solid var(--border);vertical-align:top}
ul{list-style:none;padding:0;margin:0}li{padding:4px 0;border-bottom:1px solid var(--border);font-size:13px}time{color:var(--muted);font-size:12px;margin-right:6px}
.kind{font-size:10.5px;padding:1px 6px;border-radius:4px;border:1px solid var(--border);color:var(--muted);text-transform:uppercase;margin-right:4px}
.bar{display:grid;grid-template-columns:52px 1fr 118px;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin:4px 0}.bar b{color:var(--fg);font-weight:500;text-align:right;white-space:nowrap}
.track{height:7px;background:var(--border);border-radius:99px;overflow:hidden}.fill{height:100%;background:var(--accent);border-radius:99px}.fill.hot{background:var(--warn)}
pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.45 ui-monospace,Menlo,monospace;background:var(--bg);padding:10px;border-radius:8px;margin:6px 0 0;max-height:70vh;overflow:auto}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}footer{margin-top:24px;color:var(--muted);font-size:12.5px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:6px;animation:pulse 1.6s infinite}.dot.idle{background:var(--muted);animation:none}.dot.off{background:var(--bad);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(46,204,113,.5)}70%{box-shadow:0 0 0 8px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}
details{margin:6px 0}summary{cursor:pointer;font-size:13px}.kv{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--muted);margin:6px 0}.kv b{color:var(--fg)}
nav.tabs{display:flex;gap:2px;flex-wrap:wrap;margin:0 0 16px;border-bottom:1px solid var(--border)}nav.tabs a{padding:7px 12px;color:var(--muted);font-size:13.5px;border-bottom:2px solid transparent;margin-bottom:-1px}nav.tabs a:hover{color:var(--fg);text-decoration:none}nav.tabs a.active{color:var(--fg);border-bottom-color:var(--accent)}nav.tabs a small{margin-left:4px}
.tab{margin-bottom:18px}.tabtitle{font-size:18px;margin:22px 0 10px;padding-top:12px;border-top:1px solid var(--border)}body.js .tab{display:none}body.js .tab.active{display:block}body.js .tabtitle{display:none}
.cols{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}.col h2 small{margin-left:4px}
.filters{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12.5px;margin:0 0 10px;align-items:center}.filters label{cursor:pointer;color:var(--muted)}.filters input[type=search]{font:inherit;font-size:12.5px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);min-width:180px}
.days td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}.more{color:var(--muted);font-size:12px;padding:4px 0}
.live{font-size:12.5px;margin-top:3px}.feed{margin-top:4px}.feed li{font:12px/1.45 ui-monospace,Menlo,monospace;padding:2px 0;border-bottom:1px dotted var(--border)}.feed time{min-width:62px;display:inline-block}.feed q{quotes:none;color:var(--muted)}
`;

/**
 * Status page script: tabs keyed by the URL hash (every section is server-rendered, so the page reads top to bottom without JS),
 * the workers list of the visible tab swapped for a fresh fragment every 20 s, and the log's kind/text filters.
 */
const STATUS_JS = `(function(){var b=document.body;b.className+=' js';
var tabs=[].slice.call(document.querySelectorAll('.tab')),links=[].slice.call(document.querySelectorAll('nav.tabs a'));
function show(){var h=(location.hash||'#overview').slice(1);if(!document.getElementById(h))h='overview';tabs.forEach(function(t){t.classList.toggle('active',t.id===h)});links.forEach(function(a){a.classList.toggle('active',a.getAttribute('href')==='#'+h)})}
window.addEventListener('hashchange',show);show();
var lists=[{el:document.getElementById('workers-live'),url:'/live/workers'},{el:document.getElementById('workers-live-full'),url:'/live/workers?open=1'}];
function tick(){if(document.hidden||!window.fetch)return;lists.forEach(function(l){if(!l.el)return;var t=l.el.closest('.tab');if(t&&!t.classList.contains('active'))return;fetch(l.url,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(h)l.el.innerHTML=h}).catch(function(){})})}
setInterval(tick,20000);
var log=document.getElementById('log-list');if(log){var kinds=[].slice.call(document.querySelectorAll('#log-filters input[data-kind]')),q=document.getElementById('log-q');
function apply(){var on={};kinds.forEach(function(c){on[c.getAttribute('data-kind')]=c.checked});var text=(q&&q.value||'').toLowerCase();var n=0;[].forEach.call(log.children,function(li){var ok=on[li.getAttribute('data-kind')]!==false&&(!text||li.textContent.toLowerCase().indexOf(text)>=0);li.style.display=ok?'':'none';if(ok)n++});var c=document.getElementById('log-count');if(c)c.textContent=n+' shown'}
kinds.forEach(function(c){c.addEventListener('change',apply)});if(q)q.addEventListener('input',apply);var all=document.getElementById('log-all'),none=document.getElementById('log-none');if(all)all.addEventListener('click',function(e){e.preventDefault();kinds.forEach(function(c){c.checked=true});apply()});if(none)none.addEventListener('click',function(e){e.preventDefault();kinds.forEach(function(c){c.checked=false});apply()})}
})();`;
/** Poll the task's live fragment every 15 s; when the task leaves claimed/running, reload once to show the deliverable and reviews. */
const LIVE_TASK_JS = `(function(){var el=document.getElementById('task-live');if(!el||!window.fetch)return;var id=el.getAttribute('data-task');var iv=setInterval(function(){if(document.hidden)return;fetch('/live/tasks/'+id,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(!h)return;el.innerHTML=h;var st=el.querySelector('[data-status]');if(st&&['claimed','running'].indexOf(st.getAttribute('data-status'))<0){clearInterval(iv);setTimeout(function(){location.reload()},1500)}}).catch(function(){})},15000)})();`;

/**
 * Page shell. The periodic refresh is a meta refresh only when scripts are off (inside <noscript>); with scripts on, the page's
 * script reloads itself instead, which keeps the URL hash (the active tab) and the scroll position.
 */
const shell = (title: string, body: string, refreshS: number | null) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshS ? `<noscript><meta http-equiv="refresh" content="${refreshS}"></noscript>` : ""}<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}${refreshS ? `<script>setTimeout(function(){location.reload()},${refreshS * 1000})</script>` : ""}</body></html>`;

const statusPill = (s: string) => {
  const cls = s === "accepted" ? "ok" : s === "blocked" || s === "rejected" ? "bad" : s === "review" ? "warn" : s === "running" || s === "claimed" ? "accent" : "";
  return `<span class="pill ${cls}">${esc(s)}</span>`;
};
/** Elapsed seconds of a snapshot as of now: the worker's clock plus, while the task is still in progress, the time since it posted. */
const liveElapsed = (p: ProgressSnapshot, now: number, active: boolean) => p.elapsed_s + (active && p.phase === "running" ? Math.max(0, (now - p.updated_at) / 1000) : 0);

/** One line: "step 12 · bash: npx vitest run · 3m20s · $0.004 · 21k tokens", plus a stale marker when the worker stopped posting. */
const liveLine = (p: ProgressSnapshot, now: number, active: boolean) => {
  const last = p.events.length ? p.events[p.events.length - 1] : null;
  const lastTool = p.events.slice().reverse().find((e) => e.k === "tool");
  const toolLabel = (e: ProgressEvent) => `${e.tool ?? "tool"}${e.title ? `: ${e.title}` : ""}${e.status && e.status !== "completed" ? ` (${e.status})` : ""}`;
  const doing =
    p.phase !== "running"
      ? p.phase
      : !active
        ? "stopped"
        : last?.k === "tool"
        ? toolLabel(last)
        : last?.k === "text" && last.text
          ? `“${last.text}”`
          : last?.k === "error"
            ? `error: ${last.text ?? ""}`
            : lastTool
              ? `thinking · after ${toolLabel(lastTool)}`
              : p.last_tool
                ? `thinking · after ${p.last_tool}`
                : "thinking";
  const stale = active && p.phase === "running" && now - p.updated_at > 3 * 60_000;
  return `<span class="muted">step</span> ${p.step} · ${esc(doing.slice(0, 110))} · ${dur(liveElapsed(p, now, active))} · ${usd(p.cost_usd, 3)} · ${Math.round((p.tokens_in + p.tokens_out) / 1000)}k tokens${stale ? ` <span class="pill warn" title="last progress post ${ago(p.updated_at, now)}">stale</span>` : ""}`;
};

/** The snapshot's event feed, newest first. */
const liveFeed = (p: ProgressSnapshot) =>
  p.events.length
    ? `<ul class="feed">${p.events
        .slice()
        .reverse()
        .map((e) => {
          const body =
            e.k === "tool"
              ? `<b>${esc(e.tool ?? "tool")}</b> ${esc(e.title ?? "")}${e.status && e.status !== "completed" ? ` <span class="pill bad">${esc(e.status)}</span>` : ""}`
              : e.k === "step"
                ? `<span class="muted">step ${e.n} finished</span>`
                : e.k === "error"
                  ? `<span class="pill bad">error</span> ${esc(e.text ?? "")}`
                  : `<q>${esc(e.text ?? "")}</q>`;
          return `<li><time>+${dur(e.t)}</time>${body}</li>`;
        })
        .join("")}</ul>`
    : `<span class="muted">no events yet</span>`;

/**
 * The workers list with each worker's live line and event feed. Rendered into the status page and served alone at
 * /live/workers (the page's script swaps it in every 20 s while the tab is visible).
 */
export function renderWorkersLive(s: Pick<LiveStatus, "workers" | "running" | "progress">, now: number, open = false): string {
  if (!s.workers.length) return `<li class="muted">no worker has checked in yet</li>`;
  return s.workers
    .map((w) => {
      const offline = now - w.last_seen > 15 * 60_000;
      const state = offline ? "off" : w.task_id ? "" : "idle";
      const task = w.task_id ? s.running.find((r) => r.id === w.task_id) : undefined;
      const p = w.task_id ? s.progress[String(w.task_id)] : undefined;
      const label = offline
        ? `offline · last seen ${ago(w.last_seen, now)}`
        : w.task_id
          ? `working on <a href="/tasks/${w.task_id}">${esc(w.task_key ?? `#${w.task_id}`)}</a>${task ? ` · attempt ${task.attempt} · claimed ${ago(task.claimed_at, now)}` : ""}`
          : esc(w.note ?? "idle");
      let live = "";
      if (!offline && w.task_id) {
        live =
          p && (!task || p.attempt === task.attempt)
            ? `<div class="live">${liveLine(p, now, true)}${p.session_url ? ` · <a href="${esc(p.session_url)}" rel="noopener">transcript ↗</a>` : ""}</div><details${open ? " open" : ""}><summary>last ${p.events.length} events</summary>${liveFeed(p)}</details>`
            : `<div class="live muted">${esc(w.note ?? "")} · no live snapshot yet</div>`;
      }
      return `<li><span class="dot ${state}"></span><b>${esc(w.id)}</b> <span class="muted">${esc(w.host ?? "")} · done ${w.tasks_done} · failed ${w.tasks_failed}</span><br><span class="muted">${label}</span>${live}</li>`;
    })
    .join("");
}

/** The live section of a task page; served alone at /live/tasks/:id for the page's 15-second poll. */
export function renderTaskLive(d: { task: Pick<TaskRow, "id" | "key" | "status" | "worker_id" | "attempt" | "claimed_at" | "lease_until">; progress: ProgressSnapshot | null }, now: number): string {
  const t = d.task;
  const p = d.progress;
  const active = t.status === "claimed" || t.status === "running";
  const head = active ? `<span class="dot"></span>${esc(t.worker_id ?? "?")} · ${esc(t.status)} · attempt ${t.attempt} · claimed ${ago(t.claimed_at, now)} · lease ends ${ago(t.lease_until, now)}` : p ? `attempt ${p.attempt} · ${esc(p.worker_id)} · ${esc(p.phase === "running" ? "stopped" : p.phase)} · ${dur(p.elapsed_s)}` : "";
  if (!p) return `<div data-status="${esc(t.status)}"><span class="muted">${head}${active ? " · waiting for the worker's first progress post" : "no session snapshot"}</span></div>`;
  const stats = `<div class="kv"><span>step <b>${p.step}</b></span><span>tool calls <b>${p.tools}</b></span><span>elapsed <b>${dur(liveElapsed(p, now, active))}</b></span><span>tokens <b>${p.tokens_in + p.tokens_out}</b> (${p.tokens_cached} cached)</span><span>cost so far <b>${usd(p.cost_usd, 3)}</b></span><span>posted <b>${ago(p.updated_at, now)}</b></span>${p.session_url ? `<span><a href="${esc(p.session_url)}" rel="noopener">worker session transcript ↗</a></span>` : p.session_id ? `<span>session <b>${esc(p.session_id)}</b></span>` : ""}</div>`;
  return `<div data-status="${esc(t.status)}"><div class="muted">${head}</div>${stats}<div class="live">${liveLine(p, now, active)}</div><h3>Last ${p.events.length} events</h3>${liveFeed(p)}</div>`;
}

const bar = (label: string, v: number, cap: number) => `<div class="bar"><span>${esc(label)}</span><div class="track"><div class="fill ${v / cap > 0.8 ? "hot" : ""}" style="width:${Math.min(100, (100 * v) / cap).toFixed(1)}%"></div></div><b>${usd(v)} / ${usd(cap, 0)}</b></div>`;

export function renderStatusPage(s: BoardStatus, now: number): string {
  const c = (k: string) => s.counts[k] ?? 0;
  const inProgress = c("claimed") + c("running");
  const sp = s.spend;
  const cf = s.cloudflare;
  const goalsTable = s.goals.length
    ? s.goals
        .map((g) => {
          const gc = (k: string) => g.counts[k] ?? 0;
          return `<tr><td><b>${esc(g.id)}</b> ${esc(g.title)} ${statusPill(g.status)}</td><td>${gc("ready")}</td><td>${gc("claimed") + gc("running")}</td><td>${gc("review")}</td><td>${gc("accepted")}</td><td>${gc("blocked")}</td><td>${gc("rejected") + gc("cancelled")}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">no goals yet — the manager syncs GOALS.md on its next run</td></tr>`;
  const list = (rows: { id: number; key: string; title: string }[], extra: (r: any) => string, empty: string) =>
    rows.length ? rows.map((r) => `<li><a href="/tasks/${r.id}">${esc(r.key)}</a> <span class="muted">${esc(r.title)}</span><br><span class="muted">${extra(r)}</span></li>`).join("") : `<li class="muted">${empty}</li>`;
  const more = (total: number, shown: number, what: string) => (total > shown ? `<div class="more">and ${total - shown} more ${what} (<a href="/api/tasks?status=${encodeURIComponent(what)}&limit=100">JSON</a>)</div>` : "");
  const eventLi = (e: BoardStatus["events"][number]) => `<li data-kind="${esc(e.kind)}"><time>${when(e.ts)}</time><span class="kind">${esc(e.kind)}</span>${e.task_id ? `<a href="/tasks/${e.task_id}">#${e.task_id}</a> ` : ""}${esc(e.text)} <span class="muted">· ${esc(e.actor)}</span></li>`;
  const kinds = Array.from(new Set(s.events.map((e) => e.kind))).sort();
  const needs = s.needsHuman.length ? `<ul>${s.needsHuman.map((n) => `<li><time>${when(n.ts)}</time>${esc(n.text)}</li>`).join("")}</ul>` : `<span class="muted">nothing — the manager has not asked for a human</span>`;
  const cfBar = (label: string, v: number, cap: number, capLabel: string) =>
    `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${v / cap > 0.8 ? "hot" : ""}" style="width:${Math.min(100, (100 * v) / cap).toFixed(1)}%"></div></div><b>${v.toLocaleString()} / ${capLabel}</b></div>`;
  const pacingLine = sp.pacing ? `<span class="pill warn">pacing</span> <span class="muted">${esc(sp.pacing.reason)}</span>` : `<span class="pill ok">within pace</span>`;
  const managerLine = `<div class="kv"><span>last run <b>${s.manager.lastRunAt ? ago(s.manager.lastRunAt, now) : "never"}</b></span><span>${s.manager.lockedUntil ? `<span class="pill accent">running now</span>` : `<span class="muted">next at :13 or :43</span>`}</span></div>`;
  const nav = `<nav class="tabs"><a href="#overview">Overview</a><a href="#board">Board<small>${c("ready")} · ${inProgress} · ${c("review")}</small></a><a href="#workers">Workers<small>${s.workers.length}</small></a><a href="#goals">Goals<small>${s.goals.length}</small></a><a href="#log">Log</a><a href="#spend">Spend<small>${usd(sp.todayUsd)}</small></a></nav>`;

  const overview = `<section class="tab" id="overview"><h2 class="tabtitle">Overview</h2>
<div class="grid">
  <section class="card"><h2>Workers <small>live · <a href="#workers">details</a></small></h2><ul id="workers-live">${renderWorkersLive(s, now)}</ul></section>
  <section class="card"><h2>Spend <small>OpenCode Go · <a href="#spend">details</a></small></h2>
    ${bar("today", sp.todayUsd, sp.paceUsdPerDay)}${bar("week", sp.weekUsd, 30)}${bar("month", sp.monthUsd, 60)}
    <div class="kv"><span>tasks today <b>${sp.todayTasks}</b></span><span>in flight est. <b>${usd(sp.inflightEstimateUsd)}</b></span><span>daily pace <b>${usd(sp.paceUsdPerDay)}</b></span></div>
    ${pacingLine}
    <h3>Cloudflare free tier today</h3>
    ${cfBar("reads", cf.reads, cf.readLimit, `${(cf.readLimit / 1e6).toFixed(0)}M`)}${cfBar("writes", cf.writes, cf.writeLimit, `${(cf.writeLimit / 1e3).toFixed(0)}k`)}
  </section>
  <section class="card"><h2>Manager <small>Claude routine</small></h2>${managerLine}<h3>Needs a human</h3>${needs}</section>
</div>
<section class="card"><h2>Goals <small><a href="#goals">bodies</a></small></h2><table><tr><th>goal</th><th>ready</th><th>in progress</th><th>review</th><th>accepted</th><th>blocked</th><th title="cancelled + rejected: retired without ever being accepted; never retried">dropped</th></tr>${goalsTable}</table>
<div class="kv"><span>all tasks: ready <b>${c("ready")}</b></span><span>in progress <b>${inProgress}</b></span><span>review <b>${c("review")}</b></span><span>accepted <b>${c("accepted")}</b></span><span>blocked <b>${c("blocked")}</b></span><span><a href="#board">open the board →</a></span></div></section>
<section class="card" style="margin-top:14px"><h2>Where to look</h2><ul>
<li><b>This page</b> — refreshes every 60 s. <a href="#board">Board</a>: every task by column. <a href="#workers">Workers</a>: what each worker is doing right now, step by step. <a href="#log">Log</a>: everything that happened, filterable by kind. <a href="/api/status">JSON</a>.</li>
<li><b>One task</b> — click any task: spec, acceptance checklist, live session while it runs, every review verdict, the report and the files.</li>
<li><b>Manager runs</b> — Claude routines <a href="https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1" rel="noopener">:13</a> and <a href="https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG" rel="noopener">:43</a> (owner login; every run is a full session transcript). Their verdicts appear in the log as <code>task.accept</code>, <code>task.reject</code>, <code>tasks.create</code> and <code>run</code>.</li>
<li><b>Worker transcripts</b> — the live view here shows tool calls and text excerpts; the full opencode transcript is in the web UI on the VM (SSH tunnel, see the README), or linked from the task page when session sharing is on.</li>
<li><b>Source and goals</b> — <a href="https://github.com/yukewF2023/yuke-persistent-agent-flow" rel="noopener">github.com/yukewF2023/yuke-persistent-agent-flow</a> (GOALS.md is the only human input).</li></ul></section>
</section>`;

  const board = `<section class="tab" id="board"><h2 class="tabtitle">Board</h2>
<div class="cols">
  <section class="card col"><h2>Ready <small>${c("ready")}</small></h2><ul>${list(s.ready, (r) => `${esc(r.goal_id)} · priority ${r.priority} · created ${ago(r.created_at, now)}${r.deps && r.deps !== "[]" ? ` · deps ${esc(r.deps)}` : ""}`, "nothing ready — the manager plans more on its next run")}</ul>${more(c("ready"), s.ready.length, "ready")}</section>
  <section class="card col"><h2>In progress <small>${inProgress}</small></h2><ul>${list(s.running, (r) => `${esc(r.worker_id ?? "?")} · ${esc(r.status)} · since ${ago(r.claimed_at, now)} · attempt ${r.attempt}${s.progress[String(r.id)] ? `<br>${liveLine(s.progress[String(r.id)], now, true)}` : ""}`, "nothing running")}</ul></section>
  <section class="card col"><h2>Waiting for review <small>${c("review")}</small></h2><ul>${list(s.reviewQueue, (r) => `submitted ${ago(r.submitted_at, now)} · attempt ${r.attempt}`, "queue empty")}</ul>${more(c("review"), s.reviewQueue.length, "review")}</section>
  <section class="card col"><h2>Accepted <small>${c("accepted")}</small></h2><ul>${list(s.recentAccepted, (r) => `${ago(r.finished_at, now)} · ${usd(r.cost_usd, 3)} · ${r.attempt} attempt${r.attempt === 1 ? "" : "s"}`, "nothing accepted yet")}</ul>${more(c("accepted"), s.recentAccepted.length, "accepted")}</section>
  <section class="card col"><h2>Blocked <small>${c("blocked")}</small></h2><ul>${list(s.blocked, (r) => esc(r.last_error ?? ""), "nothing blocked")}</ul>${more(c("blocked"), s.blocked.length, "blocked")}</section>
</div>
<p class="muted" style="font-size:12.5px">Columns follow the task states: ready → claimed/running → review → accepted, or blocked after the attempts run out. Dropped tasks (cancelled or rejected for good: ${c("cancelled") + c("rejected")}) are counted in the goals table only.</p>
</section>`;

  const workersTab = `<section class="tab" id="workers"><h2 class="tabtitle">Workers</h2>
<section class="card"><h2>Live <small>refreshes every 20 s while this tab is open</small></h2>
<p class="muted" style="font-size:12.5px;margin:0 0 8px">Each worker posts a snapshot of its running opencode session after every finished step (at most every 20 s): the step number, the tool call in progress, tokens and cost so far, and the last 30 events. Done and failed are attempt counters (submitted for review / ended without a submission), not quality: see the goals table for accepted work.</p>
<ul id="workers-live-full">${renderWorkersLive(s, now, true)}</ul></section>
<section class="card" style="margin-top:14px"><h2>Full transcripts</h2><ul>
<li>opencode web UI on the VM: <code>gcloud compute ssh agent-workers --zone=us-east1-b -- -N -L 4091:127.0.0.1:4091 -L 4092:127.0.0.1:4092</code>, then http://localhost:4091 (worker 1) and http://localhost:4092 (worker 2).</li>
<li>Raw logs: <code>gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo journalctl -u agent-worker@1 -u agent-worker@2 -f'</code>.</li>
<li>Public transcript links appear on task pages when <code>OPENCODE_SHARE=auto</code> is set on the VM (see worker/README.md).</li></ul></section>
</section>`;

  const goalsTab = `<section class="tab" id="goals"><h2 class="tabtitle">Goals</h2>
<p class="muted" style="font-size:12.5px;margin:0 0 10px">The goals come from <a href="https://github.com/yukewF2023/yuke-persistent-agent-flow/blob/main/GOALS.md" rel="noopener">GOALS.md</a> in the repository; the manager syncs them into the board on every run, plans tasks from each active goal's body, and pauses goals that were removed from the file.</p>
${
  s.goals.length
    ? s.goals
        .map((g) => {
          const gc = (k: string) => g.counts[k] ?? 0;
          return `<section class="card" style="margin-bottom:14px"><h2>${esc(g.id)} <small>${esc(g.title)}</small> ${statusPill(g.status)}</h2>
<div class="kv"><span>min ready <b>${g.min_ready}</b></span><span>ready <b>${gc("ready")}</b></span><span>in progress <b>${gc("claimed") + gc("running")}</b></span><span>review <b>${gc("review")}</b></span><span>accepted <b>${gc("accepted")}</b></span><span>blocked <b>${gc("blocked")}</b></span><span>dropped <b>${gc("rejected") + gc("cancelled")}</b></span><span>synced <b>${ago(g.updated_at, now)}</b></span>${g.done_when ? `<span>done when <b>${esc(g.done_when)}</b></span>` : ""}</div>
<pre>${esc(g.body.trim() || "(empty body)")}</pre></section>`;
        })
        .join("")
    : `<section class="card"><span class="muted">no goals yet — the manager syncs GOALS.md on its next run</span></section>`
}
</section>`;

  const logTab = `<section class="tab" id="log"><h2 class="tabtitle">Log</h2>
<section class="card"><h2>Log <small>last ${s.events.length} events · <span id="log-count"></span></small></h2>
<div class="filters" id="log-filters"><input type="search" id="log-q" placeholder="filter text…" aria-label="filter text">${kinds.map((k) => `<label><input type="checkbox" data-kind="${esc(k)}" checked> ${esc(k)}</label>`).join("")}<a href="#log" id="log-all">all</a><a href="#log" id="log-none">none</a></div>
<ul id="log-list">${s.events.length ? s.events.map(eventLi).join("") : "<li class=\"muted\">nothing yet</li>"}</ul>
<p class="muted" style="font-size:12px;margin:8px 0 0">Kinds: <code>task.claim</code>, <code>task.submit</code>, <code>task.fail</code> and <code>task.release</code> come from the workers; <code>task.accept</code>, <code>task.reject</code>, <code>tasks.create</code>, <code>task.patch</code>, <code>goal.paused</code>, <code>pace.set</code>, <code>needs-human</code> and <code>run</code> from the manager; <code>lease.expired</code> and <code>task.blocked</code> from the board itself. Older events: <code>scripts/board.sh events 200</code>.</p></section>
</section>`;

  const spendTab = `<section class="tab" id="spend"><h2 class="tabtitle">Spend and budgets</h2>
<div class="grid">
  <section class="card"><h2>OpenCode Go windows</h2>
    ${bar("today", sp.todayUsd, sp.paceUsdPerDay)}${bar("5 h", sp.fiveHourUsd, 12)}${bar("week", sp.weekUsd, 30)}${bar("month", sp.monthUsd, 60)}
    <div class="kv"><span>tasks today <b>${sp.todayTasks}</b></span><span>avg per task today <b>${usd(sp.todayTasks ? sp.todayUsd / sp.todayTasks : 0, 3)}</b></span><span>in flight est. <b>${usd(sp.inflightEstimateUsd)}</b></span><span>daily pace <b>${usd(sp.paceUsdPerDay)}</b></span></div>
    ${pacingLine}
    <p class="muted" style="font-size:12.5px">The board refuses new claims when today's spend plus the in-flight estimate reaches the daily pace, or when a Go window (5 h $12, week $30, month $60) is at 90 %. The manager moves the pace with <code>scripts/board.sh pace &lt;usd&gt;</code>; the workers resume on their own at 00:00 UTC. Tokens are priced at DeepSeek V4.1 Flash Go rates (peak ×2 on weekdays 01–04 and 06–10 UTC).</p>
  </section>
  <section class="card"><h2>Last 7 days <small>UTC</small></h2><table class="days"><tr><th>day</th><th>spent</th><th>tasks</th><th>avg</th></tr>${sp.days.map((d) => `<tr><td>${esc(d.day)}${d.day === s.cloudflare.day ? " <span class=\"muted\">(today)</span>" : ""}</td><td>${usd(d.usd, 3)}</td><td>${d.tasks}</td><td>${usd(d.tasks ? d.usd / d.tasks : 0, 3)}</td></tr>`).join("")}</table>
    <p class="muted" style="font-size:12.5px">A task counts here when its attempt ended (submitted or failed) that day; running totals live in the board's kv table so pacing never sums the spend log.</p>
  </section>
  <section class="card"><h2>Cloudflare free tier <small>today, resets 00:00 UTC</small></h2>
    ${cfBar("reads", cf.reads, cf.readLimit, `${(cf.readLimit / 1e6).toFixed(0)}M`)}${cfBar("writes", cf.writes, cf.writeLimit, `${(cf.writeLimit / 1e3).toFixed(0)}k`)}
    <p class="muted" style="font-size:12.5px">The board is one SQLite Durable Object on the free tier: 5M row reads and 100k row writes a day. Every query is index-bounded, the status page is cached for 60 s, the live view costs a handful of reads per poll, and progress snapshots are overwritten rather than appended. Above 4.5M reads the board stops handing out tasks so this page stays reachable.</p>
  </section>
</div>
</section>`;

  const body = `
<div class="top"><div><h1>Agent board</h1><span class="muted">Claude manager (plan · dispatch · review) · two DeepSeek V4.1 Flash workers on opencode · board on Cloudflare</span></div><span class="muted">rendered ${when(now)} · refresh 60 s · <a href="/api/status">JSON</a></span></div>
${nav}
${overview}
${board}
${workersTab}
${goalsTab}
${logTab}
${spendTab}
<footer>How it works: a human writes goals in the repo. The manager (Claude, a scheduled routine) turns them into tasks with acceptance criteria, keeps the board stocked, and reviews every deliverable by running its tests: accept, send back with notes, or split. Two workers (DeepSeek V4.1 Flash inside opencode on a small VM) pull tasks continuously, paced by the OpenCode Go allowance. Sessions are disposable; this board is the memory.</footer>
<script>${STATUS_JS}</script>`;
  return shell("Agent board", body, 60);
}

export function renderTaskPage(d: { task: TaskRow & { deps: number[] }; reviews: ReviewRow[]; deliverable: (Omit<DeliverableRow, "files"> & { files: Record<string, string> }) | null; progress?: ProgressSnapshot | null }, now: number): string {
  const t = d.task;
  const files = d.deliverable ? Object.entries(d.deliverable.files) : [];
  const active = t.status === "claimed" || t.status === "running";
  const progress = d.progress ?? null;
  const live = active || progress ? `<section class="card" style="margin-top:14px"><h2>${active ? "Live session" : `Last session <small>attempt ${progress?.attempt ?? t.attempt}</small>`}${active ? ` <small>updates every 15 s</small>` : ""}</h2><div id="task-live" data-task="${t.id}">${renderTaskLive({ task: t, progress }, now)}</div></section>` : "";
  const body = `
<div class="top"><div><h1><a href="/">← board</a> · ${esc(t.key)} ${statusPill(t.status)}</h1><span class="muted">${esc(t.title)}</span></div><span class="muted"><a href="/api/tasks/${t.id}">JSON</a></span></div>
<section class="card">
  <div class="kv"><span>goal <b>${esc(t.goal_id)}</b></span><span>kind <b>${esc(t.kind)}</b></span><span>priority <b>${t.priority}</b></span><span>attempt <b>${t.attempt}/${t.max_attempts}</b></span><span>budget <b>${t.max_minutes} min</b></span><span>worker <b>${esc(t.worker_id ?? "—")}</b></span><span>cost <b>${usd(t.cost_usd, 3)}</b></span><span>tokens <b>${t.tokens_in + t.tokens_out}</b> (${t.tokens_cached} cached)</span><span>steps <b>${t.steps}</b></span><span>updated <b>${ago(t.updated_at, now)}</b></span>${t.deps.length ? `<span>deps <b>${t.deps.map((x) => `<a href="/tasks/${x}">#${x}</a>`).join(", ")}</b></span>` : ""}</div>
  ${t.last_error ? `<p class="muted">last error: ${esc(t.last_error)}</p>` : ""}
  <h3>Spec</h3><pre>${esc(t.spec)}</pre>
  <h3>Acceptance criteria</h3><pre>${esc(t.acceptance)}</pre>
</section>
${live}
<section class="card" style="margin-top:14px"><h2>Reviews</h2><ul>${d.reviews.length ? d.reviews.map((r) => `<li><time>${when(r.created_at)}</time>${statusPill(r.verdict === "accept" ? "accepted" : "rejected")} attempt ${r.attempt} · ${esc(r.who)}${r.notes ? `<pre>${esc(r.notes)}</pre>` : ""}</li>`).join("") : "<li class=\"muted\">not reviewed yet</li>"}</ul></section>
<section class="card" style="margin-top:14px"><h2>Deliverable ${d.deliverable ? `<small>attempt ${d.deliverable.attempt} · ${d.deliverable.nfiles} files · ${Math.round(d.deliverable.bytes / 1024)} KB${d.deliverable.truncated ? " · truncated" : ""}${d.deliverable.session_url ? ` · <a href="${esc(d.deliverable.session_url)}" rel="noopener">worker session transcript ↗</a>` : d.deliverable.session_id ? ` · session ${esc(d.deliverable.session_id)}` : ""}</small>` : ""}</h2>
  ${d.deliverable ? `<h3>Report</h3><pre>${esc(d.deliverable.report)}</pre><h3>Files</h3>${files.map(([p, c]) => `<details><summary>${esc(p)} <span class="muted">(${c.length} chars)</span></summary><pre>${esc(c)}</pre></details>`).join("") || "<span class=\"muted\">no files</span>"}` : "<span class=\"muted\">nothing submitted yet</span>"}
</section>${active ? `<script>${LIVE_TASK_JS}</script>` : ""}`;
  return shell(`${t.key} · Agent board`, body, active ? 30 : null);
}

export function renderNotFound(): string {
  return shell("Not found", `<div class="top"><h1><a href="/">← board</a> · not found</h1></div>`, null);
}

export function renderUnavailable(error: string): string {
  const cap = /rows read/i.test(error);
  const body = `<div class="top"><div><h1>Agent board</h1><span class="muted">temporarily unavailable</span></div></div>
<section class="card"><h2>${cap ? "Cloudflare free-tier daily read limit reached" : "Board error"}</h2>
<p>${esc(error)}</p>
${cap ? `<p class="muted">The Durable Object's daily row-read allowance is exhausted. It resets at 00:00 UTC; the workers and the manager retry on their own and the board comes back by itself. This page refreshes every 5 minutes.</p>` : ""}</section>`;
  return shell("Agent board · unavailable", body, 300);
}
