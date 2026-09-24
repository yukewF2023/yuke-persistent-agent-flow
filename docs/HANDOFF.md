# Handoff (2026-09-23, rebuild day)

## State
- Design: see docs/PLAN.md. Board on the Cloudflare Worker (personal account, free tier), workers on GCP e2-micro `agent-workers` (project `yuke-persistent-agent-flow`, zone us-east1-b), manager = Claude routine `trig_0144Fo1i6xENAvLa58h3BBQ1`.
- Goals: A (TypeScript algorithms library) and B (Python port + cross-checks) in GOALS.md.
- Secrets: `.dev.vars` holds ORCHESTRATOR_TOKEN and WORKER_TOKEN (pushed to the Worker); `worker/agent-worker.env` (gitignored) holds BOARD_URL, WORKER_TOKEN, OPENCODE_API_KEY for the VM.
- Health: `scripts/monitor.sh` (anomalies) and `scripts/board.sh status`.

## Cloudflare free-tier budget
- Limits: 5M row reads and 100k row writes per day, reset 00:00 UTC. The old design blew this on 2026-09-23 (per-segment pruning). The board now meters its own reads/writes (`scripts/board.sh status`, the status page, `GET /manager/meter`), keeps spend as running totals, caches the page 60 s, and stops handing out tasks above 4.5M reads so the page stays reachable.
- Measured: idle claim 18 reads / 2 writes; heartbeat 1 / 1; uncached page render 53 reads; manager list+queue+memory 7 reads. Expected day: 50k–200k reads, under 15k writes.
- Backups: `/srv/backups/board-<date>.json` on the VM, daily 01:17 UTC, 14 days kept (`sudo board-backup` to run now).

## Known limits
- e2-micro has 1 GB RAM and a quarter vCPU: test runs are serialized through `./run-tests` (flock), each worker has MemoryMax=450M, swap is 2 GB. First night: no OOM kills, but ~800 MB of swap in use and 8–25 min per task (a laptop does the same task in 1 min). Task budgets are 45 min for that reason. If tasks start timing out or the journal shows OOM kills, run one worker (`systemctl disable --now agent-worker@2`) or resize to e2-small (~$12/month).
- The routine API refuses sub-hourly crons, so the manager is two hourly routines (:13 and :43) sharing the board's lock; see manager/ROUTINE.md.
- The bundle cap is 800 KB of text per deliverable; bigger work must be split by the manager.
