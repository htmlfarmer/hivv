"""Tests for the POCKET PANEL (public_html/panel.html) + POST
/api/control/update-all — the "update my network from my phone" path.

THE MOBILE STORY
Everything needed already existed except the button: per-bee push-update,
signed repair plans, policy approvals, and an admin SESSION that a phone
browser can log into (requireControlAuth accepts localhost, the control
token, OR an admin/owner session cookie). What was missing:
  * a BULK update — one tap for the whole fleet (update-all),
  * a mobile-first page with big touch targets and a confirm step.

SAFETY PINNED HERE
  * dry_run plans without enqueueing (the panel ALWAYS previews first);
  * external URLs are refused — the envelope is hub-relative only, and the
    sha256 comes from the bytes THIS hub serves (never the caller);
  * offline bees are reported as skipped, not pretend-pushed (the first
    draft trusted the cached node.status and claimed to push to a bee that
    had been offline for a day — now it uses getNodeStatus, same as
    /api/control/nodes shows);
  * the panel's confirm button self-disarms after 8s — a stale CONFIRM is
    a hazard in a pocket.
"""
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
PANEL = REPO / "public_html" / "panel.html"
GATEWAY = "http://localhost:3011"


def _panel() -> str:
    return PANEL.read_text(encoding="utf-8")


def _gateway_up() -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(GATEWAY + "/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


needs_gateway = pytest.mark.skipif(
    not _gateway_up(), reason="gateway not running on localhost:3011")


class TestPanelContract:
    def test_panel_exists_and_is_mobile_first(self):
        src = _panel()
        assert 'name="viewport"' in src, "a phone page MUST have a viewport meta"
        assert "viewport-fit=cover" in src, "notch-safe insets for modern phones"

    def test_panel_calls_the_real_endpoints(self):
        src = _panel()
        for ep in ("/api/auth/login", "/api/control/update-all",
                   "/api/control/agents/", "/api/policy/grants",
                   "/api/health", "/api/control/nodes"):
            assert ep in src, f"panel must use {ep}"

    def test_panel_has_no_secrets(self):
        src = _panel()
        for bad in ("HIVV_CONTROL_TOKEN", "HIVV_SESSION_SECRET", "sk-",
                    "Bearer "):
            assert bad not in src, f"panel must not contain {bad!r}"

    def test_update_all_requires_a_confirmation_tap(self):
        """The first tap must only PREVIEW (dry_run) — the confirm tap
        fires. An accidental pocket-tap must never push to the fleet."""
        src = _panel()
        assert 'JSON.stringify({ dry_run: true })' in src
        assert "TAP TO CONFIRM" in src
        assert "setTimeout" in src, "the confirm must self-disarm"

    def test_session_cookie_is_sent(self):
        src = _panel()
        assert "credentials: 'same-origin'" in src


class TestUpdateAllEndpoint:
    """Live against the gateway; skipped where none runs (CI unit job)."""

    def _post(self, body: dict):
        import urllib.request
        req = urllib.request.Request(
            GATEWAY + "/api/control/update-all",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            except Exception:
                return e.code, {}

    @needs_gateway
    def test_dry_run_plans_without_pushing(self):
        code, d = self._post({"dry_run": True})
        assert code == 200, d
        assert d["ok"] is True and d["dry_run"] is True
        assert d["version"].startswith("0.2.")
        assert len(d["sha256"]) == 64, "the envelope must carry the served hash"
        # every registered bee is accounted for: pushed-or-skipped, no orphans
        assert d["total"] == len(d["pushed"]) + len(d["skipped"])
        for s in d["skipped"]:
            assert s["reason"], "a skip must say WHY"

    @needs_gateway
    def test_offline_bees_are_skipped_not_pushed(self):
        """The first draft trusted the cached status and claimed to push to
        a bee offline for a day. getNodeStatus (heartbeat age) is the same
        computation /api/control/nodes shows."""
        code, d = self._post({"dry_run": True})
        assert code == 200
        code2, nodes = 200, None
        import urllib.request
        with urllib.request.urlopen(GATEWAY + "/api/control/nodes", timeout=10) as r:
            nodes = json.loads(r.read().decode())
        offline = {n["id"] for n in nodes.get("nodes", []) if n["status"] == "offline"}
        # THE invariant: never push to a bee /nodes calls offline.
        # (The reverse cross-check — every skip must appear in /nodes'
        # offline set — is deliberately NOT asserted: getNodeStatus derives
        # from heartbeat age and is FRESHER than the cached field the sweep
        # updates, so a just-died bee can be skipped-as-offline one sweep
        # before /nodes agrees. Freshness in the safe direction is fine.)
        for pid in d["pushed"]:
            assert pid not in offline, (
                f"{pid} shows OFFLINE on /nodes but update-all pushed to it"
            )

    @needs_gateway
    def test_external_url_is_refused(self):
        """The envelope tells bees what to download — it can never point
        them off-hub."""
        code, d = self._post({"url": "https://evil.example/x.py"})
        assert code == 400, d
        assert "hub-relative" in d.get("error", "")

    @needs_gateway
    def test_dotdot_url_is_refused(self):
        code, d = self._post({"url": "/../../etc/passwd"})
        assert code == 400, d

    @needs_gateway
    def test_missing_target_is_refused(self):
        code, d = self._post({"url": "/no-such-file.py"})
        assert code == 400, d
        assert "not found" in d.get("error", "")
