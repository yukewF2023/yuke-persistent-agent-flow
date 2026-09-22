# Admin API (for the orchestrator and `scripts/orch.sh`)

Base URL: the Worker (`https://yuke-persistent-agent-flow.yuke-521.workers.dev`; `WORKER_URL=http://localhost:8787` for the dev server). Public routes need no auth. Admin routes need `Authorization: Bearer $ORCHESTRATOR_TOKEN`. Picks routes need `?k=$PICKS_TOKEN`.

## Public
| Route | Returns |
|---|---|
| `GET /` | HTML status page (auto-refresh 60 s) |
| `GET /api/status` | `{ agents: { uptime, scout }, orchestrator: { memory, lastRunAt }, teamLog }` |
| `GET /api/agents/:id` | one agent's status |
| `GET /api/agents/:id/notes?limit=&kind=` | notes, newest first (`change`, `finding`, `recommendation`, `thought`, `error`, `admin`) |
| `GET /api/agents/:id/runs?limit=` | run history without transcripts |
| `GET /api/agents/:id/queue?status=open` | queue items |
| `GET /api/agents/:id/charter` | base charter + override + version |
| `GET /api/team/log?limit=` | orchestrator action log |

## Picks (token `k`)
| Route | Effect |
|---|---|
| `GET /picks?k=` | private page with 👍/👎 buttons and a text box |
| `GET /api/picks?k=&limit=3` | latest recommendation sets with picks and ratings |
| `POST /api/picks/rate?k=` `{candidateId, rating: up\|down, reason?}` | rating → scout memory + team mailbox |
| `POST /api/picks/feedback?k=` `{text}` | free text → team mailbox |

## Admin (bearer)
| Route | Effect |
|---|---|
| `GET /admin/agents` | full status for both agents + open queues + charter versions + configs + new feedback + orchestrator state |
| `POST /admin/agents/:id/queue` `{task, priority?}` | add a task for the agent (source = orchestrator) |
| `DELETE /admin/agents/:id/queue/:qid` | drop a task |
| `POST /admin/agents/:id/reassign` `{queueId, to}` | move a task to the other agent |
| `POST /admin/agents/:id/tick[?async=1]` `{reason?}` | run a tick now (sync returns the TickResult; async schedules it 1 s out). For the scout, a reason containing "deliver" forces a delivery tick, "research" a research tick |
| `POST /admin/agents/:id/pause` `{reason?}` / `POST …/resume` | pause cancels the pending alarm; resume schedules one |
| `POST /admin/agents/:id/ensure` | repair: guarantee exactly one pending alarm |
| `GET\|PATCH /admin/agents/:id/config` | kv overrides: `targets` (uptime), `wakeBounds {min,max}`, `search_profile` (scout; prefer the profile route). Send `null` to clear a key |
| `PATCH /admin/agents/scout/profile` `{…}` | merge into the scout's search profile; bumps `profileVersion` |
| `GET\|PUT\|DELETE /admin/agents/:id/charter` `{text, reason}` | manager override appended to the base charter; version++ and an admin note each time |
| `GET /admin/agents/:id/runs/:rid` | full run incl. transcript (tool calls + results) |
| `POST /admin/agents/scout/rate` `{candidateId, rating, reason?}` | write a rating into the scout's memory |
| `GET /admin/agents/scout/candidates?status=new` | candidate pool |
| `GET\|PUT /admin/team/state` | orchestrator memory (`PUT {memory: {...}}`) |
| `GET\|POST /admin/team/log` `{action, target?, detail?}` | action log |
| `GET /admin/team/feedback?status=new` / `POST` `{text, source?, author?}` | the mailbox |
| `POST /admin/team/feedback/:id/apply` `{status?: applied\|ignored, detail}` | resolve a mailbox item |

## Shapes
- **TickResult**: `{ runId, status: ok|error|skipped|paused|budget, steps, subrequests, inputTokens, outputTokens, nextWakeSeconds, nextTickAt, summary, error }`
- **AgentStatus**: `{ id, name, paused, runCount, lastTickAt, nextTickAt, lastSummary, lastError, charterVersion, budgetToday{tokens,limit}, queueOpen, pendingSchedules, recentRuns[], recentNotes[], extra }` — `extra.targets` for uptime; `extra.profile / candidates / tavily / nextDeliveryAt / ratings` for scout.

## Examples
```bash
scripts/orch.sh agents
scripts/orch.sh queue uptime "add target https://example.app.space expect <title" 2
scripts/orch.sh tick scout deliver
scripts/orch.sh profile '{"keywords":["Hartford hiking this weekend","CT farm dinner"],"exclusions":["21+ nightlife","kids-only"]}'
scripts/orch.sh charter scout /tmp/override.md "always include one free option"
scripts/orch.sh feedback "more outdoors, fewer coffee things"
scripts/orch.sh picks-link
```

## GitHub (REST, no `gh`)
Needs `GITHUB_TOKEN` (fine-grained PAT scoped to this repo, Issues read/write) and optionally `GITHUB_REPO` (default `yukewF2023/yuke-persistent-agent-flow`).
```bash
scripts/orch.sh gh-issues                     # open issues labelled agents
scripts/orch.sh gh-comments 1 2026-09-22T00:00:00Z   # comments on #1 since a timestamp (JSON lines)
scripts/orch.sh gh-comment 1 "run summary…"
scripts/orch.sh gh-issue-create "Down: gist.app.space" "evidence…"        # in this repo (or pass owner/repo as 3rd arg)
scripts/orch.sh gh-issue-close 7 "recovered at 14:02Z"
```
