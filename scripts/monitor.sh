#!/usr/bin/env bash
# One-shot health snapshot of the whole system: 2 DeepSeek worker agents (Durable Objects) + the Claude orchestrator routine.
# Prints a compact report and a list of anomalies. Exit code 0 always (it is a report, not a gate).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_URL="${WORKER_URL:-https://yuke-persistent-agent-flow.yuke-521.workers.dev}"
export WORKER_URL
S=$(curl -sS -m 30 "$WORKER_URL/api/status") || { echo "ANOMALY: worker unreachable"; exit 0; }
python3 - "$S" <<'PY'
import json,sys,datetime,time
d=json.loads(sys.argv[1]); now=time.time()*1000
anom=[]
def ago(ts):
    if not ts: return "never"
    d=int((now-ts)/60000)
    return f"{d}m ago" if d>=0 else f"in {-d}m"
print(f"# snapshot {datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%d %H:%MZ')}")
for k,a in d["agents"].items():
    acts=a["recentActivity"]; last=acts[0]["ts"] if acts else None
    errs=[x for x in acts if x["kind"]=="error"]
    g=a["governor"]; sp=a["spend"]
    print(f"- {k}: {'PAUSED' if a['paused'] else 'working'} | now: {a['workingNow']} | last activity {ago(last)} | segments {a['segmentCount']} | work today {a['workDoneToday']} | thinks today {a['thinksToday']} | open {a['workOpen']} | spend today ${sp['todayUsd']:.3f} 5h ${sp['fiveHourUsd']:.3f} month ${sp['monthUsd']:.3f} / ${g['monthlyBudgetUsd']} | bucket ${g['bucketUsd']:.3f} | next alarm {ago(a['nextTickAt']) if a['nextTickAt'] else 'NONE'}")
    if a["lastError"]: print(f"    lastError: {a['lastError'][:160]}")
    if errs: print(f"    recent errors ({len(errs)}): " + " || ".join(e["text"][:100] for e in errs[:3]))
    if not a["paused"]:
        if last is None or now-last > 15*60000: anom.append(f"{k}: no activity for {ago(last)} (loop stalled?)")
        if a["nextTickAt"] is None: anom.append(f"{k}: no pending alarm")
        elif a["nextTickAt"] < now - 5*60000: anom.append(f"{k}: alarm overdue by {int((now-a['nextTickAt'])/60000)}m")
    if len(errs) >= 4: anom.append(f"{k}: {len(errs)} errors in last 20 activities")
    share=g["monthlyBudgetUsd"]/60
    if sp["fiveHourUsd"] > 12*share*0.8: anom.append(f"{k}: 5h spend ${sp['fiveHourUsd']:.2f} > 80% of share")
    if a["thinksToday"] and a["thinksToday"]>0:
        avg = sp["todayUsd"]/a["thinksToday"]
        if avg > 0.03: anom.append(f"{k}: avg think ${avg:.3f} is high")
    ex=a.get("extra",{})
    if k=="uptime":
        down=[t["url"] for t in ex.get("targets",[]) if not t["ok"]]
        if down: anom.append("uptime: DOWN " + ", ".join(down))
        print(f"    apps: {sum(1 for t in ex.get('targets',[]) if t['ok'])}/{len(ex.get('targets',[]))} ok, checks today {ex.get('checksToday')}, probes today {ex.get('probesToday')}")
    if k=="scout":
        c=ex.get("candidates",{}); print(f"    candidates: {c} | searches today {ex.get('searchesToday')}/{ex.get('tavily',{}).get('dailyCap')} | pages unextracted {ex.get('pagesUnextracted')} | next delivery {ago(ex.get('nextDeliveryAt')) if ex.get('nextDeliveryAt') else '?'}")
o=d.get("orchestrator") or {}
lr=o.get("lastRunAt")
print(f"- orchestrator: last run {ago(lr)}; memory keys: {list((o.get('memory') or {}).keys())[:6]}")
if lr is None or now-lr > 7*3600000: anom.append(f"orchestrator: last run {ago(lr)} (expected every 6h)")
tl=d.get("teamLog",[])
if tl:
    l=tl[0]; print(f"    latest team log: {datetime.datetime.fromtimestamp(l['ts']/1000,datetime.UTC).strftime('%H:%MZ')} {l['action']} {l.get('target') or ''} {(l.get('detail') or '')[:100]}")
print("ANOMALIES: " + ("; ".join(anom) if anom else "none"))
PY
