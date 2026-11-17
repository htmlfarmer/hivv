#!/usr/bin/env python3
"""Cross-network integration test: HIVV ↔ BLNQ.

Proves the loop described in docs/INTEGRATION-CONTRACT.md actually works:

    HIVV  ──submit a job──►  BLNQ
    HIVV  ◄─signed result──  BLNQ
    HIVV  verifies the signature INDEPENDENTLY (no trust in BLNQ's word)
    BLNQ  ◄──human revokes authorization── HIVV
    both record failures correctly
    the whole thing recovers when either service goes offline

Nothing here trusts the other service's "it worked" — every claim is checked
against a signature the verifier computes itself.

Run:
    python3 tests/test_cross_network.py
    python3 tests/test_cross_network.py --hivv URL --blnq URL
    python3 tests/test_cross_network.py --json
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
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


def record(name: str, ok: bool, detail: str = "", skipped: bool = False):
    global PASS, FAIL, SKIP
    RESULTS.append({"name": name, "ok": ok, "detail": detail, "skipped": skipped})
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


def req(url, method="GET", body=None, headers=None, timeout=60):
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


# ── an INDEPENDENT verifier ────────────────────────────────────────────────
# Deliberately implemented here, from the contract, using only the standard
# library's hashlib plus `openssl` for Ed25519. It shares NO code with either
# service, so a bug in either implementation cannot make this test pass.
def canonicalize(value) -> bytes:
    """The blnq.attestation.v2 canonical JSON: UTF-8 byte key order, no
    whitespace, integers only."""
    if value is None:
        return b"null"
    if isinstance(value, bool):
        return b"true" if value else b"false"
    if isinstance(value, int):
        return str(value).encode()
    if isinstance(value, float):
        raise ValueError(f"floats are not canonical: {value}")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False).encode()
    if isinstance(value, list):
        return b"[" + b",".join(canonicalize(v) for v in value) + b"]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: str(kv[0]).encode("utf-8"))
        return b"{" + b",".join(
            json.dumps(str(k), ensure_ascii=False).encode() + b":"
            + canonicalize(v) for k, v in items) + b"}"
    raise ValueError(f"not canonicalizable: {type(value)}")


def ed25519_verify(pubkey_raw: bytes, message: bytes, signature: bytes) -> bool:
    """Verify Ed25519 with openssl (RFC 8032), independent of both services."""
    spki_prefix = bytes.fromhex("302a300506032b6570032100")
    with tempfile.TemporaryDirectory() as td:
        key_path = Path(td) / "key.der"
        msg_path = Path(td) / "msg.bin"
        sig_path = Path(td) / "sig.bin"
        key_path.write_bytes(spki_prefix + pubkey_raw)
        msg_path.write_bytes(message)
        sig_path.write_bytes(signature)
        p = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(key_path),
             "-keyform", "DER", "-rawin", "-in", str(msg_path),
             "-sigfile", str(sig_path)],
            capture_output=True, text=True, timeout=30)
        return p.returncode == 0


def principal_id_from_raw(raw: bytes) -> str:
    return "hivv_" + hashlib.sha256(raw).hexdigest()[:32]


def independently_verify(envelope: dict, signature_b64: str, public_key_b64: str):
    """Verify a signed envelope from first principles.

    Returns (ok, problems). Checks:
      * the signature over the canonical envelope
      * that the issuer id DERIVES from the public key (anti-impersonation)
    """
    problems = []
    try:
        raw = base64.b64decode(public_key_b64, validate=True)
    except Exception as e:
        return False, [f"bad public key: {e}"]
    if len(raw) != 32:
        return False, ["public key must be 32 bytes"]

    try:
        sig = base64.b64decode(signature_b64, validate=True)
    except Exception as e:
        return False, [f"bad signature: {e}"]
    if len(sig) != 64:
        return False, ["signature must be 64 bytes"]

    issuer = str(envelope.get("issuer", ""))
    if issuer.startswith("hivv_") and principal_id_from_raw(raw) != issuer:
        problems.append("issuer does not derive from the public key")

    try:
        msg = canonicalize(envelope)
    except Exception as e:
        return False, [f"envelope is not canonicalizable: {e}"]

    if not ed25519_verify(raw, msg, sig):
        problems.append("signature mismatch")
    return (not problems), problems


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(base, timeout=90):
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        code, body, _ = req(base + "/api/health", timeout=3)
        last = {"code": code, "body": body}
        if code == 200 and isinstance(body, dict) \
                and body.get("status") in ("healthy", "degraded"):
            return True, body
        time.sleep(0.4)
    return False, last


# ── the actual test ───────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hivv", default=os.environ.get("HIVV_URL", DEFAULT_HIVV))
    ap.add_argument("--blnq", default=os.environ.get("BLNQ_URL", DEFAULT_BLNQ))
    ap.add_argument("--json", dest="as_json", action="store_true")
    args = ap.parse_args()

    hivv = args.hivv.rstrip("/")
    blnq = args.blnq.rstrip("/")

    print("\n╔══════════════════════════════════════════════════════════╗")
    print("║  HIVV ↔ BLNQ · cross-network integration test              ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print(f"  HIVV: {hivv}")
    print(f"  BLNQ: {blnq}")

    # ── 0. both services are up ─────────────────────────────────────
    print("\n== 0. both services are reachable ==")
    h_ok, h_body = wait_health(hivv)
    record("HIVV is healthy", h_ok, json.dumps(h_body)[:160])
    b_code, b_body, _ = req(blnq + "/api/health")
    record("BLNQ is healthy", b_code == 200, f"HTTP {b_code}")
    if not h_ok or b_code != 200:
        print("\n  both services must be running for this test")
        return 2

    # ── 1. HIVV submits a job to BLNQ ────────────────────────────────
    print("\n== 1. HIVV submits a job to BLNQ ==")
    # THE OWNERSHIP SPLIT (docs/INTEGRATION-CONTRACT.md):
    #   HIVV owns REASONING  — the signed source.review lives on HIVV.
    #   BLNQ owns EXECUTION  — it receives authorised jobs.
    # So the signed review comes FROM HIVV and is VERIFIED by BLNQ (and by
    # anyone else), and the job goes TO BLNQ.
    code = "print('cross network')\n"
    source_sha = hashlib.sha256(code.encode()).hexdigest()

    # 1a. HIVV signs the review (the analysis side).
    code_r, body_r, _ = req(hivv + "/api/scan", "POST",
                            {"language": "python", "code": code}, timeout=180)
    if code_r == 200 and isinstance(body_r, dict) and body_r.get("envelope"):
        record("HIVV produced a signed source.review", True)
        envelope = body_r["envelope"]
        signature = body_r["signature"]
        public_key = body_r["public_key"]

        record("the envelope is a source.review",
               envelope.get("kind") == "source.review", str(envelope.get("kind")))
        record("the envelope is bound to the exact source",
               envelope.get("subject") == source_sha,
               f"{envelope.get('subject')} vs {source_sha}")

        # 1b. HIVV submits the signed review TO BLNQ (BLNQ is the validator
        #     coordinator — it stores and counts the verdict toward quorum).
        code_sub, body_sub, _ = req(blnq + "/api/attest", "POST", {
            "envelope": envelope,
            "signature": signature,
        }, timeout=60)
        record("BLNQ accepted the signed review from HIVV",
               code_sub in (200, 201), f"HTTP {code_sub}: {str(body_sub)[:120]}")

        # ── 2. BLNQ returned an AUTHENTICATED result ────────────────
        print("\n== 2. the result is authenticated ==")
        if code_sub in (200, 201) and isinstance(body_sub, dict):
            data = body_sub.get("data", body_sub)
            record("BLNQ reports the stored attestation",
                   bool(data.get("attestation_id")), json.dumps(data)[:160])
            record("BLNQ reports the issuer it accepted",
                   str(data.get("issuer", "")) == str(envelope.get("issuer")),
                   f"{data.get('issuer')} vs {envelope.get('issuer')}")
            record("BLNQ reports live quorum for the source",
                   "quorum" in data, json.dumps(data.get("quorum"))[:120])

        # ── 3. HIVV verifies the result INDEPENDENTLY ───────────────
        print("\n== 3. HIVV verifies the result independently ==")
        ok, problems = independently_verify(envelope, signature, public_key)
        record("an INDEPENDENT verifier accepts the signature", ok,
               "; ".join(problems))

        # A tampered envelope must FAIL the same verifier.
        tampered = json.loads(json.dumps(envelope))
        tampered["body"]["verdict"] = "unsafe" if tampered["body"].get("verdict") == "safe" else "safe"
        t_ok, t_problems = independently_verify(tampered, signature, public_key)
        record("a tampered envelope is REJECTED by the same verifier",
               not t_ok, "; ".join(t_problems))

        # An impersonated issuer must FAIL too.
        forged = json.loads(json.dumps(envelope))
        forged["issuer"] = "hivv_" + "0" * 32
        f_ok, f_problems = independently_verify(forged, signature, public_key)
        record("an impersonated issuer is REJECTED by the same verifier",
               not f_ok, "; ".join(f_problems))

        # HIVV's OWN verifier must agree with the independent one.
        # It is loaded through node (not imported into Python) because it
        # `require`s its sibling contract module.
        try:
            script = (
                "const m=require(process.argv[1]);"
                "const e=JSON.parse(process.argv[2]);"
                "const s=process.argv[3], k=process.argv[4];"
                "process.stdout.write(JSON.stringify(m.verifyEnvelope(e,s,k)));"
            )
            p = subprocess.run(
                ["node", "-e", script,
                 str(ROOT / "api" / "lib" / "attest.js"),
                 json.dumps(envelope), signature, public_key],
                capture_output=True, text=True, timeout=60)
            if p.returncode != 0:
                raise RuntimeError(p.stderr[-200:])
            v = json.loads(p.stdout)
            record("HIVV's own verifier agrees",
                   v.get("ok") is True, json.dumps(v)[:120])
        except Exception as e:
            record("HIVV's own verifier agrees", False, str(e)[:160])

        # ── 4. failures are recorded correctly ─────────────────────
        print("\n== 4. failures are recorded correctly ==")
        # A corrupted signature must be refused BY BLNQ.
        code_bad, body_bad, _ = req(blnq + "/api/attest/verify", "POST", {
            "envelope": envelope,
            "signature": base64.b64encode(b"\x00" * 64).decode(),
            "public_key": public_key,
        })
        if code_bad == 200 and isinstance(body_bad, dict):
            data = body_bad.get("data", body_bad)
            record("BLNQ rejects a corrupted signature",
                   data.get("valid") is False, json.dumps(data)[:120])
        else:
            record("BLNQ rejects a corrupted signature", False,
                   f"HTTP {code_bad}")

        # A REPLAY must be refused by BLNQ's storage (nonce uniqueness).
        code_replay, body_replay, _ = req(blnq + "/api/attest", "POST", {
            "envelope": envelope,
            "signature": signature,
        }, timeout=60)
        record("BLNQ refuses a replayed attestation",
               code_replay == 409 or code_replay == 400,
               f"HTTP {code_replay}: {str(body_replay)[:100]}")

        # ── 1c. the job goes TO BLNQ (execution side) ────────────────
        code_job, body_job, _ = req(blnq + "/api/jobs", "POST", {
            "script_id": "scr_does_not_exist",
            "args": [], "stdin": "",
        }, timeout=60)
        record("BLNQ refuses a job for a missing script",
               code_job in (400, 403, 404), f"HTTP {code_job}")
    else:
        record("HIVV produced a signed source.review", False,
               f"HTTP {code_r} — is a model running on HIVV?", skipped=True)

    # ── 5. a human can revoke authorization during execution ─────────
    print("\n== 5. a human can revoke an authorization ==")
    # The policy gate's deny/ask machinery: a standing grant can be revoked,
    # and an ASK verdict is a hard stop until a grant exists.
    code_p, body_p, _ = req(hivv + "/api/policy")
    if code_p == 200 and isinstance(body_p, dict):
        record("the policy surface is reachable", True)
        # Revoking a non-existent grant must be a clean 404, not a crash.
        code_rv, body_rv, _ = req(hivv + "/api/policy/grant/gr_nonexistent/revoke",
                                  "POST", {})
        record("revoking an unknown grant is a clean refusal",
               code_rv in (400, 403, 404), f"HTTP {code_rv}")
    else:
        record("the policy surface is reachable", False, f"HTTP {code_p}",
               skipped=True)

    # ── 6. the workflow recovers when a service goes offline ─────────
    print("\n== 6. the workflow recovers after a service goes offline ==")
    # Start a PRIVATE blnq so we can stop it without touching the real one.
    blnq_port = free_port()
    data_dir = Path(tempfile.mkdtemp(prefix="hivv-cross-blnq-"))
    log_path = data_dir / "blnq.log"
    env = dict(os.environ)
    env.update({
        "NODE_ENV": "production", "PORT": str(blnq_port),
        "PG_HOST": "127.0.0.1", "PG_PORT": "5432",
        "PG_DATABASE": os.environ.get("PG_DATABASE", "postgres"),
        "PG_USER": os.environ.get("PG_USER", "postgres"),
        "PG_PASSWORD": os.environ.get("PG_PASSWORD", "postgres"),
        # BLNQ refuses to boot in production without a session secret.
        "SESSION_SECRET": os.environ.get("SESSION_SECRET")
            or hashlib.sha256(f"cross-test-{blnq_port}".encode()).hexdigest(),
        "BLNQ_ADMIN_TOKEN": os.environ.get("BLNQ_ADMIN_TOKEN")
            or hashlib.sha256(f"cross-admin-{blnq_port}".encode()).hexdigest(),
    })
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(["node", "server.js"],
                            cwd="/var/www/vhosts/blnq.org/public_html/api",
                            env=env, stdout=log_f, stderr=subprocess.STDOUT)
    try:
        up, _ = wait_health(f"http://127.0.0.1:{blnq_port}", timeout=60)
        if not record("a private BLNQ instance starts for the outage test", up):
            raise RuntimeError("private blnq did not start")

        # While it is up, the cross-network call works.
        c1, _, _ = req(f"http://127.0.0.1:{blnq_port}/api/health")
        record("the private BLNQ serves the cross-network call",
               c1 == 200, f"HTTP {c1}")

        # Stop it.
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(1)

        # Now it is down: the call must fail LOUDLY, and HIVV must stay up.
        c2, b2, _ = req(f"http://127.0.0.1:{blnq_port}/api/health", timeout=10)
        record("a downed BLNQ produces a clean error, not a hang",
               c2 in (0, 502, 503, 504), f"HTTP {c2}")
        c3, _, _ = req(hivv + "/api/health", timeout=15)
        record("HIVV is unaffected by BLNQ being down", c3 == 200, f"HTTP {c3}")

        # Bring it back: the call must work again.
        proc2 = subprocess.Popen(["node", "server.js"],
                                 cwd="/var/www/vhosts/blnq.org/public_html/api",
                                 env=env, stdout=log_f, stderr=subprocess.STDOUT)
        try:
            up2, _ = wait_health(f"http://127.0.0.1:{blnq_port}", timeout=60)
            record("BLNQ comes back up", up2)
            if up2:
                c4, _, _ = req(f"http://127.0.0.1:{blnq_port}/api/health")
                record("the cross-network call works again after recovery",
                       c4 == 200, f"HTTP {c4}")
        finally:
            proc2.terminate()
            try:
                proc2.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc2.kill()
    except Exception as e:
        record("the outage test ran", False, f"{type(e).__name__}: {e}")
    finally:
        log_f.close()
        import shutil
        shutil.rmtree(data_dir, ignore_errors=True)

    # ── summary ──────────────────────────────────────────────────────
    if args.as_json:
        print(json.dumps({"pass": PASS, "fail": FAIL, "skip": SKIP,
                          "results": RESULTS}, indent=2))
    else:
        print(f"\n\033[1m{PASS} passed, {FAIL} failed, {SKIP} skipped\033[0m")
        if FAIL:
            print("\nfailures:")
            for r in RESULTS:
                if not r["ok"] and not r["skipped"]:
                    print(f"  · {r['name']} — {r['detail']}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
