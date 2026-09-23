# Handoff (2026-09-23)

## State
- Live: https://yuke-persistent-agent-flow.yuke-521.workers.dev (personal CF account yuke@deep.space). Repo public at github.com/yukewF2023/yuke-persistent-agent-flow. Issues #1 Team log, #2 Weekend picks.
- Two DeepSeek V4.1 Flash agents (OpenCode Go) as Durable Objects running a never-ending segment loop over a self-maintained worklist; code items free/nonstop, think items paced by a per-agent dollar governor (orchestrator set uptime $8, scout $34).
- Claude orchestrator: cloud routine `trig_0144Fo1i6xENAvLa58h3BBQ1` every 6 h (env vars WORKER_URL / ORCHESTRATOR_TOKEN / GITHUB_TOKEN live in the "Default" cloud environment; network allowlist includes the Worker host and api.github.com). Local fallback `scripts/orch.sh manager-now`.
- Health snapshot: `scripts/monitor.sh`. CLI: `scripts/orch.sh` (defaults to production).
- 6-hour watch on 2026-09-23 01:35–07:30Z: clean; two fixes shipped (finish recovery on forced last step; per-agent whitelist of self-plannable actions).

## Open question for the next session
Teammate (Donald) asked for agents that are "constantly working", not "wake every N minutes". Current design = continuous loop, but chores inside it are paced (checks every 60 s, probes every 30 s, one search ≈ every 45 min) and model steps are budget-paced (~$1/day for the scout ⇒ a think every ~10 min). Yuke suspects this still isn't what Donald means. To settle: what does "constantly working" look like to him (visible model activity? unbounded loop? a task that is inherently endless?), and what budget is acceptable, since an unthrottled DeepSeek loop costs ~$200+/month vs Go's $60 cap. See README "In plain words" and docs/PLAN.md "Redesign" for the current model.
