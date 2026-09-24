# Handoff (2026-09-23, rebuild day)

## State
- Design: see docs/PLAN.md. Board on the Cloudflare Worker (personal account, free tier), workers on GCP e2-small `agent-workers` (project `yuke-persistent-agent-flow`, zone us-east1-b), manager = Claude routine `trig_0144Fo1i6xENAvLa58h3BBQ1`.
- Goals: A (TypeScript algorithms library) and B (Python port + cross-checks) in GOALS.md.
- Secrets: `.dev.vars` holds ORCHESTRATOR_TOKEN and WORKER_TOKEN (pushed to the Worker); `worker/agent-worker.env` (gitignored) holds BOARD_URL, WORKER_TOKEN, OPENCODE_API_KEY for the VM.
- Health: `scripts/monitor.sh` (anomalies) and `scripts/board.sh status`.

## Cloudflare free-tier budget
- Limits: 5M row reads and 100k row writes per day, reset 00:00 UTC. The old design blew this on 2026-09-23 (per-segment pruning). The board now meters its own reads/writes (`scripts/board.sh status`, the status page, `GET /manager/meter`), keeps spend as running totals, caches the page 60 s, and stops handing out tasks above 4.5M reads so the page stays reachable.
- Measured: idle claim 18 reads / 2 writes; heartbeat 1 / 1; uncached page render 53 reads; manager list+queue+memory 7 reads. Expected day: 50k–200k reads, under 15k writes.
- Backups: `/srv/backups/board-<date>.json` on the VM, daily 01:17 UTC, 14 days kept (`sudo board-backup` to run now).

## Known limits
- VM sizing: e2-micro (1 GB) failed on night one: two opencode sessions plus viewers swapped constantly, sessions stalled, and the shared session store threw SQLite errors. Fixes on 2026-09-24: one opencode data dir per worker (`/srv/agent/xdg-N`), a 12-minute stall watchdog (24 min before the first event), 700M cgroup caps, and a resize to e2-small (2 GB). If sessions stall again, check `free -m` and the journal before anything else.
- The routine API refuses sub-hourly crons, so the manager is two hourly routines (:13 and :43) sharing the board's lock; see manager/ROUTINE.md.
- The bundle cap is 800 KB of text per deliverable; bigger work must be split by the manager.
