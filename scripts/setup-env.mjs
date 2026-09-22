#!/usr/bin/env node
// Builds .dev.vars (gitignored) from the local OpenCode credential + random tokens,
// and prompts for the Tavily key if it is missing. Never prints secret values.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const DEV_VARS = new URL("../.dev.vars", import.meta.url).pathname;
const NO_PROMPT = process.argv.includes("--no-prompt");

const existing = {};
if (existsSync(DEV_VARS)) {
  for (const line of readFileSync(DEV_VARS, "utf8").split("\n")) {
    const m = /^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line.trim());
    if (m && m[2]) existing[m[1]] = m[2];
  }
}
const out = { ...existing };
const set = (k, v, how) => {
  if (out[k]) return console.log(`  ${k}: kept`);
  out[k] = v;
  console.log(`  ${k}: ${how}`);
};

// 1. OpenCode Go key from the opencode CLI credential store
try {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"));
  const key = auth["opencode-go"]?.key ?? auth["opencode"]?.key;
  if (key) set("OPENCODE_API_KEY", key, "copied from ~/.local/share/opencode/auth.json");
  else console.log("  OPENCODE_API_KEY: not found in auth.json — run `opencode auth login` (OpenCode Go)");
} catch {
  console.log("  OPENCODE_API_KEY: ~/.local/share/opencode/auth.json not readable — run `opencode auth login`");
}

// 2. Random tokens
const rand = () => randomBytes(24).toString("base64url");
set("ORCHESTRATOR_TOKEN", rand(), "generated");
set("PICKS_TOKEN", rand(), "generated");
set("NTFY_TOPIC", `yuke-picks-${randomBytes(6).toString("hex")}`, "generated (subscribe in the ntfy app)");

// 3. Keys that only the human has
const ask = async (k, hint) => {
  if (out[k]) return console.log(`  ${k}: kept`);
  if (NO_PROMPT || !stdin.isTTY) return console.log(`  ${k}: MISSING — add it to .dev.vars (${hint})`);
  const rl = createInterface({ input: stdin, output: stdout });
  const v = (await rl.question(`  Paste ${k} (${hint}) or press Enter to skip: `)).trim();
  rl.close();
  if (v) {
    out[k] = v;
    console.log(`  ${k}: set`);
  } else console.log(`  ${k}: skipped`);
};
await ask("TAVILY_API_KEY", "app.tavily.com, free plan");
await ask("TICKETMASTER_API_KEY", "optional, developer.ticketmaster.com");

const order = ["OPENCODE_API_KEY", "ORCHESTRATOR_TOKEN", "PICKS_TOKEN", "TAVILY_API_KEY", "NTFY_TOPIC", "TICKETMASTER_API_KEY"];
const body = order
  .filter((k) => out[k])
  .map((k) => `${k}="${out[k]}"`)
  .join("\n");
writeFileSync(DEV_VARS, body + "\n");
chmodSync(DEV_VARS, 0o600);
console.log(`\nWrote ${DEV_VARS} (mode 600). Push to Cloudflare with: npm run secrets:push`);
