"""Tests for `hivv prefs` — the per-principal routing defaults (K3/K4).

WHY THESE EXIST
A request's own --mode always wins, so without a stored default every chat
started at "balanced" and the only way to say "just answer from my bee" was
to remember a flag every single time. `hivv prefs` stores the default ONCE,
per VERIFIED identity, and `privacy self` is the "only when I talk" switch.

Pinned here (in-process against the real CLI module, no network):
  * the command is dispatched (never swallowed by the chat smart-default),
  * every action builds the RIGHT body for PUT /api/prefs,
  * show renders the three things that matter (mode · privacy · self bees),
  * the hub's NO_IDENTITY refusal reaches the human with its hint.
"""
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("hivv_cli_prefs", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_prefs"] = hivv
spec.loader.exec_module(hivv)


def _args(**over):
    base = dict(action=None, values=[])
    base.update(over)
    return SimpleNamespace(**base)


def _run(args, response):
    """Run cmd_prefs with http() faked; return (stdout, captured call)."""
    captured = {}

    def fake_http(method, path, *, body=None, **kw):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        code, payload = response
        return code, json.loads(json.dumps(payload))

    orig = hivv.http
    hivv.http = fake_http
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            hivv.cmd_prefs(args)
    finally:
        hivv.http = orig
    return buf.getvalue(), captured


SHOW_OK = (200, {
    "scopes": ["node:ashy"],
    "defaults": {"mode": "fast", "privacy": "self"},
    "by_scope": {"node:ashy": {"mode": "fast", "privacy": "self"}},
    "self_nodes": ["ashy"],
})

PUT_OK = (200, {
    "ok": True, "scope": "node:ashy",
    "defaults": {"mode": "fast"}, "self_nodes": [],
})

NO_IDENTITY = (403, {
    "error": "prefs need a verified identity", "code": "NO_IDENTITY",
    "hint": "set prefs from a logged-in session, a browser with the hivv_visitor cookie, or a registered bee (hivv start)",
})


def test_prefs_is_dispatched_not_swallowed_by_chat():
    """'prefs' must be a real command — the smart-default eats strays."""
    cmd = hivv.COMMANDS.get("prefs")
    assert cmd is not None, "prefs must be dispatched, never chat-fallback"
    name = getattr(cmd, "__name__", cmd)
    assert name == "cmd_prefs"


def test_help_documents_the_command_offline():
    import subprocess
    proc = subprocess.run(
        [sys.executable, str(CLI_PATH), "prefs", "--help"],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "set" in proc.stdout and "privacy" in proc.stdout and "self" in proc.stdout
    assert "always wins" in proc.stdout, "the pref-vs-flag contract is the point"


def test_show_reads_and_renders_the_three_fields():
    out, call = _run(_args(), SHOW_OK)
    assert call["method"] == "GET" and call["path"] == "/api/prefs"
    assert "node:ashy" in out
    assert "fast" in out and "self" in out and "ashy" in out


def test_set_mode_sends_exactly_the_mode():
    out, call = _run(_args(action="set", values=["fast"]), PUT_OK)
    assert call["method"] == "PUT"
    assert call["body"] == {"mode": "fast"}
    assert "prefs saved" in out


def test_set_mode_off_clears_it():
    _out, call = _run(_args(action="set", values=["off"]), PUT_OK)
    assert call["body"] == {"mode": None}


def test_privacy_self_and_off():
    _out, call = _run(_args(action="privacy", values=["self"]), PUT_OK)
    assert call["body"] == {"privacy": "self"}
    _out2, call2 = _run(_args(action="privacy", values=["off"]), PUT_OK)
    assert call2["body"] == {"privacy": None}


def test_self_replaces_the_claim_list_and_off_releases():
    _out, call = _run(_args(action="self", values=["ashy", "yalla"]), PUT_OK)
    assert call["body"] == {"self_nodes": ["ashy", "yalla"]}
    _out2, call2 = _run(_args(action="self", values=["off"]), PUT_OK)
    assert call2["body"] == {"self_nodes": []}


def test_clear_wipes_everything():
    _out, call = _run(_args(action="clear"), PUT_OK)
    assert call["body"] == {"mode": None, "privacy": None, "self_nodes": []}


def test_unknown_action_dies_with_usage_not_chat():
    """An unknown action must die LOUDLY with usage — never fall into chat."""
    from contextlib import redirect_stderr
    out, err = io.StringIO(), io.StringIO()
    with pytest.raises(SystemExit):
        with redirect_stdout(out), redirect_stderr(err):
            hivv.cmd_prefs(_args(action="yeet"))
    msg = err.getvalue()
    assert "unknown prefs action" in msg
    assert "set MODE" in msg, "the usage line names every action"
    assert "chat" not in out.getvalue().lower(), "nothing was sent to the LLM"


def test_no_identity_refusal_shows_the_hint():
    out, _call = _run(_args(), NO_IDENTITY)
    assert "could not read prefs" in out
    assert "registered bee (hivv start)" in out, "the hint reaches the human"
