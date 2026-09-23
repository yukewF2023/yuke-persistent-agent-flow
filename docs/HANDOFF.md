# Handoff (2026-09-23, rebuild day)

## State
- Design: see docs/PLAN.md. Board on the Cloudflare Worker (personal account, free tier), workers on GCP e2-micro `agent-workers` (project `yuke-persistent-agent-flow`, zone us-east1-b), manager = Claude routine `trig_0144Fo1i6xENAvLa58h3BBQ1`.
- Goals: A (TypeScript algorithms library) and B (Python port + cross-checks) in GOALS.md.
- Secrets: `.dev.vars` holds ORCHESTRATOR_TOKEN and WORKER_TOKEN (pushed to the Worker); `worker/agent-worker.env` (gitignored) holds BOARD_URL, WORKER_TOKEN, OPENCODE_API_KEY for the VM.
- Health: `scripts/monitor.sh` (anomalies) and `scripts/board.sh status`.

## Known limits
- e2-micro has 1 GB RAM: test runs are serialized through `./run-tests` (flock) and each worker has MemoryMax=450M. If the journal shows OOM kills, run one worker (`systemctl disable --now agent-worker@2`) or move to e2-small.
- The routine API refuses sub-hourly crons, so the manager is two hourly routines (:13 and :43) sharing the board's lock; see manager/ROUTINE.md.
- The bundle cap is 800 KB of text per deliverable; bigger work must be split by the manager.
