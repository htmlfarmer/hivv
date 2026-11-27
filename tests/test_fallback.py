"""The escape hatch: hivv.org is a single point of failure, and GitHub must
never become a flood.

WHY THIS EXISTS
----------------------------------------------------------------------
hivv.org serves the CLI, the wrapper, the installer, the rescue script AND
the online help. It is also the very thing you need to fix when it is
broken. If it is down — or worse, compromised — every entry point dies with
it and there is nowhere to go. The git repository is the second copy:
the same files, the same layout, a different host.

THE FLOOD LAW (the reason this file exists more than the rest)
----------------------------------------------------------------------
The agent checks for updates every 5 minutes on EVERY bee. If that check
ever fell back to raw.githubusercontent, a hive of N bees would make N
requests every 5 minutes against a third party's CDN. That is a flood.
GitHub would rightly answer with a rate limit or an IP ban, and every bee
behind that address would be collateral damage — the hive would be taken
down by a feature meant to save it.

So the law is:
  * the AUTOMATIC path never touches GitHub (pinned here, by scanning the
    agent's own source);
  * the HUMAN path touches it once, deliberately, and only through an
    explicit flag;
  * and every deliberate fetch passes a guard that allows ONE per cool-down
    window per machine, so even a mistaken loop cannot hammer it.

No network (the hub is a dead localhost port), no $HOME writes
(HIVV_STATE_DIR is a temp dir). The ONE live GitHub check is OPT-IN
(HIVV_TEST_GITHUB=1) — a test suite must not touch GitHub by default, for
the same reason the agent must not.
"""
from __future__ import annotations

import ast
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"
WRAPPER = REPO / "public_html" / "hivv"
INSTALLER = REPO / "public_html" / "install-hivv.sh"
RESCUE = REPO / "public_html" / "rescue"
HELP_MD = REPO / "docs" / "HELP.md"

# Isolate state BEFORE the module computes its paths (the 2026-11-24
# import-time env leaker red).
_PRE_STATE = os.environ.get("HIVV_STATE_DIR")
_PRE_HUB = os.environ.get("HIVV_HUB")
_FB_STATE = tempfile.mkdtemp(prefix="hivv-fallback-test-")
_FB_HUB = "http://127.0.0.1:1"               # dead port: fast-fail, offline
os.environ["HIVV_STATE_DIR"] = _FB_STATE
os.environ["HIVV_HUB"] = _FB_HUB


@pytest.fixture(scope="module", autouse=True)
def _restore_env_after_this_module():
    os.environ["HIVV_STATE_DIR"] = _FB_STATE
    os.environ["HIVV_HUB"] = _FB_HUB
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
    spec = importlib.util.spec_from_file_location("hivv_cli_fallbacktest", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cli = _load_cli()


def _run(args, env_extra=None, timeout=120):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, str(CLI), *args],
                          capture_output=True, text=True,
                          timeout=timeout, env=env)


# =============================================================================
# THE FLOOD LAW — the automatic path must never name GitHub
# =============================================================================
class TestFloodLaw:
    def _func_source(self, name: str) -> str:
        # Slice by LINE RANGE, not ast.get_source_segment: the CLI is ~1MB
        # and get_source_segment re-slices the whole source per call, so
        # walking every function with it costs 90 seconds.
        src = CLI.read_text(encoding="utf-8")
        lines = src.splitlines()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return "\n".join(lines[node.lineno - 1:node.end_lineno])
        pytest.fail(f"function {name} not found")

    def _all_func_sources(self):
        src = CLI.read_text(encoding="utf-8")
        lines = src.splitlines()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                yield node.name, "\n".join(lines[node.lineno - 1:node.end_lineno])

    def test_the_agent_never_mentions_github(self):
        """THE LAW. cmd_agent owns the 5-minute auto-update loop. If GitHub
        ever appears in it, every bee in the hive polls GitHub every 5
        minutes — a flood, and an IP ban for everyone behind that address.
        """
        seg = self._func_source("cmd_agent")
        assert seg, "cmd_agent not found"
        assert "githubusercontent" not in seg
        assert "github.com" not in seg

    def test_the_agent_does_not_call_the_update_command(self):
        """The auto-update has its own inline fetch. It must never route
        through cmd_update, which is where the GitHub option lives."""
        seg = self._func_source("cmd_agent")
        assert "cmd_update" not in seg

    def test_the_agent_does_not_touch_the_fallback_helpers(self):
        seg = self._func_source("cmd_agent")
        assert "_fallback" not in seg

    def test_the_fallback_is_only_reachable_by_an_explicit_flag(self):
        """cmd_update's URL is the hub unless the human asks otherwise."""
        seg = self._func_source("cmd_update")
        assert "--from-github" not in seg          # it reads the parsed arg
        assert "from_github" in seg
        # the fallback URL is built ONLY inside the explicit branch
        assert seg.count("_fallback_url(") == 1
        assert "_fallback_guard_ok(" in seg

    def test_the_automatic_paths_name_only_the_hub(self):
        """A belt-and-braces scan: the words that mean 'a machine did this
        on its own' must never sit next to a GitHub URL."""
        src = CLI.read_text(encoding="utf-8")
        for marker in ("auto-update", "heartbeat", "_ensure_tools_running"):
            assert marker in src
        # the fallback base is defined once and used only by the helpers
        assert src.count("FALLBACK_RAW_BASE =") == 1

    def test_exactly_one_function_may_name_github(self):
        """AST, not grep: only the helper that BUILDS the URL may contain
        the literal. Any other function naming GitHub is a place where a
        machine could start talking to it on its own."""
        holders = [name for name, seg in self._all_func_sources()
                   if "raw.githubusercontent.com" in seg]
        assert holders == ["_fallback_url"], holders


# =============================================================================
# THE FLOOD GUARD — one deliberate fetch per cool-down window
# =============================================================================
class TestFloodGuard:
    def test_the_first_fetch_is_allowed(self, monkeypatch):
        guard = cli.STATE_DIR / "guard-test.json"
        monkeypatch.setattr(cli, "FALLBACK_GUARD_FILE", guard)
        ok, why = cli._fallback_guard_ok()
        assert ok, why

    def test_the_second_fetch_inside_the_window_is_refused(self, monkeypatch):
        guard = cli.STATE_DIR / "guard-test2.json"
        monkeypatch.setattr(cli, "FALLBACK_GUARD_FILE", guard)
        ok, _ = cli._fallback_guard_ok()
        assert ok
        ok2, why = cli._fallback_guard_ok()
        assert not ok2
        assert "flood guard" in why

    def test_force_overrides_the_guard(self, monkeypatch):
        guard = cli.STATE_DIR / "guard-test3.json"
        monkeypatch.setattr(cli, "FALLBACK_GUARD_FILE", guard)
        cli._fallback_guard_ok()
        ok, _ = cli._fallback_guard_ok(force=True)
        assert ok

    def test_the_window_expires(self, monkeypatch):
        guard = cli.STATE_DIR / "guard-test4.json"
        monkeypatch.setattr(cli, "FALLBACK_GUARD_FILE", guard)
        monkeypatch.setattr(cli, "FALLBACK_COOLDOWN", 1)
        cli._fallback_guard_ok()
        time.sleep(1.2)
        ok, why = cli._fallback_guard_ok()
        assert ok, why

    def test_a_failed_fetch_still_spends_the_slot(self, monkeypatch):
        """The slot is reserved BEFORE the fetch — a broken network must not
        turn a retry loop into a flood."""
        guard = cli.STATE_DIR / "guard-test5.json"
        monkeypatch.setattr(cli, "FALLBACK_GUARD_FILE", guard)
        cli._fallback_guard_ok()
        assert guard.exists()
        ok, _ = cli._fallback_guard_ok()
        assert not ok


# =============================================================================
# THE ESCAPE HATCH — hivv fallback
# =============================================================================
class TestFallbackCommand:
    def test_it_prints_the_github_copy_of_every_entry_point(self):
        r = _run(["fallback"])
        assert r.returncode == 0, r.stderr
        out = r.stdout
        assert "install-hivv.sh" in out
        assert "rescue" in out
        assert "raw.githubusercontent.com" in out
        assert "--from-github" in out

    def test_it_works_with_no_network_at_all(self):
        """No hub, no DNS — the escape hatch must still print. That is the
        whole point of it."""
        r = _run(["fallback"], env_extra={"HIVV_HUB": "http://127.0.0.1:1"})
        assert r.returncode == 0, r.stderr
        assert "raw.githubusercontent.com" in r.stdout

    def test_json_is_machine_readable(self):
        r = _run(["fallback", "--json"])
        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["repo"] == "htmlfarmer/hivv"
        assert data["raw_base"].startswith("https://raw.githubusercontent.com/")
        assert "install-hivv.sh" in data["install"]
        assert "rescue" in data["rescue"]
        assert data["update"] == "hivv update --from-github"

    def test_the_urls_have_the_right_shape(self):
        """The repo layout is public_html/ mirroring what the site serves —
        so a flat base + the filename is the whole URL."""
        url = cli._fallback_url("hivv-cli.py")
        assert url == ("https://raw.githubusercontent.com/htmlfarmer/hivv/main"
                       "/public_html/hivv-cli.py")

    def test_a_commit_sha_makes_the_url_immutable(self):
        sha = "0123456789abcdef0123456789abcdef01234567"
        url = cli._fallback_url("hivv-cli.py", ref=sha)
        assert sha in url
        assert "main" not in url.replace(sha, "")

    def test_the_compromise_procedure_stops_the_bleeding_FIRST(self):
        """The auto-update polls the hub every 5 minutes. Fixing a compromised
        CLI without blocking the auto-update is useless: the hub pulls the bad
        copy straight back over your fix in five minutes."""
        r = _run(["fallback"])
        assert r.returncode == 0, r.stderr
        tail = r.stdout.split("IF YOU SUSPECT")[1]
        assert "hivv dev on" in tail
        assert "hivv dev off" in tail
        # the ORDER matters: block the update BEFORE fetching anything
        assert tail.index("hivv dev on") < tail.index("raw.githubusercontent.com")
        assert tail.index("raw.githubusercontent.com") < tail.index("hivv dev off")

    def test_the_help_document_exists_and_covers_both_cases(self):
        assert HELP_MD.exists()
        text = HELP_MD.read_text(encoding="utf-8")
        assert "IF HIVV.ORG IS DOWN" in text
        assert "COMPROMISED" in text
        assert "raw.githubusercontent.com" in text
        assert "flood" in text.lower()
        # the stop-the-bleeding step, in the right order
        assert text.index("hivv dev on") < text.index("<COMMIT-SHA>")


# =============================================================================
# THE SHELL ENTRY POINTS — the installer, the wrapper, the rescue
# =============================================================================
class TestShellEntryPoints:
    @pytest.mark.parametrize("path", [WRAPPER, INSTALLER, RESCUE])
    def test_they_are_valid_shell(self, path):
        r = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr

    @pytest.mark.parametrize("path", [WRAPPER, INSTALLER, RESCUE])
    def test_each_one_has_a_github_fallback(self, path):
        text = path.read_text(encoding="utf-8", errors="replace")
        assert "raw.githubusercontent.com" in text, f"{path.name} has no fallback"
        assert "HIVV_FALLBACK" in text, f"{path.name} cannot be pointed elsewhere"

    def test_the_wrapper_tries_the_hub_first(self):
        text = WRAPPER.read_text(encoding="utf-8", errors="replace")
        # the hub is still the first choice — the fallback is a fallback
        assert text.index("CLIENT_URL") < text.index("FALLBACK_URL")
        assert "_fetch_to" in text

    def test_the_rescue_falls_back_to_the_github_installer(self):
        text = RESCUE.read_text(encoding="utf-8", errors="replace")
        assert "fetch_installer" in text
        assert "FALLBACK_RAW/install-" in text

    def test_the_installer_falls_back_to_the_github_copy(self):
        text = INSTALLER.read_text(encoding="utf-8", errors="replace")
        assert "FALLBACK_RAW" in text
        assert "hub unreachable" in text.lower() or "github" in text.lower()


# =============================================================================
# THE LIVE CHECK — OPT-IN, and deliberately ONE request
# =============================================================================
@pytest.mark.skipif(not os.environ.get("HIVV_TEST_GITHUB"),
                    reason="set HIVV_TEST_GITHUB=1 to make ONE live GitHub request")
def test_the_raw_url_resolves():
    import urllib.request
    url = cli._fallback_url("docs/HELP.md")
    req = urllib.request.Request(url, method="HEAD",
                                 headers={"User-Agent": "hivv-fallback-test/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        assert r.status == 200
