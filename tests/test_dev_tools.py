#!/usr/bin/env python3
"""git + gh at install time — for people who want to work with the source.

THE RULE THIS PINS: **ASK, don't decide.**

An AI landing on hivv.org must be able to find the repository, the rules and
the write path without being told. A human who wants to help must be able to
get git + gh without hunting for the package name on their distro. But most
people came here to RUN a network, not edit one — so the default answer is
no, and a prompt with no TTY takes its default silently.

THE OTHER RULE: **never a dead end.** If the package manager cannot provide
gh (apt without universe, a distro that spells it github-cli), the exact
copy-paste command must be printed. Same contract as scripts/lib/deps.sh.

THE THIRD RULE: **never prompt for a password.** sudo -n only — a prompt
hangs CI and cron.

Run:
    python3 -m pytest tests/test_dev_tools.py -q
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEPS = REPO / "scripts" / "lib" / "deps.sh"
SETUP_LOCAL = REPO / "scripts" / "setup-local.sh"
INSTALL_SH = REPO / "public_html" / "install-hivv.sh"
CLI = REPO / "public_html" / "hivv-cli.py"


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def sh(script: str) -> str:
    """Source the shared library in a real shell and run a probe."""
    r = subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-600:]
    return (r.stdout or "").strip()


class TestTheSharedLibrary:
    """deps.sh learns git + gh, across every manager the house supports."""

    def test_probe_helpers_exist(self):
        src = read(DEPS)
        assert "d_have_git()" in src
        assert "d_have_gh()" in src
        assert "d_dev_tools_hint()" in src
        assert "d_install_dev_tools()" in src

    def test_the_probes_actually_work(self):
        out = sh(
            "source scripts/lib/deps.sh; detect_platform; "
            "d_have_git && echo YES || echo NO")
        assert out in ("YES", "NO")
        out = sh(
            "source scripts/lib/deps.sh; detect_platform; "
            "d_have_gh && echo YES || echo NO")
        assert out in ("YES", "NO")

    def test_the_hint_covers_every_manager(self):
        src = read(DEPS)
        for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper",
                   "brew", "winget", "scoop", "choco"):
            assert '"' + pm + '"' in src, f"deps.sh has no gh hint for {pm}"

    def test_the_gh_package_name_differs_per_distro(self):
        """apt spells it gh; pacman/apk/zypper spell it github-cli."""
        src = read(DEPS)
        assert "github-cli" in src, "the gh package name must be translated"

    def test_the_apt_fallback_is_the_official_repo_script(self):
        """gh is not in every distro's default repo set — the official install
        script is the exact command, and it needs no guesswork."""
        src = read(DEPS)
        assert "d_gh_official_hint" in src
        assert "cli.github.com/packages" in src

    def test_never_a_dead_end(self):
        src = read(DEPS)
        assert "d_gh_official_hint" in src
        assert "d_dev_tools_hint" in src

    def test_no_password_prompt(self):
        """The install path never asks for a password (a prompt hangs CI)."""
        src = read(DEPS)
        assert "d_run_privileged" in src
        assert "sudo -n" in src


class TestSetupLocal:
    """The clone-and-run path ASKS, and the default is no."""

    def test_it_asks_the_question(self):
        src = read(SETUP_LOCAL)
        assert "Install git and the GitHub CLI now?" in src

    def test_the_default_is_no(self):
        """Most people came to RUN the hive, not edit it."""
        src = read(SETUP_LOCAL)
        assert 'd_ask_yesno "Install git and the GitHub CLI now?" "n"' in src

    def test_it_never_dead_ends(self):
        src = read(SETUP_LOCAL)
        assert "hivv contribute" in src, "it must name the later path"

    def test_it_respects_check_only(self):
        """--check must not install anything."""
        src = read(SETUP_LOCAL)
        assert 'if [[ "$CHECK_ONLY" -eq 0 ]]; then' in src

    def test_the_question_is_optional_not_required(self):
        src = read(SETUP_LOCAL)
        assert "Neither is needed to run the hive" in src


class TestTheOneLinerInstaller:
    """The curl|bash path: a flag, a prompt, and the install."""

    def test_the_flags_exist(self):
        src = read(INSTALL_SH)
        assert "--with-git" in src
        assert "--no-git" in src
        assert "WITH_GIT=0" in src

    def test_the_help_lists_them(self):
        out = subprocess.run(
            ["bash", str(INSTALL_SH), "--help"],
            capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr[-400:]
        assert "--with-git" in out.stdout
        assert "--no-git" in out.stdout

    def test_it_asks_and_defaults_to_no(self):
        src = read(INSTALL_SH)
        assert "should_install_git()" in src
        assert "[y/N]" in src

    def test_the_install_helper_exists(self):
        src = read(INSTALL_SH)
        assert "ensure_dev_tools()" in src
        assert "ensure_build_tools git gh" in src
        assert "_TOOLS_LABEL=\"contributor tool\"" in src

    def test_it_reuses_the_escalation_ladder(self):
        """A second install path is a second set of bugs — reuse, don't copy."""
        src = read(INSTALL_SH)
        assert "ensure_build_tools git gh" in src
        assert "_can_prompt_sudo" in src

    def test_the_installer_still_parses(self):
        r = subprocess.run(
            ["bash", "-n", str(INSTALL_SH)], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr[-400:]


class TestTheContributeCommand:
    """hivv contribute — the on-ramp for someone who ALREADY installed."""

    def test_the_command_exists(self):
        src = read(CLI)
        assert '"contribute"' in src
        assert "def cmd_contribute" in src

    def test_the_package_table_covers_every_manager(self):
        src = read(CLI)
        for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper",
                   "brew", "winget", "scoop", "choco"):
            assert ('"' + pm + '"') in src, f"the CLI has no gh table for {pm}"

    def test_it_never_prompts_for_a_password(self):
        """A prompt with nobody behind it hangs — sudo -n only."""
        src = read(CLI)
        assert '["sudo", "-n"]' in src

    def test_the_clone_url_is_the_canonical_repo(self):
        src = read(CLI)
        assert "htmlfarmer/hivv" in src

    def test_it_prints_the_no_credential_path(self):
        src = read(CLI)
        assert "no credential is needed" in src

    def test_it_runs(self):
        r = subprocess.run(
            [sys.executable, str(CLI), "contribute", "--json"],
            capture_output=True, text=True, timeout=180,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp/hivv-test-home",
                 "HIVV_HUB": "http://127.0.0.1:1"},
            stdin=subprocess.DEVNULL)
        assert r.returncode == 0, r.stderr[-600:]
        payload = json.loads(r.stdout)
        assert payload["repo"] == "htmlfarmer/hivv"
        assert payload["clone_url"].endswith("hivv.git")

