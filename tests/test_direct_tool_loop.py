#!/usr/bin/env python3
"""tests/test_direct_tool_loop.py — the CLI's direct path must offer tools.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
2026-11-22: `hivv chat "whats the date today"` printed

    (direct → ashy:8090)
    I do not have access to real-time information, so I cannot tell you the
    current date.

The hive had a clock tool. The model never heard of it.

WHY: `hivv chat` tries a DIRECT connection to a bee first (it is much faster
than going through the hub), and that path sent only `{"model","messages",
"stream","max_tokens","repeat_penalty"}` — no `tools` field at all. So on
the direct path the model was offered NOTHING, and every tool in the catalog
was unreachable. The hub's tool loop never ran, because the hub was never
asked.

The CLI now runs its OWN tool loop on the direct path: it offers the hub's
tool schemas, collects the tool call, executes it on this machine (the local
hivv-tools server computes the cheap ones and proxies the rest to the hub),
feeds the result back and asks the bee again.

Run:
    python3 -m pytest tests/test_direct_tool_loop.py -q
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


def _load_cli():
    """Import the CLI module WITHOUT running main()."""
    spec = importlib.util.spec_from_file_location("hivv_cli_direct_loop", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


def _src() -> str:
    return CLI.read_text(encoding="utf-8", errors="replace")


class TestTheDirectPathOffersTools:
    """The payload must carry the toolkit, or the model can never call one."""

    def test_the_payload_attaches_tools(self):
        src = _src()
        assert 'payload_dict["tools"] = _tool_schemas_list' in src, (
            "the direct path does not attach the tool schemas — the model is "
            "offered nothing and answers \"I do not have access to real-time "
            "information\" about today's date")

    def test_the_schemas_come_from_the_hubs_catalog(self):
        src = _src()
        assert "_tool_schemas_list = _tool_schemas() if tools_running else None" in src

    def test_the_helpers_exist(self):
        mod = _load_cli()
        for fn in ("_merge_tool_call_deltas", "_run_tool_calls",
                   "_bee_tool_round", "_bee_chat_with_tools",
                   "_exec_tool_via_hub", "_format_tool_content"):
            assert hasattr(mod, fn), f"missing {fn}() — the direct path cannot run tools"

    def test_every_direct_chat_path_offers_tools(self):
        """hivv chat, hivv ask and hivv chat --local are all direct paths.

        Any one of them left out of this is a model that cannot answer
        "what's the date" — which is exactly how the bug was first seen.
        """
        src = _src()
        assert 'payload_dict["tools"] = _tool_schemas_list' in src, "hivv chat's direct path"
        assert 'payload_dict["tools"] = _ask_tools' in src, "hivv ask's direct path"
        assert 'body["tools"] = _local_tools' in src, "hivv chat --local's path"

    def test_each_direct_path_runs_a_tool_loop(self):
        src = _src()
        # every path must call the loop, not just attach the schemas
        assert src.count("_bee_chat_with_tools(") >= 3, (
            "attaching tools without running the loop leaves the model "
            "asking for a tool nobody executes")


class TestFragmentMerging:
    """A streamed tool call arrives in pieces; they must become one call."""

    def test_two_fragments_become_one_call(self):
        mod = _load_cli()
        calls = mod._merge_tool_call_deltas([
            {"index": 0, "id": "call_1", "type": "function",
             "function": {"name": "current_", "arguments": '{"a"'}},
            {"index": 0, "function": {"name": "time", "arguments": ':1}'}},
        ])
        assert len(calls) == 1
        assert calls[0]["function"]["name"] == "current_time"
        assert calls[0]["function"]["arguments"] == '{"a":1}'
        assert calls[0]["id"] == "call_1"

    def test_two_separate_calls_stay_separate(self):
        mod = _load_cli()
        calls = mod._merge_tool_call_deltas([
            {"index": 0, "id": "a", "function": {"name": "calculator", "arguments": "{}"}},
            {"index": 1, "id": "b", "function": {"name": "current_time", "arguments": "{}"}},
        ])
        assert [c["function"]["name"] for c in calls] == ["calculator", "current_time"]

    def test_garbage_is_ignored(self):
        mod = _load_cli()
        assert mod._merge_tool_call_deltas([None, "nope", 3]) == []
        assert mod._merge_tool_call_deltas(None) == []


class TestTheToolLoop:
    """The bee is asked again with the tool result until it stops asking."""

    def test_the_loop_runs_until_the_model_answers(self):
        mod = _load_cli()
        rounds = []

        def fake_round(url, messages, tools, max_tok, think_off):
            rounds.append(messages)
            if len(rounds) == 1:
                return "", [{"index": 0, "id": "c1", "type": "function",
                             "function": {"name": "calculator",
                                          "arguments": '{"expression":"6*7"}'}}]
            return "The answer is 42.", []

        mod._bee_tool_round = fake_round
        mod._run_tool_calls = lambda calls: [
            {"role": "tool", "tool_call_id": "c1", "content": "42"}]

        answer = mod._bee_chat_with_tools(
            "http://127.0.0.1:1/v1/chat/completions",
            [{"role": "user", "content": "what is 6 times 7"}],
            [], 1024, True)

        assert answer == "The answer is 42."
        assert len(rounds) == 2, "the bee must be asked a second time with the result"
        second = rounds[1]
        assert second[1]["role"] == "assistant" and second[1]["tool_calls"]
        assert second[2]["role"] == "tool" and second[2]["content"] == "42"

    def test_a_model_that_never_calls_a_tool_stops_immediately(self):
        mod = _load_cli()
        calls = []

        def fake_round(url, messages, tools, max_tok, think_off):
            calls.append(messages)
            return "just an answer", []

        mod._bee_tool_round = fake_round
        mod._run_tool_calls = lambda c: []
        answer = mod._bee_chat_with_tools("http://x", [{"role": "user", "content": "hi"}], [], 512, True)
        assert answer == "just an answer"
        assert len(calls) == 1, "no tool call means no second round"

    def test_a_broken_bee_does_not_hang(self):
        """An unreachable bee must end the loop, not spin on it."""
        mod = _load_cli()

        def boom(*a, **k):
            raise OSError("connection refused")

        mod._bee_tool_round = boom
        assert mod._bee_chat_with_tools("http://x", [], [], 512, True) == ""

    def test_the_loop_is_bounded(self):
        """A model that asks for a tool forever must stop."""
        mod = _load_cli()
        seen = []

        def always_asks(url, messages, tools, max_tok, think_off):
            seen.append(messages)
            return "", [{"index": 0, "id": "c", "type": "function",
                         "function": {"name": "calculator", "arguments": "{}"}}]

        mod._bee_tool_round = always_asks
        mod._run_tool_calls = lambda calls: [
            {"role": "tool", "tool_call_id": "c", "content": "1"}]
        mod._bee_chat_with_tools("http://x", [{"role": "user", "content": "q"}], [], 512, True)
        assert len(seen) <= 4, "the tool loop must be bounded"


class TestHubFallback:
    """A dead local tool server must not cost the model its tool."""

    def test_a_down_local_server_falls_back_to_the_hub(self, monkeypatch):
        mod = _load_cli()
        # a port nothing listens on → the local call fails
        monkeypatch.setattr(mod, "TOOLS_PORT", 1)

        def fake_http(method, path, *, body=None, token=None, timeout=15.0,
                      sign=True, base_url=None):
            assert method == "POST"
            assert "/api/tools/calculator/invoke" in path
            return 200, {"ok": True, "via": "hub",
                         "data": {"expression": "6*7", "result": 42}}

        monkeypatch.setattr(mod, "http", fake_http)
        res = mod._exec_tool_locally("calculator", {"expression": "6*7", "id": "c1"})
        assert res["tool_call_id"] == "c1"
        assert "42" in res["content"]

    def test_a_hub_maybe_becomes_an_honest_message(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(mod, "TOOLS_PORT", 1)
        monkeypatch.setattr(
            mod, "http",
            lambda *a, **k: (202, {"verdict": "MAYBE", "grant_id": "G_abc",
                                   "message": "approve with hivv approve G_abc"}))
        res = mod._exec_tool_locally("web_fetch", {"url": "https://x", "id": "c1"})
        assert "MAYBE" in res["content"]
        assert "G_abc" in res["content"]


class TestSchemaSource:
    def test_the_hub_catalog_wins(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(
            mod, "http",
            lambda *a, **k: (200, {"tools": [
                {"name": "calculator", "description": "d",
                 "parameters": {"type": "object", "properties": {}},
                 "advertised": True},
                {"name": "web_search", "description": "d",
                 "parameters": {"type": "object", "properties": {}},
                 "advertised": False},
            ]}))
        schemas = mod._tool_schemas()
        names = [s["function"]["name"] for s in schemas]
        assert names == ["calculator"], "an unadvertised tool must not be offered"

    def test_an_unreachable_hub_falls_back_to_the_static_list(self, monkeypatch):
        mod = _load_cli()

        def boom(*a, **k):
            raise OSError("no hub")

        monkeypatch.setattr(mod, "http", boom)
        schemas = mod._tool_schemas()
        assert schemas, "the static fallback list must not be empty"
        assert all(s["type"] == "function" for s in schemas)

    def test_the_offline_fallback_covers_the_whole_catalog(self, monkeypatch):
        """A bee with no uplink must still be offered every tool.

        The fallback used to be six tools (news, search, fetch, calculate,
        get_time, sysinfo) — so an offline bee lost the timezone converter,
        the parser, memory, files and translation entirely.
        """
        mod = _load_cli()

        def boom(*a, **k):
            raise OSError("no hub")

        monkeypatch.setattr(mod, "http", boom)
        names = {s["function"]["name"] for s in mod._tool_schemas()}
        for expected in ("web_search", "current_time", "calculator", "web_fetch",
                         "http_request", "code_interpreter", "file_read",
                         "file_search", "memory", "text_parser",
                         "timezone_convert", "translate", "sysinfo"):
            assert expected in names, f"the offline fallback is missing {expected}"

    def test_the_fallback_schemas_are_well_formed(self):
        mod = _load_cli()
        for s in mod._fallback_tool_schemas():
            fn = s["function"]
            assert fn["name"] and fn["description"]
            params = fn["parameters"]
            assert params["type"] == "object"
            for req in params.get("required", []):
                assert req in params["properties"], f"{fn['name']} requires {req} but never declares it"


class TestToolFormatting:
    """The line the model reads back must never contain None."""

    def test_the_local_clock_without_a_timezone(self, monkeypatch):
        mod = _load_cli()
        out = mod._format_tool_content("current_time", {"unix": 1, "human": "2026-11-23 03:00:00"})
        assert "None" not in out, out
        assert "2026-11-23 03:00:00" in out

    def test_the_hub_clock_with_a_timezone(self, monkeypatch):
        mod = _load_cli()
        out = mod._format_tool_content("current_time", {
            "human": "2026-11-23 08:00:00", "timezone": "Asia/Karachi",
            "utc_offset": "+05:00"})
        assert "Asia/Karachi" in out and "+05:00" in out
        assert "None" not in out, out

    def test_the_calculator_is_a_bare_number(self):
        mod = _load_cli()
        assert mod._format_tool_content("calculator", {"expression": "6*7", "result": 42}) == "42"


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
