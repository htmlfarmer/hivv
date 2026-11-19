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
  4. Keep PostgreSQL OPTIONAL (local-first mode needs no database).

These tests pin all four behaviours.

Run:
    python3 tests/test_setup_scripts.py
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


def main() -> int:
    print("\nHIVV — setup script regression tests\n")

    # ── 1. files exist ───────────────────────────────────────────────
    for p in (DEPS, SETUP, SETUP_LOCAL, SETUP_PS1, INIT_NODE):
        check(f"{p.relative_to(ROOT)} exists", p.exists())
    if FAIL:
        print("\nmissing files — aborting\n")
        return 1

    deps = read(DEPS)
    setup = read(SETUP)
    local = read(SETUP_LOCAL)
    ps1 = read(SETUP_PS1)
    init = read(INIT_NODE)

    # ── 2. every shell script parses ──────────────────────────────────
    for p in (DEPS, SETUP, SETUP_LOCAL, INIT_NODE):
        ok, err = bash_syntax_ok(p)
        check(f"{p.relative_to(ROOT)} parses (bash -n)", ok, err)

    # ── 3. NO bare "not installed" death sentence anywhere ───────────
    # The old wording that must never come back.
    banned = [
        "Node.js is not installed. Please install",
        "Please install Node.js 18+ first",
        "PostgreSQL client is not installed.",
    ]
    for name, blob in (
        ("setup.sh", setup),
        ("setup-local.sh", local),
        ("hivv_init_node.sh", init),
    ):
        for phrase in banned:
            check(
                f"{name} has no bare '{phrase[:38]}' error",
                phrase not in blob,
                "must auto-install or print the exact command",
            )

    # ── 4. the shared dependency library exists and is used ──────────
    check("scripts/lib/deps.sh is a real file", DEPS.stat().st_size > 1000)
    for name, blob in (
        ("setup.sh", setup),
        ("setup-local.sh", local),
        ("hivv_init_node.sh", init),
    ):
        check(
            f"{name} sources the shared deps library",
            "lib/deps.sh" in blob,
            "must source scripts/lib/deps.sh",
        )
        check(
            f"{name} calls the node auto-installer",
            "d_install_node" in blob,
            "must call d_install_node",
        )

    # ── 5. every supported package manager is handled ────────────────
    for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper", "brew"):
        check(f"deps.sh handles '{pm}'", f'"{pm}"' in deps)
    for pm in ("winget", "scoop", "choco"):
        check(f"deps.sh handles '{pm}'", f'"{pm}"' in deps)

    # ── 6. every OS gets an exact command to type ────────────────────
    for os_name in ("Linux", "Darwin", "windows"):
        check(f"deps.sh has a manual hint for {os_name}", os_name in deps)
    check(
        "deps.sh node hint prints copy-paste commands",
        "d_node_manual_hint" in deps and "dcmd " in deps,
        "dcmd prints '    $ <command>'",
    )
    check(
        "deps.sh python hint exists",
        "d_python_manual_hint" in deps,
    )
    check(
        "deps.sh postgres hint exists",
        "d_install_postgres" in deps,
    )

    # ── 7. node version floor is 18 ──────────────────────────────────
    check("deps.sh requires node >= 18", re.search(r"-ge 18", deps) is not None)
    check(
        "setup.sh mentions node 18+",
        "18" in setup,
    )

    # ── 8. PostgreSQL is OPTIONAL ────────────────────────────────────
    check(
        "setup.sh has a local-first default (no DB required)",
        "MODE=\"local\"" in setup,
        "default mode must be local-first",
    )
    check(
        "setup.sh sets HIVV_DB_REQUIRED=0 for local mode",
        "HIVV_DB_REQUIRED=0" in setup,
    )
    check(
        "setup.sh only requires psql in hosted mode",
        'MODE" == "hosted"' in setup,
    )
    # The structural guarantee: the postgres check lives INSIDE the hosted
    # branch. Find the hosted branch and confirm psql logic is inside it.
    hosted_idx = setup.find('if [[ "$MODE" == "hosted" ]]; then')
    postgres_idx = setup.find("d_install_postgres")
    check(
        "setup.sh skips PostgreSQL entirely in local mode",
        hosted_idx != -1 and postgres_idx > hosted_idx,
        "postgres install must be inside the hosted branch",
    )
    check(
        "setup-local.sh never requires psql",
        "psql" not in local,
        "local-first must not touch PostgreSQL",
    )

    # ── 9. the scripts never prompt for a password ───────────────────
    # A `sudo` prompt inside a piped/CI install would hang forever.
    check(
        "deps.sh never prompts for sudo (uses -n)",
        "sudo -n" in deps,
    )
    check(
        "deps.sh uses sudo -n for the privilege probe",
        "sudo -n true" in deps,
    )

    # ── 10. Windows script auto-installs too ─────────────────────────
    check(
        "setup-local.ps1 auto-installs node",
        "Install-Node" in ps1,
    )
    check(
        "setup-local.ps1 auto-installs python",
        "Install-Python" in ps1,
    )
    check(
        "setup-local.ps1 prints winget commands",
        "winget install OpenJS.NodeJS.LTS" in ps1,
    )
    check(
        "setup-local.ps1 refreshes PATH after winget",
        "Update-PathFromRegistry" in ps1,
    )
    check(
        "setup-local.ps1 has a -NoAuto opt-out",
        "-NoAuto" in ps1,
    )

    # ── 11. no-sudo user-local fallback exists ───────────────────────
    check(
        "deps.sh has a no-sudo node fallback (fnm/nvm/tarball)",
        "d_try_node_userlocal" in deps and "d_try_node_tarball" in deps,
    )
    check(
        r"deps.sh installs node into $HOME/.local",
        "$HOME/.local/node" in deps,
    )
    check(
        "deps.sh resolves the node LTS version live",
        "nodejs.org/dist/index.json" in deps,
    )
    check(
        "deps.sh prefers an LTS release over Current",
        '"lts":false' in deps,
    )

    # ── 12. the node tarball URL is well-formed ──────────────────────
    check(
        "deps.sh builds the nodejs dist URL correctly",
        "https://nodejs.org/dist/${lts_ver}/${tarball}" in deps,
    )
    check(
        "deps.sh node tarball name is well-formed",
        re.search(r'tarball="node-\$\{lts_ver\}-\$\{os\}-\$\{arch\}', deps) is not None,
    )

    # ── 13. help text mentions the new flags ────────────────────────
    for flag in ("--db", "--check", "--port"):
        check(f"setup.sh help mentions {flag}", flag in setup)
    check("setup-local.sh help mentions --no-auto", "--no-auto" in local)

    # ── 14. setup.sh --check is non-destructive ──────────────────────
    # It must exit 0 without starting anything or touching a DB.
    try:
        p = subprocess.run(
            ["bash", str(SETUP), "--check"],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(ROOT),
        )
        check(
            "setup.sh --check exits 0",
            p.returncode == 0,
            p.stderr[-400:],
        )
        check(
            "setup.sh --check reports the platform",
            "detected environment" in p.stdout,
        )
    except Exception as exc:  # pragma: no cover
        check("setup.sh --check runs", False, str(exc))

    # ── summary ──────────────────────────────────────────────────────
    print(f"\n  {PASS} passed   {FAIL} failed\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
