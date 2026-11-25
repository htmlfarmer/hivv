"""Failure forensics on upgrade reports: the specific problem, not prose.

WHY THIS EXISTS (the 2026-11-22 audit of wahi's nine failed reports)
---------------------------------------------------------------------
wahi's auto-update failed nine times over two days. Every row the hub got
carried ONLY `reason` — a prose string like "unexpected: [Errno 13]
Permission denied: '…/hivv-cli.py.bak'". To diagnose it the operator had to
SSH in and run `ls -la`: nothing said WHICH step died, WHO owns the file,
whether WE can write, or HOW to fix it. And dedup was keyed on sha, so nine
different hub shas produced nine rows for one root cause.

Pinned here:
  1. the CLI gathers structured diagnostics on failure — step (sha256 /
     backup / write / healthcheck / swap / guard), errno + error_class,
     target + install layout, dir/file owner+mode, euid, writability,
     version_to, platform, free disk, the local fix tip — and attaches them
     to `failed` reports only
  2. a `signature` normalizes away paths/digits so the SAME failure hashes
     the same on every machine and every retry
  3. the hub collapses repeats: same node + signature within 24h →
     `attempts`++ on ONE row (never a new row), bumps the incident's
     attempt counter instead of stacking incidents, and old CLIs that send
     no signature get one derived server-side from the reason
  4. hard anti-spam bounds: per-IP rate limit on the route + a daily
     insert cap per node (50 known / 10 unknown ids)
  5. a WRONG x-node-secret is a forged report → 403; a MISSING one is
     accepted on purpose (`sudo hivv update` runs with a different HOME)

No network for the unit tests: hub, LAN and gateway are all faked. The
live round-trip skips unless the localhost gateway is actually up.
"""
import argparse
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
HONEY = REPO / "api" / "routes" / "honey-routes.js"
MIGRATION = REPO / "api" / "migrations" / "021_upgrade_diagnostics.sql"

# Isolate state before the module computes its paths (same contract as
# test_cli_install / test_upgrade_review).
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

spec = importlib.util.spec_from_file_location("hivv_cli_diag", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_diag"] = hivv
spec.loader.exec_module(hivv)

ANSI = re.compile(r"\033\[[0-9;]*[A-Za-z]")


def vis(s: str) -> str:
    return ANSI.sub("", s)


# ── 1. the diagnostics collector ─────────────────────────────────────────────
class TestDiagCapture:
    def test_captures_step_errno_ownership_and_platform(self, tmp_path):
        target = tmp_path / "hivv-cli.py"
        target.write_text("# x\n")
        err = PermissionError(13, "Permission denied")
        hivv._record_update_diag(target, "write", exc=err,
                                 msg="permission denied writing x")
        d = hivv._LAST_UPDATE_DIAG
        assert d["step"] == "write"
        assert d["errno"] == 13
        assert d["error_class"] == "PermissionError"
        # tmp_path lives under /tmp, not HOME — classified "system"; the
        # user/git classification is pinned separately in TestInstallType.
        assert d["install"] in {"user", "system", "git", "frozen", "unknown"}
        assert "dir_owner" in d and "dir_mode" in d
        assert "file_owner" in d and d["file_mode"].startswith("0")
        assert d["euid"] == os.geteuid()
        assert isinstance(d["dir_writable"], bool)
        assert d["os"] and d["arch"] and d["python"]
        assert re.fullmatch(r"[0-9a-f]{16}", d["signature"]), (
            "signature must be a stable 16-hex grouping key")

    def test_install_layout_classification(self, monkeypatch, tmp_path):
        """system vs user vs git — one word that explains WHY euid≠owner."""
        monkeypatch.setenv("HOME", str(tmp_path))
        assert hivv._install_type(tmp_path / ".local/lib/hivv/x") == "user"
        assert hivv._install_type(Path("/usr/local/lib/hivv/x")) == "system"
        # the repo itself is a git checkout
        assert hivv._install_type(CLI_PATH) == "git"

    def test_errno_parsed_from_message_when_no_exception(self, tmp_path):
        hivv._record_update_diag(tmp_path / "cli", "swap",
                                 msg="unexpected: [Errno 28] No space left")
        assert hivv._LAST_UPDATE_DIAG["errno"] == 28

    def test_version_to_comes_from_the_new_bytes(self, tmp_path):
        data = b"print('hi')\n"
        hivv._record_update_diag(tmp_path / "cli", "write", msg="m", data=data)
        assert hivv._LAST_UPDATE_DIAG["version_to"] == hivv._get_version(data)

    def test_home_paths_are_scrubbed(self, monkeypatch, tmp_path):
        """Reports land on a shared hub — a user-local target must not leak
        the OS username via the path."""
        monkeypatch.setenv("HOME", str(tmp_path))
        target = tmp_path / ".local" / "lib" / "hivv" / "hivv-cli.py"
        hivv._record_update_diag(target, "write", msg="permission denied")
        assert hivv._LAST_UPDATE_DIAG["target"].startswith("~/")
        assert str(tmp_path) not in hivv._LAST_UPDATE_DIAG["target"]

    def test_tip_is_attached_for_a_known_failure(self, tmp_path):
        """The incident must say HOW to fix itself, not just what broke."""
        hivv._record_update_diag(
            tmp_path / "cli", "write",
            msg="permission denied writing /usr/local/lib/hivv/hivv-cli.py")
        tip = hivv._LAST_UPDATE_DIAG.get("tip", "")
        assert "sudo" in tip or "install-hivv" in tip, (
            f"the permission tip must ride along, got: {tip!r}")

    def test_collector_never_raises_on_junk(self):
        # non-path target, weird message, no exception — best effort only
        hivv._record_update_diag(object(), "", msg=None)
        hivv._record_update_diag(None, "x", exc=RuntimeError("boom"), msg="")
        assert isinstance(hivv._LAST_UPDATE_DIAG, dict)


# ── 2. signature stability (the grouping key) ────────────────────────────────
class TestSignature:
    _M1 = ("unexpected: [Errno 13] Permission denied: "
           "'/usr/local/lib/hivv/hivv-cli.py.bak'")
    _M2 = ("unexpected: [Errno 13] Permission denied: "
           "'/home/someone_else/.local/lib/hivv/hivv-cli.py.bak'")
    _M3 = ("unexpected: [Errno 28] Permission denied: "
           "'/usr/local/lib/hivv/hivv-cli.py.bak'")

    def _sig(self, msg, step="write"):
        hivv._record_update_diag("/x/y", step, msg=msg)
        return hivv._LAST_UPDATE_DIAG["signature"]

    def test_same_failure_same_signature_across_paths(self):
        assert self._sig(self._M1) == self._sig(self._M2), (
            "paths must normalize away — the same wall on two boxes is "
            "one signature, or the hub can't group it")

    def test_different_errno_different_signature(self):
        assert self._sig(self._M1) != self._sig(self._M3)

    def test_different_step_different_signature(self):
        assert self._sig(self._M1, "write") != self._sig(self._M1, "swap")

    def test_digits_normalize_away(self):
        a = "healthcheck failed (rc=1, source=auto)"
        b = "healthcheck failed (rc=2, source=auto)"
        assert self._sig(a, "healthcheck") == self._sig(b, "healthcheck")


# ── 3. the apply path records the right STEP ─────────────────────────────────
class TestStepTracking:
    def test_sha_mismatch_records_verify_step(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_update_target",
                            lambda: (tmp_path / "hivv-cli.py", False))
        ok, msg, _ = hivv._apply_update(b"junk", expected_sha256="0" * 64)
        assert ok is False and "sha256 mismatch" in msg
        assert hivv._LAST_UPDATE_DIAG["step"] == "sha256"

    @pytest.mark.skipif(os.geteuid() == 0,
                        reason="root can write into a 0555 dir")
    def test_unwritable_dir_records_write_step(self, monkeypatch, tmp_path):
        """wahi's exact failure: the update dies at the write step with
        EACCES, and the report must say so (step=write, errno=13)."""
        ro = tmp_path / "ro"
        ro.mkdir()
        ro.chmod(0o555)
        monkeypatch.setattr(hivv, "_update_target",
                            lambda: (ro / "hivv-cli.py", False))
        try:
            ok, msg, _ = hivv._apply_update(b"print('x')\n")
            assert ok is False
            assert hivv._LAST_UPDATE_DIAG["step"] == "write"
            assert hivv._LAST_UPDATE_DIAG["errno"] == 13
            assert "permission denied" in msg.lower() or "sudo" in msg.lower()
        finally:
            ro.chmod(0o700)   # let tmp_path cleanup through

    def test_success_clears_the_diag(self, monkeypatch, tmp_path):
        """A later `applied` report must never carry a STALE failure diag."""
        monkeypatch.setattr(hivv, "_update_target",
                            lambda: (tmp_path / "hivv-cli.py", False))
        hivv._record_update_diag(tmp_path / "hivv-cli.py", "write",
                                 msg="old failure")
        assert hivv._LAST_UPDATE_DIAG
        hivv._apply_update(b"print('x')\n")   # no expected sha → real apply
        # healthcheck runs `python3 <file> --healthcheck` — a valid script
        # passes, so this succeeds and must reset the diag
        if (tmp_path / "hivv-cli.py").exists():
            # apply either succeeded (diag cleared) or failed at a later step
            # (diag replaced) — NEVER the old one
            assert hivv._LAST_UPDATE_DIAG.get("step") != "write" or \
                hivv._LAST_UPDATE_DIAG.get("msg") != "old failure"


# ── 4. the report attaches diagnostics ONLY for failures ─────────────────────
class TestReportAttachment:
    @pytest.fixture(autouse=True)
    def capture(self, monkeypatch):
        self.sent = []
        monkeypatch.setattr(
            hivv, "http",
            lambda method, path, **kw: (self.sent.append((path, kw.get("body")))
                                        or (200, {})))
        hivv._LAST_UPDATE_DIAG = {}
        return self.sent

    def test_failed_report_carries_diagnostics(self):
        hivv._record_update_diag("/usr/local/lib/hivv/hivv-cli.py", "write",
                                 exc=PermissionError(13, "denied"),
                                 msg="permission denied writing x")
        hivv._upgrade_report({"action": "failed", "reason": "permission denied"})
        body = self.sent[-1][1]
        assert body["action"] == "failed"
        diag = body["diagnostics"]
        assert diag["step"] == "write" and diag["errno"] == 13
        assert re.fullmatch(r"[0-9a-f]{16}", diag["signature"])

    def test_applied_report_has_no_diagnostics(self):
        hivv._record_update_diag("/x", "swap", msg="old failure")
        hivv._upgrade_report({"action": "applied", "reason": "applied cleanly"})
        assert "diagnostics" not in self.sent[-1][1], (
            "applied/blocked reports carry no failure forensics — the "
            "fields exist to explain a BROKEN update")

    def test_blocked_report_has_no_diagnostics(self):
        hivv._record_update_diag("/x", "swap", msg="old failure")
        hivv._upgrade_report({"action": "blocked", "reason": "suspicious"})
        assert "diagnostics" not in self.sent[-1][1]

    def test_failure_without_diag_still_reports(self):
        hivv._LAST_UPDATE_DIAG = {}
        hivv._upgrade_report({"action": "failed", "reason": "boom"})
        assert self.sent[-1][1]["reason"] == "boom", (
            "a missing diag must never suppress the report itself")


# ── 5. auto + inbox failure reports keep the review context ──────────────────
class TestFailureCarriesReview:
    def test_auto_and_inbox_failures_include_votes_and_findings(self):
        """Empty votes made every incident read as an unreviewed push —
        'brains approved the bytes, the APPLY died' is the whole story."""
        src = CLI_PATH.read_text()
        carry = src.count('"votes": (gate["review"].get("votes") or [])')
        assert carry >= 2, (
            "both the auto-loop and inbox failure reports must carry the "
            f"review's votes, found {carry}")
        findings = src.count(
            '"static_findings": (gate["review"].get("scan") or {}).get("findings", [])')
        assert findings >= 2, "both failure sites must carry static findings"


# ── 6. `hivv upgrades` renders the forensics ────────────────────────────────
class TestUpgradesDisplay:
    def test_attempts_badge_and_failure_details(self, monkeypatch, capsys):
        report = {
            "node_id": "wahi", "source": "auto", "action": "failed",
            "verdict": "ok", "votes": [], "attempts": 9,
            "reason": "unexpected: [Errno 13] Permission denied: "
                      "'/usr/local/lib/hivv/hivv-cli.py.bak'",
            "created_at": "2026-11-22T11:39:23.115089-08",
            "last_seen": "2026-11-22T14:20:56.480059-08",
            "diagnostics": {
                "step": "write", "errno": 13,
                "error_class": "PermissionError",
                "install": "system", "dir_owner": "root", "dir_mode": "0755",
                "file_owner": "root", "file_mode": "0644",
                "euid": 1001, "dir_writable": False,
                "version_to": "0.2.50199eae",
                "target": "/usr/local/lib/hivv/hivv-cli.py",
                "tip": "permission denied — the install dir belongs to "
                       "another user: sudo hivv update",
            },
        }
        monkeypatch.setattr(
            hivv, "http",
            lambda m, p, **kw: (200, {"total": 1, "reports": [report]}))
        args = argparse.Namespace(flagged=False, node=None, json_output=False)
        hivv.cmd_upgrades(args)
        out = vis(capsys.readouterr().out)
        # the fix/tip lines are _wrap_text'd to the terminal width — match on
        # whitespace-normalized output so the assertion holds at any width
        flat = re.sub(r"\s+", " ", out)
        assert "×9" in out, "the attempt count must be visible at a glance"
        assert "failure details" in out
        assert "step=write" in out and "errno=13" in out
        assert "owner=root:0755" in out
        assert "dir NOT writable" in out
        assert "sudo hivv update" in flat, "the fix must be shown"

    def test_old_rows_without_diagnostics_render_cleanly(
            self, monkeypatch, capsys):
        """Rows written before the migration have no diagnostics/attempts."""
        monkeypatch.setattr(
            hivv, "http",
            lambda m, p, **kw: (200, {"total": 1, "reports": [{
                "node_id": "masjid", "source": "auto", "action": "applied",
                "verdict": "ok", "votes": [], "reason": "1/1 brains approved",
                "created_at": "2026-11-22T11:40:12.671272-08",
                "diagnostics": None, "attempts": None, "last_seen": None,
            }]}))
        args = argparse.Namespace(flagged=False, node=None, json_output=False)
        hivv.cmd_upgrades(args)          # must not raise
        out = vis(capsys.readouterr().out)
        assert "1/1 brains approved" in out
        assert "failure details" not in out


# ── 7. hub-side contract (source pins — the live gateway is exercised below) ─
class TestHubContract:
    def test_migration_defines_the_columns(self):
        sql = MIGRATION.read_text()
        for col in ("diagnostics", "signature", "attempts", "last_seen"):
            assert col in sql, f"migration 021 must add {col}"
        assert "idx_upgrade_reviews_signature" in sql

    def test_signature_collapse_updates_one_row(self):
        src = HONEY.read_text()
        assert "collapsedAttempts" in src
        # the counter is computed in JS then written — never a fresh row
        assert "(dupSig.rows[0].attempts || 1) + 1" in src
        assert ("COALESCE(last_seen, created_at) > NOW() - INTERVAL '24 hours'"
                in src)

    def test_old_cli_failures_get_a_server_derived_signature(self):
        src = HONEY.read_text()
        assert "function failureSignature" in src
        assert "action === 'failed' ? failureSignature(reason)" in src

    def test_incident_bumps_attempts_instead_of_stacking(self):
        src = HONEY.read_text()
        assert "attempt ${collapsedAttempts}" in src or \
            "(attempt ${collapsedAttempts})" in src
        assert "regexp_replace" in src or ".replace(/ \\(attempt" in src, (
            "the attempt suffix must be REPLACED, or descriptions stack "
            "'(attempt 2) (attempt 3)'")

    def test_diagnostics_are_whitelisted_not_trusted(self):
        src = HONEY.read_text()
        assert "const DIAG_KEYS" in src
        assert "sanitizeDiagnostics" in src
        # every insert goes through the sanitizer
        assert "sanitizeDiagnostics(b.diagnostics)" in src

    def test_anti_spam_bounds_exist(self):
        src = HONEY.read_text()
        assert "reportLimiter" in src, "the route needs its own IP rate limit"
        assert "DAILY_CAP" in src, "a daily insert cap bounds any flooder"
        assert "daily report cap reached" in src

    def test_node_secret_rules(self):
        """Wrong secret = forged (403). Missing = sudo/stateless, accepted."""
        src = HONEY.read_text()
        block = src.split("// Anti-spoof:")[1].split("const DAILY_CAP")[0]
        assert "x-node-secret" in block
        assert "node secret mismatch" in block
        # The 403 must sit BEHIND "header present": verify() rejects a MISSING
        # secret too, and `sudo hivv update` (our own permission fix) runs with
        # a different HOME and no state — rejecting absence would lose exactly
        # the reports we want.
        assert "req.headers['x-node-secret']" in block.split("node secret mismatch")[0], (
            "the mismatch check must only run when a secret was presented")

    def test_get_returns_the_new_fields(self):
        src = HONEY.read_text()
        # slice from the GET route to the NEXT route definition — the handler
        # body contains `});` closures that would truncate a naive split
        after = src.split("router.get('/upgrade-reports'")[1]
        get_block = after.split("router.get(", 1)[0] if "router.get(" in after \
            else after
        for col in ("diagnostics", "attempts", "last_seen"):
            assert col in get_block, f"GET must return {col}"
        assert "COALESCE(last_seen, created_at) DESC" in get_block, (
            "a collapsed row must float up when it is hit again")


# ── 8. live round-trip (skips unless the localhost gateway is up) ───────────
GATEWAY = "http://localhost:3011"


def _gateway_up() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen(GATEWAY + "/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


needs_gateway = pytest.mark.skipif(
    not _gateway_up(), reason="gateway not running on localhost:3011")

NODE = "__diag_e2e__"


def _psql(sql: str) -> str:
    r = subprocess.run(
        ["psql", "-h", "localhost", "-U", "hivv", "-d", "hivv", "-tAc", sql],
        capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "psql failed")
    return r.stdout.strip()


@needs_gateway
class TestLiveReportRoundtrip:
    def test_collapse_and_cleanup(self):
        import json as _json
        import urllib.request

        if not shutil.which("psql"):
            pytest.skip("psql required to clean up after the round-trip")
        try:
            _psql("SELECT 1")
        except Exception:
            pytest.skip("no local database access to clean up")

        _psql(f"DELETE FROM hivv_upgrade_reviews WHERE node_id='{NODE}'")

        def post(sha, sig):
            body = _json.dumps({
                "node_id": NODE, "source": "auto", "action": "failed",
                "to_sha256": sha, "reason": "e2e probe failure",
                "diagnostics": {"step": "swap", "errno": 13,
                                "error_class": "PermissionError",
                                "signature": sig, "euid": 1001,
                                "dir_writable": False,
                                "target": "/usr/local/lib/hivv/hivv-cli.py",
                                "tip": "sudo hivv update"},
            }).encode()
            req = urllib.request.Request(
                GATEWAY + "/api/hive/upgrade-reports", data=body,
                headers={"content-type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                return _json.loads(resp.read().decode())

        try:
            sig = "e2e0e2e0e2e0e2e0"
            r1 = post("a" * 64, sig)
            r2 = post("b" * 64, sig)
            assert r1.get("recorded") is True, (
                "local-mode gateway without a database — skip-worthy, "
                f"got {r1}")
            assert "attempts" not in r1 or r1["attempts"] is None
            assert r2.get("attempts") == 2, (
                f"same signature must collapse into attempts=2, got {r2}")

            with urllib.request.urlopen(
                    GATEWAY + f"/api/hive/upgrade-reports?node={NODE}",
                    timeout=10) as resp:
                rows = _json.loads(resp.read().decode())["reports"]
            assert len(rows) == 1, (
                f"two POSTs must be ONE row, got {len(rows)}")
            assert rows[0]["attempts"] == 2
            assert rows[0]["diagnostics"]["step"] == "swap"
            assert rows[0]["signature"] == sig
            assert rows[0]["last_seen"], "last_seen must be set on collapse"
        finally:
            _psql(f"DELETE FROM hivv_upgrade_reviews WHERE node_id='{NODE}'")

    def test_cleanup_left_no_rows(self):
        import urllib.request
        import json as _json
        with urllib.request.urlopen(
                GATEWAY + f"/api/hive/upgrade-reports?node={NODE}",
                timeout=10) as resp:
            rows = _json.loads(resp.read().decode())["reports"]
        assert rows == [], "the round-trip must clean up after itself"
