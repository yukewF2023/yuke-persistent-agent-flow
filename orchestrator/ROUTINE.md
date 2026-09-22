# Orchestrator routine

**Created 2026-09-22:** routine `trig_0144Fo1i6xENAvLa58h3BBQ1` ("Persistent agents orchestrator"), cron `22 */6 * * *` UTC (the server offsets the minute), model claude-sonnet-5, repo `yukewF2023/yuke-persistent-agent-flow`, tools Bash/Read/Glob/Grep, environment Default, no MCP connectors. Manage it at https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1. The Worker URL and admin token live in the routine's private prompt (routines have no secret store); rotate the token with `wrangler secret put ORCHESTRATOR_TOKEN` + update the routine if it ever leaks.

The manager runs as a Claude Code **scheduled cloud routine** every 6 hours with this repo checked out.

## Create it
1. Deploy the Worker and note its URL (`https://yuke-persistent-agent-flow.<subdomain>.workers.dev`).
2. Push this repo to GitHub (`yukewF2023/yuke-persistent-agent-flow`, private) and create two issues labelled `agents`: **Team log** and **Weekend picks**.
3. In Claude Code, run `/schedule` and create a routine on this repo:
   - schedule: `0 */6 * * *` (every 6 h, UTC)
   - environment: `WORKER_URL=https://…workers.dev`, `ORCHESTRATOR_TOKEN=<from .dev.vars>` (as a secret)
   - prompt: the contents of `orchestrator/PROMPT.md` (or simply `Read orchestrator/PROMPT.md and follow it.`)
   - tools: shell (for `scripts/orch.sh` and `gh`), file read.
4. Run it once by hand and check the Team log issue for its first comment.

**Status 2026-09-22:** the routine is created but **paused**. Two runs (sessions `cse_01Ar2V85…`, `cse_01Sejsgz…`) failed the same way: the cloud sandbox's egress proxy rejects `yuke-persistent-agent-flow.yuke-521.workers.dev:443` with a 403 policy denial (fixed allowlist: Anthropic, npm, PyPI…), even with the URL declared on the routine; `gh` is also not installed there. To use the cloud routine, change the **Default** environment's network access at https://claude.ai/code/environments to allow the Worker host (or full network), then re-enable the routine. Until then, use the Mac fallback below.

## Fallback: run it from the Mac
`scripts/orch.sh manager-now` runs the same prompt with the local `claude` CLI (headless, `-p`); the CLI must be logged in (`claude login`). To schedule it: `scripts/install-launchd.sh` installs a launchd job that runs it every 6 h while the Mac is awake (logs in `/tmp/agents-orchestrator.log`).

## Talking to the manager
Anything you tell it lands in the Worker's feedback mailbox and is read on the next run:
- the private picks page (buttons + text box): `scripts/orch.sh picks-link`
- `scripts/orch.sh feedback "more outdoors, fewer coffee things"`
- a plain-text comment on the **Weekend picks** or **Team log** issue
- editing `orchestrator/GOALS.md`
For "act now", run `scripts/orch.sh manager-now`.
