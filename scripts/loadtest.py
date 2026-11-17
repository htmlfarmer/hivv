#!/usr/bin/env python3
"""Load test for the HIVV gateway.

Answers the question that matters before a launch: "if too many users show
up, what breaks first?"

It measures the READ paths a browser hits constantly (health, manifest,
models, the public status dashboard) and the WRITE path that costs real
compute (chat). It reports latency percentiles, error rates, and — the part
that matters — WHERE the time went.

Stdlib only: no wrk, no ab, no pip install.

Usage:
    python3 scripts/loadtest.py                       # against the live gateway
    python3 scripts/loadtest.py --url http://...      # somewhere else
    python3 scripts/loadtest.py --concurrency 50 --duration 20
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict

DEFAULT_BASE = "http://127.0.0.1:3011"

# (name, path, method, body) — the endpoints a browser actually hammers.
READ_PATHS = [
    ("health", "/api/health", "GET", None),
    ("manifest", "/api/partner/manifest", "GET", None),
    ("models", "/v1/models", "GET", None),
    ("public-status", "/api/public/status", "GET", None),
    ("capabilities", "/api/capabilities", "GET", None),
]

WRITE_PATHS = [
    ("chat", "/v1/chat/completions", "POST",
     {"model": "auto", "messages": [{"role": "user", "content": "ping"}],
      "stream": False, "max_tokens": 8}),
]


class Result:
    __slots__ = ("name", "status", "ms", "error")

    def __init__(self, name, status, ms, error=None):
        self.name = name
        self.status = status
        self.ms = ms
        self.error = error


def one_request(base, name, path, method, body, timeout):
    started = time.perf_counter()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path, data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        e.read()
        status = e.code
    except Exception as e:
        return Result(name, 0, (time.perf_counter() - started) * 1000, str(e)[:120])
    return Result(name, status, (time.perf_counter() - started) * 1000)


def percentile(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def run_phase(base, paths, concurrency, duration, timeout, label):
    results = []
    lock = threading.Lock()
    stop_at = time.time() + duration

    def worker():
        local = []
        while time.time() < stop_at:
            for name, path, method, body in paths:
                r = one_request(base, name, path, method, body, timeout)
                local.append(r)
                if time.time() >= stop_at:
                    break
        with lock:
            results.extend(local)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(concurrency)]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.perf_counter() - t0

    by_name = defaultdict(list)
    for r in results:
        by_name[r.name].append(r)

    print(f"\n── {label} ── {concurrency} concurrent, {elapsed:.1f}s")
    print(f"  {'endpoint':<16}{'n':>7}{'rps':>9}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>9}{'err':>8}")
    for name in sorted(by_name):
        rs = by_name[name]
        times = [r.ms for r in rs]
        errors = sum(1 for r in rs if r.status == 0 or r.status >= 500)
        rate_limited = sum(1 for r in rs if r.status == 429)
        rps = len(rs) / elapsed if elapsed else 0
        print(f"  {name:<16}{len(rs):>7}{rps:>9.1f}{percentile(times,.5):>8.1f}ms"
              f"{percentile(times,.95):>8.1f}ms{percentile(times,.99):>8.1f}ms"
              f"{max(times) if times else 0:>8.1f}ms"
              f"{errors:>4}{('+'+str(rate_limited)+'rl' if rate_limited else ''):>4}")
    return results, elapsed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_BASE, help=f"base URL (default {DEFAULT_BASE})")
    ap.add_argument("--concurrency", type=int, default=20)
    ap.add_argument("--duration", type=int, default=10)
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--skip-write", action="store_true", help="skip the chat phase")
    args = ap.parse_args()

    base = args.url.rstrip("/")
    print(f"\n== HIVV load test ==")
    print(f"  target      : {base}")
    print(f"  concurrency : {args.concurrency}")
    print(f"  duration    : {args.duration}s per phase")

    # warm the connections
    for name, path, method, body in READ_PATHS:
        one_request(base, name, path, method, body, args.timeout)

    read_results, read_elapsed = run_phase(
        base, READ_PATHS, args.concurrency, args.duration, args.timeout, "READ paths")

    write_results = []
    if not args.skip_write:
        # Chat costs real model time — use a smaller load so we measure the
        # pipeline, not how fast the local GPU can be melted.
        write_results, _ = run_phase(
            base, WRITE_PATHS, max(2, args.concurrency // 4), max(3, args.duration // 3),
            args.timeout, "WRITE paths (chat)")

    print("\n== verdict ==")
    all_results = read_results + write_results
    if not all_results:
        print("  no results")
        return 1
    errors = [r for r in all_results if r.status == 0 or r.status >= 500]
    limited = [r for r in all_results if r.status == 429]
    times = [r.ms for r in all_results]
    print(f"  total requests : {len(all_results)}")
    print(f"  5xx / errors   : {len(errors)}  ({100*len(errors)/len(all_results):.2f}%)")
    print(f"  429 limited    : {len(limited)}")
    print(f"  p50 / p95 / p99: {percentile(times,.5):.1f} / {percentile(times,.95):.1f} / {percentile(times,.99):.1f} ms")
    if errors:
        from collections import Counter
        c = Counter(f"{r.status}:{(r.error or '')[:60]}" for r in errors)
        print("  error kinds:")
        for k, n in c.most_common(5):
            print(f"    {n:>5}  {k}")
    if percentile(times, .95) < 200 and len(errors) == 0:
        print("  → healthy under this load")
    elif len(errors) == 0:
        print("  → OK, but p95 is above 200ms — look for a cache")
    else:
        print("  → OVERLOADED — this is where it breaks first")
    return 0


if __name__ == "__main__":
    sys.exit(main())
