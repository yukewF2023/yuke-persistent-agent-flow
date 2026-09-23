# Manager routine

The manager runs as **two Claude Code cloud routines** that share the board's manager lock (the routine API refuses crons shorter than 1 hour, so two hourly routines offset by 30 minutes give a 30-minute cadence):

- `trig_0144Fo1i6xENAvLa58h3BBQ1` "Agent board manager (:13)" — cron `13 * * * *` (the original orchestrator routine, repurposed on 2026-09-23)
- `trig_019wCc3dqf85HAAtkfDTwUtG` "Agent board manager (:43)" — cron `43 * * * *` (created 2026-09-23)

Both:

- model: claude-sonnet-5; tools: Bash, Read, Write, Glob, Grep
- repo: `yukewF2023/yuke-persistent-agent-flow` (cloned fresh each run, so the prompt, `GOALS.md` and `scripts/board.sh` must be pushed)
- environment `env_01HUXQno31z13QhWv3CBREm6`: env vars `WORKER_URL` and `ORCHESTRATOR_TOKEN`; network access allows the Worker host (npm and PyPI are on the sandbox's default allowlist)
- kickoff prompt: check the env vars exist, `chmod +x scripts/board.sh`, then read `manager/PROMPT.md` and follow it

Manage them at https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1 and https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG. Neither has MCP connectors; tools are Bash, Read, Glob, Grep (the manager writes its temp files through Bash). Run it by hand from a laptop with `scripts/board.sh manager-now` (same prompt through the local `claude` CLI; needs `claude login`).

Debugging a run: the routine's session log shows every command; on the board, the `run` event it posts at the end summarizes verdicts and additions, and `manager:memory` holds its cursor.
