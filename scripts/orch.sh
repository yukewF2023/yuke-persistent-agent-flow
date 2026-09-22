#!/usr/bin/env bash
# CLI for humans and for the orchestrator. Reads WORKER_URL / ORCHESTRATOR_TOKEN / PICKS_TOKEN from env or .dev.vars.
# Usage: scripts/orch.sh <command> [args]   (run with no args for the list)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$HERE/.dev.vars" ]; then
  while IFS='=' read -r k v; do
    [ -z "$k" ] && continue; case "$k" in \#*) continue;; esac
    v=${v%'"'}; v=${v#'"'}
    [ -z "${!k:-}" ] && export "$k=$v"
  done < "$HERE/.dev.vars"
fi
# Defaults to production. For the local dev server: WORKER_URL=http://localhost:8787 scripts/orch.sh …
WORKER_URL="${WORKER_URL:-https://yuke-persistent-agent-flow.yuke-521.workers.dev}"
: "${ORCHESTRATOR_TOKEN:?ORCHESTRATOR_TOKEN missing (run npm run setup:env)}"
auth=(-H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H "content-type: application/json")
j() { if command -v jq >/dev/null; then jq .; else python3 -m json.tool; fi; }
get() { curl -sS "${auth[@]}" "$WORKER_URL$1" | j; }
post() { local b="${2:-}"; [ -z "$b" ] && b='{}'; curl -sS "${auth[@]}" -X "${3:-POST}" "$WORKER_URL$1" -d "$b" | j; }

# ---- GitHub via REST (no gh needed). Needs GITHUB_TOKEN (fine-grained PAT, Issues read/write on this repo). ----
GITHUB_REPO="${GITHUB_REPO:-yukewF2023/yuke-persistent-agent-flow}"
gh_api() { : "${GITHUB_TOKEN:?GITHUB_TOKEN missing (fine-grained PAT with Issues read/write)}"; curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }
gh_json() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  status)        curl -sS "$WORKER_URL/api/status" | j ;;
  agents)        get /admin/agents ;;
  notes)         curl -sS "$WORKER_URL/api/agents/${1:?agent}/notes?limit=${2:-30}" | j ;;
  runs)          curl -sS "$WORKER_URL/api/agents/${1:?agent}/runs?limit=${2:-10}" | j ;;
  run)           get "/admin/agents/${1:?agent}/runs/${2:?run id}" ;;
  queue)         post "/admin/agents/${1:?agent}/queue" "{\"task\":$(printf '%s' "${2:?task}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"priority\":${3:-5}}" ;;
  queue-list)    curl -sS "$WORKER_URL/api/agents/${1:?agent}/queue?status=${2:-open}" | j ;;
  queue-drop)    post "/admin/agents/${1:?agent}/queue/${2:?id}" "" DELETE ;;
  reassign)      post "/admin/agents/${1:?from}/reassign" "{\"queueId\":${2:?queue id},\"to\":\"${3:?to agent}\"}" ;;
  tick)          post "/admin/agents/${1:?agent}/tick" "{\"reason\":\"${2:-manual}\"}" ;;
  tick-async)    post "/admin/agents/${1:?agent}/tick?async=1" "{\"reason\":\"${2:-manual}\"}" ;;
  pause)         post "/admin/agents/${1:?agent}/pause" "{\"reason\":\"${2:-paused}\"}" ;;
  resume)        post "/admin/agents/${1:?agent}/resume" ;;
  ensure)        post "/admin/agents/${1:?agent}/ensure" ;;
  config)        if [ -n "${2:-}" ]; then post "/admin/agents/${1:?agent}/config" "$2" PATCH; else get "/admin/agents/${1:?agent}/config"; fi ;;
  profile)       if [ -n "${1:-}" ]; then post "/admin/agents/scout/profile" "$1" PATCH; else get /admin/agents/scout/config; fi ;;
  prefs)         curl -sS "$WORKER_URL/api/status" | python3 -c 'import sys,json;d=json.load(sys.stdin)["agents"]["scout"]["extra"];print(json.dumps({"profileVersion":d["profileVersion"],"profile":d["profile"],"ratings":d["ratings"]},indent=2))' ;;
  charter)       if [ -n "${2:-}" ]; then post "/admin/agents/${1:?agent}/charter" "{\"text\":$(python3 -c 'import json,sys;print(json.dumps(open(sys.argv[1]).read()))' "$2"),\"reason\":\"${3:-orchestrator}\"}" PUT; else get "/admin/agents/${1:?agent}/charter"; fi ;;
  charter-reset) post "/admin/agents/${1:?agent}/charter" "" DELETE ;;
  candidates)    get "/admin/agents/scout/candidates?status=${1:-new}" ;;
  rate)          post "/admin/agents/scout/rate" "{\"candidateId\":${1:?candidate id},\"rating\":\"${2:?up|down}\",\"reason\":\"${3:-}\"}" ;;
  team-state)    if [ -n "${1:-}" ]; then post /admin/team/state "$1" PUT; else get /admin/team/state; fi ;;
  team-log)      if [ -n "${1:-}" ]; then post /admin/team/log "{\"action\":\"$1\",\"target\":\"${2:-}\",\"detail\":\"${3:-}\"}"; else get "/admin/team/log?limit=50"; fi ;;
  feedback)      post /admin/team/feedback "{\"text\":$(printf '%s' "${1:?text}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"source\":\"cli\",\"author\":\"${2:-yuke}\"}" ;;
  feedback-list) get "/admin/team/feedback?status=${1:-new}" ;;
  feedback-apply) post "/admin/team/feedback/${1:?id}/apply" "{\"status\":\"${2:-applied}\",\"detail\":\"${3:-}\"}" ;;
  picks-link)    echo "$WORKER_URL/picks?k=${PICKS_TOKEN:?PICKS_TOKEN missing}" ;;
  gh-issues)     gh_api "https://api.github.com/repos/$GITHUB_REPO/issues?state=open&labels=${1:-agents}&per_page=50" | python3 -c 'import json,sys;[print(i["number"],"|",i["title"],"|",i["html_url"]) for i in json.load(sys.stdin)]' ;;
  gh-comments)   gh_api "https://api.github.com/repos/$GITHUB_REPO/issues/${1:?issue number}/comments?per_page=100${2:+&since=$2}" | python3 -c 'import json,sys;[print(json.dumps({"id":c["id"],"author":c["user"]["login"],"at":c["created_at"],"body":c["body"]})) for c in json.load(sys.stdin)]' ;;
  gh-comment)    gh_api -X POST "https://api.github.com/repos/$GITHUB_REPO/issues/${1:?issue number}/comments" -d "{\"body\":$(printf '%s' "${2:?body}" | gh_json)}" | python3 -c 'import json,sys;c=json.load(sys.stdin);print(c.get("html_url") or c)' ;;
  gh-issue-create) repo="${3:-$GITHUB_REPO}"; GITHUB_REPO="$repo" gh_api -X POST "https://api.github.com/repos/$repo/issues" -d "{\"title\":$(printf '%s' "${1:?title}" | gh_json),\"body\":$(printf '%s' "${2:-}" | gh_json),\"labels\":[\"agents\"]}" | python3 -c 'import json,sys;c=json.load(sys.stdin);print(c.get("number"),c.get("html_url") or c)' ;;
  gh-issue-close) gh_api -X PATCH "https://api.github.com/repos/${3:-$GITHUB_REPO}/issues/${1:?issue number}" -d "{\"state\":\"closed\",\"state_reason\":\"completed\"}" >/dev/null && { [ -n "${2:-}" ] && "$0" gh-comment "$1" "$2" || true; } && echo "closed #$1" ;;
  manager-now)   command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }
                 export WORKER_URL ORCHESTRATOR_TOKEN
                 cd "$HERE" && claude -p "$(cat orchestrator/PROMPT.md)" --allowedTools "Bash(scripts/orch.sh:*),Bash(gh:*),Read,Glob,Grep" ;;
  help|*)        sed -n '2,3p' "$0"; grep -oE '^  [a-z-]+\)' "$0" | tr -d ' )' | tr '\n' ' '; echo ;;
esac
