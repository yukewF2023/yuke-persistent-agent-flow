#!/usr/bin/env python3
"""Check a listen memo against its task's search log (scripts/board.sh verify-citations DIR).

Every URL the memo cites (out/MEMO.md, out/SIGNALS.json) must be one the task's searches returned, and every quote in
SIGNALS.json must be a verbatim piece of the logged text of the result it cites. DIR is what review-next wrote:
out/…, REPORT.md and SEARCH_LOG.json. Prints the problems and exits 1, or prints one OK line and exits 0.
"""
import json
import os
import re
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# DeepSpace's own pages may be cited from the spec's product framing without having been searched
OWN = ("deep.space", "app.space")


def canon(u: str) -> str:
    """One spelling per page; the same rules as the gateway's canonicalUrl (agent-board src/server/research-routes.ts)."""
    u = u.strip().rstrip(".,;:!?)]}>'\"*_`")
    if "?" in u:
        u = u.rstrip("/")
    try:
        p = urlsplit(u)
    except ValueError:
        return u
    host = (p.hostname or "").lower()
    if host in ("twitter.com", "www.twitter.com", "mobile.twitter.com", "www.x.com", "mobile.x.com"):
        host = "x.com"
    if host in ("reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com"):
        host = "www.reddit.com"
    query = urlencode([(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not (k.startswith("utm_") or k in ("s", "t", "ref", "ref_src"))])
    path = p.path.rstrip("/") if p.path not in ("", "/") else ""
    return urlunsplit(("https", host, path, query, ""))


def norm(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("…", "...")
    return re.sub(r"\s+", " ", s).strip().lower()


def own(u: str) -> bool:
    host = urlsplit(u).hostname or ""
    return any(host == o or host.endswith("." + o) for o in OWN) or u.startswith("https://github.com/deepdotspace")


def main() -> int:
    d = sys.argv[1]
    try:
        log = json.load(open(os.path.join(d, "SEARCH_LOG.json")))
    except FileNotFoundError:
        print(f"no SEARCH_LOG.json in {d} (review-next writes it for listen tasks)")
        return 2
    texts: dict[str, list[str]] = {}
    for call in log:
        for r in call.get("results") or []:
            texts.setdefault(canon(r.get("url", "")), []).append(norm(f"{r.get('title') or ''} {r.get('text') or ''}"))

    memo_path = os.path.join(d, "out", "MEMO.md")
    memo = open(memo_path).read() if os.path.exists(memo_path) else ""
    signals: list = []
    signals_path = os.path.join(d, "out", "SIGNALS.json")
    if os.path.exists(signals_path):
        try:
            raw = json.load(open(signals_path))
        except ValueError as e:
            print(f"SIGNALS.json is not valid JSON: {e}")
            return 1
        signals = raw if isinstance(raw, list) else raw.get("signals", [])
    signals = [s for s in signals if isinstance(s, dict)]

    cited = {canon(u) for u in re.findall(r"https?://[^\s<>\"'`\])]+", memo)} | {canon(str(s["url"])) for s in signals if s.get("url")}
    missing = sorted(u for u in cited if u not in texts and not own(u))
    bad = []
    quotes = 0
    for s in signals:
        if not s.get("quote"):
            continue
        quotes += 1
        q = norm(str(s["quote"])).strip("\"'").replace("...", " ").strip()
        pieces = [p.strip() for p in q.split("  ") if p.strip()]
        pool = texts.get(canon(str(s.get("url", ""))), [])
        if not pieces or not any(all(p in t for p in pieces) for t in pool):
            bad.append((str(s.get("url", "")), str(s["quote"])[:120]))

    for u in missing:
        print(f"NOT IN SEARCH LOG: {u}")
    for u, q in bad:
        print(f'QUOTE NOT VERBATIM: {u}  "{q}"')
    if missing or bad:
        print(f"{len(missing)} cited URL(s) not returned by this task's searches, {len(bad)} quote(s) not found in the logged text of the result they cite")
        return 1
    print(f"OK: {len(cited)} cited URLs, all returned by this task's searches ({len(log)} calls); {quotes} quotes, all verbatim")
    return 0


if __name__ == "__main__":
    sys.exit(main())
