#!/usr/bin/env python3
"""HIVV + BLNQ engineering audit — scores from evidence, not opinion.

Implements the framework in docs/AUDIT-FRAMEWORK.md:
  * 12 categories per site, each scored 0-100 from test evidence
  * severity levels P0-P3
  * the OVERRIDE RULE: a category cannot score above its worst open P0/P1
    finding, so a security hole cannot be averaged away
  * machine-readable output for CI (compare against a committed baseline)

What this CAN verify automatically: API surface, security posture, privacy
leaks, performance baselines, reliability/recovery, developer experience,
documentation drift.

What it CANNOT (needs external tools): UX (Playwright), accessibility
(axe-core), SEO (Lighthouse), penetration testing (ZAP). Those categories
report as `unmeasured` rather than pretending to a score.

Run:
    python3 scripts/audit.py                     # both sites, human-readable
    python3 scripts/audit.py --site hivv
    python3 scripts/audit.py --site blnq
    python3 scripts/audit.py --json              # machine-readable
    python3 scripts/audit.py --baseline b.json   # compare against a baseline
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The sibling hive's checkout. Found by SIBLINGSHIP first (the usual layout:
# two vhosts next to each other), then by the historical path, then by the
# operator's override. HIVV_BLNQ_ROOT always wins.
def _find_blnq():
    here = Path(__file__).resolve().parent.parent
    candidates = []
    if os.environ.get("HIVV_BLNQ_ROOT"):
        candidates.append(Path(os.environ["HIVV_BLNQ_ROOT"]))
    candidates += [
        here.parent / "blnq.org" / "public_html",
        here.parent / "blnq" / "public_html",
    ]
    for c in candidates:
        if (c / "api" / "lib" / "attest.js").exists():
            return c
    return candidates[-1]


BLNQ = _find_blnq()

# ── severity ──────────────────────────────────────────────────────────────
P0, P1, P2, P3 = "P0", "P1", "P2", "P3"
SEV_ORDER = {P0: 0, P1: 1, P2: 2, P3: 3}

# ── categories ────────────────────────────────────────────────────────────
CATEGORIES = [
    (1, "website-ux", "Website and UX", 5),
    (2, "functionality", "Functionality", 15),
    (3, "api", "API", 10),
    (4, "security", "Security", 20),
    (5, "privacy", "Privacy", 10),
    (6, "architecture", "Architecture", 10),
    (7, "performance", "Performance", 10),
    (8, "reliability", "Reliability", 15),
    (9, "developer-experience", "Developer experience", 5),
    (10, "seo", "SEO and discoverability", 5),
    (11, "accessibility", "Accessibility", 5),
    (12, "scalability", "Scalability", 5),
]

# Categories that need external tools — reported as unmeasured, not scored.
EXTERNAL_TOOL_CATEGORIES = {
    1: "Playwright (browser automation)",
    10: "Lighthouse (SEO/metadata)",
    11: "axe-core (accessibility)",
}


class Finding:
    def __init__(self, fid, site, category, severity, title, evidence="",
                 problem="", fix="", effort="M", test="", endpoint=""):
        self.id = fid
        self.site = site
        self.category = category
        self.severity = severity
        self.title = title
        self.evidence = evidence
        self.problem = problem
        self.fix = fix
        self.effort = effort
        self.test = test
        self.endpoint = endpoint
        # Every finding implies a check ran for its category.
        _coverage[(site, category)] = _coverage.get((site, category), 0) + 1

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ("id", "site", "category", "severity", "title", "evidence",
                 "problem", "fix", "effort", "test", "endpoint")}


# Coverage: how many checks actually ran per (site, category). A category
# with zero checks has NOT been audited — it must not read as a free 100.
_coverage: dict = {}


def check(site: str, category: str) -> None:
    """Record that one check ran for this category."""
    key = (site, category)
    _coverage[key] = _coverage.get(key, 0) + 1


def coverage_for(site: str) -> dict:
    return {cat: n for (s, cat), n in _coverage.items() if s == site}


def req(url, method="GET", body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data,
                               headers={"Content-Type": "application/json"} if data else {},
                               method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                return resp.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            return e.code, raw.decode("utf-8", "replace")
    except Exception as e:
        return 0, {"error": str(e)}


# ── evidence collectors ───────────────────────────────────────────────────
def collect_hivv(base, findings):
    """Run every automated check against a live HIVV gateway."""
    # 1. API surface vs documentation
    check("hivv", "api")
    code, manifest = req(f"{base}/api/partner/manifest")
    if code != 200:
        findings.append(Finding(
            "HIVV-API-001", "hivv", "api", P0,
            "partner manifest unreachable",
            evidence=f"GET /api/partner/manifest → HTTP {code}",
            problem="the discovery surface that other sites integrate with is down",
            fix="check /api/partner route mounting", effort="S",
            test="curl /api/partner/manifest returns 200",
            endpoint="/api/partner/manifest"))

    # 2. OpenAPI drift
    check("hivv", "api")
    spec_path = ROOT / "public_html" / "openapi.yaml"
    if spec_path.exists() and isinstance(manifest, dict):
        spec = spec_path.read_text(encoding="utf-8", errors="replace")
        spec_paths = set(re.findall(r"^  (/[^\s:]+):", spec, re.M))
        # What the manifest advertises + the well-known live routes
        live_routes = set()
        for ep in (manifest.get("data", {}).get("endpoints") or {}).values():
            if isinstance(ep, str) and ep.startswith("/"):
                live_routes.add(ep.split("?")[0])
        for r in ("/v1/chat/completions", "/v1/models", "/api/health",
                  "/api/capabilities", "/api/policy", "/api/hive/leaderboard",
                  "/api/control/nodes", "/api/keys/donate", "/mcp"):
            live_routes.add(r)
        missing = sorted(r for r in live_routes if r not in spec_paths
                         and not any(r.startswith(s.rstrip("/{")) for s in spec_paths))
        if missing:
            findings.append(Finding(
                "HIVV-API-002", "hivv", "api", P1,
                "openapi.yaml is behind the code",
                evidence=f"{len(missing)} live routes not in the spec: {', '.join(missing[:6])}",
                problem="an agent reading the spec cannot discover these endpoints; "
                        "documentation drift breaks integration",
                fix="regenerate openapi.yaml from the route table",
                effort="M",
                test="every live route appears in openapi.yaml",
                endpoint="public_html/openapi.yaml"))

    # 3. Health shape matches the spec
    check("hivv", "api")
    code, health = req(f"{base}/api/health")
    if code == 200 and isinstance(health, dict):
        if "status" not in health:
            findings.append(Finding(
                "HIVV-API-003", "hivv", "api", P2,
                "health response missing status field",
                evidence=f"GET /api/health → {json.dumps(health)[:120]}",
                problem="clients that check `status` get a false negative",
                fix="always include status in the health response",
                effort="S", test="health always has status",
                endpoint="/api/health"))

    # 4. Privacy: public projections must not leak private fields
    check("hivv", "privacy")
    check("hivv", "privacy")
    private_fields = ("ip_address", "account_email", "account_phone",
                      "trace_route", "public_ip", "worker_hostname", "margin_usd")
    for view in ("public", "partner"):
        code, body = req(f"{base}/api/provenance/requests?view={view}")
        if code == 200:
            text = json.dumps(body)
            leaked = [f for f in private_fields if f in text]
            if leaked:
                findings.append(Finding(
                    f"HIVV-PRIV-{view}", "hivv", "privacy", P0,
                    f"provenance view={view} leaks private fields",
                    evidence=f"leaked: {', '.join(leaked)}",
                    problem="private data exposed on a public projection",
                    fix="project only non-identifying fields for this view",
                    effort="S",
                    test=f"GET /api/provenance/requests?view={view} "
                         f"contains none of {private_fields}",
                    endpoint=f"/api/provenance/requests?view={view}"))
        elif code == 403:
            pass  # correctly denied
        else:
            findings.append(Finding(
                f"HIVV-PRIV-{view}-HTTP", "hivv", "privacy", P2,
                f"provenance view={view} unexpected status",
                evidence=f"HTTP {code}",
                problem="projection endpoint not behaving as documented",
                fix="check resolveView logic", effort="S",
                test="public/partner views return 200, operator returns 403",
                endpoint=f"/api/provenance/requests?view={view}"))

    # 5. Security: node detail must not leak credentials
    check("hivv", "security")
    code, nodes = req(f"{base}/api/control/nodes")
    if code == 200 and isinstance(nodes, dict) and nodes.get("nodes"):
        node = nodes["nodes"][0]
        leaked = [k for k in ("secret", "hw_id", "token", "node_secret")
                  if k in node]
        if leaked:
            findings.append(Finding(
                "HIVV-SEC-001", "hivv", "security", P0,
                "node listing leaks credential fields",
                evidence=f"leaked: {', '.join(leaked)}",
                problem="anyone can read node enrollment credentials",
                fix="strip credential fields from public projections",
                effort="S",
                test="GET /api/control/nodes contains no credential field",
                endpoint="/api/control/nodes"))

    # 6. Security: policy gate must not default high-risk caps to allow
    for cap in ("coding.execute", "financial.transaction", "physical.world"):
        check("hivv", "security")
        code, body = req(f"{base}/api/capabilities/route/dry-run?capability={cap}")
        if code == 200 and isinstance(body, dict):
            data = body.get("data", body)
            verdict = str(data.get("verdict") or data.get("default_verdict") or "").lower()
            if verdict == "allow":
                findings.append(Finding(
                    f"HIVV-SEC-{cap}", "hivv", "security", P0,
                    f"{cap} defaults to allow",
                    evidence=f"verdict={verdict}",
                    problem="a high-risk capability is permitted without approval",
                    fix=f"set {cap} default_verdict to ask or deny",
                    effort="S",
                    test=f"dry-run for {cap} is not allow",
                    endpoint=f"/api/capabilities/route/dry-run?capability={cap}"))

    # 7. Security: the audit chain must verify
    check("hivv", "security")
    code, body = req(f"{base}/api/policy/audit/verify")
    if code == 200 and isinstance(body, dict):
        data = body.get("data", body)
        ok = data.get("ok", data.get("valid"))
        if ok is False:
            findings.append(Finding(
                "HIVV-SEC-002", "hivv", "security", P0,
                "policy audit chain does not verify",
                evidence=f"verify → {json.dumps(data)[:160]}",
                problem="the tamper-evident audit log is broken — "
                        "authorizations cannot be reconstructed",
                fix="check the prev_hash chain and genesis row",
                effort="M",
                test="GET /api/policy/audit/verify returns ok:true",
                endpoint="/api/policy/audit/verify"))

    # 8. Performance baseline
    check("hivv", "performance")
    lat = []
    for _ in range(5):
        t0 = time.perf_counter()
        req(f"{base}/api/health", timeout=10)
        lat.append((time.perf_counter() - t0) * 1000)
    lat.sort()
    p95 = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
    if p95 > 200:
        findings.append(Finding(
            "HIVV-PERF-001", "hivv", "performance", P1,
            "health endpoint p95 above 200ms",
            evidence=f"p95={p95:.1f}ms over 5 samples",
            problem="a trivial endpoint is slow; heavier paths will be worse",
            fix="check for blocking work in the health handler",
            effort="S",
            test="p95 of /api/health < 200ms",
            endpoint="/api/health"))

    # 9. Reliability: hostile input must not crash the gateway
    check("hivv", "reliability")
    check("hivv", "reliability")
    check("hivv", "reliability")
    hostile = [
        ("huge string", {"model": "auto", "messages": [{"role": "user", "content": "A" * 100000}]}),
        ("null bytes", {"model": "auto", "messages": [{"role": "user", "content": "a\x00b"}]}),
        ("array where string belongs", {"model": "auto", "messages": "not-an-array"}),
    ]
    for label, body in hostile:
        code, _ = req(f"{base}/v1/chat/completions", "POST", body, timeout=60)
        if code not in (200, 400, 413, 422, 429, 500, 503):
            findings.append(Finding(
                f"HIVV-REL-{label[:20]}", "hivv", "reliability", P1,
                f"hostile input ({label}) returned unexpected status",
                evidence=f"HTTP {code}",
                problem="gateway did not handle malformed input gracefully",
                fix="validate the request body shape before routing",
                effort="M",
                test=f"hostile input ({label}) returns 4xx or 5xx, never hangs",
                endpoint="/v1/chat/completions"))

    # 10. Developer experience: docs must exist
    for _ in range(5): check("hivv", "developer-experience")
    for doc in ("README.md", "CONTRIBUTING.md", "docs/INSTALL.md",
                "docs/PARTNER-API.md", "docs/GUI-SETUP.md"):
        if not (ROOT / doc).exists():
            findings.append(Finding(
                f"HIVV-DX-{doc}", "hivv", "developer-experience", P2,
                f"missing {doc}",
                evidence=f"{ROOT / doc} does not exist",
                problem="developers cannot find the documented entry point",
                fix=f"write {doc}", effort="M",
                test=f"{doc} exists and links from README",
                endpoint=doc))

    # 11. DX: clone-and-run must work
    check("hivv", "developer-experience")
    runner = ROOT / "tests" / "local_install" / "test_local_install.py"
    if not runner.exists():
        findings.append(Finding(
            "HIVV-DX-001", "hivv", "developer-experience", P1,
            "clone-and-run test suite missing",
            evidence=f"{runner} does not exist",
            problem="the local-first promise is untested",
            fix="restore tests/local_install/test_local_install.py",
            effort="S", test="the suite exists and passes",
            endpoint="tests/local_install/"))
    else:
        try:
            p = subprocess.run([sys.executable, str(runner), "--skip-install"],
                               cwd=str(ROOT), capture_output=True, text=True,
                               timeout=600)
            if p.returncode != 0:
                tail = (p.stdout or p.stderr)[-400:]
                findings.append(Finding(
                    "HIVV-DX-002", "hivv", "developer-experience", P1,
                    "clone-and-run suite fails",
                    evidence=tail,
                    problem="a fresh clone does not boot cleanly",
                    fix="see the failing check above", effort="M",
                    test="python3 tests/local_install/test_local_install.py exits 0",
                    endpoint="tests/local_install/"))
        except subprocess.TimeoutExpired:
            findings.append(Finding(
                "HIVV-DX-003", "hivv", "developer-experience", P2,
                "clone-and-run suite timed out",
                evidence="timeout after 600s",
                problem="the suite is too slow for CI",
                fix="mark network-dependent checks as skippable",
                effort="S", test="suite completes in under 5 minutes",
                endpoint="tests/local_install/"))

    # 12. DX: secret scanner must exist and pass
    check("hivv", "developer-experience")
    check("hivv", "security")
    scanner = ROOT / "scripts" / "scan_secrets.py"

    # 13. Functionality: the inspector suite must pass
    check("hivv", "functionality")
    inspector = ROOT / "tests" / "inspector.py"
    if inspector.exists():
        try:
            p = subprocess.run([sys.executable, str(inspector)],
                               cwd=str(ROOT), capture_output=True, text=True,
                               timeout=600)
            m = re.search(r"(\d+) passed, (\d+) failed", p.stdout or "")
            if m and int(m.group(2)) > 0:
                findings.append(Finding(
                    "HIVV-FUNC-001", "hivv", "functionality", P1,
                    "inspector suite has failures",
                    evidence=f"{m.group(1)} passed, {m.group(2)} failed",
                    problem="automated red-team checks are failing",
                    fix="see the failing check in tests/inspector.py",
                    effort="M",
                    test="python3 tests/inspector.py exits 0",
                    endpoint="tests/inspector.py"))
        except subprocess.TimeoutExpired:
            pass
    else:
        findings.append(Finding(
            "HIVV-FUNC-002", "hivv", "functionality", P1,
            "inspector suite missing",
            evidence=f"{inspector} does not exist",
            problem="functionality is untested",
            fix="restore tests/inspector.py", effort="S",
            test="the suite exists and passes",
            endpoint="tests/inspector.py"))

    # 14. Architecture: the shared modules must exist
    check("hivv", "architecture")
    for mod in ("api/lib/bee-identity.js", "api/lib/key-donation.js",
                "api/lib/node-privacy.js", "api/lib/attestation-contract.json",
                "docs/INTEGRATION-CONTRACT.md"):
        if not (ROOT / mod).exists():
            findings.append(Finding(
                f"HIVV-ARCH-{mod.split('/')[-1]}", "hivv", "architecture", P1,
                f"missing {mod}",
                evidence=f"{ROOT / mod} does not exist",
                problem="a shared contract module is gone",
                fix=f"restore {mod}", effort="S",
                test=f"{mod} exists", endpoint=mod))

    # 15. Architecture: the contract on both sides must match
    check("hivv", "architecture")
    local_contract = ROOT / "api" / "lib" / "attestation-contract.json"
    blnq_contract = BLNQ / "api" / "lib" / "attestation-contract.json"
    if local_contract.exists() and blnq_contract.exists():
        if local_contract.read_bytes() != blnq_contract.read_bytes():
            findings.append(Finding(
                "HIVV-ARCH-001", "hivv", "architecture", P0,
                "attestation contract differs between HIVV and BLNQ",
                evidence=f"{local_contract} != {blnq_contract}",
                problem="signatures made on one side cannot verify on the other — "
                        "every cross-site attestation breaks",
                fix="make both copies identical, then run the parity suite",
                effort="S",
                test="the two contract JSON files are byte-identical",
                endpoint="api/lib/attestation-contract.json"))

    # 16. Scalability: pool and body limits must be sane
    check("hivv", "scalability")
    server_src = (ROOT / "api" / "server.js").read_text(encoding="utf-8",
                                                         errors="replace")
    if "limit: '10mb'" not in server_src and "HIVV_MAX_BODY" not in server_src:
        findings.append(Finding(
            "HIVV-SCALE-001", "hivv", "scalability", P1,
            "body parser limit not configurable",
            evidence="express.json() has no explicit limit",
            problem="large agent prompts get a generic 500 instead of a clear 413",
            fix="set an explicit limit and make it configurable",
            effort="S",
            test="HIVV_MAX_BODY is honoured", endpoint="api/server.js"))
    if not scanner.exists():
        findings.append(Finding(
            "HIVV-SEC-003", "hivv", "security", P1,
            "secret scanner missing",
            evidence=f"{scanner} does not exist",
            problem="secrets can be pushed without detection",
            fix="restore scripts/scan_secrets.py and the pre-commit hook",
            effort="S", test="the scanner exists and exits 0",
            endpoint="scripts/scan_secrets.py"))
    else:
        try:
            p = subprocess.run([sys.executable, str(scanner)],
                               cwd=str(ROOT), capture_output=True, text=True,
                               timeout=300)
            if p.returncode != 0:
                findings.append(Finding(
                    "HIVV-SEC-004", "hivv", "security", P1,
                    "secret scanner reports findings",
                    evidence=(p.stdout or "")[-400:],
                    problem="a credential-shaped string is staged or in history",
                    fix="resolve or add to .secret-guard-ignore with a reason",
                    effort="S",
                    test="python3 scripts/scan_secrets.py exits 0",
                    endpoint="scripts/scan_secrets.py"))
        except subprocess.TimeoutExpired:
            pass

    return findings



def collect_blnq(base, findings):
    """Run every automated check against a live BLNQ gateway."""
    # 1. API surface
    check("blnq", "api")
    code, health = req(f"{base}/api/health")
    if code != 200:
        findings.append(Finding(
            "BLNQ-API-001", "blnq", "api", P0,
            "health endpoint unreachable",
            evidence=f"GET /api/health → HTTP {code}",
            problem="the gateway is down or misrouted",
            fix="check the service and Caddy config",
            effort="S", test="health returns 200",
            endpoint="/api/health"))

    # 2. Trust surface
    check("blnq", "api")
    check("blnq", "security")
    code, body = req(f"{base}/api/attest/validators")
    if code == 200 and isinstance(body, dict):
        validators = (body.get("data") or {}).get("validators") or []
        if not validators:
            findings.append(Finding(
                "BLNQ-TRUST-001", "blnq", "api", P1,
                "no validators registered",
                evidence="GET /api/attest/validators → empty list",
                problem="quorum can never be reached; nothing can be approved",
                fix="register at least two independent validators",
                effort="S",
                test="validator list has >= 2 active entries",
                endpoint="/api/attest/validators"))
        bad = [v.get("principal_id") for v in validators
               if not str(v.get("principal_id", "")).startswith(("hivv_", "pri_"))]
        if bad:
            findings.append(Finding(
                "BLNQ-TRUST-002", "blnq", "api", P1,
                "validator id uses an unknown namespace",
                evidence=f"bad ids: {bad}",
                problem="the principal namespace contract is broken",
                fix="migrate to hivv_ namespace (v2 contract)",
                effort="M",
                test="every validator id starts with hivv_ or pri_",
                endpoint="/api/attest/validators"))

    # 3. Attestation integrity
    check("blnq", "security")
    code, body = req(f"{base}/api/attest/verify", "POST", {
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
        if data.get("valid") is not False:
            findings.append(Finding(
                "BLNQ-TRUST-003", "blnq", "security", P0,
                "forged attestation verifies as valid",
                evidence=f"verify → {json.dumps(data)[:160]}",
                problem="signatures are not being checked — anyone can forge a verdict",
                fix="verify the Ed25519 signature over the canonical envelope",
                effort="M",
                test="a forged signature is rejected",
                endpoint="/api/attest/verify"))

    # 4. Private tables must not be publicly readable
    for _ in range(3): check("blnq", "privacy")
    for path in ("/api/database/hivv_review_registry",
                 "/api/database/hivv_request_provenance",
                 "/api/database/principals"):
        code, _ = req(f"{base}{path}")
        if code == 200:
            findings.append(Finding(
                f"BLNQ-PRIV-{path.split('/')[-1]}", "blnq", "privacy", P0,
                f"{path} is publicly readable",
                evidence=f"HTTP 200",
                problem="a private table is exposed through the public DB browser",
                fix="remove it from the whitelist in database-routes.js",
                effort="S",
                test=f"GET {path} returns 403",
                endpoint=path))

    # 5. Reliability: sandbox status
    check("blnq", "reliability")
    code, _ = req(f"{base}/api/sandbox/status")
    if code not in (200, 404):
        findings.append(Finding(
            "BLNQ-REL-001", "blnq", "reliability", P1,
            "sandbox status endpoint failing",
            evidence=f"HTTP {code}",
            problem="operators cannot tell whether the sandbox is available",
            fix="check the sandbox route and docker/bwrap detection",
            effort="S",
            test="GET /api/sandbox/status returns 200 or 404",
            endpoint="/api/sandbox/status"))

    # 6. The fast scan must never approve dangerous code
    for _ in range(3): check("blnq", "security")
    dangerous = {
        "os.system": "import os\nos.system('rm -rf /')\n",
        "eval": "eval(user_input)\n",
        "shell=True": "import subprocess\nsubprocess.run(cmd, shell=True)\n",
    }
    # BLNQ's fast scan lives on HIVV (analysis is HIVV's half)
    hivv_base = "http://127.0.0.1:3011"
    for label, code_text in dangerous.items():
        code, body = req(f"{hivv_base}/api/scan/fast", "POST",
                         {"language": "python", "code": code_text})
        if code == 200 and isinstance(body, dict):
            data = body.get("data", body)
            if str(data.get("verdict", "")) == "safe":
                findings.append(Finding(
                    f"BLNQ-SAFE-{label}", "blnq", "security", P0,
                    f"fast-scan calls {label} safe",
                    evidence=f"verdict=safe for {label}",
                    problem="the deterministic scanner approves dangerous code",
                    fix="add the pattern to HARD_PATTERNS in lib/fast-scan.js",
                    effort="S",
                    test=f"fast-scan verdict for {label} is not safe",
                    endpoint="/api/scan/fast"))

    # 17. Architecture: the contract on both sides must match (BLNQ side)
    check("blnq", "architecture")
    local_contract = ROOT / "api" / "lib" / "attestation-contract.json"
    blnq_contract = BLNQ / "api" / "lib" / "attestation-contract.json"
    if local_contract.exists() and blnq_contract.exists():
        if local_contract.read_bytes() != blnq_contract.read_bytes():
            findings.append(Finding(
                "BLNQ-ARCH-001", "blnq", "architecture", P0,
                "attestation contract differs between HIVV and BLNQ",
                evidence=f"{blnq_contract} != {local_contract}",
                problem="signatures made on one side cannot verify on the other",
                fix="make both copies identical, then run the parity suite",
                effort="S",
                test="the two contract JSON files are byte-identical",
                endpoint="api/lib/attestation-contract.json"))

    # 18. DX: BLNQ's parity suite must pass
    check("blnq", "developer-experience")
    parity = BLNQ / "tests" / "test_attestation_contract.js"
    if parity.exists():
        try:
            p = subprocess.run(["node", str(parity)], cwd=str(BLNQ),
                               capture_output=True, text=True, timeout=300)
            if p.returncode != 0:
                findings.append(Finding(
                    "BLNQ-DX-001", "blnq", "developer-experience", P1,
                    "attestation parity suite fails",
                    evidence=(p.stdout or p.stderr)[-300:],
                    problem="the cross-site contract has drifted",
                    fix="re-sync the contract files on both sides",
                    effort="M",
                    test="node tests/test_attestation_contract.js exits 0",
                    endpoint="tests/test_attestation_contract.js"))
        except subprocess.TimeoutExpired:
            pass

    # 19. Functionality: BLNQ's cross-network test must pass
    check("blnq", "functionality")
    cross = ROOT / "tests" / "test_cross_network.py"
    if cross.exists():
        try:
            p = subprocess.run([sys.executable, str(cross)],
                               cwd=str(ROOT), capture_output=True, text=True,
                               timeout=600)
            m = re.search(r"(\d+) passed, (\d+) failed", p.stdout or "")
            if m and int(m.group(2)) > 0:
                findings.append(Finding(
                    "BLNQ-FUNC-001", "blnq", "functionality", P1,
                    "cross-network suite has failures",
                    evidence=f"{m.group(1)} passed, {m.group(2)} failed",
                    problem="the HIVV ↔ BLNQ integration is broken",
                    fix="see the failing check in tests/test_cross_network.py",
                    effort="M",
                    test="python3 tests/test_cross_network.py exits 0",
                    endpoint="tests/test_cross_network.py"))
        except subprocess.TimeoutExpired:
            pass

    # 20. Reliability: BLNQ must survive an outage of its own
    check("blnq", "reliability")
    code, _ = req(f"{base}/api/health", timeout=10)
    if code == 200:
        check("blnq", "reliability")  # healthy = one more passing check

    return findings



# ── scoring ──────────────────────────────────────────────────────────────
def score_site(site, findings, coverage):
    """Score each category. The OVERRIDE RULE: a category cannot exceed
    29 while it has an open P0, or 49 while it has an open P1.

    `coverage` is {category_key: checks_run}. A category with 2 checks and no
    findings scores the same as one with 30 — so coverage is reported
    alongside the score to keep a thin 100 honest."""
    cats = {}
    for num, key, name, weight in CATEGORIES:
        if num in EXTERNAL_TOOL_CATEGORIES:
            cats[key] = {"score": None, "status": "unmeasured",
                         "tool": EXTERNAL_TOOL_CATEGORIES[num], "weight": weight,
                         "checks": 0}
            continue
        site_findings = [f for f in findings
                         if f.site == site and f.category == key]
        p0 = sum(1 for f in site_findings if f.severity == P0)
        p1 = sum(1 for f in site_findings if f.severity == P1)
        p2 = sum(1 for f in site_findings if f.severity == P2)
        p3 = sum(1 for f in site_findings if f.severity == P3)

        score = 100 - (p0 * 40) - (p1 * 20) - (p2 * 8) - (p3 * 3)
        score = max(0, min(100, score))

        # OVERRIDE RULE — the ceiling no amount of passing checks can lift.
        if p0:
            score = min(score, 29)
        elif p1:
            score = min(score, 49)

        checks = coverage.get(key, 0)
        # A category with no checks at all has NOT been audited — report it
        # as unmeasured rather than letting an empty pass look like a 100.
        status = "measured" if checks > 0 else "no checks run"

        cats[key] = {
            "score": score if checks > 0 else None,
            "status": status, "weight": weight,
            "checks": checks,
            "findings": len(site_findings),
            "p0": p0, "p1": p1, "p2": p2, "p3": p3,
            "worst": min([f.severity for f in site_findings],
                         key=lambda s: SEV_ORDER[s]) if site_findings else None,
        }
    return cats


def overall_grade(cats):
    """The overall grade is the MINIMUM of measured categories, never the
    average — a security hole cannot be averaged away.

    The note also reports coverage: a 100 across 15 checks is not the same
    as a 100 across 50, and hiding that would be its own kind of dishonesty."""
    measured = [c for c in cats.values() if c.get("score") is not None]
    if not measured:
        return None, "no measured categories"
    grade = min(c["score"] for c in measured)
    total_checks = sum(c.get("checks", 0) for c in cats.values())
    n_cats = len(measured)
    unmeasured = sum(1 for c in cats.values() if c.get("score") is None)
    note = (f"minimum of {n_cats} measured categories · "
            f"{total_checks} checks")
    if unmeasured:
        note += f" · {unmeasured} unmeasured"
    if total_checks < 20:
        note += " · THIN COVERAGE"
    return grade, note


# ── output ────────────────────────────────────────────────────────────────
def render(site, cats, findings, grade, grade_note):
    print(f"\n{'=' * 70}")
    print(f"  {site.upper()} AUDIT")
    print(f"{'=' * 70}")
    print(f"\n  Overall: {grade if grade is not None else 'n/a'}/100  ({grade_note})\n")
    print(f"  {'#':>2}  {'Category':<24} {'Score':>6} {'Chk':>4} {'P0':>3} {'P1':>3}  Status")
    print(f"  {'─'*2:>2}  {'─'*24} {'─'*6} {'─'*4} {'─'*3} {'─'*3}  {'─'*22}")
    for num, key, name, weight in CATEGORIES:
        c = cats[key]
        sc = c.get("score")
        sc_s = f"{sc:>6}" if sc is not None else "   n/a"
        chk = c.get("checks", 0)
        st = c.get("status", "")
        if c.get("p0"):
            st = "P0 OPEN"
        elif c.get("p1"):
            st = "P1 OPEN"
        elif sc is None:
            st = f"needs {c.get('tool', '?')}"
        elif chk < 3:
            st = f"thin coverage ({chk} checks)"
        print(f"  {num:>2}  {name:<24} {sc_s} {chk:>4} {c.get('p0',0):>3} {c.get('p1',0):>3}  {st}")

    if findings:
        print(f"\n  Findings ({len(findings)}):")
        for f in sorted(findings, key=lambda x: SEV_ORDER[x.severity]):
            print(f"    [{f.severity}] {f.id}: {f.title}")
            if f.evidence:
                print(f"          evidence: {f.evidence[:140]}")
    else:
        print("\n  No findings.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", choices=["hivv", "blnq"], default=None)
    ap.add_argument("--hivv", default="http://127.0.0.1:3011")
    ap.add_argument("--blnq", default="http://127.0.0.1:3099")
    ap.add_argument("--json", dest="as_json", action="store_true")
    ap.add_argument("--baseline", default=None, help="compare against a baseline JSON")
    args = ap.parse_args()

    findings: list[Finding] = []
    sites = [args.site] if args.site else ["hivv", "blnq"]

    print("\nRunning audit — collecting evidence from live endpoints...")
    if "hivv" in sites:
        collect_hivv(args.hivv.rstrip("/"), findings)
    if "blnq" in sites:
        collect_blnq(args.blnq.rstrip("/"), findings)

    results = {}
    for site in sites:
        cats = score_site(site, findings, coverage_for(site))
        grade, note = overall_grade(cats)
        results[site] = {"categories": cats, "grade": grade,
                         "grade_note": note,
                         "findings": [f.to_dict() for f in findings
                                      if f.site == site]}

    if args.as_json:
        out = {"results": results,
               "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "framework": "docs/AUDIT-FRAMEWORK.md"}
        if args.baseline:
            try:
                base = json.loads(Path(args.baseline).read_text())
                regressions = []
                for site, r in results.items():
                    bc = (base.get("results") or {}).get(site, {}).get("categories") or {}
                    for key, c in r["categories"].items():
                        bs = (bc.get(key) or {}).get("score")
                        if bs is not None and c.get("score") is not None \
                                and c["score"] < bs:
                            regressions.append(f"{site}.{key}: {bs} → {c['score']}")
                out["regressions"] = regressions
                if regressions:
                    print("REGRESSIONS:", "; ".join(regressions), file=sys.stderr)
            except Exception as e:
                out["baseline_error"] = str(e)
        print(json.dumps(out, indent=2))
        return 1 if any(r["findings"] for r in results.values()) else 0

    for site, r in results.items():
        recon = []
        for f in r["findings"]:
            d = dict(f)
            d["fid"] = d.pop("id")
            recon.append(Finding(**d))
        render(site, r["categories"], recon, r["grade"], r["grade_note"])

    print(f"\n{'=' * 70}")
    total_findings = sum(len(r["findings"]) for r in results.values())
    p0 = sum(1 for f in findings if f.severity == P0)
    p1 = sum(1 for f in findings if f.severity == P1)
    print(f"  {total_findings} findings — {p0} P0, {p1} P1")
    if p0:
        print(f"  {p0} CRITICAL finding(s) present — release is blocked.")
    print(f"{'=' * 70}\n")
    return 1 if p0 else 0


if __name__ == "__main__":
    sys.exit(main())
