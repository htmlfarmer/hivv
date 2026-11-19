#!/usr/bin/env python3
"""Regression tests for the CLI's chat-silence diagnostic + volunteer copy.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
On a machine with NO local model (a fresh bee), `hivv whats up` could
produce NOTHING AT ALL — no answer, no error, no explanation. The user
cannot tell a routing miss from a broken install from a model that had
nothing to say. Silence is the worst possible failure mode.

The CLI now records what direct-connect tried and, when a chat ends with no
output, says exactly what was attempted and what to do next.

These tests also pin the volunteer incentive copy: opting OUT must state
plainly what is given up (half the CPU, RAM, disk, bandwidth and honey),
because a user who opts out silently and then wonders why their box got
slower is a bad outcome.

Run:
    python3 tests/test_cli_chat_diagnostics.py
    python3 -m pytest tests/test_cli_chat_diagnostics.py -q
"""

from __future__ import annotations

import importlib.util
import io
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"


def load_cli():
    spec = importlib.util.spec_from_file_location("hivv_cli_diag_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestChatSilenceDiagnostic:
    """A chat that produced no output must still explain itself."""

    def test_why_silent_helper_exists(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "def _why_silent()" in src, (
            "the CLI needs a _why_silent() helper that reports what was tried"
        )
        # It must name the things a user can act on.
        assert "no answer came back" in src.lower(), (
            "the diagnostic must say plainly that no answer came back"
        )
        assert "hub fallback" in src.lower()
        assert "llm setup" in src, (
            "the diagnostic must point at the fix for a node with no model"
        )

    def test_empty_hub_answer_calls_the_diagnostic(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        # The non-streaming hub path: content empty → diagnose.
        assert re.search(
            r"if content:\s*\n\s*print\(content\); return\s*\n\s*# The hub answered.*\n\s*_why_silent\(\)",
            src,
        ), "an empty hub answer must trigger _why_silent()"

    def test_empty_stream_calls_the_diagnostic(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "_got_any_content" in src, (
            "the streaming hub path must track whether ANY content arrived"
        )
        assert re.search(
            r"if payload in \(\"\[DONE\]\", \"\"\):.*?if not _got_any_content:\s*\n\s*_why_silent\(\)",
            src,
            re.S,
        ), "a [DONE] with no content must trigger _why_silent()"

    def test_direct_summary_lists_what_was_tried(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "_direct_summary" in src, (
            "the CLI must remember which nodes/ports direct-connect tried"
        )
        assert "no local model" in src, (
            "a bee with no model must be named as such in the diagnostic"
        )


class TestVolunteerIncentiveCopy:
    """Opting out must state plainly what is given up."""

    def _src(self):
        return CLI.read_text(encoding="utf-8", errors="replace")

    def test_volunteer_off_states_the_cost(self):
        src = self._src()
        # The "off" branch must spell out the four half-shares + honey.
        assert "what you just gave up" in src, (
            "volunteer off must say what the user gives up"
        )
        for term in ("CPU", "Memory", "Disk", "Network", "Honey"):
            assert term in src, f"the incentive copy must mention {term}"
        assert "half" in src.lower(), (
            "the copy must say the shares are halves"
        )
        assert "reverses this" in src.lower(), (
            "the user must know opting back in is one command"
        )

    def test_volunteer_on_states_the_gain(self):
        src = self._src()
        assert "what you just gained" in src, (
            "volunteer on must say what the user gains"
        )

    def test_volunteer_status_shows_the_tradeoff(self):
        src = self._src()
        assert "double the honey" in src, (
            "the status view must show the honey incentive both ways"
        )

    def test_volunteer_off_still_allows_rejoining(self):
        src = self._src()
        # The copy must never guilt-trip into staying — it must be a
        # free, reversible choice.
        assert "rejoin anytime" in src
        assert "Nothing is lost forever" in src


if __name__ == "__main__":
    print("\nHIVV — chat diagnostic + volunteer copy tests\n")
    rc = 0
    for cls in (TestChatSilenceDiagnostic, TestVolunteerIncentiveCopy):
        for meth in sorted(dir(cls)):
            if meth.startswith("test_"):
                try:
                    getattr(cls(), meth)()
                    print(f"  \033[32mPASS\033[0m  {cls.__name__}.{meth}")
                except AssertionError as exc:
                    rc = 1
                    print(f"  \033[31mFAIL\033[0m  {cls.__name__}.{meth}  {exc}")
    print(f"\n  exit {rc}\n")
    sys.exit(rc)
