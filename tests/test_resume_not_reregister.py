#!/usr/bin/env python3
"""Regression tests: an agent restart must RESUME, not re-register.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
2026-11-22 (yalla): the hub quarantined yalla with "crash-loop: 5
re-registrations within 10 minutes". yalla was not dead — its agent was
restarting every ~100 seconds and EVERY restart re-registered it.

The cause was in the CLI's agent startup:

    st.update({"started_at": ..., "pid": ..., "node_id": None, ...})

The agent NULLED its own node_id on every start, so the first loop
iteration always took the REGISTER branch instead of the HEARTBEAT branch.
A bee's node_id is its IDENTITY — issued by the hub and stored in the state
file — not a per-run value. Nulling it threw away knowledge the agent
already had and forced a re-register that could only ever return the SAME
id (the hub keys it by hostname + hw_id).

That turned a routine restart into an accusation: five restarts in ten
minutes looked like a crash-loop to the detector, and the quarantine that
followed FROZE the heartbeat — which was the only thing that could clear
the crash-loop accusation. A deadlock with no exit except a human.

The fix:
  * the agent KEEPS its known node_id across a restart;
  * it skips the startup register when it already knows who it is (the
    heartbeat re-announces everything the register did);
  * the register is still there for a bee whose state was wiped (the
    hub's hw_id recovery path);
  * the hub now re-reads local_models + capabilities on EVERY heartbeat, so
    skipping the register cannot leave a stale model list behind.

Verified live on ashy (2026-11-22):
    [21:47:11] agent started (pid=1889183, hub=https://hivv.org)
    [21:47:11] resuming as ashy (no re-register needed)
    [21:47:11] hb=200 node=ashy
→ no "Node re-registered" line in the hub log.

Run:
    python3 -m pytest tests/test_resume_not_reregister.py -q
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"
ORCH = REPO / "api" / "lib" / "orchestrator.js"


def _agent_body() -> str:
    src = CLI.read_text(encoding="utf-8", errors="replace")
    start = src.find("def cmd_agent(stop_event)")
    assert start != -1, "cmd_agent not found"
    end = src.find("# 3. inbox poll", start)
    assert end != -1, "the agent loop end marker moved"
    return src[start:end]


class TestAgentKeepsItsIdentity:
    def test_node_id_is_not_nulled_on_startup(self):
        """THE core regression: nulling node_id forces a re-register."""
        body = _agent_body()
        startup = body.split("write_state(st)")[0]
        assert '"node_id": None' not in startup, (
            "the agent must NOT null its node_id on startup — that forces "
            "a re-register on every restart (yalla's crash-loop)")

    def test_the_known_node_id_is_preserved(self):
        body = _agent_body()
        assert '_known_node_id = st.get("node_id") or None' in body, (
            "the agent must read its known node_id out of the state file")
        assert '"node_id": _known_node_id' in body, (
            "the agent must write the known node_id back")

    def test_the_register_is_skipped_when_the_id_is_known(self):
        body = _agent_body()
        assert "if _known_node_id:" in body, (
            "a restarting bee must skip the startup register")
        assert "resuming as" in body, (
            "the agent must say it is resuming (the log is the proof)")

    def test_the_register_is_still_reachable_for_a_wiped_state(self):
        """A bee whose state was wiped must still be able to register."""
        body = _agent_body()
        assert "/api/nodes/register" in body, (
            "the register path must remain for the state-wipe recovery")

    def test_the_heartbeat_re_announces_what_the_register_did(self):
        """Skipping the register must not lose the model's presence."""
        body = _agent_body()
        for field in ('"local_models"', '"tools"', '"tools_port"',
                      '"volunteer"', '"capabilities"'):
            assert field in body, (
                f"the heartbeat must carry {field} — skipping the register "
                "must not make the bee's presence go stale")


class TestHubRefreshesPresenceOnHeartbeat:
    def test_local_models_are_updated_by_a_heartbeat(self):
        src = ORCH.read_text(encoding="utf-8", errors="replace")
        body = src.split("updateHeartbeat(nodeId, data, opts = {})", 1)
        assert len(body) == 2, "updateHeartbeat not found"
        hb = body[1].split("\n  getNodeStatus", 1)[0]
        assert "data.local_models" in hb, (
            "the heartbeat must update local_models — otherwise a bee that "
            "installs a model after its last register advertises the OLD "
            "list forever")
        assert "data.capabilities" in hb, (
            "the heartbeat must refresh capabilities too")

    def test_a_re_registration_does_not_fake_a_fresh_heartbeat(self):
        """A crash-loop must stay VISIBLE, not look permanently alive."""
        src = ORCH.read_text(encoding="utf-8", errors="replace")
        reg = src.split("registerNode(nodeData)", 1)[1].split("updateHeartbeat", 1)[0]
        assert "last_heartbeat: existing?.last_heartbeat || now" in reg, (
            "a re-registration must keep the OLD heartbeat age — setting it "
            "to `now` made a crash-looping bee look permanently alive")

    def test_a_healthy_heartbeat_clears_the_flap_counter(self):
        src = ORCH.read_text(encoding="utf-8", errors="replace")
        hb = src.split("updateHeartbeat(nodeId, data, opts = {})", 1)[1]
        hb = hb.split("\n  getNodeStatus", 1)[0]
        assert "node.flap_events = []" in hb, (
            "a healthy heartbeat must clear the crash-loop accusation — "
            "otherwise the quarantine is permanent")


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))
