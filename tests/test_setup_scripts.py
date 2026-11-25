#!/usr/bin/env python3
"""Regression tests for the setup/install scripts.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
The original `setup.sh` did this:

    [STEP] Checking Node.js...
    [ERROR] Node.js is not installed. Please install Node.js 18+ first.
    exit 1

A person who just ran `git clone` was dead-ended by one missing binary, on
every OS, with no hint about *which* command to type for *their* machine.
The install scripts must instead:

  1. INSTALL missing dependencies automatically when it safely can,
  2. NEVER die with a bare "not installed" message,
  3. ALWAYS print the exact command to type when auto-install isn't possible,
  4. Keep PostgreSQL OPTIONAL (local-first mode needs no database),
  5. ASK the user about install scope, local LLM and hive membership
     instead of silently deciding for them.

These tests pin all five behaviours.

Run:
    python3 tests/test_setup_scripts.py
    python3 -m pytest tests/test_setup_scripts.py -q
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPS = ROOT / "scripts" / "lib" / "deps.sh"
SETUP = ROOT / "setup.sh"
SETUP_LOCAL = ROOT / "scripts" / "setup-local.sh"
SETUP_PS1 = ROOT / "scripts" / "setup-local.ps1"
INIT_NODE = ROOT / "hivv_init_node.sh"

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> bool:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32mPASS\033[0m  {name}")
    else:
        FAIL += 1
        print(f"  \033[31mFAIL\033[0m  {name}  {detail}")
    return bool(cond)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def bash_syntax_ok(path: Path) -> tuple[bool, str]:
    """Run `bash -n` on a script (syntax check only, never executes it)."""
    try:
        p = subprocess.run(
            ["bash", "-n", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return p.returncode == 0, p.stderr.strip()
    except Exception as exc:  # pragma: no cover
        return False, str(exc)


class TestSetupScripts:
    """Everything the setup scripts must (and must not) do."""

    # ── 1. files exist ───────────────────────────────────────────────
    def test_files_exist(self):
        for p in (DEPS, SETUP, SETUP_LOCAL, SETUP_PS1, INIT_NODE):
            assert p.exists(), f"{p} is missing"

    # ── 2. every shell script parses ──────────────────────────────────
    def test_scripts_parse(self):
        for p in (DEPS, SETUP, SETUP_LOCAL, INIT_NODE):
            ok, err = bash_syntax_ok(p)
            assert ok, f"{p} does not parse: {err}"

    # ── 3. NO bare "not installed" death sentence anywhere ───────────
    def test_no_bare_install_errors(self):
        banned = [
            "Node.js is not installed. Please install",
            "Please install Node.js 18+ first",
            "PostgreSQL client is not installed.",
        ]
        blobs = {
            "setup.sh": read(SETUP),
            "setup-local.sh": read(SETUP_LOCAL),
            "hivv_init_node.sh": read(INIT_NODE),
        }
        for name, blob in blobs.items():
            for phrase in banned:
                assert phrase not in blob, (
                    f"{name} still has the bare '{phrase}' error — it must "
                    f"auto-install or print the exact command"
                )

    # ── 4. the shared dependency library exists and is used ──────────
    def test_shared_library_is_used(self):
        deps = read(DEPS)
        assert DEPS.stat().st_size > 1000, "scripts/lib/deps.sh is too small"
        for name, path in (
            ("setup.sh", SETUP),
            ("setup-local.sh", SETUP_LOCAL),
            ("hivv_init_node.sh", INIT_NODE),
        ):
            blob = read(path)
            assert "lib/deps.sh" in blob, f"{name} must source scripts/lib/deps.sh"
            assert "d_install_node" in blob, f"{name} must call d_install_node"

    # ── 5. every supported package manager is handled ────────────────
    def test_all_package_managers_handled(self):
        deps = read(DEPS)
        for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper", "brew",
                   "winget", "scoop", "choco"):
            assert f'"{pm}"' in deps, f"deps.sh does not handle '{pm}'"

    # ── 6. every OS gets an exact command to type ────────────────────
    def test_manual_hints_exist(self):
        deps = read(DEPS)
        for os_name in ("Linux", "Darwin", "windows"):
            assert os_name in deps, f"deps.sh has no manual hint for {os_name}"
        assert "d_node_manual_hint" in deps and "dcmd " in deps, (
            "dcmd prints a copy-paste '    $ <command>' line"
        )
        assert "d_python_manual_hint" in deps
        assert "d_install_postgres" in deps

    # ── 7. node version floor is 18 ──────────────────────────────────
    def test_node_floor_is_18(self):
        assert re.search(r"-ge 18", read(DEPS)), "deps.sh must require node >= 18"
        assert "18" in read(SETUP)

    # ── 8. PostgreSQL is OPTIONAL ────────────────────────────────────
    def test_postgres_is_optional(self):
        setup = read(SETUP)
        assert 'MODE="local"' in setup, "default mode must be local-first"
        assert "HIVV_DB_REQUIRED=0" in setup
        assert 'MODE" == "hosted"' in setup
        hosted_idx = setup.find('if [[ "$MODE" == "hosted" ]]; then')
        postgres_idx = setup.find("d_install_postgres")
        assert hosted_idx != -1 and postgres_idx > hosted_idx, (
            "the postgres install must live inside the hosted branch"
        )
        assert "psql" not in read(SETUP_LOCAL), (
            "local-first must not touch PostgreSQL at all"
        )

    # ── 9. the scripts never prompt for a password ───────────────────
    def test_no_sudo_password_prompt(self):
        deps = read(DEPS)
        assert "sudo -n" in deps, "deps.sh must use sudo -n (never prompt)"
        assert "sudo -n true" in deps

    def test_bare_sudo_only_behind_the_tty_gate(self):
        """A password prompt may only appear where a human is watching.

        Unattended runs (CI, cron, piped stdin, the suite itself) must
        stay on `sudo -n` — a prompt with nobody to answer hangs forever
        (wahi 2026-11-24: password-only sudo used to make every
        privileged step a silent no-op instead).
        """
        deps = read(DEPS)
        body = deps.split("d_run_privileged()")[1].split("\n}")[0]
        gate_at = body.find("d_can_prompt_sudo")
        assert gate_at != -1, "the prompt branch must sit behind the gate"
        # the bare sudo invocation lives AFTER the gate, in its own branch
        bare = [i for i, ln in enumerate(body.splitlines())
                if re.match(r'^\s*sudo "\$@"\s*$', ln)]
        assert bare, "expected a gated bare-sudo branch"
        assert "elif d_can_prompt_sudo" in body

    # ── 10. Windows script auto-installs too ─────────────────────────
    def test_windows_auto_install(self):
        ps1 = read(SETUP_PS1)
        assert "Install-Node" in ps1
        assert "Install-Python" in ps1
        assert "winget install OpenJS.NodeJS.LTS" in ps1
        assert "Update-PathFromRegistry" in ps1, (
            "winget writes to the registry, not the live session PATH"
        )
        assert "-NoAuto" in ps1

    # ── 11. no-sudo user-local fallback exists ───────────────────────
    def test_no_sudo_node_fallback(self):
        deps = read(DEPS)
        assert "d_try_node_userlocal" in deps and "d_try_node_tarball" in deps
        assert "$HOME/.local/node" in deps
        assert "nodejs.org/dist/index.json" in deps, (
            "the node LTS version must be resolved live"
        )
        assert '"lts":false' in deps, (
            "must filter out Current releases and install an LTS line"
        )

    # ── 12. the node tarball URL is well-formed ──────────────────────
    def test_node_tarball_url(self):
        deps = read(DEPS)
        assert "https://nodejs.org/dist/${lts_ver}/${tarball}" in deps
        assert re.search(
            r'tarball="node-\$\{lts_ver\}-\$\{os\}-\$\{arch\}', deps
        ), "the tarball name must include the resolved version + os + arch"

    # ── 13. help text mentions the new flags ────────────────────────
    def test_help_mentions_flags(self):
        setup = read(SETUP)
        for flag in ("--db", "--check", "--port"):
            assert flag in setup, f"setup.sh help must mention {flag}"
        assert "--no-auto" in read(SETUP_LOCAL)

    # ── 14. the setup ASKS, it does not decide for the user ──────────
    def test_setup_asks_the_user(self):
        setup = read(SETUP)
        local = read(SETUP_LOCAL)
        assert "Where should HIVV be installed?" in setup, (
            "the install scope must be asked, not silently chosen"
        )
        assert "System-wide" in setup and "INSTALL_SCOPE" in setup
        assert "Install a local AI model?" in setup, (
            "the local LLM install must be offered, not just described"
        )
        assert "Join the hive now?" in setup and "JOIN_HIVE" in setup
        assert "Join the hive now?" in local

    def test_prompt_helpers_exist(self):
        deps = read(DEPS)
        assert "d_ask_yesno" in deps and "d_ask_choice" in deps
        assert "[[ ! -t 0 ]]" in deps, (
            "a piped/CI run must take the default, never hang"
        )
        assert "d_can_prompt_sudo" in deps, (
            "sudo may only be requested in an interactive session"
        )

    def test_choice_menu_goes_to_stderr(self):
        """The menu must NOT land on stdout.

        `choice="$(d_ask_choice ...)"` captures stdout. If the menu were
        printed there, the variable would hold the menu text instead of the
        index and the case-statement would silently do nothing — the prompt
        would appear, the user would answer, and NOTHING would happen.
        """
        deps = read(DEPS)
        assert re.search(r"d_ask_choice\(\).*?\} >&2", deps, re.S), (
            "d_ask_choice must send the menu to stderr and the index to stdout"
        )

    def test_setup_does_not_hand_join_the_hive(self):
        setup = read(SETUP)
        assert "HIVV_HIVE_JOIN=1 to $ENV_FILE" not in setup, (
            "the script must ASK and run the agent — not print a "
            "manual-edit instruction"
        )

    # ── 15. the gateway alone is NOT a hive node ─────────────────────
    # HIVV_HIVE_JOIN only lets the gateway QUERY the hub. Registration
    # happens in the CLI agent (POST /api/nodes/register). So the setup
    # must start the CLI agent, not just the gateway.
    def test_setup_starts_the_cli_agent(self):
        setup = read(SETUP)
        assert "hivv start" in setup or 'hivv-cli.py" start' in setup, (
            "the gateway alone never registers a node — the agent must start"
        )

    # ── 16. setup.sh --check is non-destructive ──────────────────────
    def test_check_mode_is_non_destructive(self):
        p = subprocess.run(
            ["bash", str(SETUP), "--check"],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(ROOT),
        )
        assert p.returncode == 0, p.stderr[-400:]
        assert "detected environment" in p.stdout
        assert "Where should HIVV be installed?" not in p.stdout, (
            "--check must never ask anything (nothing may change)"
        )


if __name__ == "__main__":
    print("\nHIVV — setup script regression tests\n")
    rc = 0
    for meth in sorted(dir(TestSetupScripts)):
        if meth.startswith("test_"):
            try:
                getattr(TestSetupScripts(), meth)()
                print(f"  \033[32mPASS\033[0m  {meth}")
            except AssertionError as exc:
                rc = 1
                print(f"  \033[31mFAIL\033[0m  {meth}  {exc}")
    print(f"\n  exit {rc}\n")
    sys.exit(rc)
