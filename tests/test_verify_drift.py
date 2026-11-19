"""Tests for `hivv verify` (run the shipped suite against YOUR changes) and
the periodic GitHub drift check (the agent's self-repair loop).

WHY `hivv verify` EXISTS
The test suite ships with the repo (500+ checks, also run by CI on every
push). It answers the question a fork must answer before it ships: "I
modified the code — did I break anything?" Without it, every customisation
is a leap of faith. With it, a change either passes the same gate the
original passes, or it does not — and the failing test says exactly what
broke.

Two failure modes are pinned here:
  • an installed CLI (no repo) must EXPLAIN itself, not crash
  • `hivv verify` must not be fooled by a `tests/` directory that is not
    the repo's (an installed prefix could have one by coincidence —
    running the wrong suite would report a false verdict)

WHY THE DRIFT CHECK EXISTS
`hivv sync` answers on demand; the point of a drift check is that it
happens WITHOUT anyone asking. The 2026-11-18 merge was painful precisely
because nobody noticed the two copies had diverged. Its safety rules
(never merges, never raises, no network for the local half) are pinned.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli"] = hivv
spec.loader.exec_module(hivv)


class TestFindRepoRoot:
    def test_finds_this_repo(self):
        found = hivv._find_repo_root()
        assert found is not None
        assert (found / "tests").is_dir()
        assert (found / ".git").exists()

    def test_no_repo_is_none(self, tmp_path, monkeypatch):
        """A directory with tests/ but no .git is NOT the repo — running
        the wrong suite would report a false verdict.

        chdir matters: _find_repo_root also probes the CWD (so an
        INSTALLED CLI can find the clone the user is standing in), and
        without leaving the real repo the cwd probe would find it."""
        (tmp_path / "tests").mkdir()
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(hivv, "__file__", str(tmp_path / "hivv-cli.py"))
        assert hivv._find_repo_root() is None

    def test_bare_tests_dir_without_git_is_none(self, tmp_path, monkeypatch):
        (tmp_path / "tests").mkdir()
        (tmp_path / "tests" / "test_x.py").write_text("")
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(hivv, "__file__", str(tmp_path / "hivv-cli.py"))
        assert hivv._find_repo_root() is None

    def test_installed_cli_finds_the_clone_via_cwd(self, tmp_path, monkeypatch):
        """THE developer flow: the CLI runs from an install prefix
        (~/.local/lib/hivv — no .git above it) while the user is cd'd into
        their clone. Without the cwd probe this refused with 'no repo
        found' even though the clone was right there."""
        monkeypatch.chdir(REPO)                       # standing in the clone
        monkeypatch.setattr(hivv, "__file__",
                            str(tmp_path / "prefix" / "lib" / "hivv" / "hivv-cli.py"))
        found = hivv._find_repo_root()
        assert found is not None
        assert (found / "public_html" / "hivv-cli.py").exists()

    def test_unrelated_repo_is_never_mistaken_for_ours(self, tmp_path, monkeypatch):
        """The cwd probe must only accept an HIVV repo — standing in some
        other project must not make us run the wrong suite."""
        other = tmp_path / "other-project"
        (other / ".git").mkdir(parents=True)
        (other / "tests").mkdir()
        (other / "tests" / "test_x.py").write_text("")
        monkeypatch.chdir(other)
        monkeypatch.setattr(hivv, "__file__", str(tmp_path / "noinstall" / "hivv-cli.py"))
        assert hivv._find_repo_root() is None


class TestVerifyCommand:
    def test_registered(self):
        assert hivv.COMMANDS.get("verify") is not None

    def test_parser_flags(self):
        p = hivv.build_parser()
        a = p.parse_args(["verify", "--diff", "--review"])
        assert a.diff is True and a.review is True

    def test_verify_without_flags(self):
        p = hivv.build_parser()
        a = p.parse_args(["verify"])
        assert a.diff is False and a.review is False

    def test_verify_explains_when_there_is_no_repo(self, tmp_path, monkeypatch):
        """An installed CLI has no tree — say so with the fix, not a crash."""
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: None)
        import argparse
        with pytest.raises(SystemExit) as e:
            hivv.cmd_verify(argparse.Namespace(diff=False, review=False))
        assert e.value.code != 0

    @pytest.mark.skipif(os.environ.get("HIVV_VERIFY_RUNNING") == "1",
                        reason="already inside a `hivv verify` run — "
                               "re-entering would recurse forever")
    def test_verify_passes_on_this_repo(self):
        """The suite the CLI runs must be the suite that passes — a verify
        command that always fails (or always passes) is worthless.

        GUARD: this test spawns `hivv verify`, which runs the suite, which
        includes this test. Without the skipif above it would recurse
        forever (it did — the first run hung)."""
        r = subprocess.run([sys.executable, str(CLI_PATH), "verify"],
                           capture_output=True, text=True, timeout=900,
                           cwd=str(REPO))
        assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
        assert "VERIFIED" in r.stdout

    def test_verify_reports_failure_as_nonzero(self, tmp_path, monkeypatch):
        """A broken test must produce a non-zero exit — that is the whole
        contract of the command."""
        # a fake repo with one failing test
        repo = tmp_path / "repo"
        (repo / "tests").mkdir(parents=True)
        (repo / ".git").mkdir()
        (repo / "tests" / "test_broken.py").write_text(
            "def test_fails():\n    assert False, 'intentional'\n")
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: repo)
        import argparse
        with pytest.raises(SystemExit) as e:
            hivv.cmd_verify(argparse.Namespace(diff=False, review=False))
        assert e.value.code != 0


class TestSyncDriftCheck:
    """The agent's periodic drift check — read-only, never raises."""

    def test_never_raises_on_a_non_repo(self, tmp_path, monkeypatch):
        log = tmp_path / "agent.log"
        fixes = []
        monkeypatch.chdir(tmp_path)  # no .git here
        hivv._sync_drift_check(log, fixes)   # must not raise
        assert fixes == []

    def test_never_raises_on_a_broken_log(self, tmp_path):
        """A Path, a closed handle, a bad path — the log is an aid."""
        fixes = []
        # a Path works (tested), so does a nonsense object
        hivv._sync_drift_check(object(), fixes)  # must not raise

    def test_records_drift_state(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "-b", "main", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("hi\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)
        # a fresh repo has no origin/main — the check has nothing to compare
        # against and returns early. Real clones always have it; make one.
        subprocess.run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"],
                       check=True)
        # ...and one genuinely uncommitted change for the dirty count
        (tmp_path / "b.txt").write_text("uncommitted\n")

        # isolate state
        state = tmp_path / "state"
        state.mkdir()
        monkeypatch.setattr(hivv, "STATE_DIR", state)
        monkeypatch.setattr(hivv, "STATE_FILE", state / "state.json")

        log = tmp_path / "agent.log"
        hivv._sync_drift_check(log, [])
        st = hivv.read_state()
        assert "sync_drift" in st, "the check must record what it found"
        assert st["sync_drift"]["ahead"] == 0
        assert st["sync_drift"]["behind"] == 0
        assert st["sync_drift"]["dirty"] == 1

    def test_never_mutates_the_tree(self, tmp_path, monkeypatch):
        """READ-ONLY: it must never merge, pull, push or reset. A drift
        check that changes things is a drift check nobody trusts."""
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init", "-q", "-b", "main", "."], check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "config", "user.name", "t"], check=True)
        (tmp_path / "a.txt").write_text("hi\n")
        subprocess.run(["git", "add", "a.txt"], check=True)
        subprocess.run(["git", "commit", "-qm", "init"], check=True)

        head_before = subprocess.run(["git", "rev-parse", "HEAD"],
                                     capture_output=True, text=True).stdout
        status_before = subprocess.run(["git", "status", "--porcelain"],
                                       capture_output=True, text=True).stdout

        state = tmp_path / "state"
        state.mkdir()
        monkeypatch.setattr(hivv, "STATE_DIR", state)
        monkeypatch.setattr(hivv, "STATE_FILE", state / "state.json")
        # no origin → fetch fails quietly, the local half still runs
        hivv._sync_drift_check(tmp_path / "agent.log", [])

        head_after = subprocess.run(["git", "rev-parse", "HEAD"],
                                    capture_output=True, text=True).stdout
        status_after = subprocess.run(["git", "status", "--porcelain"],
                                      capture_output=True, text=True).stdout
        assert head_before == head_after, "the check moved HEAD"
        assert status_before == status_after, "the check changed the tree"

    def test_source_is_read_only(self):
        """Static pin: no mutating git subcommand inside the checker."""
        src = CLI_PATH.read_text()
        start = src.index("def _sync_drift_check(")
        end = src.index("\ndef ", start + 10)
        body = src[start:end]
        for forbidden in ('"push"', '"merge"', '"reset"', '"checkout"',
                          '"pull"', '"commit"', '"rebase"', '"stash"'):
            assert forbidden not in body, (
                f"_sync_drift_check must not run {forbidden}"
            )
        # fetch is allowed but must be quiet + timeout-bounded
        assert '"fetch"' in body, "the periodic refresh should fetch"
        assert "timeout=" in body, "the fetch must be timeout-bounded"


class TestSelfRepairWiresTheCheck:
    def test_self_repair_calls_the_drift_check(self):
        src = CLI_PATH.read_text()
        assert "_sync_drift_check(log_path, fixes)" in src, (
            "the periodic check must be wired into the agent's self-repair loop"
        )

    def test_wiring_is_exception_guarded(self):
        """A broken git must not break self-repair — the loop that keeps
        the box alive must never die because of an advisory check."""
        src = CLI_PATH.read_text()
        start = src.index("_sync_drift_check(log_path, fixes)")
        # the try is BEFORE the call, the except AFTER it — window both sides
        guard = src[max(0, start - 400):start + 400]
        assert "try:" in guard, "the drift check call must be inside a try"
        assert "except Exception" in guard, (
            "the drift check call must be inside a try/except"
        )
