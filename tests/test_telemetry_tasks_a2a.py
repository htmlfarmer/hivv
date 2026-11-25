"""Deeper telemetry + distributed task execution + MCP/A2A interoperability.

Static checks only (no network, no HOME writes, no database). These pin the
things that rot silently:

  1. the agent card exists, in BOTH well-known paths, and is honest
  2. the bridge manifest advertises endpoints that ACTUALLY EXIST
  3. every live route of the new surfaces is documented in openapi.yaml
  4. the house laws survive: no eval, SSRF-guarded outbound, allow-listed
     labels, and a policy gate that is not bypassed

A failing test here is a gift: it names the exact thing the change broke
before a peer hive notices.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "public_html"
API = REPO / "api"


def _load(rel: str) -> dict:
    return json.loads((PUBLIC / rel).read_text())


def _src(rel: str) -> str:
    return (API / rel).read_text()


# ── the agent card ──────────────────────────────────────────────────────────


class TestAgentCard:
    def test_the_well_known_card_exists_at_both_paths(self):
        # A2A v1.0 says /.well-known/agent-card.json; v0.2 said
        # /.well-known/agent.json. A card is a card — both doors stay open.
        assert (PUBLIC / ".well-known" / "agent-card.json").exists()
        assert (PUBLIC / ".well-known" / "agent.json").exists(), "the v0.2 door stays open too"

    def test_the_two_doors_serve_identical_content(self):
        assert _load(".well-known/agent-card.json") == _load(".well-known/agent.json")

    def test_the_card_declares_the_protocol_and_the_hive_by_its_own_domain(self):
        card = _load(".well-known/agent-card.json")
        assert card["protocolVersion"].startswith("1."), card["protocolVersion"]
        assert card["name"]
        assert card["description"]
        assert card["url"].startswith("https://")
        assert card["x-hivv"]["hive"] == "hivv.org", "a hive is named by its own domain"
        assert card["x-hivv"]["mcp"].endswith("/mcp")
        assert card["x-hivv"]["telemetry"].endswith("/api/telemetry/overview")

    def test_the_card_publishes_real_skills(self):
        card = _load(".well-known/agent-card.json")
        skills = card["skills"]
        assert len(skills) >= 3
        for s in skills:
            assert s["id"] and s["name"] and s["description"]
            assert isinstance(s["examples"], list) and s["examples"]

    def test_the_card_declares_its_transports(self):
        card = _load(".well-known/agent-card.json")
        assert card["preferredTransport"]
        assert card["additionalInterfaces"]
        for iface in card["additionalInterfaces"]:
            assert iface["url"].startswith("https://")
            assert iface["transport"]

    def test_the_card_and_the_route_agree(self):
        # The static copy is generated from the route; if they drift, a client
        # that reads the file sees a different hive than one that asks the API.
        route = _src("routes/a2a-routes.js")
        assert "protocolVersion: PROTOCOL_VERSION" in route
        card = _load(".well-known/agent-card.json")
        assert card["protocolVersion"] == "1.0.0"


# ── the bridge manifest ─────────────────────────────────────────────────────


class TestBridgeManifestAdvertisesRealEndpoints:
    def _route_exists(self, path: str) -> bool:
        """Is there a live route for this manifest endpoint?"""
        src = _src("routes/bridge-routes.js")
        rel = path.split("hivv.org")[-1] if "hivv.org" in path else path
        rel = rel.split("?")[0].rstrip("/")
        if not rel:
            return True
        pattern = re.escape(rel).replace(r"\{node_id\}", "[^'\"]*").replace(r"\{id\}", "[^'\"]*")
        return re.search(r"router\.(get|post|put|delete)\(\s*'" + pattern + r"'", src) is not None

    def test_submit_and_receipts_now_exist(self):
        # The manifest advertised these two since the first release while the
        # routes did not exist — a door painted on a wall.
        m = _load(".bridge/hivv.json")
        assert m["endpoints"]["submit"] == "https://hivv.org/api/bridge/requests"
        assert m["endpoints"]["receipts"] == "https://hivv.org/api/bridge/receipts"
        src = _src("routes/bridge-routes.js")
        assert "router.post('/requests'" in src
        assert "router.get('/requests/:id'" in src
        assert "router.post('/receipts'" in src
        assert "router.get('/receipts'" in src

    def test_the_manifest_advertises_the_new_protocols(self):
        m = _load(".bridge/hivv.json")
        assert m["protocols"]["a2a"] == "a2a/1.0"
        assert m["protocols"]["mcp"]
        assert m["protocols"]["bridge"] == "open-hives/0.1"
        for key in ("a2a", "agent_card", "telemetry", "mcp"):
            assert key in m["endpoints"], f"{key} must be discoverable"

    def test_the_two_discovery_doors_still_agree(self):
        assert _load(".bridge/hivv.json") == _load(".well-known/hivv.json")


# ── documentation parity ────────────────────────────────────────────────────


class TestOpenApiParity:
    @pytest.fixture(scope="class")
    def spec(self) -> dict:
        return yaml.safe_load((PUBLIC / "openapi.yaml").read_text())

    @pytest.mark.parametrize(
        "path",
        [
            "/api/bridge/requests",
            "/api/bridge/receipts",
            "/api/telemetry/overview",
            "/api/telemetry/errors",
            "/api/telemetry/slo",
            "/api/telemetry/series",
            "/api/telemetry/metrics",
            "/api/a2a",
            "/api/a2a/agent-card",
        ],
    )
    def test_the_new_routes_are_documented(self, spec, path):
        assert path in spec["paths"], f"{path} is live but missing from openapi.yaml"

    def test_the_telemetry_audience_is_explicit(self, spec):
        params = spec["paths"]["/api/telemetry/errors"]["get"]["parameters"]
        views = [p for p in params if p["name"] == "view"]
        assert views, "the view parameter must be documented"
        assert set(views[0]["schema"]["enum"]) == {"public", "partner", "operator"}


# ── the house laws ──────────────────────────────────────────────────────────


class TestHouseLaws:
    def test_no_eval_anywhere_in_the_new_code(self):
        for rel in (
            "lib/telemetry.js",
            "lib/task-queue.js",
            "lib/mcp-client.js",
            "lib/a2a-client.js",
            "lib/hive-clients.js",
            "routes/telemetry-routes.js",
            "routes/a2a-routes.js",
            "routes/bridge-routes.js",
        ):
            src = _src(rel)
            assert "eval(" not in src, f"{rel} must not use eval"

    def test_every_outbound_client_is_ssrf_guarded(self):
        for rel in ("lib/mcp-client.js", "lib/a2a-client.js", "lib/hive-clients.js"):
            src = _src(rel)
            assert "ssrf" in src, f"{rel} must route outbound URLs through the SSRF guard"
            assert "checkUrl" in src or "safeFetch" in src

    def test_the_telemetry_label_allow_list_is_a_privacy_boundary(self):
        src = _src("lib/telemetry.js")
        assert "LABEL_ALLOW" in src
        # A prompt must never be storable as a label.
        for forbidden in ("'prompt'", '"prompt"', "'api_key'", "'password'"):
            assert forbidden not in src.split("LABEL_ALLOW = new Set([")[1].split("]);")[0], (
                f"{forbidden} must not be an allow-listed label"
            )

    def test_the_policy_gate_is_not_bypassed_by_the_new_surfaces(self):
        # A2A and the bridge both answer through the SAME gate as /api/chat.
        a2a = _src("routes/a2a-routes.js")
        assert "data.denied" in a2a and "data.asked" in a2a
        bridge = _src("routes/bridge-routes.js")
        assert "data.denied" in bridge and "data.asked" in bridge

    def test_a_maybe_verdict_is_an_interruption_not_a_failure(self):
        src = _src("routes/a2a-routes.js")
        assert "TASK_STATE_AUTH_REQUIRED" in src
        assert "interrupted" in src

    def test_the_task_queue_is_local_first(self):
        src = _src("lib/task-queue.js")
        assert "memory-only" in src, "a queue with no database must still be useful"
        assert "let pool = null" in src

    def test_the_telemetry_is_local_first(self):
        src = _src("lib/telemetry.js")
        assert "memory-only" in src
        assert "let pool = null" in src

    def test_a_metric_with_no_samples_is_never_zero(self):
        src = _src("lib/telemetry.js")
        # percentiles() must return null when there is nothing to report.
        assert "if (!e || !e.count) return null;" in src

    def test_the_bridge_loop_shield_is_enforced(self):
        src = _src("routes/bridge-routes.js")
        assert "loop_detected" in src
        assert "X-Hive-Path" in src or "x-hive-path" in src
        assert "X-Hive-Hops" in src or "x-hive-hops" in src

    def test_the_bridge_holds_at_zero_allowance_instead_of_failing(self):
        src = _src("routes/bridge-routes.js")
        assert "held" in src, "a busy hive holds work; it does not fail it"


# ── migrations ──────────────────────────────────────────────────────────────


class TestMigrations:
    def test_the_new_migrations_exist_and_are_idempotent(self):
        for name in ("028_deeper_telemetry.sql", "029_task_queue.sql"):
            path = API / "migrations" / name
            assert path.exists(), f"{name} is missing"
            sql = path.read_text()
            assert "CREATE TABLE IF NOT EXISTS" in sql
            assert "IF NOT EXISTS" in sql

    def test_the_task_queue_table_matches_the_queue_states(self):
        sql = (API / "migrations" / "029_task_queue.sql").read_text()
        for column in ("state", "kind", "attempts", "lease_worker", "lease_expires_at_ms",
                       "interrupted", "budget", "usage", "trace_id"):
            assert column in sql, f"{column} must be a column"

    def test_the_queue_table_does_not_collide_with_the_legacy_task_table(self):
        """The hive ALREADY had a table named hivv_tasks (migration 003 — the
        dashboard's agent-task board: uuid id, task_type, decision trees,
        approval flow). A CREATE TABLE IF NOT EXISTS hivv_tasks was therefore
        a SILENT no-op: the schema looked created, every INSERT failed with
        "column kind does not exist", and the queue looked like it was
        storing things when it was not.

        The queue's table is hivv_task_queue. This canary keeps it that way.
        """
        queue = (API / "migrations" / "029_task_queue.sql").read_text()
        assert "hivv_task_queue" in queue
        # The legacy name must not be created by the queue's migration...
        assert "CREATE TABLE IF NOT EXISTS hivv_tasks (" not in queue
        # ...nor referenced by its writes.
        assert "INSERT INTO hivv_tasks" not in queue
        # ...and the code must use the same name the migration creates.
        lib = _src("lib/task-queue.js")
        assert "hivv_task_queue" in lib
        assert "INSERT INTO hivv_tasks" not in lib
        assert "CREATE TABLE IF NOT EXISTS hivv_tasks (" not in lib

    def test_the_legacy_task_table_still_belongs_to_the_dashboard(self):
        """The dashboard's own task table must not be disturbed."""
        legacy = (API / "migrations" / "003_hivv_dashboard_schema.sql").read_text()
        assert "hivv_tasks" in legacy
        assert "task_type" in legacy, "the legacy table is the dashboard's, not the queue's"

    def test_the_bridge_receipts_table_exists(self):
        sql = (API / "migrations" / "028_deeper_telemetry.sql").read_text()
        assert "hivv_bridge_receipts" in sql
