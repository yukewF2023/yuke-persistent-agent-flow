# yuke-persistent-agent-flow

Two **persistent, self-scheduling agents** running 24/7 on a personal free Cloudflare account, using **DeepSeek V4.1 Flash through the $10/month OpenCode Go subscription**, managed by a **Claude orchestrator** that runs every 6 hours. Built for the team ask: *"everyone runs persistent agents with little oversight, on deepseek-flash-4-1, via OpenCode Go."*

Live: **https://yuke-persistent-agent-flow.yuke-521.workers.dev** — the Worker's root page shows each agent's last tick, next tick, run count, token spend and notes over days. The plan and architecture diagram live in [docs/PLAN.md](docs/PLAN.md).

## What "persistent" and "constantly working" mean here
Each agent is a Cloudflare **Durable Object** with its own SQLite memory running a **never-ending work loop**: a segment of work runs for up to ~2 minutes, then arms an alarm one second out, and the next segment continues. Nothing polls it and nothing is lost between segments because every table lives in the object. The loop pulls from a **worklist the agent maintains itself**:

- **code items** run without the model and cost nothing: fetch, probe, read pages, expire, rank, check clocks. They run nonstop.
- **think items** call DeepSeek V4.1 Flash for judgement (review, triage, extract, deliver, plan). They are paced by a **spend governor**: each agent has a monthly dollar budget (uptime $12, scout $30 by default) and a small bucket that refills at that rate; a think runs when the bucket can pay for it, otherwise the agent keeps doing code work and reports "pacing". Hard stops at 90% of Go's 5-hour / weekly / monthly windows. Every think records its real cost (Go's published prices, peak hours ×2) and the status page shows the bars.

So the agent is always doing something visible, and the model thinks as often as the budget allows. Errors never kill the loop; a failed item is logged and the next segment continues.

## The two agents
| Agent | Job | Cost profile |
|---|---|---|
| **uptime** | Checks all six DeepSpace apps every minute, deep-probes one app every 30 s (time to first byte, size drift, history), rebuilds a 24 h latency report hourly, writes DOWN/RECOVERED notes from code, and thinks (`review`) after changes or every 8 checks; handles manager tasks like "add target X". | code nonstop; ~$12/month of model time |
| **scout** (Weekend scout) | Continuous pipeline: refresh curated sources → paced web search (~33/day) → `triage` hits → read pages → `extract` dated events into a candidate pool → `deliver` 5–7 picks Wed 18:00 / Fri 12:00 ET (ntfy push) → `plan` new searches when the well runs dry. Learns from 👍/👎. | code nonstop; ~$30/month of model time |

Explored and dropped: CT DMV appointment watching (the scheduler demands name, date of birth, address and a captcha before showing slots — not automatable without personal data); Global Entry slot watching (feasible via the public CBP scheduler JSON, `locationId=14681` for Hartford/Windsor Locks, not wanted for now).

## The orchestrator (the manager)
A Claude Code cloud routine (see [orchestrator/ROUTINE.md](orchestrator/ROUTINE.md)) runs [orchestrator/PROMPT.md](orchestrator/PROMPT.md) every 6 h: health repair, quality review against charters (it can rewrite an agent's charter override), tuning the scout's search profile from your feedback, turning [orchestrator/GOALS.md](orchestrator/GOALS.md) into queue items, opening/closing GitHub outage issues, and escalating only what needs a human. It talks to the Worker through `scripts/orch.sh` (see [docs/orchestrator.md](docs/orchestrator.md)), and can also move budget between agents (`governor`), inject work items (`work-add`) and read the live feed (`activity`).

**How you steer it** (everything lands in the Worker's feedback mailbox, read on the next run):
- the private picks page with 👍/👎 buttons and a text box: `scripts/orch.sh picks-link`
- `scripts/orch.sh feedback "more outdoors, fewer coffee things"`
- a plain-text comment on the **Weekend picks** or **Team log** GitHub issue
- editing `orchestrator/GOALS.md`
- for "act now": `scripts/orch.sh manager-now`

## Setup
```bash
npm install
npm run setup:env        # copies the OpenCode Go key from ~/.local/share/opencode/auth.json, generates tokens, prompts for the Tavily key
npm run dev              # http://localhost:8787
```
Requirements outside this repo: an OpenCode Go subscription (`opencode auth login`, and in the OpenCode dashboard set the workspace **Privacy → region to Global**, which DeepSeek V4.1 Flash requires), a free Tavily key, optionally a Ticketmaster key and the ntfy app subscribed to the generated topic.

## Deploy
```bash
npx wrangler whoami      # must be the personal account
npm run secrets:push     # pushes .dev.vars as Worker secrets
npm run deploy
```
Open the Worker URL once; the agents bootstrap their first alarm on first contact.

## Cost bounds
| Bound | Value |
|---|---|
| Model budget | uptime $12/month, scout $30/month (governor; sum kept ≤ $45 of Go's $60) |
| Tool steps / think | 6 (`MAX_STEPS`), 1,500 output tokens |
| Subrequests / segment | ≤ 40 (free plan allows 50 per invocation) |
| Idle gap | ≥ 30 s (keeps DO row writes under the free plan's 100k/day) |
| Tavily | ≤ 33 searches/day (1,000 free/month) |
| Cloudflare | free plan; a few hundred requests/day |
| Orchestrator | 4 short Claude runs/day |

## Layout
```
charters/        standing instructions per agent (imported into the system prompt)
orchestrator/    PROMPT.md (the manager loop), GOALS.md (yours), apps.json (url → repo), ROUTINE.md
scripts/         setup-env.mjs, orch.sh
src/agents/      base-agent.ts (tick loop, scheduling, memory, budgets), uptime-agent.ts, weekend-scout-agent.ts
src/tools/       http (counted fetch), search (Tavily), reader (Jina), ticketmaster, notify (ntfy), time, common (note/queue/finish tools)
src/             index.ts (router), admin.ts, team-state.ts (mailbox + log), status-page.ts, picks-page.ts, llm.ts, rpc.ts, types.ts
docs/            PLAN.md, orchestrator.md
```
