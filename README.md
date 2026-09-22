# yuke-persistent-agent-flow

Two **persistent, self-scheduling agents** running 24/7 on a personal free Cloudflare account, using **DeepSeek V4.1 Flash through the $10/month OpenCode Go subscription**, managed by a **Claude orchestrator** that runs every 6 hours. Built for the team ask: *"everyone runs persistent agents with little oversight, on deepseek-flash-4-1, via OpenCode Go."*

Live proof: the Worker's root page shows each agent's last tick, next tick, run count, token spend and notes over days. The plan and architecture diagram live in [docs/PLAN.md](docs/PLAN.md).

## What "persistent" means here
Each agent is a Cloudflare **Durable Object** with its own SQLite memory (notes, queue, runs, agent-specific tables) and **exactly one pending alarm that it sets itself at the end of every tick**. Nothing polls it; nothing keeps a process hot. A tick is: load memory → observe (deterministic fetches) → let the model decide with tools → persist → schedule the next wake. Errors never kill an agent; they back off and reschedule. The model chooses what to do and when to wake next, within charter policy and hard budget caps. That is the difference from a cron job.

## The two agents
| Agent | Job | Cost profile |
|---|---|---|
| **uptime** | Fetches the six DeepSpace apps, writes DOWN/RECOVERED notes on change, adapts cadence (5 min when something is down, up to 1 h when clean), handles manager tasks like "add target X". | ~6 fetches + 1 short LLM call per tick |
| **scout** (Weekend scout) | Researches things to do on weekends near West Hartford CT (date ideas, coffee sessions, workshops, farms, seasonal), keeps a candidate pool with memory, delivers 5–7 picks Wed 18:00 and Fri 12:00 ET, pushes to the phone via ntfy, learns from 👍/👎. | ≤25 Tavily searches/day, 2 research ticks/day |

Explored and dropped: CT DMV appointment watching (the scheduler demands name, date of birth, address and a captcha before showing slots — not automatable without personal data); Global Entry slot watching (feasible via the public CBP scheduler JSON, `locationId=14681` for Hartford/Windsor Locks, not wanted for now).

## The orchestrator (the manager)
A Claude Code cloud routine (see [orchestrator/ROUTINE.md](orchestrator/ROUTINE.md)) runs [orchestrator/PROMPT.md](orchestrator/PROMPT.md) every 6 h: health repair, quality review against charters (it can rewrite an agent's charter override), tuning the scout's search profile from your feedback, turning [orchestrator/GOALS.md](orchestrator/GOALS.md) into queue items, opening/closing GitHub outage issues, and escalating only what needs a human. It talks to the Worker through `scripts/orch.sh` (see [docs/orchestrator.md](docs/orchestrator.md)).

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
| LLM steps / tick | 8 (`MAX_STEPS`) |
| Output tokens / step | 900 |
| Subrequests / tick | ≤ 30 (shared counter; free plan allows 50) |
| Daily tokens / agent | 400k, then deterministic fallback |
| Tavily | ≤ 25 searches/day |
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
