"""`hivv nodes` must survive a DEAD HUB, and the gateway must fail FAST.

WHY THESE EXIST (the 2026-11-22 outage)
----------------------------------------
The hub's pg pool wedged at 00:00:38 — zero sockets to Postgres, waiters
queued forever. Every DB-backed route hung for 10 hours, *including
/api/health*, so no monitor could even see the outage while pm2 reported
the process "online". On top of that, `hivv nodes` was pure hub-dependent:
with hivv.org unreachable the command died with "failed to fetch nodes"
even though every bee on the local network was healthy the whole time.

Pinned here:
  1. the roster ladder — hub → local gateway → on-disk snapshot, with the
     snapshot's statuses re-derived by a LIVE LAN probe (a cached
     "online" from yesterday is a lie; a port that answers NOW is not)
  2. only UNPROBEABLE bees keep their cached status — firewalled peers
     must not all flip to red just because this machine can't reach them
  3. the gateway's pool timeouts + the health endpoint's 3s race, so a
     wedged pool becomes a fast 503 instead of an invisible hang
  4. the watchdog's failure detection — including the `|| echo 000`
     trap where curl's own "000" plus echo's "000" made a dead gateway
     read as healthy

No network: the hub, the LAN probes and the gateway are all faked.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
SERVER_JS = REPO / "api" / "server.js"
WATCHDOG = REPO / "scripts" / "health-watchdog.sh"

# Isolate EVERY state write (nodes-cache.json lives in STATE_DIR) before the
# module computes its paths — same contract as test_upgrade_review.py.
_PRE_STATE = os.environ.get("HIVV_STATE_DIR")
os.environ["HIVV_STATE_DIR"] = tempfile.mkdtemp(prefix="hivv-test-state-")


@pytest.fixture(scope="module", autouse=True)
def _restore_state_after_this_module():
    """Give the env back after this module's tests — a module-level write
    leaks into every test running later (full suite red, 2026-11-24)."""
    yield
    if _PRE_STATE is None:
        os.environ.pop("HIVV_STATE_DIR", None)
    else:
        os.environ["HIVV_STATE_DIR"] = _PRE_STATE

spec = importlib.util.spec_from_file_location("hivv_cli_offline", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_offline"] = hivv
spec.loader.exec_module(hivv)

ANSI = re.compile(r"\033\[[0-9;]*[A-Za-z]")


def vis(s: str) -> str:
    return ANSI.sub("", s)


def node(nid="bee", status="online", ip="192.0.2.10", port=8080, models=1):
    """A roster entry. 192.0.2.x is TEST-NET-1 (RFC 5737): guaranteed
    non-routable, so even an accidental real probe can't leave the box."""
    return {
        "id": nid, "name": nid, "status": status, "lan_ip": ip, "ip": ip,
        "version": "0.2.abc12345",
        "local_models": [{"port": port, "model": f"{nid}-model"}] * models,
        "last_heartbeat": 1790000000000,
    }


def payload(nodes, **extra):
    return {"nodes": nodes, "total": len(nodes),
            "online": sum(1 for n in nodes if n["status"] != "offline"),
            **extra}


# ── 1. snapshot persistence ─────────────────────────────────────────────────
class TestSnapshotIO:
    def test_roundtrip(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "nodes-cache.json")
        hivv._save_nodes_cache(payload([node()]))
        got = hivv._load_nodes_cache()
        assert got is not None
        assert got["payload"]["nodes"][0]["id"] == "bee"
        assert got["saved_at"] > 0

    def test_missing_file_is_none_not_crash(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "nope.json")
        assert hivv._load_nodes_cache() is None

    def test_corrupt_file_is_none_not_crash(self, monkeypatch, tmp_path):
        f = tmp_path / "nodes-cache.json"
        f.write_text("{not json at all")
        monkeypatch.setattr(hivv, "NODES_CACHE", f)
        assert hivv._load_nodes_cache() is None

    def test_wrong_shape_is_none(self, monkeypatch, tmp_path):
        f = tmp_path / "nodes-cache.json"
        f.write_text(json.dumps({"saved_at": 1, "payload": "a string"}))
        monkeypatch.setattr(hivv, "NODES_CACHE", f)
        assert hivv._load_nodes_cache() is None

    def test_unwritable_state_dir_never_raises(self, monkeypatch, tmp_path):
        """A read-only STATE_DIR must not break `hivv nodes` — the cache is
        best-effort; the roster itself is what matters."""
        ro = tmp_path / "ro"
        ro.mkdir()
        ro.chmod(0o500)
        monkeypatch.setattr(hivv, "NODES_CACHE", ro / "nodes-cache.json")
        try:
            hivv._save_nodes_cache(payload([node()]))   # must not raise
        finally:
            ro.chmod(0o700)                              # let tmp_path clean up

    def test_atomic_write_leaves_no_tmp_behind(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "nodes-cache.json")
        hivv._save_nodes_cache(payload([node()]))
        assert not list(tmp_path.glob("*.tmp"))


# ── 2. live status re-derivation ────────────────────────────────────────────
class TestRederiveLanStatus:
    def test_probeable_bee_is_marked_online_when_port_answers(
            self, monkeypatch):
        monkeypatch.setattr(hivv, "_measure_pings", lambda n, budget=0.7: {"a": 12})
        p = payload([node("a")])
        hivv._rederive_lan_status(p)
        assert p["nodes"][0]["status"] == "online"
        assert p["_pings"] == {"a": 12}

    def test_probeable_bee_is_marked_offline_when_nothing_answers(
            self, monkeypatch):
        monkeypatch.setattr(hivv, "_measure_pings", lambda n, budget=0.7: {})
        p = payload([node("a", status="online")])
        hivv._rederive_lan_status(p)
        assert p["nodes"][0]["status"] == "offline", (
            "a bee whose ports answer NOTHING from here is offline, "
            "whatever yesterday's snapshot claimed")

    def test_unprobeable_bee_keeps_its_cached_status(self, monkeypatch):
        """No IP / no port ⇒ we cannot probe ⇒ we must NOT guess.

        Flipping these to offline would paint every firewalled peer (and
        every bee on a different LAN) red in the offline view."""
        monkeypatch.setattr(hivv, "_measure_pings", lambda n, budget=0.7: {})
        p = payload([node("nof ip", status="online", ip="", port=0),
                     node("noport", status="quarantined", port=0)])
        hivv._rederive_lan_status(p)
        assert p["nodes"][0]["status"] == "online"
        assert p["nodes"][1]["status"] == "quarantined"

    def test_totals_are_recounted_from_the_probe(self, monkeypatch):
        monkeypatch.setattr(hivv, "_measure_pings",
                            lambda n, budget=0.7: {"up": 5})
        p = payload([node("up"), node("down", status="online")])
        hivv._rederive_lan_status(p)
        assert p["online"] == 1 and p["total"] == 2

    def test_none_and_junk_nodes_do_not_crash(self, monkeypatch):
        monkeypatch.setattr(hivv, "_measure_pings", lambda n, budget=0.7: {})
        p = {"nodes": [None, 7, {}, node("ok")], "total": 4, "online": 4}
        hivv._rederive_lan_status(p)          # must not raise
        assert p["total"] == 4


# ── 3. the ladder: hub → local gateway → snapshot ───────────────────────────
class TestFetchLadder:
    @pytest.fixture(autouse=True)
    def _isolated_snapshot(self, tmp_path, monkeypatch):
        """Every ladder test gets its OWN snapshot file AND a pinned hub.

        Without the snapshot isolation a local-leg save in one test becomes
        a cache HIT in the next and `test_everything_down` silently passes
        the ladder it should fail. HUB is pinned because other test files
        set HIVV_HUB=http://127.0.0.1:1 at import (dead-port fast-fail),
        which would trip the "HUB is already local ⇒ skip the local leg"
        guard and make these tests order-dependent."""
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "nodes-cache.json")
        monkeypatch.setattr(hivv, "HUB", "https://hivv.org")

    @staticmethod
    def _fake_http(monkeypatch, *, hub, local=None):
        """Route by base_url: hub calls get `hub`, localhost calls `local`."""
        calls = []

        def fake(method, path, *, base_url=None, **kw):
            calls.append((method, path, base_url))
            if base_url and "127.0.0.1" in base_url:
                if local is None:
                    return 0, "network error: refused"
                return local(method, path)
            return hub(method, path)

        monkeypatch.setattr(hivv, "http", fake)
        return calls

    def test_hub_up_serves_roster_and_refreshes_snapshot(
            self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "n.json")
        good = payload([node("a")])
        self._fake_http(monkeypatch, hub=lambda m, p: (200, good))
        code, out, source = hivv._fetch_nodes()
        assert (code, source) == (200, "hub")
        assert out["nodes"][0]["id"] == "a"
        assert "_fallback" not in out
        assert hivv._load_nodes_cache() is not None, (
            "a successful fetch MUST seed the snapshot, or the offline "
            "fallback has nothing to fall back to")

    def test_hub_down_falls_back_to_local_gateway(self, monkeypatch):
        local_payload = payload([node("local-bee")])
        self._fake_http(
            monkeypatch,
            hub=lambda m, p: (0, "network error: timed out"),
            local=lambda m, p: (200, local_payload) if m == "GET" else (404, {}))
        code, out, source = hivv._fetch_nodes()
        assert (code, source) == (200, "local")
        assert out["nodes"][0]["id"] == "local-bee"
        assert out["_fallback"]["source"] == "local"
        assert "timed out" in out["_fallback"]["hub_error"]

    def test_hub_and_local_down_use_the_snapshot(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "n.json")
        hivv._save_nodes_cache(payload([node("cached")]))
        monkeypatch.setattr(hivv, "_measure_pings", lambda n, budget=0.7: {"cached": 9})
        self._fake_http(monkeypatch,
                        hub=lambda m, p: (0, "network error: refused"))
        code, out, source = hivv._fetch_nodes()
        assert (code, source) == (200, "cache")
        assert out["nodes"][0]["id"] == "cached"
        assert out["nodes"][0]["status"] == "online"   # re-probed, not stale
        assert out["_fallback"]["source"] == "cache"
        assert out["_fallback"]["saved_at"] > 0

    def test_everything_down_returns_the_original_hub_error(
            self, monkeypatch):
        self._fake_http(monkeypatch,
                        hub=lambda m, p: (0, "network error: refused"))
        code, out, source = hivv._fetch_nodes()
        assert code == 0 and source == "hub"
        assert "network error" in str(out)

    def test_localhost_hub_does_not_ping_itself_twice(self, monkeypatch):
        """HIVV_HUB=http://127.0.0.1:3011 → the local leg IS the hub leg;
        a second probe of the same box just burns 3s for nothing."""
        monkeypatch.setattr(hivv, "HUB", "http://127.0.0.1:3011")
        calls = self._fake_http(
            monkeypatch, hub=lambda m, p: (0, "network error: refused"))
        hivv._fetch_nodes()
        local_calls = [c for c in calls if c[2] and "127.0.0.1" in c[2]]
        assert local_calls == []

    def test_local_leg_never_masks_the_snapshot_with_an_empty_roster(
            self, monkeypatch, tmp_path):
        """A local gateway that knows NO bees must not hide a snapshot
        that does — empty local answer ⇒ keep walking the ladder."""
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "n.json")
        hivv._save_nodes_cache(payload([node("cached")]))
        monkeypatch.setattr(hivv, "_measure_pings", lambda n, budget=0.7: {})
        self._fake_http(
            monkeypatch,
            hub=lambda m, p: (0, "network error: refused"),
            local=lambda m, p: (200, {"nodes": [], "total": 0, "online": 0}))
        code, out, source = hivv._fetch_nodes()
        assert source == "cache"
        assert out["nodes"][0]["id"] == "cached"


# ── 4. the banner ───────────────────────────────────────────────────────────
class TestOfflineBanner:
    def test_hub_fed_payload_has_no_banner(self):
        assert hivv._offline_banner(payload([node()])) == []

    def test_cache_banner_explains_which_columns_are_live(self):
        lines = hivv._offline_banner(
            {"_fallback": {"source": "cache", "hub_error": "boom",
                           "saved_at": 1790000000}})
        assert any("LIVE probe" in ln for ln in lines)
        assert any("snapshot" in ln for ln in lines)
        assert any("boom" in ln for ln in lines)

    def test_cache_banner_formats_age(self):
        import time as _t
        fresh = {"_fallback": {"source": "cache", "hub_error": "x",
                               "saved_at": _t.time() - 120}}
        assert any("2m ago" in ln for ln in hivv._offline_banner(fresh))

    def test_local_banner_names_the_local_gateway(self):
        lines = hivv._offline_banner(
            {"_fallback": {"source": "local", "hub_error": "cdn down"}})
        assert any("127.0.0.1:3011" in ln for ln in lines)

    def test_banner_wraps_instead_of_overflowing(self):
        """cmd_nodes wraps every banner line to the terminal (that's where
        `_wrap_text` is applied) — pin that the wrap actually fits.

        The injected error is a realistic network message (spaces inside);
        `_wrap_text`'s contract is to never chop a long WORD, so a single
        300-char token would be passed through by design."""
        lines = hivv._offline_banner(
            {"_fallback": {"source": "cache",
                           "hub_error": "network error: " + "timed out " * 40,
                           "saved_at": 1}})
        for ln in lines:
            for chunk in hivv._wrap_text(ln, 80):
                assert len(chunk) <= 80


# ── 5. cmd_nodes end-to-end ─────────────────────────────────────────────────
class TestCmdNodesOffline:
    @pytest.fixture(autouse=True)
    def _isolated_snapshot(self, tmp_path, monkeypatch):
        """Fresh snapshot per test — a cache written by one case must not
        turn the next case's "total failure" into an accidental cache hit.
        HUB is pinned too: other files set HIVV_HUB=http://127.0.0.1:1 at
        import, which would skip the local leg and change the fallback path."""
        monkeypatch.setattr(hivv, "NODES_CACHE", tmp_path / "nodes-cache.json")
        monkeypatch.setattr(hivv, "HUB", "https://hivv.org")

    @staticmethod
    def _run(monkeypatch, capsys, *, hub, cache=None, probes=None,
             json_output=False):
        if cache is not None:
            hivv._save_nodes_cache(cache)
        monkeypatch.setattr(hivv, "_measure_pings",
                            (lambda n, budget=0.7: probes) if probes is not None
                            else (lambda n, budget=0.7: {}))
        monkeypatch.setattr(hivv, "http",
                            lambda m, p, **kw: hub(m, p, **kw))
        args = type("A", (), {"json_output": json_output})()
        code = 0
        try:
            hivv.cmd_nodes(args)
        except SystemExit as e:
            code = e.code or 0
        return code, capsys.readouterr().out

    def test_cache_view_renders_table_and_banner(self, monkeypatch, capsys):
        cached = payload([node("yalla", status="online"),
                          node("masjid", status="offline")])
        code, out = self._run(
            monkeypatch, capsys,
            hub=lambda m, p, **kw: (0, "network error: timed out"),
            cache=cached, probes={"yalla": 7})
        assert code == 0, "the LAN view must SUCCEED when the hub is down"
        text = vis(out)
        assert "yalla" in text and "masjid" in text
        assert "offline LAN view" in text
        # live probe wins over the snapshot: yalla answers, masjid doesn't
        rows = [ln for ln in text.splitlines() if ln.strip().startswith("yalla")]
        assert rows and "online" in rows[0]
        rows = [ln for ln in text.splitlines() if ln.strip().startswith("masjid")]
        assert rows and "offline" in rows[0]

    def test_json_mode_carries_the_fallback_marker(self, monkeypatch, capsys):
        cached = payload([node("yalla")])
        code, out = self._run(
            monkeypatch, capsys,
            hub=lambda m, p, **kw: (0, "network error: refused"),
            cache=cached, json_output=True)
        assert code == 0
        d = json.loads(out)
        assert d["_fallback"]["source"] == "cache"
        assert d["nodes"][0]["id"] == "yalla"

    def test_json_mode_still_fails_loudly_without_any_fallback(
            self, monkeypatch, capsys):
        code, out = self._run(
            monkeypatch, capsys,
            hub=lambda m, p, **kw: (0, "network error: refused"))
        assert code == 2

    def test_human_mode_without_any_fallback_how_to_seed(
            self, monkeypatch, capsys):
        code, out = self._run(
            monkeypatch, capsys,
            hub=lambda m, p, **kw: (0, "network error: refused"))
        assert code == 2
        text = vis(out)
        assert "failed to fetch nodes" in text
        assert "seed the LAN fallback" in text, (
            "a total failure must teach the user how to never see it again")

    def test_hub_up_path_is_unchanged(self, monkeypatch, capsys):
        good = payload([node("yalla")])
        code, out = self._run(
            monkeypatch, capsys,
            hub=lambda m, p, **kw: (200, good) if m == "GET"
            and p == "/api/control/nodes" else (404, {}))
        assert code == 0
        text = vis(out)
        assert "yalla" in text
        assert "offline LAN view" not in text
        assert "hub unreachable" not in text

    def test_empty_snapshot_says_so_not_no_agents(
            self, monkeypatch, capsys):
        code, out = self._run(
            monkeypatch, capsys,
            hub=lambda m, p, **kw: (0, "network error: refused"),
            cache={"nodes": [], "total": 0, "online": 0})
        assert code == 0
        assert "snapshot is empty" in vis(out)


# ── 6. the probe-target extractor ───────────────────────────────────────────
class TestProbeTargets:
    def test_collects_tools_and_model_ports(self):
        ips, ports = hivv._probe_targets(
            {"lan_ip": "10.0.0.2", "tools_port": 18789,
             "local_models": [{"port": 8080}, {"port": 8090}]})
        assert ips == ["10.0.0.2"]
        assert ports == [18789, 8080, 8090]

    def test_dedupes_ports_and_ips(self):
        ips, ports = hivv._probe_targets(
            {"lan_ip": "10.0.0.2", "ip": "10.0.0.2",
             "local_models": [{"port": 8080}, {"port": 8080}]})
        assert ips == ["10.0.0.2"] and ports == [8080]

    def test_junk_values_are_skipped(self):
        ips, ports = hivv._probe_targets(
            {"lan_ip": "?", "ip": "", "tools_port": "not-a-port",
             "local_models": [{"port": None}, "not-a-dict"]})
        assert ips == [] and ports == []

    def test_no_targets_means_no_probe(self):
        assert hivv._probe_targets({}) == ([], [])


# ── 7. gateway fail-fast pins (server.js) ───────────────────────────────────
class TestGatewayFailFast:
    src = SERVER_JS.read_text()

    def test_pool_acquires_have_a_deadline(self):
        """Without connectionTimeoutMillis pg-pool queues waiters FOREVER —
        that is exactly what turned a wedged pool into a 10h outage."""
        assert "connectionTimeoutMillis" in self.src
        m = re.search(r"connectionTimeoutMillis:\s*parseInt\(process\.env\.DB_CONNECT_TIMEOUT\)\s*\|\|\s*(\d+)",
                      self.src)
        assert m, "pool must set connectionTimeoutMillis with a sane default"
        assert 1000 <= int(m.group(1)) <= 30000

    def test_server_side_statement_timeout(self):
        """Queries stuck MID-Flight get killed by Postgres itself."""
        m = re.search(r"statement_timeout:\s*parseInt\(process\.env\.DB_STATEMENT_TIMEOUT\)\s*\|\|\s*(\d+)",
                      self.src)
        assert m, "pool must set statement_timeout"
        assert 1000 <= int(m.group(1)) <= 60000

    def test_health_endpoint_races_a_hard_deadline(self):
        """/api/health must answer even when the pool is wedged — a hung
        health endpoint is invisible to every external monitor."""
        body = self.src.split("app.get('/api/health'")[1].split("\n});")[0]
        assert "Promise.race" in body, "health must race the DB probe"
        assert "3000" in body, "the race needs a hard 3s deadline"
        assert "unref" in body, "the timer must not hold the process open"


# ── 8. watchdog pins (scripts/health-watchdog.sh) ───────────────────────────
class TestWatchdog:
    src = WATCHDOG.read_text()

    def test_script_is_executable(self):
        assert os.access(WATCHDOG, os.X_OK), "cron runs it directly"

    def test_curl_failure_never_reads_as_healthy(self):
        """THE trap: curl prints 000 from -w even on failure, so `|| echo 000`
        appends a SECOND line → code="000\\n000" ≠ "000" → a dead gateway
        was classified healthy. Pinned so it can never come back.

        Comments are stripped first: the script's own docstring documents
        this exact trap and would otherwise match the literal."""
        code_lines = [ln for ln in self.src.splitlines()
                      if not ln.lstrip().startswith("#")]
        code = "\n".join(code_lines)
        assert "|| echo 000" not in code
        assert "|| code=000" in code

    def test_two_strikes_before_restart(self):
        m = re.search(r'FAIL_THRESHOLD="\$\{HIVV_HEALTH_FAILS:-(-?\d+)\}"', self.src)
        assert m and int(m.group(1)) >= 2, (
            "one failed probe must never restart anything — a blip is not "
            "an outage")

    def test_restart_cooldown_exists(self):
        assert re.search(r"COOLDOWN_S=\d+", self.src), (
            "restarting every minute while POSTGRES is down is thrash, "
            "not remediation")

    def test_restarts_the_gateway_via_pm2(self):
        assert "pm2" in self.src and "hivv-ai-gateway" in self.src

    def test_dead_endpoint_is_detected_live(self):
        """Functional: two ticks against a closed port must log a restart."""
        # A pm2 shim WE create — /bin/true on the macOS runner somehow
        # failed the script's -x re-validation, PM2_BIN re-resolved to
        # empty, and the run logged "pm2 not found" instead of restarting
        # (CI, 2026-11-23). A shim in our own tmp dir is executable by
        # construction on every OS.
        state = tempfile.mkdtemp(prefix="hivv-wd-")
        shim = Path(state) / "pm2-shim"
        shim.write_text("#!/bin/sh\nexit 0\n")
        shim.chmod(0o755)
        env = {**os.environ,
               "HIVV_HEALTH_URL": "http://127.0.0.1:59999/api/health",
               "HIVV_HEALTH_TIMEOUT": "2",
               "HIVV_HEALTH_FAILS": "2",
               "HIVV_WATCHDOG_STATE": state,
               "PM2_BIN": str(shim)}
        for _ in range(2):
            subprocess.run(["bash", str(WATCHDOG)], env=env,
                           timeout=30, capture_output=True)
        log = Path(env["HIVV_WATCHDOG_STATE"]) / "health-watchdog.log"
        assert "restarting hivv-ai-gateway" in log.read_text()

    def test_one_blip_never_restarts(self):
        """fail → recover: counter clears, no restart line ever appears.

        The 'alive' leg serves ITS OWN health endpoint on an ephemeral
        port. Pointing it at the real gateway (:3011) made this pass on a
        dev box and FAIL in CI, where no gateway runs — the 'recovery'
        tick failed too, crossed the threshold, and logged a restart
        (2026-11-22). A blip test must control BOTH halves of the blip."""
        import http.server
        import threading

        class _HealthHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"status":"healthy"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_a):   # keep pytest output clean
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _HealthHandler)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            state = tempfile.mkdtemp(prefix="hivv-wd-")
            dead = {**os.environ,
                    "HIVV_HEALTH_URL": "http://127.0.0.1:59999/api/health",
                    "HIVV_HEALTH_TIMEOUT": "2", "HIVV_WATCHDOG_STATE": state,
                    "PM2_BIN": "/bin/true"}
            alive = {**dead,
                     "HIVV_HEALTH_URL": f"http://127.0.0.1:{port}/api/health"}
            subprocess.run(["bash", str(WATCHDOG)], env=dead,
                           timeout=30, capture_output=True)
            subprocess.run(["bash", str(WATCHDOG)], env=alive,
                           timeout=30, capture_output=True)
            log_text = (Path(state) / "health-watchdog.log").read_text()
            assert "recovered after 1" in log_text
            assert "restarting" not in log_text
        finally:
            srv.shutdown()
            srv.server_close()
        assert not (Path(state) / ".health-watchdog-fails").exists()
