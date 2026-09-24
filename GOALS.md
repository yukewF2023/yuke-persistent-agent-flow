# Goals

Owned by Yuke. The manager syncs this file into the board on every run (`scripts/board.sh goals-sync`).
Format: one `## Goal <id>: <title>` section per goal. The lines `- status:`, `- min_ready:` and `- done-when:` are parsed; everything else in the section is the goal body the manager plans from.

## Goal A: TypeScript algorithms and data structures library
- status: active
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
- status: active
- min_ready: 4
- done-when: every accepted Goal A item has an accepted Python twin and an accepted cross-check.

Purpose: the same catalog in Python 3.11+, one module per item, each with pytest tests (hypothesis where sensible), then one cross-check task per pair that runs both implementations on random inputs and fails on any disagreement. This gives the manager an objective signal that neither worker can game alone.

Task shapes:
- `B/<category>/<name>` (kind `py`, 45 minutes, deps: the accepted `A/<category>/<name>`; its files appear under `deps/`): `out/py/<category>/<name>.py`, `out/tests/test_<name>.py` (at least 8 tests including edge cases), `out/README.md`. Acceptance: `.venv/bin/pytest -q` passes; same public behaviour and, where possible, the same function names as the TypeScript module; type hints; no third-party runtime dependencies.
- `X/<category>/<name>` (kind `check`, 30 minutes, deps: the accepted A and B twins): `out/xcheck/<name>/gen.py` (deterministic random cases, seeds 1 to 200, printed as JSON lines), `out/xcheck/<name>/run_ts.ts` and `out/xcheck/<name>/run_py.py` (read cases from stdin, print one JSON result per line), `out/xcheck/<name>/check.sh` (runs both with `npx tsx` and `.venv/bin/python`, diffs the outputs, exits 1 on any mismatch), `out/REPORT.md` with the case count and any mismatch. Acceptance: `bash out/xcheck/<name>/check.sh` exits 0 over at least 200 cases.
The manager creates a B task only after its A twin is accepted, and an X task only after both twins are accepted.

## Pace and sizing
- Daily spend target $1.60 (80 % of OpenCode Go's $60 per month). The manager may move it between $0.50 and $2.50 with `scripts/board.sh pace`.
- Tasks get 45 minutes (the e2-micro is slow: a session that takes 1 minute on a laptop takes 10 to 25 here) and 3 attempts. Anything bigger gets split.
