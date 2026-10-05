#!/usr/bin/env bash
# End-to-end smoke test of the board API (about 130 checks). Usage, from the repo root with `npm run dev` running: scripts/smoke.sh http://localhost:8787
# Reads ORCHESTRATOR_TOKEN / WORKER_TOKEN from .dev.vars. Safe to re-run (unique task keys per run); wipe .wrangler/state between runs for a clean board.
# Written for bash 3.2: every response is captured with R=$(...) first (no nested quotes inside "$(...)").
set -u
U="${1:-http://localhost:8787}"
set -a; . ./.dev.vars; set +a
M=(-H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H "content-type: application/json")
W=(-H "Authorization: Bearer $WORKER_TOKEN" -H "content-type: application/json")
T=/tmp/claude-smoke; mkdir -p $T
pass=0; fail=0; RUN=$RANDOM; echo "run suffix $RUN"
check() { if [[ "$3" == *"$2"* ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1 — expected '$2' in: $(echo "$3" | tr -d '\n' | head -c 300)"; fi; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

R=$(curl -s "${M[@]}" "$U/api/status"); check "status with the manager token" '"generatedAt"' "$R"
R=$(code "$U/manager/tasks"); check "manager needs auth" "401" "$R"
R=$(code -X POST "$U/worker/claim"); check "worker needs auth" "401" "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/goals" -d '[{"id":"T","title":"Smoke goal","body":"test","min_ready":2,"catalog_size":12}]'); check "goals upsert" '"upserted": 1' "$R"
R=$(curl -s "${M[@]}" "$U/api/status"); check "status has catalog size" '"catalog_size": 12' "$R"; check "status has accepted today" '"acceptedToday"' "$R"
cat > $T/create.json <<J
[{"goal_id":"T","key":"T/one-$RUN","title":"first","spec":"do one","acceptance":"- has out/REPORT.md","priority":1},
 {"goal_id":"T","key":"T/two-$RUN","title":"second","spec":"do two","acceptance":"- ok","priority":2,"max_attempts":2},
 {"goal_id":"T","key":"T/three-$RUN","title":"third depends on one","spec":"do three","acceptance":"- ok","priority":1,"deps":["T/one-$RUN"]},
 {"goal_id":"T","key":"T/one-$RUN","title":"dup","spec":"x","acceptance":"y"},
 {"goal_id":"NOPE","key":"T/bad-$RUN","title":"bad goal","spec":"x","acceptance":"y"}]
J
R=$(curl -s "${M[@]}" -X POST "$U/manager/tasks" -d @$T/create.json)
N=$(echo "$R" | jget "len(d['created'])"); check "tasks create 3" "3" "$N"; check "dup skipped" 'duplicate key' "$R"; check "unknown goal skipped" 'unknown goal' "$R"
ID1=$(echo "$R" | jget "d['created'][0]['id']"); ID2=$(echo "$R" | jget "d['created'][1]['id']"); ID3=$(echo "$R" | jget "d['created'][2]['id']"); echo "ids $ID1 $ID2 $ID3"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w1","host":"smoke","version":"t"}'); check "w1 claims T/one (prio 1, no deps)" "\"key\": \"T/one-$RUN\"" "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w2","host":"smoke","version":"t"}'); check "w2 claims T/two (three waits on one)" "\"key\": \"T/two-$RUN\"" "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w3","host":"smoke","version":"t"}'); check "w3 gets nothing (waiting on deps)" 'waiting on dependencies' "$R"
R=$(code "${W[@]}" -X POST "$U/worker/tasks/$ID1/start" -d '{"worker_id":"w2"}'); check "start needs holder" "409" "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID1/start" -d '{"worker_id":"w1"}'); check "start ok" '"ok": true' "$R"
echo "{\"worker_id\":\"w1\",\"task_id\":$ID1,\"note\":\"step 3\"}" > $T/hb.json
R=$(curl -s "${W[@]}" -X POST "$U/worker/heartbeat" -d @$T/hb.json); check "heartbeat extends" '"lease_until"' "$R"
echo "{\"worker_id\":\"w2\",\"task_id\":$ID1}" > $T/hb2.json
R=$(code "${W[@]}" -X POST "$U/worker/heartbeat" -d @$T/hb2.json); check "heartbeat wrong holder 409" "409" "$R"
cat > $T/prog.json <<'J'
{"worker_id":"w1","attempt":1,"phase":"running","step":3,"tools":4,"elapsed_s":75,"tokens_in":5000,"tokens_out":300,"tokens_cached":4000,"cost_usd":0.0012,"last_tool":"bash","last_text":"Running the tests now","session_id":"ses_x","events":[{"t":10,"k":"tool","n":1,"tool":"read","title":"TASK.md","status":"completed"},{"t":40,"k":"text","n":2,"text":"I will implement it"},{"t":70,"k":"tool","n":3,"tool":"bash","title":"npx vitest run","status":"completed"},{"t":75,"k":"step","n":3}]}
J
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID1/progress" -d @$T/prog.json); check "progress post by holder" '"ok": true' "$R"
echo '{"worker_id":"w2","attempt":1,"step":1}' > $T/prog2.json
R=$(code "${W[@]}" -X POST "$U/worker/tasks/$ID1/progress" -d @$T/prog2.json); check "progress post wrong holder 409" "409" "$R"
R=$(curl -s "${M[@]}" "$U/api/tasks/$ID1/progress"); check "progress read" '"last_tool": "bash"' "$R"
R=$(curl -s "${M[@]}" "$U/api/live"); check "live has snapshot" '"npx vitest run"' "$R"
cat > $T/sub1.json <<'J'
{"worker_id":"w1","attempt":1,"report":"did one","files":{"out/REPORT.md":"# done","out/src/a.ts":"export const a = 1;"},"steps":7,"tokens_in":120000,"tokens_out":4000,"tokens_cached":90000,"cost_usd":0.11,"session_id":"ses_x"}
J
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID1/submit" -d @$T/sub1.json); check "submit → review" '"status": "review"' "$R"
R=$(curl -s "${M[@]}" "$U/api/status"); check "status shows review queue" "T/one-$RUN" "$R"
R=$(curl -s "${M[@]}" "$U/manager/review-queue?limit=1"); check "review queue has files" 'out/src/a.ts' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/tasks/$ID1/review" -d '{"verdict":"accept","notes":"tests pass"}'); check "accept" '"status": "accepted"' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w3","host":"smoke","version":"t"}'); check "w3 now claims T/three (dep accepted)" "\"key\": \"T/three-$RUN\"" "$R"; check "claim returns dep info" "\"key\": \"T/one-$RUN\"" "$R"
R=$(curl -s "${W[@]}" "$U/worker/tasks/$ID1/bundle"); check "bundle of accepted dep" 'export const a = 1' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID2/submit" -d '{"worker_id":"w2","attempt":1,"report":"meh","files":{"out/REPORT.md":"x"},"steps":3,"cost_usd":0.02}'); check "submit T/two" '"status": "review"' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/tasks/$ID2/review" -d '{"verdict":"reject","notes":"missing tests"}'); check "reject → ready (attempt 1 of 2)" '"status": "ready"' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w2","host":"smoke","version":"t"}'); check "w2 re-claims T/two attempt 2" '"attempt": 2' "$R"; check "prior review notes included" 'missing tests' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID3/fail" -d '{"worker_id":"w3","attempt":1,"error":"opencode timed out","cost_usd":0.03}'); check "fail T/three → ready" '"status": "ready"' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID2/submit" -d '{"worker_id":"w2","attempt":2,"report":"better","files":{"out/REPORT.md":"y"},"steps":4,"cost_usd":0.02}'); check "submit T/two attempt 2" '"status": "review"' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/tasks/$ID2/review" -d '{"verdict":"reject","notes":"still no tests"}'); check "reject at max attempts → blocked" '"status": "blocked"' "$R"
R=$(curl -s "${M[@]}" "$U/manager/needs-human"); check "needs-human populated" 'blocked after 2' "$R"
printf '# Brief\n\n## Bottom line\n- first version\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' > $T/doc.md
python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"title":"Smoke brief","note":"first draft"}))' $T/doc.md > $T/doc.json
R=$(curl -s "${M[@]}" -X PUT "$U/manager/docs/smoke-brief" -d @$T/doc.json); check "doc put" '"version": 1' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/docs/smoke-brief" -d @$T/doc.json); check "doc put again bumps version" '"version": 2' "$R"
R=$(code -X PUT "${M[@]}" "$U/manager/docs/Bad_Id" -d @$T/doc.json); check "doc id validated" "400" "$R"
R=$(curl -s "${M[@]}" "$U/api/docs"); check "docs index" '"smoke-brief"' "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/tasks/$ID2" -d '{"status":"ready","priority":3}'); check "patch blocked → ready bumps attempts" '"max_attempts": 3' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/pace" -d '{"usd_per_day":0.1}'); check "pace set" '"usd_per_day": 0.1' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w1"}'); check "claim paced (spent ≥ 0.1 today)" '"pacing": true' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/pace" -d '{"usd_per_day":1.6}'); check "pace reset" '"usd_per_day": 1.6' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/pace-extra" -d '{"usd":2}'); check "extra allowance for today" '"extraTodayUsd": 2' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/pace-extra" -d '{"usd":0}'); check "extra allowance cleared" '"extraTodayUsd": 0' "$R"
python3 -c "import json;print(json.dumps({'worker_id':'w3','report':'big','files':{'out/big.txt':'x'*900000}}))" > $T/big.json
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w3"}'); check "w3 re-claims T/three" "\"key\": \"T/three-$RUN\"" "$R"
R=$(code "${W[@]}" -X POST "$U/worker/tasks/$ID3/submit" -d @$T/big.json); check "files too large → 413" "413" "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID3/release" -d '{"worker_id":"w3","reason":"sigterm"}'); check "release → ready, attempt not consumed" '"ok": true' "$R"
R=$(curl -s "${M[@]}" "$U/api/tasks/$ID3"); check "released task attempt back to 1" '"attempt": 1' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/memory" -d '{"memory":{"cursor":{"A":3}}}'); check "memory put" '"ok": true' "$R"
R=$(curl -s "${M[@]}" "$U/manager/memory"); check "memory get" '"cursor"' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/lock" -d '{"ttl_s":120}'); check "lock acquire" '"ok": true' "$R"
R=$(code "${M[@]}" -X POST "$U/manager/lock" -d '{"ttl_s":120}'); check "lock busy 409" "409" "$R"
R=$(curl -s "${M[@]}" -X DELETE "$U/manager/lock"); check "unlock" '"ok": true' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/event" -d '{"kind":"run","text":"smoke run"}'); check "event run" '"ok": true' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/prune"); check "prune" '"deleted"' "$R"
R=$(curl -s "${M[@]}" "$U/api/tasks?status=accepted"); check "list accepted" "T/one-$RUN" "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/goals" -d '[{"id":"T","title":"Smoke goal","body":"test","min_ready":2},{"id":"R","title":"Research goal","body":"test","min_ready":1}]'); check "second goal upsert" '"upserted": 2' "$R"
echo "[{\"goal_id\":\"R\",\"key\":\"R/memo-$RUN\",\"title\":\"memo\",\"kind\":\"doc\",\"spec\":\"write a memo\",\"acceptance\":\"- out/MEMO.md exists\",\"priority\":9}]" > $T/doc-task.json
R=$(curl -s "${M[@]}" -X POST "$U/manager/tasks" -d @$T/doc-task.json); check "doc-kind task created" '"key": "R/memo-' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w9","goals":["R"]}'); check "worker preferring R claims the R task over higher-priority T tasks" "\"key\": \"R/memo-$RUN\"" "$R"; check "claim keeps the doc kind" '"kind": "doc"' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/wake" -d '{"reason":"smoke"}'); check "wake via CLI records the request" '"message"' "$R"
R=$(code "${M[@]}" -X POST "$U/manager/wake" -d '{"reason":"smoke again"}'); check "second wake within 5 min refused" "429" "$R"
# ---- projects: approve an idea from an idea bank ----
cat > $T/bank.md <<J
As of today.

| # | Idea | Buyer / channel | Why | Cheapest test | Boldness | Fit | Seen | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Smoke idea one $RUN: send a built demo | Head of ops · email | Proof before ask | 10 sends | 4 | 5 | 3× | new |
| 2 | Smoke idea two $RUN: workflow mailer | Ops lead · mail | Tangible | Mail 20 | 4 | 3 | 2× | later |
J
python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"title":"Smoke idea bank","note":"smoke"}))' $T/bank.md > $T/bank.json
R=$(curl -s "${M[@]}" -X PUT "$U/manager/docs/ideas-smoke" -d @$T/bank.json); check "idea bank put" '"ok": true' "$R"; BV=$(echo "$R" | jget "d['version']")
R=$(curl -s "${M[@]}" -X POST "$U/manager/projects" -d "{\"doc_id\":\"ideas-smoke\",\"version\":$BV,\"row\":\"1.1\",\"idea\":\"Smoke idea one $RUN: send a built demo\",\"notes\":\"smoke notes\"}"); check "project created from an idea row" '"ok": true' "$R"; PID=$(echo "$R" | jget "d['project']['id']"); echo "project $PID"
R=$(curl -s "${M[@]}" "$U/api/projects?status=approved"); check "project recorded with the row" '"Cheapest test": "10 sends"' "$R"; check "project keeps the notes" 'smoke notes' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/projects" -d "{\"doc_id\":\"ideas-smoke\",\"version\":$BV,\"row\":\"1.1\",\"idea\":\"Smoke idea one $RUN: send a built demo\"}"); check "the same idea twice → duplicate" '"error": "duplicate"' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/projects" -d "{\"doc_id\":\"ideas-smoke\",\"version\":0,\"row\":\"1.2\",\"idea\":\"Smoke idea one $RUN: send a built demo\"}"); check "a stale row number falls back to the idea text" '"error": "duplicate"' "$R"
R=$(code "${M[@]}" -X POST "$U/manager/projects" -d '{"doc_id":"ideas-smoke","version":0,"row":"1.9","idea":"not in the bank"}'); check "approve of a row that is gone → 409" "409" "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/projects/$PID" -d '{"status":"nope"}'); check "project status validated" 'status must be one of' "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/projects/$PID" -d '{"pr_url":"javascript:alert(1)"}'); check "project links must be https" 'must be an https URL' "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/projects/$PID" -d "{\"actor\":\"builder\",\"status\":\"ready\",\"slug\":\"smoke-demo-$RUN\",\"pr_url\":\"https://github.com/example/projects/pull/1\",\"note\":\"test, 3 workstreams\"}"); check "builder marks the project ready" '"status": "ready"' "$R"
R=$(curl -s "${M[@]}" "$U/api/status"); check "status lists projects" "smoke-demo-$RUN" "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/projects/$PID" -d '{"status":"active","note":"merged"}'); check "project marked active" '"status": "active"' "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/projects/$PID" -d '{"status":"done","result":"3 replies of 10: keep"}'); check "project done with its result" '"result": "3 replies of 10: keep"' "$R"; check "project log has every step" '"status": "active"' "$R"
R=$(curl -s "${M[@]}" "$U/api/tasks?key=T/one-$RUN"); N=$(echo "$R" | jget "len(d)"); check "tasks can be found by key" "1" "$N"
R=$(code "${M[@]}" "$U/api/projects/99999"); check "unknown project → 404" "404" "$R"
# ---- nothing is public: a person sees the board only through the DeepSpace app ----
A=(-H "Authorization: Bearer $APP_TOKEN" -H "content-type: application/json")
for path in / /healthz /goals /docs/smoke-brief /docs/smoke-brief.md /tasks/$ID1 /live/workers /projects /projects/$PID "/projects/new?doc=ideas-smoke&row=1.1&v=$BV"; do R=$(code "$U$path"); check "no page at $path" "404" "$R"; done
for path in /goals /wake /projects; do R=$(code -X POST "$U$path" -d "token=$ORCHESTRATOR_TOKEN"); check "no form route at POST $path" "404" "$R"; done
for path in /api/status /api/live /api/docs /api/docs/ideas-smoke /api/projects /api/tasks/$ID1; do R=$(code "$U$path"); check "$path needs a token" "401" "$R"; done
R=$(code "${W[@]}" "$U/api/status"); check "the worker token cannot read the board" "401" "$R"
R=$(curl -s "${A[@]}" "$U/api/status"); check "the app token reads the board" '"generatedAt"' "$R"
R=$(code "${A[@]}" -X POST "$U/api/status"); check "the read routes are GET only" "404" "$R"
# ---- /app/*: the DeepSpace app acting for the signed-in owner ----
R=$(code "$U/app/config"); check "app routes need the app token" "401" "$R"
R=$(code "${M[@]}" "$U/app/config"); check "the manager token is not the app token" "401" "$R"
R=$(code "${A[@]}" "$U/manager/tasks"); check "the app token cannot reach manager routes" "401" "$R"
R=$(curl -s "${A[@]}" "$U/app/config"); check "app config" '"builderReady": false' "$R"
R=$(curl -s "${M[@]}" "$U/api/docs/ideas-smoke"); check "doc JSON carries its idea rows" '"ref": "1.2"' "$R"
R=$(curl -s "${A[@]}" -X POST "$U/app/projects" -d "{\"doc\":\"ideas-smoke\",\"version\":$BV,\"row\":\"1.2\",\"idea\":\"Smoke idea two $RUN: workflow mailer\",\"notes\":\"from the app\",\"who\":\"owner@example.com\"}"); check "app approves an idea" '"ok": true' "$R"; AID=$(echo "$R" | jget "d['id']"); echo "app project $AID"
R=$(curl -s "${A[@]}" -X POST "$U/app/projects" -d "{\"doc\":\"ideas-smoke\",\"version\":$BV,\"row\":\"1.2\",\"idea\":\"Smoke idea two $RUN: workflow mailer\"}"); check "app approve twice → duplicate" '"error": "duplicate"' "$R"
R=$(curl -s "${A[@]}" -X POST "$U/app/projects" -d '{"doc":"ideas-smoke","version":0,"row":"1.9","idea":"gone"}'); check "app approve of a changed row → changed" '"error": "changed"' "$R"
R=$(curl -s "${M[@]}" "$U/api/projects/$AID"); check "the approval records who clicked" '"actor": "owner@example.com"' "$R"; check "app project keeps the notes" 'from the app' "$R"
R=$(code "${A[@]}" -X POST "$U/app/projects/$AID" -d '{"action":"merged"}'); check "app action out of order → 409" "409" "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/projects/$AID" -d '{"actor":"builder","status":"ready","pr_url":"https://github.com/example/projects/pull/2"}'); check "builder marks the app project ready" '"status": "ready"' "$R"
R=$(curl -s "${A[@]}" -X POST "$U/app/projects/$AID" -d '{"action":"merged","who":"owner@example.com"}'); check "app records the merge" '"status": "active"' "$R"
R=$(code "${A[@]}" -X POST "$U/app/projects/$AID" -d '{"action":"result","outcome":"done","result":""}'); check "app result needs a line" "400" "$R"
R=$(curl -s "${A[@]}" -X POST "$U/app/projects/$AID" -d '{"action":"result","outcome":"dropped","result":"overlaps with another project","who":"owner@example.com"}'); check "app records the result" '"status": "dropped"' "$R"
# ---- feedback: on an idea row, or a note to the manager ----
R=$(curl -s "${A[@]}" -X POST "$U/app/feedback" -d "{\"doc\":\"ideas-smoke\",\"version\":$BV,\"row\":\"1.1\",\"idea\":\"Smoke idea one $RUN: send a built demo\",\"kind\":\"generic\",\"note\":\"any vendor could send this\",\"who\":\"owner@example.com\"}"); check "app sends feedback on a row" '"ok": true' "$R"; FID=$(echo "$R" | jget "d['id']"); echo "feedback $FID"
R=$(curl -s "${A[@]}" -X POST "$U/app/feedback" -d "{\"doc\":\"ideas-smoke\",\"version\":0,\"row\":\"1.2\",\"idea\":\"Smoke idea one $RUN: send a built demo\",\"kind\":\"more\"}"); check "feedback with a stale row number falls back to the idea text" '"ok": true' "$R"; FID2=$(echo "$R" | jget "d['id']")
R=$(curl -s "${A[@]}" -X POST "$U/app/feedback" -d '{"doc":"ideas-smoke","version":0,"row":"1.9","idea":"gone","kind":"generic"}'); check "feedback on a row that is gone → changed" '"error": "changed"' "$R"
R=$(code "${A[@]}" -X POST "$U/app/feedback" -d '{"kind":"nope","note":"x"}'); check "feedback kind validated" "400" "$R"
R=$(code "${A[@]}" -X POST "$U/app/feedback" -d '{"kind":"generic","note":"about nothing"}'); check "row feedback needs a row" "400" "$R"
R=$(code "${A[@]}" -X POST "$U/app/feedback" -d '{"kind":"note","note":""}'); check "a note needs text" "400" "$R"
R=$(curl -s "${A[@]}" -X POST "$U/app/feedback" -d '{"kind":"note","note":"fewer ideas that need a sales team","who":"owner@example.com"}'); check "app sends a note to the manager" '"ok": true' "$R"; FID3=$(echo "$R" | jget "d['id']")
R=$(curl -s "${A[@]}" "$U/api/feedback"); check "feedback lists the row as it stood" '"Cheapest test": "10 sends"' "$R"; check "feedback records who sent it" '"who": "owner@example.com"' "$R"
R=$(curl -s "${M[@]}" "$U/api/status"); check "status counts open feedback" '"feedbackOpen": ' "$R"
R=$(code "${W[@]}" -X PATCH "$U/manager/feedback/$FID" -d '{"outcome":"x y z"}'); check "only the manager closes feedback" "401" "$R"
R=$(code "${M[@]}" -X PATCH "$U/manager/feedback/$FID" -d '{"outcome":""}'); check "closing feedback needs an outcome" "400" "$R"
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/feedback/$FID" -d '{"outcome":"moved to the graveyard; rule added to taste-smoke"}'); check "manager closes feedback" '"status": "handled"' "$R"
for F in $FID2 $FID3; do R=$(curl -s "${M[@]}" -X PATCH "$U/manager/feedback/$F" -d '{"outcome":"smoke cleanup"}'); done
R=$(curl -s "${A[@]}" "$U/api/feedback?status=open"); check "handled feedback leaves the open list" "$(echo "$R" | grep -c "\"id\": $FID,")" "0"
R=$(curl -s "${A[@]}" "$U/api/feedback?status=handled"); check "the outcome is kept" 'rule added to taste-smoke' "$R"
# ---- a GOALS.md change the manager drafts and the owner decides ----
python3 -c 'import json;print(json.dumps({"summary":"pause goal D","base":"## Goal D: x\n- status: active\n","content":"## Goal D: x\n- status: paused\n"}))' > $T/prop.json
R=$(code "${A[@]}" -X PUT "$U/manager/goals-proposal" -d @$T/prop.json); check "only the manager drafts a goals change" "401" "$R"
R=$(code "${M[@]}" -X PUT "$U/manager/goals-proposal" -d '{"summary":"x y z","base":"## Goal D: x\n","content":"no goals here\n"}'); check "a proposal must keep a goal section" "400" "$R"
R=$(code "${M[@]}" -X PUT "$U/manager/goals-proposal" -d '{"summary":"x y z","base":"## Goal D: x\n","content":"## Goal D: x\n"}'); check "a proposal must change something" "400" "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/goals-proposal" -d @$T/prop.json); check "manager drafts a goals change" '"ok": true' "$R"
R=$(curl -s "${A[@]}" "$U/api/goals-proposal"); check "app reads the proposal" '- status: paused' "$R"
R=$(curl -s "${A[@]}" "$U/api/status"); check "status names the proposal" '"summary": "pause goal D"' "$R"
R=$(code "${A[@]}" -X POST "$U/app/goals-proposal" -d '{"action":"approve"}'); check "approve without a GitHub token → 503" "503" "$R"
R=$(code "${A[@]}" -X POST "$U/app/goals-proposal" -d '{"action":"nope"}'); check "proposal action validated" "400" "$R"
R=$(curl -s "${A[@]}" -X POST "$U/app/goals-proposal" -d '{"action":"decline","who":"owner@example.com"}'); check "app declines the proposal" '"ok": true' "$R"
R=$(curl -s "${A[@]}" "$U/api/goals-proposal"); check "a declined proposal is gone" '"proposal": null' "$R"
R=$(code "${A[@]}" -X POST "$U/app/goals-proposal" -d '{"action":"decline"}'); check "deciding twice → 404" "404" "$R"
R=$(curl -s "${A[@]}" "$U/app/goals"); check "app reads the goals file" '## Goal' "$R"
R=$(code "${A[@]}" -X PUT "$U/app/goals" -d '{"content":"## Goal Z: x\n","sha":"abc","message":"m"}'); check "app goals save without a GitHub token → 503" "503" "$R"
R=$(code "${A[@]}" -X POST "$U/app/wake" -d '{"reason":"smoke","who":"owner@example.com"}'); check "app wake goes through the same guard" "429" "$R"
R=$(code "${A[@]}" "$U/app/nope"); check "unknown app route → 404" "404" "$R"
echo; echo "passed $pass, failed $fail"
