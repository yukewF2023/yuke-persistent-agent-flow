#!/usr/bin/env node
// Board worker: claims one task at a time from the board and runs it in a fresh `opencode run` session
// (DeepSeek V4.1 Flash via OpenCode Go). State lives on the board; this process is disposable.
// Env: BOARD_URL, WORKER_TOKEN, WORKER_ID, OPENCODE_MODEL, WORK_ROOT, TEMPLATES, POLL_S, HEARTBEAT_S
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.2.0";
const env = process.env;
const BOARD_URL = (env.BOARD_URL ?? "").replace(/\/$/, "");
const TOKEN = env.WORKER_TOKEN ?? "";
const WORKER_ID = env.WORKER_ID ?? `${hostname()}-${process.argv[2] ?? "1"}`;
const HOST = hostname();
const MODEL = env.OPENCODE_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const WORK_ROOT = env.WORK_ROOT ?? "/srv/work";
const TEMPLATES = env.TEMPLATES ?? "/srv/templates";
const POLL_S = Number(env.POLL_S ?? 60);
const SESSION_API = env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4091"; // this worker's opencode-web@ instance; used only to read a session's share link
const STALL_MINUTES = Number(env.STALL_MINUTES ?? 12); // no opencode event for this long → kill and fail fast (the 45-min budget is for real work)
const HEARTBEAT_S = Number(env.HEARTBEAT_S ?? 120);
const FILES_MAX_BYTES = 800_000;
const FILES_MAX_COUNT = 200;
const FILE_MAX_BYTES = 200_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", ".pytest_cache", ".vitest"]);

if (!BOARD_URL || !TOKEN) {
  console.error("BOARD_URL and WORKER_TOKEN are required");
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString(), `[${WORKER_ID}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- board API ----
async function api(method, path, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(BOARD_URL + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { ok: res.ok, status: res.status, json, text };
    } catch (err) {
      log(`api ${method} ${path} failed (${attempt}/3): ${err.message}`);
      if (attempt === 3) return { ok: false, status: 0, json: null, text: String(err.message) };
      await sleep(5_000 * attempt);
    }
  }
}

// ---- pricing (DeepSeek V4.1 Flash on OpenCode Go; peak x2 weekdays 01–04 and 06–10 UTC) ----
const PRICE = { input: 0.21, output: 0.84, cacheRead: 0.021 };
function peakMultiplier(ts) {
  const d = new Date(ts);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();
  if (dow === 0 || dow === 6) return 1;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 2 : 1;
}
// opencode reports `input` as the uncached prompt tokens and `cache.read` separately (verified against its session API).
function stepCost(tokens, ts) {
  return (peakMultiplier(ts) * (tokens.input * PRICE.input + tokens.cacheRead * PRICE.cacheRead + (tokens.output + tokens.reasoning) * PRICE.output)) / 1e6;
}

/** If session sharing is enabled, the local opencode server knows the public transcript URL. */
async function sessionShareUrl(sessionID) {
  if (!sessionID) return null;
  try {
    const res = await fetch(`${SESSION_API}/session`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const list = await res.json();
    const s = Array.isArray(list) ? list.find((x) => x.id === sessionID) : null;
    return s?.share?.url ?? null;
  } catch {
    return null;
  }
}

// ---- workspace ----
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}
function link(target, path) {
  if (!existsSync(target) || existsSync(path)) return;
  try {
    symlinkSync(target, path);
  } catch (err) {
    log(`symlink ${path} failed: ${err.message}`);
  }
}
function prepareWorkspace(task, deps) {
  const ws = join(WORK_ROOT, `${task.id}-a${task.attempt}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  const wantTs = task.kind !== "py";
  const wantPy = task.kind === "py" || task.kind === "check";
  if (wantTs && existsSync(join(TEMPLATES, "ts"))) {
    cpSync(join(TEMPLATES, "ts"), ws, { recursive: true, filter: (src) => !src.includes("/node_modules") });
    link(join(TEMPLATES, "ts", "node_modules"), join(ws, "node_modules"));
  }
  if (wantPy && existsSync(join(TEMPLATES, "py"))) {
    cpSync(join(TEMPLATES, "py"), ws, { recursive: true, force: false, errorOnExist: false, filter: (src) => !src.includes("/.venv") });
    link(join(TEMPLATES, "py", ".venv"), join(ws, ".venv"));
  }
  if (existsSync(join(TEMPLATES, "run-tests"))) {
    cpSync(join(TEMPLATES, "run-tests"), join(ws, "run-tests"));
    chmodSync(join(ws, "run-tests"), 0o755);
  }
  mkdirSync(join(ws, "out"), { recursive: true });
  const depLines = [];
  for (const d of deps ?? []) {
    const dir = join(ws, "deps", safeName(d.key));
    for (const [p, content] of Object.entries(d.files ?? {})) {
      const rel = p.replace(/^\/+/, "").replace(/\.\.(\/|$)/g, "");
      const target = join(dir, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    if (d.report) writeFileSync(join(dir, "REPORT.md"), d.report);
    depLines.push(`- deps/${safeName(d.key)}/ — accepted deliverable of task #${d.id} (${d.key})`);
  }
  return { ws, depLines };
}
function taskMarkdown(task, reviews, depLines) {
  const prior = (reviews ?? []).filter((r) => r.verdict === "reject" && r.notes);
  return [
    `# Task ${task.key}: ${task.title}`,
    ``,
    `Goal: ${task.goal_id} · kind: ${task.kind} · attempt ${task.attempt} of ${task.max_attempts} · time budget: ${task.max_minutes} minutes.`,
    ``,
    `## What to do`,
    task.spec.trim(),
    ``,
    `## Acceptance criteria (the reviewer checks every line)`,
    task.acceptance.trim(),
    prior.length ? `\n## Notes from the previous review (that attempt was rejected — fix these first)\n${prior.map((r) => `- attempt ${r.attempt}: ${r.notes}`).join("\n")}` : "",
    depLines.length ? `\n## Dependencies available in this workspace\n${depLines.join("\n")}` : "",
    ``,
    `## Rules for this workspace`,
    `- Write EVERY deliverable file under \`out/\` (for example \`out/src/…\`, \`out/tests/…\`). Files outside \`out/\` are not collected.`,
    `- Finish by writing \`out/REPORT.md\` with the sections: Summary, Files, How I tested, Known gaps.`,
    `- Run tests only through \`./run-tests <command>\` (for example \`./run-tests npx vitest run\` or \`./run-tests .venv/bin/pytest -q\`); it serializes test runs on this small machine.`,
    `- Tooling is already installed: Node 22 with typescript, vitest and tsx (node_modules is linked), Python 3 with pytest and hypothesis (.venv is linked). Do not install global packages. No network access is needed.`,
    `- Keep it finished: a small, working, tested deliverable within the time budget beats a large unfinished one.`,
    `- Do not ask questions; make reasonable assumptions and state them in the report.`,
    ``
  ].join("\n");
}
function collectFiles(root) {
  const files = {};
  let bytes = 0;
  let count = 0;
  let truncated = false;
  const skipped = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(root, full);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > FILE_MAX_BYTES) {
        skipped.push(`${rel} (${st.size} bytes)`);
        truncated = true;
        continue;
      }
      const buf = readFileSync(full);
      if (buf.includes(0)) {
        skipped.push(`${rel} (binary)`);
        truncated = true;
        continue;
      }
      if (count >= FILES_MAX_COUNT || bytes + buf.length > FILES_MAX_BYTES) {
        skipped.push(`${rel} (over bundle cap)`);
        truncated = true;
        continue;
      }
      files["out/" + rel] = buf.toString("utf8");
      bytes += buf.length;
      count++;
    }
  };
  walk(root);
  return { files, bytes, count, truncated, skipped };
}

// ---- running one task ----
let stopping = false;
let current = null; // { task, child }

async function runTask(claim) {
  const { task, reviews, deps: depMeta } = claim;
  log(`claimed #${task.id} ${task.key} (attempt ${task.attempt}, ${task.max_minutes} min)`);
  const deps = [];
  for (const d of depMeta ?? []) {
    const r = await api("GET", `/worker/tasks/${d.id}/bundle`);
    if (r.ok && r.json) deps.push({ id: d.id, key: d.key, files: r.json.files, report: r.json.report });
    else log(`dependency #${d.id} bundle unavailable: ${r.status}`);
  }
  const { ws, depLines } = prepareWorkspace(task, deps);
  writeFileSync(join(ws, "TASK.md"), taskMarkdown(task, reviews, depLines));
  const started = Date.now();
  const startRes = await api("POST", `/worker/tasks/${task.id}/start`, { worker_id: WORKER_ID });
  if (!startRes.ok) {
    log(`start rejected (${startRes.status}); abandoning`);
    return;
  }

  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let opencodeCost = 0;
  let steps = 0;
  let tools = 0;
  let sessionID = null;
  let lastError = null;
  let lastTool = "";
  let stderrTail = "";
  let timedOut = false;
  let leaseLost = false;
  let stalled = false;
  let lastEventAt = Date.now();

  const prompt = "Read TASK.md in this directory and do exactly what it says. Work until the acceptance criteria are met, then make sure out/REPORT.md exists.";
  const args = ["run", "--auto", "--format", "json", "--model", MODEL, "--dir", ws, "--title", `task-${task.id}-${safeName(task.key)}`, prompt];
  const child = spawn("opencode", args, { cwd: ws, env: { ...env, HOME: env.HOME ?? "/home/agent", OPENCODE_DISABLE_AUTOUPDATE: "1", NODE_OPTIONS: "--max-old-space-size=384" }, stdio: ["ignore", "pipe", "pipe"] });
  current = { task, child };

  const hb = setInterval(async () => {
    const r = await api("POST", "/worker/heartbeat", { worker_id: WORKER_ID, host: HOST, version: VERSION, task_id: task.id, note: `step ${steps}${lastTool ? ` · ${lastTool}` : ""}` });
    if (r.status === 409) {
      leaseLost = true;
      log("lease lost; killing opencode");
      child.kill("SIGTERM");
    }
  }, HEARTBEAT_S * 1000);
  const timer = setTimeout(() => {
    timedOut = true;
    log(`time budget (${task.max_minutes} min) exceeded; stopping opencode`);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
  }, task.max_minutes * 60_000);
  const stallTimer = setInterval(() => {
    if (Date.now() - lastEventAt > STALL_MINUTES * 60_000) {
      stalled = true;
      log(`no opencode event for ${STALL_MINUTES} min (${steps} steps so far); stopping opencode`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
      clearInterval(stallTimer);
    }
  }, 30_000);

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.startsWith("{")) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.sessionID) sessionID = ev.sessionID;
    lastEventAt = Date.now();
    const part = ev.part ?? {};
    if (ev.type === "step_finish") {
      steps++;
      const t = part.tokens ?? {};
      const step = { input: Number(t.input ?? 0), output: Number(t.output ?? 0), reasoning: Number(t.reasoning ?? 0), cacheRead: Number(t.cache?.read ?? 0), cacheWrite: Number(t.cache?.write ?? 0) };
      tokens.input += step.input;
      tokens.output += step.output;
      tokens.reasoning += step.reasoning;
      tokens.cacheRead += step.cacheRead;
      tokens.cacheWrite += step.cacheWrite;
      cost += stepCost(step, ev.timestamp ?? Date.now());
      opencodeCost += Number(part.cost ?? 0);
    } else if (ev.type === "tool_use") {
      tools++;
      lastTool = String(part.tool ?? "tool");
      if (part.state?.status === "error") lastError = String(part.state.error ?? "tool error").slice(0, 300);
    } else if (ev.type === "error") {
      lastError = JSON.stringify(ev.error ?? ev).slice(0, 300);
    }
  });
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-8000);
  });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  clearInterval(hb);
  clearTimeout(timer);
  clearInterval(stallTimer);
  current = null;
  const durationS = Math.round((Date.now() - started) / 1000);
  log(`opencode exited ${exitCode} after ${durationS}s: ${steps} steps, ${tools} tool calls, ${tokens.input + tokens.output} tokens, $${cost.toFixed(4)}${sessionID ? ` (session ${sessionID})` : ""}`);

  if (leaseLost) {
    rmSync(ws, { recursive: true, force: true });
    return;
  }
  if (tokens.input + tokens.output === 0 && sessionID) {
    try {
      const exported = JSON.parse(execFileSync("opencode", ["export", sessionID], { encoding: "utf8", timeout: 30_000, env: { ...env, HOME: env.HOME ?? "/home/agent" } }));
      for (const msg of exported.messages ?? []) {
        const t = msg.info?.tokens ?? msg.tokens;
        if (!t) continue;
        const step = { input: Number(t.input ?? 0), output: Number(t.output ?? 0), reasoning: Number(t.reasoning ?? 0), cacheRead: Number(t.cache?.read ?? 0), cacheWrite: Number(t.cache?.write ?? 0) };
        tokens.input += step.input;
        tokens.output += step.output;
        tokens.reasoning += step.reasoning;
        tokens.cacheRead += step.cacheRead;
        cost += stepCost(step, Date.now());
      }
      log(`token usage recovered via export: ${tokens.input + tokens.output}`);
    } catch (err) {
      log(`export fallback failed: ${err.message}`);
    }
  }
  const usage = { steps, tokens_in: tokens.input, tokens_out: tokens.output + tokens.reasoning, tokens_cached: tokens.cacheRead, cost_usd: Number(cost.toFixed(6)), session_id: sessionID, session_url: await sessionShareUrl(sessionID), duration_s: durationS };
  const outDir = join(ws, "out");
  const collected = collectFiles(outDir);
  const reportPath = join(outDir, "REPORT.md");
  let report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  report += `\n\n---\nworker: ${WORKER_ID} · opencode exit ${exitCode} · ${durationS}s · ${steps} steps · ${tools} tool calls · tokens in ${tokens.input} (cached ${tokens.cacheRead}) out ${tokens.output + tokens.reasoning} · cost $${cost.toFixed(4)} (opencode says $${opencodeCost.toFixed(4)})${lastError ? `\nlast error: ${lastError}` : ""}${collected.skipped.length ? `\nfiles not bundled: ${collected.skipped.slice(0, 20).join(", ")}` : ""}`;

  const fail = async (error) => {
    log(`failing #${task.id}: ${error}`);
    await api("POST", `/worker/tasks/${task.id}/fail`, { worker_id: WORKER_ID, attempt: task.attempt, error: `${error}${stderrTail ? ` | stderr: ${stderrTail.slice(-300)}` : ""}`.slice(0, 500), ...usage });
    const keep = join(WORK_ROOT, "last-failed");
    rmSync(keep, { recursive: true, force: true });
    try {
      renameSync(ws, keep);
    } catch {}
  };
  if (stalled && collected.count === 0) return fail(`stalled: no opencode event for ${STALL_MINUTES} min (${steps} steps, exit ${exitCode})${lastError ? `: ${lastError}` : ""}`);
  if (timedOut && collected.count === 0) return fail(`timed out after ${task.max_minutes} min with no files under out/ (${steps} steps)`);
  if (collected.count === 0) return fail(`opencode exited ${exitCode} without writing any file under out/${lastError ? `: ${lastError}` : ""}`);
  if (timedOut || stalled) report += `\nNOTE: ${stalled ? "the session stalled and was stopped" : "the time budget ran out"}; this may be incomplete.`;
  const sub = await api("POST", `/worker/tasks/${task.id}/submit`, { worker_id: WORKER_ID, attempt: task.attempt, report: report.slice(0, 60_000), files: collected.files, truncated: collected.truncated, ...usage });
  if (!sub.ok) {
    log(`submit failed (${sub.status}): ${sub.text.slice(0, 200)}`);
    if (sub.status === 413) return fail(`deliverable too large (${collected.bytes} bytes); split the task`);
    return;
  }
  log(`submitted #${task.id} for review (${collected.count} files, ${collected.bytes} bytes)`);
  rmSync(ws, { recursive: true, force: true });
}

// ---- main loop ----
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  if (current) {
    try {
      current.child.kill("SIGTERM");
    } catch {}
    await api("POST", `/worker/tasks/${current.task.id}/release`, { worker_id: WORKER_ID, reason: `worker stopping (${signal})` });
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

mkdirSync(WORK_ROOT, { recursive: true });
log(`worker ${VERSION} starting: board ${BOARD_URL}, model ${MODEL}`);
let backoff = 30;
while (!stopping) {
  const r = await api("POST", "/worker/claim", { worker_id: WORKER_ID, host: HOST, version: VERSION });
  if (!r.ok || !r.json) {
    log(`claim failed (${r.status}): ${(r.text ?? "").slice(0, 160)}; retry in ${backoff}s`);
    await sleep(backoff * 1000);
    backoff = Math.min(300, backoff * 2);
    continue;
  }
  backoff = 30;
  if (!r.json.task) {
    const wait = Math.min(900, Math.max(15, Number(r.json.retry_after_s ?? POLL_S)));
    log(`${r.json.pacing ? "pacing" : "idle"}: ${r.json.reason} (next claim in ${wait}s)`);
    await sleep(wait * 1000);
    continue;
  }
  try {
    await runTask(r.json);
    if (env.ONCE === "1") {
      log("ONCE=1: exiting after one task");
      break;
    }
  } catch (err) {
    log(`task crashed: ${err.stack ?? err}`);
    if (r.json.task) await api("POST", `/worker/tasks/${r.json.task.id}/fail`, { worker_id: WORKER_ID, attempt: r.json.task.attempt, error: `worker crashed: ${String(err.message ?? err).slice(0, 300)}` });
    current = null;
    await sleep(10_000);
  }
}
