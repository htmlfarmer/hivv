#!/usr/bin/env python3
"""Tests for the HIVV GUI-tool setup matrix.

These prove:
  1. Every profile builds a sane plan (local / hybrid / hive / cloud).
  2. Every registered tool can write its config, and the written config
     actually contains the endpoint we intended.
  3. Writing NEVER clobbers the user's existing settings — their values win.
  4. A backup is written before an existing file is modified.
  5. The tool registry is stable (ids unique, every entry complete).
  6. `hivv setup --json` runs end to end and reports the matrix.

Run:
    python3 tests/test_gui_setup.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
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


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gui = load(GUI, "hivv_gui_setup")

LOCAL = [{"name": "llama.cpp", "port": 8090,
          "base_url": "http://localhost:8090/v1",
          "models": ["gemma-4-E2B"], "model": "gemma-4-E2B"}]


def main() -> int:
    print("\n== HIVV GUI-tool setup tests ==")

    # ── 1. registry integrity ──────────────────────────────────────
    print("\n== 1. registry integrity ==")
    ids = [t["id"] for t in gui.TOOL_REGISTRY]
    check("registry is not empty", len(ids) > 0, f"{len(ids)} tools")
    check("tool ids are unique", len(ids) == len(set(ids)),
          f"dupes: {[i for i in set(ids) if ids.count(i) > 1]}")
    check("every tool has a label", all(t.get("label") for t in gui.TOOL_REGISTRY))
    check("every tool has a kind", all(t.get("kind") for t in gui.TOOL_REGISTRY))
    check("every tool has detect()", all(callable(t.get("detect")) for t in gui.TOOL_REGISTRY))
    check("every tool has paths()", all(callable(t.get("paths")) for t in gui.TOOL_REGISTRY))
    check("every tool has write()", all(callable(t.get("write")) for t in gui.TOOL_REGISTRY))
    check("every tool has a note", all(t.get("note") for t in gui.TOOL_REGISTRY))
    kinds = {t["kind"] for t in gui.TOOL_REGISTRY}
    for kind in ("vscode", "jetbrains", "editor", "chat", "cli", "mcp"):
        check(f"registry covers {kind}", kind in kinds, str(kinds))

    # ── 2. profiles ────────────────────────────────────────────────
    print("\n== 2. profiles build sane plans ==")
    p_local = gui.build_plan("local", local_models=LOCAL)
    check("local profile uses the local endpoint",
          p_local["base_url"] == "http://localhost:8090/v1", p_local["base_url"])
    check("local profile uses the local model",
          p_local["model"] == "gemma-4-E2B", p_local["model"])
    check("local profile carries no api key", p_local["api_key"] is None)

    p_hybrid = gui.build_plan("hybrid", local_models=LOCAL, hub="https://hivv.org")
    check("hybrid profile prefers local",
          p_hybrid["base_url"] == "http://localhost:8090/v1", p_hybrid["base_url"])
    check("hybrid profile records the hive fallback",
          p_hybrid.get("fallback_url") == "https://hivv.org/v1", str(p_hybrid.get("fallback_url")))
    check("hybrid profile names the local model",
          p_hybrid.get("local_model") == "gemma-4-E2B")

    p_hive = gui.build_plan("hive", local_models=LOCAL, hub="https://hivv.org")
    check("hive profile uses the public endpoint",
          p_hive["base_url"] == "https://hivv.org/v1", p_hive["base_url"])
    check("hive profile ignores the local model", p_hive.get("local_model") is None)

    p_cloud = gui.build_plan("cloud", local_models=LOCAL, api_key="sk-test")
    check("cloud profile uses a cloud endpoint",
          p_cloud["base_url"].startswith("https://"), p_cloud["base_url"])
    check("cloud profile carries the key", p_cloud["api_key"] == "sk-test")

    p_nolocal = gui.build_plan("hybrid", local_models=[])
    check("hybrid with no local model falls back to the hive",
          p_nolocal["base_url"] == "https://hivv.org/v1", p_nolocal["base_url"])

    try:
        gui.build_plan("local", local_models=[])
        check("local profile without a local model raises", False, "no error")
    except ValueError:
        check("local profile without a local model raises", True)

    try:
        gui.build_plan("bogus", local_models=LOCAL)
        check("an unknown profile raises", False, "no error")
    except ValueError:
        check("an unknown profile raises", True)

    # ── 3. pinning a specific backend ───────────────────────────────
    print("\n== 3. pinning a backend ==")
    two = LOCAL + [{"name": "ollama", "port": 11434,
                    "base_url": "http://localhost:11434/v1",
                    "models": ["qwen"], "model": "qwen"}]
    p_pin = gui.build_plan("local", local_models=two, backend="qwen")
    check("pinning by model id selects that backend",
          p_pin["base_url"] == "http://localhost:11434/v1", p_pin["base_url"])
    p_pin2 = gui.build_plan("local", local_models=two, backend="ollama")
    check("pinning by runtime name selects that backend",
          p_pin2["base_url"] == "http://localhost:11434/v1", p_pin2["base_url"])
    try:
        gui.build_plan("local", local_models=two, backend="nope")
        check("pinning an unknown backend raises", False, "no error")
    except ValueError:
        check("pinning an unknown backend raises", True)

    # ── 4. every tool can write ─────────────────────────────────────
    print("\n== 4. every tool writes a usable config ==")
    plan = gui.build_plan("hybrid", local_models=LOCAL, hub="https://hivv.org")
    for t in gui.TOOL_REGISTRY:
        with tempfile.TemporaryDirectory(prefix="hivv-gui-") as td:
            dest = Path(td) / "config"
            # give the tool a paths() that points into the temp dir
            orig_paths = t["paths"]
            t["paths"] = lambda td=td: [Path(td) / "config"]
            try:
                r = gui.apply_tool(t, plan)
            finally:
                t["paths"] = orig_paths
            ok = r.get("ok")
            check(f"{t['id']}: wrote without error", ok, str(r.get("error", "")))
            if ok:
                check(f"{t['id']}: file exists", Path(r["path"]).exists(), r["path"])
                body = Path(r["path"]).read_text(encoding="utf-8", errors="replace")
                check(f"{t['id']}: mentions the endpoint",
                      "localhost:8090" in body or "hivv.org" in body,
                      body[:120])

    # ── 5. the user's settings always win ──────────────────────────
    print("\n== 5. user settings are never clobbered ==")
    with tempfile.TemporaryDirectory(prefix="hivv-gui-") as td:
        dest = Path(td) / "settings.json"
        dest.write_text(json.dumps({
            "editor.fontSize": 15,
            "models": [{"title": "MY OWN MODEL", "provider": "mine"}],
            "apiKey": "USER-OWN-KEY",
        }, indent=2), encoding="utf-8")
        cont = next(t for t in gui.TOOL_REGISTRY if t["id"] == "vscode-continue")
        orig_paths = cont["paths"]
        cont["paths"] = lambda dest=dest: [dest]
        try:
            action, _ = cont["write"](dest, plan)
        finally:
            cont["paths"] = orig_paths
        data = json.loads(dest.read_text())
        check("the user's own setting survives", data.get("editor.fontSize") == 15)
        check("the user's own model list survives",
              isinstance(data.get("models"), list)
              and data["models"][0].get("title") == "MY OWN MODEL",
              json.dumps(data.get("models"))[:200])
        check("the user's own apiKey survives", data.get("apiKey") == "USER-OWN-KEY")
        check("our model was appended to the list",
              any(isinstance(m, dict) and m.get("title") == "HIVV" for m in data.get("models", [])),
              json.dumps(data.get("models"))[:200])
        check("the array shape was preserved", isinstance(data.get("models"), list))
        backups = list(dest.parent.glob("settings.json.bak-*"))
        check("a backup was written before modifying", len(backups) >= 1,
              f"{len(backups)} backups")
        if backups:
            b = json.loads(backups[-1].read_text())
            check("the backup holds the ORIGINAL content",
                  b.get("editor.fontSize") == 15 and b.get("apiKey") == "USER-OWN-KEY")

    # the object form must also be respected
    with tempfile.TemporaryDirectory(prefix="hivv-gui-") as td:
        dest = Path(td) / "settings.json"
        dest.write_text(json.dumps({
            "models": {"mine": {"title": "MY OWN", "provider": "mine"}},
        }, indent=2), encoding="utf-8")
        cont = next(t for t in gui.TOOL_REGISTRY if t["id"] == "vscode-continue")
        orig_paths = cont["paths"]
        cont["paths"] = lambda dest=dest: [dest]
        try:
            cont["write"](dest, plan)
        finally:
            cont["paths"] = orig_paths
        data = json.loads(dest.read_text())
        check("the object shape was preserved", isinstance(data.get("models"), dict),
              type(data.get("models")).__name__)
        check("the user's own object entry survives",
              data["models"].get("mine", {}).get("title") == "MY OWN")
        check("our entry was added alongside it", "hivv" in data.get("models", {}))

    # ── 6. JSONC handling ──────────────────────────────────────────
    print("\n== 6. JSONC is parsed correctly ==")
    jsonc = """{
      // a comment
      "editor.fontSize": 14, /* another */
      "url": "https://example.com/not-a-comment",
      "trailing": 1,
    }"""
    parsed = json.loads(gui._strip_jsonc(jsonc))
    check("comments stripped", "editor.fontSize" in parsed)
    check("a URL inside a string survives", parsed.get("url") == "https://example.com/not-a-comment")
    check("trailing comma removed", parsed.get("trailing") == 1)

    # ── 7. the CLI runs it ──────────────────────────────────────────
    print("\n== 7. hivv setup --json runs end to end ==")
    p = subprocess.run([sys.executable, str(CLI), "setup", "--json", "--dry-run"],
                       capture_output=True, text=True, timeout=180, cwd=str(ROOT))
    check("setup --json exits 0", p.returncode == 0, p.stderr[-300:])
    if p.returncode == 0:
        try:
            out = json.loads(p.stdout)
            check("json has the detect block", "detect" in out)
            check("json has the gui block", "gui" in out)
            check("gui reports available", out.get("gui", {}).get("available") is True)
            check("gui reports a profile", bool(out.get("gui", {}).get("profile")))
            check("gui lists the tools", len(out.get("gui", {}).get("tools", [])) > 0)
        except Exception as e:
            check("setup --json output parses", False, str(e))

    p2 = subprocess.run([sys.executable, str(CLI), "setup", "--help"],
                        capture_output=True, text=True, timeout=60, cwd=str(ROOT))
    check("setup --help exits 0", p2.returncode == 0)
    for flag in ("--profile", "--backend", "--tools", "--gui", "--dry-run"):
        check(f"setup --help documents {flag}", flag in p2.stdout)

    print(f"\n\033[1m{PASS} passed, {FAIL} failed\033[0m")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
