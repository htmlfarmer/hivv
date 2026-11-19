"""Tests for the `hivv ask` output modes: --json · --quiet · --details.

WHY THESE EXIST
The reply is the same in every mode — only the packaging differs:
  default   banner + streamed reply + timing footer (humans)
  --json    ONE JSON object on stdout, even on FAILURE — for AIs and
            scripts; no ANSI, no progress lines to parse around
  --quiet   reply TEXT ONLY — the mode an AI wants when it feeds the
            answer onward and tok/s noise would corrupt the pipeline
  --details the network transaction (endpoint, transport, thinking state,
            first-token, full timing) — what you want when something is
            SLOW and you need to know where the time went

Also pinned here: thinking is OFF by default in `ask` (the same rule
`hivv chat` uses). yalla's gemma is a reasoning model — with thinking on
it streams a `reasoning_content` preamble for ~11s before the first real
token, which IS the slowness users feel (first token 14.6s of a 16.0s
reply, 2026-11-19). The payload must carry
`chat_template_kwargs: {enable_thinking: false}` unless HIVV_THINK=1.

No network: the hub call and the LLM stream are both faked.
"""
import argparse
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli_ask", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_ask"] = hivv
spec.loader.exec_module(hivv)

import urllib.request  # noqa: E402  (patched globally in the fakes below)

BEE = {
    "id": "yalla", "name": "yalla", "lan_ip": "192.168.1.209", "ip": "192.168.1.209",
    "status": "online", "local_models": [{"port": 8080, "model": "m"}],
}


def sse_body():
    """A tiny streamed completion: role delta, two content deltas, done."""
    lines = [
        b'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        b'data: [DONE]\n\n',
    ]
    return lines


class FakeResponse:
    def __init__(self, lines):
        self._lines = lines

    def __iter__(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def fake_net(monkeypatch):
    """Hub + TCP + ports + stream: everything cmd_node_chat touches."""
    captured = {}

    def fake_http(method, path, **kw):
        if path == "/api/control/nodes":
            return 200, {"nodes": [dict(BEE)]}
        return 404, {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["payload"] = json.loads(req.data.decode())
        return FakeResponse(sse_body())

    monkeypatch.setattr(hivv, "http", fake_http)
    monkeypatch.setattr(hivv, "_tcp_ok", lambda *a, **k: True)
    monkeypatch.setattr(hivv, "_node_llm_ports", lambda n: [8080])
    monkeypatch.setattr(hivv, "_local_ip", lambda: "")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.delenv("HIVV_THINK", raising=False)
    return captured


def run_ask(monkeypatch, capsys, **kw):
    opts = {"json_output": False, "quiet": False, "details": False}
    opts.update(kw)                       # kwargs win, never collide
    args = argparse.Namespace(name="yalla", message=["hello"], **opts)
    hivv.cmd_node_chat(args)
    return capsys.readouterr()


class TestParserFlags:
    @pytest.mark.parametrize("verb", ["ask", "talk", "node-chat"])
    def test_all_three_verbs_have_the_modes(self, verb):
        p = hivv.build_parser()
        a = p.parse_args([verb, "yalla", "hi", "--json", "--quiet", "--details"])
        assert a.json_output is True
        assert a.quiet is True
        assert a.details is True

    def test_verbose_is_an_alias_for_details(self):
        p = hivv.build_parser()
        assert p.parse_args(["ask", "yalla", "hi", "--verbose"]).details is True

    def test_default_is_none_of_them(self):
        p = hivv.build_parser()
        a = p.parse_args(["ask", "yalla", "hi"])
        assert a.json_output is False and a.quiet is False and a.details is False


class TestJsonMode:
    def test_one_clean_json_object(self, fake_net, monkeypatch, capsys):
        out = run_ask(monkeypatch, capsys, json_output=True)
        d = json.loads(out.out)          # must parse — no banner mixed in
        assert d["ok"] is True
        assert d["bee"] == "yalla"
        assert d["transport"] == "direct"
        assert d["reply"] == "Hello"
        assert d["tokens"] == 2
        assert d["ttft_s"] is not None and d["ttft_s"] >= 0
        assert d["tok_per_s"] > 0
        assert d["endpoint"].endswith("/v1/chat/completions")

    def test_failure_is_json_too(self, monkeypatch, capsys):
        """A JSON consumer must never have to parse prose to learn it failed."""
        monkeypatch.setattr(hivv, "http", lambda *a, **k: (200, {"nodes": []}))
        args = argparse.Namespace(name="ghost", message=["hi"], json_output=True,
                                  quiet=False, details=False)
        with pytest.raises(SystemExit) as e:
            hivv.cmd_node_chat(args)
        assert e.value.code == 1
        d = json.loads(capsys.readouterr().out)
        assert d["ok"] is False
        assert "not found" in d["error"]

    def test_no_ansi_escapes_in_json(self, fake_net, monkeypatch, capsys):
        out = run_ask(monkeypatch, capsys, json_output=True)
        assert "\x1b[" not in out.out


class TestQuietMode:
    def test_reply_text_only(self, fake_net, monkeypatch, capsys):
        out = run_ask(monkeypatch, capsys, quiet=True)
        assert out.out == "Hello", (
            f"--quiet must be EXACTLY the reply, got {out.out!r}"
        )
        assert "\x1b[" not in out.out
        assert "tok/s" not in out.out
        assert "chatting with" not in out.out


class TestDetailsMode:
    def test_shows_the_transaction(self, fake_net, monkeypatch, capsys):
        out = run_ask(monkeypatch, capsys, details=True)
        assert "transaction" in out.out
        assert "endpoint" in out.out
        assert "192.168.1.209:8080" in out.out
        assert "first tok" in out.out
        assert "thinking" in out.out
        assert "Hello" in out.out


class TestThinkingOffByDefault:
    """The yalla slowness fix: a reasoning preamble of ~11s before the
    first content token — ask must not pay it unless asked to."""

    def test_payload_disables_thinking_by_default(self, fake_net, monkeypatch, capsys):
        run_ask(monkeypatch, capsys, json_output=True)
        kw = fake_net["payload"].get("chat_template_kwargs")
        assert kw == {"enable_thinking": False}, (
            "ask must send enable_thinking:false like hivv chat does"
        )

    def test_hivv_think_env_opts_back_in(self, fake_net, monkeypatch, capsys):
        monkeypatch.setenv("HIVV_THINK", "1")
        run_ask(monkeypatch, capsys, json_output=True)
        assert "chat_template_kwargs" not in fake_net["payload"], (
            "HIVV_THINK=1 must let the model think"
        )

    def test_details_reports_the_thinking_state(self, fake_net, monkeypatch, capsys):
        out = run_ask(monkeypatch, capsys, details=True)
        assert "thinking   off" in out.out


class TestSpeedLedgerCoercion:
    """`hivv speeds` crashed on its own data: provenance numeric columns
    arrive as STRINGS (pg numeric → JSON) and `sum(['1', '2'])` raised
    TypeError — in THREE places (summary, by-user, by-bee) because the
    coercion was applied at each read site and the rollup got missed.
    Now normalised ONCE on the rows; this runs the REAL cmd_speeds."""

    ROWS = [
        {"duration_ms": "100", "ttfb_ms": "50", "tokens_per_sec": "42",
         "principal": "u1", "answered_by_node": "masjid", "transport": "direct"},
        {"duration_ms": 300, "ttfb_ms": 120, "tokens_per_sec": 55,
         "principal": "u2", "answered_by_node": "masjid", "transport": "direct"},
        {"duration_ms": "200", "ttfb_ms": None, "tokens_per_sec": None,
         "principal": "u1", "answered_by_node": "yalla", "transport": "relay"},
    ]

    def _run(self, monkeypatch, capsys):
        def fake_http(method, path, **kw):
            if path.startswith("/api/provenance/requests"):
                return 200, {"data": {"rows": [dict(r) for r in self.ROWS]}}
            return 404, {}
        monkeypatch.setattr(hivv, "http", fake_http)
        args = argparse.Namespace(days=1, limit=50, json_output=True)
        hivv.cmd_speeds(args)
        return json.loads(capsys.readouterr().out)

    def test_string_numbers_do_not_crash_and_average_correctly(
            self, monkeypatch, capsys):
        d = self._run(monkeypatch, capsys)
        assert d["summary"]["requests"] == 3
        # (100 + 300 + 200) / 3 — strings and ints mixed must still average
        assert d["summary"]["avg_duration_ms"] == 200
        assert d["summary"]["avg_tokens_per_sec"] == 48.5   # (42+55)/2

    def test_rollups_survive_too(self, monkeypatch, capsys):
        """The by-user/by-bee rollups were the SECOND crash site — the
        coercion at read sites never reached them."""
        d = self._run(monkeypatch, capsys)
        by_user = {u["key"]: u for u in d["summary"]["by_user"]}
        assert by_user["u1"]["requests"] == 2
        assert by_user["u1"]["avg_duration_ms"] == 150      # (100+200)/2
        by_node = {n["key"]: n for n in d["summary"]["by_node"]}
        assert "masjid" in by_node and "yalla" in by_node
