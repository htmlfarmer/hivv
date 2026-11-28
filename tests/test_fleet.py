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
import subprocess as sp
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

    # ── add and list, driven the way a person drives them ──────────────
    # These went UNTESTED until they shipped broken: 'hivv fleet list' on an
    # empty registry raised NameError on a helper that does not exist in
    # this CLI (_info), and the dashboard — the part the tests DID cover —
    # never touched it. A verb that only works when there is something to
    # show is a verb that is broken exactly when you need it.
    with tempfile.TemporaryDirectory(prefix="hivv-fleet-cli-") as td:
        os.environ["HIVV_CONFIG_DIR"] = td
        mod.CONFIG_DIR = Path(td)
        env = {**os.environ, "HIVV_CONFIG_DIR": td}

        # list on an EMPTY registry must not crash
        r = sp.run([sys.executable, str(CLI), "fleet", "list"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet list on an empty registry exits 0",
              r.returncode == 0, r.stderr[-300:])
        check("fleet list on an empty registry says so",
              "no boxes registered" in r.stdout, r.stdout[-200:])

        # add a box, then list it
        r = sp.run([sys.executable, str(CLI), "fleet", "add", "ashy",
                    "192.168.1.3", "--role", "centre"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet add exits 0", r.returncode == 0, r.stderr[-300:])
        check("fleet add confirms",
              "ashy" in r.stdout and "centre" in r.stdout, r.stdout[-200:])

        r = sp.run([sys.executable, str(CLI), "fleet", "list"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet list shows the box",
              r.returncode == 0 and "ashy" in r.stdout,
              (r.stdout + r.stderr)[-300:])
        check("fleet list shows the host",
              "192.168.1.3" in r.stdout, r.stdout[-200:])

        # the registry the CLI wrote is the one the CLI reads
        reg = json.loads((Path(td) / "fleet.json").read_text())
        check("the registry on disk has the box",
              reg["boxes"]["ashy"]["role"] == "centre", str(reg))

    # ── the verbs that were added after the list bug ────────────────────
    # 'hivv fleet list' shipped broken because it was only ever run with
    # something in it. Every new verb is now driven on an EMPTY state too.
    with tempfile.TemporaryDirectory(prefix="hivv-fleet-empty-") as td:
        os.environ["HIVV_CONFIG_DIR"] = td
        mod.CONFIG_DIR = Path(td)
        env = {**os.environ, "HIVV_CONFIG_DIR": td}

        # preview: no preview running
        r = sp.run([sys.executable, str(CLI), "fleet", "preview"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet preview on an empty box exits 0",
              r.returncode == 0, (r.stdout + r.stderr)[-300:])
        check("fleet preview on an empty box says so",
              "no preview" in r.stdout, r.stdout[-200:])

        # preview stop: nothing to stop, and it must not crash
        r = sp.run([sys.executable, str(CLI), "fleet", "preview", "stop"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet preview stop on an empty box exits 0",
              r.returncode == 0, (r.stdout + r.stderr)[-300:])
        check("fleet preview stop on an empty box says so",
              "no preview" in r.stdout, r.stdout[-200:])

        # preview url: there is none. Asking for a URL that does not exist
        # is an ERROR, not a status — die() to stderr and exit 1.
        r = sp.run([sys.executable, str(CLI), "fleet", "preview", "url"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet preview url on an empty box fails, does not crash",
              r.returncode != 0 and "Traceback" not in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-300:])
        check("fleet preview url on an empty box says why",
              "no preview" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-300:])

        # deploy: no centre registered, and it must say so rather than crash
        r = sp.run([sys.executable, str(CLI), "fleet", "deploy", "--dry-run"],
                   capture_output=True, text=True, timeout=90, env=env)
        check("fleet deploy with no centre does not crash",
              "Traceback" not in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-400:])
        check("fleet deploy with no centre names the problem",
              "centre" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-300:])

    # ── the probe ─────────────────────────────────────────────────────────
    # The probe is what the fleet asks when the CLI on a box is an old
    # version. It runs on a box with no fleet code at all, so it has to
    # stand alone: no imports beyond the standard library, and it must
    # answer even when there is nothing to report.
    probe = ROOT / "scripts" / "fleet-probe.py"
    check("the probe ships with the repo", probe.exists())
    if probe.exists():
        with tempfile.TemporaryDirectory(prefix="hivv-probe-") as td:
            r = sp.run([sys.executable, str(probe)], capture_output=True,
                       text=True, timeout=90,
                       env={**os.environ, "HOME": td})
            check("the probe exits 0", r.returncode == 0, r.stderr[-200:])
            try:
                rep = json.loads(r.stdout)
                ok = True
            except Exception as e:
                rep, ok = {}, False
                check("the probe emits JSON", False, str(e))
            if ok:
                check("the probe emits JSON", True)
                for key in ("host", "reachable", "agent_running", "nodes",
                            "gateway", "git", "deployed"):
                    check(f"the probe reports '{key}'", key in rep, str(sorted(rep)))

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
                                     "move", "report", "deploy", "preview"},
              str(sorted(choices or [])))

    print()
    print(f"  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
