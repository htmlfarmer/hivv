#!/usr/bin/env python3
"""Interactive-prompt regression tests for the HIVV setup scripts.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
Two real bugs lived in these prompts, and both were invisible to a grep:

  1. `d_ask_choice` printed its MENU to stdout. The caller does
        choice="$(d_ask_choice ...)"
     so the variable captured the menu TEXT, not the index. The `case`
     statement then matched nothing and the branch silently did nothing —
     the prompt appeared, the user answered, and NOTHING happened.

  2. The prompts read from /dev/tty. Under a pty harness, cron, a
     container or CI, /dev/tty is not the controlling terminal — reads
     failed with "No such device or address" and the default was used
     instead of the user's answer.

These tests drive the scripts through a REAL pty (so the prompts actually
fire) and assert the answers are honoured.

Run:
    python3 tests/test_setup_prompts.py
    python3 -m pytest tests/test_setup_prompts.py -q
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PTY_DRIVE = ROOT / "tests" / "pty_drive.py"


def drive(cmd: str, answers: list[str], timeout: int = 300):
    """Run `cmd` under a pty, answering prompts by matching their text.

    Returns (rc, stdout, stderr, combined) — the streams are kept apart
    because one of the tests asserts that d_ask_choice puts its MENU on
    stderr and only the INDEX on stdout.
    """
    argv = [sys.executable, str(PTY_DRIVE), cmd, *answers]
    # The pty makes stdin a TTY, which would otherwise unlock the
    # interactive-sudo branch (d_can_prompt_sudo) — and the harness has
    # nobody to type a password. Force the unattended behaviour.
    env = dict(os.environ, HIVV_NO_SUDO_PROMPT="1")
    try:
        p = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, cwd=str(ROOT),
            env=env,
        )
        raw = p.stdout + p.stderr
        out = _between(raw, "===STDOUT===", "===STDERR===")
        err = _between(raw, "===STDERR===", "===END===")
        return p.returncode, out, err, raw
    except subprocess.TimeoutExpired:
        return 124, "", "", "(timed out)"


def _between(raw: str, start: str, end: str) -> str:
    if start not in raw:
        return ""
    part = raw.split(start, 1)[1]
    if end in part:
        part = part.split(end, 1)[0]
    return part


class TestSetupPrompts:
    """The setup prompts must actually work when a real person answers."""

    # ── 1. d_ask_choice sends the INDEX to stdout, the MENU to stderr ──
    def test_choice_returns_only_the_index(self):
        rc, out, err, raw = drive(
            "bash -c '. scripts/lib/deps.sh; d_ask_choice \"Pick\" \"A|B|C\" 3'",
            ["Pick:2"],
        )
        captured = out.strip()
        assert captured == "2", (
            f"captured {captured!r} — the menu must NOT be on stdout, or "
            f"`choice=$(d_ask_choice ...)` breaks the caller's case-statement"
        )
        assert "1)" in err and "2)" in err and "3)" in err, (
            "the menu must be visible to the user"
        )

    # ── 2. d_ask_yesno honours y and n ────────────────────────────────
    def test_yesno_honours_no(self):
        rc, out, err, raw = drive(
            "bash -c '. scripts/lib/deps.sh; "
            "if d_ask_yesno \"Go?\" y; then echo YES; else echo NO; fi'",
            ["Go?:n"],
        )
        assert "NO" in out + err, (out + err)[-200:]

    def test_yesno_honours_yes(self):
        rc, out, err, raw = drive(
            "bash -c '. scripts/lib/deps.sh; "
            "if d_ask_yesno \"Go?\" n; then echo YES; else echo NO; fi'",
            ["Go?:y"],
        )
        assert "YES" in out + err, (out + err)[-200:]

    # ── 3. no prompt fires without a TTY (CI must never hang) ───────
    def test_no_prompt_without_tty(self):
        p = subprocess.run(
            ["bash", str(ROOT / "setup.sh"), "--check"],
            capture_output=True, text=True, timeout=300, cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
        )
        assert p.returncode == 0, p.stderr[-300:]
        assert "Where should HIVV be installed?" not in p.stdout, (
            "a piped run must take the default silently"
        )

    # ── 4. the full interactive flow: scope → LLM → join ─────────────
    def test_full_interactive_flow(self):
        with tempfile.TemporaryDirectory(prefix="hivv-prompt-") as td:
            data = os.path.join(td, "data")
            rc, out, err, raw = drive(
                f"HIVV_DATA_DIR={data} bash ./setup.sh --port 3099",
                [
                    "Where should HIVV be installed?:1",
                    "Install a local AI model?:3",
                    "Join the hive now?:n",
                ],
            )
            all_out = out + err
            assert "Where should HIVV be installed?" in all_out, (
                "the install scope must be asked"
            )
            assert "Install scope: just for you" in all_out, (
                "the answer 'just for me' must be honoured"
            )
            # The LLM offer only fires when NO server answers setup's probe
            # (setup.sh: FOUND_MODELS -eq 0). On a box where llama/ollama
            # already answers — every bee, and this dev box whenever
            # llama.service is up — setup correctly skips the offer and
            # acknowledges the server it found instead.
            if "model server on 127.0.0.1" in all_out:
                assert "Install a local AI model?" not in all_out, (
                    "with a live model server setup must not re-offer the install"
                )
            else:
                assert "Install a local AI model?" in all_out, (
                    "the local LLM install must be offered when none exists"
                )
                assert ("Skipped — you can add one any time" in all_out
                        or "cloud API key later" in all_out), (
                    "the answer 'no local model' must be honoured"
                )
            assert "Join the hive now?" in all_out, (
                "joining the hive must be asked"
            )
            assert "Not joining the hive" in all_out, (
                "the answer 'do not join' must be honoured"
            )
            assert "HIVV_HIVE_JOIN=1 to" not in all_out, (
                "the script must do the join, not print a manual instruction"
            )

            # clean up the gateway this test started
            pidf = os.path.join(data, "hivv.pid")
            if os.path.exists(pidf):
                try:
                    os.kill(int(Path(pidf).read_text().strip()), 15)
                except Exception:
                    pass


if __name__ == "__main__":
    print("\nHIVV — interactive prompt regression tests\n")
    rc = 0
    for meth in dir(TestSetupPrompts):
        if meth.startswith("test_"):
            try:
                getattr(TestSetupPrompts(), meth)()
                print(f"  \033[32mPASS\033[0m  {meth}")
            except AssertionError as exc:
                rc = 1
                print(f"  \033[31mFAIL\033[0m  {meth}  {exc}")
    print(f"\n  exit {rc}\n")
    sys.exit(rc)
