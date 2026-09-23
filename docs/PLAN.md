# Design: task board with a Claude manager and DeepSeek workers

Replaced the first build on 2026-09-23. The old design (two hand-made pipelines inside Durable Objects on a never-ending segment loop, a Claude routine every 6 h) is in git history before commit "rebuild"; its post-mortem is in the Context section below.

## Context

Team ask (Donald): everyone runs two persistent, low-oversight agents on DeepSeek V4.1 Flash via the $10/month OpenCode Go plan, doing anything. "Constantly working" was the sticking point. The first build optimized "never dies": the loops ran forever, but the model calls were busywork (76 reviews a day that said "nothing to report"), the manager never planned or judged work, and the per-segment bookkeeping exhausted the Durable Object free tier's 5M row reads per day. Yuke's reframing: give Claude a high-level goal; Claude decomposes it, hands tasks to the DeepSeek workers, and supervises their output quality; the human is consulted only when necessary.

## Shape

- **Board** (Cloudflare Worker, one SQLite Durable Object, free tier): goals, tasks, deliverables, reviews, events, workers, spend. Public status page. Manager API under `/manager/*` (Bearer `ORCHESTRATOR_TOKEN`), worker API under `/worker/*` (Bearer `WORKER_TOKEN`). Every query is index-bounded, spend totals are running counters in kv (never summed from the spend table), the public page is cached for 60 s, and there is no per-request pruning. Measured with the built-in meter: an idle claim reads 18 rows, a heartbeat 1, an uncached page render 53, a manager list-plus-queue call 7. Two workers polling every minute plus a page refreshing every minute come to well under 1M reads a day against the 5M free-tier limit; the board refuses claims at 4.5M and the page shows today's usage. The VM exports the whole board nightly to `/srv/backups`.
- **Workers** (`worker/worker.mjs`, two systemd instances on a GCP e2-micro): loop of claim → workspace from template → `TASK.md` → `opencode run --auto --format json --model opencode-go/deepseek-v4.1-flash` with a wall-clock budget → collect `out/**` + `out/REPORT.md` → submit. Heartbeats extend a lease; an expired lease returns the task to `ready`; `fail` consumes an attempt, `release` (SIGTERM) does not. Cost per task is computed from the `step_finish` token counts at Go prices (peak ×2 on weekdays 01–04 and 06–10 UTC), with `opencode export` as a fallback.
- **Manager** (`manager/PROMPT.md`, the existing Claude routine, Sonnet 5, every 30 minutes): lock → status + memory → sync `GOALS.md` → review each deliverable by unpacking it and running `tsc`/`vitest`/`pytest`/`check.sh` in the sandbox → accept or reject with concrete fixes → keep `min_ready` tasks per goal by decomposing the next catalog items → health and pace → memory + run event → unlock.
- **Goals** (`GOALS.md`): A = TypeScript algorithms library (about 110 catalog items, one task each); B = Python port with differential cross-check tasks that depend on both twins.

## Task life cycle

`ready` → `claimed` (worker holds a lease of max(45, max_minutes + 15) minutes) → `running` → `review` (deliverable stored) → `accepted`, or back to `ready` with the reviewer's notes (attempt + 1) until `max_attempts`, then `blocked` and listed under *needs a human*. Dependencies: a task is claimable only when every dependency is `accepted`; a cancelled or blocked dependency blocks the dependent task. Pacing: a claim is refused when today's spend plus in-flight estimates reach the daily pace ($1.60 default) or a Go window reaches 90 %.

## Invariants worth keeping

- Sessions are disposable, the board is the memory: nothing carries between tasks or manager runs except board rows and files.
- `rowsWritten` on the DO SQL cursor counts index rows too; never compare it to 1.
- The worker never runs deliverable code as a reviewer; the manager runs tests in its own sandbox.
- The Worker holds no model key; only the VM has the OpenCode Go key.

## Cutover checklist (done in this order)

1. Board built and smoke-tested locally (48 checks: auth, create, claim ordering and deps, leases, submit/review/reject/blocked, pace, bundle cap, release, memory, lock, prune, pages).
2. Worker loop tested on a Mac against the local board with a real opencode session.
3. Worker deployed with migration v2 (deletes the three old DO classes and their data); `WORKER_TOKEN` added; unused secrets deleted.
4. VM created, `install.sh`, both units running.
5. Manager dry run from the laptop (`scripts/board.sh manager-now`), then the routine repointed at `manager/PROMPT.md` every 30 minutes.
