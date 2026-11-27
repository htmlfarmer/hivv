"""The SERVED-TRAFFIC accounting — why `hivv stats` showed REQS 0.

THE BUG (2026-11-26)
───────────────────
`hivv stats` printed a REQS column that was 0 for every bee in the hive,
forever, while the hive was serving hundreds of requests a day (every call
xyzo.org makes through this hub included). Two independent causes:

  1. The BEE never reported anything. The agent's heartbeat sends
     `stats.total_requests`, computed from a state key (`local_requests`)
     that the CLI NEVER wrote — a structural zero, not a measurement.
  2. The HUB never counted either. Nearly every answer is routed DIRECTLY
     (hub → bee's llama-server); the bee's agent is not in that path, so the
     bee cannot see the request and the hub did not tally it. Only RELAY
     work (bee behind NAT) was ever counted — which is why TASKS showed a
     few dozen and TOKENS showed a few hundred while the real numbers were
     orders of magnitude bigger.

THE FIX, in two halves
──────────────────────
  * the CLI counts the requests its own agent serves (`local_requests`), so
    the bee-reported counter is real;
  * the HUB counts what it ROUTES (direct + relay), because the hub is the
    only place where both transports are visible.

These tests pin the CLI half (the wiring) and the LIVE end-to-end proof
(an answer through the hub moves the answering bee's REQS counter).
"""
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
GATEWAY = "http://localhost:3011"


def _cli() -> str:
    return CLI_PATH.read_text(encoding="utf-8", errors="replace")


def _gateway_up() -> bool:
    try:
        with urllib.request.urlopen(GATEWAY + "/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


needs_gateway = pytest.mark.skipif(
    not _gateway_up(), reason="gateway not running on localhost:3011")


class TestTheBeeCountsItsOwnWork:
    """The CLI half: the counter must be WRITTEN, not just read."""

    def test_local_requests_is_written_when_a_relay_job_is_served(self):
        src = _cli()
        # the relay path bumps tasks_completed + tokens_processed; the
        # request counter belongs in the same breath.
        assert 'st2["local_requests"] = (st2.get("local_requests") or 0) + 1' in src, (
            "the agent must count the relay jobs it serves — without this the "
            "heartbeat reports total_requests = 0 forever"
        )

    def test_local_requests_is_written_when_a_coding_job_finishes(self):
        src = _cli()
        coding = src.split("def _run_coding_job(")[-1].split("\ndef ")[0]
        assert "local_requests" in coding, (
            "a coding job is a served request too"
        )

    def test_the_heartbeat_still_derives_total_requests_from_local_requests(self):
        """The read side must stay wired to the write side."""
        src = _cli()
        assert '"total_requests": max(0, (st.get("local_requests") or 0) -' in src, (
            "the heartbeat's total_requests must come from local_requests"
        )

    def test_the_counter_is_monotonic_across_heartbeats(self):
        """The delta is computed against the PREVIOUS heartbeat — a counter
        that went backwards must not mint negative history."""
        src = _cli()
        for key in ("tasks_completed", "tasks_failed", "tokens_processed",
                    "local_requests", "local_cost"):
            assert f'"{key}"' in src.split("monotonic counters")[1][:900], (
                f"{key} must take part in the monotonic-counter guard"
            )


class TestTheStatsTable:
    def test_the_table_has_a_reqs_column_and_says_what_it_means(self):
        src = _cli()
        table = src.split("def cmd_stats")[1].split("def ")[0]
        assert "'REQS'" in table, "the stats table must keep its REQS column"
        assert "REQS = requests the hive routed" in table, (
            "a number without a meaning is a rumour — say what REQS counts"
        )

    def test_the_totals_row_sums_the_requests(self):
        src = _cli()
        table = src.split("def cmd_stats")[1].split("def ")[0]
        assert 'totals.get("requests", 0)' in table


@needs_gateway
class TestLiveEndToEnd:
    """An answer through the hub must move the answering bee's counter."""

    def _stats(self) -> dict:
        with urllib.request.urlopen(GATEWAY + "/api/control/stats", timeout=10) as r:
            return json.loads(r.read().decode())

    def _requests_for(self, stats: dict, name: str) -> int:
        for n in stats.get("nodes", []):
            if (n.get("name") or n.get("id")) == name:
                return int(n.get("requests") or 0)
        return -1

    def test_an_answer_increments_the_answering_bees_request_counter(self):
        before = self._stats()
        payload = json.dumps({
            "model": "auto",
            "messages": [{"role": "user", "content": "Reply with the single word: PONG"}],
            "stream": False,
            "max_tokens": 16,
        }).encode()
        req = urllib.request.Request(
            GATEWAY + "/api/chat", data=payload, method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                answered_by = r.headers.get("X-Hivv-Answered-By") or ""
                r.read()
        except urllib.error.HTTPError as e:
            pytest.skip(f"the hub refused the probe: {e.code}")

        assert answered_by, "the answer must name the bee that served it"
        name = answered_by.split("/")[0].strip()
        after = self._stats()
        was = self._requests_for(before, name)
        now = self._requests_for(after, name)
        assert was >= 0, f"the answering bee {name} is not in the stats roster"
        assert now > was, (
            f"{name} answered a request but its REQS counter did not move "
            f"({was} -> {now}) — the served-traffic accounting is broken again"
        )

    def test_the_stats_payload_exposes_the_transport_split(self):
        stats = self._stats()
        for n in stats.get("nodes", []):
            assert "transport_split" in n, "the transport split must be visible"
            assert isinstance(n.get("bee_reported_requests"), int)
