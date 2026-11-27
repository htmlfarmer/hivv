#!/usr/bin/env python3
"""The `hivv git` verbs, and the rails they carry.

`hivv git` is not a git mirror. Every verb adds a rule this repository
already states:

  * never push main
  * a moved or renamed file wants a MOVES.md entry in the SAME commit
  * the commit message is type(scope): what changed
  * a clone must not hang because a global URL rewrite sent it to SSH

These tests pin the RAILS, because a rail that quietly stops firing is
worse than no rail: the contributor believes they are covered and is not.

Run:
    python3 tests/test_git_verbs.py
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"

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


def load_cli():
    spec = importlib.util.spec_from_file_location("hivv_git_verbs_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def run(mod, args, cwd):
    return mod.subprocess.run(
        [sys.executable, str(CLI)] + args, cwd=str(cwd),
        capture_output=True, text=True, timeout=120,
    )


def git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=str(cwd),
                          capture_output=True, text=True, timeout=60)


def main() -> int:
    mod = load_cli()

    # ── the message convention ────────────────────────────────────────────
    check("a conventional message is accepted",
          mod._git_msg_ok("fix(scope): what changed"))
    check("a conventional message without a scope is accepted",
          mod._git_msg_ok("merge: stage 2"))
    check("a bare sentence is not",
          not mod._git_msg_ok("just some words"))
    check("a type with no summary is not",
          not mod._git_msg_ok("fix(scope):"))
    check("an unknown type is not",
          not mod._git_msg_ok("wibble(scope): what"))
    check("an empty message is not",
          not mod._git_msg_ok(""))

    # ── the parser ────────────────────────────────────────────────────────
    parser = mod.build_parser()
    verbs = None
    for action in parser._subparsers._group_actions if hasattr(parser._subparsers, "_group_actions") else []:
        pass
    # find the git subparser's choices
    import argparse
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            git_p = action.choices.get("git")
            if git_p is not None:
                verbs = git_p
    check("the git subparser exists", verbs is not None)
    if verbs is not None:
        choices = None
        for action in verbs._actions:
            if action.dest == "git_verb":
                choices = action.choices
        check("the verbs are the ones we ship",
              set(choices or []) == {"status", "clone", "branch", "commit",
                                     "push", "pr", "log", "diff"},
              str(sorted(choices or [])))
        check("there is deliberately NO merge verb",
              "merge" not in (choices or []),
              "merging goes through a PR")

    # ── the rails, in a real repo ─────────────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="hivv-git-verbs-") as td:
        repo = Path(td) / "repo"
        repo.mkdir()
        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.email", "t@example")
        git(repo, "config", "user.name", "T")
        (repo / "a.txt").write_text("hello\n")
        (repo / "old.txt").write_text("old\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "init")

        # status
        r = run(mod, ["git", "status"], repo)
        check("status works", r.returncode == 0, r.stderr[-200:])
        check("status names the branch", "main" in r.stdout)

        # a checkout with NO origin must not report git's error as the remote
        check("a missing origin is not reported as a remote",
              "No such remote" not in r.stdout, r.stdout[-200:])

        # branch rails
        r = run(mod, ["git", "branch", "main"], repo)
        check("a branch named main is refused", r.returncode != 0)
        check("the refusal says why", "topic branch" in (r.stdout + r.stderr))
        r = run(mod, ["git", "branch", "feature-x"], repo)
        check("a topic branch is created", r.returncode == 0, r.stderr[-200:])

        # commit rails: the message convention
        (repo / "a.txt").write_text("changed\n")
        git(repo, "add", "-A")
        r = run(mod, ["git", "commit", "-m", "just some words"], repo)
        check("a non-conventional message warns",
              "type(scope)" in (r.stdout + r.stderr), (r.stdout + r.stderr)[-200:])

        # commit rails: the MOVES.md rule
        git(repo, "mv", "old.txt", "new.txt")
        git(repo, "add", "-A")
        r = run(mod, ["git", "commit", "-m", "refactor(x): move a file"], repo)
        check("a move without a MOVES.md entry warns",
              "MOVES.md" in (r.stdout + r.stderr), (r.stdout + r.stderr)[-300:])

        # commit rails: nothing staged
        r = run(mod, ["git", "commit", "-m", "fix(x): nothing"], repo)
        check("an empty commit is refused",
              r.returncode != 0 and "nothing staged" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])

        # push rails
        git(repo, "checkout", "-q", "main")
        r = run(mod, ["git", "push"], repo)
        check("pushing main is refused",
              r.returncode != 0 and "main" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])
        git(repo, "checkout", "-q", "feature-x")

    print()
    print(f"  {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
