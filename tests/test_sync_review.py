"""Tests for `hivv sync` (the two-way GitHub check) and `hivv review-diff`
(the hive reviewing our own changes).

WHY `hivv sync` EXISTS
The hive is developed in two places — the hub host and GitHub — and when
they drift, someone merges by hand and loses work. That happened on
2026-11-18. `hivv sync` makes the drift VISIBLE instead of surprising.

THE ONE RULE THAT MATTERS: `hivv sync` is READ-ONLY. A sync command that
can merge, push or reset is a sync command nobody runs, because the one
time it is wrong it loses work. That is pinned here.

WHY `hivv review-diff` EXISTS
The hive is a fleet of machines running models — a review board. A change
can be shown to several models at once and their verdicts compared. It is
a SECOND opinion, never an authority: a model is a reader, not a
gatekeeper. So the verdict must be parsed honestly, and an unparseable
answer must read as UNKNOWN, never as SAFE.

No network in these tests: the GitHub side is stubbed.
"""
import importlib.util
import re
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


class TestVerdictParsing:
    def test_plain_verdict(self):
        assert hivv._verdict_from_reply("SAFE") == "SAFE"

    def test_verdict_on_last_line(self):
        reply = "1. RISK: none\n2. WHAT: adds a flag\n3. VERDICT: REVIEW"
        assert hivv._verdict_from_reply(reply) == "REVIEW"

    def test_risky_wins_over_safe_when_both_present(self):
        reply = "Looks SAFE overall\nVERDICT: RISKY"
        assert hivv._verdict_from_reply(reply) == "RISKY"

    def test_trailing_prose_after_verdict_is_ignored(self):
        reply = "VERDICT: SAFE\nThis is because the change only adds output."
        assert hivv._verdict_from_reply(reply) == "SAFE"

    def test_empty_reply_is_unknown(self):
        assert hivv._verdict_from_reply("") == "UNKNOWN"
        assert hivv._verdict_from_reply("   ") == "UNKNOWN"
        assert hivv._verdict_from_reply(None) == "UNKNOWN"

    def test_unparseable_is_unknown_not_safe(self):
        """The dangerous default would be reading an unparseable answer as
        SAFE — that is how a real problem gets waved through."""
        assert hivv._verdict_from_reply("I am not sure, let me think about it") == "UNKNOWN"

    def test_case_insensitive(self):
        assert hivv._verdict_from_reply("verdict: safe") == "SAFE"
        assert hivv._verdict_from_reply("VERDICT: risky") == "RISKY"

    def test_prose_mentioning_safe_is_read(self):
        assert hivv._verdict_from_reply("This change is safe to apply.") == "SAFE"


class TestDiffCollection:
    def test_empty_diff_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        assert hivv._collect_diff() == ""

    def test_diff_is_collected(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("hello\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)
        (tmp_path / "a.txt").write_text("hello world\n")
        out = hivv._collect_diff()
        assert "hello world" in out

    def test_diff_is_truncated(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("x\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)
        (tmp_path / "a.txt").write_text("y" * 50000 + "\n")
        out = hivv._collect_diff(max_bytes=1000)
        assert len(out) < 5000, "an enormous diff must be truncated"
        assert "truncated" in out


class TestLocalGitState:
    def test_not_a_repo_is_handled(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        st = hivv._local_git_state()
        assert st["is_repo"] is False
        assert st["sha"] == ""
        assert st["ahead"] == 0 and st["behind"] == 0

    def test_repo_state_is_read(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "-b", "main", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("hi\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)
        st = hivv._local_git_state()
        assert st["is_repo"] is True
        assert st["branch"] == "main"
        assert len(st["sha"]) == 40
        assert st["short"] == st["sha"][:8]
        assert st["dirty"] == 0

    def test_uncommitted_files_counted(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "-b", "main", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("hi\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)
        (tmp_path / "b.txt").write_text("new\n")
        st = hivv._local_git_state()
        assert st["dirty"] == 1


class TestSyncIsReadOnly:
    """THE RULE: `hivv sync` must never change the tree.

    It reports drift. It never merges, never pushes, never resets, never
    checks out. A sync command that can lose work is a sync command nobody
    runs — because the one time it is wrong, it loses work.
    """

    def test_sync_source_has_no_mutating_git_calls(self):
        """Only actual git INVOCATIONS count — the prose says "github" and
        "git" all over, and a naive substring check would flag both."""
        src = CLI_PATH.read_text()
        start = src.index("def cmd_sync(args)")
        end = src.index("\ndef ", start + 10)
        body = src[start:end]
        # every _git(...) call in cmd_sync
        calls = re.findall(r'_git\(\s*([^)]*)\)', body)
        for call in calls:
            first = call.strip().split(",")[0].strip().strip('"\'')
            assert first in ("rev-parse", "status", "remote", "rev-list",
                             "log", "fetch"), (
                f"cmd_sync runs a mutating git command: {first}"
            )

    def test_sync_uses_only_read_git_subcommands(self):
        """The git invocations inside cmd_sync's helpers must be read-only."""
        src = CLI_PATH.read_text()
        start = src.index("def _local_git_state()")
        end = src.index("\ndef ", start + 10)
        body = src[start:end]
        for forbidden in ('"push"', '"merge"', '"reset"', '"checkout"',
                          '"pull"', '"commit"', '"rebase"', '"stash"',
                          '"apply"', '"am"'):
            assert forbidden not in body, (
                f"_local_git_state must not run {forbidden}"
            )

    def test_sync_does_not_write_files(self, tmp_path, monkeypatch):
        """Run it for real in a throwaway repo and prove nothing changed."""
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "-b", "main", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("hi\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)
        before = subprocess.run(["git", "status", "--porcelain"],
                                capture_output=True, text=True).stdout
        head_before = subprocess.run(["git", "rev-parse", "HEAD"],
                                     capture_output=True, text=True).stdout
        # stub the network so the test never touches GitHub
        monkeypatch.setattr(hivv, "_gh_get", lambda *a, **k: (
            200, {"sha": "0" * 40, "commit": {"message": "x"}}))
        import argparse
        try:
            hivv.cmd_sync(argparse.Namespace(fetch=False, check=False, quiet=True))
        except SystemExit:
            pass
        after = subprocess.run(["git", "status", "--porcelain"],
                               capture_output=True, text=True).stdout
        head_after = subprocess.run(["git", "rev-parse", "HEAD"],
                                    capture_output=True, text=True).stdout
        assert before == after, "hivv sync changed the working tree"
        assert head_before == head_after, "hivv sync moved HEAD"


class TestCommandsRegistered:
    def test_sync_is_registered(self):
        assert hivv.COMMANDS.get("sync") is not None

    def test_review_diff_is_registered(self):
        assert hivv.COMMANDS.get("review-diff") is not None

    def test_sync_parses_flags(self):
        p = hivv.build_parser()
        a = p.parse_args(["sync", "--fetch", "--check"])
        assert a.fetch is True and a.check is True

    def test_review_diff_parses_flags(self):
        p = hivv.build_parser()
        a = p.parse_args(["review-diff", "--staged", "--votes", "3"])
        assert a.staged is True and a.votes == 3

    def test_review_diff_file_is_repeatable(self):
        p = hivv.build_parser()
        a = p.parse_args(["review-diff", "--file", "a.py", "--file", "b.py"])
        assert len(a.file) == 2


class TestGithubHelpers:
    def test_gh_url_is_built_from_the_repo(self):
        assert hivv._gh_url("/commits/main") == \
            "https://api.github.com/repos/htmlfarmer/hivv/commits/main"

    def test_gh_get_never_sends_a_token(self):
        """No token means no secret to leak. The repo is public."""
        src = CLI_PATH.read_text()
        start = src.index("def _gh_get(")
        end = src.index("\ndef ", start + 10)
        body = src[start:end]
        assert "Authorization" not in body
        assert "token" not in body.lower() or "no token" in body.lower()
