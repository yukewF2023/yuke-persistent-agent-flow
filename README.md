# yuke-persistent-agent-flow

A **task board** where a **Claude manager** plans and reviews work and **two DeepSeek V4.1 Flash workers** execute it around the clock. Built for the team ask: *"everyone runs two persistent agents with little oversight, on deepseek-flash-4-1 via OpenCode Go, doing literally anything."*

Live board: **https://yuke-persistent-agent-flow.yuke-521.workers.dev**

## In plain words

Think of a small team with one manager and two junior engineers who never sleep.

- **You** write what you want in one file, `GOALS.md`. Today that is Goal A, "build a tested TypeScript algorithms library, one module per item from this catalog", and Goal B, "port each accepted module to Python and prove both agree on random inputs".
- **The manager is Claude.** Twice an hour it wakes up in a fresh sandbox, reads the goals, and looks at the board. For every piece of work the engineers handed in, it downloads the files and actually runs the tests and type checks. If everything in the acceptance list holds, it accepts; if not, it sends the task back with numbered fixes; after three failed attempts it blocks the task and flags it for you. Then it looks at how many tasks are waiting and, if a goal is running low, writes the next few tasks from the catalog, each with a precise spec and a checklist. It saves a tiny note to itself and goes back to sleep.
- **The engineers are DeepSeek.** Two worker processes on a $3.65-a-month VM sit in a loop: ask the board for the next task, get a fresh folder with the spec, run an `opencode` session with DeepSeek V4.1 Flash that writes the code and runs the tests, package everything under `out/` plus a short report, hand it in, and ask for the next one. If a session hangs or the VM restarts, the lease expires and the task simply goes back on the board.
- **The board is a Cloudflare Worker.** It is the only shared memory: goals, tasks, who holds what, submitted files, reviews, a log, and spend. Its public page shows all of it live.
- **Money is the throttle.** Each task's tokens are priced at OpenCode Go rates and the board refuses new claims once the day's spend reaches the pace (default $1.60, about 20 tasks). So "constantly working" means the workers are always either running a task or waiting for budget, never waiting for a human.

Nothing remembers anything between sessions except the board: every opencode session and every manager run starts from scratch and reads the board. The board itself is durable SQLite inside a Cloudflare Durable Object, and the VM downloads a full copy every night to `/srv/backups`.

## Where to look

| What | Where |
|---|---|
| The board: workers, tasks in progress, review queue, accepted work, blocked tasks, spend, needs-a-human, live log | https://yuke-persistent-agent-flow.yuke-521.workers.dev |
| One task: spec, acceptance checklist, every review verdict, the report and the files | click any task on the board (`/tasks/<id>`) |
| The manager's runs, with full transcripts | https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1 (:13) and https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG (:43) |
| The workers' opencode sessions, with tool calls, tokens and cost | opencode web UI on the VM through an SSH tunnel, see [worker/README.md](worker/README.md); or public transcript links on task pages when `OPENCODE_SHARE=auto` |
| Raw worker logs | `gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo journalctl -u agent-worker@1 -u agent-worker@2 -f'` |
| Machine-readable status | https://yuke-persistent-agent-flow.yuke-521.workers.dev/api/status |
| Health snapshot with anomalies | `scripts/monitor.sh` |

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
| Cloudflare Worker + Durable Object | $0 (free tier: 5M row reads and 100k writes a day; the board uses well under 1M reads on a busy day, and the status page shows today's usage) |
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
