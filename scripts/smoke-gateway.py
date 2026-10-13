#!/usr/bin/env python3
"""A stand-in for the agent-board app's research gateway, for scripts/smoke.sh only.

Listens on 127.0.0.1:8799 and answers POST /<source> the way the gateway does: results plus cost_usd, or an error that
says what happened to the money. The query picks the case: "retained" → the provider kept a worst-case charge;
"down" → an answer without the gateway's shape (a platform error page), which counts toward the board's breaker.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("SEARCH_GATEWAY_TOKEN", "")
COST = {"x": 0.0039, "web": 0.02, "reddit": 0.02, "news": 0.02, "hn": 0.0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.reply(401, {"error": "unauthorized"})
        source = self.path.strip("/")
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        q = str(body.get("q", ""))
        if q == "retained":
            return self.reply(502, {"error": "exa/search: upstream timed out", "billing": "retained", "cost_usd": 0.65})
        if q == "down":
            return self.reply(500, b"<html>platform error</html>", "text/html")
        results = [
            {"url": f"https://x.com/opslead/status/{abs(hash(q)) % 10**12}", "source": source, "author": "@opslead", "date": "2026-10-07", "text": f"we outgrew airtable fast; {q}", "engagement": {"likes": 3}},
            {"url": "https://news.ycombinator.com/item?id=41", "source": source, "author": "pg", "date": "2026-10-02", "title": "Ask HN: build vs buy", "text": "We built it in-house and regret it", "engagement": {"points": 12}},
        ]
        return self.reply(200, {"results": results, "cost_usd": COST.get(source, 0.01)})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
