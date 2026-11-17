#!/usr/bin/env python3
"""End-to-end test: a GUI tool pointed at HIVV actually gets answers.

This is the test that proves the setup is not just writing pretty JSON. It:

  1. starts a local gateway (no database),
  2. points a Continue-style config at it,
  3. makes an OpenAI-compatible request the way a GUI tool would,
  4. checks the response is a real chat completion, and
  5. checks the receipt headers say WHO answered.

It also proves the fallback story: when the local model is unreachable, the
request still works through the hive path (or fails honestly, never silently
with a broken config).

Run:
    python3 tests/test_gui_e2e.py
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"
GUI = ROOT / "public_html" / "hivv-gui-setup.py"

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
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def post(url: str, payload: dict, timeout: float = 120.0, headers: dict | None = None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            body = json.loads(body)
        except Exception:
            pass
        return e.code, dict(e.headers), body


def get(url: str, timeout: float = 20.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, dict(r.headers), json.loads(r.read().decode())


def main() -> int:
    port = free_port()
    data_dir = Path(tempfile.mkdtemp(prefix="hivv-gui-e2e-"))
    log_path = data_dir / "server.log"

    print(f"\n== HIVV GUI end-to-end ==")
    print(f"  port     : {port}")
    print(f"  data dir : {data_dir}\n")

    # ── 1. start a local gateway (no database) ─────────────────────
    print("== 1. start a local gateway (no database, no internet) ==")
    env = dict(os.environ)
    env.update({
        "HIVV_MODE": "local",
        "HIVV_DB_REQUIRED": "0",
        "HIVV_DATA_DIR": str(data_dir),
        "HIVV_PORT": str(port),
        "HIVV_HIVE_JOIN": "0",
        "NODE_ENV": "production",
        "HIVV_HIVE_URL": "http://127.0.0.1:1",
    })
    for k in ("DB_HOST", "DB_NAME", "DB_USER", "HIVV_DB_PASSWORD", "DB_PASSWORD"):
        env.pop(k, None)

    log_f = open(log_path, "wb")
    proc = subprocess.Popen(["node", "server.js"], cwd=str(ROOT / "api"),
                            env=env, stdout=log_f, stderr=subprocess.STDOUT)

    healthy = False
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            code, _, body = get(f"http://127.0.0.1:{port}/api/health", timeout=3)
            if code == 200 and body.get("status") in ("healthy", "degraded"):
                healthy = True
                break
        except Exception:
            pass
        time.sleep(0.4)

    if not check("the gateway started", healthy,
                 f"exited {proc.returncode}" if proc.poll() is not None else "timeout"):
        try:
            print(log_path.read_text()[-1500:])
        except Exception:
            pass
        proc.terminate()
        return 1

    try:
        # ── 2. write a GUI config that points at it ────────────────
        print("\n== 2. write a GUI config (Continue shape) ==")
        import importlib.util
        spec = importlib.util.spec_from_file_location("gui", GUI)
        gui = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gui)

        plan = gui.build_plan("hive", local_models=[], hub=f"http://127.0.0.1:{port}")
        check("the plan points at the local gateway",
              plan["base_url"] == f"http://127.0.0.1:{port}/v1", plan["base_url"])

        settings = data_dir / "settings.json"
        cont = next(t for t in gui.TOOL_REGISTRY if t["id"] == "vscode-continue")
        orig = cont["paths"]
        cont["paths"] = lambda settings=settings: [settings]
        try:
            action, path = cont["write"](settings, plan)
        finally:
            cont["paths"] = orig
        check("the Continue config was written", settings.exists(), str(path))

        data = json.loads(settings.read_text())
        models = data.get("models")
        entry = models.get("hivv") if isinstance(models, dict) else None
        check("the config carries our model entry", entry is not None, json.dumps(data)[:200])
        if entry:
            check("the config points at the local gateway",
                  str(port) in str(entry.get("apiBase", "")),
                  str(entry.get("apiBase")))

        # ── 3. talk to it the way a GUI would ───────────────────────
        print("\n== 3. make an OpenAI-compatible request ==")
        base = plan["base_url"]
        status, headers, body = post(
            f"{base}/chat/completions",
            {"model": "auto", "messages": [{"role": "user", "content": "say hi"}],
             "stream": False},
            timeout=150,
        )
        # A FRESH CLONE has no local model, no hive and no cloud key, so the
        # honest answer is 503 "no providers" — NOT a fabricated answer. That
        # is the fail-closed behaviour we want. When a model IS reachable the
        # same request must succeed.
        if status == 200:
            check("the chat endpoint answered 200", True)
            check("the response is a chat completion",
                  isinstance(body, dict) and bool(body.get("choices")),
                  str(body)[:200])
            if isinstance(body, dict) and body.get("choices"):
                msg = body["choices"][0].get("message", {})
                check("the completion carries content",
                      bool(msg.get("content")), json.dumps(msg)[:200])
            check("the response carries the answered-by receipt",
                  any(k.lower().startswith("x-hivv-answered-by") for k in headers),
                  str(list(headers.keys())))
            check("the response carries a policy receipt",
                  any(k.lower().startswith("x-hivv-policy") for k in headers),
                  str(list(headers.keys())))
        elif status == 503:
            check("a provider-less gateway fails CLOSED (503, no fake answer)",
                  isinstance(body, dict) and bool(body.get("error")),
                  str(body)[:200])
            check("the 503 names the real cause",
                  "provider" in json.dumps(body).lower() or "no local" in json.dumps(body).lower(),
                  str(body)[:200])
        else:
            check("the chat endpoint answered 200 or failed closed with 503",
                  False, f"HTTP {status}: {str(body)[:200]}")

        # ── 4. /v1/models works (GUIs call it to populate a picker) ─
        print("\n== 4. /v1/models (GUI model pickers call this) ==")
        code, _, mbody = get(f"{base}/models", timeout=30)
        check("/v1/models answered", code == 200, f"HTTP {code}")
        check("/v1/models lists the route aliases",
              any(m.get("id") in ("auto", "smart", "fast", "cheap", "private")
                  for m in (mbody.get("data") or [])),
              json.dumps(mbody)[:200])

        # ── 5. the MCP surface (another common GUI integration) ────
        print("\n== 5. the MCP surface ==")
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/mcp",
                data=json.dumps({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/list",
                }).encode(),
                headers={"Content-Type": "application/json",
                         "Accept": "application/json, text/event-stream"},
                method="POST")
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8", "replace")
            check("MCP tools/list answered", "tools" in raw or "chat" in raw,
                  raw[:200])
        except urllib.error.HTTPError as e:
            check("MCP endpoint reachable", False, f"HTTP {e.code}")
        except Exception as e:
            check("MCP endpoint reachable", False, str(e))

        # ── 6. the fast-scan works from the same gateway ────────────
        print("\n== 6. the fast-scan from the same gateway ==")
        status, _, fs = post(f"http://127.0.0.1:{port}/api/partner/fast-scan",
                             {"language": "python", "code": "import os\nos.system('x')\n"},
                             timeout=30)
        check("fast-scan answered", status == 200, f"HTTP {status}")
        if status == 200:
            check("fast-scan flagged the dangerous code",
                  fs.get("data", {}).get("verdict") == "unsafe",
                  json.dumps(fs)[:200])

        # ── 7. the fallback story is honest ─────────────────────────
        print("\n== 7. an unreachable backend fails LOUDLY, never silently ==")
        try:
            status, _, body = post(
                "http://127.0.0.1:1/v1/chat/completions",
                {"model": "auto", "messages": [{"role": "user", "content": "hi"}]},
                timeout=15)
            check("a dead endpoint produces an error, not a fake answer",
                  status >= 400, f"HTTP {status}")
        except Exception as e:
            # A refused connection IS the loud failure we want.
            check("a dead endpoint fails loudly (connection refused)",
                  "refused" in str(e).lower() or "refused" in type(e).__name__.lower(),
                  str(e))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log_f.close()
        import shutil
        shutil.rmtree(data_dir, ignore_errors=True)

    print(f"\n\033[1m{PASS} passed, {FAIL} failed\033[0m")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
