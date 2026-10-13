#!/usr/bin/env node
// search: live web search for `listen` tasks, through the board (which checks the task's key and budget and logs every
// call) and the agent-board app's research gateway (which runs it). Installed root-owned at /usr/local/bin/search.
// Env, set by the worker for `listen` tasks only: SEARCH_URL (the board's /search) and SEARCH_KEY (this task's key).
// No dependencies; Node 22.

const HELP = `usage:
  search x "<query>" [--days N] [--top]          X posts (Latest by default; --top for most engaged)
  search x-thread <post url or id>               the thread a post belongs to
  search x-replies <post url or id>              replies to a post, most relevant first
  search reddit "<query>"                        Reddit threads, through Google (any age: no date window)
  search web "<query>" [--days N] [--domains a.com,b.com]   articles, blogs, newsletters
  search news "<query>" [--days N]               news articles
  search hn "<query>" [--days N]                 Hacker News stories and comments (free)
  search hn-thread <item url or id>              a Hacker News discussion (free)
  search forum <retool|bubble|n8n> "<query>" [--days N]   a tool's community forum (free)
  search forum-topic <topic url>                 one forum topic's posts (free)
  search review <url>                            one review page on capterra.com or trustradius.com
--days defaults to 14 (at most 30). Each call prints its results, what it cost, and what is left of this attempt's budget.`;

const QUERY_SOURCES = new Set(["x", "reddit", "web", "news", "hn"]);
const URL_SOURCES = new Set(["x-thread", "x-replies", "hn-thread", "forum-topic", "review"]);
const TEXT_SHOWN = 400;

function fail(message, code = 2) {
  process.stderr.write(`search: ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
  process.stdout.write(HELP + "\n");
  process.exit(argv.length ? 0 : 2);
}
const { SEARCH_URL, SEARCH_KEY } = process.env;
if (!SEARCH_URL || !SEARCH_KEY) fail("live search is only available in listen tasks (SEARCH_URL and SEARCH_KEY are not set)");

const source = argv[0];
const body = {};
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--days") body.days = Number(argv[++i]);
  else if (a === "--top") body.top = true;
  else if (a === "--domains") body.domains = String(argv[++i] ?? "").split(",");
  else if (a.startsWith("--")) fail(`unknown option ${a}\n\n${HELP}`);
  else rest.push(a);
}
if (source === "forum") {
  body.forum = rest.shift();
  body.q = rest.join(" ");
} else if (QUERY_SOURCES.has(source)) body.q = rest.join(" ");
else if (URL_SOURCES.has(source)) {
  const target = rest.join(" ").trim();
  if (/^\d+$/.test(target)) body.id = target;
  else body.url = target;
} else fail(`unknown source ${source}\n\n${HELP}`);

let res;
try {
  res = await fetch(`${SEARCH_URL.replace(/\/$/, "")}/${source}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SEARCH_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  });
} catch (err) {
  fail(`the board did not answer (${err?.message ?? err}); try again in a minute, or carry on with what you have`, 1);
}
const out = await res.json().catch(() => ({}));
const left = out.remaining ? `left this attempt: ${out.remaining.calls} calls, $${Number(out.remaining.usd).toFixed(3)}` : "";
if (!res.ok) fail(`${out.error ?? `HTTP ${res.status}`}${left ? ` (${left})` : ""}`, 1);

const results = Array.isArray(out.results) ? out.results : [];
const lines = [];
results.forEach((r, i) => {
  const counts = Object.entries(r.engagement ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  lines.push(`[${i + 1}] ${r.url}${r.author ? ` · ${r.author}` : ""}${r.date ? ` · ${r.date}` : ""}${counts ? ` · ${counts}` : ""}`);
  if (r.title) lines.push(`    ${r.title}`);
  const text = String(r.text ?? "");
  if (text) lines.push(`    ${text.length > TEXT_SHOWN && source !== "review" ? `${text.slice(0, TEXT_SHOWN - 1)}…` : text}`);
});
lines.push(`— ${results.length} result${results.length === 1 ? "" : "s"} · cost $${Number(out.cost_usd ?? 0).toFixed(4)}${left ? ` · ${left}` : ""}`);
process.stdout.write(lines.join("\n") + "\n");
