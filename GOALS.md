# Goals

Owned by Yuke. The manager syncs this file into the board on every run (`scripts/board.sh goals-sync`), so editing it is all it takes: use the editor at https://yuke-persistent-agent-flow.yuke-521.workers.dev/goals (one commit on `main` per save) or push with git. Every push to `main` fires the manager within about a minute (otherwise it runs at :13 and :43); the run picks up new goals, new catalog items and changed rules, and reconciles the board.
Format: one `## Goal <id>: <title>` section per goal. The lines `- status:` (`active`, `paused` or `done`; only active goals hand out tasks), `- min_ready:` (how many ready tasks the manager keeps queued) and `- done-when:` are parsed; everything else in the section is the goal body the manager plans from, so it should say what a task looks like and how the reviewer can check it. Removing a section pauses that goal. A "Catalog" paragraph of `- category: item, item` lines gives the goal a progress bar on the board. A goal whose tasks are research memos says `kind doc` and names the brief the manager maintains for it (`brief: <id>`); those briefs are what the human reads, at `/docs/<id>` on the board.

Worker 1 prefers Goal C tasks and worker 2 prefers Goal D tasks (`WORKER_GOALS_1` / `WORKER_GOALS_2` in `worker/agent-worker.env`); either takes any other active goal's tasks when its own are exhausted.

## Goal A: TypeScript algorithms and data structures library
- status: paused
- min_ready: 6
- done-when: every catalog item below is accepted.

Purpose: a small, well-tested library, one module per catalog item, each with unit tests, a doc comment and a micro-benchmark. No network. MIT.

Task shape (one catalog item = one task, key `A/<category>/<name>`, kind `ts`, 45 minutes, priority 5):
- `out/src/<category>/<name>.ts` — the implementation; exported functions or classes with a JSDoc block that states the complexity.
- `out/src/<category>/<name>.test.ts` — vitest; normal cases, edge cases (empty, single element, duplicates, negative or huge values), and where sensible a randomized test against a naive reference implementation.
- `out/bench/<category>/<name>.bench.ts` — a tiny timing script runnable with `npx tsx`, no dependencies.
- `out/README.md` — one paragraph: what it is, the API, complexity, how to run the tests.

Acceptance (the manager runs these in a fresh copy of the template):
- `npx tsc --noEmit -p .` passes.
- `npx vitest run` passes with at least 8 tests, including the listed edge cases.
- The implementation is the real algorithm, not a wrapper around a built-in; no `any`; input arrays are not mutated unless the spec says so.

Catalog (work top to bottom; the manager keeps `min_ready` tasks open):
- sorting: merge-sort, quick-sort (3-way partition), heap-sort, insertion-sort, counting-sort, radix-sort (LSD, non-negative integers), shell-sort, timsort-lite (natural runs + merge)
- searching: binary-search (with lower and upper bound), exponential-search, interpolation-search, ternary-search (unimodal function), quickselect (k-th smallest), two-sum (sorted two-pointer and hash map)
- heaps and queues: binary-heap (min and max), d-ary-heap, indexed-priority-queue (decrease-key), ring-buffer-deque, monotonic-queue (sliding-window maximum), median-stream (two heaps)
- sets and caches: union-find (path compression, union by rank), bloom-filter, lru-cache, lfu-cache, bitset, count-min-sketch
- trees: binary-search-tree, avl-tree, red-black-tree (insert and search), treap, splay-tree, segment-tree (range sum and min, point update), lazy-segment-tree (range add, range sum), fenwick-tree, trie, ternary-search-tree, kd-tree (2D nearest neighbour), interval-tree, skip-list, b-tree-lite (order 4, insert and search)
- graphs: bfs, dfs (iterative and recursive), topological-sort (Kahn and DFS, cycle detection), dijkstra (binary heap), bellman-ford (negative cycle detection), floyd-warshall, kruskal, prim, tarjan-scc, kosaraju-scc, articulation-points, bridges, bipartite-check, edmonds-karp (max flow), dinic, hopcroft-karp (bipartite matching), a-star (grid), lca-binary-lifting, connected-components
- strings: kmp, z-algorithm, rabin-karp, boyer-moore-horspool, aho-corasick, suffix-array (O(n log² n)), lcp-array (Kasai), manacher, edit-distance, longest-common-subsequence, longest-palindromic-substring, rolling-hash (double modulus), run-length-encoding, huffman-coding
- number theory and math: sieve-of-eratosthenes (segmented), extended-gcd (with lcm), modpow-modinv, miller-rabin (deterministic for 64-bit, BigInt), pollard-rho, chinese-remainder, fast-fibonacci (matrix), combinatorics (nCr mod p, Lucas), bigint-string-arithmetic (add, multiply, divmod on decimal strings), fft-polynomial-multiply, karatsuba, prime-factorization, euler-totient
- dynamic programming: knapsack-0-1, unbounded-knapsack, coin-change (ways and minimum coins), lis (n log n), matrix-chain, rod-cutting, subset-sum (bitset), egg-drop, weighted-interval-scheduling, longest-common-substring, palindrome-partitioning, word-break, kadane (1D and 2D), bitmask-tsp (n ≤ 15)
- geometry: convex-hull (Andrew monotone chain), segment-intersection, point-in-polygon, closest-pair (divide and conquer), shoelace-area, rectangle-union-area (sweep), rotating-calipers-diameter
- misc: reservoir-sampling, fisher-yates, top-k (heap and quickselect), interval-merge, meeting-rooms, token-bucket-rate-limiter, consistent-hashing (ring), lru-with-ttl, json-pointer, base64-codec

## Goal B: Python port with differential cross-checks
- status: paused
- min_ready: 4
- done-when: every accepted Goal A item has an accepted Python twin and an accepted cross-check.

Purpose: the same catalog in Python 3.11+, one module per item, each with pytest tests (hypothesis where sensible), then one cross-check task per pair that runs both implementations on random inputs and fails on any disagreement. This gives the manager an objective signal that neither worker can game alone.

Task shapes:
- `B/<category>/<name>` (kind `py`, 45 minutes, deps: the accepted `A/<category>/<name>`; its files appear under `deps/`): `out/py/<category>/<name>.py`, `out/tests/test_<name>.py` (at least 8 tests including edge cases), `out/README.md`. Acceptance: `.venv/bin/pytest -q` passes; same public behaviour and, where possible, the same function names as the TypeScript module; type hints; no third-party runtime dependencies.
- `X/<category>/<name>` (kind `check`, 30 minutes, deps: the accepted A and B twins): `out/xcheck/<name>/gen.py` (deterministic random cases, seeds 1 to 200, printed as JSON lines), `out/xcheck/<name>/run_ts.ts` and `out/xcheck/<name>/run_py.py` (read cases from stdin, print one JSON result per line), `out/xcheck/<name>/check.sh` (runs both with `npx tsx` and `.venv/bin/python`, diffs the outputs, exits 1 on any mismatch), `out/REPORT.md` with the case count and any mismatch. Acceptance: `bash out/xcheck/<name>/check.sh` exits 0 over at least 200 cases.
The manager creates a B task only after its A twin is accepted, and an X task only after both twins are accepted.

## Goal C: DeepSpace B2B go-to-market
- status: active
- min_ready: 3
- done-when: never; this is a standing research desk whose rounds repeat with fresh angles.

Purpose: a standing research and brainstorming desk on how DeepSpace wins business customers: which segments to target, how to position against Supabase, Firebase, Convex, Liveblocks and the AI app builders, which channels and plays acquire teams and companies, and what evidence exists from other developer-platform companies. The memos are raw material; the product of this goal is the brief the manager maintains for the CEO on the board (`brief: gtm-b2b`).

What DeepSpace is (the framing every task gets; the product-brief task turns the official pages into a short brief that every later task receives under `deps/`):
- "The first app engine — secure, scalable, and production-ready from day one." A full-stack SDK plus hosting on Cloudflare Workers that lets an AI coding agent (or a developer) build, deploy and ship a real-time app from a prompt: auth and role-based permissions, SQLite-backed real-time sync, presence and live cursors, Yjs collaborative editing, channel messaging with reactions and read receipts, file storage, streamed AI chat (Claude, GPT, Cerebras) with tool use, Stripe checkout and paywalls, scheduled and background jobs, and one-command deploys to `<app>.app.space` or a custom domain with TLS. Scaffolds ship Vite + React, a Hono worker, file-based routing, Tailwind v4 and six Durable Object classes. Free to start, paid plans for scale. Positioned against Supabase, Firebase and Convex as "the whole app, not components". There is a hosted builder at https://deep.space, docs at https://docs.deep.space, a dashboard at https://dashboard.deep.space, code at https://github.com/deepdotspace, and a Discord.
- Pages to read (tell the workers to fetch them): https://deep.space, https://deep.space/get-started, https://docs.deep.space (Get started, Core concepts, Going to production).

Task shape (`kind doc`, key `C/<slug>`, 20 minutes, 2 attempts, priority 5; every task except `C/brief` depends on `C/brief`):
- `out/MEMO.md`, at most 1,200 words, sections in this order: **Question** (one line), **Findings** (5 to 10 bullets, each specific and attributed), **Recommendations** (ranked, 3 to 7, each with the why and a first step), **Evidence** (every URL fetched with a one-line takeaway; anything from model knowledge labelled "unverified"), **Confidence and gaps** (what would change the conclusion).
- `out/REPORT.md` with Summary, Files, Sources used, Known gaps.
- Research means: fetch the pages the spec names (webfetch tool or curl; the machine has internet), compare with what the product brief says, think, rank. No code. The spec must list the URLs to fetch and the two or three questions the memo has to answer, and remind the worker of the product framing above.

Acceptance (the manager reads the memo; see manager/PROMPT.md "Research goals"): on DeepSpace, format respected, at least 5 concrete findings, evidence cited or labelled, nothing invented.

Brief the manager maintains: `brief: gtm-b2b`, title "DeepSpace B2B go-to-market brief", under 1,500 words, rewritten in place after every run that accepted memos (never appended), with exactly these sections:
1. As of <date> · Bottom line (three bullets the CEO should act on now)
2. Ranked recommendations (at most 10: what, why, evidence pointer, confidence)
3. What we know (grouped: market and segments; competitors; positioning and messaging; pricing and packaging; channels and plays)
4. Competitor snapshot (table: name, positioning, pricing, where they beat DeepSpace, where DeepSpace beats them)
5. Open questions for the CEO (at most 6)
6. Sources (URLs actually fetched, at most 15)
7. Changelog (last 5 rewrites: date, what changed, which memos were folded in)

Catalog (one task each, in order; when every item has an accepted memo the next round starts with `-r2` keys and the brief's open questions as extra input):
- foundation: brief (the product brief from the official pages: what DeepSpace is, for whom, features, pricing, deploy story, how it positions against Supabase/Firebase/Convex, glossary; `out/BRIEF.md` of at most 900 words instead of MEMO.md, plus REPORT.md; no dependency), icp (ideal customer profiles for B2B: agencies, SaaS teams adding realtime or collaboration, internal-tool teams, AI-native startups, game and edtech studios; pains, triggers, budget owner, where they gather)
- competitors: competitor-supabase (https://supabase.com and https://supabase.com/pricing), competitor-firebase (https://firebase.google.com and https://firebase.google.com/pricing), competitor-convex (https://www.convex.dev and https://www.convex.dev/pricing), competitor-liveblocks (https://liveblocks.io and https://liveblocks.io/pricing), competitor-partykit-cloudflare (https://www.partykit.io and https://developers.cloudflare.com/durable-objects/), competitor-ably-pusher (https://ably.com/pricing and https://pusher.com/pricing), competitor-ai-builders (Lovable, Bolt.new, v0, Replit Agent and Base44 as B2B substitutes: https://lovable.dev, https://bolt.new, https://v0.app, https://replit.com, https://base44.com), competitor-local-first (Electric SQL, PowerSync, Zero, InstantDB: https://electric-sql.com, https://www.powersync.com, https://zero.rocicorp.dev, https://www.instantdb.com)
- positioning: positioning (three positioning statements and a messaging hierarchy per ICP; the "app engine" claim versus "backend as a service"), pricing-packaging (how the free tier and paid plans should be shaped for teams; usage versus seats; what competitors charge), objections (the top 15 objections such as lock-in, Cloudflare-only, maturity, migration, data residency, with answers and the proof each needs), enterprise-readiness (what enterprise buyers require and a prioritized roadmap of GTM-relevant capabilities)
- channels: developer-marketing (docs, templates, examples, quickstarts and DX as acquisition; what Vercel, Supabase, Clerk and Resend did), content-strategy (a 12-week content plan with topics, formats, channels, each tied to a template or example app), launch-plan (Product Hunt, Hacker News, X, YouTube and newsletter launches; sequencing; what worked for PlanetScale, Supabase and Convex), community (Discord, GitHub, office hours, champions; how to seed and moderate), partnerships (the Cloudflare ecosystem, AI coding agents such as Claude Code, Cursor, Codex and Lovable, agencies, marketplaces), ai-agent-channel (how to become the backend AI coding agents pick by default: skills, MCP, templates, docs written for agents), agencies-channel (a partner program for agencies and freelancers building client apps), events (conferences, meetups and hackathons worth sponsoring or speaking at, with cost and expected yield), pr-analysts (press, analysts, newsletters and podcasts that reach the buyers)
- sales: outbound (a first outbound play: target-list criteria, sequences, messaging, tooling, what to measure), sales-process (self-serve to enterprise: qualification, demos, proofs of concept, procurement needs such as SOC 2, SSO, DPA and SLAs, pricing floors), migration-plays ("switch from Firebase or Supabase" playbooks and incentives), case-studies (which early customers and apps to turn into case studies, the template, how to get them)
- evidence: success-stories (three developer-platform GTM success stories chosen from Vercel, Supabase, Clerk, PlanetScale, Resend, Liveblocks and Convex, with the specific moves that worked and what transfers), metrics (the B2B funnel and the 10 metrics to track weekly, with first-quarter targets), experiments (10 cheap acquisition experiments with hypothesis, cost, metric and decision rule)

## Goal D: DeepSpace B2C growth
- status: active
- min_ready: 3
- done-when: never; this is a standing research desk whose rounds repeat with fresh angles.

Purpose: how DeepSpace wins individual builders (indie hackers, students, hobbyists, creators, non-technical founders and prosumers who use the hosted builder at https://deep.space and the free tier to make and share apps), how those users compound into growth (viral `.app.space` apps, templates, community, content) and later into paying customers. Same product framing, pages and task shape as Goal C (keys `D/<slug>`); every task depends on `C/brief`, which is shared. The brief the manager maintains: `brief: gtm-b2c`, title "DeepSpace B2C growth brief", same structure as Goal C's brief.

Catalog (one task each, in order; rounds repeat with `-r2` keys):
- foundation: personas (builder personas: indie hacker, student, creator, non-technical founder, hobbyist game maker; motivations, current tools, where they gather, willingness to pay), onboarding (the first ten minutes from prompt to a shared live app: friction points, fixes, the activation metric)
- competitors: competitor-ai-builders (Lovable, Bolt.new, v0, Replit, Base44 and Create.xyz for individuals: https://lovable.dev, https://bolt.new, https://v0.app, https://replit.com, https://base44.com, https://www.create.xyz; onboarding, pricing, virality mechanics, what users complain about), competitor-no-code (Bubble, Glide, Softr and Adalo: https://bubble.io, https://www.glideapps.com, https://www.softr.io, https://adalo.com; pricing, templates, community, weaknesses)
- loops: viral-loops (how `.app.space` apps, "made with DeepSpace" badges, remix buttons and share links drive acquisition; what Glitch, Replit, Figma and Notion did), templates-gallery (20 template ideas ranked by search demand and shareability, with the loop each creates), monetization-for-builders (helping builders charge for their apps with Stripe paywalls as a growth lever), retention (what brings builders back weekly: notifications, streaks, project ideas, collaboration invites)
- channels: content-creators (YouTube, TikTok, X and newsletters: creator partnerships, formats, build-in-public plays), community (Discord, Reddit, showcases, weekly challenges, hackathons), education (students and bootcamps: programs, curricula, campus ambassadors), seo (search topics individual builders use, programmatic pages, docs SEO), launch-plan (consumer-style launches on Product Hunt, Hacker News, Reddit and TikTok; sequencing), ai-agents-for-individuals (how individuals use Claude Code, Cursor, ChatGPT and Codex to build apps and how DeepSpace inserts itself), localization (markets and languages worth an early push)
- pricing: pricing-free-tier (free-tier design and the individual paid plan: limits, upgrade triggers, what competitors do), objections (why individuals bounce: price, trust, lock-in, complexity; answers)
- evidence: success-stories (three consumer or prosumer dev-tool growth stories chosen from Replit, Glitch, Figma, Notion, Canva and v0, with transferable moves), metrics (the B2C funnel and 10 weekly metrics with first-quarter targets), experiments (10 cheap growth experiments with hypothesis, cost, metric and decision rule)

## Pace and sizing
- Daily spend target $1.60 (80 % of OpenCode Go's $60 per month). The manager may move it between $0.50 and $2.50 with `scripts/board.sh pace`.
- Tasks get 45 minutes (the e2-micro is slow: a session that takes 1 minute on a laptop takes 10 to 25 here) and 3 attempts. Anything bigger gets split. Research memos (kind doc) get 20 minutes and 2 attempts and cost about $0.03 to $0.06 each.
- The board releases the daily pace hour by hour (smooth mode: 20 % at 00:00 UTC, then 1/24 per hour), so work spreads over the whole day instead of burning the budget in the first hours; `scripts/board.sh pace-mode burst` restores the old behaviour.
