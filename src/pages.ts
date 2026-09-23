import type { BoardStatus, DeliverableRow, ReviewRow, TaskRow } from "./types";
import { ago, esc, usd, when } from "./util";

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
`;

const shell = (title: string, body: string, refreshS: number | null) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshS ? `<meta http-equiv="refresh" content="${refreshS}">` : ""}<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const statusPill = (s: string) => {
  const cls = s === "accepted" ? "ok" : s === "blocked" || s === "rejected" ? "bad" : s === "review" ? "warn" : s === "running" || s === "claimed" ? "accent" : "";
  return `<span class="pill ${cls}">${esc(s)}</span>`;
};
const bar = (label: string, v: number, cap: number) => `<div class="bar"><span>${esc(label)}</span><div class="track"><div class="fill ${v / cap > 0.8 ? "hot" : ""}" style="width:${Math.min(100, (100 * v) / cap).toFixed(1)}%"></div></div><b>${usd(v)} / ${usd(cap, 0)}</b></div>`;

export function renderStatusPage(s: BoardStatus, now: number): string {
  const c = (k: string) => s.counts[k] ?? 0;
  const inProgress = c("claimed") + c("running");
  const workers = s.workers.length
    ? s.workers
        .map((w) => {
          const offline = now - w.last_seen > 15 * 60_000;
          const state = offline ? "off" : w.task_id ? "" : "idle";
          const label = offline ? `offline · last seen ${ago(w.last_seen, now)}` : w.task_id ? `working on <a href="/tasks/${w.task_id}">${esc(w.task_key ?? `#${w.task_id}`)}</a>` : esc(w.note ?? "idle");
          return `<li><span class="dot ${state}"></span><b>${esc(w.id)}</b> <span class="muted">${esc(w.host ?? "")}</span><br><span class="muted">${label}${!offline && w.task_id && w.note ? ` · ${esc(w.note)}` : ""} · done ${w.tasks_done} · failed ${w.tasks_failed}</span></li>`;
        })
        .join("")
    : "<li class=\"muted\">no worker has checked in yet</li>";
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
  <section class="card"><h2>Workers</h2><ul>${workers}</ul></section>
  <section class="card"><h2>Spend <small>OpenCode Go</small></h2>
    ${bar("today", sp.todayUsd, sp.paceUsdPerDay)}${bar("5 h", sp.fiveHourUsd, 12)}${bar("week", sp.weekUsd, 30)}${bar("month", sp.monthUsd, 60)}
    <div class="kv"><span>tasks today <b>${sp.todayTasks}</b></span><span>in flight est. <b>${usd(sp.inflightEstimateUsd)}</b></span><span>daily pace <b>${usd(sp.paceUsdPerDay)}</b></span></div>
    ${sp.pacing ? `<span class="pill warn">pacing</span> <span class="muted">${esc(sp.pacing.reason)}</span>` : `<span class="pill ok">within pace</span>`}
  </section>
  <section class="card"><h2>Manager <small>Claude routine</small></h2>
    <div class="kv"><span>last run <b>${s.manager.lastRunAt ? ago(s.manager.lastRunAt, now) : "never"}</b></span><span>${s.manager.lockedUntil ? `<span class="pill accent">running now</span>` : ""}</span></div>
    <h3>Needs a human</h3>${needs}
  </section>
</div>
<section class="card"><h2>Goals</h2><table><tr><th>goal</th><th>ready</th><th>in progress</th><th>review</th><th>accepted</th><th>blocked</th><th>dropped</th></tr>${goals}</table>
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
<footer>How it works: a human writes goals in the repo. The manager (Claude, a scheduled routine) turns them into tasks with acceptance criteria, keeps the board stocked, and reviews every deliverable by running its tests: accept, send back with notes, or split. Two workers (DeepSeek V4.1 Flash inside opencode on a small VM) pull tasks continuously, paced by the OpenCode Go allowance. Sessions are disposable; this board is the memory.</footer>`;
  return shell("Agent board", body, 60);
}

export function renderTaskPage(d: { task: TaskRow & { deps: number[] }; reviews: ReviewRow[]; deliverable: (Omit<DeliverableRow, "files"> & { files: Record<string, string> }) | null }, now: number): string {
  const t = d.task;
  const files = d.deliverable ? Object.entries(d.deliverable.files) : [];
  const body = `
<div class="top"><div><h1><a href="/">← board</a> · ${esc(t.key)} ${statusPill(t.status)}</h1><span class="muted">${esc(t.title)}</span></div><span class="muted"><a href="/api/tasks/${t.id}">JSON</a></span></div>
<section class="card">
  <div class="kv"><span>goal <b>${esc(t.goal_id)}</b></span><span>kind <b>${esc(t.kind)}</b></span><span>priority <b>${t.priority}</b></span><span>attempt <b>${t.attempt}/${t.max_attempts}</b></span><span>budget <b>${t.max_minutes} min</b></span><span>worker <b>${esc(t.worker_id ?? "—")}</b></span><span>cost <b>${usd(t.cost_usd, 3)}</b></span><span>tokens <b>${t.tokens_in + t.tokens_out}</b> (${t.tokens_cached} cached)</span><span>steps <b>${t.steps}</b></span><span>updated <b>${ago(t.updated_at, now)}</b></span>${t.deps.length ? `<span>deps <b>${t.deps.map((x) => `<a href="/tasks/${x}">#${x}</a>`).join(", ")}</b></span>` : ""}</div>
  ${t.last_error ? `<p class="muted">last error: ${esc(t.last_error)}</p>` : ""}
  <h3>Spec</h3><pre>${esc(t.spec)}</pre>
  <h3>Acceptance criteria</h3><pre>${esc(t.acceptance)}</pre>
</section>
<section class="card" style="margin-top:14px"><h2>Reviews</h2><ul>${d.reviews.length ? d.reviews.map((r) => `<li><time>${when(r.created_at)}</time>${statusPill(r.verdict === "accept" ? "accepted" : "rejected")} attempt ${r.attempt} · ${esc(r.who)}${r.notes ? `<pre>${esc(r.notes)}</pre>` : ""}</li>`).join("") : "<li class=\"muted\">not reviewed yet</li>"}</ul></section>
<section class="card" style="margin-top:14px"><h2>Deliverable ${d.deliverable ? `<small>attempt ${d.deliverable.attempt} · ${d.deliverable.nfiles} files · ${Math.round(d.deliverable.bytes / 1024)} KB${d.deliverable.truncated ? " · truncated" : ""}${d.deliverable.session_url ? ` · <a href="${esc(d.deliverable.session_url)}" rel="noopener">worker session transcript ↗</a>` : d.deliverable.session_id ? ` · session ${esc(d.deliverable.session_id)}` : ""}</small>` : ""}</h2>
  ${d.deliverable ? `<h3>Report</h3><pre>${esc(d.deliverable.report)}</pre><h3>Files</h3>${files.map(([p, c]) => `<details><summary>${esc(p)} <span class="muted">(${c.length} chars)</span></summary><pre>${esc(c)}</pre></details>`).join("") || "<span class=\"muted\">no files</span>"}` : "<span class=\"muted\">nothing submitted yet</span>"}
</section>`;
  return shell(`${t.key} · Agent board`, body, null);
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
