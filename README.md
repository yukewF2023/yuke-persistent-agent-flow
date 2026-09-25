# yuke-persistent-agent-flow

A **task board** where a **Claude manager** plans and reviews work and **two DeepSeek V4.1 Flash workers** execute it around the clock. Built for the team ask: *"everyone runs two persistent agents with little oversight, on deepseek-flash-4-1 via OpenCode Go, doing literally anything."*

Live board: **https://yuke-persistent-agent-flow.yuke-521.workers.dev**

## In plain words

Think of a small team with one manager and two junior engineers who never sleep.

- **You** write what you want in one file, `GOALS.md`. Today that is Goal C, "a standing research desk on how DeepSpace wins business customers", and Goal D, the same for individual builders; the earlier Goal A (a TypeScript algorithms library) and Goal B (its Python port with cross-checks) are paused and can be switched back on with one line.
- **The manager is Claude.** Twice an hour (and within a minute of any push to `main`) it wakes up in a fresh sandbox, reads the goals, and looks at the board. For code tasks it downloads the files and actually runs the tests and type checks: accept, or send back with numbered fixes, or block after three attempts and flag it for you. For research tasks it reads the memo, keeps what is sourced and specific, and then rewrites the goal's **brief** on the board, a living one-page summary for you that it maintains in place (ranked recommendations, what we know, competitor table, open questions), never a growing log. Then it tops up the queue from the goal's catalog, in rounds, so the desk never runs dry. It saves a tiny note to itself and goes back to sleep.
- **The engineers are DeepSeek.** Two worker processes on a small VM sit in a loop: ask the board for the next task (worker 1 prefers Goal C, worker 2 prefers Goal D), get a fresh folder with the spec, run an `opencode` session with DeepSeek V4.1 Flash that does the work (code and tests, or web research and a memo), package everything under `out/` plus a short report, hand it in, and ask for the next one. If a session hangs or the VM restarts, the lease expires and the task simply goes back on the board.
- **The board is a Cloudflare Worker.** It is the only shared memory: goals, tasks, who holds what, submitted files, reviews, a log, and spend. Its public page shows all of it live.
- **Money is the throttle.** Each task's tokens are priced at OpenCode Go rates and the board releases the day's pace hour by hour (default $1.60 a day, 20 % at 00:00 UTC and the rest spread over the day), refusing new claims when spend runs ahead of it. So "constantly working" means the workers are always either running a task or waiting a few minutes for budget, never waiting for a human.

Nothing remembers anything between sessions except the board: every opencode session and every manager run starts from scratch and reads the board. The board itself is durable SQLite inside a Cloudflare Durable Object, and the VM downloads a full copy every night to `/srv/backups`.

## Board vocabulary

A task moves through these states:

| State | Meaning |
|---|---|
| ready | on the board, waiting for a worker; claimable only once every task it depends on is accepted, and only while its goal is active |
| claimed | a worker took it and holds a lease (45 minutes, extended by heartbeats) while it prepares the folder |
| running | the opencode session is going |
| review | the worker handed in files plus a report; waiting for the manager |
| accepted | the manager ran the checks and approved; final |
| blocked | the task used up its attempts, or a dependency was cancelled or blocked; it sits still and appears under *needs a human* until someone re-readies, splits or cancels it |
| cancelled | retired on purpose, for example after the manager split it into smaller tasks; never retried |
| rejected | the manager marked a rejection as final; never retried (rare) |

**Dropped**, in the goals table on the status page, is cancelled plus rejected: tasks that ended without ever being accepted.

**Attempt**: one worker claim plus one fresh opencode session on the task. An attempt ends in a submission (which goes to review) or a failure (crash, stall, timeout, or no files produced). A rejected review sends the task back to `ready` with the reviewer's numbered notes and spends the attempt; the retry starts from the previous attempt's files and only has to fix what the notes say. Tasks get 3 attempts by default (the manager or a human can raise it), then they are blocked.

**Worker counters**: *done* is the number of submissions that worker handed in for review, *failed* the number of its attempts that ended without a submission. Neither says anything about quality; the goals table's *accepted* column does.

**Lease**: while a worker holds a task it heartbeats every two minutes; if the worker dies, the lease expires and the task returns to `ready` on its own.

## Where to look

| What | Where |
|---|---|
| The briefs the manager maintains for you (one per research goal, rewritten in place, with a change log) | https://yuke-persistent-agent-flow.yuke-521.workers.dev/docs/gtm-b2b and `/docs/gtm-b2c`, listed under "Briefs for you" on the Overview; raw markdown at `/docs/<id>.md` |
| The board: a status strip (workers, ready, in progress, review, accepted today, blocked, spend, manager) above tabs: **Overview** (pipeline bar, agents, needs-attention, recent activity, goals progress), **Pipeline** (ready / in progress / review / accepted / blocked columns), **Agents** (the manager and each worker, live), **Goals** (progress and the goal bodies), **Activity** (every event, filterable), **Budget** (Go windows, last 7 days, Cloudflare free tier) | https://yuke-persistent-agent-flow.yuke-521.workers.dev — the tab is in the URL hash (`/#pipeline`, `/#agents`, `/#activity`…), so a bookmark opens straight to it; with JavaScript off the same page shows every section top to bottom |
| One task: spec, acceptance checklist, every review verdict, the report and the files | click any task on the board (`/tasks/<id>`) |
| What a worker is doing right now: step, current tool call, tokens and cost so far, the last 30 session events | the [Agents tab](https://yuke-persistent-agent-flow.yuke-521.workers.dev/#agents) (refreshes every 20 s) and the "Live session" section of the running task's page; JSON at `/api/live` and `/api/tasks/<id>/progress` |
| Editing the goals | https://yuke-persistent-agent-flow.yuke-521.workers.dev/goals — GOALS.md in a form; Save makes one commit on `main` (needs the board token and, once, a GitHub token on the Worker: see [manager/ROUTINE.md](manager/ROUTINE.md) and the page itself); git history at https://github.com/yukewF2023/yuke-persistent-agent-flow/commits/main/GOALS.md |
| Waking the manager now | any push to `main` fires it within about a minute (GitHub trigger); the "Wake now" button on the Manager card or `scripts/board.sh wake` (once the routine's API trigger is configured); details in [manager/ROUTINE.md](manager/ROUTINE.md) |
| The manager's runs, with full transcripts | https://claude.ai/code/routines/trig_0144Fo1i6xENAvLa58h3BBQ1 (:13) and https://claude.ai/code/routines/trig_019wCc3dqf85HAAtkfDTwUtG (:43) |
| The workers' full opencode transcripts | opencode web UI on the VM through an SSH tunnel, see [worker/README.md](worker/README.md); or public transcript links on task pages when `OPENCODE_SHARE=auto` |
| Raw worker logs | `gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo journalctl -u agent-worker@1 -u agent-worker@2 -f'` |
| Machine-readable status | https://yuke-persistent-agent-flow.yuke-521.workers.dev/api/status |
| Health snapshot with anomalies | `scripts/monitor.sh` |

## How it works

```
Yuke ── edits GOALS.md ──▶ repo ◀── cloned each run ──┐
                                                       │
Claude routine (Sonnet 5, every 30 min + on push) ─────┼── Bearer ORCHESTRATOR_TOKEN ──▶ Cloudflare Worker: the board
  plan · dispatch · review · replan                    │                                  (Durable Object + SQLite)
                                                       │                                  public status page
GCP e2-micro VM: agent-worker@1, agent-worker@2 ───────┴── Bearer WORKER_TOKEN ─────────▶ claim · heartbeat · submit · deps
  each task = one fresh `opencode run` (DeepSeek V4.1 Flash via OpenCode Go)
```

1. **Goals** live in [GOALS.md](GOALS.md). A human edits that file and nothing else, on the board's `/goals` page or with git; every push to `main` wakes the manager.
2. **The manager** ([manager/PROMPT.md](manager/PROMPT.md)) is a Claude Code cloud routine. Every 30 minutes it syncs the goals, **reviews** each finished task by running its tests in its own sandbox (accept, send back with concrete fixes, or split), and **plans** new tasks from the goal catalog so the board never runs dry. It writes a small JSON memory to the board and never keeps a transcript.
3. **The workers** ([worker/](worker/)) are two systemd services on one small VM. Each claims the next ready task (dependencies accepted, spend within pace), builds a workspace from a template, writes `TASK.md`, runs `opencode run --auto --format json` with DeepSeek V4.1 Flash, bundles everything under `out/` plus `out/REPORT.md`, and submits it for review. Leases, heartbeats and attempts make crashes harmless.
4. **The board** ([src/board.ts](src/board.ts)) is one Durable Object: goals, tasks, deliverables, reviews, events, workers, spend. The public page ([src/pages.ts](src/pages.ts), string templates plus a little vanilla JS, no build step) shows the pipeline, what each agent is doing (live: step, tool call, cost so far, the last session events), what needs a human, goal progress, the activity log and the budgets.

"Persistent" means the board always has ready tasks and the workers always pull the next one. "Little oversight" means the only human inputs are `GOALS.md` (the `/goals` editor commits it) and the *needs a human* list on the page.

## Cost

| Item | Monthly |
|---|---|
| OpenCode Go (the workers' model) | $10, with a $60 usage allowance; the board paces spend at $1.60/day by default (`scripts/board.sh pace`) |
| GCP e2-small VM (2 GB) + external IPv4 | about $12 (1 GB e2-micro was too small for two opencode sessions) |
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

- `scripts/board.sh status` — the whole board in one screen; `scripts/board.sh` alone lists every command (tasks, task, accept, reject, tasks-add, pace, pace-mode, docs, doc-get, doc-put, needs-human, events…).
- `scripts/monitor.sh` — one-shot health snapshot with anomalies.
- `scripts/board.sh manager-now` — run the manager loop from a laptop instead of waiting for the routine; `scripts/board.sh wake "why"` — start a cloud run now (see [manager/ROUTINE.md](manager/ROUTINE.md)).
- Edit the goals on [/goals](https://yuke-persistent-agent-flow.yuke-521.workers.dev/goals) (one commit per save) or edit [GOALS.md](GOALS.md) and push: the push wakes the manager within about a minute.

## Layout

```
GOALS.md            the goals (C: DeepSpace B2B go-to-market desk; D: DeepSpace B2C growth desk; A and B, the algorithms library and its Python port, paused)
manager/            PROMPT.md (the manager loop), ROUTINE.md (how the routine is configured)
worker/             worker.mjs (the loop), install.sh (VM bootstrap), agent-worker@.service, templates/, run-tests, README.md
scripts/            board.sh (CLI), monitor.sh, setup-env.mjs
src/                index.ts (router), board.ts (Durable Object), pages.ts (status + task pages), util.ts, types.ts
docs/               PLAN.md (design), HANDOFF.md (state for the next session)
```
