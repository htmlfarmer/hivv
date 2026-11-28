#!/usr/bin/env python3
"""Discovery + surgery: `hivv help <anything>` (fuzzy search) and `hivv remove`.

THE FAILURES THIS GUARDS (2026-11-25):
  1. "we need a hivv help that searched for anything — hivv help ollama,
     hivv ollama help, people like --flag too" — before this, `hivv help
     ollama` printed the ROOT help (the `help` verb short-circuited to it)
     and `hivv ollama help` fell into the smart-default CHAT and talked to
     the model. Both now search the introspected parser index.
  2. "do we have a way to hivv remove — any aspect, or everything, and
     start a clean hivv" — before this there was only `uninstall` (CLI
     files only). `hivv remove` lists parts with sizes, shows EXACTLY what
     dies, and asks; a non-TTY without --yes refuses with NOTHING removed.

Both are subprocess tests against the REAL CLI, with every path env-overridden
into tmp — a test can never touch this box's real state, stop its agent, or
run `ollama rm --all` against the hive's models (PATH excludes ollama).

Run:
    python3 -m pytest tests/test_cli_discovery.py -q
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


def _run(args, env_extra=None, timeout=60):
    """Run the real CLI with isolation: stdin closed (non-TTY by definition),
    PATH stripped of /usr/local/bin (no ollama), and caller env overrides."""
    env = dict(os.environ)
    env["PATH"] = "/usr/bin:/bin"
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True, text=True, timeout=timeout, env=env,
        stdin=subprocess.DEVNULL,
    )


def _tmp_env(tmp_path):
    """Every destructive path points into tmp — nothing real is reachable."""
    return {
        "HIVV_STATE_DIR": str(tmp_path / "state"),
        "HIVV_CONFIG_DIR": str(tmp_path / "cfg"),
        "HIVV_INSTALL_DIR": str(tmp_path / "lib"),
        "HIVV_BIN_DIR": str(tmp_path / "bin"),
        "HOME": str(tmp_path / "home"),
    }


class TestHelpSearch:
    """hivv help <query> / hivv <anything> help / hivv --flag → search."""

    def test_help_finds_ollama(self):
        r = _run(["help", "ollama"])
        assert r.returncode == 0, r.stderr
        assert "hivv help — 'ollama'" in r.stdout
        assert "llm" in r.stdout, "the llm group must match an ollama query"

    def test_unknown_command_with_help_suffix_searches_not_chats(self):
        r = _run(["ollama", "help"])
        assert r.returncode == 0, r.stderr
        assert "hivv help — 'ollama'" in r.stdout
        assert "asking the hive" not in r.stdout, "must search, not chat"

    def test_flag_query_strips_dashes(self):
        """hivv help --model searches FLAG text (header echoes the raw query)."""
        r = _run(["help", "--model"])
        assert r.returncode == 0, r.stderr
        assert "hivv help — '--model'" in r.stdout, "header echoes what was typed"
        assert "match" in r.stdout, "must find matches for a real flag"
        # the search strips dashes: llm install/pull carry a --model flag
        assert "llm install" in r.stdout or "llm pull" in r.stdout

    def test_no_match_says_so_and_points_at_the_index(self):
        r = _run(["help", "zzznope-9876"])
        assert r.returncode == 0, r.stderr
        assert "no help matches" in r.stdout
        assert "hivv --help" in r.stdout

    def test_bare_help_is_still_root_help(self):
        r = _run(["help"])
        assert r.returncode == 0, r.stderr
        assert "hivv help — '" not in r.stdout, "bare help must NOT search"
        assert "subcommands" in r.stdout or "Operator" in r.stdout

    def test_help_submit_still_reaches_the_feedback_command(self):
        """The search branch must not shadow list/submit (it used to —
        the root-help short-circuit swallowed them whole)."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert 'argv[1] not in ("list", "submit")' in src, (
            "help list|submit must fall through to cmd_help, not search")

    def test_unknown_flag_searches_before_dying(self):
        r = _run(["--definitely-not-a-flag"])
        # search runs first; if nothing matches it dies loud (exit 1/2) —
        # either way it must NOT fall into the chat smart-default
        assert "asking the hive" not in (r.stdout + r.stderr)
        assert "no help matches" in (r.stdout + r.stderr) or "unknown flag" in (r.stdout + r.stderr)


class TestRemoveListAndRefusal:
    """Bare `hivv remove` lists; a non-TTY without --yes deletes NOTHING."""

    def test_bare_remove_lists_parts_with_sizes(self, tmp_path):
        env = _tmp_env(tmp_path)
        (tmp_path / "state").mkdir(parents=True)
        (tmp_path / "state" / "agent.log").write_text("x" * 100)
        r = _run(["remove"], env_extra=env)
        assert r.returncode == 0, r.stderr
        for part in ("llm", "models", "agent", "config", "logs", "state", "everything"):
            assert part in r.stdout, f"part {part!r} missing from the list"
        assert "[--yes]" in r.stdout
        # the planted log SURVIVES — listing never deletes
        assert (tmp_path / "state" / "agent.log").exists()

    def test_non_tty_without_yes_refuses_and_deletes_nothing(self, tmp_path):
        env = _tmp_env(tmp_path)
        st = tmp_path / "state"
        st.mkdir(parents=True)
        (st / "agent.log").write_text("keep me")
        (st / "state.json").write_text("{}")
        r = _run(["remove", "logs"], env_extra=env)
        assert r.returncode == 1, "a refused delete must exit non-zero"
        assert "--yes" in (r.stdout + r.stderr)
        assert (st / "agent.log").exists(), "refusal must delete NOTHING"
        assert (st / "state.json").exists()

    def test_unknown_part_lists_the_choices(self, tmp_path):
        r = _run(["remove", "bogus-part"], env_extra=_tmp_env(tmp_path))
        out = r.stdout + r.stderr
        assert "invalid choice" in out
        assert "everything" in out, "the error must show the valid parts"


class TestRemoveYesDeletesOnlyWhatWasAskedFor:
    """--yes in a non-TTY is the operator's explicit intent — scoped deletes."""

    def test_logs_yes_keeps_state_and_identity(self, tmp_path):
        env = _tmp_env(tmp_path)
        st = tmp_path / "state"
        (st / "identity").mkdir(parents=True)
        (st / "agent.log").write_text("log" * 1000)
        (st / "agent.log.1").write_text("rotated")
        (st / "state.json").write_text('{"node_id": "wahi"}')
        (st / "identity" / "key").write_text("SECRET")
        r = _run(["remove", "logs", "--yes"], env_extra=env)
        assert r.returncode == 0, r.stderr
        assert not (st / "agent.log").exists(), "the log must go"
        assert not (st / "agent.log.1").exists(), "rotated logs must go too"
        assert (st / "state.json").exists(), "state must be kept"
        assert (st / "identity" / "key").exists(), "identity keys must be kept"
        assert "state + identity kept" in r.stdout

    def test_config_yes_deletes_config_only(self, tmp_path):
        env = _tmp_env(tmp_path)
        cfg = tmp_path / "cfg"
        st = tmp_path / "state"
        cfg.mkdir(parents=True)
        (cfg / "settings.json").write_text("{}")
        st.mkdir(parents=True)
        (st / "state.json").write_text("{}")
        r = _run(["remove", "config", "--yes"], env_extra=env)
        assert r.returncode == 0, r.stderr
        assert not cfg.exists(), "config must go"
        assert st.exists(), "state must be untouched by config removal"

    def test_everything_cleans_the_plant_and_prints_the_reinstall_line(self, tmp_path):
        env = _tmp_env(tmp_path)
        # plant every component
        st = tmp_path / "state"; (st / "identity").mkdir(parents=True)
        (st / "state.json").write_text("{}"); (st / "agent.log").write_text("x")
        (st / "identity" / "key").write_text("k")
        cfg = tmp_path / "cfg"; cfg.mkdir(parents=True); (cfg / "s.json").write_text("{}")
        home = tmp_path / "home"; home.mkdir(parents=True)
        llama = home / "llama.cpp"; (llama / "models").mkdir(parents=True)
        (llama / "models" / "m.gguf").write_bytes(b"0" * 4096)
        lib = tmp_path / "lib"; lib.mkdir(parents=True); (lib / "hivv-cli.py").write_text("# cli")
        binp = tmp_path / "bin"; binp.mkdir(parents=True); (binp / "hivv").write_text("# wrapper")
        r = _run(["remove", "everything", "--yes"], env_extra=env)
        assert r.returncode == 0, r.stderr + r.stdout
        assert not st.exists(), "state must be gone"
        assert not cfg.exists(), "config must be gone"
        assert not llama.exists(), "llama.cpp tree must be gone"
        assert not (lib / "hivv-cli.py").exists(), "cli file must be gone"
        assert not (binp / "hivv").exists(), "wrapper must be gone"
        # no live agent in the tmp state → no service stops were attempted
        assert "skipping service stops" in r.stdout or "agent not running" in r.stdout
        assert "start over" in r.stdout, "a clean hivv must say how to start over"
        assert "install-hivv.sh" in r.stdout

    def test_everything_refuses_without_yes_in_non_tty(self, tmp_path):
        env = _tmp_env(tmp_path)
        st = tmp_path / "state"; st.mkdir(parents=True)
        (st / "state.json").write_text("{}")
        r = _run(["remove", "everything"], env_extra=env)
        assert r.returncode == 1
        assert st.exists(), "nothing may die without --yes off-TTY"
        assert "--yes" in (r.stdout + r.stderr)


class TestRemoveSafetyRails:
    """Unit rails: _rm_tree never eats / or $HOME, whatever pointed at them."""

    @staticmethod
    def _load():
        import importlib.util
        spec = importlib.util.spec_from_file_location("hivv_cli_rm_test", CLI)
        mod = importlib.util.module_from_spec(spec)
        saved = sys.argv
        sys.argv = ["hivv"]
        try:
            spec.loader.exec_module(mod)
        except SystemExit:
            pass
        finally:
            sys.argv = saved
        return mod

    def test_rm_tree_refuses_root_and_home(self, tmp_path):
        mod = self._load()
        assert mod._rm_tree("/") is False
        assert mod._rm_tree(str(Path.home())) is False
        # and a planted tree under tmp dies just fine
        victim = tmp_path / "victim"
        victim.mkdir()
        (victim / "f.txt").write_text("x")
        assert mod._rm_tree(str(victim)) is True
        assert not victim.exists()


class TestSmartDefaultDispatch:
    """A quoted SENTENCE must reach the hive; a lone typo must not.

    THE BUG THIS GUARDS (reported from a MacBook Air, 2026-11-28)
    ──────────────────────────────────────────────────────────────
    The rule counted ARGUMENTS, not words — and the shell folds a quoted
    phrase into ONE element. So the natural thing to type

        hivv "whats up in pakistan"

    was rejected with "isn't an hivv command", while the SAME words
    unquoted (four arguments) chatted fine. Quoting broke it; not quoting
    worked. Exactly backwards.

    Both halves still hold: a lone typo (hivv frobnicate) fails loud and
    never spends a call, and greetings/questions still go to the hive.
    """

    def _load(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("hivv_cli_dispatch_test", CLI)
        mod = importlib.util.module_from_spec(spec)
        saved = sys.argv
        sys.argv = ["hivv"]
        try:
            spec.loader.exec_module(mod)
        except SystemExit:
            pass
        finally:
            sys.argv = saved
        return mod

    # ── the predicate, in isolation ────────────────────────────────────

    def test_a_quoted_sentence_is_not_a_stray_word(self):
        mod = self._load()
        # the reported case, and its longer sibling
        assert mod._is_stray_command_word(["whats up"]) is False
        assert mod._is_stray_command_word(["whats up in pakistan"]) is False

    def test_a_lone_typo_still_fails_loud(self):
        mod = self._load()
        for word in ("frobnicate", "if", "when", "blorb", "statuss"):
            assert mod._is_stray_command_word([word]) is True, word

    def test_greetings_and_questions_still_chat(self):
        mod = self._load()
        assert mod._is_stray_command_word(["hello"]) is False
        assert mod._is_stray_command_word(["whats up?"]) is False

    def test_several_arguments_are_always_a_sentence(self):
        mod = self._load()
        assert mod._is_stray_command_word(["whats", "up"]) is False
        assert mod._is_stray_command_word([]) is False   # bare hivv -> help

    # ── end to end, against the REAL CLI ───────────────────────────────
    # The hub is pointed at a dead port so the chat path fails fast (~0.3s)
    # with no network and no tools server — we are asserting WHICH branch
    # the dispatch took, not what the model said.

    def _dead_hub_env(self, tmp_path):
        env = _tmp_env(tmp_path)
        env["HIVV_HUB"] = "http://127.0.0.1:1"
        return env

    def test_quoted_question_reaches_chat_not_the_rejector(self, tmp_path):
        r = _run(["whats up in pakistan"],
                 env_extra=self._dead_hub_env(tmp_path))
        out = r.stdout + r.stderr
        assert "isn't an hivv command" not in out, (
            "a quoted SENTENCE was rejected as a stray word:\n" + out)
        assert "asking the hive instead" in out, (
            "a quoted question must go to the hive:\n" + out)

    def test_the_reported_two_word_question_reaches_chat(self, tmp_path):
        r = _run(["whats up"], env_extra=self._dead_hub_env(tmp_path))
        out = r.stdout + r.stderr
        assert "isn't an hivv command" not in out, out
        assert "asking the hive instead" in out, out

    def test_stray_word_still_exits_2_with_the_hint(self, tmp_path):
        r = _run(["frobnicate"], env_extra=self._dead_hub_env(tmp_path))
        out = r.stdout + r.stderr
        assert r.returncode == 2, f"expected exit 2, got {r.returncode}\n{out}"
        assert "isn't an hivv command" in out, out
        # and it must point at the door it refused to open
        assert 'hivv chat "' in out, out

    def test_a_real_command_is_never_mistaken_for_chat(self, tmp_path):
        # regression guard for the other direction: the new space check must
        # not swallow actual commands (they are dispatched BEFORE this rule).
        r = _run(["status"], env_extra=self._dead_hub_env(tmp_path))
        out = r.stdout + r.stderr
        assert "asking the hive instead" not in out, out
        assert "isn't an hivv command" not in out, out


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))

