#!/usr/bin/env bash
# End-to-end smoke test of the board API (63 checks). Usage, from the repo root with `npm run dev` running: scripts/smoke.sh http://localhost:8787
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

R=$(curl -s "$U/api/status"); check "status public" '"generatedAt"' "$R"
R=$(code "$U/manager/tasks"); check "manager needs auth" "401" "$R"
R=$(code -X POST "$U/worker/claim"); check "worker needs auth" "401" "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/goals" -d '[{"id":"T","title":"Smoke goal","body":"test","min_ready":2}]'); check "goals upsert" '"upserted": 1' "$R"
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
R=$(curl -s "$U/api/tasks/$ID1/progress"); check "progress read" '"last_tool": "bash"' "$R"
R=$(curl -s "$U/api/live"); check "live has snapshot" '"npx vitest run"' "$R"
R=$(curl -s "$U/live/workers"); check "live workers fragment" 'bash: npx vitest run' "$R"
R=$(curl -s "$U/live/tasks/$ID1"); check "live task fragment" 'data-status="running"' "$R"
R=$(curl -s "$U/tasks/$ID1"); check "task page live section" 'Live session' "$R"
R=$(curl -s "$U/"); check "status page live line" 'npx vitest run' "$R"
cat > $T/sub1.json <<'J'
{"worker_id":"w1","attempt":1,"report":"did one","files":{"out/REPORT.md":"# done","out/src/a.ts":"export const a = 1;"},"steps":7,"tokens_in":120000,"tokens_out":4000,"tokens_cached":90000,"cost_usd":0.11,"session_id":"ses_x"}
J
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID1/submit" -d @$T/sub1.json); check "submit → review" '"status": "review"' "$R"
R=$(curl -s "$U/api/status"); check "status shows review queue" "T/one-$RUN" "$R"
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
R=$(curl -s "${M[@]}" -X PATCH "$U/manager/tasks/$ID2" -d '{"status":"ready","priority":3}'); check "patch blocked → ready bumps attempts" '"max_attempts": 3' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/pace" -d '{"usd_per_day":0.1}'); check "pace set" '"usd_per_day": 0.1' "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w1"}'); check "claim paced (spent ≥ 0.1 today)" '"pacing": true' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/pace" -d '{"usd_per_day":1.6}'); check "pace reset" '"usd_per_day": 1.6' "$R"
python3 -c "import json;print(json.dumps({'worker_id':'w3','report':'big','files':{'out/big.txt':'x'*900000}}))" > $T/big.json
R=$(curl -s "${W[@]}" -X POST "$U/worker/claim" -d '{"worker_id":"w3"}'); check "w3 re-claims T/three" "\"key\": \"T/three-$RUN\"" "$R"
R=$(code "${W[@]}" -X POST "$U/worker/tasks/$ID3/submit" -d @$T/big.json); check "files too large → 413" "413" "$R"
R=$(curl -s "${W[@]}" -X POST "$U/worker/tasks/$ID3/release" -d '{"worker_id":"w3","reason":"sigterm"}'); check "release → ready, attempt not consumed" '"ok": true' "$R"
R=$(curl -s "$U/api/tasks/$ID3"); check "released task attempt back to 1" '"attempt": 1' "$R"
R=$(curl -s "${M[@]}" -X PUT "$U/manager/memory" -d '{"memory":{"cursor":{"A":3}}}'); check "memory put" '"ok": true' "$R"
R=$(curl -s "${M[@]}" "$U/manager/memory"); check "memory get" '"cursor"' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/lock" -d '{"ttl_s":120}'); check "lock acquire" '"ok": true' "$R"
R=$(code "${M[@]}" -X POST "$U/manager/lock" -d '{"ttl_s":120}'); check "lock busy 409" "409" "$R"
R=$(curl -s "${M[@]}" -X DELETE "$U/manager/lock"); check "unlock" '"ok": true' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/event" -d '{"kind":"run","text":"smoke run"}'); check "event run" '"ok": true' "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/prune"); check "prune" '"deleted"' "$R"
R=$(curl -s "$U/"); check "status page html" '<h1>Agent board</h1>' "$R"; check "status page tabs" '<nav class="tabs">' "$R"; check "log entries carry their kind" 'data-kind="task.release"' "$R"
R=$(curl -s "$U/tasks/$ID1"); check "task page html" 'Acceptance criteria' "$R"
R=$(code "$U/tasks/99999"); check "task 404 page" "404" "$R"
R=$(curl -s "$U/api/tasks?status=accepted"); check "public list accepted" "T/one-$RUN" "$R"
R=$(curl -s "$U/goals"); check "goals editor renders GOALS.md" '## Goal A' "$R"
R=$(code -X POST "$U/goals" -d 'token=wrong&content=x&sha=y'); check "goals save needs the board token" "401" "$R"
R=$(code -X POST "$U/wake" -d 'token=wrong'); check "wake needs the board token" "401" "$R"
R=$(curl -s "${M[@]}" -X POST "$U/manager/wake" -d '{"reason":"smoke"}'); check "wake via CLI records the request" '"message"' "$R"
R=$(code "${M[@]}" -X POST "$U/manager/wake" -d '{"reason":"smoke again"}'); check "second wake within 5 min refused" "429" "$R"
echo; echo "passed $pass, failed $fail"
