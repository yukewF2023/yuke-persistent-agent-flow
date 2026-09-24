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
.live{font-size:12.5px;margin-top:3px}.feed{margin-top:4px}.feed li{font:12px/1.45 ui-monospace,Menlo,monospace;padding:2px 0;border-bottom:1px dotted var(--border)}.feed time{min-width:62px;display:inline-block}.feed q{quotes:none;color:var(--muted)}
`;

/** Swap the workers list for a fresh fragment every 20 s while the tab is visible (the page itself still reloads every 60 s). */
const LIVE_WORKERS_JS = `(function(){var el=document.getElementById('workers-live');if(!el||!window.fetch)return;function tick(){if(document.hidden)return;fetch('/live/workers',{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(h)el.innerHTML=h}).catch(function(){})}setInterval(tick,20000)})();`;
/** Poll the task's live fragment every 15 s; when the task leaves claimed/running, reload once to show the deliverable and reviews. */
const LIVE_TASK_JS = `(function(){var el=document.getElementById('task-live');if(!el||!window.fetch)return;var id=el.getAttribute('data-task');var iv=setInterval(function(){if(document.hidden)return;fetch('/live/tasks/'+id,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(!h)return;el.innerHTML=h;var st=el.querySelector('[data-status]');if(st&&['claimed','running'].indexOf(st.getAttribute('data-status'))<0){clearInterval(iv);setTimeout(function(){location.reload()},1500)}}).catch(function(){})},15000)})();`;

const shell = (title: string, body: string, refreshS: number | null) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshS ? `<meta http-equiv="refresh" content="${refreshS}">` : ""}<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

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
  const workers = renderWorkersLive(s, now);
  const sp = s.spend;
  const goals = s.goals.length
    ? s.goals
        .map((g) => {
          const gc = (k: string) => g.counts[k] ?? 0;
          return `<tr><td><b>${esc(g.id)}</b> ${esc(g.title)} ${statusPill(g.status)}</td><td>${gc("ready")}</td><td>${gc("claimed") + gc("running")}</td><td>${gc("review")}</td><td>${gc("accepted")}</td><td>${gc("blocked")}</td><td>${gc("rejected") + gc("cancelled")}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">no goals yet — the manager syncs GOALS.md on its next run</td></tr>`;
  const list = (rows: { id: number; key: string; title: string }[], extra: (r: any) => string, empty: string) =>
    rows.length ? rows.map((r) => `<li><a href="/tasks/${r.id}">${esc(r.key)}</a> <span class="muted">${esc(r.title)}</span><br><span class="muted">${extra(r)}</span></li>`).join("") : `<li class="muted">${empty}</li>`;
  const events = s.events.length ? s.events.map((e) => `<li><time>${when(e.ts)}</time><span class="kind">${esc(e.kind)}</span>${e.task_id ? `<a href="/tasks/${e.task_id}">#${e.task_id}</a> ` : ""}${esc(e.text)} <span class="muted">· ${esc(e.actor)}</span></li>`).join("") : "<li class=\"muted\">nothing yet</li>";
  const needs = s.needsHuman.length ? `<ul>${s.needsHuman.map((n) => `<li><time>${when(n.ts)}</time>${esc(n.text)}</li>`).join("")}</ul>` : `<span class="muted">nothing — the manager has not asked for a human</span>`;
  const body = `
<div class="top"><div><h1>Agent board</h1><span class="muted">Claude manager (plan · dispatch · review) · two DeepSeek V4.1 Flash workers on opencode · board on Cloudflare</span></div><span class="muted">rendered ${when(now)} · refresh 60 s · <a href="/api/status">JSON</a></span></div>
<div class="grid">
  <section class="card"><h2>Workers <small>live</small></h2><ul id="workers-live">${workers}</ul></section>
  <section class="card"><h2>Spend <small>OpenCode Go</small></h2>
    ${bar("today", sp.todayUsd, sp.paceUsdPerDay)}${bar("5 h", sp.fiveHourUsd, 12)}${bar("week", sp.weekUsd, 30)}${bar("month", sp.monthUsd, 60)}
    <div class="kv"><span>tasks today <b>${sp.todayTasks}</b></span><span>in flight est. <b>${usd(sp.inflightEstimateUsd)}</b></span><span>daily pace <b>${usd(sp.paceUsdPerDay)}</b></span></div>
    ${sp.pacing ? `<span class="pill warn">pacing</span> <span class="muted">${esc(sp.pacing.reason)}</span>` : `<span class="pill ok">within pace</span>`}
    <h3>Cloudflare free tier today</h3>
    <div class="bar"><span>reads</span><div class="track"><div class="fill ${s.cloudflare.reads / s.cloudflare.readLimit > 0.8 ? "hot" : ""}" style="width:${Math.min(100, (100 * s.cloudflare.reads) / s.cloudflare.readLimit).toFixed(1)}%"></div></div><b>${s.cloudflare.reads.toLocaleString()} / ${(s.cloudflare.readLimit / 1e6).toFixed(0)}M</b></div>
    <div class="bar"><span>writes</span><div class="track"><div class="fill ${s.cloudflare.writes / s.cloudflare.writeLimit > 0.8 ? "hot" : ""}" style="width:${Math.min(100, (100 * s.cloudflare.writes) / s.cloudflare.writeLimit).toFixed(1)}%"></div></div><b>${s.cloudflare.writes.toLocaleString()} / ${(s.cloudflare.writeLimit / 1e3).toFixed(0)}k</b></div>
  </section>
  <section class="card"><h2>Manager <small>Claude routine</small></h2>
    <div class="kv"><span>last run <b>${s.manager.lastRunAt ? ago(s.manager.lastRunAt, now) : "never"}</b></span><span>${s.manager.lockedUntil ? `<span class="pill accent">running now</span>` : ""}</span></div>
    <h3>Needs a human</h3>${needs}
  </section>
</div>
<section class="card"><h2>Goals</h2><table><tr><th>goal</th><th>ready</th><th>in progress</th><th>review</th><th>accepted</th><th>blocked</th><th title="cancelled + rejected: retired without ever being accepted; never retried">dropped</th></tr>${goals}</table>
<div class="kv"><span>all tasks: ready <b>${c("ready")}</b></span><span>in progress <b>${inProgress}</b></span><span>review <b>${c("review")}</b></span><span>accepted <b>${c("accepted")}</b></span><span>blocked <b>${c("blocked")}</b></span></div></section>
<div class="grid" style="margin-top:14px">
  <section class="card"><h2>In progress</h2><ul>${list(s.running, (r) => `${esc(r.worker_id ?? "?")} · since ${ago(r.claimed_at, now)} · attempt ${r.attempt}`, "nothing running")}</ul></section>
  <section class="card"><h2>Waiting for review</h2><ul>${list(s.reviewQueue, (r) => `submitted ${ago(r.submitted_at, now)} · attempt ${r.attempt}`, "queue empty")}</ul></section>
  <section class="card"><h2>Accepted</h2><ul>${list(s.recentAccepted, (r) => `${ago(r.finished_at, now)} · ${usd(r.cost_usd, 3)} · ${r.attempt} attempt${r.attempt === 1 ? "" : "s"}`, "nothing accepted yet")}</ul></section>
  <section class="card"><h2>Blocked</h2><ul>${list(s.blocked, (r) => esc(r.last_error ?? ""), "nothing blocked")}</ul></section>
</div>
<section class="card"><h2>Log</h2><ul>${events}</ul></section>
<section class="card"><h2>Where to look</h2><ul>
<li><b>This page</b> — refreshes every 60 s; each task links to its spec, reviews, report and files. <a href="/api/status">JSON</a>.</li>
<li><b>Manager runs</b> — Claude routines <a href="https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1" rel="noopener">:13</a> and <a href="https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG" rel="noopener">:43</a> (owner login; every run is a full session transcript). Their verdicts appear in the log below as <code>task.accept</code>, <code>task.reject</code>, <code>tasks.create</code> and <code>run</code>.</li>
<li><b>Worker sessions</b> — the opencode web UI on the VM (SSH tunnel, see the README), or the transcript link on a task page when session sharing is on.</li>
<li><b>Source and goals</b> — <a href="https://github.com/yukewF2023/yuke-persistent-agent-flow" rel="noopener">github.com/yukewF2023/yuke-persistent-agent-flow</a> (GOALS.md is the only human input).</li></ul></section>
<footer>How it works: a human writes goals in the repo. The manager (Claude, a scheduled routine) turns them into tasks with acceptance criteria, keeps the board stocked, and reviews every deliverable by running its tests: accept, send back with notes, or split. Two workers (DeepSeek V4.1 Flash inside opencode on a small VM) pull tasks continuously, paced by the OpenCode Go allowance. Sessions are disposable; this board is the memory.</footer>
<script>${LIVE_WORKERS_JS}</script>`;
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
