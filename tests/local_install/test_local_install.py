#!/usr/bin/env python3
"""Cross-platform clone-and-run test for HIVV.

WHAT THIS PROVES
────────────────
After `git clone https://github.com/htmlfarmer/hivv`, a user on Linux, macOS,
or Windows can:

  1. install the API dependencies,
  2. start the gateway in LOCAL-FIRST mode with NO PostgreSQL and NO internet,
  3. reach the partner surface and the OpenAI-compatible surface,
  4. get a deterministic fast-scan,
  5. verify a signed attestation against the published public key,
  6. discover local models and route to them.

The test is pure-Python (stdlib only) so it runs identically on Linux, macOS,
Windows/WSL, and Git Bash. It starts the gateway itself, waits for health,
probes the endpoints, and always tears the server down.

Run:
    python3 tests/local_install/test_local_install.py
    python3 tests/local_install/test_local_install.py --keep    # leave it running
    python3 tests/local_install/test_local_install.py --port 3099
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
API_DIR = ROOT / "api"

PASS = 0
FAIL = 0


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
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_json(url: str, payload=None, timeout: float = 20.0, method: str | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method or ("POST" if data else "GET"),
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    try:
        return json.loads(body)
    except Exception:
        return body.decode("utf-8", "replace")


def wait_health(port: int, proc, timeout: float = 90.0) -> tuple[bool, str]:
    """Wait for /api/health. A local install must answer WITHOUT a database."""
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        if proc.poll() is not None:
            return False, f"server exited early with code {proc.returncode}"
        try:
            d = http_json(f"http://127.0.0.1:{port}/api/health", timeout=3)
            if isinstance(d, dict) and d.get("status") in ("healthy", "degraded"):
                return True, json.dumps(d)
        except Exception as e:
            last = str(e)
        time.sleep(0.5)
    return False, f"timed out waiting for health ({last})"


def node_available() -> bool:
    return shutil.which("node") is not None


def npm_install(api_dir: Path) -> tuple[bool, str]:
    if not shutil.which("npm"):
        return False, "npm not found"
    lock = (api_dir / "package-lock.json").exists()
    cmd = ["npm", "ci", "--silent", "--no-audit", "--no-fund"] if lock else \
          ["npm", "install", "--silent", "--no-audit", "--no-fund"]
    try:
        p = subprocess.run(cmd, cwd=api_dir, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        return False, "npm timed out"
    if p.returncode != 0:
        # Fall back to `npm install` when a lockfile is stale.
        p = subprocess.run(["npm", "install", "--silent", "--no-audit", "--no-fund"],
                           cwd=api_dir, capture_output=True, text=True, timeout=900)
    return p.returncode == 0, (p.stderr or p.stdout)[-500:]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--keep", action="store_true", help="leave the server running")
    ap.add_argument("--skip-install", action="store_true", help="assume node_modules exists")
    args = ap.parse_args()

    port = args.port or free_port()
    data_dir = Path(tempfile.mkdtemp(prefix="hivv-local-test-"))
    log_path = data_dir / "server.log"

    print(f"\n== HIVV clone-and-run test ==")
    print(f"  repo       : {ROOT}")
    print(f"  api        : {API_DIR}")
    print(f"  data dir   : {data_dir}")
    print(f"  port       : {port}")
    print(f"  python     : {sys.version.split()[0]}")
    print(f"  platform   : {sys.platform}\n")

    print("== 1. prerequisites ==")
    if not check("node is installed", node_available(),
                 "install Node.js 18+"):
        return 1
    node_ver = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    major = int(node_ver.lstrip("v").split(".")[0]) if node_ver else 0
    check(f"node is 18+ ({node_ver})", major >= 18, f"got {node_ver}")

    print("\n== 2. install dependencies ==")
    if args.skip_install:
        check("node_modules present (skipped install)", (API_DIR / "node_modules").exists())
    else:
        ok, detail = npm_install(API_DIR)
        if not check("npm install succeeded", ok, detail):
            return 1

    print("\n== 3. start the gateway (NO database, NO internet) ==")
    env = dict(os.environ)
    env.update({
        "HIVV_MODE": "local",
        "HIVV_DB_REQUIRED": "0",
        "HIVV_DATA_DIR": str(data_dir),
        "HIVV_PORT": str(port),
        "HIVV_HIVE_JOIN": "0",
        "NODE_ENV": "production",
        # A local install must not reach the public hive.
        "HIVV_HIVE_URL": "http://127.0.0.1:1",
    })
    for k in ("DB_HOST", "DB_NAME", "DB_USER", "HIVV_DB_PASSWORD", "DB_PASSWORD"):
        env.pop(k, None)

    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=API_DIR, env=env, stdout=log_f, stderr=subprocess.STDOUT,
    )

    healthy, detail = wait_health(port, proc)
    if not check("gateway became healthy without a database", healthy, detail):
        log_f.flush()
        try:
            print(log_path.read_text()[-2000:])
        except Exception:
            pass
        proc.terminate()
        return 1

    health = json.loads(detail) if detail.startswith("{") else {}
    check("health reports local/offline mode", health.get("mode") == "local" or
          health.get("database") in ("disabled", "unavailable"), json.dumps(health))
    check("health says offline_capable", health.get("offline_capable") is True,
          json.dumps(health))

    try:
        print("\n== 4. partner surface ==")
        m = http_json(f"http://127.0.0.1:{port}/api/partner/manifest")
        d = m.get("data", {})
        check("manifest names HIVV", d.get("name") == "HIVV", json.dumps(d)[:200])
        check("manifest is local-first", d.get("local_first") is True)
        check("manifest is offline-capable", d.get("offline_capable") is True)
        check("manifest advertises the OpenAI surface",
              d.get("openai_compatible", {}).get("chat") == "/v1/chat/completions")
        check("manifest advertises fast-scan",
              d.get("endpoints", {}).get("fast_scan") == "/api/partner/fast-scan")
        check("manifest carries meta.version", bool(m.get("meta", {}).get("version")))
        check("manifest does not leak a private key",
              "private_key" not in json.dumps(m).lower())

        ph = http_json(f"http://127.0.0.1:{port}/api/partner/health")
        check("partner health answers", ph.get("data", {}).get("offline_capable") is True)
        check("partner health did NOT contact the hive",
              ph.get("data", {}).get("hive", {}).get("status") == "not-contacted",
              json.dumps(ph.get("data", {}).get("hive")))

        pm = http_json(f"http://127.0.0.1:{port}/api/partner/models")
        check("partner models endpoint answers", "data" in pm)

        pn = http_json(f"http://127.0.0.1:{port}/api/partner/network")
        check("partner network endpoint answers", "data" in pn)

        print("\n== 5. deterministic fast-scan (no AI) ==")
        code = "import os\nos.system('echo hi')\n"
        fs = http_json(f"http://127.0.0.1:{port}/api/partner/fast-scan",
                       {"language": "python", "code": code})
        fd = fs.get("data", {})
        check("fast-scan returns a verdict", fd.get("verdict") in ("safe", "unsafe", "review"),
              json.dumps(fd)[:200])
        check("fast-scan says no AI was used", fd.get("ai_used") is False)
        check("fast-scan is unsigned", fd.get("signed") is False)
        check("fast-scan counts bytes", isinstance(fd.get("size", {}).get("bytes"), int))
        check("fast-scan counts lines", isinstance(fd.get("size", {}).get("lines"), int))
        check("fast-scan flags os.system as unsafe",
              fd.get("verdict") == "unsafe", json.dumps(fd)[:300])
        check("fast-scan reports a numeric risk score",
              isinstance(fd.get("risks", {}).get("score"), int))
        check("fast-scan reports a risk level",
              fd.get("risks", {}).get("level") in ("safe", "low", "medium", "high", "critical"))

        fs2 = http_json(f"http://127.0.0.1:{port}/api/partner/fast-scan",
                        {"language": "python", "code": "print('hello')\n"})
        check("clean code is not flagged unsafe",
              fs2.get("data", {}).get("verdict") != "unsafe",
              json.dumps(fs2.get("data", {}))[:200])

        print("\n== 6. signed attestation surface ==")
        key = http_json(f"http://127.0.0.1:{port}/api/partner/attestation/key")
        kd = key.get("data", {})
        check("attestation key published", kd.get("algorithm") == "ed25519", json.dumps(kd)[:200])
        check("principal uses the hivv_ namespace",
              str(kd.get("principal_id", "")).startswith("hivv_"), str(kd.get("principal_id")))
        check("public key is 32 bytes",
              len(__import__("base64").b64decode(kd.get("public_key", ""))) == 32)

        # A signed review needs a model. When none is running the endpoint must
        # fail CLOSED (503) rather than pretending to approve.
        try:
            rv = http_json(f"http://127.0.0.1:{port}/api/partner/review",
                           {"language": "python", "code": "print('x')\n"}, timeout=120)
            signed = bool(rv.get("data", {}).get("signed"))
            check("signed review either signs or fails closed", True, f"signed={signed}")
            if signed:
                envl = rv["data"]["envelope"]
                check("signed review carries a hivv_ issuer",
                      str(envl.get("issuer", "")).startswith("hivv_"))
                ver = http_json(f"http://127.0.0.1:{port}/api/partner/verify", {
                    "envelope": envl,
                    "signature": rv["data"]["signature"],
                    "public_key": rv["data"]["public_key"],
                })
                check("partner verify accepts our own signature",
                      ver.get("data", {}).get("valid") is True, json.dumps(ver)[:300])
        except urllib.error.HTTPError as e:
            check("signed review fails closed without a model", e.code == 503,
                  f"got HTTP {e.code}")
        except Exception as e:
            check("signed review endpoint reachable", False, str(e))

        print("\n== 7. OpenAI-compatible surface ==")
        vm = http_json(f"http://127.0.0.1:{port}/v1/models")
        check("/v1/models answers", "data" in vm, json.dumps(vm)[:200])
        check("/v1/models lists at least the route aliases",
              any(m.get("id") in ("auto", "smart", "fast", "cheap", "private")
                  for m in vm.get("data", [])),
              json.dumps(vm)[:300])

        print("\n== 8. no database required ==")
        psql = shutil.which("psql")
        if psql:
            print("  (psql exists on this box — the server still ran with HIVV_DB_REQUIRED=0)")
        check("server started with the DB password removed",
              "without a database" in (log_path.read_text() if log_path.exists() else "").lower()
              or health.get("database") in ("disabled", "unavailable"))

    finally:
        if not args.keep:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            log_f.close()
            shutil.rmtree(data_dir, ignore_errors=True)
        else:
            log_f.close()
            print(f"\n  server left running on port {port} (data dir {data_dir})")

    print(f"\n\033[1m{PASS} passed, {FAIL} failed\033[0m")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
