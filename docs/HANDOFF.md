# Handoff (2026-09-24, evening: the human-facing side)

## State
- Design: see docs/PLAN.md. Board on the Cloudflare Worker (personal account, free tier), workers on GCP e2-small `agent-workers` (project `yuke-persistent-agent-flow`, zone us-east1-b), manager = Claude routines `trig_0144Fo1i6xENAvLa58h3BBQ1` (:13, also fired by every push to `main`) and `trig_019wCc3dqf85HAAtkfDTwUtG` (:43); see manager/ROUTINE.md.
- Goals: A (TypeScript algorithms library) and B (Python port + cross-checks) in GOALS.md; on 2026-09-24 evening about 46 A and 63 B tasks were accepted, 0 blocked.
- Secrets: `.dev.vars` holds ORCHESTRATOR_TOKEN and WORKER_TOKEN (pushed to the Worker); `worker/agent-worker.env` (gitignored) holds BOARD_URL, WORKER_TOKEN, OPENCODE_API_KEY for the VM. Optional Worker secrets not yet set: GITHUB_TOKEN (goals editor saves), MANAGER_FIRE_URL + MANAGER_FIRE_TOKEN (wake button).
- Health: `scripts/monitor.sh` (anomalies) and `scripts/board.sh status`.

## What changed on 2026-09-24 (evening)
1. **Live worker view.** `worker/worker.mjs` 0.3.0 posts a progress snapshot (`POST /worker/tasks/<id>/progress`: step, tool calls, tokens, cost, elapsed, the last 30 opencode events) after every finished step, at most every 20 s, at least every 30 s while something changed, and a final one before submit/fail. The board keeps one overwritten row per task (`progress` table, pruned after 3 days), serves `/api/live` and `/api/tasks/<id>/progress`, and the pages poll the HTML fragments `/live/workers` and `/live/tasks/<id>` while a task runs. Measured: two workers add roughly 4–6k row writes a day.
2. **Tabs.** The status page is Overview / Board / Workers / Goals / Log / Spend, all server-rendered; the hash picks the tab (`/#workers`), the page reloads itself every 60 s keeping the hash (the meta refresh sits in `<noscript>`), the log filters by kind and text, Spend shows the last 7 days. Status JSON gained `ready` (next 20), 60 events, `spend.days`, `progress`.
3. **Goals editor** at `/goals`: GOALS.md as a form; Save commits to `main` through the GitHub contents API (sha-checked; 409 on a concurrent edit) and records a `goals.edit` event. Read-only with setup instructions until the Worker has a fine-grained PAT (`npx wrangler secret put GITHUB_TOKEN`; Contents read/write on this repo only). The request/response shape was verified with the same API call from the CLI (commit bbc8dc0, and a 409 on the stale sha); the first save through the deployed page still needs the PAT.
4. **Waking the manager.** A GitHub push trigger (`e08447e1-b71a-45c1-8c91-994db41fa760`, on the :13 routine) fires a run within about 30 s of any push; verified three times today (runs carry a `<github-trigger-context>` block; a run that finds the lock held stops in seconds). The "Wake the manager now" button, `POST /manager/wake` and `scripts/board.sh wake` post to the routine's API trigger once MANAGER_FIRE_URL/MANAGER_FIRE_TOKEN exist (token minted in the web UI), and record a `manager.wake` event either way; double wakes are refused for 5 minutes and while a run holds the lock.

## Pending human steps (each is one command once the value exists)
- `npx wrangler secret put GITHUB_TOKEN` — fine-grained PAT, repository `yukewF2023/yuke-persistent-agent-flow` only, permission Contents: read and write. Enables Save on /goals.
- `npx wrangler secret put MANAGER_FIRE_URL` and `npx wrangler secret put MANAGER_FIRE_TOKEN` — from the :13 routine's Edit → Add another trigger → API → Generate token. Enables the wake button; pushes already wake the manager without it.
- Optional: `OPENCODE_SHARE=auto` in `worker/agent-worker.env` + re-run the install to get public transcript links on task pages and in the live view (opencode.ai share pages are public).

## Cloudflare free-tier budget
- Limits: 5M row reads and 100k row writes per day, reset 00:00 UTC. The board meters itself (`scripts/board.sh status`, the Spend tab, `GET /manager/meter`), keeps spend as running totals, caches the page 60 s, and stops handing out tasks above 4.5M reads.
- Measured: idle claim 18 reads / 2 writes; heartbeat 1 / 1; uncached page render about 110 reads (was 53 before the tabs: +20 ready tasks, +30 events, +7 spend days); `/api/live` about 8 reads; a progress post 1 read / about 3 writes. A busy day is well under 300k reads and 30k writes.
- Backups: `/srv/backups/board-<date>.json` on the VM, daily 01:17 UTC, 14 days kept (`sudo board-backup` to run now).

## Known limits
- VM sizing: e2-micro (1 GB) failed on night one; now e2-small (2 GB) with one opencode data dir per worker, a 12-minute stall watchdog, 700M cgroup caps. If sessions stall, check `free -m` and the journal first.
- The routine API refuses sub-hourly crons, so the manager is two hourly routines sharing the lock; the push trigger fires on every push to any branch (no path filter available through the API), which is harmless but costs a short run per push.
- The GitHub push trigger cannot be listed or deleted through the API; manage it on the routine's page.
- The bundle cap is 800 KB of text per deliverable; bigger work must be split by the manager.
- Local smoke test (`scripts/smoke.sh`, 63 checks) needs a clean board: stop `npm run dev`, delete `.wrangler/state`, start again.
