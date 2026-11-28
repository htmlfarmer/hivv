"""P2P default for OpenCode: the local dial shim, with the hub as the fallback.

WHY THIS EXISTS
---------------------------------------------------------------------
`hivv setup` used to write baseURL=https://hivv.org/v1 — EVERY chat request
then relayed through the hub. The dial shim (hivv dial) inverts that: one
local endpoint (127.0.0.1:3911/v1), the hub consulted only for route picks +
async telemetry, the data plane direct-to-bee. The ask: "migrate people to
P2P naturally — hivv setup should do the dial shim mode by default, and
almost never do direct requests."

Pinned here:
  1. THE ENDPOINT DECISION — the shim URL by default; the hub when the user
     opted out (--no-shim / dial off marker / HIVV_DIAL_OFF) or the shim
     cannot run (foreign app on the port, start failed). A config is NEVER
     written against a dead localhost URL.
  2. MIGRATION — a HIVV-OWNED baseURL (hub ↔ shim) moves to whatever this
     run decided, with a backup; a user's own proxy URL is never touched.
  3. PROBE — OUR shim (healthz marker + pid) vs a foreign app vs a free port.
  4. ENSURE — probe-only has NO side effects; the disabled marker is
     honored; the spawn path really starts/stops a shim. Tests NEVER install
     systemd/LaunchAgent units (service install is monkeypatched away, or
     never reached: already-running / disabled / HOME pointed at a tmp dir).
  5. _fwd_payload — a DIRECT candidate gets the real model name (ollama 404s
     on "auto", llama.cpp ignores the field); a HUB candidate keeps the
     alias — the hub routes on it. The body dict is never mutated.
  6. SERVICE TEXT — the systemd unit / LaunchAgent content is pinned as a
     pure string (crash-loop bounds, Restart=always, ExecStart with dial
     --port) without installing anything.
  7. CLI — `dial status` exit codes, `setup --json` carries a dial block,
     `setup --write` writes/migrates the config, --dry-run writes NOTHING.

No network (the hub is a dead localhost port), no $HOME writes
(HIVV_STATE_DIR is a temp dir; write tests point HOME at a tmp dir too),
no systemd. A real shim is spawned on a free port where the probe needs one.
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
# test_cli_install / test_failure_diagnostics (an import-time env leaker
# poisons every later subprocess; the 2026-11-24 full-suite red).
_PRE_STATE = os.environ.get("HIVV_STATE_DIR")
_PRE_HUB = os.environ.get("HIVV_HUB")
_DIAL_STATE = tempfile.mkdtemp(prefix="hivv-dial-test-")
_DIAL_HUB = "http://127.0.0.1:1"               # dead port: fast-fail, offline
os.environ["HIVV_STATE_DIR"] = _DIAL_STATE
os.environ["HIVV_HUB"] = _DIAL_HUB


@pytest.fixture(scope="module", autouse=True)
def _restore_env_after_this_module():
    # RE-assert the poison for the DURATION of our tests: an earlier module's
    # restore fixture (test_cli_install's — the leaker fix of 2026-11-24) may
    # have cleaned the env before we run, but these tests compare CHILD output
    # (env resolved at run time) against cli.HUB (frozen at import). Both must
    # agree no matter which order the suite executes in.
    os.environ["HIVV_STATE_DIR"] = _DIAL_STATE
    os.environ["HIVV_HUB"] = _DIAL_HUB
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
    spec = importlib.util.spec_from_file_location("hivv_cli_dialtest", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cli = _load_cli()


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
def _clean_dial_marker():
    """The opt-out marker lives in the module's temp STATE_DIR — never let
    one test's `dial off` bleed into the next test's endpoint decision."""
    marker = cli._dial_off_marker()
    if marker.exists():
        marker.unlink()
    yield
    if marker.exists():
        marker.unlink()


@pytest.fixture
def shim(tmp_path):
    """A REAL dial shim on a free port (spawned, killed at teardown).
    healthz needs no hub — the dial happens lazily on the first chat.

    The shim's output is CAPTURED, not thrown away: this fixture was failing
    on the macOS CI runner for weeks with nothing but "never became healthy",
    and a blind failure is a failure nobody can fix. Whatever the shim said
    (or failed to say) now travels with the assertion.
    """
    port = _free_port()
    log = tmp_path / "shim.log"
    # PYTHONUNBUFFERED is the whole point of capturing this: stdout pointed at
    # a FILE is block-buffered in Python, so a shim that prints two lines and
    # then hangs shows an EMPTY log — and kill() throws the buffer away
    # entirely. Unbuffered, whatever it managed to say is on disk when we
    # read it, which is the only way this fixture can ever explain itself.
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    with open(log, "wb") as fh:
        proc = subprocess.Popen(
            [sys.executable, str(CLI), "dial", "--port", str(port)],
            stdout=fh, stderr=subprocess.STDOUT, env=env)

    def _tail():
        try:
            return log.read_text(encoding="utf-8", errors="replace")[-1200:]
        except OSError:
            return "(no shim output captured)"

    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            if cli._dial_health(port, timeout=0.5):
                break
            if proc.poll() is not None:
                pytest.fail(f"shim exited early rc={proc.returncode}\n--- shim output ---\n{_tail()}")
            time.sleep(0.2)
        else:
            # READ BEFORE KILL. SIGKILL discards anything still in a buffer,
            # so killing first and reading second returns an empty file even
            # when the shim said something. Report what the process was doing
            # (alive? how long?) alongside it, so the next failure is data and
            # not another shrug.
            tail = _tail()
            alive = proc.poll() is None
            proc.kill()
            pytest.fail(
                "shim never became healthy "
                f"(alive={alive} pid={proc.pid} waited=10s, "
                f"log_bytes={len(tail)})\n--- shim output ---\n" + tail)
        yield port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


class _Foreign:
    """A plain HTTP server on a port — answers, but is NOT our shim."""

    def __init__(self):
        self.port = _free_port()

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"service": "something-else"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


@pytest.fixture
def foreign():
    f = _Foreign()
    yield f
    f.close()


# ── 1. port / url / endpoint decision (pure) ─────────────────────────────
class TestEndpointPure:
    def test_port_default(self, monkeypatch):
        monkeypatch.delenv("HIVV_DIAL_PORT", raising=False)
        assert cli._dial_port() == 3911

    def test_port_env_override(self, monkeypatch):
        monkeypatch.setenv("HIVV_DIAL_PORT", "4444")
        assert cli._dial_port() == 4444
        assert cli._dial_url() == "http://127.0.0.1:4444/v1"

    def test_port_bad_env_falls_back(self, monkeypatch):
        monkeypatch.setenv("HIVV_DIAL_PORT", "not-a-number")
        assert cli._dial_port() == 3911

    def test_owned_urls_include_hub_and_shim(self, monkeypatch):
        monkeypatch.delenv("HIVV_DIAL_PORT", raising=False)
        urls = cli._hivv_owned_base_urls()
        assert "https://hivv.org/v1" in urls
        assert "http://hivv.org/v1" in urls
        assert "http://127.0.0.1:3911/v1" in urls
        assert "http://localhost:3911/v1" in urls

    def test_custom_proxy_is_never_owned(self):
        assert "https://my-proxy.example/v1" not in cli._hivv_owned_base_urls()

    def test_opencode_config_for_sets_url(self):
        cfg = cli._opencode_config_for("http://127.0.0.1:9999/v1")
        assert cfg["providers"]["hivv"]["settings"]["baseURL"] ==             "http://127.0.0.1:9999/v1"
        assert len(cfg["providers"]["hivv"]["models"]) == 5

    def test_opencode_config_for_is_a_deep_copy(self):
        cfg = cli._opencode_config_for("http://mutated/v1")
        cfg["providers"]["hivv"]["settings"]["baseURL"] = "mutated"
        assert cli.OPENCODE_CONFIG["providers"]["hivv"]["settings"][
            "baseURL"] == "https://hivv.org/v1"


# ── 2. the endpoint decision (P2P default, hub fallback) ─────────────────
class TestP2pEndpoint:
    def test_disabled_env_returns_hub(self, monkeypatch):
        monkeypatch.setenv("HIVV_DIAL_OFF", "1")
        url, info = cli._p2p_endpoint(want=True, install=True,
                                      port=_free_port())
        assert url == f"{cli.HUB}/v1"
        assert info["enabled"] is False and info["how"] == "disabled"

    def test_no_shim_flag_returns_hub(self):
        url, info = cli._p2p_endpoint(want=False, install=True,
                                      port=_free_port())
        assert url == f"{cli.HUB}/v1"
        assert info["enabled"] is False

    def test_running_shim_wins(self, shim):
        url, info = cli._p2p_endpoint(install=False, port=shim)
        assert url == f"http://127.0.0.1:{shim}/v1"
        assert info["running"] is True and info["how"] == "already"
        assert isinstance(info["pid"], int)

    def test_report_mode_states_the_intent_without_starting(self):
        port = _free_port()
        url, info = cli._p2p_endpoint(install=False, port=port)
        # what --write WOULD do — but nothing was started
        assert url == f"http://127.0.0.1:{port}/v1"
        assert info["how"] == "will-start" and info["running"] is False
        assert cli._dial_port_state(port) == "free"

    def test_write_mode_starts_the_shim(self, monkeypatch):
        monkeypatch.setattr(cli, "_dial_install_service",
                            lambda *a, **k: None)   # tests never touch systemd
        port = _free_port()
        url, info = cli._p2p_endpoint(install=True, port=port)
        try:
            assert info["running"] is True and info["how"] == "spawned"
            assert url == f"http://127.0.0.1:{port}/v1"
        finally:
            cli._dial_stop(port, service=False)

    def test_foreign_port_falls_back_to_hub_never_a_dead_url(self, monkeypatch,
                                                            foreign):
        monkeypatch.setattr(cli, "_dial_install_service",
                            lambda *a, **k: None)
        url, info = cli._p2p_endpoint(install=True, port=foreign.port)
        assert url == f"{cli.HUB}/v1", "must NEVER write a dead localhost URL"
        assert info["fallback"] == "hub"
        assert info["how"] == "foreign"
        assert "in use" in info["error"]


# ── 3. probe: our shim vs foreign vs free ────────────────────────────────
class TestProbe:
    def test_dead_port_is_free(self):
        port = _free_port()
        assert cli._dial_health(port, timeout=0.4) is None
        assert cli._dial_port_state(port) == "free"

    def test_foreign_server_is_foreign(self, foreign):
        assert cli._dial_health(foreign.port, timeout=1.0) is None
        assert cli._dial_port_state(foreign.port) == "foreign"

    def test_our_shim_is_ours(self, shim):
        h = cli._dial_health(shim)
        assert h is not None
        assert h["shim"] == "hivv-dial"
        assert isinstance(h.get("pid"), int) and h["pid"] > 0
        assert cli._dial_port_state(shim) == "ours"


# ── 4. ensure / stop (spawn path only — no systemd in tests) ─────────────
class TestEnsureStop:
    def test_probe_only_has_no_side_effects(self):
        port = _free_port()
        unit = Path.home() / ".config" / "systemd" / "user" / "hivv-dial.service"
        existed = unit.exists()
        info = cli._dial_ensure(port=port, install=False)
        assert info["running"] is False and info["how"] == "probe-only"
        assert unit.exists() == existed, "probe must not install anything"
        assert cli._dial_port_state(port) == "free"

    def test_disabled_marker_wins_over_install(self):
        port = _free_port()
        cli._dial_off_marker().write_text("off\n")
        info = cli._dial_ensure(port=port, install=True)
        assert info["how"] == "disabled" and info["running"] is False
        assert cli._dial_port_state(port) == "free",             "a disabled shim must not be started"

    def test_env_disabled(self, monkeypatch):
        monkeypatch.setenv("HIVV_DIAL_OFF", "yes")
        info = cli._dial_ensure(port=_free_port(), install=True)
        assert info["how"] == "disabled"

    def test_already_running_short_circuits(self, shim):
        info = cli._dial_ensure(port=shim, install=False)
        assert info["running"] is True and info["how"] == "already"
        assert info["endpoint"] == f"http://127.0.0.1:{shim}/v1"

    def test_a_requested_pin_is_applied_not_dropped(self, shim, monkeypatch):
        """'dial on --pin X' must actually PIN.

        THE BUG: the shim was already running, so _dial_ensure answered
        "already running" and the --pin was dropped on the floor. The
        command printed success while the shim kept serving the bee it had
        already picked, and the unit file still had no --pin in it
        (yalla 2026-11-27).
        """
        # a test must NEVER touch the real systemd unit
        monkeypatch.setattr(cli, "_service_state", lambda *a, **k: None)
        monkeypatch.setattr(cli, "_dial_install_service",
                            lambda *a, **k: None)
        # The 8s budget _dial_ensure gives _dial_wait is about a COLD START
        # on a loaded box. This test is not about that, but the wait must
        # still POLL -- a shim that is 1s from answering is not a dead shim.
        def _fast_wait(port=None, seconds=4.0):
            deadline = time.time() + min(seconds, 4.0)
            while time.time() < deadline:
                if cli._dial_health(port, timeout=0.5):
                    return True
                time.sleep(0.25)
            return cli._dial_health(port, timeout=0.5) is not None

        monkeypatch.setattr(cli, "_dial_wait", _fast_wait)
        assert cli._dial_running_pin(shim) == "", "the fixture starts unpinned"
        try:
            info = cli._dial_ensure(port=shim, hub=cli.HUB, pin="yalla",
                                    install=True)
            assert info["running"] is True, info
            assert info.get("pin_replaced") == "", info
            assert cli._dial_running_pin(shim) == "yalla", \
                "the pin must be in the RUNNING shim argv"
        finally:
            cli._dial_stop(shim, service=False, marker=False)

    def test_the_same_pin_leaves_the_shim_alone(self, shim, monkeypatch):
        """Asking for the pin that is already in force must NOT bounce the
        shim -- a needless restart drops the requests in flight."""
        monkeypatch.setattr(cli, "_service_state", lambda *a, **k: None)
        monkeypatch.setattr(cli, "_dial_install_service",
                            lambda *a, **k: None)

        def _fast_wait(port=None, seconds=4.0):
            deadline = time.time() + min(seconds, 4.0)
            while time.time() < deadline:
                if cli._dial_health(port, timeout=0.5):
                    return True
                time.sleep(0.25)
            return cli._dial_health(port, timeout=0.5) is not None

        monkeypatch.setattr(cli, "_dial_wait", _fast_wait)
        try:
            first = cli._dial_ensure(port=shim, hub=cli.HUB, pin="yalla",
                                     install=True)
            assert first["running"] is True, first
            assert cli._dial_running_pin(shim) == "yalla"
            pid_before = cli._dial_pid(shim)
            again = cli._dial_ensure(port=shim, hub=cli.HUB, pin="yalla",
                                     install=True)
            assert again["how"] == "already", again
            assert "pin_replaced" not in again, \
                "the same pin must not restart the shim"
            assert cli._dial_pid(shim) == pid_before, "no needless restart"
        finally:
            cli._dial_stop(shim, service=False, marker=False)

    def test_the_pin_is_read_out_of_an_argv(self):
        # pure: no process, no port
        assert cli._pin_from_argv(
            ["python", "hivv-cli.py", "dial", "--port", "3911"]) == ""
        assert cli._pin_from_argv(
            ["python", "hivv-cli.py", "dial", "--pin", "yalla"]) == "yalla"
        assert cli._pin_from_argv(
            ["python", "hivv-cli.py", "dial", "--pin=yalla"]) == "yalla"

    def test_spawn_and_stop_roundtrip(self, monkeypatch):
        monkeypatch.setattr(cli, "_dial_install_service",
                            lambda *a, **k: None)
        port = _free_port()
        info = cli._dial_ensure(port=port, install=True)
        try:
            assert info["running"] is True and info["how"] == "spawned"
            assert cli._dial_health(port) is not None
        finally:
            res = cli._dial_stop(port, service=False)
        assert res["running"] is False, "stop must actually kill the shim"
        assert cli._dial_health(port) is None
        assert res["stopped"], "stop should report what it stopped"


# ── 5. migration: HIVV-owned URLs move, user URLs never ──────────────────
class TestMigration:
    def _target(self, tmp_path, existing=None) -> Path:
        t = tmp_path / "opencode.jsonc"
        if existing is not None:
            t.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        return t

    def test_hub_to_shim(self, tmp_path):
        t = self._target(tmp_path, {"providers": {"hivv": {"settings": {
            "baseURL": "https://hivv.org/v1"}}}})
        cfg = cli._opencode_config_for("http://127.0.0.1:3911/v1")
        info = cli._setup_write_config(t, cfg)
        assert info["action"] == "merged"
        assert info["migrated_base_url"] == [
            "https://hivv.org/v1", "http://127.0.0.1:3911/v1"]
        on_disk = json.loads(t.read_text())
        assert on_disk["providers"]["hivv"]["settings"]["baseURL"] ==             "http://127.0.0.1:3911/v1"
        assert info["backup"] and Path(info["backup"]).exists(),             "a migration must leave a backup"

    def test_shim_to_hub_opt_out(self, tmp_path):
        t = self._target(tmp_path, {"providers": {"hivv": {"settings": {
            "baseURL": "http://127.0.0.1:3911/v1"}}}})
        cfg = cli._opencode_config_for(f"{cli.HUB}/v1")
        info = cli._setup_write_config(t, cfg)
        assert info["migrated_base_url"] == [
            "http://127.0.0.1:3911/v1", f"{cli.HUB}/v1"]
        on_disk = json.loads(t.read_text())
        assert on_disk["providers"]["hivv"]["settings"]["baseURL"] ==             f"{cli.HUB}/v1"

    def test_user_proxy_url_is_never_touched(self, tmp_path):
        custom = "https://my-proxy.example/v1"
        t = self._target(tmp_path, {"providers": {"hivv": {"settings": {
            "baseURL": custom}}}})
        cfg = cli._opencode_config_for("http://127.0.0.1:3911/v1")
        info = cli._setup_write_config(t, cfg)
        assert "migrated_base_url" not in info,             "a URL we do not own must never be migrated"
        on_disk = json.loads(t.read_text())
        assert on_disk["providers"]["hivv"]["settings"]["baseURL"] == custom

    def test_identical_config_is_already_up_to_date(self, tmp_path):
        cfg = cli._opencode_config_for("http://127.0.0.1:3911/v1")
        t = self._target(tmp_path, json.loads(json.dumps(cfg)))
        info = cli._setup_write_config(t, cfg)
        assert info["action"] == "already up to date"
        assert info["backup"] is None

    def test_missing_file_is_created(self, tmp_path):
        t = self._target(tmp_path, None)
        cfg = cli._opencode_config_for("http://127.0.0.1:3911/v1")
        info = cli._setup_write_config(t, cfg)
        assert info["action"] == "created"
        assert json.loads(t.read_text())["providers"]["hivv"]["settings"][
            "baseURL"] == "http://127.0.0.1:3911/v1"


# ── 6. service text is pinned without installing anything ────────────────
class TestServiceText:
    def test_systemd_unit_contract(self):
        txt = cli._dial_unit_text(3911, hub="https://hivv.org")
        assert "ExecStart=" in txt
        assert " dial --port 3911" in txt
        assert "--hub https://hivv.org" in txt
        assert "Restart=always" in txt
        assert "StartLimitIntervalSec=300" in txt, "crash-loop bound"
        assert "StartLimitBurst=3" in txt, "crash-loop bound"
        assert "WantedBy=default.target" in txt
        assert "dial.log" in txt

    def test_systemd_unit_carries_pin(self):
        txt = cli._dial_unit_text(4000, pin="masjid")
        assert "--pin masjid" in txt
        assert "--port 4000" in txt

    def test_launchd_plist_contract(self):
        txt = cli._dial_plist_text(3911, hub="https://hivv.org")
        assert "<string>org.hivv.dial</string>" in txt
        assert "<key>RunAtLoad</key>" in txt
        assert "<key>KeepAlive</key>" in txt
        assert "<string>dial</string>" in txt
        assert "<string>--port</string>" in txt
        assert "<string>3911</string>" in txt
        assert "<string>--hub</string>" in txt


# ── 7. model rewrite for direct candidates ───────────────────────────────
class TestFwdPayload:
    RAW = json.dumps({"model": "auto", "messages": []}).encode()
    BODY = {"model": "auto", "messages": []}

    def test_hub_candidate_keeps_the_alias(self):
        out = cli._fwd_payload(self.RAW, dict(self.BODY),
                               {"transport": "hub", "model": "auto"})
        assert out == self.RAW
        assert json.loads(out)["model"] == "auto"

    def test_direct_candidate_gets_the_real_model(self):
        real = "Qwen/Qwen2.5-0.5B-Instruct-GGUF"
        out = cli._fwd_payload(self.RAW, dict(self.BODY),
                               {"transport": "direct", "model": real})
        assert json.loads(out)["model"] == real

    def test_body_dict_is_never_mutated(self):
        body = dict(self.BODY)
        cli._fwd_payload(self.RAW, body,
                         {"transport": "direct", "model": "real-name"})
        assert body["model"] == "auto", "purity: the caller's body survives"

    def test_placeholder_models_stay_verbatim(self):
        for m in ("auto", "local", "pinned", "fast", ""):
            out = cli._fwd_payload(self.RAW, dict(self.BODY),
                                   {"transport": "direct", "model": m})
            assert out == self.RAW, f"placeholder {m!r} must not rewrite"

    def test_already_correct_model_is_verbatim(self):
        body = {"model": "real-name"}
        raw = json.dumps(body).encode()
        out = cli._fwd_payload(raw, body,
                               {"transport": "direct", "model": "real-name"})
        assert out == raw

    def test_missing_model_key_gets_filled(self):
        body = {"messages": []}
        out = cli._fwd_payload(b'{"messages": []}', body,
                               {"transport": "direct", "model": "real-name"})
        assert json.loads(out)["model"] == "real-name"


# ── 8. CLI surface ───────────────────────────────────────────────────────
class TestCliDialStatus:
    def test_status_not_running_exits_1(self):
        p = _run(["dial", "status", "--port", str(_free_port())])
        assert p.returncode == 1, "scripts rely on the exit code"
        assert "NOT running" in p.stdout

    def test_status_running_exits_0(self, shim):
        p = _run(["dial", "status", "--port", str(shim)])
        assert p.returncode == 0
        assert "running on 127.0.0.1" in p.stdout
        assert "candidate(s)" in p.stdout

    def test_help_lists_the_lifecycle_verbs(self):
        p = _run(["dial", "--help"])
        assert p.returncode == 0
        assert "run|on|off|status" in p.stdout


class TestCliSetupJson:
    def test_json_carries_a_dial_block(self):
        p = _run(["setup", "--json"])
        assert p.returncode == 0, p.stderr[-300:]
        d = json.loads(p.stdout)
        assert "dial" in d, "AI consumers need the dial decision in JSON"
        for k in ("enabled", "running", "port", "how", "error", "endpoint"):
            assert k in d["dial"], f"dial.{k} missing"

    def test_off_env_writes_the_hub_endpoint(self):
        p = _run(["setup", "--json"], {"HIVV_DIAL_OFF": "1"})
        d = json.loads(p.stdout)
        assert d["dial"]["enabled"] is False
        assert d["config"]["providers"]["hivv"]["settings"]["baseURL"] ==             f"{cli.HUB}/v1"

    def test_no_shim_flag_writes_the_hub_endpoint(self):
        p = _run(["setup", "--json", "--no-shim"])
        d = json.loads(p.stdout)
        assert d["dial"]["how"] == "disabled"
        assert d["config"]["providers"]["hivv"]["settings"]["baseURL"] ==             f"{cli.HUB}/v1"

    def test_running_shim_gets_the_shim_endpoint(self, shim):
        p = _run(["setup", "--json"], {"HIVV_DIAL_PORT": str(shim)})
        d = json.loads(p.stdout)
        assert d["dial"]["running"] is True
        assert d["dial"]["how"] == "already"
        assert d["config"]["providers"]["hivv"]["settings"]["baseURL"] ==             f"http://127.0.0.1:{shim}/v1"


class TestCliSetupWrite:
    def test_write_migrates_a_hub_config_to_the_running_shim(self, shim,
                                                             tmp_path):
        target = tmp_path / "opencode.jsonc"
        target.write_text(json.dumps({"providers": {"hivv": {"settings": {
            "baseURL": "https://hivv.org/v1"}}}}), encoding="utf-8")
        p = _run(["setup", "--write", str(target), "--json"],
                 {"HIVV_DIAL_PORT": str(shim), "HOME": str(tmp_path)})
        assert p.returncode == 0, p.stderr[-300:]
        d = json.loads(p.stdout)
        assert d["dial"]["running"] is True
        assert d["write"]["action"] == "merged"
        assert d["write"]["migrated_base_url"] == [
            "https://hivv.org/v1", f"http://127.0.0.1:{shim}/v1"]
        on_disk = json.loads(target.read_text())
        assert on_disk["providers"]["hivv"]["settings"]["baseURL"] ==             f"http://127.0.0.1:{shim}/v1"
        assert list(tmp_path.glob("opencode.jsonc.bak-*")), "backup first"

    def test_write_never_installs_a_service_for_a_running_shim(self, shim,
                                                               tmp_path):
        target = tmp_path / "opencode.jsonc"
        p = _run(["setup", "--write", str(target), "--json"],
                 {"HIVV_DIAL_PORT": str(shim), "HOME": str(tmp_path)})
        assert p.returncode == 0, p.stderr[-300:]
        unit = tmp_path / ".config" / "systemd" / "user" / "hivv-dial.service"
        assert not unit.exists(),             "already-running must not install (and HOME is a tmp dir anyway)"

    def test_write_off_env_writes_hub_url(self, tmp_path):
        target = tmp_path / "opencode.jsonc"
        p = _run(["setup", "--write", str(target), "--json"],
                 {"HIVV_DIAL_OFF": "1", "HOME": str(tmp_path)})
        d = json.loads(p.stdout)
        assert d["write"]["action"] == "created"
        on_disk = json.loads(target.read_text())
        assert on_disk["providers"]["hivv"]["settings"]["baseURL"] ==             f"{cli.HUB}/v1"
        unit = tmp_path / ".config" / "systemd" / "user" / "hivv-dial.service"
        assert not unit.exists(), "disabled must never install anything"

    def test_dry_run_writes_nothing(self, tmp_path):
        target = tmp_path / "opencode.jsonc"
        p = _run(["setup", "--write", str(target), "--dry-run", "--json"],
                 {"HIVV_DIAL_OFF": "1", "HOME": str(tmp_path)})
        assert p.returncode == 0, p.stderr[-300:]
        d = json.loads(p.stdout)
        assert d["write"]["action"].startswith("dry run")
        assert not target.exists(), "--dry-run must not write"
        unit = tmp_path / ".config" / "systemd" / "user" / "hivv-dial.service"
        assert not unit.exists(), "--dry-run must not install"


# ── 9. the update nudge: TTY-only discovery for the installed base ───────
class TestP2pNudge:
    """`hivv update` points existing users at the migration door — but only
    on a TTY (the 5-min auto-loop captures output) and only when a config
    still points at a HUB endpoint."""

    def _cfg(self, tmp_path, url) -> Path:
        p = tmp_path / "opencode.jsonc"
        p.write_text(json.dumps({"providers": {"hivv": {"settings": {
            "baseURL": url}}}}), encoding="utf-8")
        return p

    def test_nudges_a_hub_config_on_a_tty(self, monkeypatch, capsys, tmp_path):
        p = self._cfg(tmp_path, f"{cli.HUB}/v1")
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        assert cli._p2p_nudge(paths=[p]) is True
        assert "setup --write" in capsys.readouterr().out

    def test_silent_when_not_a_tty(self, monkeypatch, capsys, tmp_path):
        p = self._cfg(tmp_path, f"{cli.HUB}/v1")
        monkeypatch.setattr(sys.stdout, "isatty", lambda: False)
        assert cli._p2p_nudge(paths=[p]) is False
        assert capsys.readouterr().out == "", "the auto-loop must stay clean"

    def test_silent_when_already_on_the_shim(self, monkeypatch, capsys,
                                             tmp_path):
        p = self._cfg(tmp_path, "http://127.0.0.1:3911/v1")
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        assert cli._p2p_nudge(paths=[p]) is False
        assert capsys.readouterr().out == ""

    def test_silent_for_a_user_proxy(self, monkeypatch, capsys, tmp_path):
        p = self._cfg(tmp_path, "https://my-proxy.example/v1")
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        assert cli._p2p_nudge(paths=[p]) is False
        assert capsys.readouterr().out == ""

    def test_garbage_config_never_raises(self, monkeypatch, capsys, tmp_path):
        p = tmp_path / "opencode.jsonc"
        p.write_text("{not json", encoding="utf-8")
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        assert cli._p2p_nudge(paths=[p]) is False

    def test_missing_file_is_fine(self, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        assert cli._p2p_nudge(paths=[tmp_path / "nope.jsonc"]) is False
