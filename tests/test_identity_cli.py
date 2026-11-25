#!/usr/bin/env python3
"""Regression tests: the bee's Ed25519 identity (Phase 1) in hivv-cli.py.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
A signature made by the bee must verify on the hub and vice versa. That
contract rests on TWO independently-written canonicalizers (Python
`_canonical_json` vs Node `attest.canonicalize`) and TWO key backends
(`cryptography` package vs the openssl CLI). Any drift is invisible until
every register starts failing in production — so both are pinned HERE,
byte-for-byte, in both directions:

  1. canonical JSON parity — nasty fixtures, Python vs Node, byte-identical
  2. cross-language round trip — Python signs → hub's identity.js verifies
  3. the openssl fallback produces keys/sigs the hub accepts too
  4. identity is ADDITIVE — no key backend / unwritable state = None, never a crash
  5. dispatch — `hivv identity` is a real command, never the chat smart-default

Run:
    python3 -m pytest tests/test_identity_cli.py -q
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"
ATTEST = REPO / "api" / "lib" / "attest.js"
IDENTITY_JS = REPO / "api" / "lib" / "identity.js"

# Capture the originals BEFORE touching them — the import-time env-leaker
# lesson (2026-11-24): a test that sets HIVV_STATE_DIR at import and never
# restores it poisons every later subprocess in the suite.
_ORIG_ENV = {k: os.environ.get(k) for k in ("HIVV_STATE_DIR", "HIVV_HUB")}


@pytest.fixture(scope="module", autouse=True)
def _isolated_state(tmp_path_factory):
    state = tmp_path_factory.mktemp("identity-state")
    os.environ["HIVV_STATE_DIR"] = str(state)
    # dead port: nothing in this suite may talk to a real hub
    os.environ["HIVV_HUB"] = "http://127.0.0.1:1"
    yield state
    for k, v in _ORIG_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load_cli():
    """Import the CLI module WITHOUT running main()."""
    spec = importlib.util.spec_from_file_location("hivv_cli_identity_under_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


@pytest.fixture(scope="module")
def cli(_isolated_state):
    # depends on the state isolation so STATE_DIR points at the tmp dir
    return _load_cli()


# ── Node-side helpers (the OTHER canonicalizer / the hub's verifier) ────────

# The hub-side verifier subprocess must NEVER write into the production
# api/data/identities.json — every node-side call gets its own tmp store.
_HUB_STORE = None


@pytest.fixture(scope="module", autouse=True)
def _hub_store(tmp_path_factory):
    global _HUB_STORE
    _HUB_STORE = str(tmp_path_factory.mktemp("hub-identity") / "identities.json")
    yield
    _HUB_STORE = None


def _node(script: str, stdin: str | None = None) -> str:
    env = dict(os.environ)
    if _HUB_STORE:
        env["HIVV_IDENTITY_FILE"] = _HUB_STORE
    r = subprocess.run(
        ["node", "-e", script],
        input=stdin, capture_output=True, text=True, timeout=60,
        cwd=str(REPO / "api"), env=env,
    )
    if r.returncode != 0:
        raise AssertionError(f"node failed: {r.stderr[:800]}")
    return r.stdout


def _node_canonicalize(py_value) -> str:
    """Canonicalize the SAME value with the hub's attest.canonicalize."""
    payload = json.dumps(py_value, ensure_ascii=False)
    script = (
        "const attest = require(" + json.dumps(str(ATTEST)) + ");"
        "const v = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "process.stdout.write(attest.canonicalize(v));"
    )
    return _node(script, stdin=payload)


# ═══════════════════ 1. canonical JSON parity ═══════════════════════════════

CANON_FIXTURES = [
    {"b": 1, "a": 2, "A": 3, "0": 4},                       # byte-order sort
    {"nested": {"z": [1, 2, {"y": None, "x": True, "w": False}],
                "a": "mid\ttab\nnewline"},
     "unicode": "héllo ❤ 😀 emoji",
     "esc": 'quote " backslash \\ slash /'},
    {"neg": -42, "big": 2**53 - 1, "zero": 0, "list": [], "obj": {}},
    ["mixed", 1, {"k": "v"}, None, True],
    "just a string",
    {"rtl": "السلام عليكم", "bom": "﻿zw", "cjk": "天地玄黄"},
]


@pytest.mark.parametrize("fixture", CANON_FIXTURES, ids=range(len(CANON_FIXTURES)))
def test_canonical_json_byte_parity(cli, fixture):
    """_canonical_json MUST equal attest.canonicalize for the same value."""
    py = cli._canonical_json(fixture)
    js = _node_canonicalize(fixture)
    assert py == js, f"\n py: {py!r}\n js: {js!r}"


def test_canonical_json_rejects_floats(cli):
    with pytest.raises(ValueError):
        cli._canonical_json(1.5)
    # an integral float renders like JS would (JSON.parse(1.0) === 1)
    assert cli._canonical_json(1.0) == "1"


def test_canonical_json_keeps_null(cli):
    # JS canonicalize only drops `undefined` — null must survive on both sides
    assert cli._canonical_json({"a": None}) == '{"a":null}'
    assert _node_canonicalize({"a": None}) == '{"a":null}'


# ═══════════════════ 2. key material ════════════════════════════════════════

def test_keygen_creates_key_with_right_mode_and_principal(cli, tmp_path):
    ident = cli._identity_ensure()
    assert ident is not None, "keygen must succeed (cryptography or openssl)"
    assert ident["principal"].startswith("hivv_")
    assert len(ident["principal"]) == len("hivv_") + 32
    assert len(base64.b64decode(ident["pub"])) == 32
    mode = oct(cli.IDENTITY_KEY.stat().st_mode & 0o777)
    assert mode == "0o600", f"private key must be 0600, got {mode}"

    # stable: a second call returns the SAME key, not a new one
    again = cli._identity_ensure()
    assert again["principal"] == ident["principal"]


def test_principal_is_self_certifying(cli):
    """hivv_ + sha256(raw_pub)[:32] — matches the hub's principalIdFromRaw."""
    import hashlib
    ident = cli._identity_ensure()
    raw = base64.b64decode(ident["pub"])
    expected = "hivv_" + hashlib.sha256(raw).hexdigest()[:32]
    assert ident["principal"] == expected


@pytest.mark.skipif(not shutil.which("openssl"), reason="openssl not installed")
def test_openssl_fallback_generates_hub_verifiable_keys(cli, monkeypatch):
    """With `cryptography` unavailable, openssl must produce keys+sigs the
    hub accepts — the fleet's second backend is not second-class."""
    # block the package the way a missing install would. Null EVERY name in
    # the chain: a cached submodule in sys.modules would otherwise satisfy
    # the from-import before the parent's None is ever consulted.
    for name in ("cryptography",
                 "cryptography.hazmat",
                 "cryptography.hazmat.primitives",
                 "cryptography.hazmat.primitives.serialization",
                 "cryptography.hazmat.primitives.asymmetric",
                 "cryptography.hazmat.primitives.asymmetric.ed25519"):
        monkeypatch.setitem(sys.modules, name, None)
    # fresh key dir so we don't reuse a cryptography-made key
    for p in (cli.IDENTITY_KEY, cli.IDENTITY_PUB):
        try:
            p.unlink()
        except OSError:
            pass
    ident = cli._identity_ensure()
    assert ident is not None, "openssl fallback must produce a key"
    sig = cli._identity_sign(ident["priv"], b"probe message")
    assert len(base64.b64decode(sig)) == 64

    # and the HUB must verify a statement signed by the openssl-made key
    env = cli._identity_envelope("node.register", "opensslbee")
    assert env is not None
    out = _verify_on_hub(env, "opensslbee")
    assert out["ok"] is True, out


# ═══════════════════ 3. cross-language round trip ═══════════════════════════

def _verify_on_hub(envelope: dict, node_id: str, verify_as: str | None = None) -> dict:
    """Run the envelope through the hub's REAL verifier (identity.js).

    verify_as forces the KIND the hub verifies under (defaults to the
    statement's own kind) — passing a different one is how the wrong-kind
    rejection is exercised."""
    script = (
        "const identity = require(" + json.dumps(str(IDENTITY_JS)) + ");"
        "const env = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "const r = identity.verifyIncoming({nodeId: env.node_id, identity: env.block,"
        "  kind: env.kind});"
        "process.stdout.write(JSON.stringify({ok: r.ok, action: r.action,"
        "  problems: r.problems, advisory: r.advisory, principal: r.principal}));"
    )
    payload = json.dumps({"node_id": node_id,
                          "kind": verify_as or envelope["statement"]["kind"],
                          "block": envelope})
    return json.loads(_node(script, stdin=payload))


def test_envelope_shape(cli):
    env = cli._identity_envelope("node.register", "shapebee",
                                 {"hw_id_sha256": "a" * 64, "client": "hivv-cli/test"})
    assert env is not None
    assert env["algorithm"] == "ed25519"
    st = env["statement"]
    assert st["v"] == 1 and st["kind"] == "node.register"
    assert st["node_id"] == "shapebee"
    assert isinstance(st["ts"], int) and not isinstance(st["ts"], bool)
    assert len(st["nonce"]) == 16 and all(c in "0123456789abcdef" for c in st["nonce"])
    assert st["hw_id_sha256"] == "a" * 64
    assert len(base64.b64decode(env["public_key"])) == 32
    assert len(base64.b64decode(env["signature"])) == 64
    # every statement value is a plain str/int (canonical contract: no floats)
    for v in st.values():
        assert isinstance(v, (str, int)), f"statement value must be str/int: {v!r}"


def test_python_signed_envelope_verifies_on_hub(cli):
    """THE round trip: this machine signs, the hub's identity.js accepts."""
    env = cli._identity_envelope("node.register", "crossbee",
                                 {"hw_id_sha256": "b" * 64})
    assert env is not None
    out = _verify_on_hub(env, "crossbee")
    assert out["ok"] is True, out
    assert out["action"] == "bound"
    assert out["principal"] == cli._identity_ensure()["principal"]


def test_tampered_statement_fails_on_hub(cli):
    env = cli._identity_envelope("node.heartbeat", "tamperbee")
    env["statement"]["ts"] = env["statement"]["ts"] + 1   # no re-signature
    out = _verify_on_hub(env, "tamperbee")
    assert out["ok"] is False
    assert any("signature mismatch" in p for p in out["problems"])


def test_wrong_kind_fails_on_hub(cli):
    env = cli._identity_envelope("node.heartbeat", "kindbee")
    # hub verifies it under node.register → the declared kind must not match
    out = _verify_on_hub(env, "kindbee", verify_as="node.register")
    assert out["ok"] is False
    assert any("kind" in p for p in out["problems"])


# ═══════════════════ 4. additive: never break the agent ═════════════════════

def test_envelope_none_when_state_dir_unwritable(cli, tmp_path, monkeypatch):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    monkeypatch.setattr(cli, "IDENTITY_DIR", locked / "identity")
    monkeypatch.setattr(cli, "IDENTITY_KEY", locked / "identity" / "ed25519.key")
    monkeypatch.setattr(cli, "IDENTITY_PUB", locked / "identity" / "ed25519.pub")
    try:
        assert cli._identity_envelope("node.register", "lockedbee") is None
        # and status must not explode either
        assert cli._identity_ensure() is None
    finally:
        locked.chmod(0o700)


def test_envelope_none_without_node_id(cli):
    assert cli._identity_envelope("node.register", "") is None
    assert cli._identity_envelope("node.register", None) is None


# ═══════════════════ 5. dispatch: a real command, never chat ════════════════

def test_identity_is_a_registered_command(cli):
    assert "identity" in cli.COMMANDS, "identity must be a command, not smart-default chat"
    assert cli.COMMANDS["identity"] is cli.cmd_identity
    # parser accepts both actions
    args = cli.build_parser().parse_args(["identity"])
    assert args.action == "status"
    args = cli.build_parser().parse_args(["identity", "keygen", "--json"])
    assert args.action == "keygen" and args.json_output


def test_identity_status_json_offline(cli, capsys):
    """With no node_id there is NO hub call — status must work fully offline."""
    out = cli._identity_envelope("node.register", "offlinebee")  # ensures a key exists
    assert out is not None

    class A:
        action = "status"
        json_output = True
    cli.cmd_identity(A())
    data = json.loads(capsys.readouterr().out)
    assert data["algorithm"] == "ed25519"
    assert data["principal"].startswith("hivv_")
    assert data["node_id"] is None            # never registered → no HTTP attempted
    assert data["hub"] is None
    assert "sign OK" in data["selftest"] or "deterministic" in data["selftest"]


def test_identity_keygen_rotates(cli, capsys):
    before = cli._identity_ensure()["principal"]

    class A:
        action = "keygen"
        json_output = False
    cli.cmd_identity(A())
    out = capsys.readouterr().out
    after = cli._identity_ensure()["principal"]
    assert after != before, "keygen must produce a NEW key"
    assert before in out and after in out, "both principals must be shown"


# ═══════════════════ Phase 2: manifests + rotation ══════════════════════════

def _hub_ops(payload: dict) -> dict:
    """Run bind + manifest + rotation verifications through the hub's REAL
    identity.js in one process (so the binding and the checks share a store)."""
    script = (
        "const identity = require(" + json.dumps(str(IDENTITY_JS)) + ");"
        "const p = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "const out = {};"
        "if (p.bind) out.bind = identity.verifyIncoming({nodeId: p.node_id,"
        "  identity: p.bind, kind: 'node.register'});"
        "if (p.manifest) out.manifest = identity.verifyManifest({nodeId: p.node_id,"
        "  manifest: p.manifest});"
        "if (p.rotation) out.rotation = identity.verifyRotation({nodeId: p.node_id,"
        "  rotation: p.rotation});"
        "if (p.receipt) out.receipt = identity.verifyReceipt({nodeId: p.node_id,"
        "  receipt: p.receipt});"
        "if (p.revocation) out.revocation = identity.verifySelfRevocation({nodeId: p.node_id,"
        "  revocation: p.revocation});"
        "if (p.endorsement) out.endorsement = identity.verifyEndorsement({endorsement: p.endorsement});"
        "if (p.check) out.check = identity.verifyIncoming({nodeId: p.node_id,"
        "  identity: p.check, kind: p.check_kind || 'node.heartbeat'});"
        "if (p.crl) out.crl = identity.listRevocations();"
        "process.stdout.write(JSON.stringify(out));"
    )
    return json.loads(_node(script, stdin=json.dumps(payload)))


def _reg_envelope(cli, node_id: str) -> dict:
    env = cli._identity_envelope("node.register", node_id,
                                 {"hw_id_sha256": "c" * 64})
    assert env is not None
    return env


def test_manifest_envelope_and_hub_verify(cli):
    """Python builds the manifest; the hub's verifyManifest accepts it, and
    the SIGNED values are what the hub applies."""
    node_id = "mfpy"
    bind = _reg_envelope(cli, node_id)
    mf = cli._identity_manifest(node_id, seq=7, tools=["web_search", "calculator"],
                                tools_port=8091,
                                local_models=[{"name": "gemma", "port": 8080}],
                                capabilities=["heartbeat"], volunteer=True)
    assert mf is not None
    st = mf["statement"]
    assert st["kind"] == "capability.manifest" and st["seq"] == 7
    assert st["tools"] == ["web_search", "calculator"]
    assert st["volunteer"] is True

    out = _hub_ops({"node_id": node_id, "bind": bind, "manifest": mf})
    assert out["bind"]["ok"] is True, out
    assert out["manifest"]["ok"] is True, out["manifest"]
    assert out["manifest"]["applied"]["tools"] == ["web_search", "calculator"]


def test_manifest_seq_is_monotonic_on_hub(cli):
    node_id = "mfseq"
    bind = _reg_envelope(cli, node_id)
    mf = cli._identity_manifest(node_id, seq=3, tools=["t"], tools_port=0,
                                local_models=[], capabilities=[], volunteer=False)
    first = _hub_ops({"node_id": node_id, "bind": bind, "manifest": mf})
    assert first["manifest"]["ok"] is True

    # same seq, FRESH nonce → still refused (replay/reorder protection)
    mf2 = cli._identity_manifest(node_id, seq=3, tools=["t"], tools_port=0,
                                 local_models=[], capabilities=[], volunteer=False)
    second = _hub_ops({"node_id": node_id, "manifest": mf2})
    assert second["manifest"]["ok"] is False
    assert any("stale seq" in p for p in second["manifest"]["problems"])

    # bumped seq → accepted
    mf3 = cli._identity_manifest(node_id, seq=4, tools=["t"], tools_port=0,
                                 local_models=[], capabilities=[], volunteer=False)
    third = _hub_ops({"node_id": node_id, "manifest": mf3})
    assert third["manifest"]["ok"] is True


def test_rotation_statement_roundtrip(cli):
    """Old key signs the successor; the hub accepts WITHOUT legacy proof —
    and a forged signer is refused."""
    node_id = "rotpy"
    bind = _reg_envelope(cli, node_id)
    old = cli._identity_ensure()

    # generate the successor the way cmd_identity rotate does
    new_priv, new_raw = cli._identity_generate()
    new_pub = base64.b64encode(new_raw).decode()
    new_principal = cli._principal_from_pub(new_pub)
    assert new_principal != old["principal"]

    import secrets as _secrets
    import time as _time
    rstmt = {"v": 1, "kind": "identity.rotate", "node_id": node_id,
             "ts": int(_time.time()), "nonce": _secrets.token_hex(8),
             "new_public_key": new_pub}
    rsig = cli._identity_sign(old["priv"], cli._canonical_json(rstmt).encode())
    rotation = {"algorithm": "ed25519", "public_key": old["pub"],
                "statement": rstmt, "signature": rsig}

    out = _hub_ops({"node_id": node_id, "bind": bind, "rotation": rotation})
    assert out["bind"]["ok"] is True, out
    assert out["rotation"]["ok"] is True, out["rotation"]
    assert out["rotation"]["principal"] == new_principal

    # forged: a DIFFERENT key signs a rotation claiming yet another successor
    forged_priv, forged_raw = cli._identity_generate()
    fstmt = {"v": 1, "kind": "identity.rotate", "node_id": node_id,
             "ts": int(_time.time()), "nonce": _secrets.token_hex(8),
             "new_public_key": base64.b64encode(forged_raw).decode()}
    fsig = cli._identity_sign(forged_priv, cli._canonical_json(fstmt).encode())
    forged = {"algorithm": "ed25519", "public_key": old["pub"],
              "statement": fstmt, "signature": fsig}
    out2 = _hub_ops({"node_id": node_id, "rotation": forged})
    assert out2["rotation"]["ok"] is False
    assert any("CURRENT bound key" in p for p in out2["rotation"]["problems"])


def test_identity_rotate_command_offline(cli, capsys):
    """No node_id → pure local rotation, no hub call, clear output."""
    before = cli._identity_ensure()["principal"]

    class A:
        action = "rotate"
        json_output = False
    cli.cmd_identity(A())
    out = capsys.readouterr().out
    after = cli._identity_ensure()["principal"]
    assert after != before, "rotate must produce a NEW key"
    assert before in out and after in out
    assert "no node_id" in out or "binds on first register" in out


# ═══════════════════ Phase 3: execution receipts ═══════════════════════════

def test_receipt_envelope_and_hub_verify(cli):
    """Python signs the receipt; the hub verifies it against the bound key
    and keeps it in the ring."""
    node_id = "rcptpy"
    bind = _reg_envelope(cli, node_id)
    report = {"plan_id": "P_test1", "ok": True, "op": "cli_update",
              "result": "update applied", "ts": 1795590000}
    rcpt = cli._identity_receipt(node_id, report)
    assert rcpt is not None
    st = rcpt["statement"]
    assert st["kind"] == "execution.receipt"
    assert st["op"] == "cli_update" and st["result"] == "ok"
    assert st["job_id"] == "P_test1"
    assert len(st["output_sha256"]) == 64

    out = _hub_ops({"node_id": node_id, "bind": bind, "receipt": rcpt})
    assert out["bind"]["ok"] is True, out
    assert out["receipt"]["ok"] is True, out["receipt"]
    assert out["receipt"]["receipt"]["op"] == "cli_update"


def test_receipt_output_hash_binds_the_report(cli):
    """output_sha256 is over the EXACT report — edit the report and the
    binding changes (the hub can detect post-signing edits)."""
    import hashlib
    node_id = "rcpthash"
    report = {"plan_id": "P_x", "ok": False, "op": "agent_restart",
              "result": "failed: boom", "ts": 1}
    rcpt = cli._identity_receipt(node_id, report)
    core = dict(report)
    expected = hashlib.sha256(cli._canonical_json(core).encode()).hexdigest()
    assert rcpt["statement"]["output_sha256"] == expected

    edited = dict(report, result="failed: nothing to see here")
    rcpt2 = cli._identity_receipt(node_id, edited)
    assert rcpt2["statement"]["output_sha256"] != expected


def test_receipt_tampered_and_foreign_refused(cli):
    node_id = "rcptbad"
    bind = _reg_envelope(cli, node_id)
    report = {"plan_id": "P_y", "ok": True, "op": "selftest", "result": "ok", "ts": 2}
    rcpt = cli._identity_receipt(node_id, report)

    # tampered result after signing
    import copy
    tampered = copy.deepcopy(rcpt)
    tampered["statement"]["result"] = "failed"
    out = _hub_ops({"node_id": node_id, "bind": bind, "receipt": tampered})
    assert out["receipt"]["ok"] is False
    assert any("signature mismatch" in p for p in out["receipt"]["problems"])

    # a different key claims to be the bee
    other_priv, other_raw = cli._identity_generate()
    forged = dict(rcpt)
    forged["public_key"] = base64.b64encode(other_raw).decode()
    forged["signature"] = cli._identity_sign(
        other_priv, cli._canonical_json(rcpt["statement"]).encode())
    out2 = _hub_ops({"node_id": node_id, "receipt": forged})
    assert out2["receipt"]["ok"] is False
    assert any("bound key" in p for p in out2["receipt"]["problems"])


# ═══════════════════ Phase 4: revocation + endorsements ════════════════════

def test_self_revocation_roundtrip_and_crl(cli):
    """The bound key signs its own revocation; afterwards NOTHING it signs
    verifies — and a fresh key + legacy proof recovers while the CRL keeps
    the old principal forever."""
    node_id = "revpy"
    bind = _reg_envelope(cli, node_id)
    ident = cli._identity_ensure()

    import secrets as _secrets
    import time as _time
    rst = {"v": 1, "kind": "identity.revoke", "node_id": node_id,
           "ts": int(_time.time()), "nonce": _secrets.token_hex(8),
           "principal": ident["principal"], "reason": "key may be compromised"}
    rsig = cli._identity_sign(ident["priv"], cli._canonical_json(rst).encode())
    rev = {"algorithm": "ed25519", "public_key": ident["pub"],
           "statement": rst, "signature": rsig}

    out = _hub_ops({"node_id": node_id, "bind": bind, "revocation": rev,
                    "crl": True})
    assert out["bind"]["ok"] is True, out
    assert out["revocation"]["ok"] is True, out["revocation"]
    assert len(out["crl"]) == 1 and out["crl"][0]["by"] == "self"
    assert out["crl"][0]["reason"] == "key may be compromised"

    # the revoked key presents a heartbeat → refused with the CRL reason
    hb = cli._identity_envelope("node.heartbeat", node_id)
    out2 = _hub_ops({"node_id": node_id, "check": hb, "crl": True})
    assert out2["check"]["ok"] is False
    assert any("revoked:" in p for p in out2["check"]["problems"])
    assert len(out2["crl"]) == 1, "the CRL must retain the principal"

    # revoke without a reason is refused by the hub's shape check too
    import copy
    bad = copy.deepcopy(rev)
    bad["statement"] = dict(rst, reason="", nonce=_secrets.token_hex(8))
    bad["signature"] = cli._identity_sign(
        ident["priv"], cli._canonical_json(bad["statement"]).encode())
    out3 = _hub_ops({"node_id": node_id, "revocation": bad})
    assert out3["revocation"]["ok"] is False

    # Test isolation — and the REAL flow: the CLI revoke action mints a
    # fresh key afterwards, because the CRL now holds THIS principal and
    # every later bind with it would (correctly) be refused.
    _np, _nr = cli._identity_generate()
    cli._identity_write(_np, base64.b64encode(_nr).decode())


def test_endorsement_roundtrip(cli):
    """The operator key (never a bee key) signs the endorsement; the hub
    checks self-consistency and the node-binding cross-check."""
    node_id = "endpy"
    bind = _reg_envelope(cli, node_id)
    ident = cli._identity_ensure()
    op = cli._operator_ensure()
    assert op is not None
    assert op["principal"] != ident["principal"], "operator key must differ from the bee key"

    import secrets as _secrets
    import time as _time
    est = {"v": 1, "kind": "operator.endorse", "ts": int(_time.time()),
           "nonce": _secrets.token_hex(8), "operator_principal": op["principal"],
           "node_id": node_id, "node_principal": ident["principal"], "role": "owner"}
    esig = cli._identity_sign(op["priv"], cli._canonical_json(est).encode())
    endo = {"algorithm": "ed25519", "public_key": op["pub"],
            "statement": est, "signature": esig}

    out = _hub_ops({"node_id": node_id, "bind": bind, "endorsement": endo})
    assert out["bind"]["ok"] is True, out
    assert out["endorsement"]["ok"] is True, out["endorsement"]
    assert out["endorsement"]["entry"]["operator_principal"] == op["principal"]

    # forged: a valid signature under the operator key, but the statement
    # CLAIMS a different operator principal — must not derive → refused
    forged_stmt = dict(est, nonce=_secrets.token_hex(8),
                       operator_principal=ident["principal"])
    forged_sig = cli._identity_sign(
        op["priv"], cli._canonical_json(forged_stmt).encode())
    forged = {"algorithm": "ed25519", "public_key": op["pub"],
              "statement": forged_stmt, "signature": forged_sig}
    out2 = _hub_ops({"node_id": node_id, "endorsement": forged})
    assert out2["endorsement"]["ok"] is False
    assert any("does not derive" in p for p in out2["endorsement"]["problems"])

    # forged: signed by the BEE key entirely (wrong signer → bad signature)
    wrong_sig_stmt = dict(est, nonce=_secrets.token_hex(8))
    wrong_sig = cli._identity_sign(
        ident["priv"], cli._canonical_json(wrong_sig_stmt).encode())
    wrong = {"algorithm": "ed25519", "public_key": op["pub"],
             "statement": wrong_sig_stmt, "signature": wrong_sig}
    out3 = _hub_ops({"node_id": node_id, "endorsement": wrong})
    assert out3["endorsement"]["ok"] is False


def test_operator_key_created_with_right_mode(cli):
    op = cli._operator_ensure()
    assert op is not None
    assert op["principal"].startswith("hivv_")
    mode = oct(cli.OPERATOR_KEY.stat().st_mode & 0o777)
    assert mode == "0o600", f"operator private key must be 0600, got {mode}"
    # stable across calls
    assert cli._operator_ensure()["principal"] == op["principal"]


def test_revoke_command_requires_reason(cli, capsys):
    with pytest.raises(SystemExit):
        class A:
            action = "revoke"
            json_output = False
            reason = None
        cli.cmd_identity(A())
    captured = capsys.readouterr()
    assert "--reason" in (captured.out + captured.err)


def test_endorse_command_requires_target(cli, capsys):
    with pytest.raises(SystemExit):
        class A:
            action = "endorse"
            json_output = False
            target = None
            role = "owner"
        cli.cmd_identity(A())
    captured = capsys.readouterr()
    assert "endorse" in (captured.out + captured.err)


def test_identity_receipts_command_never_crashes(cli, capsys):
    """receipts with no node_id dies with a clear message (SystemExit via
    die(), never a traceback)."""
    with pytest.raises(SystemExit):
        class A:
            action = "receipts"
            json_output = False
            limit = 20
        cli.cmd_identity(A())
    captured = capsys.readouterr()
    # die() may print to either stream — a clear message, never a traceback
    blob = captured.out + captured.err
    assert "node_id" in blob
    assert "Traceback" not in blob


def test_identity_rotate_command_dead_hub_falls_back(cli, capsys, tmp_path):
    """With a node_id but an unreachable hub: the key is STILL rotated (the
    statement was already signed) and the fallback path is explained."""
    import json as _json
    state_dir = cli.STATE_DIR
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "state.json").write_text(_json.dumps({"node_id": "deadhubbee"}))
    before = cli._identity_ensure()["principal"]

    class A:
        action = "rotate"
        json_output = False
    cli.cmd_identity(A())
    out = capsys.readouterr().out
    after = cli._identity_ensure()["principal"]
    assert after != before, "rotation must not be blocked by an unreachable hub"
    assert "rotate refused" in out or "http 0" in out
    assert "legacy proof" in out or "rebinds" in out
    (state_dir / "state.json").unlink(missing_ok=True)
