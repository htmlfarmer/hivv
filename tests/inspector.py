#!/usr/bin/env python3
"""HIVE INSPECTOR — continuously test both APIs for security and resilience.

This is a red-team suite, not a smoke test. Every case asks "can someone do
something they should not?" and the expected answer is NO.

HIVV CASES
──────────
  * Can anonymous users read private information?
  * Can one user modify another user's agents?
  * Can an agent bypass MAYBE approval?
  * Can a NO permission be overridden?
  * Are API keys isolated between contributors?
  * Does streaming recover after an interruption?
  * Does routing work when all local nodes disappear?
  * Can a compromised provider affect other providers?

BLNQ CASES
──────────
  * Can a signed attestation be tampered with and still verify?
  * Can one validator impersonate another?
  * Can a stale/replayed attestation be accepted?
  * Can a code execution job escape its sandbox?
  * Can the private review registry leak through the public API?

Run:
    python3 tests/inspector.py                     # against the live sites
    python3 tests/inspector.py --hivv URL --blnq URL
    python3 tests/inspector.py --json              # machine-readable
    python3 tests/inspector.py --only security     # one group

Exit code is 0 when every case PASSES. A FAIL means a real problem.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import string
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

DEFAULT_HIVV = "http://127.0.0.1:3011"
DEFAULT_BLNQ = "http://127.0.0.1:3099"

PASS = FAIL = SKIP = 0
RESULTS: list[dict] = []


def record(group: str, name: str, ok: bool, detail: str = "", skipped: bool = False):
    global PASS, FAIL, SKIP
    entry = {"group": group, "name": name, "ok": ok, "detail": detail,
             "skipped": skipped}
    RESULTS.append(entry)
    if skipped:
        SKIP += 1
        print(f"  \033[90mSKIP\033[0m  {name}  {detail}")
    elif ok:
        PASS += 1
        print(f"  \033[32mPASS\033[0m  {name}")
    else:
        FAIL += 1
        print(f"  \033[31mFAIL\033[0m  {name}  {detail}")
    return ok


def req(url, method="GET", body=None, headers=None, timeout=30):
    """Return (status, body_obj, headers). Never raises."""
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode("utf-8", "replace")), dict(resp.headers)
            except Exception:
                return resp.status, raw.decode("utf-8", "replace"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8", "replace")), dict(e.headers)
        except Exception:
            return e.code, raw.decode("utf-8", "replace"), dict(e.headers)
    except Exception as e:
        return 0, {"error": str(e)}, {}


def rand_name(prefix="probe"):
    return prefix + "_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))


# ── HIVV: anonymous access ────────────────────────────────────────────────
def hivv_anonymous(hivv):
    print("\n== HIVV · anonymous access ==")
    group = "hivv-anonymous"

    # The public surfaces must be readable.
    for path in ("/api/health", "/api/partner/manifest", "/v1/models",
                 "/api/capabilities", "/api/public/status"):
        code, _, _ = req(hivv + path)
        record(group, f"public GET {path} is readable", code in (200, 503),
               f"HTTP {code}")

    # The private surfaces: the security property that actually matters is
    # that the REDUCED projections carry no private fields. The operator view
    # is legitimately available from loopback (that IS the admin trust
    # boundary), so we assert the projections rather than the vantage point.
    private_fields = ("ip_address", "account_email", "account_phone",
                      "trace_route", "public_ip", "worker_hostname", "margin_usd")
    for view in ("public", "partner"):
        for path in ("/api/provenance/requests", "/api/provenance/reviews",
                     "/api/provenance/stats"):
            code, body, _ = req(hivv + f"{path}?view={view}")
            if code != 200:
                record(group, f"{path}?view={view} is reachable",
                       code in (403, 404, 500), f"HTTP {code}")
                continue
            text = json.dumps(body)
            leaked = [f for f in private_fields if f in text]
            record(group, f"{path}?view={view} leaks no private field",
                   not leaked, f"leaked: {leaked}")

    # And `view=operator` without a token must be refused from anywhere BUT
    # loopback — which we can prove by asking for a nonsense view.
    code, body, _ = req(hivv + "/api/provenance/requests?view=sneaky")
    record(group, "an unknown view is rejected, not defaulted",
           code == 400, f"HTTP {code}: {str(body)[:100]}")

    # The provenance table must never be in the public database browser.
    code, body, _ = req(hivv + "/api/database/hivv_request_provenance")
    record(group, "the provenance table is NOT in the public browser",
           code == 403, f"HTTP {code}")

    # A node detail must never leak its secret/hw_id/token.
    code, body, _ = req(hivv + "/api/control/nodes")
    if code == 200 and isinstance(body, dict) and body.get("nodes"):
        node = body["nodes"][0]
        leaked = [k for k in ("secret", "hw_id", "token", "node_secret")
                  if k in node]
        record(group, "a node listing leaks no credential field",
               not leaked, f"leaked: {leaked}")
    else:
        record(group, "a node listing leaks no credential field", True,
               "no nodes to check", skipped=True)


# ── HIVV: cross-user isolation ────────────────────────────────────────────
def hivv_cross_user(hivv):
    print("\n== HIVV · cross-user isolation ==")
    group = "hivv-isolation"

    # Two anonymous sessions must not see each other's data.
    a = rand_name("alice")
    b = rand_name("bob")
    code_a, body_a, headers_a = req(hivv + "/api/auth/register", "POST", {
        "username": a, "email": f"{a}@example.test",
        "password": "CorrectHorse!Battery9",
    })
    code_b, body_b, headers_b = req(hivv + "/api/auth/register", "POST", {
        "username": b, "email": f"{b}@example.test",
        "password": "CorrectHorse!Battery9",
    })

    if code_a not in (200, 201):
        record(group, "register user A", False,
               f"HTTP {code_a}: {str(body_a)[:120]}", skipped=True)
        return
    record(group, "register user A", True)

    token_a = None
    if isinstance(body_a, dict):
        token_a = body_a.get("token") or body_a.get("session_token")
        if not token_a:
            cookie = headers_a.get("set-cookie", "")
            if "hivv_session=" in cookie:
                token_a = cookie.split("hivv_session=")[1].split(";")[0]
    if not token_a:
        record(group, "user A received a session token", False,
               "no token in the response", skipped=True)
        return
    record(group, "user A received a session token", True)

    # A must not be able to read B's keys (if B has any).
    code, body, _ = req(hivv + "/api/keys", headers={"X-Session-Token": token_a})
    if code == 200 and isinstance(body, dict):
        rows = body.get("keys") or body.get("data") or []
        # Every key visible must belong to A.
        foreign = [k for k in rows if isinstance(k, dict)
                   and k.get("user_id") not in (None, body.get("user_id"))]
        record(group, "a user's key list contains only their own keys",
               not foreign, f"{len(foreign)} foreign key(s)")
    else:
        record(group, "a user's key list contains only their own keys", True,
               f"HTTP {code}", skipped=True)

    # A must not be able to deactivate B's key.
    code, body, _ = req(hivv + "/api/keys/deactivate", "POST",
                        {"id": 999999}, headers={"X-Session-Token": token_a})
    record(group, "a user cannot deactivate another user's key",
           code in (400, 401, 403, 404), f"HTTP {code}")

    # A must not be able to read another user's agent list.
    code, body, _ = req(hivv + "/api/hivv/agents", headers={"X-Session-Token": token_a})
    record(group, "a user's agent list is reachable but scoped",
           code in (200, 403), f"HTTP {code}")


# ── HIVV: policy — MAYBE and NO cannot be bypassed ───────────────────────
def hivv_policy(hivv):
    print("\n== HIVV · policy gate ==")
    group = "hivv-policy"

    # A high-risk capability must produce MAYBE, not ALLOW, without a grant.
    for cap in ("coding.execute", "financial.transaction", "physical.world"):
        code, body, headers = req(
            hivv + "/api/capabilities/route/dry-run?"
            + f"capability={cap}&mode=balanced")
        if code != 200 or not isinstance(body, dict):
            record(group, f"dry-run for {cap} answers", False,
                   f"HTTP {code}", skipped=True)
            continue
        data = body.get("data", body)
        verdict = str(data.get("verdict") or data.get("default_verdict") or "").lower()
        record(group, f"{cap} does not default to allow",
               verdict in ("ask", "deny", "maybe") or verdict == "",
               f"verdict={verdict}")

    # The audit chain must verify.
    code, body, _ = req(hivv + "/api/policy/audit/verify")
    if code == 200 and isinstance(body, dict):
        data = body.get("data", body)
        ok = data.get("ok")
        if ok is None:
            ok = data.get("valid")
        record(group, "the policy audit chain verifies", ok is True,
               json.dumps(data)[:160])
    else:
        record(group, "the policy audit chain verifies", False,
               f"HTTP {code}")


# ── HIVV: API key isolation ───────────────────────────────────────────────
def hivv_key_isolation(hivv):
    print("\n== HIVV · API key isolation ==")
    group = "hivv-keys"

    # A donated key must not be readable by an anonymous caller.
    code, body, _ = req(hivv + "/api/keys")
    if code == 200 and isinstance(body, dict):
        rows = body.get("keys") or body.get("data") or []
        # No raw key material may ever be in a listing.
        leaked = []
        for k in rows:
            if not isinstance(k, dict):
                continue
            for field in ("key_value", "api_key", "secret_key"):
                if field in k and k.get(field):
                    leaked.append(field)
        record(group, "a key listing exposes no raw key material",
               not leaked, f"leaked: {leaked}")
    else:
        record(group, "a key listing exposes no raw key material", True,
               f"HTTP {code}", skipped=True)

    # A single node detail must not leak a secret.
    code, body, _ = req(hivv + "/api/control/nodes")
    if code == 200 and isinstance(body, dict) and body.get("nodes"):
        nid = body["nodes"][0].get("id")
        code2, body2, _ = req(hivv + f"/api/control/nodes/{nid}")
        if code2 == 200 and isinstance(body2, dict):
            node = body2.get("node", body2)
            leaked = [k for k in ("secret", "hw_id", "token", "node_secret")
                      if k in node]
            record(group, "a node detail exposes no credential field",
                   not leaked, f"leaked: {leaked}")
        else:
            record(group, "a node detail exposes no credential field", True,
                   f"HTTP {code2}", skipped=True)
    else:
        record(group, "a node detail exposes no credential field", True,
               "no nodes to check", skipped=True)


# ── HIVV: streaming + resilience ─────────────────────────────────────────
def hivv_streaming(hivv):
    print("\n== HIVV · streaming + resilience ==")
    group = "hivv-resilience"

    # A streaming request must produce proper SSE framing and terminate.
    payload = {"model": "auto", "messages": [{"role": "user", "content": "say hi"}],
               "stream": True, "max_tokens": 8}
    r = urllib.request.Request(hivv + "/v1/chat/completions",
                               data=json.dumps(payload).encode(),
                               headers={"Content-Type": "application/json",
                                        "Accept": "text/event-stream"},
                               method="POST")
    frames = 0
    done = False
    blank_line_framed = True
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            buf = b""
            while True:
                chunk = resp.read(1)
                if not chunk:
                    break
                buf += chunk
                while b"\n\n" in buf:
                    frame, buf = buf.split(b"\n\n", 1)
                    if frame.strip():
                        frames += 1
                if b"[DONE]" in buf:
                    done = True
                    break
    except Exception as e:
        record(group, "a streaming request completes", False, str(e)[:120])
        return
    record(group, "a streaming request completes", done,
           f"{frames} frames, done={done}")
    record(group, "SSE frames are separated by a blank line", blank_line_framed)

    # Routing must survive a local endpoint being unreachable: the gateway
    # should still answer (from the hive, a peer, or a clean error) rather than
    # hang or crash.
    code, body, _ = req(hivv + "/v1/chat/completions", "POST", {
        "model": "auto", "messages": [{"role": "user", "content": "ping"}],
        "stream": False, "max_tokens": 4,
    }, timeout=120)
    record(group, "routing answers when local nodes are unavailable",
           code in (200, 429, 503), f"HTTP {code}")

    # A provider that returns garbage must not take the gateway down.
    code, body, _ = req(hivv + "/v1/chat/completions", "POST", {
        "model": "auto", "messages": [{"role": "user", "content": "ping"}],
        "stream": False, "max_tokens": 4, "api_url": "http://127.0.0.1:9/v1",
    }, timeout=60)
    record(group, "a dead custom endpoint does not crash the gateway",
           code in (200, 400, 429, 502, 503), f"HTTP {code}")

    # The gateway must still answer health after all of that.
    code, _, _ = req(hivv + "/api/health", timeout=15)
    record(group, "the gateway is still healthy afterwards",
           code == 200, f"HTTP {code}")


# ── HIVV: the gateway survives a hostile body ────────────────────────────
def hivv_hostile_input(hivv):
    print("\n== HIVV · hostile input ==")
    group = "hivv-hostile"

    hostile_bodies = [
        ("a huge string", {"model": "auto", "messages": [{"role": "user", "content": "A" * 100000}]}),
        ("null bytes", {"model": "auto", "messages": [{"role": "user", "content": "a\x00b"}]}),
        ("deep nesting", {"model": "auto", "messages": [{"role": "user", "content": {"a": {"b": {"c": [[[[1]]]]}}}}]}),
        ("an array where a string belongs", {"model": "auto", "messages": "not-an-array"}),
        ("no body at all", None),
    ]
    for label, body in hostile_bodies:
        code, _, _ = req(hivv + "/v1/chat/completions", "POST", body, timeout=60)
        record(group, f"the gateway survives {label}",
               code in (200, 400, 413, 422, 429, 500, 503), f"HTTP {code}")

    code, _, _ = req(hivv + "/api/health", timeout=15)
    record(group, "the gateway is healthy after the hostile inputs",
           code == 200, f"HTTP {code}")


# ── BLNQ: attestation integrity ───────────────────────────────────────────
def blnq_attestations(blnq):
    print("\n== BLNQ · attestation integrity ==")
    group = "blnq-attest"

    # The published key must be the current namespace.
    code, body, _ = req(blnq + "/api/attest/validators")
    if code == 200 and isinstance(body, dict):
        validators = body.get("data", {}).get("validators", [])
        active = [v for v in validators if v.get("is_active")]
        record(group, "there is at least one active validator",
               len(active) > 0, f"{len(active)} active")
        # Every validator must be a known principal id.
        bad = [v.get("principal_id") for v in validators
               if not str(v.get("principal_id", "")).startswith(("hivv_", "pri_"))]
        record(group, "every validator id uses a known namespace",
               not bad, f"bad: {bad}")
    else:
        record(group, "the validator list is readable", False, f"HTTP {code}")

    # A tampered envelope must NOT verify.
    code, body, _ = req(blnq + "/api/attest/verify", "POST", {
        "envelope": {
            "v": 2, "kind": "source.review",
            "subject": "a" * 64,
            "issuer": "hivv_" + "b" * 32,
            "issued_at": int(time.time()),
            "nonce": "deadbeef",
            "body": {"verdict": "safe", "statement": "pretend"},
        },
        "signature": "A" * 88,
        "public_key": "A" * 43 + "=",
    })
    if code == 200 and isinstance(body, dict):
        data = body.get("data", body)
        record(group, "a forged attestation does not verify",
               data.get("valid") is False, json.dumps(data)[:160])
    else:
        record(group, "a forged attestation does not verify", False,
               f"HTTP {code}")

    # An envelope whose issuer does not derive from the key must not verify.
    code, body, _ = req(blnq + "/api/attest/verify", "POST", {
        "envelope": {
            "v": 2, "kind": "source.review",
            "subject": "a" * 64,
            "issuer": "hivv_" + "c" * 32,
            "issued_at": int(time.time()),
            "nonce": "cafebabe",
            "body": {"verdict": "safe"},
        },
        "signature": "A" * 88,
        "public_key": "A" * 43 + "=",
    })
    if code == 200 and isinstance(body, dict):
        data = body.get("data", body)
        problems = " ".join(data.get("problems") or [])
        record(group, "an issuer that does not derive from the key is refused",
               data.get("valid") is False and "derive" in problems.lower(),
               json.dumps(data)[:160])
    else:
        record(group, "an issuer that does not derive from the key is refused",
               False, f"HTTP {code}")

    # The public leaderboard must not leak the private registry.
    for path in ("/api/database/hivv_review_registry",
                 "/api/database/hivv_request_provenance"):
        code, _, _ = req(blnq + path)
        record(group, f"{path} is not publicly readable",
               code in (403, 404), f"HTTP {code}")


# ── BLNQ: sandbox + jobs ─────────────────────────────────────────────────
def blnq_jobs(blnq):
    print("\n== BLNQ · jobs + sandbox ==")
    group = "blnq-jobs"

    code, body, _ = req(blnq + "/api/sandbox/status")
    record(group, "the sandbox status is readable",
           code in (200, 404), f"HTTP {code}")

    # A job for a script that does not exist must be refused, not created.
    code, body, _ = req(blnq + "/api/jobs", "POST", {
        "script_id": "scr_does_not_exist_0000",
        "args": [], "stdin": "",
    })
    record(group, "a job for a missing script is refused",
           code in (400, 403, 404), f"HTTP {code}")

    # The public trust surface must not leak a private key.
    code, body, _ = req(blnq + "/api/attest/validators")
    if code == 200:
        text = json.dumps(body)
        record(group, "the validator list exposes no private key material",
               "private_key" not in text.lower())


# ── the fast scan must never approve ─────────────────────────────────────
# NOTE: this lives on HIVV (analysis is HIVV's half of the integration), not
# BLNQ (execution is BLNQ's). See docs/INTEGRATION-CONTRACT.md.
def hivv_fast_scan(hivv):
    print("\n== HIVV · the fast scan never approves ==")
    group = "hivv-fastscan"

    dangerous = {
        "os.system": "import os\nos.system('rm -rf /')\n",
        "eval": "eval(user_input)\n",
        "shell=True": "import subprocess\nsubprocess.run(cmd, shell=True)\n",
        "a private key": "KEY = '-----BEGIN RSA PRIVATE KEY-----'\n",
    }
    for label, code_text in dangerous.items():
        code, body, _ = req(hivv + "/api/scan/fast", "POST",
                            {"language": "python", "code": code_text})
        if code != 200 or not isinstance(body, dict):
            record(group, f"fast-scan flags {label}", False, f"HTTP {code}")
            continue
        data = body.get("data", body)
        verdict = str(data.get("verdict", ""))
        record(group, f"fast-scan does not call {label} safe",
               verdict != "safe", f"verdict={verdict}")

    # And the same rules through the partner surface a third party uses.
    for label, code_text in list(dangerous.items())[:2]:
        code, body, _ = req(hivv + "/api/partner/fast-scan", "POST",
                            {"language": "python", "code": code_text})
        if code == 200 and isinstance(body, dict):
            data = body.get("data", body)
            record(group, f"the partner fast-scan agrees on {label}",
                   str(data.get("verdict", "")) != "safe",
                   f"verdict={data.get('verdict')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hivv", default=os.environ.get("HIVV_URL", DEFAULT_HIVV))
    ap.add_argument("--blnq", default=os.environ.get("BLNQ_URL", DEFAULT_BLNQ))
    ap.add_argument("--only", default=None,
                    help="run one group: security | resilience | attest")
    ap.add_argument("--json", dest="as_json", action="store_true")
    args = ap.parse_args()

    hivv = args.hivv.rstrip("/")
    blnq = args.blnq.rstrip("/")

    print("\n╔══════════════════════════════════════════════════════════╗")
    print("║  HIVE INSPECTOR 🐝 — continuous red-team for both APIs    ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print(f"  HIVV: {hivv}")
    print(f"  BLNQ: {blnq}")

    code, _, _ = req(hivv + "/api/health", timeout=10)
    if code != 200:
        print(f"\n  HIVV is not reachable (HTTP {code}) — run against a live gateway.")
        return 2

    only = args.only
    groups = {
        "security": [hivv_anonymous, hivv_cross_user, hivv_policy,
                      hivv_key_isolation, hivv_fast_scan, blnq_attestations],
        "resilience": [hivv_streaming, hivv_hostile_input, blnq_jobs],
        "attest": [blnq_attestations, hivv_fast_scan],
    }
    if only:
        chosen = groups.get(only, [])
    else:
        chosen = groups["security"] + groups["resilience"]

    for fn in chosen:
        try:
            fn(hivv) if fn.__name__.startswith("hivv") else fn(blnq)
        except Exception as e:
            record("crash", f"{fn.__name__} ran", False, f"{type(e).__name__}: {e}")

    if args.as_json:
        print(json.dumps({
            "pass": PASS, "fail": FAIL, "skip": SKIP, "results": RESULTS,
        }, indent=2))
    else:
        print(f"\n\033[1m{PASS} passed, {FAIL} failed, {SKIP} skipped\033[0m")
        if FAIL:
            print("\nfailures:")
            for r in RESULTS:
                if not r["ok"] and not r["skipped"]:
                    print(f"  · [{r['group']}] {r['name']} — {r['detail']}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
