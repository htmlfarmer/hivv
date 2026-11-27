"""Can you file a problem — from the CLI, from OpenCode — and ever get an answer?

THE ASK
----------------------------------------------------------------------
"can we do some testing that we can submit a request with 'hivv proposal' or
'hivv bugs' or various other ways? and that all works from within opencode?
and is easy for AI's to find and easy for hivv.org to help with and quickly
reply to? and even solve?"

That is FIVE properties, and only the first two used to hold:

  1. SUBMIT, several ways     -> submit / request / flag / propose / help
  2. WORKS FROM OPENCODE      -> the MCP surface had NO submission tool: an
                                 AI connected to /mcp could chat, search and
                                 read honey, but could not file a bug.
  3. EASY FOR AIS TO FIND     -> neither SKILL.md mentioned filing anything.
                                 An AI reads the skill; if the skill is
                                 silent, the command does not exist for it.
  4. HIVV.ORG CAN REPLY       -> the reply COLUMN exists (review_notes) but
                                 NOTHING writes it, and the GET does not
                                 return it. You can file; you can never see
                                 an answer. (Still open — see below.)
  5. AND SOLVE                -> status lifecycle exists in the schema
                                 (open -> reviewed -> in_progress ->
                                 resolved) but no transition is driven by
                                 anything. (Still open — see below.)

This file pins 1-3 (and the parts of 4/5 that are reachable), and keeps the
two open gaps NAMED rather than quietly green.

No network, no $HOME writes, no database.
"""
from __future__ import annotations

import ast
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"
MCP = REPO / "api" / "routes" / "mcp-routes.js"
FEEDBACK_MIGRATION = REPO / "api" / "migrations" / "005_hivv_feedback.sql"
SKILL_REPO = REPO / ".opencode" / "skills" / "hivv" / "SKILL.md"
SKILL_PUBLIC = REPO / "public_html" / ".well-known" / "skills" / "hivv" / "SKILL.md"

# Isolate state BEFORE the module computes its paths (the env-leaker law).
_PRE_STATE = os.environ.get("HIVV_STATE_DIR")
_PRE_HUB = os.environ.get("HIVV_HUB")
_SUB_STATE = tempfile.mkdtemp(prefix="hivv-submission-test-")
_SUB_HUB = "http://127.0.0.1:1"               # dead port: fast-fail, offline
os.environ["HIVV_STATE_DIR"] = _SUB_STATE
os.environ["HIVV_HUB"] = _SUB_HUB


@pytest.fixture(scope="module", autouse=True)
def _restore_env_after_this_module():
    os.environ["HIVV_STATE_DIR"] = _SUB_STATE
    os.environ["HIVV_HUB"] = _SUB_HUB
    yield
    if _PRE_STATE is None:
        os.environ.pop("HIVV_STATE_DIR", None)
    else:
        os.environ["HIVV_STATE_DIR"] = _PRE_STATE
    if _PRE_HUB is None:
        os.environ.pop("HIVV_HUB", None)
    else:
        os.environ["HIVV_HUB"] = _PRE_HUB


def _load_cli():
    spec = importlib.util.spec_from_file_location("hivv_cli_subtest", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cli = _load_cli()


def _run(args, timeout=60):
    env = dict(os.environ)
    return subprocess.run([sys.executable, str(CLI), *args],
                          capture_output=True, text=True, timeout=timeout, env=env)


# =============================================================================
# 1. SUBMIT — every door exists and actually dispatches
# =============================================================================
SUBMISSION_COMMANDS = ["submit", "request", "flag", "bug", "propose", "help"]


class TestDispatch:
    """The smart-default trap: any subcommand the dispatch does not recognise
    falls through to CHAT. A submission command that lands in chat silently
    'works' (the model replies helpfully) and files NOTHING — the worst
    possible failure, because it looks like success."""

    @pytest.mark.parametrize("name", SUBMISSION_COMMANDS)
    def test_it_is_in_the_command_table(self, name):
        assert name in cli.COMMANDS, f"{name} is not a registered command"

    @pytest.mark.parametrize("name", SUBMISSION_COMMANDS)
    def test_it_maps_to_a_real_function_not_a_stub(self, name):
        fn = cli.COMMANDS[name]
        assert callable(fn), f"{name} is not callable"
        # A stub is what _resolve_cmds returns when the name is misspelled.
        assert getattr(fn, "__name__", "") != "_cmd_stub", (
            f"{name} resolves to a STUB — the dispatch would fall through to chat")

    @pytest.mark.parametrize("name", ["submit", "request", "flag", "propose"])
    def test_help_shows_usage_not_a_chat_reply(self, name):
        """--help must never reach the model."""
        r = _run([name, "--help"])
        assert r.returncode == 0, r.stderr
        out = (r.stdout + r.stderr).lower()
        assert "usage" in out
        # a chat answer would look like prose, not a usage block
        assert "hivv" in out

    def test_the_obvious_alias_exists(self):
        """`hivv help list` is two levels down behind a word that means
        something else — nobody guesses it. `hivv feedback` matches the MCP
        tool name, so a human and an AI reach for the same word."""
        assert "feedback" in cli.COMMANDS, "no hivv feedback alias"
        assert cli.COMMANDS["feedback"] is cli.COMMANDS["help"]

    def test_the_alias_has_help_text(self):
        r = _run(["feedback", "--help"])
        assert r.returncode == 0, r.stderr
        out = (r.stdout + r.stderr).lower()
        assert "no help yet" not in out, "hivv feedback has no help entry"
        assert "usage" in out

    def test_the_list_door_is_help_list(self):
        """BARE `hivv help` prints the ROOT help — main() intercepts it,
        because people type `hivv help` expecting help. The submission list
        is `hivv help list`. The docstring used to claim otherwise, so every
        document built from it pointed at the wrong command."""
        r = _run(["help"])
        assert r.returncode == 0, r.stderr
        assert "Traceback" not in r.stderr, r.stderr
        # root help, not a feedback list
        assert "submissions" not in r.stdout

        r2 = _run(["help", "list"])
        assert "Traceback" not in r2.stderr, r2.stderr
        # offline it must complain about the hub, not crash
        assert ("submissions" in r2.stdout) or ("hub" in (r2.stdout + r2.stderr).lower())


# =============================================================================
# 2. WORKS FROM OPENCODE — the MCP surface can file and read back
# =============================================================================
class TestMcpSurface:
    @pytest.fixture(scope="class")
    def mcp_src(self):
        return MCP.read_text(encoding="utf-8", errors="replace")

    def test_the_feedback_tool_is_registered(self, mcp_src):
        assert re.search(r"^  feedback: *\{", mcp_src, re.M), (
            "the MCP server has no feedback tool — an AI in OpenCode cannot file a bug")

    def test_it_is_dispatched(self, mcp_src):
        assert "case 'feedback': return _toolFeedback(args, ctx);" in mcp_src

    def test_the_handler_exists(self, mcp_src):
        assert "async function _toolFeedback(" in mcp_src

    def test_it_can_both_submit_and_read_back(self, mcp_src):
        """One tool, two actions: file it, and see whether anyone answered."""
        block = mcp_src[mcp_src.index("const FEEDBACK_SHAPE"):]
        block = block[:block.index("const TOOL_DEFS")]
        assert "submit" in block
        assert "list" in block

    def test_the_types_match_the_database_check_constraint(self, mcp_src):
        """No drift between what MCP accepts and what the table allows — a
        type the DB rejects would fail at INSERT time, i.e. after the AI
        already told the user it was filed."""
        mig = FEEDBACK_MIGRATION.read_text(encoding="utf-8")
        m = re.search(r"type\s+IN\s*\(([^)]+)\)", mig)
        assert m, "could not read the type CHECK constraint"
        db_types = {t.strip().strip("'") for t in m.group(1).split(",")}
        block = mcp_src[mcp_src.index("const FEEDBACK_SHAPE"):]
        enum = re.search(r"type: z\.enum\(\[([^\]]+)\]\)", block)
        assert enum, "the MCP feedback type is not an enum"
        mcp_types = {t.strip().strip("'") for t in enum.group(1).split(",")}
        assert mcp_types == db_types, (
            f"MCP {sorted(mcp_types)} != database {sorted(db_types)}")

    def test_the_description_tells_an_ai_when_to_use_it(self, mcp_src):
        """Discoverability inside OpenCode: an AI picks a tool by reading its
        description. If the description never says 'bug', it never gets used."""
        start = mcp_src.index("  feedback: {")
        block = mcp_src[start:start + 1400]
        assert "bug" in block.lower()
        assert "action=list" in block or "action" in block

    def test_the_mcp_surface_is_documented_in_the_skill(self):
        for skill in (SKILL_REPO, SKILL_PUBLIC):
            text = skill.read_text(encoding="utf-8", errors="replace")
            assert "feedback" in text, f"{skill.name} never mentions the MCP feedback tool"


# =============================================================================
# 2b. LIVE — what a RUNNING gateway actually advertises to OpenCode
# =============================================================================
#
# The static checks above prove the source says the right thing. This proves
# a real gateway serves it — which is the only thing an MCP client sees.
# READ-ONLY on purpose: an automated test must never write rows into
# production feedback. The write path was proven by hand once (submit ->
# id 2 -> read back) and is covered statically by the schema/type tests.


def _gateway_up() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:3011/api/health",
                                    timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


@pytest.mark.skipif(not _gateway_up(), reason="no local gateway running")
def test_the_live_mcp_endpoint_advertises_feedback():
    """An AI in OpenCode picks tools from tools/list. If `feedback` is not
    in that list, the whole feature is invisible to it — however good the
    docs are."""
    import urllib.request
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}
    }).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:3011/mcp", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        payload = json.loads(r.read())
    tools = {t["name"]: t for t in payload.get("result", {}).get("tools", [])}
    assert "feedback" in tools, (
        f"the live MCP surface has no feedback tool (has: {sorted(tools)})")
    # and its schema must carry the two actions — submit and read back
    props = (tools["feedback"].get("inputSchema") or {}).get("properties", {})
    assert "action" in props, "the feedback tool has no action parameter"
    assert "message" in props
    # discoverability, live: the description must say what it is for
    desc = (tools["feedback"].get("description") or "").lower()
    assert "bug" in desc


# =============================================================================
# 3. EASY FOR AIS TO FIND — the skill is what an AI actually reads
# =============================================================================
class TestDiscoverability:
    @pytest.mark.parametrize("skill", [SKILL_REPO, SKILL_PUBLIC],
                             ids=["repo-skill", "public-skill"])
    def test_it_names_the_submission_commands(self, skill):
        text = skill.read_text(encoding="utf-8", errors="replace")
        assert "hivv submit" in text, f"{skill} never mentions hivv submit"
        assert "hivv request" in text, f"{skill} never mentions hivv request"

    @pytest.mark.parametrize("skill", [SKILL_REPO, SKILL_PUBLIC],
                             ids=["repo-skill", "public-skill"])
    def test_it_names_the_obvious_alias(self, skill):
        """The same word a human types and the MCP tool is called."""
        text = skill.read_text(encoding="utf-8", errors="replace")
        assert "hivv feedback" in text, f"{skill} never mentions hivv feedback"

    @pytest.mark.parametrize("skill", [SKILL_REPO, SKILL_PUBLIC],
                             ids=["repo-skill", "public-skill"])
    def test_it_tells_the_ai_the_report_is_trackable(self, skill):
        """An AI that believes filing is pointless will not bother. Say what
        happens to the report."""
        text = skill.read_text(encoding="utf-8", errors="replace")
        assert "status" in text
        assert "reply" in text.lower()

    @pytest.mark.parametrize("skill", [SKILL_REPO, SKILL_PUBLIC],
                             ids=["repo-skill", "public-skill"])
    def test_it_points_at_the_offline_fallback(self, skill):
        text = skill.read_text(encoding="utf-8", errors="replace")
        assert "hivv fallback" in text

    def test_the_cli_help_table_lists_them(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        # the human-facing help table (cmd_help's), not just the argparse
        for name in ("submit", "request", "flag"):
            assert f'"{name}":' in src, f"no help entry for {name}"


# =============================================================================
# 4/5. REPLY AND SOLVE — the gaps, named rather than quietly green
# =============================================================================
class TestReplyPath:
    def test_the_reply_column_exists(self):
        """The schema was built for a conversation: a status lifecycle and a
        review_notes column where the maintainer's answer goes."""
        mig = FEEDBACK_MIGRATION.read_text(encoding="utf-8")
        assert "review_notes" in mig
        for state in ("open", "reviewed", "in_progress", "resolved", "dismissed"):
            assert state in mig, f"status '{state}' is not in the lifecycle"

    def test_the_mcp_read_path_returns_the_reply(self):
        """MCP's action=list SELECTs review_notes — an AI checking back can
        see the answer the moment anything writes one."""
        src = MCP.read_text(encoding="utf-8", errors="replace")
        block = src[src.index("async function _toolFeedback"):]
        block = block[:block.index("\n}") + 3]
        assert "review_notes" in block

    def test_the_reply_write_path(self):
        """THE OPEN GAP — named, not quietly green.

        Nothing updates hivv_feedback: no endpoint sets status or
        review_notes. So today hivv.org can RECEIVE a report but cannot
        ANSWER one. Marked xfail (expected) so it documents the gap without
        blocking the suite — and it turns into a real assertion the moment
        somebody builds the write side.
        """
        hits = []
        for path in (REPO / "api").rglob("*.js"):
            if "node_modules" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if re.search(r"UPDATE[ \t\n]+hivv_feedback", text, re.I):
                hits.append(path)
        if not hits:
            pytest.xfail("OPEN GAP: nothing writes a reply to hivv_feedback "
                         "yet — when you build it, make this assert the round trip")
        # Built! now prove it can set a status AND leave a note.
        joined = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                            for p in hits)
        assert "review_notes" in joined, "the writer updates status but never a reply"
