#!/usr/bin/env bash
# One-shot health snapshot of the board with anomalies. Exit 0 always.
set -uo pipefail
WORKER_URL="${WORKER_URL:-https://yuke-persistent-agent-flow.yuke-521.workers.dev}"
S=$(curl -sS -m 30 "$WORKER_URL/api/status") || { echo "ANOMALY: board unreachable"; exit 0; }
python3 - "$S" <<'PY'
import json,sys,time
d=json.loads(sys.argv[1]); now=time.time()*1000; anom=[]
if "error" in d and "counts" not in d: print("ANOMALY: board error: "+str(d["error"])); sys.exit(0)
ago=lambda ts: "never" if not ts else "%dm ago"%int((now-ts)/60000)
c=d["counts"]; s=d["spend"]
print("# board snapshot", time.strftime("%Y-%m-%d %H:%MZ", time.gmtime()))
print("tasks: ready %d · in progress %d · review %d · accepted %d · blocked %d"%(c.get("ready",0),c.get("claimed",0)+c.get("running",0),c.get("review",0),c.get("accepted",0),c.get("blocked",0)))
for w in d["workers"]:
    print("worker %s: last seen %s · %s"%(w["id"],ago(w["last_seen"]),w.get("note") or ""))
    if now-w["last_seen"]>15*60000: anom.append("worker %s silent for %s"%(w["id"],ago(w["last_seen"])))
if not d["workers"]: anom.append("no workers have checked in")
print("spend: today $%.2f / $%.2f pace · week $%.2f · month $%.2f%s"%(s["todayUsd"],s["paceUsdPerDay"],s["weekUsd"],s["monthUsd"]," · PACING: "+s["pacing"]["reason"] if s["pacing"] else ""))
if c.get("review",0)>10: anom.append("review queue %d (manager falling behind?)"%c["review"])
if c.get("blocked",0): anom.append("%d blocked task(s)"%c["blocked"])
if s["monthUsd"]>54: anom.append("month spend $%.2f near Go cap"%s["monthUsd"])
cf=d.get("cloudflare") or {}
if cf:
    print("cloudflare today: rows read %s / %s · written %s / %s"%(f"{cf['reads']:,}",f"{cf['readLimit']:,}",f"{cf['writes']:,}",f"{cf['writeLimit']:,}"))
    if cf["reads"]>0.7*cf["readLimit"]: anom.append("DO reads at %d%% of the daily free-tier limit"%(100*cf["reads"]/cf["readLimit"]))
    if cf["writes"]>0.7*cf["writeLimit"]: anom.append("DO writes at %d%% of the daily free-tier limit"%(100*cf["writes"]/cf["writeLimit"]))
m=d["manager"]; print("manager: last run %s"%ago(m["lastRunAt"]))
if not m["lastRunAt"] or now-m["lastRunAt"]>2*3600000: anom.append("manager last run %s (expected every 30 min)"%ago(m["lastRunAt"]))
if d["needsHuman"]: print("needs human:"); [print("  - "+n["text"]) for n in d["needsHuman"]]
print("ANOMALIES: "+("; ".join(anom) if anom else "none"))
PY
