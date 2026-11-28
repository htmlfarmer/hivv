#!/usr/bin/env python3
"""Regression tests: install-tailscale.sh + the `hivv install tailscale` door.

THE FAILURE THIS GUARDS AGAINST
-------------------------------
ashy (BOSS GNU/Linux 10 "pragya", ID=boss) 2026-11-27:

    $ curl -fsSL https://tailscale.com/install.sh | sh
    Couldn't determine what kind of Linux is running.
    ...
    PRETTY_NAME="BOSS GNU/Linux 10 (pragya)"
    ID=boss

tailscale.com's installer cases ONLY on ID= from /etc/os-release, does not
know `boss`, sets OS_UNSUPPORTED and exits 1 BEFORE installing anything --
and has no env override to opt out of detection. The box is a Debian 12
(bookworm) system wearing an ID the installer never heard of, so the
documented one-liner was a dead end with a friendly error.

The CLI's own hints pointed at that same dead end in FOUR places, so
`hivv doctor` and `hivv firewall` both told you to run the command that
cannot work.

WHAT SHIPS
----------
public_html/install-tailscale.sh — three tiers, first one that wins:
  1. the official installer (right answer wherever it works)
  2. apt — uses an already-configured repo, else adds one, but only with a
     suite pkgs.tailscale.com actually serves (probed, never guessed:
     VERSION_CODENAME=pragya is not a Debian codename)
  3. the static tarball + a systemd unit — needs no distro knowledge

plus the `hivv install tailscale` door, and the four hints repointed.

Run:
    python3 -m pytest tests/test_tailscale_install.py -q
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "public_html"
SCRIPT = PUBLIC / "install-tailscale.sh"
INSTALLER = PUBLIC / "install-hivv.sh"
CLI = PUBLIC / "hivv-cli.py"

# The pattern the repo's fast-scan calls critical: a download piped into a
# shell. Mirrors api/lib/fast-scan.js and tests/test_upgrade_review.py.
PIPE_TO_SHELL = re.compile(r"(?:curl|wget)[^|;\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi|da)?sh")


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def run(args, *, env=None, timeout=120):
    full_env = dict(os.environ)
    full_env.pop("HIVV_STATE_DIR", None)
    full_env["HIVV_HUB"] = "http://127.0.0.1:1"   # never touch production
    full_env["CI"] = "1"                          # never prompt for sudo
    if env:
        full_env.update(env)
    return subprocess.run(args, capture_output=True, text=True,
                          timeout=timeout, env=full_env, cwd=str(REPO))


# ── 1. the script exists and is well-formed ─────────────────────────────
class TestScriptShape:
    def test_script_exists_and_is_executable(self):
        assert SCRIPT.is_file(), "public_html/install-tailscale.sh must exist"
        assert os.access(SCRIPT, os.X_OK), "the script must be executable"

    @pytest.mark.parametrize("shell", ["sh", "dash", "bash"])
    def test_syntax_is_clean(self, shell):
        """POSIX sh at minimum — `curl | sh` runs it under /bin/sh (dash)."""
        if not Path(f"/bin/{shell}").exists() and not Path(f"/usr/bin/{shell}").exists():
            pytest.skip(f"{shell} not installed")
        r = run([shell, "-n", str(SCRIPT)])
        assert r.returncode == 0, f"{shell} -n failed:\n{r.stderr}"

    def test_never_pipes_a_download_into_a_shell(self):
        """The fast-scan law: a download is written to a FILE, then run."""
        hits = [(i, l) for i, l in enumerate(read(SCRIPT).splitlines(), 1)
                if PIPE_TO_SHELL.search(l)]
        assert not hits, f"download piped into a shell: {hits}"

    def test_declares_its_three_tiers(self):
        src = read(SCRIPT)
        for tier in ("tier_official", "tier_apt", "tier_static"):
            assert f"{tier}()" in src, f"{tier} must exist"

    def test_tiers_run_in_order_first_win(self):
        src = read(SCRIPT)
        i1 = src.index("if tier_official; then")
        i2 = src.index('if [ "$_done" = 0 ] && tier_apt; then')
        i3 = src.index('if [ "$_done" = 0 ] && tier_static; then')
        assert i1 < i2 < i3, "tiers must run in order, stopping at the first win"


# ── 2. the CLI door ─────────────────────────────────────────────────────
class TestInstallTailscaleDoor:
    def test_chooser_lists_it(self):
        r = run([sys.executable, str(CLI), "install"])
        assert r.returncode == 0, r.stderr
        assert "install tailscale" in r.stdout, (
            "the chooser must mention the tailscale path")

    def test_dispatch_reaches_the_script_not_the_chooser(self):
        """The trap this repo has hit before: an unrecognized subcommand
        falls through to the smart-default and gets SENT TO THE MODEL."""
        r = run([sys.executable, str(CLI), "install", "tailscale", "--dry-run"])
        out = r.stdout + r.stderr
        assert "what do you want to install" not in out, (
            "install tailscale fell into the chooser instead of the installer")
        assert "tier 1" in out and "tier 3" in out, (
            f"the three-tier script did not run:\n{out}")
        assert r.returncode == 0, out

    def test_dry_run_changes_nothing_and_needs_no_root(self):
        r = run([sys.executable, str(CLI), "install", "tailscale", "--dry-run"])
        assert r.returncode == 0, r.stdout + r.stderr
        assert "dry run" in r.stdout
        # all three tiers are shown, not just the first
        assert "tier 1" in r.stdout and "tier 2" in r.stdout and "tier 3" in r.stdout

    def test_help_is_clean(self):
        r = run([sys.executable, str(CLI), "install", "tailscale", "--help"])
        combined = r.stdout + r.stderr
        assert "parser failed" not in combined, (
            "a healthy CLI must not claim its own parser failed")

    def test_the_four_broken_hints_are_repointed(self):
        """doctor + firewall told you to run the command that cannot work."""
        src = read(CLI)
        assert "tailscale.com/install.sh" not in src, (
            "the CLI still points at tailscale.com's installer, which exits 1 "
            "on ID=boss")
        assert "install tailscale" in src

    def test_install_hivv_does_not_pipe_the_official_installer(self):
        src = read(INSTALLER)
        assert "tailscale.com/install.sh" not in src, (
            "install-hivv.sh still pipes tailscale.com's installer")
        hits = [(i, l) for i, l in enumerate(src.splitlines(), 1)
                if PIPE_TO_SHELL.search(l) and "tailscale" in l.lower()]
        assert not hits, f"tailscale install piped into a shell: {hits}"


# ── 3. behaviour of the script itself ───────────────────────────────────
class TestScriptBehaviour:
    def test_help_exits_zero(self):
        r = run(["sh", str(SCRIPT), "--help"])
        assert r.returncode == 0, r.stdout + r.stderr
        assert "usage" in r.stdout

    def test_unknown_option_exits_two(self):
        r = run(["sh", str(SCRIPT), "--bogus"])
        assert r.returncode == 2, r.stdout + r.stderr

    def test_already_installed_is_a_no_op(self, tmp_path):
        """Idempotent: a box that has it is told so and nothing is touched."""
        fake = tmp_path / "bin"
        fake.mkdir(parents=True, exist_ok=True)
        (fake / "tailscale").write_text("#!/bin/sh\necho 1.104.7\n")
        (fake / "tailscale").chmod(0o755)
        r = run(["sh", str(SCRIPT)], env={"PATH": f"{fake}:{os.environ['PATH']}"})
        assert r.returncode == 0, r.stdout + r.stderr
        assert "already installed" in r.stdout

    def test_refuses_to_prompt_when_nobody_can_answer(self):
        """THE LAW: no sudo password prompt when nobody is watching.

        PATH is emptied so `command -v sudo` cannot find a passwordless
        sudo either — otherwise a CI box WITH passwordless sudo would
        actually try to install tailscale during a test run.
        """
        # absolute path: an empty PATH must stop the SCRIPT finding sudo,
        # not stop Python finding sh
        r = run(["/bin/sh", str(SCRIPT)], env={"PATH": "/nonexistent", "CI": "1"})
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "needs root" in out, out
        # it must hand over the EXACT command, not just complain
        assert "sudo sh" in out, out

    def test_dry_run_never_touches_the_network_or_root(self):
        r = run(["/bin/sh", str(SCRIPT), "--dry-run"], env={"PATH": "/nonexistent"})
        out = r.stdout + r.stderr
        # no root and no tools at all: it must still print a plan and exit 0
        assert r.returncode == 0, out
        assert "tier 1" in out and "tier 2" in out and "tier 3" in out
        assert "dry run" in out


# ── 4. the helpers, via sourcing ────────────────────────────────────────
class TestHelpers:
    @staticmethod
    def _src(expr: str) -> str:
        r = run(["sh", "-c",
                 f'. "{SCRIPT}"; {expr}'],
                env={"HIVV_TS_SOURCED": "1", "PATH": os.environ["PATH"]})
        assert r.returncode == 0, r.stdout + r.stderr
        return r.stdout.strip()

    @pytest.mark.parametrize("machine,expect", [
        ("x86_64", "amd64"),
        ("amd64", "amd64"),
        ("aarch64", "arm64"),
        ("arm64", "arm64"),
        ("armv7l", "armv7"),
        ("i686", "386"),
        ("riscv64", "riscv64"),
    ])
    def test_arch_mapping(self, machine, expect):
        assert self._src(f"arch_to_tarch {machine}") == expect

    def test_unknown_arch_is_rejected_not_guessed(self):
        r = run(["sh", "-c", f'. "{SCRIPT}"; arch_to_tarch sparc'],
                env={"HIVV_TS_SOURCED": "1"})
        assert r.returncode != 0, "an unknown arch must fail loudly, not guess"

    def test_sourcing_does_not_run_main(self):
        """HIVV_TS_SOURCED=1 must give functions without installing."""
        r = run(["/bin/sh", "-c", f'. "{SCRIPT}"; echo LOADED'],
                env={"HIVV_TS_SOURCED": "1", "PATH": "/nonexistent"})
        assert r.stdout.strip().endswith("LOADED"), r.stdout + r.stderr


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
