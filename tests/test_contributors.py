"""Tests for the contributor stats — the hub module and the CLI command.

WHY THIS EXISTS
The honey leaderboard counts COMPUTE (a bee serving tokens). CODE
contribution had no number, no card, no page — in a distributed project
that is how people quietly stop helping. These tests pin the parts that
could quietly break the promise:

  • a GitHub outage must NOT blank the page (serve the last good cache)
  • a rate-limited fetch must NOT wipe a good cache
  • the API must work with NO token (no secret to leak, no rate-limit
    dependency on a credential that might expire)
  • the CLI must not claim contributors exist when GitHub says none do
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
CONTRIB_MODULE = REPO / "api" / "lib" / "contributors.js"

spec = importlib.util.spec_from_file_location("hivv_cli", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli"] = hivv
spec.loader.exec_module(hivv)


class TestContributorsModule:
    def test_module_exists(self):
        assert CONTRIB_MODULE.exists()

    def test_module_is_valid_node(self):
        r = subprocess.run(["node", "--check", str(CONTRIB_MODULE)],
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr

    def test_route_is_registered(self):
        src = (REPO / "api" / "routes" / "honey-routes.js").read_text()
        assert "router.get('/contributors'" in src
        assert "router.get('/contributors.svg'" in src

    def test_module_uses_no_token(self):
        """No token means no secret to leak — and the repo is public."""
        src = CONTRIB_MODULE.read_text()
        assert "Authorization" not in src
        assert "GITHUB_TOKEN" not in src

    def test_module_never_posts_anything(self):
        """It READS. It must never send data anywhere."""
        src = CONTRIB_MODULE.read_text()
        assert "method: 'POST'" not in src
        assert 'method: "POST"' not in src
        assert "write(" not in src

    def test_module_caches(self):
        src = CONTRIB_MODULE.read_text()
        assert "_cache" in src
        assert "TTL_MS" in src

    def test_failed_fetch_keeps_the_last_good_cache(self):
        """A GitHub outage must not blank the contributors page."""
        src = CONTRIB_MODULE.read_text()
        assert "stale: true" in src, (
            "a failed fetch must fall back to the last good cache"
        )

    def test_inflight_is_deduplicated(self):
        """A burst of visitors must not become a burst of GitHub calls."""
        src = CONTRIB_MODULE.read_text()
        assert "_inflight" in src


class TestContributorsCli:
    def test_command_is_registered(self):
        assert hivv.COMMANDS.get("contributors") is not None

    def test_parser_accepts_github_flag(self):
        p = hivv.build_parser()
        a = p.parse_args(["contributors", "--github"])
        assert a.github is True

    def test_parser_without_flag(self):
        p = hivv.build_parser()
        a = p.parse_args(["contributors"])
        assert a.github is False

    def test_contributors_command_is_callable(self):
        assert callable(getattr(hivv, "cmd_contributors", None))

    def test_empty_contributor_list_prints_no_data(self, capsys, monkeypatch):
        """No contributors must read as 'no data', never as a fake count."""
        import argparse
        monkeypatch.setattr(hivv, "_gh_get", lambda *a, **k: (200, []))
        try:
            hivv.cmd_contributors(argparse.Namespace(github=True))
        except SystemExit:
            pass
        out = capsys.readouterr().out
        assert "no contributor data" in out.lower()

    def test_contributors_are_sorted_by_commits(self, capsys, monkeypatch):
        import argparse
        monkeypatch.setattr(hivv, "_gh_get", lambda *a, **k: (200, [
            {"login": "low", "contributions": 2},
            {"login": "high", "contributions": 50},
        ]))
        try:
            hivv.cmd_contributors(argparse.Namespace(github=True))
        except SystemExit:
            pass
        out = capsys.readouterr().out
        assert out.index("high") < out.index("low"), (
            "the biggest contributor must be listed first"
        )


class TestPublicPage:
    def test_page_exists(self):
        assert (REPO / "public_html" / "contributors.html").exists()

    def test_page_has_no_secrets(self):
        src = (REPO / "public_html" / "contributors.html").read_text()
        for bad in ("HIVV_CONTROL_TOKEN", "HIVV_SESSION_SECRET", "api_key",
                    "password", "Bearer "):
            assert bad not in src, f"the contributors page must not contain {bad!r}"

    def test_page_reads_the_public_api(self):
        src = (REPO / "public_html" / "contributors.html").read_text()
        assert "/api/hive/contributors" in src

    def test_page_escapes_contributor_data(self):
        """A contributor login is UNTRUSTED input — it goes through esc()."""
        src = (REPO / "public_html" / "contributors.html").read_text()
        assert "function esc(" in src
        # every interpolation of a contributor field must be escaped
        assert "esc(c.login)" in src
        assert "esc(c.html_url)" in src
        assert "esc(c.avatar_url)" in src

    def test_links_open_safely(self):
        src = (REPO / "public_html" / "contributors.html").read_text()
        assert 'rel="noopener"' in src
