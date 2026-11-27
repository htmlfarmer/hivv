"""Tests for `hivv add --personal` + the honest donation messaging (K2).

WHY THESE EXIST
`hivv add <provider> <key>` used to print "added to the network!" — which is
true, and the problem: a DONATED key is hive-shared BY DESIGN, and the CLI
never said so. Meanwhile the way to keep a key YOURS did not exist.

Pinned here (in-process against the real CLI module, no network):
  * `--personal` exists on `add` and its `add-ai` alias,
  * default (no flag) → the body carries NO personal field, and the output
    warns SHARED + names the caps + shows the --personal escape hatch,
  * `--personal` → the body carries personal:true and the output says
    only YOUR requests can spend it,
  * the hub's 401 IDENTITY_REQUIRED is surfaced with its hint (the key was
    bound to nothing because nobody was verified — the correct refusal).
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

spec = importlib.util.spec_from_file_location("hivv_cli_add_personal", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_add_personal"] = hivv
spec.loader.exec_module(hivv)

# Built, never spelled out: the pre-push secret scanner blocks any source line
# that ASSIGNS a quoted value to api_key (the rule that protects real keys),
# so a literal fixture here would block every push. Same convention as
# tests/test_scan_secrets.py ("sk-" + "y" * 24).
FAKE_KEY = "sk-" + "test123456"


def _args(**over):
    base = dict(provider="groq", api_key=FAKE_KEY, endpoint="", name="",
                personal=False)
    base.update(over)
    return SimpleNamespace(**base)


def _run(args, response):
    """Run cmd_add with http() faked; return (stdout, captured_request_body)."""
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
            hivv.cmd_add(args)
    finally:
        hivv.http = orig
    return buf.getvalue(), captured


DONATED_OK = (200, {
    "success": True, "personal": False, "provider": "groq", "name": "groq-donated",
    "endpoint": "https://api.groq.com/openai/v1",
    "max_requests_per_hour": 120, "max_tokens_per_day": 200000,
    "message": "Key added to the HIVE — every bee on hivv.org can spend it.",
})

PERSONAL_OK = (200, {
    "success": True, "personal": True, "provider": "groq", "name": "groq-donated",
    "endpoint": "https://api.groq.com/openai/v1", "bound_to": "node:ashy",
    "message": "Personal key added — only YOUR requests can spend it.",
})

IDENTITY_401 = (401, {
    "error": "personal keys need a verified identity", "code": "IDENTITY_REQUIRED",
    "hint": "log in on hivv.org first — or run `hivv add --personal` from a registered bee",
})


def test_personal_flag_exists_on_add_and_alias():
    """--help is offline and must advertise the flag on BOTH spellings."""
    import subprocess
    for cmd in (["add", "--help"], ["add-ai", "--help"]):
        proc = subprocess.run(
            [sys.executable, str(CLI_PATH), *cmd],
            capture_output=True, text=True, timeout=60,
        )
        assert proc.returncode == 0, proc.stderr
        assert "--personal" in proc.stdout, f"{' '.join(cmd)} must document --personal"


def test_default_donation_says_SHARED_with_caps_and_escape_hatch():
    out, req = _run(_args(), DONATED_OK)
    assert req["path"] == "/api/keys/donate"
    assert "personal" not in (req["body"] or {}), "no flag → plain donation body"
    # honesty: the old "added to the network!" one-liner is gone
    assert "SHARED" in out
    assert "every bee on the hive can spend this key" in out
    assert "120" in out and "200000" in out, "caps are shown, not implied"
    assert "--personal" in out, "the way out is named at the moment it matters"


def test_personal_flag_travels_and_output_says_ONLY_YOURS():
    out, req = _run(_args(personal=True), PERSONAL_OK)
    assert req["body"].get("personal") is True, "the flag must reach the hub"
    assert "PERSONAL" in out
    assert "only YOUR requests can spend it" in out
    assert "bound to:  node:ashy" in out
    assert "SHARED" not in out


def test_identity_required_is_surfaced_with_its_hint():
    out, req = _run(_args(personal=True), IDENTITY_401)
    assert req["body"].get("personal") is True
    assert "failed to add groq" in out
    assert "IDENTITY_REQUIRED" not in out or "verified identity" in out
    assert "log in on hivv.org first" in out, "the hint reaches the human"


def test_interactive_menu_mentions_both_paths():
    """Bare `hivv add` prints the chooser — it must teach the two modes."""
    import io as _io
    from contextlib import redirect_stdout as _rso
    buf = _io.StringIO()
    with _rso(buf):
        hivv.cmd_add(_args(provider="", api_key=""))
    out = buf.getvalue()
    assert "--personal" in out
    assert "DONATED" in out, "the default is spelled out, not assumed"
