#!/usr/bin/env python3
"""The dial shim must not depend on DNS to start.

The macOS CI runner failed for weeks with:

    shim never became healthy (alive=True pid=… waited=10s, log_bytes=32)
    --- shim output ---
    [hivv] dial starting (pid …)

The process was alive. It had printed one line. It had never reached
"dial ready" — because the BIND was still waiting on a reverse DNS lookup.

http.server.HTTPServer.server_bind does socket.getfqdn(host), which is a
PTR lookup for the bind address. On a machine whose resolver is slow, or
which has no PTR record for 127.0.0.1, that blocks for tens of seconds. A
local proxy that cannot answer because the resolver is slow is worse than
useless: clients get a connection refused instead of a 502.

The test poisons socket.getfqdn in the SHIM'S OWN PROCESS — via
sitecustomize.py, which Python imports before anything else — so this
exercises the real cmd_dial code path, not a copy of it.

Run:
    python3 tests/test_dial_startup.py
"""

from __future__ import annotations

import importlib.util
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> bool:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32mPASS\033[0m  {name}")
    else:
        FAIL += 1
        print(f"  \033[31mFAIL\033[0m  {name}  {detail}")
    return bool(cond)


def free_port() -> int:
    with socket.socket() as tmp:
        tmp.bind(("127.0.0.1", 0))
        return tmp.getsockname()[1]


# sitecustomize is imported by Python at startup, before the CLI runs. It
# turns every reverse lookup into a hard failure, so any code path that
# still calls getfqdn CRASHES instead of quietly blocking.
POISON = """
import socket as _s


def _no_getfqdn(host=None):
    raise RuntimeError(
        "reverse DNS was attempted during the dial shim's bind — "
        "the shim must not depend on DNS to start")

_s.getfqdn = _no_getfqdn
"""


def run_shim(env_extra: dict, port: int, wait: float = 15.0):
    """Start the shim and wait for it to answer /healthz."""
    log = Path(tempfile.gettempdir()) / f"dial-startup-{port}.log"
    env = {**os.environ, "PYTHONUNBUFFERED": "1", **env_extra}
    with open(log, "wb") as fh:
        proc = subprocess.Popen(
            [sys.executable, str(CLI), "dial", "--port", str(port)],
            stdout=fh, stderr=subprocess.STDOUT, env=env)
    try:
        deadline = time.time() + wait
        while time.time() < deadline:
            if proc.poll() is not None:
                return False, log.read_text(errors="replace")[-400:]
            try:
                import json
                import urllib.request
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/healthz", timeout=0.5) as r:
                    data = json.loads(r.read().decode("utf-8", "replace"))
                if data.get("shim") == "hivv-dial":
                    return True, log.read_text(errors="replace")[-400:]
            except Exception:
                pass
            time.sleep(0.2)
        return False, log.read_text(errors="replace")[-400:]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    # ── the stock behaviour, for contrast ─────────────────────────────────
    # If a future Python stops doing the reverse lookup, the note in the
    # fix goes stale — so assert it directly.
    stock: list[str] = []
    real = socket.getfqdn

    def spy(host):
        stock.append(host)
        return real(host)

    socket.getfqdn = spy
    try:
        import http.server

        class S(http.server.ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        srv = S(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
        srv.server_close()
    finally:
        socket.getfqdn = real
    check("the STOCK HTTPServer does a reverse lookup (so the override is needed)",
          bool(stock), "the stock behaviour changed — re-check the fix")

    # ── the REAL shim, with DNS poisoned ──────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="hivv-no-dns-") as td:
        (Path(td) / "sitecustomize.py").write_text(POISON)
        env = {"PYTHONPATH": td}
        ok, out = run_shim(env, free_port())
        check("the shim starts even when reverse DNS raises", ok, out)
        check("the shim reaches 'dial ready' without DNS",
              "dial ready" in out, out)
        check("the shim never asked for a PTR record",
              "reverse DNS was attempted" not in out, out)

    # ── and it still works normally ───────────────────────────────────────
    ok, out = run_shim({}, free_port())
    check("the shim starts normally too", ok, out)

    print()
    print(f"  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
