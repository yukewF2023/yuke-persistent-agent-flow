# Workers (GCP e2-micro)

Two `opencode run` workers (DeepSeek V4.1 Flash via OpenCode Go) that pull tasks from the board. State lives on the board; the VM is disposable.

## Create the VM (once)
```bash
gcloud config set project yuke-persistent-agent-flow
gcloud services enable compute.googleapis.com
gcloud compute instances create agent-workers --zone=us-east1-b --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --network-tier=STANDARD --metadata=enable-oslogin=TRUE --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
```
Resized from e2-micro to e2-small on 2026-09-24: 1 GB was not enough for two concurrent opencode sessions (constant swapping, stalled sessions, SQLite errors). e2-small is about $12/month; Standard network tier egress has 200 GiB/month free.

## Ship and install
```bash
npm run setup:env                                    # writes worker/agent-worker.env (gitignored) with BOARD_URL, WORKER_TOKEN, BACKUP_TOKEN, OPENCODE_API_KEY, WORKER_GOALS_1/2
gcloud compute scp --recurse worker agent-workers:/tmp/worker --zone=us-east1-b
gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo bash /tmp/worker/install.sh && rm -rf /tmp/worker'
```
Re-run the same two commands to update `worker.mjs`, `search.mjs`, the templates or the unit file. `WORKER_GOALS_1=F` and `WORKER_GOALS_2=G` in `worker/agent-worker.env` make each worker prefer a goal (it still takes other goals' tasks when its own are exhausted); the installer turns them into `/etc/agent-worker-<n>.env`, and moves `BACKUP_TOKEN` into the root-only `/etc/agent-board-backup.env`. Research tasks (kind `doc`) get no code templates and different rules in `TASK.md`: fetch the spec's URLs with opencode's webfetch tool or curl, cite sources, write `out/MEMO.md`.

Listening tasks (kind `listen`) search instead of fetching: the claim comes back with a per-task search key, which the worker hands to the session as `SEARCH_KEY` (with `SEARCH_URL`, the board's `/search`), and the session runs `search x "…"`, `search reddit "…"`, `search hn "…"` and so on (`/usr/local/bin/search`, from `search.mjs`; `search --help` lists the sources). The board checks the key (valid only while that claim is live), caps the calls and the spend, logs every call with its results, and forwards it to the agent-board app's research gateway, which runs it through DeepSpace's integrations. A worker only gets listen tasks when `/usr/local/bin/search` exists (it says so in its claim).

## Watch the workers' sessions
**On the board, no gcloud needed:** while a task runs, the worker posts a progress snapshot to the board (`POST /worker/tasks/<id>/progress`) on every finished step, at most once every 30 s and at least every 45 s while something changed: step number, tool calls, tokens and cost so far, elapsed time, and the last 30 events (tool name and title, a one-line text excerpt, errors). The board keeps one row per task and overwrites it (`GET /api/tasks/<id>/progress`, `GET /api/live`), about one row write per post, so two busy workers add a few thousand row writes a day. The Agents tab on the status page shows the line ("step 12 · bash: npx vitest run · 3m20s") with cost and tokens, a bar of elapsed time against the task's budget, and the event feed, refreshed every 20 s; the task page shows the same while the task runs, and keeps the last snapshot afterwards (pruned after 3 days). Tune with `PROGRESS_MIN_S` / `PROGRESS_MAX_S` in the unit environment.

**Full transcripts:** each worker has its own opencode data directory (`/srv/agent/xdg-1`, `/srv/agent/xdg-2`, so two sessions never share one SQLite file) and its own read-only web UI: worker 1 on `127.0.0.1:4091`, worker 2 on `127.0.0.1:4092` (services `opencode-web@1`, `opencode-web@2`). Each lists that worker's sessions with the full transcript, tool calls, tokens and cost. Open both through one SSH tunnel:
```bash
gcloud compute ssh agent-workers --zone=us-east1-b -- -N -L 4091:127.0.0.1:4091 -L 4092:127.0.0.1:4092
```
then browse http://localhost:4091 and http://localhost:4092 (leave the command running; Ctrl-C closes the tunnel).

Optional public transcript links: set `OPENCODE_SHARE=auto` in `worker/agent-worker.env`, re-run the install, and every task page on the board gets a "worker session transcript" link (opencode.ai share pages are public; the task content is open-source algorithm code).

## Backups
The backups are root-only (`/srv/backups` is mode 700 and hidden from the worker units), and the opencode sessions run without `WORKER_TOKEN` and `BOARD_URL` in their environment: a session is meant to see its task and `deps/`, nothing else of the board. The sessions share one Unix user with the worker process, so since 2026-10-13 the worker runs from an execute-only copy of node (`/srv/agent/node-noread`, mode 0111): the kernel marks it non-dumpable, which closes its `/proc/<pid>/environ`, `mem` and `fd` to the sessions. The export has its own token (`BACKUP_TOKEN`, in `/etc/agent-board-backup.env`, root only); the workers' token no longer exports the board, and a dependency bundle is served only for the task the asking worker holds. What a session can still read: the other worker's workspace and session store, and its own OpenCode key. A root cron job runs `/usr/local/bin/board-backup` daily at 01:17 UTC: it downloads the whole board (goals, tasks, deliverables, reviews, events, manager memory) to `/srv/backups/board-<date>.json` and keeps 14 days. Run it by hand with `sudo board-backup`. Restoring is manual: the export is plain JSON that `scripts/board.sh tasks-add` and `goals-sync` can be fed from.

## Operate
```bash
gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo journalctl -u agent-worker@1 -u agent-worker@2 -f'
gcloud compute ssh agent-workers --zone=us-east1-b -- 'systemctl status agent-worker@1 agent-worker@2; free -m'
gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo systemctl restart agent-worker@1 agent-worker@2'
```
Each task runs in `/srv/work/<task>-a<attempt>/` from a template (`/srv/templates/ts`, `/srv/templates/py`, linked `node_modules` / `.venv`), with `TASK.md` as the prompt. Only files under `out/` are collected; `out/REPORT.md` is the report. Failed workspaces are kept at `/srv/work/last-failed`.
