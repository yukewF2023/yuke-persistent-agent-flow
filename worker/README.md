# Workers (GCP e2-micro)

Two `opencode run` workers (DeepSeek V4.1 Flash via OpenCode Go) that pull tasks from the board. State lives on the board; the VM is disposable.

## Create the VM (once)
```bash
gcloud config set project yuke-persistent-agent-flow
gcloud services enable compute.googleapis.com
gcloud compute instances create agent-workers --zone=us-east1-b --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --network-tier=STANDARD --metadata=enable-oslogin=TRUE --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
```
`us-east1` is a free-tier region; Standard network tier egress has 200 GiB/month free. The external IPv4 (about $3.65/month) is the only recurring VM charge.

## Ship and install
```bash
npm run setup:env                                    # writes worker/agent-worker.env (gitignored) with BOARD_URL, WORKER_TOKEN, OPENCODE_API_KEY
gcloud compute scp --recurse worker agent-workers:/tmp/worker --zone=us-east1-b
gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo bash /tmp/worker/install.sh && rm -rf /tmp/worker'
```
Re-run the same two commands to update `worker.mjs`, the templates or the unit file.

## Operate
```bash
gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo journalctl -u agent-worker@1 -u agent-worker@2 -f'
gcloud compute ssh agent-workers --zone=us-east1-b -- 'systemctl status agent-worker@1 agent-worker@2; free -m'
gcloud compute ssh agent-workers --zone=us-east1-b -- 'sudo systemctl restart agent-worker@1 agent-worker@2'
```
Each task runs in `/srv/work/<task>-a<attempt>/` from a template (`/srv/templates/ts`, `/srv/templates/py`, linked `node_modules` / `.venv`), with `TASK.md` as the prompt. Only files under `out/` are collected; `out/REPORT.md` is the report. Failed workspaces are kept at `/srv/work/last-failed`.
