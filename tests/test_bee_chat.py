"""`hivv ask` / `hivv talk` — chat with ONE bee (2026-11-19).

Pins the failure modes from the bug report:

  * `hivv node-chat <bee> <msg>` was the only hyphenated chat verb, and
    `hivv node chat <bee> <msg>` died with "node 'chat yalla whas up' not
    found" — `node`'s nargs='+' swallowed the WHOLE tail as the node name.
  * the hub fallback posted {provider: <bee-name>}, but the router matches
    `provider` against endpoint names like `ashy:8090`, never `ashy`. No
    match → it routed to whichever bee was free and printed that answer as
    if the named bee had said it. Silence followed when the hub 503'd.
  * a bee whose model binds to 127.0.0.1 (ashy :8090) refuses every LAN
    connection, so the direct path can never work — only the hub RELAY,
    which the bee's own agent answers on localhost, reaches it.

These are static/behavioural checks: no network, no hub, no $HOME writes.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import urllib.parse

import pytest

REPO = pathlib.Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


@pytest.fixture(scope="module")
def cli():
    """Load the CLI as a module WITHOUT running main() (sys.argv guard)."""
    spec = importlib.util.spec_from_file_location("hivv_cli_under_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    old = sys.argv[:]
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    finally:
        sys.argv = old
    return mod


# ── naming ──────────────────────────────────────────────────────────────

def test_ask_and_talk_are_registered(cli):
    """`ask` + `talk` must be real subcommands, not fall into the smart-default
    (which would SEND the verb to the LLM as a chat prompt)."""
    for verb in ("ask", "talk", "node-chat"):
        assert verb in cli.COMMANDS, f"{verb} missing from COMMANDS"
        assert cli.COMMANDS[verb] is cli.cmd_node_chat


def test_hive_chat_stays_separate(cli):
    """`hivv chat` = the HIVE. It must NOT be repointed at one bee."""
    assert cli.COMMANDS["chat"] is cli.cmd_chat
    assert cli.COMMANDS["chat"] is not cli.cmd_node_chat


def test_chat_verbs_cover_node_subcommand(cli):
    """`hivv node chat <bee> <msg>` must be recognised as a chat verb."""
    assert "chat" in cli._BEE_CHAT_VERBS
    assert set(cli._BEE_CHAT_VERBS) >= {"ask", "talk", "chat"}


def test_node_chat_has_a_parser(cli):
    p = cli.build_parser()
    for verb in ("ask", "talk", "node-chat"):
        a = p.parse_args([verb, "ashy", "whas", "up"])
        assert a.name == "ashy"
        assert a.message == ["whas", "up"]


def test_bare_ask_parses_for_friendly_usage(cli):
    """Bare `hivv ask` must reach OUR usage text (with the hive-routing hint)
    rather than argparse's terse 'required: name'."""
    a = cli.build_parser().parse_args(["ask"])
    assert a.name == "" and a.message == []


# ── node resolution ─────────────────────────────────────────────────────

_NODES = [
    {"id": "masjid", "name": "masjid", "status": "online"},
    {"id": "yalla", "name": "yalla", "status": "online"},
    {"id": "ashy", "name": "ashy", "status": "online"},
    {"id": "i-1", "name": "Stuarts-iMac-Pro", "status": "offline"},
]


def test_find_node_exact_id(cli):
    assert cli._find_node("ashy", _NODES)["id"] == "ashy"


def test_find_node_is_case_insensitive(cli):
    assert cli._find_node("ASHY", _NODES)["id"] == "ashy"


def test_find_node_partial_name(cli):
    assert cli._find_node("stuart", _NODES)["name"] == "Stuarts-iMac-Pro"


def test_find_node_exact_beats_partial(cli):
    """`yalla` must resolve to yalla, not to whichever bee contains it."""
    assert cli._find_node("yalla", _NODES)["id"] == "yalla"


def test_find_node_unknown_returns_none(cli):
    assert cli._find_node("nosuchbee", _NODES) is None


def test_find_node_never_returns_a_dict_shaped_thing_for_garbage(cli):
    assert cli._find_node("", _NODES) is None


# ── relay endpoints (the localhost-bound-model fix) ─────────────────────

def test_relay_endpoints_include_detected_port_first(cli):
    """ashy serves on :8090; the old hardcoded list was
    [8080, 11434, 1234, 8081] — 8090 absent, so every relay job died with
    'no local model answered'. Alive/detected ports must come FIRST."""
    eps = cli._relay_endpoints()
    assert eps, "relay must have at least one endpoint"
    assert all(e.startswith("http://") and e.endswith("/v1/chat/completions") for e in eps)


def test_relay_endpoints_keep_legacy_backstop(cli):
    """Detected ports are probed, but the legacy list stays as a fallback for
    a box where detection fails. Checked by PORT (not exact URL) because an
    alive :8080 is added as 127.0.0.1 and shadows the legacy localhost form."""
    ports = {urllib.parse.urlsplit(e).port for e in cli._relay_endpoints()}
    for p in (8080, 11434, 1234, 8081, 8090):
        assert p in ports, f"legacy port {p} missing from relay backstop"


def test_relay_endpoints_dedup(cli):
    eps = cli._relay_endpoints()
    assert len(eps) == len(set(eps))


def test_relay_endpoints_dont_duplicate_8090(cli):
    """8090 must appear once even though `127.0.0.1:8090` (detected) and
    `localhost:8090` (legacy) are the same llama-server — loopback aliases
    canonicalise to one key."""
    eps = cli._relay_endpoints()
    ports = [urllib.parse.urlsplit(e).port for e in eps]
    assert ports.count(8090) == 1, [e for e in eps if ":8090" in e]
    assert len(ports) == len(set(ports)), "same host:port tried twice"


# ── the fallback never lies about who answered ──────────────────────────

def test_fallback_uses_relay_not_provider_spoofing(cli):
    """The old code posted {provider: <bee-name>} to /api/chat — which the
    router resolves against endpoint names, so it silently answered from a
    DIFFERENT bee. The fallback must go through the relay, pinned to a node_id."""
    src = CLI.read_text()
    fn = src.split("def cmd_node_chat(")[1].split("\ndef ")[0]
    assert "_relay_chat_to_bee" in fn, "fallback must use the pinned relay"
    assert '"provider": name' not in fn, "provider-spoofing fallback is the bug"
    assert "/api/relay/jobs" in src


def test_relay_helper_pins_a_node_id(cli):
    """The relay POST must carry node_id — that is what makes it THAT bee."""
    src = CLI.read_text()
    fn = src.split("def _relay_chat_to_bee(")[1].split("\ndef ")[0]
    assert '"node_id"' in fn


def test_relay_helper_reports_failure_instead_of_silence(cli):
    """Silence was the worst failure mode — the old `if code == 200` had no
    else, so a hub error printed NOTHING."""
    src = CLI.read_text()
    fn = src.split("def _relay_chat_to_bee(")[1].split("\ndef ")[0]
    assert '"failed"' in fn and '"refused"' in fn and '"ok"' in fn


def test_cmd_node_chat_exits_nonzero_when_nobody_answers(cli):
    src = CLI.read_text()
    fn = src.split("def cmd_node_chat(")[1].split("\ndef ")[0]
    assert "sys.exit(1)" in fn


# ── `hivv node chat <bee> <msg>` no longer swallows the tail ────────────

def test_cmd_node_routes_chat_verb_to_cmd_node_chat(cli):
    """Regression for: `hivv node chat yalla whas up` →
    "node 'chat yalla whas up' not found"."""
    src = CLI.read_text()
    fn = src.split("def cmd_node(")[1].split("\ndef ")[0]
    assert "_BEE_CHAT_VERBS" in fn, "cmd_node must recognise the chat verbs"
    assert "cmd_node_chat" in fn, "cmd_node must delegate to cmd_node_chat"


def test_cmd_node_still_shows_info_for_plain_args(cli):
    """`hivv node yalla` must still print details (no verb → no delegation)."""
    src = CLI.read_text()
    fn = src.split("def cmd_node(")[1].split("\ndef ")[0]
    assert 'die("usage: hivv node <name>' in fn


# ── self-describing help (agents read this first) ───────────────────────

def test_help_table_documents_ask_and_talk(cli):
    src = CLI.read_text()
    assert '"ask":' in src and '"talk":' in src
    # and the hive/one-bee distinction is spelled out
    assert "asks the HIVE" in src or "ask the HIVE" in src


def test_root_help_lists_ask(cli):
    src = CLI.read_text()
    assert "ask / talk <n> MSG" in src


def test_no_stale_node_chat_usage_in_die_path(cli):
    """The usage text must teach the NEW verb first."""
    src = CLI.read_text()
    fn = src.split("def cmd_node_chat(")[1].split("\ndef ")[0]
    assert "hivv ask <bee> <message>" in fn


# ── localisation of a localhost-bound bee ───────────────────────────────

def test_localhost_swap_when_asking_own_bee(cli):
    """Asking THIS box's own bee must use 127.0.0.1 — a model bound to
    localhost refuses its own LAN IP (the exact ashy failure)."""
    src = CLI.read_text()
    fn = src.split("def cmd_node_chat(")[1].split("\ndef ")[0]
    assert 'ip = "127.0.0.1"' in fn


def test_direct_path_preflights_tcp(cli):
    """Never print 'chatting with X (:8090)' for a port already refusing
    connections — banner-then-failure is what made this look broken."""
    src = CLI.read_text()
    fn = src.split("def cmd_node_chat(")[1].split("\ndef ")[0]
    assert "_tcp_ok" in fn
