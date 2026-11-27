#!/usr/bin/env python3
"""Regression tests: `hivv propose` + `hivv proposals` (the proposal funnel).

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
Two, both silent:

  1. THE BRICKED PARSER. `propose` already existed, so adding a SECOND
     `sub.add_parser("propose", ...)` duplicates the top-level subparser and
     takes the WHOLE CLI down — and the parse-fail path prints the
     "hivv could not start — its own command parser failed" footer on a
     perfectly healthy binary. `tests/test_cli_parser.py` regexes the parser
     source for duplicates; this file pins the same property behaviourally.

  2. THE CREDENTIAL creeping back. The design law is: nodes never hold a
     GitHub credential — the hub holds exactly ONE, behind a policy gate.
     The old `--push` had the node run `gh pr create` itself. It is now
     refused, and the refusal is pinned here so nobody "helpfully"
     re-enables it.

Also pinned: both commands are REAL commands (never the chat smart-default),
the envelope is signed as kind `proposal.create`, and `--dry-run` sends
nothing.

Run:
    python3 -m pytest tests/test_propose_cli.py -q
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"

# Capture BEFORE touching — the import-time env-leaker lesson: a test that
# sets HIVV_STATE_DIR at import and never restores it poisons every later
# subprocess in the suite.
_ORIG_ENV = {k: os.environ.get(k) for k in ("HIVV_STATE_DIR", "HIVV_HUB", "HIVV_CONFIG_DIR")}


@pytest.fixture(scope="module", autouse=True)
def _isolated_state(tmp_path_factory):
    state = tmp_path_factory.mktemp("propose-state")
    os.environ["HIVV_STATE_DIR"] = str(state)
    os.environ["HIVV_CONFIG_DIR"] = str(tmp_path_factory.mktemp("propose-cfg"))
    # dead port: nothing in this suite may talk to a real hub
    os.environ["HIVV_HUB"] = "http://127.0.0.1:1"
    yield state
    for k, v in _ORIG_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _tmp_env(tmp_path):
    return {
        "HIVV_STATE_DIR": str(tmp_path / "state"),
        "HIVV_CONFIG_DIR": str(tmp_path / "cfg"),
        "HIVV_INSTALL_DIR": str(tmp_path / "lib"),
        "HIVV_BIN_DIR": str(tmp_path / "bin"),
        "HOME": str(tmp_path / "home"),
        "HIVV_HUB": "http://127.0.0.1:1",
    }


def _run(args, env_extra=None, timeout=60):
    """Subprocess against the REAL CLI, every path env-overridden into tmp."""
    env = dict(os.environ)
    env["PATH"] = "/usr/bin:/bin"
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True, text=True, timeout=timeout, env=env,
        stdin=subprocess.DEVNULL,
    )


def _load_cli():
    """Import the CLI module WITHOUT running main()."""
    spec = importlib.util.spec_from_file_location("hivv_cli_propose_under_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


@pytest.fixture(scope="module")
def cli(_isolated_state):
    return _load_cli()


# ══ 1 · dispatch — a command, never the chat trap ══════════════════════════

def test_both_commands_are_registered(cli):
    """A missing COMMANDS entry silently becomes 'asking the hive instead'."""
    assert "propose" in cli.COMMANDS, "propose must be a command"
    assert "proposals" in cli.COMMANDS, "proposals must be a command"
    assert cli.COMMANDS.get("propose") is not None
    assert cli.COMMANDS.get("proposals") is not None


def test_no_duplicate_subparser(cli):
    """A second add_parser('propose') bricks every command, not just this one."""
    src = CLI.read_text(encoding="utf-8")
    names = []
    for line in src.splitlines():
        if 'sub.add_parser("' in line:
            start = line.index('sub.add_parser("') + len('sub.add_parser("')
            end = line.index('"', start)
            names.append(line[start:end])
    dupes = {n for n in names if names.count(n) > 1}
    assert not dupes, f"duplicate subparser(s) would brick the CLI: {sorted(dupes)}"


def test_parser_builds_and_takes_the_new_arguments(cli):
    p = cli.build_parser()
    a = p.parse_args(["propose", "a title", "--evidence", "saw it", "--type", "bug"])
    assert a.topic == "a title"
    assert a.evidence == "saw it"
    assert a.ptype == "bug"


def test_type_is_a_closed_vocabulary(cli):
    p = cli.build_parser()
    with pytest.raises(SystemExit):
        p.parse_args(["propose", "t", "--type", "definitely-not-a-type"])


def test_proposals_parser_exists(cli):
    p = cli.build_parser()
    a = p.parse_args(["proposals", "--all"])
    assert a.all is True


# ══ 2 · THE LAW — no GitHub credential on a node ═══════════════════════════

def test_push_is_refused_with_the_design_law(tmp_path):
    r = _run(["propose", "anything at all", "--push"], env_extra=_tmp_env(tmp_path))
    out = (r.stdout or "") + (r.stderr or "")
    assert r.returncode != 0, "--push must not succeed"
    assert "never hold a GitHub credential" in out, out
    # and it must never have reached the network
    assert "hub is not reachable" not in out, "it should die before sending"


def test_the_node_side_push_helper_is_not_called_by_propose():
    """The gh push helper may still exist for `contribute`, but propose must
    not reach it — the hub's relay is the only writer."""
    src = CLI.read_text(encoding="utf-8")
    fn_start = src.index("def cmd_propose(args)")
    fn_end = src.index("\ndef ", fn_start + 10)
    body = src[fn_start:fn_end]
    assert "_propose_push(" not in body, "cmd_propose must not push a branch itself"


# ══ 3 · the envelope is signed as a proposal ═══════════════════════════════

def test_envelope_kind_and_payload(cli):
    ident = cli._identity_envelope("proposal.create", "bee-under-test", {
        "type": "bug",
        "title": "the tools server never refreshes",
        "body": "a body",
        "evidence": "pid 42335",
        "patch": "diff --git a/x b/x\n",
    })
    assert ident is not None, "a state dir with a key must produce an envelope"
    assert ident["algorithm"] == "ed25519"
    st = ident["statement"]
    assert st["kind"] == "proposal.create", "the hub verifies against this exact kind"
    assert st["v"] == 1
    assert st["node_id"] == "bee-under-test"
    assert isinstance(st["ts"], int)
    assert isinstance(st["nonce"], str) and len(st["nonce"]) >= 16
    assert st["type"] == "bug"
    assert st["title"].startswith("the tools server")
    assert "pid 42335" in st["evidence"]
    assert st["patch"].startswith("diff --git")
    assert isinstance(st["ts"], int), "canonical JSON forbids floats"
    # wire shape the hub's identity.verifyIncoming expects
    assert set(ident) >= {"algorithm", "public_key", "statement", "signature"}
    assert len(cli.base64.b64decode(ident["public_key"])) == 32
    assert len(cli.base64.b64decode(ident["signature"])) == 64


def test_envelope_carries_no_floats(cli):
    """canonical JSON forbids floats — a float in the statement would make
    every signature fail on the hub with a confusing error."""
    ident = cli._identity_envelope("proposal.create", "bee", {"title": "t"})
    canon = cli._canonical_json(ident["statement"])
    assert "." not in canon.split('"ts":')[1].split(",")[0], "ts must be an int"
    assert isinstance(ident["statement"]["ts"], int)


# ══ 4 · behaviour ══════════════════════════════════════════════════════════

def test_no_title_dies_with_usage_and_never_chats(tmp_path):
    r = _run(["propose"], env_extra=_tmp_env(tmp_path))
    out = (r.stdout or "") + (r.stderr or "")
    assert r.returncode != 0
    assert "needs a title" in out, out
    assert "asking the hive instead" not in out, "propose must never fall into chat"


def test_help_mentions_the_funnel(tmp_path):
    r = _run(["propose", "--help"], env_extra=_tmp_env(tmp_path))
    out = (r.stdout or "") + (r.stderr or "")
    assert r.returncode == 0, out
    for word in ("verify", "dedupe", "fastScan", "policy gate"):
        assert word in out, f"help should describe the funnel stage '{word}'"
    assert "GitHub credential" in out


def test_proposals_help_exists(tmp_path):
    r = _run(["proposals", "--help"], env_extra=_tmp_env(tmp_path))
    out = (r.stdout or "") + (r.stderr or "")
    assert r.returncode == 0, out
    assert "no help yet" not in out, "the sub-help table must have an entry"


def test_dry_run_sends_nothing_and_reports_the_signature(tmp_path):
    r = _run(["propose", "a dry run title", "--dry-run", "--json"],
             env_extra=_tmp_env(tmp_path))
    out = (r.stdout or "")
    # the dead hub must never have been contacted
    assert "network error" not in out
    assert "hub is not reachable" not in out
    payload = None
    for line in out.splitlines():
        try:
            candidate = json.loads(line)
        except Exception:
            continue
        if isinstance(candidate, dict) and candidate.get("dry_run"):
            payload = candidate
    if payload is None:
        # the whole stdout may be one JSON document
        try:
            payload = json.loads(out)
        except Exception:
            payload = None
    assert payload and payload.get("dry_run") is True, out[:800]
    assert payload["proposal"]["identity"] == "signed", "it must sign before sending"


def test_patch_out_writes_the_credential_free_handback(tmp_path):
    patch = tmp_path / "in.diff"
    patch.write_text("diff --git a/x b/x\n+++ b/x\n+hello\n", encoding="utf-8")
    handback = tmp_path / "handback.diff"
    r = _run(
        ["propose", "handback", "--patch", str(patch),
         "--patch-out", str(handback), "--dry-run"],
        env_extra=_tmp_env(tmp_path),
    )
    assert r.returncode == 0, (r.stdout or "") + (r.stderr or "")
    assert handback.exists(), "--patch-out must still write the handback"
    assert "+hello" in handback.read_text(encoding="utf-8")
