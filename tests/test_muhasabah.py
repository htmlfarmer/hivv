#!/usr/bin/env python3
"""MUHASABAH — our guards, accounting for themselves.

محاسبہ · self-accounting. The detector turned on the detector.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
A guard that *looks* alive and does nothing. Three states are identical from
outside: the guard evaluated and stayed silent, the guard was never reached,
and the guard threw and failed open. Only the first is a decision. This suite
exists so those three can never be confused again.

Named from our own vocabulary (O3.txt), not borrowed:

    MUHASABAH   the suite — self-accounting, the guard auditing itself
    MIZAN       the scale — calibrated BEFORE anything is weighed
    RADD        رد · the guard rejected it. Teeth.
    MAUN        मौन · sacred silence. It let the thing walk straight past.
    HAQ         حق · the guard behaved — we are in the truth.
    BATIL       باطل · the void — the guard failed.

THE THREE CONTROLLED FAILURES (exactly three, every run)
────────────────────────────────────────────────────────
1. MAYA    माया · "too holy to fail."  Pristine, RFC-conformant, utterly
           legitimate-looking — and hollow underneath. A canonical IPv6
           literal that no linter would ever flag. Its perfection is the
           flaw: a scale that never tips is not a scale.
2. KHARAB  خراب · "too bad."  Crude, obvious, stinking on sight. This one
           proves the detector has teeth at all. If KHARAB walks in the
           front door, close the laptop.
3. RAAZ    راز · "the secret."  Generated fresh at runtime from a private
           pool — never the same payload twice, so this suite cannot learn
           its own answers. *(Unravel the Raaz.)*

MIZAN runs first and must tip BOTH ways. If the known-bad does not RADD, or
the known-good does not MAUN, the scale is broken and everything after it
means nothing — the suite says so out loud instead of reporting a green run.

NO NETWORK, BY CONSTRUCTION
───────────────────────────
Every payload is a literal, a scheme, or a blocked suffix — none require a
resolver. DNS is stubbed to explode inside the runner as a second lock: if a
payload ever tries to reach the network, the suite reports it rather than
quietly leaning on a resolver failure.

Run:
    python3 -m pytest tests/test_muhasabah.py -q
"""

from __future__ import annotations

import json
import random
import subprocess
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SSRF_JS = REPO / "api" / "lib" / "ssrf.js"

RADD = "RADD"  # rejected — the guard had teeth
MAUN = "MAUN"  # sacred silence — it let it through
THREW = "THREW"  # the guard itself broke

# If any payload reaches the resolver, this marker comes back and the suite
# fails loudly: a no-network test must never quietly depend on one.
_DNS_MARKER = "MUHASABAH-DNS-DISABLED"

# ─────────────────────────────────────────────────────────────────────────────
# The runner: one node process, a batch of URLs in, verdicts out.
# ─────────────────────────────────────────────────────────────────────────────

_NODE = f"""
const fs = require('fs');
const dns = require('dns').promises;
// Second lock on the no-network promise — see the module docstring.
dns.lookup = async () => {{ throw new Error('{_DNS_MARKER}'); }};
const {{ checkUrl }} = require({json.dumps(str(SSRF_JS))});
const urls = JSON.parse(fs.readFileSync(0, 'utf8'));
(async () => {{
  const out = [];
  for (const u of urls) {{
    try {{
      const v = await checkUrl(u);
      out.push({{ v: v.ok ? '{MAUN}' : '{RADD}', r: v.reason || '' }});
    }} catch (e) {{
      out.push({{ v: '{THREW}', r: String((e && e.message) || e) }});
    }}
  }}
  process.stdout.write(JSON.stringify(out));
}})();
"""


def _verdicts(urls: list[str]) -> list[dict]:
    """Run a batch of URLs through the REAL guard, in one node process."""
    r = subprocess.run(
        ["node", "-e", _NODE],
        input=json.dumps(list(urls)),
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(REPO / "api"),
    )
    if r.returncode != 0:
        raise AssertionError(f"node failed: {r.stderr[:800]}")
    return json.loads(r.stdout)


def _verdict(url: str) -> dict:
    return _verdicts([url])[0]


def _assert_refused(name: str, url: str) -> None:
    """One payload must RADD. The message carries the payload so a failure
    replays itself — a verdict with no reproduction path is worthless."""
    got = _verdict(url)
    assert got["v"] == RADD, (
        f"BATIL — {name} was not refused.\n"
        f"  payload : {url}\n"
        f"  verdict : {got['v']}   (expected {RADD})\n"
        f"  reason  : {got['r']}\n"
        f"  replay  : node -e \"...checkUrl({url!r})...\""
    )
    assert _DNS_MARKER not in got["r"], (
        f"payload escaped to the resolver (no-network suite): {url}"
    )


_HUB_IS_PRIVATE = f"""
const s = require({json.dumps(str(SSRF_JS))});
const net = require('net');
const ip = process.argv[1];
const fam = net.isIP(ip);
const r = fam === 4 ? s.isPrivateIPv4(ip) : fam === 6 ? s.isPrivateIPv6(ip) : true;
process.stdout.write(r ? '1' : '0');
"""


def _hub_is_private(ip: str) -> bool:
    """The HUB guard's verdict on a bare IP literal, via its own exports.

    Deliberately not re-implemented in Python: the whole point of the
    agreement test is that each side is asked, not that one side guesses
    for both.
    """
    r = subprocess.run(
        ["node", "-e", _HUB_IS_PRIVATE, ip],
        capture_output=True,
        text=True,
        timeout=30,
        cwd=str(REPO / "api"),
    )
    if r.returncode != 0:
        raise AssertionError(f"node failed: {r.stderr[:800]}")
    return r.stdout.strip() == "1"


# ─────────────────────────────────────────────────────────────────────────────
# MIZAN — calibrate the scale before anything is weighed.
# ─────────────────────────────────────────────────────────────────────────────

# Known-bad: plain loopback, the most boring evil there is.
MIZAN_KNOWN_BAD = "http://127.0.0.1/"
# Known-good: a public IP LITERAL, so it never needs a resolver.
MIZAN_KNOWN_GOOD = "http://8.8.8.8/"


def test_mizan_the_scale_tips_both_ways() -> None:
    """MIZAN first. A scale that only tips one way cannot weigh anything.

    This is the calibration foreman called "prove the harness can produce a
    red and a clean green" — we just say: weigh before you judge.
    """
    bad = _verdict(MIZAN_KNOWN_BAD)
    good = _verdict(MIZAN_KNOWN_GOOD)

    assert bad["v"] == RADD, (
        f"MIZAN did not tip toward RADD on a known-bad payload.\n"
        f"  payload : {MIZAN_KNOWN_BAD}\n"
        f"  verdict : {bad['v']}  reason: {bad['r']}\n"
        f"  Nothing after this line means anything until the scale is fixed."
    )
    assert good["v"] == MAUN, (
        f"MIZAN did not tip toward MAUN on a known-good payload.\n"
        f"  payload : {MIZAN_KNOWN_GOOD}\n"
        f"  verdict : {good['v']}  reason: {good['r']}\n"
        f"  Either the guard blocks everything (useless) or the scale is blind."
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. MAYA — too holy to fail. The veil: flawless surface, hollow within.
# ─────────────────────────────────────────────────────────────────────────────

# Every one of these is a canonical, spec-conformant IPv6 literal. No linter
# would flag them. No human eyeball would pause on them. Each one embeds an
# IPv4 address in a transition prefix — and several of them mean
# 169.254.169.254 (the cloud metadata endpoint) or 127.0.0.1 (ourselves).
_MAYA = [
    "http://[64:ff9b::a9fe:a9fe]/",  # NAT64 → 169.254.169.254 metadata
    "http://[64:ff9b::7f00:1]/",     # NAT64 → 127.0.0.1
    "http://[64:ff9b::c0a8:101]/",   # NAT64 → 192.168.1.1
    "http://[2002:a9fe:a9fe::]/",    # 6to4 → 169.254.169.254 metadata
    "http://[2002:7f00:1::]/",       # 6to4 → 127.0.0.1
    "http://[::ffff:0:7f00:1]/",     # IPv4-translated → 127.0.0.1
    "http://[64:ff9b::127.0.0.1]/",  # the dotted spelling of the first one
    # NAT64 local-use, RFC 6052 §2.2 /48 layout: prefix(48) then the v4.
    # The malformed spelling (v4 shoved at the tail) is caught too, but these
    # two are the WELL-FORMED ones — a fix that only handled the typo would
    # pass a sloppy test and miss the real address.
    "http://[64:ff9b:1:7f00:1::]/",   # → 127.0.0.1
    "http://[64:ff9b:1:a9fe:a9fe::]/", # → 169.254.169.254 metadata
]


def test_maya_the_veil_is_seen_through() -> None:
    """MAYA — the failure that is too good.

    A perfect-looking address that is rotten underneath. The guard must look
    PAST the surface: if it trusts the form, the veil holds and the metadata
    endpoint is one fetch away.
    """
    for url in _MAYA:
        _assert_refused("MAYA", url)


# ─────────────────────────────────────────────────────────────────────────────
# 2. KHARAB — too bad. Obvious, crude, embarrassing to let through.
# ─────────────────────────────────────────────────────────────────────────────

_KHARAB = [
    "http://169.254.169.254/latest/meta-data/",  # the metadata endpoint, in daylight
    "http://127.0.0.1:5432/",                    # postgres
    "http://[::1]:3011/api/health",              # our own gateway
    "http://localhost/admin",
    "http://printer.local/",
    "file:///etc/passwd",
    "gopher://127.0.0.1:70/",
    "http://0.0.0.0/",
]


def test_kharab_cannot_walk_in_the_front_door() -> None:
    """KHARAB — the failure that is too bad.

    Nothing subtle here. If this one gets through, the detector has no teeth
    and every other verdict in this file is theatre.
    """
    for url in _KHARAB:
        _assert_refused("KHARAB", url)


# ─────────────────────────────────────────────────────────────────────────────
# 3. RAAZ — the secret. Fresh every run, so the suite can't memorise.
# ─────────────────────────────────────────────────────────────────────────────

# Every range below is private by construction — RAAZ never generates a
# payload that is *allowed to* succeed, only one that must be refused.
_PRIVATE_V4_RANGES = [
    ("0.0.0.0", 8),
    ("10.0.0.0", 8),
    ("100.64.0.0", 10),
    ("127.0.0.0", 8),
    ("169.254.0.0", 16),
    ("172.16.0.0", 12),
    ("192.168.0.0", 16),
]

_PRIVATE_V6 = ["::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1"]

_BAD_SUFFIXES = [".local", ".internal", ".localhost", ".localdomain"]

_BAD_SCHEMES = [
    "file:///etc/passwd",
    "ftp://127.0.0.1/",
    "gopher://127.0.0.1:70/",
    "dict://127.0.0.1:2628/",
    "ldap://127.0.0.1:389/",
]


def _private_v4_in(base: str, bits: int, rng: random.Random) -> str:
    """A private IPv4 inside a specific range — the range and the address are
    chosen TOGETHER, because a safety argument about which octets survive
    shortening is worthless if the address came from a different range."""
    host_bits = 32 - bits
    network = int.from_bytes(bytes(int(p) for p in base.split(".")), "big")
    if host_bits == 0:
        return base
    mask = (0xFFFFFFFF << host_bits) & 0xFFFFFFFF
    value = (network & mask) | rng.getrandbits(host_bits)
    return ".".join(str((value >> s) & 0xFF) for s in (24, 16, 8, 0))


def _random_private_v4(rng: random.Random) -> str:
    base, bits = rng.choice(_PRIVATE_V4_RANGES)
    return _private_v4_in(base, bits, rng)


def _v4_to_hex_pair(v4: str) -> tuple[str, str]:
    a, b, c, d = (int(p) for p in v4.split("."))
    return f"{((a << 8) | b):x}", f"{((c << 8) | d):x}"


def _v4_to_int(v4: str) -> int:
    a, b, c, d = (int(p) for p in v4.split("."))
    return (a << 24) | (b << 16) | (c << 8) | d


def _raaz(rng: random.Random) -> str:
    """One fresh payload. Never twice the same shape AND never twice the
    same value — freshness is what stops this suite memorising itself."""
    kind = rng.choice(
        [
            "v4",
            "v6",
            "suffix",
            "scheme",
            "userinfo",
            "nat64",
            "6to4",
            "translated",
            "mapped",
            "decimal",
            "shorthand",
        ]
    )

    if kind == "v4":
        return f"http://{_random_private_v4(rng)}/"

    if kind == "v6":
        return f"http://[{rng.choice(_PRIVATE_V6)}]/"

    if kind == "suffix":
        host = rng.choice(["router", "db", "printer", "nas", "gateway", "nas"])
        return f"http://{host}{rng.choice(_BAD_SUFFIXES)}/"

    if kind == "scheme":
        return rng.choice(_BAD_SCHEMES)

    if kind == "userinfo":
        return f"http://innocent@{_random_private_v4(rng)}/"

    if kind in ("nat64", "6to4", "translated", "mapped"):
        hi, lo = _v4_to_hex_pair(_random_private_v4(rng))
        if kind == "nat64":
            return f"http://[64:ff9b::{hi}:{lo}]/"
        if kind == "6to4":
            return f"http://[2002:{hi}:{lo}::]/"
        if kind == "translated":
            return f"http://[::ffff:0:{hi}:{lo}]/"
        return f"http://[::ffff:{hi}:{lo}]/"

    if kind == "decimal":
        return f"http://{_v4_to_int(_random_private_v4(rng))}/"

    # Shorthand — the nastiest little trap in IPv4 parsing, and the reason this
    # branch is written defensively. WHATWG re-parses a shortened address by
    # FILLING FROM THE RIGHT, so `169.254` becomes 169.0.0.254 — which is
    # PUBLIC. Shortening a private address can therefore manufacture a legal
    # public one, and a test that asserts "must be refused" would then be
    # asserting something untrue. Only emit a form that provably keeps the
    # network part intact:
    #   a.b     → (a<<24)|b      keeps only the FIRST octet  → safe on /8
    #   a.b.c   → (a<<24)|(b<<16)|c keeps the first two       → safe on ≤ /16
    base, bits = rng.choice(_PRIVATE_V4_RANGES)
    a, b, c, d = (int(p) for p in _private_v4_in(base, bits, rng).split("."))
    if bits == 8 and rng.random() < 0.5:
        return f"http://{a}.{d}/"          # network is the first octet alone
    if bits <= 16:
        return f"http://{a}.{b}.{c}/"      # network survives the first two
    return f"http://{a}.{b}.{c}.{d}/"


def test_raaz_is_refused_and_actually_fresh() -> None:
    """RAAZ — the secret.

    Ten draws, all refused, and at least two must differ. The second half is
    the point: a "random" generator that emits the same payload every run has
    quietly become a fixed test wearing a costume.
    """
    seed = f"{time.time_ns()}-{_random_private_v4(random.Random())}"
    rng = random.Random(seed)

    draws = [_raaz(rng) for _ in range(10)]

    for url in draws:
        _assert_refused("RAAZ", url)

    assert len(set(draws)) >= 2, (
        "RAAZ is not fresh — ten draws produced one payload.\n"
        f"  payload : {draws[0]}\n"
        "  A constant wearing a costume is a fixed test, not a secret."
    )


def test_raaz_differs_between_runs() -> None:
    """Two independent runs must not agree.

    Pinned by seeding from the clock: if this ever collides, the generator
    has collapsed back to a constant and RAAZ is theatre.
    """
    a = _raaz(random.Random(f"a-{time.time_ns()}"))
    b = _raaz(random.Random(f"b-{time.time_ns()}"))
    # Different seeds across a nanosecond clock — if these match, the pool
    # has one member left in it.
    assert a != b or len(_PRIVATE_V6) + len(_BAD_SCHEMES) < 2, (
        f"RAAZ produced the same payload from two seeds: {a}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# THE SECOND GUARD — public_html/hivv-tools.py
#
# Every bee runs this one on its own box (port 18789, loopback). It is a
# separate implementation with a separate predicate, so it gets its own
# accounting: a fix to the hub's guard says nothing about this one.
#
# Only `_is_private_ip` is exercised. `_host_is_internal` calls
# socket.getaddrinfo, which would reach the network — and this suite's
# promise is that it never does.
# ─────────────────────────────────────────────────────────────────────────────

_TOOLS_PY = REPO / "public_html" / "hivv-tools.py"


def _python_guard():
    """Import the bee-side guard. It carries a __main__ guard, so importing
    starts no server — verified rather than assumed."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("hivv_tools_under_test", _TOOLS_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._is_private_ip


# Literal forms of the same attack class MAYA uses on the hub guard.
_PY_EVIL = [
    "64:ff9b::7f00:1",        # NAT64 → 127.0.0.1
    "64:ff9b::a9fe:a9fe",     # NAT64 → 169.254.169.254 metadata
    "2002:7f00:1::",          # 6to4 → 127.0.0.1
    "2002:a9fe:a9fe::",       # 6to4 → metadata
    "::ffff:0:7f00:1",        # IPv4-translated → 127.0.0.1
    "::ffff:7f00:1",          # IPv4-mapped → 127.0.0.1
    "::1",
    "fd00::1",                # unique local
    "fe80::1",                # link-local
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "192.168.1.1",
]

# Plain public addresses — the scale has to tip the other way here too.
_PY_PUBLIC = ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "2001:4860:4860::8888"]


def test_mizan_python_guard_tips_both_ways() -> None:
    """MIZAN, again, for the second guard.

    NOTE, honestly: this guard is CONSERVATIVE. It refuses an entire
    transition prefix, so it also refuses a PUBLIC address written in a
    mapped form (`::ffff:8.8.8.8`). That is over-blocking, not a hole — and
    it is why the known-good below uses plain public addresses rather than
    the exotic spellings. Asserted here so nobody mistakes bluntness for
    blindness.
    """
    guard = _python_guard()

    for ip in ("127.0.0.1", "64:ff9b::a9fe:a9fe"):
        assert guard(ip) is True, (
            f"BATIL — the bee-side guard let {ip} through.\n"
            f"  This one runs on EVERY bee's own machine."
        )
    for ip in ("8.8.8.8", "2606:4700::1111"):
        assert guard(ip) is False, (
            f"BATIL — the bee-side guard refused public {ip}.\n"
            f"  A guard that blocks everything is as useless as one that blocks nothing."
        )


def test_maya_the_veil_is_seen_through_by_the_bee_side_guard() -> None:
    """MAYA, second guard.

    The hub and the bee are two implementations of one promise. Each must
    see through the veil in its own right — a fix to one is not a fix to
    both, which is precisely how the hub's hole survived so long.
    """
    guard = _python_guard()
    for ip in _PY_EVIL:
        assert guard(ip) is True, (
            f"BATIL — bee-side guard did not recognise {ip} as internal.\n"
            f"  verdict: allowed (expected refused)\n"
            f"  replay  : python3 -c \"..._is_private_ip('{ip}')...\""
        )


def test_the_two_guards_agree_on_every_shared_payload() -> None:
    """Neither guard may be the weaker one.

    Where both can judge the same literal, they must reach the SAME verdict.
    Divergence is the actual failure mode: a payload the hub refuses and the
    bee allows is a hole that only opens on the bee's machine — the one place
    nobody is watching.
    """
    import ipaddress

    guard = _python_guard()
    for ip in _PY_EVIL + _PY_PUBLIC:
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            continue  # not a literal — the hub's guard judges hostnames, we don't
        py_verdict = bool(guard(ip))
        # The hub's view, via its own exported predicate.
        hub = _hub_is_private(ip)
        assert py_verdict == hub, (
            f"The two SSRF guards disagree on {ip}:\n"
            f"  hub  (ssrf.js)        : {'private' if hub else 'public'}\n"
            f"  bee  (hivv-tools.py)  : {'private' if py_verdict else 'public'}\n"
            f"  Whichever is wrong is a live hole on one side of the network."
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
