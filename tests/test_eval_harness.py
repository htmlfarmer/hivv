#!/usr/bin/env python3
"""Regression tests: the eval study bench (hivv eval run).

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
2026-11-24: the hive can be invoked a dozen ways, but there was no
REPEATABLE way to STUDY it — golden questions across route modes, scored,
receipts kept, runs saved for comparison. And a new top-level command is
exactly the shape that falls into the smart-default trap: bare "hivv eval"
must be a chooser, never a chat message sent to the model.

The bench's contract:
  1. deterministic scoring (NO model-as-judge in v1 — a bench whose scores
     drift with the judge is not a bench),
  2. every run saved under STATE_DIR/evals/ so results compare over time,
  3. receipts (X-Hivv-Answered-By) recorded per case — you must know WHICH
     brain answered,
  4. bad suites die cleanly with what's wrong, never a traceback,
  5. --json is machine output; --strict makes failures exit non-zero.

Run:
    python3 -m pytest tests/test_eval_harness.py -q
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


def _load_cli():
    """Import the CLI module WITHOUT running main()."""
    spec = importlib.util.spec_from_file_location("hivv_cli_eval_under_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


def _args(**kw):
    class A:
        pass
    a = A()
    for k, v in kw.items():
        setattr(a, k, v)
    return a


def _answer_for(msg: str) -> str:
    """Deterministic perfect answers for the builtin suite."""
    if "HIVE-CANARY" in msg:
        return "HIVE-CANARY"
    if "17 * 23" in msg:
        return "391"
    if "15%" in msg:
        return "36"
    if "bat and a ball" in msg:
        return "0.05"
    if "JSON object" in msg:
        return '{"answer": 42}'
    if "today's date" in msg:
        return "2026-11-24"
    return "ok"


class _FakeHttp:
    """Canned /api/chat answers + receipts — no network in unit tests."""

    def __init__(self, answers=None, code=200, default=None):
        self.calls = []
        self.answers = answers or {}
        self.code = code
        self.default = default

    def __call__(self, method, path, *, body=None, token=None, timeout=15.0,
                 sign=True, base_url=None, with_headers=False):
        self.calls.append({"method": method, "path": path, "body": body})
        msg = (body or {}).get("message", "")
        if msg in self.answers:
            content = self.answers[msg]
        elif self.default is not None:
            content = self.default
        else:
            content = _answer_for(msg)
        resp = {"choices": [{"message": {"content": content}}]}
        hdrs = {"X-Hivv-Answered-By": "masjid/Qwen2.5-0.5B-Instruct-GGUF (direct)"}
        if with_headers:
            return self.code, resp, hdrs
        return self.code, resp


class TestParserAndDispatch:
    """eval must be wired as a command — and NEVER fall into smart-default."""

    def test_parser_wires_run_and_cases(self):
        mod = _load_cli()
        a = mod.build_parser().parse_args(
            ["eval", "run", "--modes", "smart,fast", "--repeat", "2",
             "--model", "gemma-4"])
        assert a.modes == "smart,fast" and a.repeat == 2
        assert a.model == "gemma-4"
        c = mod.build_parser().parse_args(["eval", "cases"])
        assert c.eval_action == "cases"

    def test_commands_registered(self):
        mod = _load_cli()
        for key in ("eval", "eval run", "eval cases"):
            assert callable(mod.COMMANDS.get(key)), f"COMMANDS[{key!r}] not wired"

    def test_bare_eval_is_a_chooser_not_chat(self, capsys):
        mod = _load_cli()
        mod.cmd_eval(None)
        out = capsys.readouterr().out
        assert "eval run" in out and "eval cases" in out

    def test_dispatch_never_sends_eval_to_the_model(self):
        """The smart-default trap: 'eval' as a bare word would be sent to
        the hive as a chat message. The dispatch must intercept it."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert 'cmd_name = "eval " + argv[1]' in src, "dispatch must map eval run/cases"
        assert "unknown eval action" in src, "a wrong action must fail LOUD, not chat"

    def test_sub_help_covers_eval(self, capsys):
        mod = _load_cli()
        mod._print_sub_help("eval run")
        assert "--modes" in capsys.readouterr().out

    def test_http_accepts_with_headers(self):
        mod = _load_cli()
        assert "with_headers" in inspect.signature(mod.http).parameters


class TestScoring:
    """Deterministic scoring — the bench's whole reason to exist."""

    def test_contains_and_not_contains(self):
        mod = _load_cli()
        assert mod._eval_score({"type": "contains", "value": "CANARY"},
                               "x HIVE-CANARY y")[0]
        assert not mod._eval_score({"type": "contains", "value": "CANARY"},
                                   "nothing")[0]
        assert mod._eval_score({"type": "not_contains", "value": "CANARY"},
                               "nothing")[0]

    def test_exact_is_case_insensitive_and_trimmed(self):
        mod = _load_cli()
        assert mod._eval_score({"type": "exact", "value": "done"}, "  Done \n")[0]
        assert not mod._eval_score({"type": "exact", "value": "done"}, "done!")[0]

    def test_regex_and_bad_pattern(self):
        mod = _load_cli()
        assert mod._eval_score({"type": "regex", "pattern": r"\b391\b"},
                               "the answer is 391")[0]
        assert not mod._eval_score({"type": "regex", "pattern": r"\b391\b"}, "39")[0]
        ok, why = mod._eval_score({"type": "regex", "pattern": "["}, "x")
        assert ok is False and "bad pattern" in why

    def test_numeric_matches_any_number_within_tolerance(self):
        mod = _load_cli()
        # prose around the number, echoed question text — any match wins
        assert mod._eval_score({"type": "numeric", "value": 36, "tolerance": 0.001},
                               "15% of 240 = 36")[0]
        assert mod._eval_score({"type": "numeric", "value": 0.05, "tolerance": 0.001},
                               "the ball costs $0.05")[0]
        assert not mod._eval_score({"type": "numeric", "value": 0.05, "tolerance": 0.001},
                                   "the ball costs 0.10")[0]
        ok, why = mod._eval_score({"type": "numeric", "value": 5}, "no numbers here")
        assert ok is False and "no number" in why

    def test_json_accepts_fences_and_rejects_prose(self):
        mod = _load_cli()
        assert mod._eval_score({"type": "json"}, '{"answer": 42}')[0]
        assert mod._eval_score({"type": "json"}, '```json\n{"answer": 42}\n```')[0]
        assert not mod._eval_score({"type": "json"}, "the answer is forty-two")[0]
        assert not mod._eval_score({"type": "json"}, '{"answer": ')[0]

    def test_unknown_type_is_a_suite_bug_not_a_crash(self):
        mod = _load_cli()
        ok, why = mod._eval_score({"type": "vibes"}, "x")
        assert ok is False and "unknown expect type" in why

    def test_builtin_suite_scores_its_own_perfect_answers(self):
        mod = _load_cli()
        suite = mod._eval_builtin_suite()
        assert suite["name"] == "builtin" and len(suite["cases"]) >= 5
        for c in suite["cases"]:
            ok, why = mod._eval_score(c["expect"], _answer_for(c["prompt"]))
            assert ok, f"{c['id']} must pass its own perfect answer: {why}"


class TestSuiteLoader:
    """Bad suites die CLEANLY with what's wrong — never a traceback."""

    def test_builtin_needs_no_file(self):
        mod = _load_cli()
        assert mod._eval_load_suite(None)["cases"]

    def test_file_suite_gets_name_and_ids(self, tmp_path):
        mod = _load_cli()
        p = tmp_path / "mine.json"
        p.write_text(json.dumps({"cases": [
            {"prompt": "say hi", "expect": {"type": "contains", "value": "hi"}}]}))
        s = mod._eval_load_suite(str(p))
        assert s["name"] == "mine"
        assert s["cases"][0]["id"] == "case-1"

    @pytest.mark.parametrize("payload,needle", [
        ("not json", "cannot read suite"),
        (json.dumps({"cases": []}), "non-empty"),
        (json.dumps({"cases": [{"prompt": "   ", "expect": {"type": "exact"}}]}),
         "prompt"),
        (json.dumps({"cases": [{"prompt": "x"}]}), "expect"),
    ])
    def test_bad_suites_die_cleanly(self, tmp_path, capsys, payload, needle):
        mod = _load_cli()
        p = tmp_path / "bad.json"
        p.write_text(payload)
        with pytest.raises(SystemExit):
            mod._eval_load_suite(str(p))
        assert needle in capsys.readouterr().err

    def test_missing_file_dies_cleanly(self, capsys):
        mod = _load_cli()
        with pytest.raises(SystemExit):
            mod._eval_load_suite("/nonexistent/suite.json")
        assert "cannot read suite" in capsys.readouterr().err


class TestRun:
    """The full loop with a faked transport: score, receipts, save."""

    def _run(self, mod, monkeypatch, tmp_path, *, modes="smart", **kw):
        http_kw = {k: kw.pop(k) for k in list(kw)
                   if k in ("json", "no_save", "strict")}
        fake = _FakeHttp(**kw)
        monkeypatch.setattr(mod, "http", fake)
        monkeypatch.setattr(mod, "STATE_DIR", tmp_path / "state")
        args = _args(suite=None, modes=modes, repeat=1, timeout=30, **http_kw)
        for d in ("json", "no_save", "strict"):
            if not hasattr(args, d):
                setattr(args, d, False)
        mod.cmd_eval_run(args)
        return fake

    def test_all_builtin_cases_pass_with_perfect_answers(
            self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        fake = self._run(mod, monkeypatch, tmp_path)
        out = capsys.readouterr().out
        assert "summary" in out
        assert "6/6" in out
        # smart is an alias — the wire must carry the expanded mode
        assert all(c["body"]["route"]["mode"] == "quality" for c in fake.calls)
        assert all(c["path"] == "/api/chat" and c["body"]["stream"] is False
                   for c in fake.calls)
        # receipts + answers recorded per case
        saved = list((tmp_path / "state" / "evals").glob("*.json"))
        assert saved, "every run must be saved for comparison"
        data = json.loads(saved[0].read_text())
        assert data["summary"]["quality"]["pass"] == 6
        assert data["results"][0]["answered_by"].startswith("masjid/")
        assert data["results"][0]["answer"]

    def test_modes_expand_aliases_and_dedupe(self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        fake = self._run(mod, monkeypatch, tmp_path, modes="smart,cheap,quality")
        capsys.readouterr()
        modes_seen = {c["body"]["route"]["mode"] for c in fake.calls}
        assert modes_seen == {"quality", "cost"}, modes_seen

    def test_json_mode_is_parseable_and_quiet(self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        self._run(mod, monkeypatch, tmp_path, json=True)
        out = capsys.readouterr().out
        data = json.loads(out)          # ONLY json on stdout
        assert data["suite"] == "builtin"
        assert len(data["results"]) == 6
        assert data["summary"]["quality"]["total"] == 6

    def test_failures_are_recorded_not_crashed(
            self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        self._run(mod, monkeypatch, tmp_path, default="totally wrong")
        out = capsys.readouterr().out
        assert "0/6" in out, "a fully-wrong run must still complete and score"

    def test_http_errors_become_failed_cases(self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        self._run(mod, monkeypatch, tmp_path, code=503)
        out = capsys.readouterr().out
        assert "HTTP 503" in out

    def test_strict_exits_nonzero_when_anything_fails(
            self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        fake = _FakeHttp(default="totally wrong")
        monkeypatch.setattr(mod, "http", fake)
        monkeypatch.setattr(mod, "STATE_DIR", tmp_path / "state")
        args = _args(suite=None, modes="smart", repeat=1, timeout=30,
                     json=False, no_save=True, strict=True)
        with pytest.raises(SystemExit) as ei:
            mod.cmd_eval_run(args)
        assert ei.value.code == 1

    def test_no_save_leaves_no_file(self, monkeypatch, tmp_path, capsys):
        mod = _load_cli()
        self._run(mod, monkeypatch, tmp_path, no_save=True)
        capsys.readouterr()
        assert not list((tmp_path / "state" / "evals").glob("*.json"))

    def test_model_pin_travels_on_the_wire_and_off(self, monkeypatch, tmp_path, capsys):
        """--model pins the router (preferredModel) so a study can target ONE
        brain — and an unpinned run must not carry a pin at all."""
        mod = _load_cli()
        fake = _FakeHttp()
        monkeypatch.setattr(mod, "http", fake)
        monkeypatch.setattr(mod, "STATE_DIR", tmp_path / "state")
        args = _args(suite=None, modes="smart", repeat=1, timeout=30,
                     model="gemma-4", json=False, no_save=True, strict=False)
        mod.cmd_eval_run(args)
        capsys.readouterr()
        assert fake.calls, "the run must have hit the transport"
        assert all(c["body"].get("model") == "gemma-4" for c in fake.calls)

        fake2 = _FakeHttp()
        monkeypatch.setattr(mod, "http", fake2)
        args2 = _args(suite=None, modes="smart", repeat=1, timeout=30,
                      model=None, json=False, no_save=True, strict=False)
        mod.cmd_eval_run(args2)
        capsys.readouterr()
        assert all("model" not in c["body"] for c in fake2.calls), (
            "no pin requested → the body must not carry one")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
