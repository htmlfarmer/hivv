"""The watchdog: restart a stuck local service, and never loop.

WHY THIS EXISTS
----------------------------------------------------------------------
The tool server had NO supervisor at all. It was started by a detached
'setsid' spawn, so when it died it stayed dead, and when it went STALE it
stayed stale — a box on 2026-11-26 had been running the pre-refactor
hivv-tools.py for a MONTH (5 tools, no do_POST, every POST answered 501).
The gateway had scripts/health-watchdog.sh; the agent and llama had systemd
units with crash-loop bounds; the tool server had neither.

The ask was "automate a restart if it gets stuck — but not in an infinite
loop". The loop half is the whole design, so it is pinned here:

  1. DESIRED STATE — only services the user turned ON are supervised. A
     watchdog that restarts what you deliberately turned OFF is a bug.
  2. THRESHOLD — two consecutive failed probes, never one.
  3. BACKOFF — the delay GROWS with each attempt (120s -> 240 -> 480 -> 900
     cap), so a service that cannot start is not hammered.
  4. BUDGET — a hard cap on restarts. Spend it and the service is
     QUARANTINED: the watchdog stops restarting it and says so, until a
     human runs 'hivv watch reset' or the service recovers on its own.
     An endless retry is a slow storm; a bounded one is supervision.
  5. THE STATE IS A FILE — the bound survives a watchdog restart, so the
     loop breaker cannot be reset by the very thing it exists to stop.

Also pinned: the STALE SERVER fix (health = the catalog's SHAPE plus a real
tool call, never 'the pid is alive'), the systemd unit text (systemd's own
StartLimit bound), and the intent flag that separates wanted from running.

No network, no $HOME writes (HIVV_STATE_DIR is a temp dir), no systemd.
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"

# Isolate state BEFORE the module computes its paths — the same contract as
# test_dial_setup / test_cli_install (an import-time env leaker poisons every
# later subprocess; the 2026-11-24 full-suite red).
_PRE_STATE = os.environ.get("HIVV_STATE_DIR")
_PRE_HUB = os.environ.get("HIVV_HUB")
_WATCH_STATE = tempfile.mkdtemp(prefix="hivv-watch-test-")
_WATCH_HUB = "http://127.0.0.1:1"               # dead port: fast-fail, offline
os.environ["HIVV_STATE_DIR"] = _WATCH_STATE
os.environ["HIVV_HUB"] = _WATCH_HUB


@pytest.fixture(scope="module", autouse=True)
def _restore_env_after_this_module():
    os.environ["HIVV_STATE_DIR"] = _WATCH_STATE
    os.environ["HIVV_HUB"] = _WATCH_HUB
    yield
    if _PRE_STATE is None:
        os.environ.pop("HIVV_STATE_DIR", None)
    else:
        os.environ["HIVV_STATE_DIR"] = _PRE_STATE
    if _PRE_HUB is None:
        os.environ.pop("HIVV_HUB", None)
    else:
        os.environ["HIVV_HUB"] = _PRE_HUB


def _load_cli():
    spec = importlib.util.spec_from_file_location("hivv_cli_watchtest", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cli = _load_cli()


def _cfg(**over):
    cfg = {"fails": 2, "backoff": 120, "max_backoff": 900,
           "budget": 4, "window": 3600, "interval": 30}
    cfg.update(over)
    return cfg


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _run(args, env_extra=None, timeout=120):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, str(CLI), *args],
                          capture_output=True, text=True,
                          timeout=timeout, env=env)


@pytest.fixture(autouse=True)
def _clean_watch_state():
    """The watchdog's state lives in the module's temp STATE_DIR — never let
    one test's spent budget bleed into the next test's decision."""
    for name in ("watch-state.json", "tools.enabled"):
        p = cli.STATE_DIR / name
        if p.exists():
            p.unlink()
    yield
    for name in ("watch-state.json", "tools.enabled"):
        p = cli.STATE_DIR / name
        if p.exists():
            p.unlink()


# =============================================================================
# THE DECISION — the loop-breaker itself
# =============================================================================
class TestDecision:
    def test_a_healthy_service_is_ok(self):
        s = {}
        action, reason = cli._watch_decide(s, desired=True, healthy=True,
                                           now=1000.0, cfg=_cfg())
        assert action == "ok"

    def test_ONE_failed_probe_never_restarts(self):
        """A blip is not a fault. One failed probe must not touch the box."""
        s = {}
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1000.0, cfg=_cfg())
        assert action == "wait"
        assert "1/2" in reason

    def test_two_failed_probes_restart(self):
        s = {}
        cli._watch_decide(s, desired=True, healthy=False, now=1000.0, cfg=_cfg())
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1001.0, cfg=_cfg())
        assert action == "restart"

    def test_a_service_you_did_not_want_is_never_restarted(self):
        """The watchdog must not fight the user."""
        s = {}
        for i in range(10):
            action, _ = cli._watch_decide(s, desired=False, healthy=False,
                                          now=1000.0 + i, cfg=_cfg())
            assert action == "ok"
        assert s.get("fails", 0) == 0

    def test_the_backoff_grows_between_attempts(self):
        s = {}
        cfg = _cfg()
        cli._watch_decide(s, desired=True, healthy=False, now=1000.0, cfg=cfg)
        action, _ = cli._watch_decide(s, desired=True, healthy=False,
                                      now=1001.0, cfg=cfg)
        assert action == "restart"
        s["restarts"].append(1001.0)
        s["last_restart"] = 1001.0
        # inside the first backoff (120s) -> wait
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1060.0, cfg=cfg)
        assert action == "wait"
        assert "backoff" in reason
        # the SECOND backoff is longer (120 * 2 = 240s)
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1130.0, cfg=cfg)
        assert action == "wait"
        # past it -> another attempt is allowed
        action, _ = cli._watch_decide(s, desired=True, healthy=False,
                                      now=1242.0, cfg=cfg)
        assert action == "restart"

    def test_the_backoff_is_capped(self):
        s = {"restarts": [1000.0] * 6, "last_restart": 1000.0, "fails": 5}
        cfg = _cfg(budget=100)
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1010.0, cfg=cfg)
        assert action == "wait"
        # 120 * 2**6 = 7680s would be the raw value — the cap holds it at 900
        s["last_restart"] = 1000.0
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1000.0 + 901, cfg=cfg)
        assert action == "restart"

    def test_the_budget_quarantines_and_stops(self):
        """Spend the budget and the watchdog STOPS. This is the end of the
        loop — not a slower loop."""
        s = {}
        cfg = _cfg(budget=3, backoff=0, window=100000)
        now = 1000.0
        for _ in range(3):
            cli._watch_decide(s, desired=True, healthy=False, now=now, cfg=cfg)
            action, _ = cli._watch_decide(s, desired=True, healthy=False,
                                          now=now + 1, cfg=cfg)
            assert action == "restart"
            s["restarts"].append(now + 1)
            s["last_restart"] = now + 1
            now += 10
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=now, cfg=cfg)
        assert action == "quarantine"
        assert "budget" in reason
        # and it STAYS quarantined — no further restarts, ever
        spent = len(s["restarts"])
        action, _ = cli._watch_decide(s, desired=True, healthy=False,
                                      now=now + 999999, cfg=cfg)
        assert action == "quarantine"
        assert len(s["restarts"]) == spent

    def test_a_self_recovery_clears_everything(self):
        """A service that came back on its own must not stay punished."""
        s = {"fails": 9, "restarts": [1.0, 2.0], "last_restart": 2.0,
             "quarantined": 1}
        action, _ = cli._watch_decide(s, desired=True, healthy=True,
                                      now=1000.0, cfg=_cfg())
        assert action == "ok"
        assert s["fails"] == 0
        assert s["quarantined"] == 0

    def test_the_restart_ledger_is_pruned_to_the_window(self):
        s = {"restarts": [1.0, 2.0, 3.0], "last_restart": 1.0, "fails": 5}
        cfg = _cfg(budget=2, backoff=0, window=100)
        action, reason = cli._watch_decide(s, desired=True, healthy=False,
                                           now=1000.0, cfg=cfg)
        # the old attempts fell out of the window -> the budget is free again
        assert action == "restart"

    def test_the_budget_survives_a_watchdog_restart(self):
        """The state is a FILE. The loop breaker cannot be reset by the very
        thing it exists to stop."""
        s = {"restarts": [1000.0, 1001.0], "last_restart": 1001.0,
             "fails": 4, "quarantined": 1}
        cli._watch_save_state({"tools": s})
        fresh = cli._watch_load_state()
        action, _ = cli._watch_decide(fresh["tools"], desired=True,
                                      healthy=False, now=1002.0,
                                      cfg=_cfg(budget=2, window=100000))
        assert action == "quarantine"

    def test_the_dials_are_env_overridable(self, monkeypatch):
        monkeypatch.setenv("HIVV_WATCH_FAILS", "5")
        monkeypatch.setenv("HIVV_WATCH_BUDGET", "9")
        monkeypatch.setenv("HIVV_WATCH_BACKOFF", "7")
        cfg = cli._watch_cfg()
        assert cfg["fails"] == 5
        assert cfg["budget"] == 9
        assert cfg["backoff"] == 7

    def test_a_junk_env_value_falls_back_to_the_default(self, monkeypatch):
        monkeypatch.setenv("HIVV_WATCH_FAILS", "not-a-number")
        assert cli._watch_cfg()["fails"] == 2


# =============================================================================
# THE TICK — one supervision pass, end to end
# =============================================================================
class TestTick:
    def _fake(self, monkeypatch, *, desired=True, healthy=False,
              restart_result=("restarted", "ok")):
        seen = {"restarts": 0}

        def _restart():
            seen["restarts"] += 1
            return restart_result

        monkeypatch.setattr(cli, "_watch_services", lambda: [{
            "name": "fake", "desired": lambda: desired,
            "probe": lambda: (healthy, "fake detail"),
            "restart": _restart,
        }])
        return seen

    def test_one_bad_probe_does_not_restart(self, monkeypatch):
        seen = self._fake(monkeypatch)
        res = cli._watch_tick(now=1000.0)
        assert res["restarted"] == []
        assert seen["restarts"] == 0

    def test_two_bad_probes_restart(self, monkeypatch):
        seen = self._fake(monkeypatch)
        cli._watch_tick(now=1000.0)
        res = cli._watch_tick(now=1001.0)
        assert res["restarted"] == ["fake"]
        assert seen["restarts"] == 1

    def test_a_service_you_did_not_want_is_never_restarted(self, monkeypatch):
        seen = self._fake(monkeypatch, desired=False)
        for i in range(5):
            cli._watch_tick(now=1000.0 + i)
        assert seen["restarts"] == 0

    def test_a_failed_restart_still_spends_the_budget(self, monkeypatch):
        """An attempt is an attempt. If the restart FAILS, that attempt is
        spent — otherwise a service that cannot start loops forever."""
        seen = self._fake(monkeypatch, restart_result=("failed", "boom"))
        cli._watch_tick(now=1000.0)
        res = cli._watch_tick(now=1001.0)
        assert res["restarted"] == ["fake"]
        state = cli._watch_load_state()
        assert len(state["fake"]["restarts"]) == 1

    def test_a_skipped_restart_spends_nothing(self, monkeypatch):
        """'skipped' means no attempt was made (the unit owns the port) — it
        must not burn the budget."""
        seen = self._fake(monkeypatch, restart_result=("skipped", "unit owns it"))
        cli._watch_tick(now=1000.0)
        cli._watch_tick(now=1001.0)
        state = cli._watch_load_state()
        assert state["fake"].get("restarts") in (None, [])

    def test_a_report_only_service_is_never_restarted(self, monkeypatch):
        monkeypatch.setattr(cli, "_watch_services", lambda: [{
            "name": "agent", "desired": lambda: True,
            "probe": lambda: (False, "wedged"), "restart": None,
        }])
        cli._watch_tick(now=1000.0)
        res = cli._watch_tick(now=1001.0)
        assert res["restarted"] == []
        svc = [s for s in res["services"] if s["name"] == "agent"][0]
        assert "report-only" in svc.get("restart", "")

    def test_quarantine_STOPS_the_service(self, monkeypatch):
        """Quarantine means STOP. A supervisor left running is the loop we
        just broke — pm2 happily restarts a doomed app forever, so the
        watchdog has to stop the app itself."""
        monkeypatch.setenv("HIVV_WATCH_BUDGET", "2")
        monkeypatch.setenv("HIVV_WATCH_BACKOFF", "0")
        monkeypatch.setenv("HIVV_WATCH_FAILS", "1")
        stopped = []
        monkeypatch.setattr(cli, "_watch_services", lambda: [{
            "name": "fake", "desired": lambda: True,
            "probe": lambda: (False, "wedged"),
            "restart": lambda: ("restarted", "ok"),
            "quarantine": lambda: (stopped.append(1), "stopped it")[1],
        }])
        for i in range(6):
            cli._watch_tick(now=1000.0 + i)
        assert stopped, "a quarantined service must be STOPPED, not left looping"
        assert "QUARANTINED" in cli.WATCH_LOG_FILE.read_text()


# =============================================================================
# THE STALE SERVER — "running" is not "working"
# =============================================================================
class TestStaleServer:
    OLD = {"tools": ["time", "calculate", "fetch", "search", "sysinfo"]}
    NEW = {"tools": ["web_search", "current_time", "calculator", "web_fetch",
                     "http_request", "code_interpreter", "file_read",
                     "file_search", "memory", "text_parser",
                     "timezone_convert", "translate", "sysinfo"],
           "local_tools": ["current_time", "calculator"],
           "hub_tools": ["web_search"]}

    def test_the_old_catalog_is_not_healthy(self):
        assert cli._tools_healthy(self.OLD) is False

    def test_the_current_catalog_is_healthy(self):
        assert cli._tools_healthy(self.NEW) is True

    def test_a_catalog_without_the_split_is_not_healthy(self):
        assert cli._tools_healthy({"tools": ["x"] * 13}) is False

    def test_no_catalog_is_not_healthy(self):
        assert cli._tools_healthy(None) is False

    def _serve(self, monkeypatch, handler):
        port = _free_port()
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        monkeypatch.setattr(cli, "TOOLS_PORT", port)
        return srv

    def test_the_probe_catches_a_501_on_the_tool_path(self, monkeypatch):
        """The old server answered GET /tools perfectly and 501'd every POST.
        The catalog alone was NOT enough to catch it."""
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(self_new()).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                self.send_error(501)

            def log_message(self, *a):
                pass

        def self_new():
            return {"tools": ["x"] * 13, "local_tools": [], "hub_tools": []}

        srv = self._serve(monkeypatch, H)
        try:
            healthy, detail = cli._tools_probe()
            assert healthy is False
            assert "501" in detail or "tool call failed" in detail
        finally:
            srv.shutdown()

    def test_the_probe_catches_a_stale_catalog(self, monkeypatch):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(TestStaleServer.OLD).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = self._serve(monkeypatch, H)
        try:
            healthy, detail = cli._tools_probe()
            assert healthy is False
            assert "stale" in detail
        finally:
            srv.shutdown()

    def test_the_probe_passes_a_healthy_server(self, monkeypatch):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(TestStaleServer.NEW).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                body = json.dumps({"tool": "calculator", "ok": True,
                                   "data": {"result": 2}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = self._serve(monkeypatch, H)
        try:
            healthy, detail = cli._tools_probe()
            assert healthy is True
            assert "tool calls OK" in detail
        finally:
            srv.shutdown()


# =============================================================================
# THE INTENT FLAG — wanted vs running
# =============================================================================
class TestIntent:
    def test_the_flag_records_what_the_user_asked_for(self):
        cli._tools_mark_enabled()
        assert cli.TOOLS_ENABLED_FILE.exists()
        cli._tools_mark_disabled()
        assert not cli.TOOLS_ENABLED_FILE.exists()

    def test_the_flag_survives_the_server_dying(self):
        """The flag is the DESIRED state. It must outlive the process —
        otherwise the watchdog forgets what the server is for."""
        cli._tools_mark_enabled()
        assert cli._tools_desired() is True


# =============================================================================
# THE UNITS — systemd's own loop-breaker
# =============================================================================
class TestUnits:
    def test_the_tools_unit_carries_the_crash_loop_bound(self):
        txt = cli._tools_unit_text()
        assert "StartLimitIntervalSec=300" in txt
        assert "StartLimitBurst=3" in txt
        assert "Restart=on-failure" in txt

    def test_the_tools_unit_binds_loopback_only(self):
        txt = cli._tools_unit_text()
        assert "HIVV_TOOLS_HOST=127.0.0.1" in txt

    def test_the_watchdog_unit_is_supervised_too(self):
        txt = cli._watch_unit_text()
        assert "StartLimitIntervalSec=300" in txt
        assert "StartLimitBurst=3" in txt
        assert "Restart=on-failure" in txt

    def test_the_watchdog_unit_runs_the_watch_loop(self):
        txt = cli._watch_unit_text()
        assert "watch run" in txt


# =============================================================================
# THE CLI
# =============================================================================
# =============================================================================
# ONE OWNER PER PORT — and the supervisors that do not bound themselves
# =============================================================================
class TestOwner:
    def test_an_enabled_unit_owns_the_port(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cli, "_tools_unit_path", lambda: tmp_path / "u.service")
        monkeypatch.setattr(cli, "_unit_enabled",
                            lambda unit, user=True: unit == cli.TOOLS_UNIT)
        monkeypatch.setattr(cli, "_pm2_has", lambda name, ttl=300.0: True)
        assert cli._tools_owner() == "systemd"

    def test_pm2_wins_over_a_leftover_disabled_unit(self, monkeypatch, tmp_path):
        """A disabled unit file is not an owner. If it were, the watchdog
        would restart through a unit that is not running while pm2 holds
        the port."""
        monkeypatch.setattr(cli, "_tools_unit_path", lambda: tmp_path / "u.service")
        monkeypatch.setattr(cli, "_unit_enabled", lambda unit, user=True: False)
        monkeypatch.setattr(cli, "_pm2_has", lambda name, ttl=300.0: True)
        monkeypatch.setattr(cli, "_tools_running", lambda: True)
        assert cli._tools_owner() == "pm2"

    def test_a_detached_spawn_has_no_owner(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cli, "_tools_unit_path", lambda: tmp_path / "u.service")
        monkeypatch.setattr(cli, "_unit_enabled", lambda unit, user=True: False)
        monkeypatch.setattr(cli, "_pm2_has", lambda name, ttl=300.0: False)
        monkeypatch.setattr(cli, "_tools_running", lambda: True)
        assert cli._tools_owner() == "detached"


class TestPm2Bound:
    """pm2's default restart policy is UNBOUNDED: autorestart with no
    max_restarts. An app that cannot start is restarted forever."""

    def _app(self, **over):
        app = {"pm_exec_path": "/usr/bin/python3",
               "args": ["hivv-tools.py", "start"],
               "autorestart": True, "max_restarts": None}
        app.update(over)
        return app

    def test_an_already_bounded_app_is_left_alone(self, monkeypatch):
        monkeypatch.setattr(cli, "_pm2_app",
                            lambda name: self._app(max_restarts=5))
        ok, msg = cli._pm2_bound_restarts("hivv-tools")
        assert ok
        assert "already bounded" in msg

    def test_autorestart_off_needs_no_bound(self, monkeypatch):
        monkeypatch.setattr(cli, "_pm2_app",
                            lambda name: self._app(autorestart=False))
        ok, msg = cli._pm2_bound_restarts("hivv-tools")
        assert ok
        assert "autorestart is off" in msg

    def test_an_unbounded_app_gets_a_bound(self, monkeypatch):
        seen = {}

        def fake_run(cmd, *a, **kw):
            seen["cmd"] = list(cmd)
            for arg in cmd:
                if str(arg).endswith(".json"):
                    seen["eco"] = json.loads(Path(str(arg)).read_text())
            class R:
                returncode = 0
                stdout = ""
                stderr = ""
            return R()

        monkeypatch.setattr(cli, "_pm2_app", lambda name: self._app())
        monkeypatch.setattr(cli, "_pm2_bin", lambda: "/usr/bin/pm2")
        monkeypatch.setattr(cli.subprocess, "run", fake_run)
        ok, msg = cli._pm2_bound_restarts("hivv-tools")
        assert ok
        assert "bounded" in msg
        app = seen["eco"]["apps"][0]
        # the bound itself
        assert app["max_restarts"] == 3
        assert app["min_uptime"] == 60000
        assert app["restart_delay"] == 10000
        # and the app is reproduced faithfully — the same command, the same cwd
        assert app["script"] == "/usr/bin/python3"
        assert app["args"] == ["hivv-tools.py", "start"]

    def test_a_failed_pm2_start_is_reported_not_hidden(self, monkeypatch):
        def fake_run(cmd, *a, **kw):
            class R:
                returncode = 1
                stdout = ""
                stderr = "boom"
            return R()

        monkeypatch.setattr(cli, "_pm2_app", lambda name: self._app())
        monkeypatch.setattr(cli, "_pm2_bin", lambda: "/usr/bin/pm2")
        monkeypatch.setattr(cli.subprocess, "run", fake_run)
        ok, msg = cli._pm2_bound_restarts("hivv-tools")
        assert not ok
        assert "boom" in msg


class TestCli:
    def test_watch_status_prints_the_loop_breaker(self):
        r = _run(["watch", "status"])
        assert r.returncode == 0, r.stderr
        assert "loop-breaker" in r.stdout
        assert "QUARANTINE" in r.stdout

    def test_watch_run_once_is_a_single_pass(self):
        r = _run(["watch", "run", "--once"])
        assert r.returncode == 0, r.stderr
        assert "tools" in r.stdout

    def test_watch_reset_clears_the_counters(self):
        cli._watch_save_state({"tools": {"fails": 9, "restarts": [1.0],
                                         "quarantined": 1}})
        r = _run(["watch", "reset", "tools"])
        assert r.returncode == 0, r.stderr
        state = cli._watch_load_state()
        assert state.get("tools", {}) == {}

    def test_watch_reset_of_an_unknown_service_dies(self):
        r = _run(["watch", "reset", "nope"])
        assert r.returncode != 0
        assert "no watchdog state" in (r.stdout + r.stderr)

    def test_tools_status_reports_the_health_not_just_the_pid(self):
        # Whatever the state of this box's tool server, the status command
        # must ANSWER — it reports the health when it is up and says plainly
        # that it is not running when it is down. It never dies, and it never
        # claims health without a probe.
        r = _run(["tools", "status"])
        assert r.returncode == 0, r.stderr
        assert ("health:" in r.stdout) or ("not running" in r.stdout)
        assert "Traceback" not in r.stderr

    def test_watch_is_in_the_help(self):
        r = _run(["help"])
        assert "watch" in r.stdout.lower()
