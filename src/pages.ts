import type { BoardStatus, DeliverableRow, DocRow, EventRow, LiveStatus, ProgressEvent, ProgressSnapshot, ReviewRow, TaskRow } from "./types";
import { ago, dur, esc, usd, when } from "./util";

/**
 * Server-rendered pages. One small design system: a five-step type scale, an 8 px grid, one accent colour and status colours
 * only on status. Every page renders completely without JavaScript; the script adds tabs, live refresh, filters and the theme toggle.
 */
const CSS = `
:root{--bg:#0c0e13;--panel:#13161d;--panel2:#191d26;--line:#262b38;--fg:#e8eaf0;--muted:#8d94a6;--dim:#5f6779;--accent:#7aa7ff;--ok:#3fcf8e;--warn:#f2b84b;--bad:#ff6b6b;--r:6px;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#f3f4f7;--panel:#fff;--panel2:#f6f7fa;--line:#e2e5ec;--fg:#181b23;--muted:#5e6678;--dim:#8d94a6;--accent:#2b66d9}}
:root[data-theme=light]{--bg:#f3f4f7;--panel:#fff;--panel2:#f6f7fa;--line:#e2e5ec;--fg:#181b23;--muted:#5e6678;--dim:#8d94a6;--accent:#2b66d9}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);padding:0 16px 48px;max-width:1280px;margin-inline:auto}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:22px;font-weight:600;margin:0;letter-spacing:-.01em}h2{font-size:15px;font-weight:600;margin:0}h3{font-size:11.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px}
code{font:12.5px var(--mono);background:var(--panel2);padding:1px 5px;border-radius:4px}pre{font:12.5px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r);padding:12px;margin:8px 0 0;max-height:70vh;overflow:auto}
.num{font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.dim{color:var(--dim)}.small{font-size:12px}.mono{font:12px var(--mono)}.right{text-align:right}
.hdr{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 0 14px;flex-wrap:wrap}.hdr .sub{color:var(--muted);font-size:13px;margin-top:2px}.hdr-r{display:flex;align-items:center;gap:14px;font-size:12.5px;color:var(--muted);flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block;flex:none}.dot.pulse{animation:pulse 1.8s infinite}.dot.idle{background:var(--dim)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,207,142,.45)}70%{box-shadow:0 0 0 7px rgba(63,207,142,0)}100%{box-shadow:0 0 0 0 rgba(63,207,142,0)}}
button,.btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:var(--r);border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer;line-height:1.3}button:hover,.btn:hover{border-color:var(--accent);text-decoration:none}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.mini,.btn.mini{font-size:12px;padding:3px 9px}
input[type=text],input[type=password],input[type=search],textarea{font:inherit;font-size:13px;color:var(--fg);background:var(--panel2);border:1px solid var(--line);border-radius:var(--r);padding:6px 9px}textarea{width:100%;font:12.5px/1.5 var(--mono);min-height:60vh;resize:vertical}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:8px;margin:0 0 14px}.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;min-width:0}.tile .l{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}.tile .v{font-size:22px;font-weight:600;line-height:1.2;margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap}.tile .v small{font-size:12px;font-weight:400;color:var(--muted);margin-left:4px}.tile .s{font-size:12px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tile.warn .v{color:var(--warn)}.tile.bad .v{color:var(--bad)}.tile.ok .v{color:var(--ok)}.tile.accent .v{color:var(--accent)}.tile .meter{margin-top:6px}
nav.tabs{display:flex;gap:2px;margin:0 0 14px;border-bottom:1px solid var(--line);overflow-x:auto}nav.tabs a{padding:8px 12px;color:var(--muted);font-size:13.5px;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}nav.tabs a:hover{color:var(--fg);text-decoration:none}nav.tabs a.active{color:var(--fg);border-bottom-color:var(--accent)}nav.tabs a .n{color:var(--dim);margin-left:5px;font-variant-numeric:tabular-nums}
.tab{margin-bottom:16px}.tabtitle{font-size:18px;margin:22px 0 10px;padding-top:12px;border-top:1px solid var(--line)}body.js .tab{display:none}body.js .tab.active{display:block}body.js .tabtitle{display:none}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;min-width:0}.panel+.panel,.grid+.panel,.panel+.grid,.two+.panel,.panel+.two{margin-top:12px}.ph{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;flex-wrap:wrap}.ph .r{font-size:12px;color:var(--muted)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.two{display:grid;gap:12px;grid-template-columns:minmax(0,3fr) minmax(0,2fr)}@media(max-width:900px){.two{grid-template-columns:1fr}}
.pipe{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--panel2);border:1px solid var(--line)}.pipe a{display:block;height:100%}.pipe .c-ready{background:var(--dim)}.pipe .c-prog{background:var(--accent)}.pipe .c-review{background:var(--warn)}.pipe .c-acc{background:var(--ok)}.pipe .c-blocked{background:var(--bad)}.pipe .c-dropped{background:var(--line)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:12.5px;color:var(--muted)}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:-1px}.legend b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}.legend a{color:inherit}
.pill{display:inline-block;font-size:11.5px;line-height:1.6;padding:0 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap;vertical-align:middle}.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.accent{color:var(--accent);border-color:var(--accent)}
.chip{display:inline-block;font:10.5px/1.7 var(--mono);padding:0 5px;border-radius:4px;color:#fff;vertical-align:1px;margin-right:6px;min-width:16px;text-align:center}.chip.A{background:#3b6fd6}.chip.B{background:#2c9a6a}.chip.X{background:#8a5cc7}.chip.C{background:#d1652b}.chip.D{background:#c2417a}.chip.o{background:var(--dim)}
.docs{list-style:none;margin:0;padding:0}.docs li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:8px 0;border-bottom:1px solid var(--line);align-items:baseline}.docs li:last-child{border-bottom:0}.docs .t{font-weight:500}.docs .s{grid-column:1;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.docs .m{grid-column:2;grid-row:1/3;font-size:12px;color:var(--muted);white-space:nowrap;text-align:right}
.doc{max-width:860px}.doc .md h4{font-size:17px;margin:22px 0 8px}.doc .md h5{font-size:14.5px;margin:16px 0 6px}.doc .md p,.doc .md li{font-size:14px}.doc .md table{border-collapse:collapse;font-size:13px;margin:8px 0}.doc .md td,.doc .md th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.tasks{list-style:none;margin:0;padding:0}.tasks li{border-bottom:1px solid var(--line)}.tasks li:last-child{border-bottom:0}.task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 10px;align-items:baseline;padding:7px 0;color:var(--fg)}.task:hover{text-decoration:none}.task:hover .t{color:var(--accent)}.task .t{grid-column:1/3;font-weight:500;line-height:1.35;overflow-wrap:anywhere}.task .k{grid-column:1;font:11.5px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.task .m{grid-column:2;font-size:11.5px;color:var(--muted);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.task .live{grid-column:1/3;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cols{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(236px,1fr))}.more{font-size:12px;color:var(--muted);padding-top:6px}.empty{color:var(--dim);font-size:13px;padding:6px 0}
.scroll{overflow-x:auto}.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:0 10px 6px 0;border-bottom:1px solid var(--line);white-space:nowrap}.tbl td{padding:7px 10px 7px 0;border-bottom:1px solid var(--line);vertical-align:middle;font-variant-numeric:tabular-nums}.tbl tr:last-child td{border-bottom:0}.tbl td.r,.tbl th.r{text-align:right;padding-right:0}.tbl td.prog{min-width:160px}
.meter{height:6px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;overflow:hidden}.meter i{display:block;height:100%;background:var(--accent)}.meter i.ok{background:var(--ok)}.meter i.warn{background:var(--warn)}.meter i.bad{background:var(--bad)}
.bar{display:grid;grid-template-columns:56px 1fr 120px;align-items:center;gap:10px;font-size:12.5px;color:var(--muted);margin:6px 0}.bar b{color:var(--fg);font-weight:500;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.kv{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12.5px;color:var(--muted);margin:6px 0}.kv b{color:var(--fg);font-weight:500;font-variant-numeric:tabular-nums}
.agent{padding:12px 14px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel2)}.agent+.agent{margin-top:10px}.agent .ah{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.agent .ah b{font-weight:600}.agent .ah .model{font-size:12px;color:var(--muted)}.agent .ah .pill{margin-left:auto}.agent .now{margin-top:6px;font-size:13px;overflow-wrap:anywhere}.agent .now .k{color:var(--muted)}.agent .meter{margin-top:8px}
.feed{list-style:none;margin:8px 0 0;padding:0;max-height:360px;overflow:auto}.feed li{font:12px/1.5 var(--mono);padding:3px 0;border-bottom:1px dotted var(--line);display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;overflow-wrap:anywhere}.feed time{color:var(--dim)}.feed q{quotes:none;color:var(--muted)}
details.fold{margin-top:8px}details.fold summary{cursor:pointer;font-size:12.5px;color:var(--muted)}details.fold summary:hover{color:var(--fg)}
.evt{list-style:none;margin:0;padding:0}.evt li{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px;align-items:baseline}.evt li:last-child{border-bottom:0}.evt time{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}.evt .kind{display:inline-block;min-width:92px;font-size:11.5px;color:var(--muted);margin-right:6px}.evt .kind.ok{color:var(--ok)}.evt .kind.bad{color:var(--bad)}.evt .kind.warn{color:var(--warn)}.evt .kind.accent{color:var(--accent)}.evt .who{color:var(--dim);font-size:12px;margin-left:6px}.evt li.evt-h{display:block;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding:14px 0 4px;border-bottom:0}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}.filters label{font-size:12px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);cursor:pointer;user-select:none}.filters label.on{color:var(--fg);border-color:var(--accent)}body.js .filters input[type=checkbox]{display:none}.filters input[type=search]{min-width:200px}.filters .sep{color:var(--dim);margin:0 4px}
.md p{margin:6px 0}.md ul{margin:4px 0 8px 18px;padding:0}.md li{margin:2px 0}.md h4,.md h5{margin:12px 0 4px;font-size:13.5px}
.alert{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}.alert:last-child{border-bottom:0}.alert .dot{margin-top:7px}
.wakeform{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px}.wakeform input{max-width:170px}
.banner{padding:10px 14px;border-radius:var(--r);margin-bottom:12px;font-size:13.5px;border:1px solid var(--line);background:var(--panel)}.banner.ok{border-color:var(--ok)}.banner.bad{border-color:var(--bad)}.banner.warn{border-color:var(--warn)}
.row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:8px 0}.row label{font-size:12.5px;color:var(--muted)}
.help{margin-top:16px;font-size:13px;color:var(--muted)}.help summary{cursor:pointer}.help ul{margin:8px 0 0 18px;padding:0}.help li{margin:4px 0}
footer{margin-top:20px;color:var(--dim);font-size:12px;display:flex;gap:14px;flex-wrap:wrap}
.days .d{display:grid;grid-template-columns:82px 1fr 64px 44px;gap:10px;align-items:center;font-size:12.5px;color:var(--muted);padding:3px 0}.days .d .meter{height:10px}.days .d b{color:var(--fg);text-align:right;font-weight:500;font-variant-numeric:tabular-nums}
.checks{list-style:none;margin:8px 0 0;padding:0}.checks li{padding:4px 0 4px 22px;position:relative;border-bottom:1px solid var(--line);font-size:13px}.checks li:before{content:"";position:absolute;left:2px;top:9px;width:11px;height:11px;border:1px solid var(--muted);border-radius:3px}.checks li:last-child{border-bottom:0}
.reviews li{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}.reviews li:last-child{border-bottom:0}.reviews{list-style:none;margin:0;padding:0}
@media(max-width:640px){body{padding:0 12px 40px}.hdr{padding:14px 0 10px}.tile .v{font-size:19px}.bar{grid-template-columns:44px 1fr 100px}}
`;

/**
 * Status page script: tabs keyed by the URL hash (old hashes still work), theme toggle, the "updated" counter, the visible
 * agents list swapped for a fresh fragment every 20 s, and the activity filters. Every section is server-rendered, so the page
 * reads top to bottom without it.
 */
const STATUS_JS = `(function(){var b=document.body;b.className+=' js';
var alias={board:'pipeline',workers:'agents',log:'activity',spend:'budget'};
var tabs=[].slice.call(document.querySelectorAll('.tab')),links=[].slice.call(document.querySelectorAll('nav.tabs a'));
function show(){var h=(location.hash||'#overview').slice(1);h=alias[h]||h;if(!document.getElementById(h))h='overview';tabs.forEach(function(t){t.classList.toggle('active',t.id===h)});links.forEach(function(a){a.classList.toggle('active',a.getAttribute('href')==='#'+h)});window.scrollTo(0,0)}
window.addEventListener('hashchange',show);show();window.addEventListener('load',function(){setTimeout(function(){window.scrollTo(0,0)},0)});
var root=document.documentElement;try{var th=localStorage.getItem('board_theme');if(th)root.setAttribute('data-theme',th)}catch(e){}
var tb=document.getElementById('theme');if(tb)tb.addEventListener('click',function(){var cur=root.getAttribute('data-theme');var next=cur==='dark'?'light':cur==='light'?'':'dark';if(next)root.setAttribute('data-theme',next);else root.removeAttribute('data-theme');try{if(next)localStorage.setItem('board_theme',next);else localStorage.removeItem('board_theme')}catch(e){}});
try{var tok=localStorage.getItem('board_token');if(tok){[].forEach.call(document.querySelectorAll('input[name=token]'),function(i){i.value=tok})}}catch(e){}
var upd=document.getElementById('updated'),t0=Date.now();if(upd)setInterval(function(){var s=Math.round((Date.now()-t0)/1000);upd.textContent=s<60?s+' s ago':Math.round(s/60)+' min ago'},5000);
var lists=[{el:document.getElementById('agents-live'),url:'/live/workers'},{el:document.getElementById('agents-full'),url:'/live/workers?open=1'}];
function tick(){if(document.hidden||!window.fetch)return;lists.forEach(function(l){if(!l.el)return;var t=l.el.closest('.tab');if(t&&!t.classList.contains('active'))return;fetch(l.url,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(h){l.el.innerHTML=h;t0=Date.now()}}).catch(function(){})})}
setInterval(tick,20000);
var log=document.getElementById('log-list');if(log){var kinds=[].slice.call(document.querySelectorAll('#log-filters input[data-kind]')),q=document.getElementById('log-q');
function apply(){var on={};kinds.forEach(function(c){on[c.getAttribute('data-kind')]=c.checked;c.parentNode.classList.toggle('on',c.checked)});var text=(q&&q.value||'').toLowerCase();var n=0;[].forEach.call(log.querySelectorAll('li[data-kind]'),function(li){var ok=on[li.getAttribute('data-kind')]!==false&&(!text||li.textContent.toLowerCase().indexOf(text)>=0);li.style.display=ok?'':'none';if(ok)n++});[].forEach.call(log.querySelectorAll('li.evt-h'),function(h){var any=false,e=h.nextElementSibling;while(e&&!e.classList.contains('evt-h')){if(e.style.display!=='none')any=true;e=e.nextElementSibling}h.style.display=any?'':'none'});var c=document.getElementById('log-count');if(c)c.textContent=n+' shown'}
kinds.forEach(function(c){c.addEventListener('change',apply)});if(q)q.addEventListener('input',apply);
var pre={all:null,verdicts:['task.accept','task.reject','run','tasks.create','task.patch','needs-human','goals.edit','manager.wake','goal.paused','pace.set'],workers:['task.claim','task.submit','task.fail','task.release','lease.expired','task.blocked']};
[].forEach.call(document.querySelectorAll('[data-preset]'),function(a){a.addEventListener('click',function(e){e.preventDefault();var p=pre[a.getAttribute('data-preset')];kinds.forEach(function(c){c.checked=!p||p.indexOf(c.getAttribute('data-kind'))>=0});apply()})});apply()}
})();`;
/** Poll the task's live fragment every 15 s; when the task leaves claimed/running, reload once to show the deliverable and reviews. */
const LIVE_TASK_JS = `(function(){document.body.className+=' js';var el=document.getElementById('task-live');if(!el||!window.fetch)return;var id=el.getAttribute('data-task');var iv=setInterval(function(){if(document.hidden)return;fetch('/live/tasks/'+id,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(!h)return;el.innerHTML=h;var st=el.querySelector('[data-status]');if(st&&['claimed','running'].indexOf(st.getAttribute('data-status'))<0){clearInterval(iv);setTimeout(function(){location.reload()},1500)}}).catch(function(){})},15000)})();`;
/** Goals editor: remember the board token per browser, warn before leaving with unsaved edits, Ctrl/Cmd+S saves. */
const GOALS_JS = `(function(){document.body.className+=' js';var f=document.getElementById('goals-form');if(!f)return;var t=f.querySelector('input[name=token]'),ta=f.querySelector('textarea'),orig=ta.value,dirty=false;
try{var saved=localStorage.getItem('board_token');if(saved&&!t.value)t.value=saved}catch(e){}
ta.addEventListener('input',function(){dirty=ta.value!==orig;var b=document.getElementById('goals-dirty');if(b)b.textContent=dirty?'unsaved changes':''});
f.addEventListener('submit',function(){try{if(t.value)localStorage.setItem('board_token',t.value)}catch(e){}dirty=false});
window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue=''}});
document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();if(f.requestSubmit)f.requestSubmit();else f.submit()}});
var forget=document.getElementById('forget-token');if(forget)forget.addEventListener('click',function(e){e.preventDefault();try{localStorage.removeItem('board_token')}catch(x){}t.value=''});
})();`;
const THEME_JS = `(function(){try{var th=localStorage.getItem('board_theme');if(th)document.documentElement.setAttribute('data-theme',th)}catch(e){}})();`;

/**
 * Page shell. The periodic refresh is a meta refresh only when scripts are off (inside <noscript>); with scripts on, the page
 * reloads itself, which keeps the URL hash (the active tab).
 */
const shell = (title: string, body: string, refreshS: number | null) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshS ? `<noscript><meta http-equiv="refresh" content="${refreshS}"></noscript>` : ""}<title>${esc(title)}</title><style>${CSS}</style><script>${THEME_JS}</script></head><body>${body}${refreshS ? `<script>setTimeout(function(){location.reload()},${refreshS * 1000})</script>` : ""}</body></html>`;

// ---- small pieces ----
const ROUTINE_13 = "https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1";
const ROUTINE_43 = "https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG";
const REPO = "https://github.com/yukewF2023/yuke-persistent-agent-flow";

const statusPill = (s: string) => {
  const cls = s === "accepted" ? "ok" : s === "blocked" || s === "rejected" ? "bad" : s === "review" ? "warn" : s === "running" || s === "claimed" ? "accent" : "";
  return `<span class="pill ${cls}">${esc(s)}</span>`;
};
const CHIP_TITLE: Record<string, string> = { A: "Goal A · TypeScript module", B: "Goal B · Python port", X: "Goal B · cross-check (TS vs Python)", C: "Goal C · B2B go-to-market", D: "Goal D · B2C growth" };
/** Goal chip from the task key prefix (A/…, B/…, X/…) or the goal id. */
const chip = (key: string, goalId?: string | null) => {
  const p = /^([A-Za-z0-9]+)\//.exec(key)?.[1] ?? goalId ?? "";
  const cls = ["A", "B", "X", "C", "D"].includes(p) ? p : "o";
  return `<span class="chip ${cls}" title="${esc(CHIP_TITLE[p] ?? `goal ${goalId ?? p}`)}">${esc(p || "·")}</span>`;
};
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (v: number, cap: number) => Math.max(0, Math.min(100, cap > 0 ? (100 * v) / cap : 0));
const meter = (v: number, cap: number, warnAt = 0.8, badAt = 1) => {
  const r = cap > 0 ? v / cap : 0;
  return `<div class="meter"><i class="${r >= badAt ? "bad" : r >= warnAt ? "warn" : ""}" style="width:${pct(v, cap).toFixed(1)}%"></i></div>`;
};
const bar = (label: string, v: number, cap: number, capLabel?: string) =>
  `<div class="bar"><span>${esc(label)}</span>${meter(v, cap)}<b>${usd(v)} / ${capLabel ?? usd(cap, 0)}</b></div>`;
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);
/** The next :13 / :43 manager slot after `now`. */
const nextRunAt = (now: number) => {
  const d = new Date(now);
  const m = d.getUTCMinutes();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  if (m < 13) next.setUTCMinutes(13);
  else if (m < 43) next.setUTCMinutes(43);
  else {
    next.setUTCHours(next.getUTCHours() + 1);
    next.setUTCMinutes(13);
  }
  return next.getTime();
};
const KIND_LABEL: Record<string, [string, string]> = {
  "task.accept": ["accepted", "ok"],
  "task.reject": ["rejected", "bad"],
  "task.submit": ["submitted", "accent"],
  "task.claim": ["claimed", ""],
  "task.fail": ["failed", "bad"],
  "task.release": ["released", ""],
  "task.blocked": ["blocked", "bad"],
  "lease.expired": ["lease expired", "warn"],
  "tasks.create": ["planned", "accent"],
  "task.patch": ["edited", ""],
  run: ["manager run", "accent"],
  "goal.paused": ["goal paused", "warn"],
  "pace.set": ["pace", ""],
  "needs-human": ["needs a human", "bad"],
  "manager.wake": ["wake", ""],
  "goals.edit": ["goals edited", "accent"],
  "doc.update": ["brief updated", "ok"],
  "doc.delete": ["brief deleted", "warn"]
};
const kindLabel = (kind: string) => KIND_LABEL[kind]?.[0] ?? kind;
const kindCls = (kind: string) => KIND_LABEL[kind]?.[1] ?? "";
const eventLi = (e: EventRow) =>
  `<li data-kind="${esc(e.kind)}"><time title="${when(e.ts)}">${hhmm(e.ts)}</time><span><span class="kind ${kindCls(e.kind)}">${esc(kindLabel(e.kind))}</span>${e.task_id ? `<a href="/tasks/${e.task_id}">#${e.task_id}</a> ` : ""}${esc(e.text)}<span class="who">${esc(e.actor)}</span></span></li>`;
/** Events newest first, grouped under one heading per UTC hour. */
const eventList = (events: EventRow[]) => {
  let out = "";
  let hour = "";
  for (const e of events) {
    const h = new Date(e.ts).toISOString().slice(0, 13);
    if (h !== hour) {
      hour = h;
      out += `<li class="evt-h">${esc(h.replace("T", " "))}:00 UTC</li>`;
    }
    out += eventLi(e);
  }
  return out;
};

/** Minimal markdown for goal bodies: headings, bullet lists, code spans, bold, bare links. Input is escaped first. */
function md(text: string): string {
  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" rel="noopener">$1</a>');
  let out = "";
  let para: string[] = [];
  let list = false;
  const flush = () => {
    if (para.length) {
      out += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    }
  };
  const endList = () => {
    if (list) {
      out += "</ul>";
      list = false;
    }
  };
  let table: string[][] = [];
  const endTable = () => {
    if (table.length) {
      const [head, ...rows] = table;
      out += `<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table>`;
      table = [];
    }
  };
  for (const raw of esc(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(#{1,3}) (.+)$/.exec(line);
    const li = /^(?:- |\* |\d+\. )(.+)$/.exec(line);
    if (/^\|.*\|$/.test(line)) {
      flush();
      endList();
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) table.push(cells);
      continue;
    }
    endTable();
    if (h) {
      flush();
      endList();
      out += `<h${h[1].length + 3}>${inline(h[2])}</h${h[1].length + 3}>`;
    } else if (li) {
      flush();
      if (!list) {
        out += "<ul>";
        list = true;
      }
      out += `<li>${inline(li[1])}</li>`;
    } else if (!line.trim()) {
      flush();
      endList();
    } else {
      if (list) endList();
      para.push(line);
    }
  }
  flush();
  endList();
  endTable();
  return out;
}

// ---- live agents ----
const liveElapsed = (p: ProgressSnapshot, now: number, active: boolean) => p.elapsed_s + (active && p.phase === "running" ? Math.max(0, (now - p.updated_at) / 1000) : 0);
const toolLabel = (e: ProgressEvent) => `${e.tool ?? "tool"}${e.title ? `: ${e.title}` : ""}${e.status && e.status !== "completed" ? ` (${e.status})` : ""}`;
/** "step 12 · bash: npx vitest run · 3m20s" plus a stale marker when the worker stopped posting. */
const liveLine = (p: ProgressSnapshot, now: number, active: boolean, withCost = false) => {
  const last = p.events.length ? p.events[p.events.length - 1] : null;
  const lastTool = p.events.slice().reverse().find((e) => e.k === "tool");
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
  return `<span class="k">step</span> ${p.step} · ${esc(doing.slice(0, 120))} · ${dur(liveElapsed(p, now, active))}${withCost ? ` · ${usd(p.cost_usd, 3)} · ${k(p.tokens_in + p.tokens_out)} tokens` : ""}${stale ? ` <span class="pill warn" title="last progress post ${ago(p.updated_at, now)}">stale</span>` : ""}`;
};
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
                ? `<span class="dim">step ${e.n} finished</span>`
                : e.k === "error"
                  ? `<span class="pill bad">error</span> ${esc(e.text ?? "")}`
                  : `<q>${esc(e.text ?? "")}</q>`;
          return `<li><time>+${dur(e.t)}</time><span>${body}</span></li>`;
        })
        .join("")}</ul>`
    : `<div class="empty">no events yet</div>`;
const workerName = (id: string) => {
  const m = /-(\d+)$/.exec(id);
  return m ? `Worker ${m[1]}` : id;
};
/** "pacing: daily pace $2.50 reached ($2.52 spent + $0.00 in flight); resumes 00:00 UTC" → "paused · daily pace $2.50 reached · resumes 00:00 UTC" */
const pausedText = (note: string) => `paused · ${note.replace(/^pacing:\s*/, "").replace(/\s*\([^)]*\)/g, "").replace(/;\s*/g, " · ")}`;

/**
 * The worker agents as cards. Rendered into the status page (Overview, compact; Agents tab, feeds open) and served alone at
 * /live/workers, which the page's script swaps in every 20 s while visible.
 */
export function renderAgents(s: Pick<LiveStatus, "workers" | "running" | "progress">, now: number, open = false): string {
  if (!s.workers.length) return `<div class="empty">no worker has checked in yet</div>`;
  return s.workers
    .map((w) => {
      const offline = now - w.last_seen > 15 * 60_000;
      const task = w.task_id ? s.running.find((r) => r.id === w.task_id) : undefined;
      const p = w.task_id ? s.progress[String(w.task_id)] : undefined;
      const snap = p && (!task || p.attempt === task.attempt) ? p : undefined;
      const paused = !offline && !w.task_id && /^pacing/.test(w.note ?? "");
      const state = offline ? ["bad", "offline"] : w.task_id ? ["ok", task?.status === "claimed" ? "starting" : "running"] : paused ? ["warn", "paused"] : ["", "idle"];
      const dot = offline ? "bad" : w.task_id ? "pulse" : paused ? "warn" : "idle";
      let nowLine: string;
      if (offline) nowLine = `<span class="k">last seen</span> ${ago(w.last_seen, now)}`;
      else if (w.task_id)
        nowLine = `<span class="k">on</span> <a href="/tasks/${w.task_id}">${esc(task?.title ?? w.task_key ?? `#${w.task_id}`)}</a> <span class="mono muted">${esc(w.task_key ?? "")}</span>${task ? ` <span class="muted small">· attempt ${task.attempt} · claimed ${ago(task.claimed_at, now)}</span>` : ""}<div class="now">${snap ? liveLine(snap, now, true) : `<span class="muted">starting the session…</span>`}</div>`;
      else if (paused) nowLine = `<span class="muted">${esc(pausedText(w.note ?? ""))}</span>`;
      else nowLine = `<span class="muted">${esc(w.note ? w.note.replace(/^idle:\s*/, "waiting · ") : "waiting for a task")}</span>`;
      const budget = task && snap ? meter(liveElapsed(snap, now, true), task.max_minutes * 60, 0.75, 0.95) : "";
      const stats = `<div class="kv small"><span>done <b>${w.tasks_done}</b></span><span>failed <b>${w.tasks_failed}</b></span>${snap ? `<span>cost <b>${usd(snap.cost_usd, 3)}</b></span><span>tokens <b>${k(snap.tokens_in + snap.tokens_out)}</b></span><span>tool calls <b>${snap.tools}</b></span>` : ""}${task ? `<span>budget <b>${task.max_minutes} min</b></span>` : ""}${snap?.session_url ? `<span><a href="${esc(snap.session_url)}" rel="noopener">transcript ↗</a></span>` : ""}</div>`;
      const feed = snap && !offline && w.task_id ? `<details class="fold"${open ? " open" : ""}><summary>last ${snap.events.length} events</summary>${liveFeed(snap)}</details>` : "";
      let prefers = "";
      try {
        const g = w.goals ? (JSON.parse(w.goals) as string[]) : [];
        if (g.length) prefers = ` · prefers ${g.map((x) => `<span class="chip ${["A", "B", "X", "C", "D"].includes(x) ? x : "o"}" title="${esc(CHIP_TITLE[x] ?? `goal ${x}`)}">${esc(x)}</span>`).join("")}`;
      } catch {}
      return `<div class="agent"><div class="ah"><span class="dot ${dot}"></span><b>${esc(workerName(w.id))}</b><span class="model">DeepSeek V4.1 Flash · opencode${w.host ? ` · ${esc(w.host)}` : ""}${prefers}</span><span class="pill ${state[0]}">${state[1]}</span></div><div class="now">${nowLine}</div>${budget}${stats}${feed}</div>`;
    })
    .join("");
}

/** The manager as an agent card: role, last run summary, next slot, wake button. */
function managerCard(s: BoardStatus, now: number): string {
  const running = Boolean(s.manager.lockedUntil);
  const lastRun = s.events.find((e) => e.kind === "run");
  const silent = !running && (!s.manager.lastRunAt || now - s.manager.lastRunAt > 90 * 60_000);
  const next = nextRunAt(now);
  return `<div class="agent"><div class="ah"><span class="dot ${running ? "pulse" : silent ? "warn" : "idle"}"></span><b>Manager</b><span class="model">Claude Sonnet 5 · cloud routine · plans, dispatches, reviews</span><span class="pill ${running ? "accent" : silent ? "warn" : ""}">${running ? "running now" : silent ? "overdue" : "scheduled"}</span></div>
<div class="now">${lastRun ? `<span class="k">last run</span> ${esc(lastRun.text)}` : `<span class="muted">no run recorded yet</span>`}</div>
<div class="kv small"><span>ran <b>${s.manager.lastRunAt ? ago(s.manager.lastRunAt, now) : "never"}</b></span><span>next <b>${hhmm(next)} UTC</b> (${ago(next, now)}), or on the next push to main</span><span><a href="${ROUTINE_13}" rel="noopener">runs :13 ↗</a></span><span><a href="${ROUTINE_43}" rel="noopener">runs :43 ↗</a></span></div>
<form method="post" action="/wake" class="wakeform"><input type="password" name="token" placeholder="board token" autocomplete="current-password" required><input type="hidden" name="reason" value="button on the board"><button class="mini">Wake now</button><a class="btn mini" href="/goals">Edit goals</a></form></div>`;
}

/** What needs a human, or "all clear". */
function attention(s: BoardStatus, now: number): string {
  const items: string[] = [];
  const alert = (cls: string, html: string) => items.push(`<div class="alert"><span class="dot ${cls}"></span><span>${html}</span></div>`);
  for (const n of s.needsHuman) alert("bad", `<span class="dim small">${when(n.ts)}</span> ${esc(n.text)}`);
  for (const t of s.blocked) alert("bad", `Blocked: <a href="/tasks/${t.id}">${esc(t.title)}</a> <span class="mono muted">${esc(t.key)}</span> · ${esc(t.last_error ?? "")}`);
  for (const w of s.workers) if (now - w.last_seen > 15 * 60_000) alert("bad", `${esc(workerName(w.id))} is offline (last seen ${ago(w.last_seen, now)})`);
  if (s.spend.pacing) alert("warn", `Workers paused: ${esc(s.spend.pacing.reason)}`);
  if (!s.manager.lockedUntil && s.manager.lastRunAt && now - s.manager.lastRunAt > 90 * 60_000) alert("warn", `The manager has not run for ${ago(s.manager.lastRunAt, now).replace(" ago", "")}; check the routine`);
  if ((s.counts.review ?? 0) > 10) alert("warn", `${s.counts.review} tasks waiting for review; the manager reviews at most 8 per run`);
  if (s.cloudflare.reads > 0.7 * s.cloudflare.readLimit || s.cloudflare.writes > 0.7 * s.cloudflare.writeLimit) alert("warn", `Cloudflare free-tier rows above 70 % today (<a href="#budget">budget</a>)`);
  return items.length ? items.join("") : `<div class="alert"><span class="dot"></span><span>All clear. Nothing needs a human.</span></div>`;
}

const taskRow = (t: { id: number; key: string; title: string; goal_id?: string | null }, meta: string, live = "") =>
  `<li><a class="task" href="/tasks/${t.id}"><span class="t">${esc(t.title)}</span><span class="k">${chip(t.key, t.goal_id)}${esc(t.key)}</span><span class="m">${meta}</span>${live ? `<span class="live">${live}</span>` : ""}</a></li>`;
const taskList = (rows: string[], empty: string) => (rows.length ? `<ul class="tasks">${rows.join("")}</ul>` : `<div class="empty">${empty}</div>`);
const more = (total: number, shown: number, status: string) => (total > shown ? `<div class="more">and ${total - shown} more · <a href="/api/tasks?status=${encodeURIComponent(status)}&limit=100">JSON</a></div>` : "");

export function renderStatusPage(s: BoardStatus, now: number): string {
  const c = (key: string) => s.counts[key] ?? 0;
  const inProgress = c("claimed") + c("running");
  const dropped = c("cancelled") + c("rejected");
  const sp = s.spend;
  const cf = s.cloudflare;
  const offline = s.workers.filter((w) => now - w.last_seen > 15 * 60_000).length;
  const busy = s.workers.filter((w) => w.task_id && now - w.last_seen <= 15 * 60_000).length;
  const paused = s.workers.filter((w) => !w.task_id && /^pacing/.test(w.note ?? "")).length;
  const running = Boolean(s.manager.lockedUntil);
  const managerSilent = !running && (!s.manager.lastRunAt || now - s.manager.lastRunAt > 90 * 60_000);
  const next = nextRunAt(now);

  // ---- status strip ----
  const strip = `<div class="strip">
<div class="tile ${offline ? "bad" : busy ? "ok" : paused ? "warn" : ""}"><div class="l">Workers</div><div class="v">${s.workers.length}</div><div class="s">${offline ? `${offline} offline` : busy ? `${busy} running` : paused ? "paused (pace)" : "idle"}</div></div>
<div class="tile"><div class="l">Ready</div><div class="v">${c("ready")}</div><div class="s">queued for workers</div></div>
<div class="tile ${inProgress ? "accent" : ""}"><div class="l">In progress</div><div class="v">${inProgress}</div><div class="s">${inProgress ? "sessions running" : "nothing running"}</div></div>
<div class="tile ${c("review") > 10 ? "warn" : ""}"><div class="l">Review</div><div class="v">${c("review")}</div><div class="s">awaiting the manager</div></div>
<div class="tile ok"><div class="l">Accepted</div><div class="v">${s.acceptedToday}<small>today</small></div><div class="s">${c("accepted")} in total</div></div>
<div class="tile ${c("blocked") ? "bad" : ""}"><div class="l">Blocked</div><div class="v">${c("blocked")}</div><div class="s">${c("blocked") ? "need a human" : "none"}</div></div>
<div class="tile ${sp.pacing ? "warn" : ""}"><div class="l">Spend today</div><div class="v">${usd(sp.todayUsd)}<small>/ ${usd(sp.paceUsdPerDay)}</small></div>${meter(sp.todayUsd, sp.paceUsdPerDay, 0.8, 1)}<div class="s">${sp.paceMode === "smooth" ? `${usd(sp.allowedNowUsd)} released so far` : "burst pace"}</div></div>
<div class="tile ${running ? "accent" : managerSilent ? "warn" : ""}"><div class="l">Manager</div><div class="v">${running ? "running" : s.manager.lastRunAt ? ago(s.manager.lastRunAt, now) : "never"}</div><div class="s">${running ? "reviewing and planning" : `next ${hhmm(next)} UTC`}</div></div>
</div>`;

  // ---- pipeline bar ----
  const stages: [string, number, string][] = [
    ["Ready", c("ready"), "c-ready"],
    ["In progress", inProgress, "c-prog"],
    ["Review", c("review"), "c-review"],
    ["Accepted", c("accepted"), "c-acc"],
    ["Blocked", c("blocked"), "c-blocked"],
    ["Dropped", dropped, "c-dropped"]
  ];
  const total = stages.reduce((a, [, n]) => a + n, 0) || 1;
  const pipe = `<div class="pipe">${stages.filter(([, n]) => n > 0).map(([label, n, cls]) => `<a class="${cls}" href="#pipeline" title="${label}: ${n}" style="flex:${Math.max(n, total * 0.025)} 0 0"></a>`).join("")}</div>
<div class="legend">${stages.map(([label, n, cls]) => `<span><i class="${cls}" style="background:var(--${cls === "c-ready" ? "dim" : cls === "c-prog" ? "accent" : cls === "c-review" ? "warn" : cls === "c-acc" ? "ok" : cls === "c-blocked" ? "bad" : "line"})"></i>${label} <b>${n}</b></span>`).join("")}</div>`;

  // ---- goals table ----
  const goalRows = s.goals.length
    ? s.goals
        .map((g) => {
          const gc = (key: string) => g.counts[key] ?? 0;
          const acc = gc("accepted");
          const prog = g.catalog_size ? `<div class="kv" style="margin:0 0 4px"><b>${acc}</b> / ${g.catalog_size} catalog items</div>${meter(acc, g.catalog_size, 2, 2).replace('<i class=""', '<i class="ok"')}` : `<span class="muted">${acc} accepted · ${gc("ready") + gc("claimed") + gc("running") + gc("review")} open</span>`;
          return `<tr><td><span class="chip ${["A", "B", "X"].includes(g.id) ? g.id : "o"}">${esc(g.id)}</span>${esc(g.title)} ${statusPill(g.status)}</td><td class="prog">${prog}</td><td class="r">${gc("ready")}</td><td class="r">${gc("claimed") + gc("running")}</td><td class="r">${gc("review")}</td><td class="r">${gc("accepted")}</td><td class="r">${gc("blocked")}</td><td class="r">${gc("rejected") + gc("cancelled")}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="8" class="empty">no goals yet — the manager syncs GOALS.md on its next run</td></tr>`;
  const goalsTable = `<div class="scroll"><table class="tbl"><tr><th>goal</th><th>progress</th><th class="r">ready</th><th class="r">running</th><th class="r">review</th><th class="r">accepted</th><th class="r">blocked</th><th class="r" title="cancelled or rejected for good">dropped</th></tr>${goalRows}</table></div>`;

  const nav = `<nav class="tabs"><a href="#overview">Overview</a><a href="#pipeline">Pipeline<span class="n">${c("ready")} · ${inProgress} · ${c("review")}</span></a><a href="#agents">Agents<span class="n">${s.workers.length + 1}</span></a><a href="#goals">Goals<span class="n">${s.goals.length}</span></a><a href="#activity">Activity</a><a href="#budget">Budget<span class="n">${usd(sp.todayUsd)}</span></a></nav>`;

  const overview = `<section class="tab" id="overview"><h2 class="tabtitle">Overview</h2>
<div class="panel"><div class="ph"><h2>Pipeline</h2><span class="r">${c("accepted") + inProgress + c("review") + c("ready") + c("blocked") + dropped} tasks · <a href="#pipeline">open the board</a></span></div>${pipe}</div>
<div class="two">
  <div class="panel"><div class="ph"><h2>Agents</h2><span class="r">live · <a href="#agents">details</a></span></div><div id="agents-live">${renderAgents(s, now)}</div><div style="margin-top:10px">${managerCard(s, now)}</div></div>
  <div class="panel"><div class="ph"><h2>Needs attention</h2><span class="r">${s.needsHuman.length + s.blocked.length ? `${s.needsHuman.length + s.blocked.length} item${s.needsHuman.length + s.blocked.length === 1 ? "" : "s"}` : "all clear"}</span></div>${attention(s, now)}
  <h3>Recent activity</h3><ul class="evt">${s.events.slice(0, 8).map(eventLi).join("") || `<li class="empty">nothing yet</li>`}</ul><div class="more"><a href="#activity">full activity log</a></div></div>
</div>
<div class="panel"><div class="ph"><h2>Briefs for you</h2><span class="r">maintained by the manager · rewritten, never appended</span></div>${
  s.docs.length
    ? `<ul class="docs">${s.docs.map((d) => `<li><a class="t" href="/docs/${esc(d.id)}">${esc(d.title)}</a><span class="s">${d.note ? esc(d.note) : "no change note"}</span><span class="m">v${d.version} · ${ago(d.updated_at, now)} · ${Math.round(d.bytes / 1024)} KB</span></li>`).join("")}</ul>`
    : `<div class="empty">no briefs yet — the manager writes one per research goal once it has reviewed the first memos</div>`
}</div>
<div class="panel"><div class="ph"><h2>Goals</h2><span class="r"><a href="#goals">bodies</a> · <a href="/goals">edit</a></span></div>${goalsTable}</div>
<details class="help"><summary>How this board works, and where to look</summary><ul>
<li><b>The loop.</b> You write goals in GOALS.md (the <a href="/goals">editor</a> commits it). The manager, a scheduled Claude routine, turns them into tasks with acceptance criteria, keeps the queue stocked, and reviews every deliverable by running its tests: accept, send back with notes, or split. Two DeepSeek workers on a small VM pull tasks continuously, paced by the OpenCode Go allowance. Sessions are disposable; this board is the memory.</li>
<li><b>Pipeline</b> lists every task by stage; <b>Agents</b> shows what each worker is doing step by step (refreshed every 20 s) and the manager's last run; <b>Goals</b> has the goal bodies and progress; <b>Activity</b> is everything that happened, filterable; <b>Budget</b> is spend against the Go windows and the Cloudflare free tier.</li>
<li><b>One task</b>: click it for the spec, the acceptance checklist, the live session while it runs, every review verdict, the report and the files.</li>
<li><b>Manager runs</b> are full session transcripts on claude.ai: <a href="${ROUTINE_13}" rel="noopener">:13</a> and <a href="${ROUTINE_43}" rel="noopener">:43</a> (owner login). Every push to <code>main</code> also starts a run within about a minute; the Wake button does the same once its trigger is configured (manager/ROUTINE.md).</li>
<li><b>Worker transcripts</b>: the opencode web UI on the VM through an SSH tunnel (worker/README.md), or a transcript link on the task page when session sharing is on.</li>
<li>The page reloads every 60 s and keeps the tab in the URL hash, so <code>/#agents</code> is a bookmark. Machine-readable: <a href="/api/status">/api/status</a>, <a href="/api/live">/api/live</a>. Source: <a href="${REPO}" rel="noopener">GitHub</a>.</li></ul></details>
</section>`;

  const pipeline = `<section class="tab" id="pipeline"><h2 class="tabtitle">Pipeline</h2>
<div class="cols">
  <div class="panel"><div class="ph"><h2>Ready</h2><span class="r num">${c("ready")}</span></div>${taskList(s.ready.map((t) => taskRow(t, `p${t.priority} · ${ago(t.created_at, now).replace(" ago", "")}${t.deps && t.deps !== "[]" ? " · deps" : ""}`)), "nothing ready — the manager plans more on its next run")}${more(c("ready"), s.ready.length, "ready")}</div>
  <div class="panel"><div class="ph"><h2>In progress</h2><span class="r num">${inProgress}</span></div>${taskList(s.running.map((t) => taskRow(t, `${esc(workerName(t.worker_id ?? "?"))} · ${ago(t.claimed_at, now).replace(" ago", "")}`, s.progress[String(t.id)] ? liveLine(s.progress[String(t.id)], now, true) : `<span class="dim">${esc(t.status)} · attempt ${t.attempt}</span>`)), sp.pacing ? "nothing running · workers paused by the daily pace" : "nothing running")}</div>
  <div class="panel"><div class="ph"><h2>Review</h2><span class="r num">${c("review")}</span></div>${taskList(s.reviewQueue.map((t) => taskRow(t, `${ago(t.submitted_at, now).replace(" ago", "")} · attempt ${t.attempt}`)), "queue empty")}${more(c("review"), s.reviewQueue.length, "review")}</div>
  <div class="panel"><div class="ph"><h2>Accepted</h2><span class="r num">${c("accepted")}</span></div>${taskList(s.recentAccepted.map((t) => taskRow(t, `${ago(t.finished_at, now).replace(" ago", "")} · ${usd(t.cost_usd, 3)}${t.attempt > 1 ? ` · ${t.attempt} attempts` : ""}`)), "nothing accepted yet")}${more(c("accepted"), s.recentAccepted.length, "accepted")}</div>
  <div class="panel"><div class="ph"><h2>Blocked</h2><span class="r num">${c("blocked")}</span></div>${taskList(s.blocked.map((t) => taskRow(t, `attempt ${t.attempt}`, esc(t.last_error ?? ""))), "nothing blocked")}${more(c("blocked"), s.blocked.length, "blocked")}</div>
</div>
<p class="muted small" style="margin:10px 0 0">ready → claimed / running → review → accepted, or blocked when the attempts run out. Dropped tasks (${dropped}: cancelled or rejected for good) only appear in the goals table.</p>
</section>`;

  const agents = `<section class="tab" id="agents"><h2 class="tabtitle">Agents</h2>
<div class="panel"><div class="ph"><h2>Manager</h2><span class="r">Claude · reviews at most 8 deliverables per run, plans when a goal runs low</span></div>${managerCard(s, now)}</div>
<div class="panel"><div class="ph"><h2>Workers</h2><span class="r">live · refreshes every 20 s while this tab is open</span></div><div id="agents-full">${renderAgents(s, now, true)}</div>
<p class="muted small" style="margin:10px 0 0">Each worker posts a snapshot of its opencode session after every finished step (at most every 30 s): the step, the tool call in progress, tokens and cost so far, and the last 30 events. Done and failed count attempts (handed in for review, or ended without a submission); accepted work is in the goals table. Full transcripts: the opencode web UI on the VM (worker/README.md).</p></div>
</section>`;

  const goalsTab = `<section class="tab" id="goals"><h2 class="tabtitle">Goals</h2>
<div class="panel"><div class="ph"><h2>Progress</h2><span class="r">from <a href="${REPO}/blob/main/GOALS.md" rel="noopener">GOALS.md</a>, synced by the manager every run · <a class="btn mini" href="/goals">Edit goals</a></span></div>${goalsTable}</div>
${s.goals
  .map((g) => {
    const body = g.body
      .split("\n")
      .filter((l) => !/^- (status|min_ready|done-when):/.test(l))
      .join("\n")
      .trim();
    return `<div class="panel"><div class="ph"><h2><span class="chip ${["A", "B", "X"].includes(g.id) ? g.id : "o"}">${esc(g.id)}</span>${esc(g.title)} ${statusPill(g.status)}</h2><span class="r">min ready ${g.min_ready}${g.catalog_size ? ` · catalog ${g.catalog_size}` : ""} · synced ${ago(g.updated_at, now)}</span></div>${g.done_when ? `<div class="kv"><span>done when <b>${esc(g.done_when)}</b></span></div>` : ""}<div class="md">${md(body) || `<p class="empty">empty body</p>`}</div></div>`;
  })
  .join("")}
</section>`;

  const kinds = Array.from(new Set(s.events.map((e) => e.kind))).sort();
  const activity = `<section class="tab" id="activity"><h2 class="tabtitle">Activity</h2>
<div class="panel"><div class="ph"><h2>Activity</h2><span class="r">last ${s.events.length} events · <span id="log-count"></span></span></div>
<div class="filters" id="log-filters"><input type="search" id="log-q" placeholder="filter text…" aria-label="filter text"><a href="#activity" data-preset="all">all</a><span class="sep">·</span><a href="#activity" data-preset="verdicts">manager</a><span class="sep">·</span><a href="#activity" data-preset="workers">workers</a><span class="sep">|</span>${kinds.map((kd) => `<label class="on"><input type="checkbox" data-kind="${esc(kd)}" checked> ${esc(kindLabel(kd))}</label>`).join("")}</div>
<ul class="evt" id="log-list">${s.events.length ? eventList(s.events) : `<li class="empty">nothing yet</li>`}</ul>
<p class="muted small" style="margin:10px 0 0">Times are UTC. Older events: <code>scripts/board.sh events 200</code>.</p></div>
</section>`;

  const days = sp.days.slice().reverse();
  const maxDay = Math.max(sp.paceUsdPerDay, ...days.map((d) => d.usd));
  const budget = `<section class="tab" id="budget"><h2 class="tabtitle">Budget</h2>
<div class="grid">
  <div class="panel"><div class="ph"><h2>OpenCode Go</h2><span class="r">DeepSeek V4.1 Flash · the workers' allowance</span></div>
    ${bar("today", sp.todayUsd, sp.paceUsdPerDay)}${bar("5 h", sp.fiveHourUsd, 12)}${bar("week", sp.weekUsd, 30)}${bar("month", sp.monthUsd, 60)}
    <div class="kv"><span>tasks today <b>${sp.todayTasks}</b></span><span>avg per task <b>${usd(sp.todayTasks ? sp.todayUsd / sp.todayTasks : 0, 3)}</b></span><span>in flight est. <b>${usd(sp.inflightEstimateUsd)}</b></span><span>daily pace <b>${usd(sp.paceUsdPerDay)}</b></span></div>
    ${sp.pacing ? `<span class="pill warn">paused</span> <span class="muted small">${esc(sp.pacing.reason)}</span>` : `<span class="pill ok">within pace</span>`}
    <p class="muted small" style="margin:10px 0 0">${sp.paceMode === "smooth" ? `Smooth pace: 20 % of the day's pace is released at 00:00 UTC and the rest hour by hour (${usd(sp.allowedNowUsd)} released so far), so the workers stay busy all day instead of spending everything in the first hours.` : "Burst pace: the whole day's pace is available from 00:00 UTC."} Claims also stop when a Go window (5 h $12, week $30, month $60) is at 90 %; the manager moves the pace between $0.50 and $2.50, and <code>scripts/board.sh pace-mode</code> switches the mode. Peak pricing ×2 on weekdays 01–04 and 06–10 UTC.</p>
  </div>
  <div class="panel"><div class="ph"><h2>Last 7 days</h2><span class="r">UTC · spend and attempts ended</span></div>
    <div class="days">${days.map((d) => `<div class="d"><span>${esc(d.day.slice(5))}${d.day === cf.day ? " <span class=\"dim\">today</span>" : ""}</span>${meter(d.usd, maxDay, 2, 2)}<b>${usd(d.usd, 3)}</b><span class="right">${d.tasks}</span></div>`).join("")}</div>
    <p class="muted small" style="margin:10px 0 0">A task counts on the day its attempt ended (submitted or failed). Totals are running counters, so pacing never sums the spend log.</p>
  </div>
  <div class="panel"><div class="ph"><h2>System</h2><span class="r">Cloudflare free tier · resets 00:00 UTC</span></div>
    <div class="bar"><span>reads</span>${meter(cf.reads, cf.readLimit)}<b>${k(cf.reads)} / ${(cf.readLimit / 1e6).toFixed(0)}M rows</b></div>
    <div class="bar"><span>writes</span>${meter(cf.writes, cf.writeLimit)}<b>${k(cf.writes)} / ${(cf.writeLimit / 1e3).toFixed(0)}k rows</b></div>
    <p class="muted small" style="margin:10px 0 0">One SQLite Durable Object: 5M row reads and 100k row writes a day. Every query is index-bounded, this page is cached for 60 s, the live view costs a handful of reads per poll, and progress snapshots are overwritten rather than appended. Above 4.5M reads the board stops handing out tasks so the page stays reachable.</p>
  </div>
</div>
</section>`;

  const body = `
<header class="hdr"><div><h1>Agent board</h1><div class="sub">Claude manager · two DeepSeek V4.1 Flash workers on opencode · Cloudflare</div></div>
<div class="hdr-r"><span><span class="dot ${busy ? "pulse" : "idle"}"></span> updated <span id="updated">just now</span></span><a href="/api/status">JSON</a><button class="mini" id="theme" type="button" title="theme: system / light / dark">theme</button></div></header>
${strip}
${nav}
${overview}
${pipeline}
${agents}
${goalsTab}
${activity}
${budget}
<footer><span>rendered ${when(now)}</span><a href="${REPO}" rel="noopener">source</a><a href="/api/status">status JSON</a></footer>
<script>${STATUS_JS}</script>`;
  return shell(`Agent board · ${inProgress} running · ${c("ready")} ready`, body, 60);
}

/** The live section of a task page; served alone at /live/tasks/:id for the page's 15-second poll. */
export function renderTaskLive(d: { task: Pick<TaskRow, "id" | "key" | "status" | "worker_id" | "attempt" | "claimed_at" | "lease_until">; progress: ProgressSnapshot | null }, now: number): string {
  const t = d.task;
  const p = d.progress;
  const active = t.status === "claimed" || t.status === "running";
  const head = active
    ? `<span class="dot pulse"></span> ${esc(workerName(t.worker_id ?? "?"))} · ${esc(t.status)} · attempt ${t.attempt} · claimed ${ago(t.claimed_at, now)} · lease ends ${ago(t.lease_until, now)}`
    : p
      ? `attempt ${p.attempt} · ${esc(workerName(p.worker_id))} · ${esc(p.phase === "running" ? "stopped" : p.phase)} · ${dur(p.elapsed_s)}`
      : "";
  if (!p) return `<div data-status="${esc(t.status)}"><span class="muted">${head}${active ? " · waiting for the worker's first progress post" : "no session snapshot"}</span></div>`;
  const stats = `<div class="kv"><span>step <b>${p.step}</b></span><span>tool calls <b>${p.tools}</b></span><span>elapsed <b>${dur(liveElapsed(p, now, active))}</b></span><span>tokens <b>${p.tokens_in + p.tokens_out}</b> (${p.tokens_cached} cached)</span><span>cost so far <b>${usd(p.cost_usd, 3)}</b></span><span>posted <b>${ago(p.updated_at, now)}</b></span>${p.session_url ? `<span><a href="${esc(p.session_url)}" rel="noopener">worker session transcript ↗</a></span>` : p.session_id ? `<span>session <b>${esc(p.session_id)}</b></span>` : ""}</div>`;
  return `<div data-status="${esc(t.status)}"><div class="muted small">${head}</div>${stats}<div style="margin-top:6px">${liveLine(p, now, active)}</div><h3>Last ${p.events.length} events</h3>${liveFeed(p)}</div>`;
}

export function renderTaskPage(d: { task: TaskRow & { deps: number[] }; reviews: ReviewRow[]; deliverable: (Omit<DeliverableRow, "files"> & { files: Record<string, string> }) | null; progress?: ProgressSnapshot | null }, now: number): string {
  const t = d.task;
  const files = d.deliverable ? Object.entries(d.deliverable.files) : [];
  const active = t.status === "claimed" || t.status === "running";
  const progress = d.progress ?? null;
  const live = active || progress ? `<div class="panel"><div class="ph"><h2>${active ? "Live session" : "Last session"}</h2><span class="r">${active ? "updates every 15 s" : `attempt ${progress?.attempt ?? t.attempt}`}</span></div><div id="task-live" data-task="${t.id}">${renderTaskLive({ task: t, progress }, now)}</div></div>` : "";
  const acceptanceLines = t.acceptance.split("\n").map((l) => l.trim()).filter(Boolean);
  const checklist = acceptanceLines.length && acceptanceLines.every((l) => /^[-*] /.test(l)) ? `<ul class="checks">${acceptanceLines.map((l) => `<li>${esc(l.replace(/^[-*] /, ""))}</li>`).join("")}</ul>` : `<pre>${esc(t.acceptance)}</pre>`;
  const body = `
<header class="hdr"><div><div class="sub"><a href="/">← board</a> · <a href="/#pipeline">pipeline</a></div><h1>${esc(t.title)}</h1><div class="sub">${chip(t.key, t.goal_id)}<span class="mono">${esc(t.key)}</span> ${statusPill(t.status)}</div></div><div class="hdr-r"><a href="/api/tasks/${t.id}">JSON</a></div></header>
<div class="panel">
  <div class="kv"><span>goal <b>${esc(t.goal_id)}</b></span><span>kind <b>${esc(t.kind)}</b></span><span>priority <b>${t.priority}</b></span><span>attempt <b>${t.attempt} / ${t.max_attempts}</b></span><span>budget <b>${t.max_minutes} min</b></span><span>worker <b>${esc(t.worker_id ? workerName(t.worker_id) : "—")}</b></span><span>cost <b>${usd(t.cost_usd, 3)}</b></span><span>tokens <b>${t.tokens_in + t.tokens_out}</b> (${t.tokens_cached} cached)</span><span>steps <b>${t.steps}</b></span><span>updated <b>${ago(t.updated_at, now)}</b></span>${t.deps.length ? `<span>depends on <b>${t.deps.map((x) => `<a href="/tasks/${x}">#${x}</a>`).join(", ")}</b></span>` : ""}</div>
  ${t.last_error ? `<div class="banner warn" style="margin:8px 0 0">${esc(t.last_error)}</div>` : ""}
  <h3>Spec</h3><pre>${esc(t.spec)}</pre>
  <h3>Acceptance criteria</h3>${checklist}
</div>
${live}
<div class="panel"><div class="ph"><h2>Reviews</h2><span class="r">${d.reviews.length ? `${d.reviews.length} verdict${d.reviews.length === 1 ? "" : "s"}` : "not reviewed yet"}</span></div>${d.reviews.length ? `<ul class="reviews">${d.reviews.map((r) => `<li><span>${statusPill(r.verdict === "accept" ? "accepted" : "rejected")}</span><span><span class="muted small">${when(r.created_at)} · attempt ${r.attempt} · ${esc(r.who)}</span>${r.notes ? `<pre>${esc(r.notes)}</pre>` : ""}</span></li>`).join("")}</ul>` : `<div class="empty">waiting for the manager</div>`}</div>
<div class="panel"><div class="ph"><h2>Deliverable</h2><span class="r">${d.deliverable ? `attempt ${d.deliverable.attempt} · ${d.deliverable.nfiles} files · ${Math.round(d.deliverable.bytes / 1024)} KB${d.deliverable.truncated ? " · truncated" : ""}${d.deliverable.session_url ? ` · <a href="${esc(d.deliverable.session_url)}" rel="noopener">worker session transcript ↗</a>` : d.deliverable.session_id ? ` · session ${esc(d.deliverable.session_id)}` : ""}` : ""}</span></div>
  ${d.deliverable ? `<h3>Report</h3><pre>${esc(d.deliverable.report)}</pre><h3>Files</h3>${files.map(([p, c]) => `<details class="fold"><summary>${esc(p)} <span class="dim">(${c.length} chars)</span></summary><pre>${esc(c)}</pre></details>`).join("") || `<div class="empty">no files</div>`}` : `<div class="empty">nothing submitted yet</div>`}
</div>${active ? `<script>${LIVE_TASK_JS}</script>` : ""}`;
  return shell(`${t.key} · Agent board`, body, active ? 30 : null);
}

/** /goals — GOALS.md as a form that commits to the repository (or read-only when no GitHub token is configured). */
export function renderGoalsPage(d: {
  text: string;
  sha: string | null;
  editable: boolean;
  repo: string;
  branch: string;
  path: string;
  error?: string | null;
  saved?: { sha: string; url: string } | null;
  loadError?: string | null;
}): string {
  const fileUrl = `https://github.com/${d.repo}/blob/${d.branch}/${d.path}`;
  const historyUrl = `https://github.com/${d.repo}/commits/${d.branch}/${d.path}`;
  const banner = d.saved
    ? `<div class="banner ok">Saved as commit <a href="${esc(d.saved.url)}" rel="noopener"><code>${esc(d.saved.sha.slice(0, 7))}</code></a> on <code>${esc(d.branch)}</code>. The push wakes the manager: within a minute or two it re-reads the goals and reconciles the board (cancels ready tasks that no longer fit, re-specs changed acceptance rules, plans new items). Watch <a href="/#activity">activity</a> for the next manager run.</div>`
    : d.error
      ? `<div class="banner bad">Not saved: ${esc(d.error)}</div>`
      : d.loadError
        ? `<div class="banner bad">Could not load ${esc(d.path)} from GitHub: ${esc(d.loadError)}</div>`
        : "";
  const setup = d.editable
    ? ""
    : `<div class="banner warn"><b>Read-only.</b> The board has no GitHub token, so this page cannot commit. To enable saving: create a <a href="https://github.com/settings/personal-access-tokens/new" rel="noopener">fine-grained personal access token</a> for the repository <code>${esc(d.repo)}</code> only, with <b>Contents: read and write</b> (nothing else), then run <code>npx wrangler secret put GITHUB_TOKEN</code> in the repo and paste it. Until then, edit <a href="${esc(fileUrl)}" rel="noopener">GOALS.md on GitHub</a> or push with git.</div>`;
  const body = `
<header class="hdr"><div><div class="sub"><a href="/">← board</a> · <a href="/#goals">goals</a></div><h1>Goals editor</h1><div class="sub"><code>${esc(d.path)}</code> on <code>${esc(d.repo)}</code>@<code>${esc(d.branch)}</code> · <a href="${esc(fileUrl)}" rel="noopener">file</a> · <a href="${esc(historyUrl)}" rel="noopener">history</a></div></div></header>
${banner}${setup}
<div class="panel">
<form id="goals-form" method="post" action="/goals">
<input type="hidden" name="sha" value="${esc(d.sha ?? "")}">
<textarea name="content" spellcheck="false" ${d.editable ? "" : "readonly"} aria-label="GOALS.md">${esc(d.text)}</textarea>
<div class="row"><label>commit message <input type="text" name="message" value="GOALS.md: edit from the board" size="40" ${d.editable ? "" : "disabled"}></label><label>board token <input type="password" name="token" autocomplete="current-password" required ${d.editable ? "" : "disabled"}></label><a href="#" id="forget-token" class="muted small">forget token</a></div>
<div class="row"><button class="primary" ${d.editable ? "" : "disabled"}>Save to ${esc(d.branch)}</button><span id="goals-dirty" class="muted small"></span></div>
</form></div>
<details class="help"><summary>How goals work</summary><ul>
<li>This file is the only human input. The manager clones the repository fresh every run and syncs it into the board: one <code>## Goal &lt;id&gt;: &lt;title&gt;</code> section per goal; the lines <code>- status:</code> (active, paused or done), <code>- min_ready:</code> and <code>- done-when:</code> are parsed; everything else in the section is the goal body the manager plans from. A "Catalog" paragraph with <code>- category: item, item</code> lines gives the goal a progress bar.</li>
<li>Saving here makes one commit on <code>${esc(d.branch)}</code> (git history is the audit trail), and the push wakes the manager within about a minute. When the file changed since its last run, the manager reconciles the board before planning: it cancels ready tasks that no longer fit, re-specs ready tasks whose acceptance rules changed, and treats new catalog items or goals as planning input. Removing a section pauses that goal. Work in progress is never interrupted.</li>
<li>The board token is the manager's <code>ORCHESTRATOR_TOKEN</code> (from <code>.dev.vars</code>); this browser remembers it once you save.</li></ul></details>
<script>${GOALS_JS}</script>`;
  return shell("Goals editor · Agent board", body, null);
}

/** /docs/<id> — a manager-maintained brief, rendered from markdown, with its change log. */
export function renderDocPage(d: DocRow, now: number): string {
  const body = `
<header class="hdr"><div><div class="sub"><a href="/">← board</a> · brief</div><h1>${esc(d.title)}</h1><div class="sub">version ${d.version} · updated ${ago(d.updated_at, now)} (${when(d.updated_at)}) · ${Math.round(d.bytes / 1024)} KB${d.note ? ` · ${esc(d.note)}` : ""}</div></div><div class="hdr-r"><a href="/docs/${esc(d.id)}.md">markdown</a><a href="/api/docs/${esc(d.id)}">JSON</a></div></header>
<div class="panel doc"><div class="md">${md(d.body)}</div></div>
<div class="panel"><div class="ph"><h2>Changes</h2><span class="r">the manager rewrites this brief in place after reviewing new memos; this is its change log</span></div><ul class="evt">${d.log
  .slice()
  .reverse()
  .map((l) => `<li><time title="${when(l.ts)}">${when(l.ts).slice(5, 16)}</time><span><span class="kind">v${l.version}</span>${esc(l.note ?? "no note")}<span class="who">${Math.round(l.bytes / 1024)} KB</span></span></li>`)
  .join("") || `<li class="empty">no changes recorded</li>`}</ul></div>`;
  return shell(`${d.title} · Agent board`, body, null);
}

/** Result of the wake button (plain page so it works without JS). */
export function renderWakeResult(d: { ok: boolean; message: string; sessionUrl?: string | null; status: number }): string {
  const body = `<header class="hdr"><div><div class="sub"><a href="/">← board</a></div><h1>Wake the manager</h1></div></header>
<div class="banner ${d.ok ? "ok" : d.status === 200 || d.status === 409 || d.status === 429 ? "warn" : "bad"}">${esc(d.message)}${d.sessionUrl ? ` <a href="${esc(d.sessionUrl)}" rel="noopener">open the run ↗</a>` : ""}</div>
<p class="muted">Other ways to wake it: push to <code>main</code> (the GitHub trigger fires the routine), <code>scripts/board.sh wake "reason"</code>, or wait for the :13 / :43 schedule. Details in <code>manager/ROUTINE.md</code>.</p>`;
  return shell("Wake · Agent board", body, null);
}

export function renderNotFound(): string {
  return shell("Not found", `<header class="hdr"><div><div class="sub"><a href="/">← board</a></div><h1>Not found</h1></div></header>`, null);
}

export function renderUnavailable(error: string): string {
  const cap = /rows read/i.test(error);
  const body = `<header class="hdr"><div><h1>Agent board</h1><div class="sub">temporarily unavailable</div></div></header>
<div class="panel"><h2>${cap ? "Cloudflare free-tier daily read limit reached" : "Board error"}</h2>
<p>${esc(error)}</p>
${cap ? `<p class="muted">The Durable Object's daily row-read allowance is exhausted. It resets at 00:00 UTC; the workers and the manager retry on their own and the board comes back by itself. This page refreshes every 5 minutes.</p>` : ""}</div>`;
  return shell("Agent board · unavailable", body, 300);
}
