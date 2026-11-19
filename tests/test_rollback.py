"""Tests for `hivv rollback` and the known-good version pin.

WHY THIS EXISTS
The update path already refuses a broken new copy: it healthchecks the
.new file BEFORE swapping, and restores .bak if that fails. That protects
the MOMENT of the update. But a copy can pass its healthcheck and still
misbehave later — a healthcheck proves the file parses and starts, not
that it works. Nothing recorded which bytes were good, so "go back to
what worked" was a hope rather than a fact.

So: every applied update pins its version (sha256 + version + source +
timestamp), and `hivv rollback` restores the .bak — healthchecked FIRST,
so a rollback can never restore a copy that is itself broken.

THE INARIANT THESE TESTS PIN: a rollback must never leave the user worse
off. Either the restore works, or the previous copy is put back and the
user is told. There is no third outcome where the CLI is gone.
"""
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli"] = hivv
spec.loader.exec_module(hivv)


V1 = 'import sys\nif "--healthcheck" in sys.argv:\n    sys.exit(0)\nprint("v1")\n'
V2 = 'import sys\nif "--healthcheck" in sys.argv:\n    sys.exit(0)\nprint("v2")\n'
BROKEN = 'this is not valid python !!\n'


def make_install(tmp_path, current: str, bak: str | None):
    """A fake installed layout: <tmp>/lib/hivv/hivv-cli.py + optional .bak.

    Returns (target, state_dir). Point HIVV_INSTALL_DIR/HIVV_STATE_DIR at
    these when driving the CLI.
    """
    target = tmp_path / "lib" / "hivv" / "hivv-cli.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(current)
    if bak is not None:
        target.with_suffix(target.suffix + ".bak").write_text(bak)
    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    return target, state, target.parent


def run_cli(state, *args, install=None, env_extra=None):
    env = dict(os.environ)
    env["HIVV_STATE_DIR"] = str(state)
    if install is not None:
        # point the CLI at the fake install so _update_target() resolves to
        # the test's target instead of the running copy in this checkout
        env["HIVV_INSTALL_DIR"] = str(install)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, str(CLI_PATH), *args],
                          capture_output=True, text=True, env=env, timeout=60)


import os  # noqa: E402  (used by run_cli)


class TestKnownGoodPin:
    def test_pin_file_lives_in_state_dir(self):
        """NOT next to the CLI: a file written beside the CLI inside a git
        checkout makes `git status` dirty — the exact bug `hivv update`
        was fixed for on 2026-11-18."""
        assert hivv.KNOWN_GOOD_FILE == hivv.STATE_DIR / "known-good.json"

    def test_pin_write_then_read_roundtrip(self, tmp_path, monkeypatch):
        target, state, install = make_install(tmp_path, V1, None)
        monkeypatch.setattr(hivv, "STATE_DIR", state)
        monkeypatch.setattr(hivv, "KNOWN_GOOD_FILE", state / "known-good.json")
        assert hivv._record_known_good(target, "0.2.test", "unit") is True
        pin = hivv._read_known_good()
        assert pin["version"] == "0.2.test"
        assert pin["source"] == "unit"
        assert len(pin["sha256"]) == 64
        assert pin["ts"] > 0

    def test_read_missing_pin_is_empty_dict(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "KNOWN_GOOD_FILE", tmp_path / "nope.json")
        assert hivv._read_known_good() == {}

    def test_corrupt_pin_is_empty_dict_not_a_crash(self, tmp_path, monkeypatch):
        bad = tmp_path / "known-good.json"
        bad.write_text("{ not json at all")
        monkeypatch.setattr(hivv, "KNOWN_GOOD_FILE", bad)
        assert hivv._read_known_good() == {}

    def test_pin_failure_does_not_fail_the_update(self, tmp_path, monkeypatch):
        """The pin is an aid. Failing to write it must not fail an update
        that otherwise succeeded — so it must never raise."""
        ro = tmp_path / "ro"
        ro.mkdir()
        monkeypatch.setattr(hivv, "STATE_DIR", ro)
        monkeypatch.setattr(hivv, "KNOWN_GOOD_FILE", ro / "known-good.json")
        ro.chmod(0o500)
        try:
            target = tmp_path / "cli.py"
            target.write_text(V1)
            # must return False, not raise
            assert hivv._record_known_good(target, "x", "y") is False
        finally:
            ro.chmod(0o700)


class TestHealthcheckFile:
    def test_healthy_file_passes(self, tmp_path):
        f = tmp_path / "ok.py"
        f.write_text(V1)
        ok, _ = hivv._healthcheck_file(f)
        assert ok is True

    def test_broken_file_fails(self, tmp_path):
        f = tmp_path / "bad.py"
        f.write_text(BROKEN)
        ok, why = hivv._healthcheck_file(f)
        assert ok is False
        assert why

    def test_missing_file_fails(self, tmp_path):
        ok, why = hivv._healthcheck_file(tmp_path / "nope.py")
        assert ok is False

    def test_never_raises(self, tmp_path):
        # a directory is not a runnable file
        d = tmp_path / "dir.py"
        d.mkdir()
        ok, _ = hivv._healthcheck_file(d)
        assert ok is False


class TestRollback:
    def test_rollback_restores_the_bak(self, tmp_path):
        target, state, install = make_install(tmp_path, V2, V1)
        r = run_cli(state, "rollback", install=install)
        assert r.returncode == 0, r.stderr
        assert target.read_text() == V1, "the .bak must be restored"

    def test_rollback_keeps_the_replaced_copy_as_bad(self, tmp_path):
        target, state, install = make_install(tmp_path, V2, V1)
        run_cli(state, "rollback", install=install)
        bad = target.with_suffix(target.suffix + ".bad")
        assert bad.exists(), "the replaced copy must be kept, never deleted"
        assert bad.read_text() == V2

    def test_rollback_writes_the_pin(self, tmp_path):
        target, state, install = make_install(tmp_path, V2, V1)
        run_cli(state, "rollback", install=install)
        pin = json.loads((state / "known-good.json").read_text())
        assert pin["source"] == "rollback"
        assert len(pin["sha256"]) == 64

    def test_rollback_refuses_a_broken_bak(self, tmp_path):
        """A rollback must never restore a copy that is itself broken."""
        target, state, install = make_install(tmp_path, V2, BROKEN)
        r = run_cli(state, "rollback", install=install)
        assert r.returncode != 0, "a broken .bak must be refused"
        assert "NOT healthy" in (r.stdout + r.stderr)
        assert target.read_text() == V2, "the current copy must be untouched"

    def test_rollback_without_bak_explains_itself(self, tmp_path):
        target, state, install = make_install(tmp_path, V2, None)
        r = run_cli(state, "rollback", install=install)
        assert r.returncode != 0
        assert "nothing to roll back" in (r.stdout + r.stderr)

    def test_rollback_is_a_noop_when_already_on_bak(self, tmp_path):
        target, state, install = make_install(tmp_path, V1, V1)
        r = run_cli(state, "rollback", install=install)
        assert r.returncode == 0
        assert "already on the .bak copy" in r.stdout

    def test_rollback_never_deletes_files(self, tmp_path):
        """No outcome may leave the CLI missing. Either the restore works,
        or the previous copy is put back."""
        target, state, install = make_install(tmp_path, V2, V1)
        run_cli(state, "rollback", install=install)
        assert target.exists()

    def test_rollback_list_shows_every_state(self, tmp_path):
        target, state, install = make_install(tmp_path, V2, V1)
        r = run_cli(state, "rollback", "--list", install=install)
        assert r.returncode == 0, r.stderr
        for label in ("current", "pinned", ".bak"):
            assert label in r.stdout, f"--list must show {label!r}"


class TestRollbackRefusesSourceTree:
    def test_source_tree_is_refused_without_force(self, tmp_path, monkeypatch):
        """A git checkout has no .bak and must never be overwritten."""
        monkeypatch.setattr(hivv, "_in_git_worktree", lambda p: True)
        monkeypatch.setattr(hivv, "_UPDATE_FORCE", False)
        import argparse
        with pytest.raises(SystemExit):
            hivv.cmd_rollback(argparse.Namespace(list=False, force=False))

    def test_source_tree_guard_can_be_overridden(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "_in_git_worktree", lambda p: True)
        monkeypatch.setattr(hivv, "_UPDATE_FORCE", True)
        monkeypatch.setattr(hivv, "_update_target",
                            lambda: (tmp_path / "cli.py", True))
        (tmp_path / "cli.py").write_text(V1)
        (tmp_path / "cli.py.bak").write_text(V1)
        import argparse
        # same bytes → "already on the .bak copy", a clean no-op return
        hivv.cmd_rollback(argparse.Namespace(list=False, force=True))
