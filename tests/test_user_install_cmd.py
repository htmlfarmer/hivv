"""Tests for the ONE no-sudo command: root-owned installs, regular users.

THE FAILURE THIS EXISTS FOR (wahi, 2026-11-21..23)
---------------------------------------------------
A system-wide (root-owned) install turned every self-service operation
into a wall for a user WITHOUT sudo:
  * hivv update        → Permission denied on hivv-cli.py.bak (7 attempts)
  * hivv how are you   → Permission denied downloading hivv-tools.py
and the advice led with "sudo hivv update" — useless to the half of the
hive that has no sudo at all.

The fix has two halves, both pinned here:
  1. ONE command, no sudo: installer --mode=user lands client + wrapper +
     agent unit in ~/.local, and the PATH/restart chain makes it live.
     It must be copy-pasteable — an escaped $HOME in the tip would break
     the paste, and that bug DID ship briefly.
  2. Proactive: doctor shows the command BEFORE the wall (it used to
     appear only in a tip AFTER the failure), and the tip itself never
     leads with sudo.
"""
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli_uic", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_uic"] = hivv
spec.loader.exec_module(hivv)


class TestUserInstallCommand:
    def test_the_command_is_complete_and_copy_pasteable(self):
        c = hivv.USER_INSTALL_CMD
        assert "install-hivv.sh" in c and "--mode=user" in c
        assert "export PATH=$HOME/.local/bin:$PATH" in c
        assert "hivv restart agent" in c
        # the bug that shipped briefly: a backslash-escaped $HOME makes the
        # pasted command wrong for exactly the users we are trying to help
        assert "\\$HOME" not in c and "\\$PATH" not in c, (
            "no backslash-escapes — the tip must be pasteable as-is"
        )

    def test_tip_never_leads_with_sudo(self):
        tip = next(t for p, t in hivv._HIVV_TIPS if p == "permission denied")
        assert "do NOT need sudo" in tip
        assert hivv.USER_INSTALL_CMD in tip
        # sudo may only appear as the ALTERNATIVE, after the no-sudo path
        assert tip.index(hivv.USER_INSTALL_CMD) < tip.index("sudo hivv update")
        assert "one-time" in tip, "sudo must be labelled as the exception"

    def test_tip_and_doctor_share_one_command(self):
        """One source of truth: the tip, the doctor line and this test all
        quote USER_INSTALL_CMD — they cannot drift apart."""
        assert hivv.USER_INSTALL_CMD in next(
            t for p, t in hivv._HIVV_TIPS if p == "permission denied")


class TestRootOwnedHint:
    def test_unwritable_dir_returns_the_command(self, tmp_path):
        d = tmp_path / "root-owned"
        d.mkdir()
        d.chmod(0o555)
        try:
            assert hivv._root_owned_install_hint(d / "hivv-cli.py") == hivv.USER_INSTALL_CMD
        finally:
            d.chmod(0o700)

    def test_writable_dir_returns_none(self, tmp_path):
        assert hivv._root_owned_install_hint(tmp_path / "hivv-cli.py") is None

    def test_missing_parent_returns_none(self, tmp_path):
        assert hivv._root_owned_install_hint(tmp_path / "no" / "cli.py") is None

    def test_doctor_shows_the_hint_proactively(self):
        """The command must appear in doctor's install section — BEFORE any
        failure, not only in a tip after one."""
        src = CLI_PATH.read_text()
        start = src.index("def cmd_doctor(args)")
        end = src.index("\ndef ", start + 10)
        body = src[start:end]
        assert "_root_owned_install_hint(bin_path)" in body
        assert "no sudo needed" in body

    def test_missing_parent_is_not_a_crash(self, tmp_path):
        # os.access on a path whose parent does not exist must not raise
        assert hivv._root_owned_install_hint(tmp_path / "a" / "b" / "c.py") is None
