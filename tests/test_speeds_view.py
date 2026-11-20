"""Tests for `hivv speeds` VIEW FALLBACK — the ledger from any machine.

THE BUG (yalla, 2026-11-20)
`hivv speeds` called /api/provenance/requests with NO view parameter, and
that endpoint correctly DEFAULTS to view=operator (the ledger holds who
asked and from where). Result: from every machine except the hub, a flat
403 and "export HIVV_CONTROL_TOKEN" — the command was hub-only in
practice while its docs promised it everywhere.

THE FIX
operator first (full detail where we're allowed), then the API's own
hinted fallback: view=partner, which carries EVERY timing field the
tables need (duration, ttfb, tok/s, model, node) and no identity unless
a row's privacy policy allows it. "How fast is my AI" works from
anywhere; only the per-user breakdown stays operator-only — and when it
is absent the UI says so instead of printing one meaningless "?" bucket.

No network: http() is monkeypatched through both paths.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli_speeds", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli_speeds"] = hivv
spec.loader.exec_module(hivv)


def _rows(with_identity: bool):
    row = {
        "created_at": "2026-11-20T10:00:00Z",
        "duration_ms": 1500, "ttfb_ms": 200, "tokens_per_sec": 45,
        "model": "gemma-4-E2B-it-GGUF", "answered_by_node": "masjid",
        "transport": "direct", "endpoint": "/api/chat",
    }
    if with_identity:
        row["principal"] = "v_test123"
    return [row]


def _operator_http(rows):
    def fake(method, path, **kw):
        if path.startswith("/api/provenance/requests"):
            return 200, {"data": {"view": "operator", "rows": rows}}
        return 404, {}
    return fake


def _bee_http(rows):
    """What a NON-hub machine sees: operator → 403, partner → rows."""
    calls = []
    def fake(method, path, **kw):
        calls.append(path)
        if path.startswith("/api/provenance/requests"):
            if "view=" in path:
                assert "view=partner" in path, (
                    "the fallback must use the API's own hinted view"
                )
                return 200, {"data": {"view": "partner", "rows": rows}}
            return 403, {"error": "operator view requires control-token or admin session"}
        return 404, {}
    fake.calls = calls
    return fake


def _run(monkeypatch, capsys, fake, **kw):
    monkeypatch.setattr(hivv, "http", fake)
    opts = {"days": 1, "limit": 50, "json_output": False}
    opts.update(kw)
    hivv.cmd_speeds(argparse.Namespace(**opts))
    return capsys.readouterr().out


class TestOperatorPathUnchanged:
    def test_full_detail_on_the_hub(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, _operator_http(_rows(True)))
        assert "per user" in out
        assert "v_test123" in out, "operator view must still show WHO"
        assert "operator-only" not in out


class TestFallbackForBees:
    def test_partner_view_used_after_403(self, monkeypatch, capsys):
        fake = _bee_http(_rows(with_identity=False))
        out = _run(monkeypatch, capsys, fake)
        assert any("view=partner" in c for c in fake.calls), (
            "after the operator 403 the CLI must retry with view=partner"
        )
        assert "masjid" in out, "the timing tables must still render"
        assert "per-user detail is operator-only" in out

    def test_no_fake_user_bucket_without_identity(self, monkeypatch, capsys):
        """A table of one '?' bucket would be a lie — the section must say
        it is operator-only instead."""
        out = _run(monkeypatch, capsys, _bee_http(_rows(with_identity=False)))
        assert "operator-only in this view" in out

    def test_json_carries_the_view_and_restriction(self, monkeypatch, capsys):
        out = _run(monkeypatch, capsys, _bee_http(_rows(with_identity=False)),
                   json_output=True)
        d = json.loads(out)
        assert d["view"] == "partner"
        assert d["restricted"] is True
        # timings still complete for consumers
        assert d["summary"]["requests"] == 1
        assert d["summary"]["by_user"] == [], "no identity → no per-user rollup"

    def test_both_views_refused_explains_both(self, monkeypatch, capsys):
        def fake(method, path, **kw):
            if path.startswith("/api/provenance/requests"):
                return 403, {"error": "no"}
            return 404, {}
        monkeypatch.setattr(hivv, "http", fake)
        with pytest.raises(SystemExit) as e:
            hivv.cmd_speeds(argparse.Namespace(days=1, limit=50, json_output=False))
        assert e.value.code == 1
        c = capsys.readouterr()
        out = c.out + c.err   # die() writes to stderr
        assert "operator AND partner" in out
        assert "HIVV_CONTROL_TOKEN" in out


class TestBothSpellings:
    """People type `speed` and `speeds` interchangeably — both must exist
    as commands (they are DIFFERENT things: benchmark vs ledger, and each
    should be discoverable)."""

    def test_speed_is_registered(self):
        assert hivv.COMMANDS.get("speed") is not None

    def test_speeds_is_registered(self):
        assert hivv.COMMANDS.get("speeds") is not None

    def test_both_parse(self):
        p = hivv.build_parser()
        p.parse_args(["speed"])
        a = p.parse_args(["speeds", "--days", "7", "--json"])
        assert a.days == 7 and a.json_output is True
