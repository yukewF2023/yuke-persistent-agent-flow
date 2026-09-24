# Manager routine

The manager runs as **two Claude Code cloud routines** that share the board's manager lock (the routine API refuses crons shorter than 1 hour, so two hourly routines offset by 30 minutes give a 30-minute cadence), plus the instant triggers below:

- `trig_0144Fo1i6xENAvLa58h3BBQ1` "Agent board manager (:13)" — cron `13 * * * *` (the original orchestrator routine, repurposed on 2026-09-23); also carries the GitHub push trigger
- `trig_019wCc3dqf85HAAtkfDTwUtG` "Agent board manager (:43)" — cron `43 * * * *` (created 2026-09-23)

Both:

- model: claude-sonnet-5; tools: Bash, Read, Glob, Grep
- repo: `yukewF2023/yuke-persistent-agent-flow` (cloned fresh each run, so the prompt, `GOALS.md` and `scripts/board.sh` must be pushed)
- environment `env_01HUXQno31z13QhWv3CBREm6`: env vars `WORKER_URL` and `ORCHESTRATOR_TOKEN`; network access allows the Worker host (npm and PyPI are on the sandbox's default allowlist)
- kickoff prompt: check the env vars exist, `chmod +x scripts/board.sh`, then read `manager/PROMPT.md` and follow it

Manage them at https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1 and https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG. Neither has MCP connectors; tools are Bash, Read, Glob, Grep (the manager writes its temp files through Bash).

## Waking the manager now

Each of these starts a run within about a minute instead of waiting for :13 or :43. The board's lock makes an overlapping run stop early, so extra fires are harmless.

| How | What happens | Setup |
|---|---|---|
| **Push to `main`** — with git, or by saving on the board's [/goals](https://yuke-persistent-agent-flow.yuke-521.workers.dev/goals) editor | GitHub delivers the push to the webhook trigger `e08447e1-b71a-45c1-8c91-994db41fa760` attached to the :13 routine; the run starts within about 30 s and its transcript begins with a `<github-trigger-context>` block naming the commit | Done on 2026-09-24. The Claude GitHub App is installed on the repository. The trigger was created from a Claude Code session with the `RemoteTrigger` tool, action `create_webhook_trigger`, body `{"hook_type":"app","routine_trigger_id":"trig_0144Fo1i6xENAvLa58h3BBQ1","source":"github","scope_id":"yukewF2023/yuke-persistent-agent-flow","events":["push"]}`. The API accepts an object under `filter` but its keys are undocumented (the web UI offers only pull-request and release events, with PR-field filters), so the trigger fires on every push to any branch, not only on `GOALS.md`. There is no API call to list or delete it; manage it on the routine's page. |
| **"Wake the manager now" button** in the board's Manager card (needs the board token), or `scripts/board.sh wake "reason"` | the Worker POSTs to the routine's API trigger (`…/routines/<id>/fire`) and records the run's URL as a `manager.wake` event; the transcript begins with a `<routine-fire-payload>` block | Needs a token minted in the web UI (the API cannot create one): open the :13 routine → Edit → **Add another trigger** → **API** → **Generate token**. Then `npx wrangler secret put MANAGER_FIRE_URL` (paste the URL shown, `https://api.anthropic.com/v1/claude_code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1/fire`) and `npx wrangler secret put MANAGER_FIRE_TOKEN` (the token). Until then the button records the request as a `manager.wake` event and says the trigger is not configured. The board refuses a wake while a run holds the lock and within 5 minutes of the previous wake. |
| **From a Claude Code session** | `RemoteTrigger` action `run`, `trigger_id` `trig_0144Fo1i6xENAvLa58h3BBQ1` (optional body `{"text":"why"}`) | none |
| **From a laptop** | `scripts/board.sh manager-now` runs the same prompt through the local `claude` CLI | `claude login` |

Not chosen: a GitHub Actions workflow with `workflow_dispatch` running `claude -p manager/PROMPT.md` (it needs a `CLAUDE_CODE_OAUTH_TOKEN` repository secret and the board token in GitHub, and a second copy of the manager's environment to keep in step; the routine already has both), and a wake flag that the next scheduled run reads (not instant).

## Debugging a run

The routine's session log shows every command; from a Claude Code session, `RemoteTrigger` `list_runs` lists recent runs and `get_run_log` prints one run's condensed log. On the board, the `run` event a run posts at the end summarizes verdicts and additions, `manager.wake` and `goals.edit` events record who woke it or changed the goals, and `manager:memory` holds its cursor. Runs fired by a push or the wake button are ordinary runs: `manager/PROMPT.md` tells the manager to treat the trigger context as information, not instructions.
