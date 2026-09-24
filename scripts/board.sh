#!/usr/bin/env bash
# CLI for the task board — used by the Claude manager routine and by humans.
# Reads WORKER_URL / ORCHESTRATOR_TOKEN from the environment or from .dev.vars. bash 3.2 compatible (curl + python3).
# Usage: scripts/board.sh <command> [args]   (no args → list of commands)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$HERE/.dev.vars" ]; then
  while IFS='=' read -r k v; do
    [ -z "$k" ] && continue; case "$k" in \#*) continue;; esac
    v=${v%'"'}; v=${v#'"'}
    [ -z "${!k:-}" ] && export "$k=$v"
  done < "$HERE/.dev.vars"
fi
WORKER_URL="${WORKER_URL:-https://yuke-persistent-agent-flow.yuke-521.workers.dev}"
WORKER_URL="${WORKER_URL%/}"
: "${ORCHESTRATOR_TOKEN:?ORCHESTRATOR_TOKEN missing (run npm run setup:env, or export it)}"
auth=(-H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H "content-type: application/json")
j() { python3 -m json.tool; }
get() { curl -sS "${auth[@]}" "$WORKER_URL$1"; }
send() { curl -sS "${auth[@]}" -X "$1" "$WORKER_URL$2" -d "${3:-{\}}"; }
sendfile() { curl -sS "${auth[@]}" -X "$1" "$WORKER_URL$2" -d "@$3"; }
jstr() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  status)
    curl -sS "$WORKER_URL/api/status" | python3 -c '
import json,sys,time
d=json.load(sys.stdin); now=time.time()*1000
if "error" in d and "goals" not in d: print("BOARD ERROR:", d["error"]); sys.exit(2)
ago=lambda ts: "never" if not ts else ("%dm ago"%int((now-ts)/60000))
print("GOALS"); 
for g in d["goals"]:
    c=g["counts"]; print("  %s %s [%s] ready %d · in progress %d · review %d · accepted %d · blocked %d · min_ready %d"%(g["id"],g["title"],g["status"],c.get("ready",0),c.get("claimed",0)+c.get("running",0),c.get("review",0),c.get("accepted",0),c.get("blocked",0),g["min_ready"]))
print("WORKERS")
for w in d["workers"]: print("  %s (%s) last seen %s · task %s · %s · done %d failed %d"%(w["id"],w.get("host") or "?",ago(w["last_seen"]),w.get("task_key") or "-",w.get("note") or "",w["tasks_done"],w["tasks_failed"]))
s=d["spend"]; print("SPEND today $%.3f / pace $%.2f · 5h $%.2f/12 · week $%.2f/30 · month $%.2f/60 · tasks today %d%s"%(s["todayUsd"],s["paceUsdPerDay"],s["fiveHourUsd"],s["weekUsd"],s["monthUsd"],s["todayTasks"],(" · PACING: "+s["pacing"]["reason"]) if s["pacing"] else ""))
print("REVIEW QUEUE (%d)"%len(d["reviewQueue"]))
for t in d["reviewQueue"]: print("  #%d %s attempt %d submitted %s"%(t["id"],t["key"],t["attempt"],ago(t["submitted_at"])))
print("IN PROGRESS")
for t in d["running"]: print("  #%d %s %s by %s since %s"%(t["id"],t["key"],t["status"],t["worker_id"],ago(t["claimed_at"])))
print("BLOCKED")
for t in d["blocked"]: print("  #%d %s: %s"%(t["id"],t["key"],(t.get("last_error") or "")[:120]))
print("NEEDS HUMAN"); [print("  - "+n["text"]) for n in d["needsHuman"]]
m=d["manager"]; print("MANAGER last run %s%s"%(ago(m["lastRunAt"])," · LOCKED" if m["lockedUntil"] else ""))
cf=d.get("cloudflare") or {}
if cf: print("CLOUDFLARE rows today: read %s / %s · written %s / %s"%(format(cf["reads"],","),format(cf["readLimit"],","),format(cf["writes"],","),format(cf["writeLimit"],",")))
print("EVENTS"); [print("  %s %s %s"%(time.strftime("%m-%d %H:%MZ",time.gmtime(e["ts"]/1000)),e["kind"],e["text"][:140])) for e in d["events"][:12]]
' ;;
  raw)           curl -sS "$WORKER_URL/api/status" | j ;;
  workers)       curl -sS "$WORKER_URL/api/status" | python3 -c 'import json,sys;[print(json.dumps(w)) for w in json.load(sys.stdin)["workers"]]' ;;
  tasks)         get "/manager/tasks?status=${1:-}&goal=${2:-}&limit=${3:-100}" | python3 -c 'import json,sys;[print("#%d %-28s %-9s p%d a%d/%d $%.3f %s"%(t["id"],t["key"],t["status"],t["priority"],t["attempt"],t["max_attempts"],t["cost_usd"],(t.get("last_error") or "")[:60])) for t in json.load(sys.stdin)]' ;;
  task)          get "/manager/tasks/${1:?task id}" | python3 -c '
import json,sys; d=json.load(sys.stdin); t=d["task"]
print(json.dumps({k:v for k,v in t.items() if k not in ("spec","acceptance")},indent=1))
print("--- spec ---\n"+t["spec"]+"\n--- acceptance ---\n"+t["acceptance"])
for r in d["reviews"]: print("--- review attempt %d: %s (%s)\n%s"%(r["attempt"],r["verdict"],r["who"],r.get("notes") or ""))
dl=d.get("deliverable")
if dl: print("--- deliverable attempt %d: %d files, %d bytes%s\n%s"%(dl["attempt"],dl["nfiles"],dl["bytes"]," (truncated)" if dl["truncated"] else "",dl["report"][:3000])); [print("  "+p) for p in dl["files"]]
' ;;
  review-next)   dir="${1:-/tmp/review}"; get "/manager/review-queue?limit=1" > /tmp/board-rq.json
                 python3 - "$dir" "$WORKER_URL" "$ORCHESTRATOR_TOKEN" <<'PY'
import json,sys,os,re,urllib.request
dir,url,tok=sys.argv[1:4]; q=json.load(open("/tmp/board-rq.json"))
if not q: print("NONE: review queue is empty"); sys.exit(0)
item=q[0]; t=item["task"]; dl=item["deliverable"]
safe=lambda s: re.sub(r"[^A-Za-z0-9._-]+","_",s)[:80]
root=os.path.join(dir,safe(t["key"])); os.makedirs(root,exist_ok=True)
def write(base,files,report):
    for p,c in (files or {}).items():
        p=re.sub(r"\.\.(/|$)","",p.lstrip("/")); full=os.path.join(base,p); os.makedirs(os.path.dirname(full),exist_ok=True); open(full,"w").write(c)
    if report: open(os.path.join(base,"REPORT.md"),"w").write(report)
if dl: write(root,dl["files"],dl["report"])
for dep in t["deps"]:
    req=urllib.request.Request(f"{url}/manager/tasks/{dep}",headers={"Authorization":"Bearer "+tok,"User-Agent":"board.sh/0.2 (curl-equivalent)"})
    d=json.load(urllib.request.urlopen(req)); dd=d.get("deliverable")
    if dd: write(os.path.join(root,"deps",safe(d["task"]["key"])),dd["files"],dd["report"])
print(f"TASK #{t['id']} {t['key']} kind={t['kind']} attempt={t['attempt']}/{t['max_attempts']} goal={t['goal_id']} title={t['title']}")
print(f"DIR {root}")
print(f"FILES {dl['nfiles'] if dl else 0} bytes={dl['bytes'] if dl else 0}{' TRUNCATED' if dl and dl['truncated'] else ''}")
print("--- acceptance ---\n"+t["acceptance"])
for r in item["reviews"]: print(f"--- prior review attempt {r['attempt']}: {r['verdict']}\n{r.get('notes') or ''}")
print("--- report (head) ---\n"+((dl["report"] if dl else "")[:2500]))
PY
                 ;;
  unpack)        get "/manager/tasks/${1:?task id}" > /tmp/board-task.json
                 python3 - "${2:?dir}" "$WORKER_URL" "$ORCHESTRATOR_TOKEN" <<'PY'
import json,sys,os,re,urllib.request
dir,url,tok=sys.argv[1:4]; d=json.load(open("/tmp/board-task.json")); t=d["task"]; dl=d.get("deliverable")
safe=lambda s: re.sub(r"[^A-Za-z0-9._-]+","_",s)[:80]
root=os.path.join(dir,safe(t["key"])); os.makedirs(root,exist_ok=True)
def write(base,files,report):
    for p,c in (files or {}).items():
        p=re.sub(r"\.\.(/|$)","",p.lstrip("/")); full=os.path.join(base,p); os.makedirs(os.path.dirname(full),exist_ok=True); open(full,"w").write(c)
    if report: open(os.path.join(base,"REPORT.md"),"w").write(report)
if dl: write(root,dl["files"],dl["report"])
for dep in t["deps"]:
    req=urllib.request.Request(f"{url}/manager/tasks/{dep}",headers={"Authorization":"Bearer "+tok,"User-Agent":"board.sh/0.2 (curl-equivalent)"}); dd=json.load(urllib.request.urlopen(req)).get("deliverable")
    if dd: write(os.path.join(root,"deps",safe(json.load(urllib.request.urlopen(urllib.request.Request(f"{url}/manager/tasks/{dep}",headers={"Authorization":"Bearer "+tok,"User-Agent":"board.sh/0.2 (curl-equivalent)"})))["task"]["key"])),dd["files"],dd["report"])
print(root)
PY
                 ;;
  ts-env)        d="${1:?dir}"; cache="${REVIEW_CACHE:-/tmp/review/_ts}"; mkdir -p "$cache" "$d"
                 cp "$HERE/worker/templates/ts/package.json" "$cache/package.json"
                 [ -d "$cache/node_modules" ] || (cd "$cache" && npm install --no-audit --no-fund >/dev/null 2>&1 && echo "installed ts deps in $cache")
                 for f in tsconfig.json vitest.config.ts package.json; do cp "$HERE/worker/templates/ts/$f" "$d/$f"; done
                 [ -e "$d/node_modules" ] || ln -s "$cache/node_modules" "$d/node_modules"; echo "ts env ready in $d" ;;
  py-env)        d="${1:?dir}"; cache="${REVIEW_CACHE:-/tmp/review/_py}"; mkdir -p "$cache" "$d"
                 [ -x "$cache/.venv/bin/pytest" ] || (python3 -m venv "$cache/.venv" && "$cache/.venv/bin/pip" install -q -r "$HERE/worker/templates/py/requirements.txt" && echo "created venv in $cache")
                 cp "$HERE/worker/templates/py/pytest.ini" "$d/pytest.ini"; [ -e "$d/.venv" ] || ln -s "$cache/.venv" "$d/.venv"; echo "py env ready in $d" ;;
  accept)        send POST "/manager/tasks/${1:?task id}/review" "{\"verdict\":\"accept\",\"notes\":$(printf '%s' "${2:-}" | jstr)}" | j ;;
  reject)        fin=false; [ "${3:-}" = "final" ] && fin=true
                 send POST "/manager/tasks/${1:?task id}/review" "{\"verdict\":\"reject\",\"notes\":$(printf '%s' "${2:?notes}" | jstr),\"final\":$fin}" | j ;;
  tasks-add)     sendfile POST /manager/tasks "${1:?tasks.json}" | j ;;
  task-edit)     send PATCH "/manager/tasks/${1:?task id}" "${2:?json}" | j ;;
  cancel)        send PATCH "/manager/tasks/${1:?task id}" '{"status":"cancelled","force":true}' | j ;;
  goals-sync)    gf="${1:-$HERE/GOALS.md}"; python3 - "$gf" <<'PY' > /tmp/board-goals.json
import json,re,sys
text=open(sys.argv[1]).read(); goals=[]; cur=None
for line in text.split("\n"):
    m=re.match(r"^## Goal ([A-Za-z0-9_-]+): (.+)$",line)
    if m: cur={"id":m.group(1),"title":m.group(2).strip(),"body":"","status":"active","min_ready":4,"done_when":None}; goals.append(cur); continue
    if cur is None: continue
    k=re.match(r"^- (status|min_ready|done-when): (.+)$",line)
    if k:
        key,val=k.group(1),k.group(2).strip()
        if key=="status": cur["status"]=val
        elif key=="min_ready": cur["min_ready"]=int(val)
        else: cur["done_when"]=val
    cur["body"]+=line+"\n"
json.dump(goals,sys.stdout)
PY
                 gh=$(python3 -c 'import hashlib,sys;print(hashlib.md5(open(sys.argv[1],"rb").read()).hexdigest())' "$gf")
                 sendfile PUT /manager/goals /tmp/board-goals.json | python3 -c 'import json,sys;d=json.load(sys.stdin);d["goals_md_hash"]=sys.argv[1];print(json.dumps(d,indent=4))' "$gh" ;;
  memory)        get /manager/memory | j ;;
  memory-put)    python3 -c 'import json,sys;print(json.dumps({"memory":json.load(open(sys.argv[1]))}))' "${1:?memory.json}" > /tmp/board-memory.json; sendfile PUT /manager/memory /tmp/board-memory.json | j ;;
  pace)          if [ -n "${1:-}" ]; then send PUT /manager/pace "{\"usd_per_day\":$1}" | j; else get /manager/pace | j; fi ;;
  needs-human)   get /manager/needs-human | j ;;
  needs-human-add) send POST /manager/needs-human "{\"text\":$(printf '%s' "${1:?text}" | jstr)}" | j ;;
  needs-human-clear) send DELETE "/manager/needs-human/${1:-}" | j ;;
  events)        get "/manager/events?limit=${1:-40}" | python3 -c 'import json,sys,time;[print(time.strftime("%m-%d %H:%MZ",time.gmtime(e["ts"]/1000)),e["kind"],("#%d"%e["task_id"]) if e["task_id"] else "",e["text"][:160]) for e in json.load(sys.stdin)]' ;;
  event)         send POST /manager/event "{\"kind\":\"${1:?kind}\",\"text\":$(printf '%s' "${2:?text}" | jstr)}" | j ;;
  lock)          send POST /manager/lock "{\"ttl_s\":${1:-1500}}" | j ;;
  unlock)        send DELETE /manager/lock | j ;;
  prune)         send POST /manager/prune | j ;;
  wake)          send POST /manager/wake "{\"who\":\"cli\",\"reason\":$(printf '%s' "${1:-scripts/board.sh wake}" | jstr)}" | j ;;
  manager-now)   command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }
                 export WORKER_URL ORCHESTRATOR_TOKEN
                 cd "$HERE" && claude -p "$(cat manager/PROMPT.md)" --allowedTools "Bash,Read,Write,Glob,Grep" ;;
  help|*)        sed -n '2,4p' "$0"; echo; grep -oE '^  [a-z-]+\)' "$0" | tr -d ' )' | tr '\n' ' '; echo ;;
esac
