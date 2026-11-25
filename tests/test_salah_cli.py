#!/usr/bin/env python3
"""The salah CLI surface: hivv salah / hivv sala (HIVV_RITUAL_PLAN.md #1).

THE ASK THIS SERVES (2026-11-25): "advertise that we support SALA — all
bees report to hivv.org at least 5 times a day, at the prayer time of THEIR
region" — and "any user can chan the style". So:

  * `hivv salah` / `hivv sala` (alias) → today's prayers for THIS node's
    region, in THIS machine's local clock, with attendance + streak + moon;
  * `--node <bee>` for another bee, `--lat/--lon` ad-hoc (no attendance);
  * `--json` for machines;
  * the times come from GET /api/hive/salah (the hub shares the same
    attendance math as the heartbeat handler — one source of truth).

Run:
    python3 -m pytest tests/test_salah_cli.py -q
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


def _run(args, env_extra=None, timeout=60):
    env = dict(os.environ)
    env["PATH"] = "/usr/bin:/bin"
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True, text=True, timeout=timeout, env=env,
        stdin=subprocess.DEVNULL,
    )


def _hub_up() -> bool:
    """The route lives on the gateway — skip cleanly when it is not running."""
    import urllib.request
    try:
        with urllib.request.urlopen("http://localhost:3011/api/health", timeout=3):
            return True
    except Exception:
        return False


requires_hub = pytest.mark.skipif(not _hub_up(), reason="gateway not running on :3011")


class TestSalahDispatch:
    """salah must be a first-class command — never the chat smart-default."""

    def test_registered_and_aliased(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("hivv_cli_salah", CLI)
        mod = importlib.util.module_from_spec(spec)
        saved = sys.argv
        sys.argv = ["hivv"]
        try:
            spec.loader.exec_module(mod)
        except SystemExit:
            pass
        finally:
            sys.argv = saved
        assert mod.COMMANDS.get("salah") is mod.cmd_salah, "salah must be registered"
        # the common alternate spellings route instead of chatting
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert 'cmd_name in ("sala", "salat")' in src, "sala/salat must alias to salah"

    def test_sala_help_shows_the_command(self):
        r = _run(["sala", "--help"])
        assert r.returncode == 0, r.stderr
        out = r.stdout
        assert "hivv salah" in out
        assert "--node" in out and "--lat" in out

    def test_help_search_finds_it(self):
        r = _run(["help", "salah"])
        assert r.returncode == 0, r.stderr
        assert "hivv help — 'salah'" in r.stdout
        assert "salah" in r.stdout

    def test_no_node_and_no_coords_fails_with_the_right_hint(self, tmp_path):
        """No state, no --node, no --lat → die with 'start the agent', not chat."""
        env = {"HIVV_STATE_DIR": str(tmp_path / "state"), "HOME": str(tmp_path / "home")}
        (tmp_path / "home").mkdir(parents=True, exist_ok=True)
        r = _run(["salah"], env_extra=env)
        assert r.returncode != 0, "must fail loudly, not chat"
        combined = r.stdout + r.stderr
        assert "hivv start" in combined, "the hint must say how to get a node id"
        assert "asking the hive" not in combined, "salah must never fall into chat"


@requires_hub
class TestSalahLive:
    """Round-trips against the real gateway (skipped when it is down)."""

    def test_adhoc_json_carries_prayers_and_moon(self):
        r = _run(["salah", "--lat", "46.73", "--lon", "-116.99", "--json"])
        assert r.returncode == 0, r.stderr
        p = json.loads(r.stdout)
        assert p["node"] is None
        for k in ("fajr", "dhuhr", "asr", "maghrib", "isha"):
            assert isinstance(p["prayers"][k], (int, float)), k
        assert p["next"]["prayer"], "there is always a next prayer"
        assert "name" in p["moon"], "the moon rides along"
        assert p["attendance"] is None, "ad-hoc has no attendance"

    def test_adhoc_human_render(self):
        r = _run(["salah", "--lat", "46.73", "--lon", "-116.99"])
        assert r.returncode == 0, r.stderr
        out = r.stdout
        for name in ("fajr", "dhuhr", "asr", "maghrib", "isha"):
            assert name in out, name
        assert "next in" in out, "the upcoming prayer must be flagged"
        assert "moon:" in out
        assert "local clock" in out

    def test_node_form_carries_attendance(self):
        r = _run(["salah", "--node", "wahi", "--json"])
        if r.returncode != 0 and "404" in (r.stdout + r.stderr):
            pytest.skip("wahi not in this store")
        assert r.returncode == 0, r.stderr
        p = json.loads(r.stdout)
        assert p["node"] == "wahi"
        att = p["attendance"]
        assert att is not None, "a registered node gets attendance"
        assert isinstance(att["today"], list)
        assert isinstance(att["expected"], int)
        assert isinstance(att["streak"], int)

    def test_alias_reaches_the_route_too(self):
        r = _run(["sala", "--lat", "46.73", "--lon", "-116.99", "--json"])
        assert r.returncode == 0, r.stderr
        p = json.loads(r.stdout)
        assert p["prayers"]["dhuhr"], "sala must behave exactly like salah"


if __name__ == "__main__":
    import pytest as _pytest

    sys.exit(_pytest.main([__file__, "-v"]))
