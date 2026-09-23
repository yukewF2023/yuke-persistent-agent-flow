# Manager routine

The manager is the existing Claude Code cloud routine `trig_0144Fo1i6xENAvLa58h3BBQ1` ("Persistent agents orchestrator"), repurposed on 2026-09-23:

- schedule: every 30 minutes (if the API refuses sub-hourly crons, two hourly routines offset by 30 minutes share the board's manager lock)
- model: claude-sonnet-5; tools: Bash, Read, Write, Glob, Grep
- repo: `yukewF2023/yuke-persistent-agent-flow` (cloned fresh each run, so the prompt, `GOALS.md` and `scripts/board.sh` must be pushed)
- environment `env_01HUXQno31z13QhWv3CBREm6`: env vars `WORKER_URL` and `ORCHESTRATOR_TOKEN`; network access allows the Worker host (npm and PyPI are on the sandbox's default allowlist)
- kickoff prompt: check the env vars exist, `chmod +x scripts/board.sh`, then read `manager/PROMPT.md` and follow it

Manage it at https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1. Run it by hand from a laptop with `scripts/board.sh manager-now` (same prompt through the local `claude` CLI; needs `claude login`).

Debugging a run: the routine's session log shows every command; on the board, the `run` event it posts at the end summarizes verdicts and additions, and `manager:memory` holds its cursor.
