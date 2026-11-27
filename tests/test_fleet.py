#!/usr/bin/env python3
"""The `hivv fleet` dashboard, and the guidance it gives.

The complaint this answers is not "git is hard". It is that a fleet is a
SET OF BOXES WITH DIFFERENT ROLES, and the operator has to remember which
box is the centre, which are bees, that the deploy runs on the centre, and
that the centre's production tree was parked on a feature branch.

So the dashboard's job is not to show everything. It is to show the ONE
thing to do next, and to be right about it.

These tests pin the guidance, because a dashboard that says the wrong
thing is worse than no dashboard: the operator acts on it.

Run:
    python3 tests/test_fleet.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
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


def load_cli():
    spec = importlib.util.spec_from_file_location("hivv_fleet_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    mod = load_cli()

    # ── the registry round-trips ───────────────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="hivv-fleet-") as td:
        os.environ["HIVV_CONFIG_DIR"] = td
        mod.CONFIG_DIR = Path(td)

        reg = mod._fleet_load()
        check("a missing registry is an empty fleet, not an error",
              reg.get("boxes") == {}, str(reg))

        mod._fleet_save({"boxes": {"ashy": {"host": "192.168.1.3", "role": "centre"},
                                   "masjid": {"host": "192.168.1.33", "role": "bee"}}})
        reg = mod._fleet_load()
        check("the registry round-trips",
              set(reg["boxes"]) == {"ashy", "masjid"}, str(reg))
        check("a box keeps its role",
              reg["boxes"]["ashy"]["role"] == "centre")
        check("a box keeps its host",
              reg["boxes"]["masjid"]["host"] == "192.168.1.33")

        # a broken registry must not take the dashboard down
        mod._fleet_path().write_text("{not json")
        check("a corrupt registry degrades to an empty fleet",
              mod._fleet_load().get("boxes") == {})

    # ── the guidance ───────────────────────────────────────────────────────
    # A centre whose production tree is on the wrong branch.
    local = {
        "host": "ashy", "role": "centre", "agent_running": True,
        "nodes": [{"home": "~/.kwaainet-hivv", "identity": "18130fce5f01",
                   "port": "8123", "peer_id": "12D3Koo", "up": True}],
        "node_up": True,
        "gateway": {"name": "hivv-ai-gateway", "cwd": "/var/www/vhosts/hivv.org/api",
                    "uptime_s": 600},
        "git": {"path": "/var/www/vhosts/hivv.org", "branch": "ai-watchdog",
                "dirty": 43, "head": "abc1234 2 hours ago"},
        "deployed": "abc1234",
    }
    steps = " ".join(mod._fleet_next_step(local, []))
    check("a production tree off main is called out", "ai-watchdog" in steps, steps)
    check("the guidance names the fix", "git checkout main" in steps, steps)
    check("a dirty tree is called out", "uncommitted" in steps, steps)

    # Branch and dirtiness are INDEPENDENT: a tree can be both.
    check("a branch AND a dirty tree both get reported",
          "ai-watchdog" in steps and "uncommitted" in steps, steps)

    # A clean centre on main: the next step is to deploy.
    clean = dict(local)
    clean["git"] = {"path": "/var/www/vhosts/hivv.org", "branch": "main",
                     "dirty": 0, "head": "abc1234 2 hours ago"}
    steps = " ".join(mod._fleet_next_step(clean, []))
    check("a clean centre is told to deploy", "deploy.sh" in steps, steps)

    # An unreachable box is reported, not hidden.
    steps = " ".join(mod._fleet_next_step(local, [{"host": "192.168.1.33",
                                                   "reachable": False}]))
    check("an unreachable box is named", "192.168.1.33" in steps, steps)

    # Nothing wrong: say so, rather than inventing work.
    steps = " ".join(mod._fleet_next_step(
        {"host": "x", "role": "bee", "agent_running": True,
         "nodes": [{"home": "~/.kwaainet-bee", "identity": "abc", "port": "8123",
                    "peer_id": "12D3Koo", "up": True}], "node_up": True,
         "gateway": None, "git": None, "deployed": ""}, []))
    check("a healthy box is told there is nothing to do",
          "nothing to do" in steps, steps)

    # ── the report ─────────────────────────────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="hivv-fleet-") as td:
        os.environ["HIVV_CONFIG_DIR"] = td
        mod.CONFIG_DIR = Path(td)
        st = mod._fleet_local_status()
        for key in ("host", "role", "agent_running", "nodes", "git", "gateway"):
            check(f"the report has '{key}'", key in st, str(sorted(st)))
        check("the report is JSON-serialisable",
              isinstance(json.dumps(st, default=str), str))

    # ── the parser ─────────────────────────────────────────────────────────
    import argparse
    parser = mod.build_parser()
    verbs = None
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            got = action.choices.get("fleet")
            if got is not None:
                verbs = got
    check("the fleet subparser exists", verbs is not None)
    if verbs is not None:
        choices = None
        for action in verbs._actions:
            if action.dest == "fleet_what":
                choices = action.choices
        check("the verbs are the ones we ship",
              set(choices or []) == {"dashboard", "up", "check", "add", "list",
                                     "move", "report"},
              str(sorted(choices or [])))

    print()
    print(f"  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
