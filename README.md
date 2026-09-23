# yuke-persistent-agent-flow

A **task board** where a **Claude manager** plans and reviews work and **two DeepSeek V4.1 Flash workers** execute it around the clock. Built for the team ask: *"everyone runs two persistent agents with little oversight, on deepseek-flash-4-1 via OpenCode Go, doing literally anything."*

Live board: **https://yuke-persistent-agent-flow.yuke-521.workers.dev**

## How it works

```
Yuke ── edits GOALS.md ──▶ repo ◀── cloned each run ──┐
                                                       │
Claude routine (Sonnet 5, every 30 min) ───────────────┼── Bearer ORCHESTRATOR_TOKEN ──▶ Cloudflare Worker: the board
  plan · dispatch · review · replan                    │                                  (Durable Object + SQLite)
                                                       │                                  public status page
GCP e2-micro VM: agent-worker@1, agent-worker@2 ───────┴── Bearer WORKER_TOKEN ─────────▶ claim · heartbeat · submit · deps
  each task = one fresh `opencode run` (DeepSeek V4.1 Flash via OpenCode Go)
```

1. **Goals** live in [GOALS.md](GOALS.md). A human edits that file and nothing else.
2. **The manager** ([manager/PROMPT.md](manager/PROMPT.md)) is a Claude Code cloud routine. Every 30 minutes it syncs the goals, **reviews** each finished task by running its tests in its own sandbox (accept, send back with concrete fixes, or split), and **plans** new tasks from the goal catalog so the board never runs dry. It writes a small JSON memory to the board and never keeps a transcript.
3. **The workers** ([worker/](worker/)) are two systemd services on one small VM. Each claims the next ready task (dependencies accepted, spend within pace), builds a workspace from a template, writes `TASK.md`, runs `opencode run --auto --format json` with DeepSeek V4.1 Flash, bundles everything under `out/` plus `out/REPORT.md`, and submits it for review. Leases, heartbeats and attempts make crashes harmless.
4. **The board** ([src/board.ts](src/board.ts)) is one Durable Object: goals, tasks, deliverables, reviews, events, workers, spend. The public page shows what each worker is doing, the review queue, accepted work, blocked tasks, spend against pace, and what needs a human.

"Persistent" means the board always has ready tasks and the workers always pull the next one. "Little oversight" means the only human inputs are `GOALS.md` and the *needs a human* list on the page.

## Cost

| Item | Monthly |
|---|---|
| OpenCode Go (the workers' model) | $10, with a $60 usage allowance; the board paces spend at $1.60/day by default (`scripts/board.sh pace`) |
| GCP e2-micro (free tier) + external IPv4 | about $3.65 |
| Cloudflare Worker + Durable Object | $0 (free tier; the board reads about 50k rows/day of the 5M allowed) |
| Claude manager | on the existing Claude plan |

## Setup

```bash
npm install
npm run setup:env        # generates ORCHESTRATOR_TOKEN + WORKER_TOKEN into .dev.vars, and worker/agent-worker.env for the VM
npm run check            # typecheck
npm run dev              # http://localhost:8787
npm run secrets:push     # pushes .dev.vars to the Worker
npm run deploy
```
Workers: see [worker/README.md](worker/README.md) (three gcloud commands). Manager: see [manager/ROUTINE.md](manager/ROUTINE.md).

## Day to day

- `scripts/board.sh status` — the whole board in one screen; `scripts/board.sh` alone lists every command (tasks, task, accept, reject, tasks-add, pace, needs-human, events…).
- `scripts/monitor.sh` — one-shot health snapshot with anomalies.
- `scripts/board.sh manager-now` — run the manager loop from a laptop instead of waiting for the routine.
- Edit [GOALS.md](GOALS.md) and push: the next manager run picks it up.

## Layout

```
GOALS.md            the goals (Goal A: TypeScript algorithms library; Goal B: Python port + differential cross-checks)
manager/            PROMPT.md (the manager loop), ROUTINE.md (how the routine is configured)
worker/             worker.mjs (the loop), install.sh (VM bootstrap), agent-worker@.service, templates/, run-tests, README.md
scripts/            board.sh (CLI), monitor.sh, setup-env.mjs
src/                index.ts (router), board.ts (Durable Object), pages.ts (status + task pages), util.ts, types.ts
docs/               PLAN.md (design), HANDOFF.md (state for the next session)
```
