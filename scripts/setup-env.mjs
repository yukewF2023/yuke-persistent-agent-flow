#!/usr/bin/env node
// Builds .dev.vars (Worker secrets, gitignored) and worker/agent-worker.env (the VM's env file, gitignored).
// Never prints secret values.
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DEV_VARS = new URL("../.dev.vars", import.meta.url).pathname;
const VM_ENV = new URL("../worker/agent-worker.env", import.meta.url).pathname;
const BOARD_URL = process.env.BOARD_URL ?? "https://yuke-persistent-agent-flow.yuke-521.workers.dev";

const parse = (path) => {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line.trim());
    if (m && m[2]) out[m[1]] = m[2];
  }
  return out;
};
const rand = () => randomBytes(24).toString("base64url");

// 1. Worker secrets
const vars = parse(DEV_VARS);
const keep = (k, v) => {
  if (vars[k]) return console.log(`  ${k}: kept`);
  vars[k] = v;
  console.log(`  ${k}: generated`);
};
keep("ORCHESTRATOR_TOKEN", rand());
keep("WORKER_TOKEN", rand());
for (const k of Object.keys(vars)) if (!["ORCHESTRATOR_TOKEN", "WORKER_TOKEN"].includes(k)) {
  delete vars[k];
  console.log(`  ${k}: dropped (no longer used by the Worker)`);
}
writeFileSync(DEV_VARS, Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
chmodSync(DEV_VARS, 0o600);
console.log(`Wrote ${DEV_VARS} (mode 600). Push with: npm run secrets:push`);

// 2. The VM's env file: board URL + worker token + the OpenCode Go key from the local opencode credential store
let goKey = parse(VM_ENV).OPENCODE_API_KEY ?? "";
if (!goKey) {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"));
    goKey = auth["opencode-go"]?.key ?? "";
  } catch {}
}
console.log(goKey ? "  OPENCODE_API_KEY: from ~/.local/share/opencode/auth.json" : "  OPENCODE_API_KEY: MISSING — run `opencode auth login` (OpenCode Go) and re-run");
mkdirSync(dirname(VM_ENV), { recursive: true });
writeFileSync(VM_ENV, [`BOARD_URL=${BOARD_URL}`, `WORKER_TOKEN=${vars.WORKER_TOKEN}`, `OPENCODE_API_KEY=${goKey}`, `OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash`].join("\n") + "\n");
chmodSync(VM_ENV, 0o600);
console.log(`Wrote ${VM_ENV} (mode 600). Ship it to the VM with worker/README.md's commands.`);
