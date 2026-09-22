# Orchestrator routine

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

## Fallback: run it from the Mac
`scripts/orch.sh manager-now` runs the same prompt with the local `claude` CLI (headless, `-p`). To schedule it locally, add a launchd job that calls that command every 6 h while the Mac is awake.

## Talking to the manager
Anything you tell it lands in the Worker's feedback mailbox and is read on the next run:
- the private picks page (buttons + text box): `scripts/orch.sh picks-link`
- `scripts/orch.sh feedback "more outdoors, fewer coffee things"`
- a plain-text comment on the **Weekend picks** or **Team log** issue
- editing `orchestrator/GOALS.md`
For "act now", run `scripts/orch.sh manager-now`.
