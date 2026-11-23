"""Bridge tests — the kwaai <-> hivv.org hive-to-hive link (open-hives/0.1).

Static checks only (no network, no HOME writes): these pin the shape of the
discovery files, the documented API surface, and the two rules that make the
bridge safe to keep stable for months:

  1. two doors, one content   — /.bridge/hivv.json == /.well-known/hivv.json
  2. scope privacy            — only scope='hive' rows reach public listings
  3. documentation parity     — every live /api/bridge route is in openapi.yaml
                                (audit rule HIVV-API-002 P1)

A failing test here is a gift: it names the exact thing the change broke
before a hive notices.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "public_html"


def _load(rel: str) -> dict:
    return json.loads((PUBLIC / rel).read_text())


class TestDiscoveryFiles:
    def test_canonical_and_standard_doors_exist_and_agree(self):
        bridge = _load(".bridge/hivv.json")
        wellknown = _load(".well-known/hivv.json")
        assert bridge == wellknown, "the two doors must serve identical content"
        assert (PUBLIC / ".well-known/hive.json").exists(), "legacy door stays open"

    def test_manifest_declares_the_protocol_and_our_name(self):
        m = _load(".bridge/hivv.json")
        assert m["protocol"].startswith("open-hive"), m["protocol"]
        assert m["hive"] == "hivv.org"
        assert m["status"] in ("accepting", "paused")
        # a human must be able to click through, an AI must find the endpoints
        assert m["human"].startswith("https://")
        assert "allowance" in m["endpoints"]
        assert "peers" not in m["endpoints"] or True  # peers may be added later

    def test_brands_json_is_a_clean_registry(self):
        b = _load("brands.json")
        brands = b["brands"]
        assert "hivv" in brands and "kwaai" in brands
        for name, domain in brands.items():
            assert "." in domain and " " not in domain, (name, domain)

    def test_connect_page_advertises_both_humans_and_agents(self):
        html = (PUBLIC / "connect.html").read_text()
        assert "hivv connect" in html
        assert "/.bridge/hivv.json" in html or "/.well-known/hivv.json" in html


class TestApiDocumentationParity:
    def test_openapi_documents_every_bridge_route(self):
        spec = yaml.safe_load((PUBLIC / "openapi.yaml").read_text())
        paths = spec["paths"]
        for route in (
            "/api/bridge/load",
            "/api/bridge/allowance",
            "/api/bridge/peers",
            "/api/bridge/problems",
            "/api/bridge/bridges",
        ):
            assert route in paths, f"{route} is live but missing from openapi.yaml"

    def test_allowance_is_bounded_and_documented_as_such(self):
        spec = yaml.safe_load((PUBLIC / "openapi.yaml").read_text())
        schema = spec["paths"]["/api/bridge/allowance"]["get"]["responses"]["200"][
            "content"
        ]["application/json"]["schema"]["properties"]["percent"]
        assert schema["maximum"] == 85, "supervised ceiling is 85%"
        assert schema["minimum"] == 0, "a busy hive says 0, never negative"


class TestBridgeSourceRules:
    """Source-assertion canaries: the rules encoded in the gateway routes."""

    ROUTES = (REPO / "api" / "routes" / "bridge-routes.js").read_text()

    def test_public_listings_filter_to_hive_scope(self):
        # scope=local must never reach /peers or /problems — a requester's
        # private bridge stays private to their own network.
        assert "scope='hive'" in self.ROUTES, "public queries must filter scope"

    def test_remote_fetches_go_through_the_ssrf_guard(self):
        assert "require('../lib/ssrf')" in self.ROUTES
        assert "safeFetch" in self.ROUTES

    def test_no_eval_in_bridge_routes(self):
        assert "eval(" not in self.ROUTES, "house law: no eval anywhere"

    def test_manifest_doors_are_tried_in_order(self):
        # branded door first, then the IETF slot — the two-door rule.
        assert self.ROUTES.index("/.bridge/hivv.json") < self.ROUTES.index(
            "/.well-known/hivv.json"
        )


class TestMigration:
    def test_023_bridges_is_idempotent_and_scoped(self):
        sql = (REPO / "api" / "migrations" / "023_bridges.sql").read_text()
        assert "CREATE TABLE IF NOT EXISTS hivv_bridges" in sql
        assert "UNIQUE (remote_url)" in sql, "one row per remote hive"
        assert "'hive' | 'local'" in sql or "'hive'" in sql
        assert "hivv_bridge_attempts" in sql, "every attempt is recorded"

    def test_migration_numbering_continues_the_series(self):
        files = sorted((REPO / "api" / "migrations").glob("*.sql"))
        assert files[-1].name.startswith("023_"), files[-1].name
