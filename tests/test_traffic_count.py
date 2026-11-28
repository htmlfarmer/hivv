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

        assert answered_by, "the answer must name who served it"
        self._assert_served_counter_moved(answered_by, before, self._stats())

    @staticmethod
    def _assert_served_counter_moved(answered_by: str, before: dict,
                                     after: dict) -> None:
        """An answer landed ⇒ some bee's REQS counter moved.

        THE HEADER NAMES THE ROUTE, NOT THE BEE (found 2026-11-28, blocking
        every deploy).

        The hub's own endpoint (HIVV_LOCAL_ENDPOINTS) competes for every
        request and wins about one time in three. Its receipt says
        "localhost" — a ROUTE label, and there is no node by that name, so
        the old `was >= 0` check failed outright. The test became a
        coin-flip: green when a bee happened to win, red when the hub's own
        box did. It failed on the rolled-back production code too, so it was
        never about the code under test.

        The accounting itself is CORRECT — measured on the live hub, six
        requests (2 via localhost, 4 via masjid) moved ashy +2 and masjid
        +4: a localhost answer credits the bee that OWNS this box, which is
        exactly how the router is built. So assert on the COUNTERS — the
        property actually under test — and demand the NAMED bee only when
        the label really is one.

        Extracted (and covered without a gateway) because the branch is a
        routing lottery: a live run may hit only one side, and the side that
        used to fail is the one that matters.
        """
        def counters(stats: dict) -> dict:
            return {(n.get("name") or n.get("id")): int(n.get("requests") or 0)
                    for n in stats.get("nodes", [])}

        name = answered_by.split("/")[0].strip()
        before_c, after_c = counters(before), counters(after)
        deltas = {k: after_c.get(k, 0) - before_c.get(k, 0)
                  for k in set(before_c) | set(after_c)}
        credited = {k: v for k, v in deltas.items() if v > 0}

        if name in before_c:
            assert deltas.get(name, 0) > 0, (
                f"{name} answered a request but its REQS counter did not move "
                f"({before_c[name]} -> {after_c.get(name)}) — the served-traffic "
                f"accounting is broken again"
            )
        else:
            # A route label, not a bee: the credit landed on whichever bee
            # owns this box. Something must have moved, or nothing was credited.
            assert credited, (
                f"an answer was served via route '{name}' but NO bee's REQS "
                f"counter moved ({before_c} -> {after_c}) — the served-traffic "
                f"accounting is broken again"
            )

    def test_the_stats_payload_exposes_the_transport_split(self):
        stats = self._stats()
        for n in stats.get("nodes", []):
            assert "transport_split" in n, "the transport split must be visible"
            assert isinstance(n.get("bee_reported_requests"), int)

class TestRouteLabelIsNotABeeName:
    """The receipt names a ROUTE; the credit lands on a BEE.

    No gateway needed — the branch under test is a routing lottery, so a live
    run may exercise only one side. The side that USED TO FAIL is the
    hub's-own-endpoint side, and it is pinned here deterministically.

    Found 2026-11-28 blocking every deploy: the old assertion looked the
    receipt's prefix up in the node roster, so a correct answer served by the
    hub's own endpoint ("localhost") failed with "not in the stats roster" —
    on the rolled-back production code too.
    """

    # staticmethod AGAIN: copied as a plain function it would re-bind the
    # instance on access, and the helper takes no self.
    _A = staticmethod(TestLiveEndToEnd._assert_served_counter_moved)

    @staticmethod
    def _stats(nodes):
        return {"nodes": [{"name": n, "requests": r} for n, r in nodes]}

    def test_a_bee_label_requires_that_bee_to_have_moved(self):
        # masjid served → masjid must be credited
        self._A("masjid/Qwen2.5-0.5B (direct)",
                self._stats([("masjid", 100), ("ashy", 47)]),
                self._stats([("masjid", 101), ("ashy", 47)]))

    def test_a_bee_that_served_but_was_not_credited_fails(self):
        # the ORIGINAL property, intact: serving without a counter move is broken
        with pytest.raises(AssertionError) as e:
            self._A("masjid/Qwen2.5-0.5B (direct)",
                    self._stats([("masjid", 100), ("ashy", 47)]),
                    self._stats([("masjid", 100), ("ashy", 47)]))
        assert "did not move" in str(e.value)

    def test_a_route_label_passes_when_a_bee_was_credited(self):
        # THE FAILING CASE: "localhost" is a route, not a node — but the credit
        # is real, and it lands on the bee that owns this box (ashy, +2 measured
        # live). This assertion failed outright before.
        self._A("localhost/gemma-4-E2B-it-Q4_K_M (direct)",
                self._stats([("masjid", 1016), ("ashy", 47)]),
                self._stats([("masjid", 1016), ("ashy", 49)]))

    def test_a_route_label_with_no_credit_at_all_still_fails(self):
        # must not become a rubber stamp: nobody credited = accounting broken
        with pytest.raises(AssertionError) as e:
            self._A("localhost/gemma-4-E2B-it-Q4_K_M (direct)",
                    self._stats([("masjid", 1016), ("ashy", 47)]),
                    self._stats([("masjid", 1016), ("ashy", 47)]))
        assert "NO bee's REQS counter moved" in str(e.value)

    def test_the_wrong_bee_moving_does_not_satisfy_a_named_bee(self):
        # a counter moving is not enough when the label IS a bee —
        # some OTHER bee moving must not satisfy the named-bee branch
        with pytest.raises(AssertionError):
            self._A("masjid/Qwen2.5-0.5B (direct)",
                    self._stats([("masjid", 100), ("ashy", 47)]),
                    self._stats([("masjid", 100), ("ashy", 48)]))

