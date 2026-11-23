#!/usr/bin/env python3
"""tests/test_tools_test_cmd.py — `hivv tools test` / `hivv test [all|tools]`.

THE GAP THIS CLOSES
───────────────────
A user ran `hivv chat "whats the date today"` and got "I do not have access
to real-time information". The hive had a clock tool. Nothing in the CLI
checked whether the toolkit actually worked — `hivv test` covered doctor,
speed, the LLM, the AI contract and the network, and stopped there.

So the three things that had to be true were never verified together:

  1. the HUB catalog is reachable (that is where the schemas come from),
  2. the LOCAL tool server runs (that is where the cheap tools run),
  3. a tool actually EXECUTES — and a MODEL actually calls one.

`hivv tools test` now checks all three plus the policy posture and the SSRF
guard, and `hivv test all` / `hivv test everything` includes it.

Run:
    python3 -m pytest tests/test_tools_test_cmd.py -q
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"
GATEWAY = "http://127.0.0.1:3011"


def _load_cli():
    spec = importlib.util.spec_from_file_location("hivv_cli_tools_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


def _src() -> str:
    return CLI.read_text(encoding="utf-8", errors="replace")


def _gateway_up() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen(f"{GATEWAY}/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


class TestTheCommandExists:
    def test_tools_test_is_an_action(self):
        mod = _load_cli()
        args = mod.build_parser().parse_args(["tools", "test"])
        assert args.action == "test"

    def test_tools_still_has_its_old_actions(self):
        mod = _load_cli()
        for action in ("on", "off", "status", "share", "list"):
            assert mod.build_parser().parse_args(["tools", action]).action == action

    def test_test_accepts_a_scope(self):
        mod = _load_cli()
        for scope in ("all", "everything", "tools"):
            args = mod.build_parser().parse_args(["test", scope])
            assert args.scope == scope, scope

    def test_test_defaults_to_all(self):
        """`hivv test` has always meant the whole suite — the default must
        not change just because a scope was added."""
        mod = _load_cli()
        assert mod.build_parser().parse_args(["test"]).scope == "all"

    def test_every_scope_is_documented_in_the_help_table(self):
        src = _src()
        assert "hivv test [all|everything|tools]" in src, "the help table must show the scope"
        assert "hivv tools [list|status|on|off|share|test]" in src, "the help table must show tools test"


class TestTheDiagnostic:
    def test_the_function_exists_and_returns_a_count(self):
        mod = _load_cli()
        assert hasattr(mod, "_test_toolkit"), "missing _test_toolkit()"
        assert callable(mod._test_toolkit)

    def test_it_checks_the_three_things_that_were_never_checked(self):
        """The exact failures that let the bug through."""
        body = _src()
        # "def cmd_test(args)" — NOT "def cmd_test": the latter matches
        # `def cmd_tests_for`, which sits BEFORE _test_toolkit and would make
        # this slice empty.
        fn = body[body.index("def _test_toolkit"):body.index("def cmd_test(args)")]
        assert fn, "could not isolate the _test_toolkit body"
        # 1. the hub catalog — where the schemas come from
        assert "/api/tools/catalog" in fn, "must check the hub catalog"
        # 2. the local tool server — where the cheap tools run
        assert "/tools" in fn, "must check the local tool server"
        assert "/tool/" in fn, "must execute a tool on the local server"
        # 3. a real call through the hub
        assert "/api/tools/" in fn and "/invoke" in fn, "must execute a tool through the hub"
        # 4. the policy posture
        assert "web_fetch" in fn, "must check that web.fetch still asks first"
        # 5. the SSRF guard
        assert "127.0.0.1" in fn and "api/health" in fn, "must check the SSRF guard"
        # 6. a MODEL actually using one — the check that catches the real bug
        assert "does a MODEL use them" in fn, "must ask a model the question a human asks"
        assert "current_time" in fn, "the model test must offer the clock"

    def test_it_returns_a_failure_count(self):
        """The exit code is the contract: 0 = green, non-zero = broken."""
        body = _src()
        fn = body[body.index("def _test_toolkit"):body.index("def cmd_test(args)")]
        assert "return fails" in fn, "the diagnostic must return its failure count"
        assert "sys.exit(1 if fails else 0)" in body, "the command must exit non-zero on failure"

    def test_it_names_the_next_command_when_something_fails(self):
        """A red check must say what to run, not just that it is red."""
        body = _src()
        fn = body[body.index("def _test_toolkit"):body.index("def cmd_test(args)")]
        assert "tools on" in fn, "must point at starting the local server"
        assert "tools list" in fn, "must point at the catalog"


class TestTheSuiteIncludesIt:
    def test_hivv_test_all_runs_the_toolkit_too(self):
        """hivv test all / everything must reach the toolkit — otherwise the
        suite still stops before the thing that broke."""
        body = _src()
        cmd = body[body.index("def cmd_test(args)"):body.index("def _volunteer_default")]
        assert "_test_toolkit()" in cmd, "hivv test does not run the toolkit section"
        assert 'scope == "tools"' in cmd, "hivv test tools must short-circuit to just the toolkit"

    def test_a_toolkit_failure_fails_the_suite(self):
        body = _src()
        cmd = body[body.index("def cmd_test(args)"):body.index("def _volunteer_default")]
        assert 'fails.append("toolkit' in cmd, "a broken toolkit must fail hivv test, not pass silently"


@unittest.skipUnless(_gateway_up(), "the gateway is not running on 127.0.0.1:3011")
class TestItActuallyRuns(unittest.TestCase):
    """Live: runs the real diagnostic against the real gateway.

    The last section is a REAL model round trip, and the full suite hits the
    gateway from several tests at once — so a transient timeout under load is
    expected. One retry separates a flake from a real break, and the whole
    diagnostic is run ONCE so the two tests below share one result.
    """

    @classmethod
    def setUpClass(cls):
        cls.out = ""
        cls.code = 1
        for _attempt in range(2):
            env = dict(os.environ, HUB=GATEWAY)
            r = subprocess.run(
                [sys.executable, str(CLI), "tools", "test"],
                capture_output=True, text=True, timeout=600, env=env, cwd=str(REPO))
            cls.out = r.stdout + r.stderr
            cls.code = r.returncode
            if r.returncode == 0:
                break

    def test_tools_test_is_green_on_this_box(self):
        assert self.code == 0, (
            "the toolkit diagnostic failed (after a retry):\n" + self.out[-3000:])
        assert "every tool answered" in self.out, self.out[-1500:]

    def test_every_section_is_reported(self):
        for section in ("catalog", "local tool server", "tool calls (hub)",
                        "tool calls (local server)", "policy",
                        "does a MODEL use them"):
            assert section in self.out, f"the diagnostic never reported '{section}'"


if __name__ == "__main__":
    unittest.main(verbosity=2)
