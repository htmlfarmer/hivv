#!/usr/bin/env python3
"""Regression tests: what transport does `hivv ask <bee>` actually use?

THE QUESTION THIS ANSWERS (asked 2026-11-22)
──────────────────────────────────────────────
"Does DIRECT messaging work outside a local home network? Is it tested and
proven?"

THE HONEST ANSWER (verified live against the running hive on 2026-11-22)
──────────────────────────────────────────────────────────────────────────
NO. Direct (peer-to-peer) messaging is a LAN-ONLY transport. The evidence:

  1. A bee advertises ONLY its LAN address in the heartbeat. `_local_ip()`
     returns the 192.168.x.x address and NOTHING else — no public IP, no
     VPN address:
         public_html/hivv-cli.py  →  m["lan_ip"] = _local_ip()
     The `public_ip` field the hub shows for a bee is the HUB'S Cloudflare
     edge IP (every bee reported 104.23.160.66 / 172.68.175.68 — the
     hub's egress), NOT the bee's own address. It is not a routable
     address for that bee.

  2. The direct path dials `lan_ip`:
         cmd_node_chat → ip = match.get("lan_ip") or match.get("ip")
     A 192.168.x.x address is unreachable from another network.

  3. Tailscale is a FIREWALL RULE, not a transport. `hivv firewall --apply
     --mode tailscale` opens 100.64.0.0/10 — but the CLI never advertises
     or dials a 100.x address. So the VPN path is configured but UNREACHABLE
     by the code that would use it.

  4. What DOES work across networks is the RELAY: the hub pushes an
     `inference_job` into the bee's long-poll inbox, the bee runs it
     locally, and POSTs the result back. Verified live:
         relay to masjid → ok in 21.5s
         relay to yalla   → ok in 46.6s
     This works behind NAT because the BEE dials OUT to the hub.

So the contract is:
  * same LAN        → DIRECT (fast, no hub in the path)
  * different LAN   → RELAY through the hub (works behind NAT)
  * localhost-bound → RELAY (direct can NEVER work — the model refuses LAN)
  * volunteer OFF   → relay is REFUSED (403) — the bee is firewalled off

These tests pin that behavior so a future change cannot quietly turn
"direct" into a lie (the old `/api/chat {provider: name}` bug answered
from a DIFFERENT bee and printed it as the named one).

Run:
    python3 -m pytest tests/test_direct_messaging.py -q
"""

from __future__ import annotations

import ast
import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


def _load_cli():
    spec = importlib.util.spec_from_file_location("hivv_cli_transport", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


class TestDirectIsLanOnly:
    """The direct transport must be LAN-only — and say so."""

    def test_heartbeat_advertises_only_the_lan_ip(self):
        """A bee must NOT advertise a public/VPN address it cannot be
        dialled on — that would make `ask` hang on an unroutable address."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def _local_ip(", 1)[1].split("\ndef ", 1)[0]
        assert "lan_ip" in src
        # _local_ip must not try to discover a tailscale/public address
        for bad in ("tailscale ip", "api.ipify", "ifconfig.me"):
            assert bad not in body, (
                f"_local_ip must stay LAN-only (found {bad!r})")

    def test_direct_path_dials_the_lan_ip(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        assert 'match.get("lan_ip")' in body, (
            "the direct path must dial the bee's lan_ip")

    def test_direct_path_preflights_tcp_before_claiming_success(self):
        """Never print 'chatting with X' for a port that refuses."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        assert "_tcp_ok(" in body, (
            "the direct path must TCP-preflight before dialling")

    def test_self_is_swapped_to_loopback(self):
        """Asking your OWN bee must use 127.0.0.1 — a model bound to
        localhost refuses its own LAN IP (the yalla/ashy bug)."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        assert 'ip = "127.0.0.1"' in body, (
            "asking your own bee must swap to loopback")


class TestRelayIsTheOffLanPath:
    """The relay is what makes off-LAN work — pin that it exists."""

    def test_relay_helper_exists_and_pins_a_node_id(self):
        mod = _load_cli()
        assert hasattr(mod, "_relay_chat_to_bee")
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def _relay_chat_to_bee(", 1)[1].split("\ndef ", 1)[0]
        assert '"node_id": node_id' in body, (
            "the relay MUST pin a node_id — an unpinned relay answers from "
            "whichever bee is free and lies about who answered")

    def test_relay_reports_failure_instead_of_silence(self):
        mod = _load_cli()
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def _relay_chat_to_bee(", 1)[1].split("\ndef ", 1)[0]
        assert "failed" in body and "refused" in body, (
            "the relay must distinguish 'refused' from 'failed'")

    def test_relay_never_spoofs_the_provider_field(self):
        """THE OLD LIE: `/api/chat {provider: <bee-name>}` never matched a
        provider (providers are endpoint names like 'ashy:8090'), so the
        router answered from a DIFFERENT bee and printed it as the named
        one. The relay path must not reintroduce that.

        We inspect the CODE (the AST), not the text — the docstring
        deliberately MENTIONS the old bug, and prose is not behaviour.
        """
        mod = _load_cli()
        tree = ast.parse(CLI.read_text(encoding="utf-8", errors="replace"))
        fn = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_relay_chat_to_bee":
                fn = node
                break
        assert fn is not None, "_relay_chat_to_bee not found"

        # Any dict KEY named "provider" in the relay body would be the bug.
        provider_keys = []
        for node in ast.walk(fn):
            if isinstance(node, ast.Dict):
                for k in node.keys:
                    if isinstance(k, ast.Constant) and k.value == "provider":
                        provider_keys.append(node.lineno)
        assert not provider_keys, (
            f"the relay must NOT send a 'provider' field (lines {provider_keys}) "
            "— it silently answers from the wrong bee")

    def test_relay_fallback_exists_in_the_ask_command(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        assert "_relay_chat_to_bee(" in body, (
            "`hivv ask` must fall back to the relay when direct fails")


class TestTransportIsReportedHonestly:
    """The transport must be visible — a user must never be misled about
    which path carried their message."""

    def test_the_transaction_reports_the_transport(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        assert '"transport"' in body, (
            "the transaction must report the transport used")

    def test_relay_transport_is_labelled(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        assert "relay" in body, (
            "the relay path must be labelled as relay in the output")


class TestFirewallTailscaleIsAFirewallNotATransport:
    """Document the gap honestly: the tailscale firewall mode exists, but
    the CLI never dials a tailscale address. Pin it so that IF someone
    wires up a VPN transport, this test tells them to update the docs."""

    def test_tailscale_firewall_mode_exists(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "100.64.0.0/10" in src, (
            "the tailscale firewall mode must keep allowing the VPN range")

    def test_the_cli_does_not_yet_dial_a_tailscale_address(self):
        """KNOWN GAP (not a bug — a missing feature).

        The firewall opens 100.64.0.0/10 but no code path advertises or
        dials a 100.x address, so a Tailscale-connected bee is still
        reached via RELAY, not direct.

        If someone implements a VPN transport, this test SHOULD fail —
        that is the signal to update the docs and the AGENTS.md notes.
        """
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_node_chat(", 1)[1].split("\ndef ", 1)[0]
        # the direct path builds its URL from a single ip variable
        assert '"http://{ip}:{port}/v1/chat/completions"' in body or \
               "http://{ip}:{port}" in body, (
            "the direct path dials one ip variable")
        # that variable is fed from lan_ip / ip only
        assert 'match.get("tailscale_ip")' not in body and \
               'match.get("vpn_ip")' not in body, (
            "KNOWN GAP: the CLI does not dial a tailscale address yet. "
            "Off-LAN bees are reached via RELAY. If you just added a VPN "
            "transport, update this test AND the docs.")


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))
