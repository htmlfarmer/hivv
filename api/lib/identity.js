// api/lib/identity.js — persistent Ed25519 identities for bees.
//
// Phase 1 of the identity layer: every bee MAY hold an Ed25519 keypair, and
// the hub binds node_id → public key in a FILE-backed store (works in
// local-first/no-DB mode, exactly like orchestrator's nodes.json).
//
// The principal is SELF-CERTIFYING — hivv_ + sha256(raw_pub)[0:32] via
// attest.principalIdFromRaw — the SAME namespace attestation issuers use, so
// a bee identity and a review issuer live in one verifiable namespace.
// A principal cannot be claimed by anyone who does not hold the private key.
//
// DUAL-MODE POLICY (advisory first — 2026-11-24):
//   * a register/heartbeat with NO identity block is accepted unchanged
//     (legacy CLIs keep working — nothing about them even changes),
//   * a PRESENT identity block is verified:
//       - crypto failures (bad signature, principal/key mismatch, wrong
//         node_id/kind/version, replayed nonce, claiming a bound node with
//         an unknown key) are REJECTED at /register (403 IDENTITY_INVALID)
//         but only RECORDED at /heartbeat — a broken signer must never
//         knock its own bee offline,
//       - a stale timestamp with an unseen nonce is ADVISORY everywhere:
//         recorded with the measured skew, never fatal (a bee with a bad
//         clock is a health problem, not an attack),
//   * the first verified sighting BINDS the key — at register OR heartbeat
//     (existing bees resume without re-registering, so their first
//     identity-bearing heartbeat is the binding moment),
//   * presenting a DIFFERENT key for a bound node replaces it only when the
//     caller also proved the legacy credentials (node secret or hw_id) —
//     that is the recovery/rotation anchor, mirroring authorizeClaim.
//
// The canonicalization contract is attest.canonicalize (UTF-8 byte key
// order, no whitespace, integers only), mirrored byte-for-byte by the CLI's
// _canonical_json — tests/test_identity_cli.py pins the parity both ways.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const attest = require('./attest');
const { PRINCIPAL_PATTERN } = require('./attestation-contract');

const IDENTITY_FILE = process.env.HIVV_IDENTITY_FILE ||
  path.join(__dirname, '..', 'data', 'identities.json');

const FRESHNESS_S = 300;        // ±5 min: statement ts window
const NONCE_TTL_MS = FRESHNESS_S * 1000;
const ALGORITHM = 'ed25519';

// base64 sanity — Buffer.from(x, 'base64') silently IGNORES invalid
// characters, so a junk "key" could decode to the right length by accident.
// 32 raw bytes → 43 data chars + '=' (44 total); 64 → 86 data + '==' (88).
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;
const B64_64 = /^[A-Za-z0-9+/]{86}==$/;
const NONCE_RE = /^[0-9a-f]{16,64}$/;

// ── store ──────────────────────────────────────────────────────────────────
// Single-process module cache (the gateway is one process — same assumption
// nodes.json makes). Atomic writes, 0600: the file holds public keys, but a
// writable-by-others identity store is a squatting surface.
let _cache = null;
const _nonces = new Map(); // "nodeId:nonce" → expiry ms (replay window)

function _emptyStore() {
  return { version: 1, principals: {} };
}

function _load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.principals !== 'object') {
      throw new Error('bad shape');
    }
    _cache = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // A corrupt store must not take the gateway down, and must not silently
      // hand out bindings either — start empty and let it be rewritten on the
      // next bind (the old keys remain provable via re-bind + legacy proof).
      console.error(`[IDENTITY] store unreadable (${e.message}) — starting empty`);
    }
    _cache = _emptyStore();
  }
  return _cache;
}

function _save() {
  const dir = path.dirname(IDENTITY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${IDENTITY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, IDENTITY_FILE);
}

function _nowS() {
  return Math.floor(Date.now() / 1000);
}

function _pruneNonces(nowMs) {
  for (const [k, exp] of _nonces) {
    if (exp <= nowMs) _nonces.delete(k);
  }
}

// ── verification ───────────────────────────────────────────────────────────
//
// Returns:
//   ok        — no fatal problems (advisory problems may still be present)
//   fatal     — reject at /register; record-only at /heartbeat
//   problems  — fatal reasons (strings)
//   advisory  — non-fatal observations (e.g. clock skew)
//   principal — the self-certifying id derived from the presented key
//   action    — 'bound' | 'verified' | 'replaced' | 'failed'
function verifyIncoming({ nodeId, identity, kind, legacyProof = false, now = _nowS() }) {
  const fatal = [];
  const advisory = [];
  let principal = null;
  let action = 'failed';

  const finish = () => {
    const store = _load();
    const rec = store.principals[nodeId];
    const at = _nowS();
    if (fatal.length) {
      if (rec) {
        rec.last_fail = { reason: fatal[0], at, kind };
        try { _save(); } catch (e) { console.error(`[IDENTITY] save failed: ${e.message}`); }
      }
      return { ok: false, fatal: true, problems: fatal, advisory, principal, action: 'failed' };
    }
    if (rec) {
      rec.last_ok_at = at;
      rec.last_ok_kind = kind;
      if (advisory.length) rec.last_advisory = { reason: advisory[0], at };
      try { _save(); } catch (e) { console.error(`[IDENTITY] save failed: ${e.message}`); }
    }
    return { ok: true, fatal: false, problems: [], advisory, principal, action };
  };

  // 1. shape of the block itself
  if (!identity || typeof identity !== 'object') {
    fatal.push('malformed identity block');
    return finish();
  }
  if (identity.algorithm !== ALGORITHM) {
    fatal.push(`unsupported algorithm ${String(identity.algorithm)}`);
    return finish();
  }
  const pubB64 = String(identity.public_key || '');
  const sigB64 = String(identity.signature || '');
  if (!B64_32.test(pubB64)) { fatal.push('public_key must be 32 raw bytes, base64'); return finish(); }
  if (!B64_64.test(sigB64)) { fatal.push('signature must be 64 raw bytes, base64'); return finish(); }
  const statement = identity.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    fatal.push('malformed statement');
    return finish();
  }

  // 2. statement claims
  if (statement.v !== 1) fatal.push(`unsupported statement version ${String(statement.v)}`);
  if (statement.kind !== kind) fatal.push(`statement kind ${String(statement.kind)} != ${kind}`);
  if (String(statement.node_id || '') !== String(nodeId)) {
    fatal.push(`statement node_id ${String(statement.node_id)} != ${nodeId}`);
  }
  if (!Number.isSafeInteger(statement.ts)) fatal.push('statement ts must be an integer (seconds)');
  if (!NONCE_RE.test(String(statement.nonce || ''))) fatal.push('statement nonce must be 16-64 hex chars');

  const raw = Buffer.from(pubB64, 'base64');
  if (raw.length !== 32) { fatal.push('public key must be 32 bytes'); return finish(); }
  try {
    principal = attest.principalIdFromRaw(raw);
  } catch (e) {
    fatal.push(`principal derivation failed: ${e.message}`);
    return finish();
  }

  // 2b. THE CRL: a revoked principal authenticates nothing — refused before
  // any binding work (never bound, never verified, never rotated-in).
  if (_isRevoked(principal)) {
    const rev = _load().revocations[principal];
    fatal.push('revoked: principal is on the CRL' +
      (rev && rev.reason ? ' (' + rev.reason + ')' : ''));
    return finish();
  }

  // 3. freshness — ADVISORY (broken clock ≠ attack), but recorded.
  if (Number.isSafeInteger(statement.ts)) {
    const skew = now - statement.ts;
    if (Math.abs(skew) > FRESHNESS_S) {
      advisory.push(`stale_ts: statement ts off by ${skew}s (window ±${FRESHNESS_S}s)`);
    }
  }

  // 4. replay — a nonce we have already ACCEPTED for this node is a literal
  //    duplicate submission: fatal regardless of ts (the CLI mints a fresh
  //    nonce per attempt, so legit retries never collide).
  const nonceKey = `${nodeId}:${statement.nonce}`;
  const nowMs = Date.now();
  _pruneNonces(nowMs);
  if (_nonces.has(nonceKey)) {
    fatal.push('replayed nonce');
    // fall through to signature check for a complete report, then finish
  }

  // 5. signature over the canonical statement — the actual proof. Runs even
  //    when a replay was already detected so the report is complete; a nonce
  //    is only CONSUMED when this is the first accepted sighting.
  let sigOk = false;
  try {
    sigOk = crypto.verify(
      null,
      Buffer.from(attest.canonicalize(statement), 'utf8'),
      attest.publicKeyFromRaw(raw),
      Buffer.from(sigB64, 'base64')
    );
  } catch (e) {
    fatal.push(`verify error: ${e.message}`);
  }
  if (fatal.length === 0 && !sigOk) fatal.push('signature mismatch');
  if (fatal.length === 0 && sigOk) _nonces.set(nonceKey, nowMs + NONCE_TTL_MS);

  // shape/claim problems already short-circuited above
  if (fatal.length) return finish();

  // 6. binding decision
  const store = _load();
  const rec = store.principals[nodeId];
  if (!rec) {
    store.principals[nodeId] = {
      node_id: nodeId,
      principal,
      public_key: pubB64,
      algorithm: ALGORITHM,
      status: 'active',
      bound_at: now,
      bound_via: kind === 'node.register' ? 'register' : 'heartbeat',
      history: [],
    };
    action = 'bound';
    try { _save(); } catch (e) { console.error(`[IDENTITY] save failed: ${e.message}`); }
  } else if (rec.public_key === pubB64) {
    action = 'verified';
  } else if (legacyProof) {
    // Rotation/recovery: the caller ALSO proved the legacy credentials
    // (node secret or hw_id) — same trust anchor authorizeClaim uses. The old
    // key goes to history as 'superseded' so historical statements made under
    // it stay attributable (attestation-contract compatibility policy).
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    rec.history.push({
      principal: rec.principal,
      public_key: rec.public_key,
      bound_at: rec.bound_at,
      superseded_at: now,
      status: 'superseded',
    });
    rec.principal = principal;
    rec.public_key = pubB64;
    rec.algorithm = ALGORITHM;
    rec.status = 'active';
    rec.bound_at = now;
    rec.bound_via = kind === 'node.register' ? 'register' : 'heartbeat';
    rec.rotated_via_legacy_proof = true;
    action = 'replaced';
    try { _save(); } catch (e) { console.error(`[IDENTITY] save failed: ${e.message}`); }
  } else {
    fatal.push('key_mismatch: node is bound to a different key (present node secret or hw_id to rotate)');
    return finish();
  }

  return finish();
}

// What the response carries back to the bee (and what GET endpoints show).
// status vocabulary the CLI reads:
//   unbound — no key yet (first identity-bearing request will bind)
//   bound|verified|replaced — hub accepts this bee's key
//   failed — presented block did not verify (reason in `reason`)
//   mismatch — hub holds a DIFFERENT key for this node (CLI rebinds)
function publicSummary(nodeId, idv = null) {
  const store = _load();
  const rec = store.principals[nodeId];
  if (!rec) return { status: 'unbound' };
  const base = {
    principal: rec.principal,
    algorithm: rec.algorithm || ALGORITHM,
    bound_at: rec.bound_at || null,
    bound_via: rec.bound_via || null,
    status: rec.status || 'active',
  };
  if (rec.last_ok_at) base.last_ok_at = rec.last_ok_at;
  if (!idv) return base;
  if (idv.ok) {
    base.status = idv.action;
    if (idv.advisory && idv.advisory.length) base.advisory = idv.advisory;
    return base;
  }
  const problems = idv.problems || [];
  const isMismatch = problems.some((p) => p.startsWith('key_mismatch'));
  const isRevoked = problems.some((p) => p.startsWith('revoked:'));
  base.status = isRevoked ? 'revoked' : (isMismatch ? 'mismatch' : 'failed');
  base.reason = problems[0] || 'verification failed';
  base.hub_principal = rec.principal;
  if (isRevoked) {
    base.hint = 'this key is on the CRL — the agent mints a fresh key and rebinds with legacy proof';
  } else if (isMismatch) {
    base.hint = 'run `hivv identity status` — the agent rebinds automatically with legacy proof';
  }
  return base;
}

// ── the HUB's identity key (route receipts, Phase 6) ───────────────────────
// One Ed25519 key for the hub's own assertions about ROUTING: "hivv attests
// this response was answered by node X model Y via Z [over body A]". The
// private half lives next to the store (0600, env-overridable), the public
// half is published at GET /api/identity/hub-key so anyone can verify an
// X-Hivv-Receipt header offline. Distinct from the scanner's attestation key
// (api/.keys/scan-key) — different purposes, different principals.
const HUB_KEY_PATH = process.env.HIVV_IDENTITY_HUB_KEY ||
  path.join(__dirname, '..', '.keys', 'identity-key');
let _hubKey = null;

function hubSigningKey() {
  if (_hubKey) return _hubKey;
  try {
    let seed = null;
    try {
      const raw = fs.readFileSync(HUB_KEY_PATH, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(raw)) seed = Buffer.from(raw, 'hex');
    } catch (_e) { /* generate below */ }
    if (!seed) {
      seed = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(HUB_KEY_PATH), { recursive: true });
      fs.writeFileSync(HUB_KEY_PATH, seed.toString('hex') + '\n', { mode: 0o600 });
      fs.chmodSync(HUB_KEY_PATH, 0o600);
    }
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der', type: 'pkcs8',
    });
    // The public key must be DERIVED from the private key — an Ed25519 SPKI
    // structure holds the public POINT, not the seed (sticking the seed in
    // produces a structurally valid but cryptographically unrelated key:
    // sign/verify then disagree — found the hard way, 2026-11-25).
    const rawPublicKey = attest.rawFromPublicKey(crypto.createPublicKey(privateKey));
    _hubKey = { privateKey, rawPublicKey, principal: attest.principalIdFromRaw(rawPublicKey) };
    return _hubKey;
  } catch (e) {
    console.error('[IDENTITY] hub key unavailable: ' + e.message);
    return null;
  }
}

function hubKeyInfo() {
  const k = hubSigningKey();
  if (!k) return null;
  return {
    principal: k.principal,
    public_key: k.rawPublicKey.toString('base64'),
    algorithm: ALGORITHM,
    schema: 'hivv.identity.route-receipt.v1',
  };
}

// Build + sign a route receipt. answer_sha256 is included ONLY when the
// full answer body is known at header time (non-streaming paths) — a
// streaming response signs attribution only, and says so by omission.
function routeReceipt({ answeredBy, transport, answerSha256 = null,
                        durationMs = null, horizon = null, now = _nowS() }) {
  const k = hubSigningKey();
  if (!k) return null;
  const statement = {
    v: 1,
    kind: 'route.receipt',
    ts: now,
    nonce: crypto.randomBytes(8).toString('hex'),
    answered_by: String(answeredBy || '').slice(0, 200),
    transport: ['direct', 'relay', 'cloud', 'local', 'hub'].includes(String(transport))
      ? String(transport) : 'direct',
    // The physical-horizon verdict — SIGNED, so the warning cannot be
    // stripped by anything between us and the reader.
    ...(horizon && horizon.status
      ? { horizon: horizon.status,
          horizon_reason: String(horizon.reason || '').slice(0, 160) }
      : {}),
  };
  if (answerSha256 && /^[0-9a-f]{64}$/.test(String(answerSha256))) {
    statement.answer_sha256 = String(answerSha256);
  }
  if (Number.isSafeInteger(durationMs) && durationMs >= 0) {
    statement.duration_ms = durationMs;
  }
  try {
    const signature = crypto.sign(
      null, Buffer.from(attest.canonicalize(statement), 'utf8'), k.privateKey
    ).toString('base64');
    return { statement, signature, public_key: k.rawPublicKey.toString('base64') };
  } catch (e) {
    console.error('[IDENTITY] receipt sign failed: ' + e.message);
    return null;
  }
}

// The X-Hivv-Receipt header value: base64 of the receipt JSON. Set it
// INSIDE a try/catch at every site — a receipt must never break a response.
function routeReceiptHeader(opts) {
  try {
    const r = routeReceipt(opts);
    return r ? Buffer.from(JSON.stringify(r), 'utf8').toString('base64') : null;
  } catch (_e) {
    return null;
  }
}

// ── nonce cache (shared) ────────────────────────────────────────────────────
// Keyed WITH the statement kind: an identity nonce and a manifest nonce are
// different statements and must not collide into a false replay.
function _nonceKey(nodeId, kind, nonce) {
  return nodeId + ':' + kind + ':' + nonce;
}

function _consumeNonce(nodeId, statement, nowMs) {
  _pruneNonces(nowMs);
  const key = _nonceKey(nodeId, String(statement.kind || ''), String(statement.nonce || ''));
  if (_nonces.has(key)) return false;
  _nonces.set(key, nowMs + NONCE_TTL_MS);
  return true;
}

// ── capability manifests (Phase 2) ──────────────────────────────────────────
// tools / local_models / capabilities were SELF-REPORTED with zero
// verification. A manifest is the bee signing its own advertisement with its
// BOUND key — the signed values become the source of truth (the hub
// overwrites the unsigned body fields with them), and a monotonic `seq`
// makes replay/reordering detectable. Advisory at heartbeat like everything
// else: a failing manifest is RECORDED, never grounds to reject the bee.
const MANIFEST_LIST_CAP = 64;
const MANIFEST_STR_CAP = 200;

function _strList(value, cap = MANIFEST_LIST_CAP) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, cap).map((v) => String(v).slice(0, MANIFEST_STR_CAP));
}

function verifyManifest({ nodeId, manifest, now = _nowS() }) {
  const fatal = [];
  const advisory = [];
  const fail = (problems) => ({ ok: false, problems, advisory, action: 'failed' });

  if (!manifest || typeof manifest !== 'object') return fail(['malformed manifest block']);
  const rec = _load().principals[nodeId];
  if (!rec) return fail(['no identity binding — a manifest must come from a bound bee']);

  const statement = manifest.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    return fail(['malformed manifest statement']);
  }
  if (String(manifest.public_key || '') !== rec.public_key) {
    return fail(['signer is not the bound key for this node']);
  }
  if (_isRevoked(rec.principal)) return fail(['revoked: bound principal is on the CRL']);
  if (statement.v !== 1) fatal.push('unsupported manifest version ' + String(statement.v));
  if (statement.kind !== 'capability.manifest') fatal.push('wrong kind ' + String(statement.kind));
  if (String(statement.node_id || '') !== nodeId) fatal.push('statement node_id mismatch');
  if (!Number.isSafeInteger(statement.ts)) fatal.push('statement ts must be an integer');
  if (!Number.isSafeInteger(statement.seq) || statement.seq < 0) {
    fatal.push('statement seq must be a non-negative integer');
  }
  if (!NONCE_RE.test(String(statement.nonce || ''))) fatal.push('bad nonce');

  if (Number.isSafeInteger(statement.ts) && Math.abs(now - statement.ts) > FRESHNESS_S) {
    advisory.push('stale_ts: manifest ts off by ' + (now - statement.ts) + 's');
  }
  // monotonic seq: a replayed or reordered manifest carries a seq we have
  // already accepted — fatal (this is the anti-replay for advertisements).
  const lastSeq = Number.isSafeInteger(rec.cap_seq) ? rec.cap_seq : -1;
  if (!fatal.length && Number.isSafeInteger(statement.seq) && statement.seq <= lastSeq) {
    fatal.push('stale seq ' + statement.seq + ' (last accepted ' + lastSeq + ')');
  }

  let sigOk = false;
  try {
    sigOk = crypto.verify(
      null,
      Buffer.from(attest.canonicalize(statement), 'utf8'),
      attest.publicKeyFromRaw(Buffer.from(String(manifest.public_key), 'base64')),
      Buffer.from(String(manifest.signature || ''), 'base64')
    );
  } catch (e) {
    fatal.push('verify error: ' + e.message);
  }
  if (!fatal.length && !sigOk) fatal.push('signature mismatch');
  if (fatal.length) return fail(fatal);

  const nowMs = Date.now();
  if (!_consumeNonce(nodeId, statement, nowMs)) return fail(['replayed nonce']);

  // accepted — the SIGNED values are the ones the hub keeps
  const tools = _strList(statement.tools) || [];
  const localModels = Array.isArray(statement.local_models)
    ? statement.local_models.slice(0, MANIFEST_LIST_CAP) : [];
  const capabilities = _strList(statement.capabilities) || [];
  rec.cap_seq = statement.seq;
  rec.manifest = {
    seq: statement.seq,
    tools,
    tools_port: Number.isSafeInteger(statement.tools_port) ? statement.tools_port : 0,
    local_models: localModels,
    capabilities,
    volunteer: statement.volunteer === true,
    verified_at: now,
    principal: rec.principal,
  };
  rec.last_ok_at = now;
  rec.last_ok_kind = 'capability.manifest';
  try { _save(); } catch (e) { console.error('[IDENTITY] save failed: ' + e.message); }

  return {
    ok: true,
    problems: [],
    advisory,
    action: 'verified',
    statement,
    applied: { tools: rec.manifest.tools, tools_port: rec.manifest.tools_port,
               local_models: rec.manifest.local_models,
               capabilities: rec.manifest.capabilities, volunteer: rec.manifest.volunteer },
  };
}

// ── rotation statements (Phase 2) ───────────────────────────────────────────
// The CURRENT bound key signs a statement naming its successor — rotation
// with NO legacy proof needed (hw_id/secret remain the recovery path for a
// bee that lost its key entirely). Freshness is FATAL here (unlike ordinary
// statements): a stale rotation replayed after a restart must never roll a
// node back to an old key; rotations are interactive, so a broken clock
// simply falls back to the legacy-proof rebind.
function verifyRotation({ nodeId, rotation, now = _nowS() }) {
  const fatal = [];
  const fail = (problems) => ({ ok: false, problems, action: 'failed' });

  if (!rotation || typeof rotation !== 'object') return fail(['malformed rotation block']);
  const store = _load();
  const rec = store.principals[nodeId];
  if (!rec) return fail(['no identity binding — nothing to rotate']);

  const statement = rotation.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    return fail(['malformed rotation statement']);
  }
  if (String(rotation.public_key || '') !== rec.public_key) {
    return fail(['rotation must be signed by the CURRENT bound key']);
  }
  if (_isRevoked(rec.principal)) return fail(['revoked: bound principal is on the CRL']);
  if (statement.v !== 1) fatal.push('unsupported rotation version ' + String(statement.v));
  if (statement.kind !== 'identity.rotate') fatal.push('wrong kind ' + String(statement.kind));
  if (String(statement.node_id || '') !== nodeId) fatal.push('statement node_id mismatch');
  if (!Number.isSafeInteger(statement.ts)) fatal.push('statement ts must be an integer');
  if (!NONCE_RE.test(String(statement.nonce || ''))) fatal.push('bad nonce');
  if (Math.abs(now - (Number.isSafeInteger(statement.ts) ? statement.ts : 0)) > FRESHNESS_S) {
    fatal.push('stale rotation (outside ±' + FRESHNESS_S + 's) — rotations must be fresh');
  }
  const newB64 = String(statement.new_public_key || '');
  if (!B64_32.test(newB64)) fatal.push('new_public_key must be 32 raw bytes, base64');
  else if (newB64 === rec.public_key) fatal.push('new key equals the current key');

  let sigOk = false;
  if (!fatal.length) {
    try {
      sigOk = crypto.verify(
        null,
        Buffer.from(attest.canonicalize(statement), 'utf8'),
        attest.publicKeyFromRaw(Buffer.from(String(rotation.public_key), 'base64')),
        Buffer.from(String(rotation.signature || ''), 'base64')
      );
    } catch (e) {
      fatal.push('verify error: ' + e.message);
    }
    if (!sigOk) fatal.push('signature mismatch');
  }
  if (fatal.length) return fail(fatal);

  const nowMs = Date.now();
  if (!_consumeNonce(nodeId, statement, nowMs)) return fail(['replayed nonce']);

  const newRaw = Buffer.from(newB64, 'base64');
  const newPrincipal = attest.principalIdFromRaw(newRaw);
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push({
    principal: rec.principal,
    public_key: rec.public_key,
    bound_at: rec.bound_at,
    superseded_at: now,
    status: 'superseded',
    rotated_via: 'rotation_statement',
  });
  rec.principal = newPrincipal;
  rec.public_key = newB64;
  rec.status = 'active';
  rec.bound_at = now;
  rec.bound_via = 'rotation';
  rec.last_ok_at = now;
  rec.last_ok_kind = 'identity.rotate';
  try { _save(); } catch (e) { console.error('[IDENTITY] save failed: ' + e.message); }

  return { ok: true, problems: [], action: 'rotated', principal: newPrincipal };
}

// ── execution receipts (Phase 3) ────────────────────────────────────────────
// The bee's SIGNED testimony that it executed something: "I, bound key of
// node X, ran <op> at <ts> with result <ok>, over output <sha256>." The
// hub verifies against the bound key and keeps a bounded ring per node —
// this is the non-repudiation layer repair/selftest/job outcomes never had.
const RECEIPT_RING = 32;
const RESULT_VALUES = ['ok', 'failed'];

function verifyReceipt({ nodeId, receipt, now = _nowS() }) {
  const fatal = [];
  const fail = (problems) => ({ ok: false, problems, action: 'failed' });

  if (!receipt || typeof receipt !== 'object') return fail(['malformed receipt block']);
  const store = _load();
  const rec = store.principals[nodeId];
  if (!rec) return fail(['no identity binding — receipts come from a bound bee']);
  if (String(receipt.public_key || '') !== rec.public_key) {
    return fail(['signer is not the bound key for this node']);
  }
  if (_isRevoked(rec.principal)) return fail(['revoked: bound principal is on the CRL']);

  const statement = receipt.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    return fail(['malformed receipt statement']);
  }
  if (statement.v !== 1) fatal.push('unsupported receipt version ' + String(statement.v));
  if (statement.kind !== 'execution.receipt') fatal.push('wrong kind ' + String(statement.kind));
  if (String(statement.node_id || '') !== nodeId) fatal.push('statement node_id mismatch');
  if (!Number.isSafeInteger(statement.ts)) fatal.push('statement ts must be an integer');
  if (!NONCE_RE.test(String(statement.nonce || ''))) fatal.push('bad nonce');
  if (!/^[0-9a-f]{16,64}$/.test(String(statement.receipt_id || ''))) {
    fatal.push('receipt_id must be 16-64 hex chars');
  }
  if (!statement.op || typeof statement.op !== 'string' || statement.op.length > 100) {
    fatal.push('receipt op must be a string (≤100 chars)');
  }
  if (!RESULT_VALUES.includes(statement.result)) {
    fatal.push('receipt result must be one of ' + RESULT_VALUES.join('|'));
  }
  if (statement.output_sha256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(String(statement.output_sha256))) {
    fatal.push('output_sha256 must be 64 hex chars');
  }
  if (statement.duration_ms !== undefined &&
      (!Number.isSafeInteger(statement.duration_ms) || statement.duration_ms < 0)) {
    fatal.push('duration_ms must be a non-negative integer');
  }
  // receipts may ride the NEXT heartbeat after a long repair — advisory skew
  if (Number.isSafeInteger(statement.ts) && Math.abs(now - statement.ts) > FRESHNESS_S) {
    // still fatal beyond a generous bound: evidence older than a day is stale
    if (Math.abs(now - statement.ts) > 86400) {
      fatal.push('receipt older than 24h — refusing as stale');
    }
  }

  let sigOk = false;
  if (!fatal.length) {
    try {
      sigOk = crypto.verify(
        null,
        Buffer.from(attest.canonicalize(statement), 'utf8'),
        attest.publicKeyFromRaw(Buffer.from(String(receipt.public_key), 'base64')),
        Buffer.from(String(receipt.signature || ''), 'base64')
      );
    } catch (e) {
      fatal.push('verify error: ' + e.message);
    }
    if (!sigOk) fatal.push('signature mismatch');
  }
  if (fatal.length) return fail(fatal);

  const nowMs = Date.now();
  if (!_consumeNonce(nodeId, statement, nowMs)) return fail(['replayed nonce']);

  rec.receipts = Array.isArray(rec.receipts) ? rec.receipts : [];
  if (rec.receipts.some((r) => r.receipt_id === statement.receipt_id)) {
    return fail(['duplicate receipt ' + statement.receipt_id]);
  }
  const stored = {
    receipt_id: statement.receipt_id,
    op: statement.op,
    result: statement.result,
    ts: statement.ts,
    verified_at: now,
    ...(statement.job_id ? { job_id: String(statement.job_id).slice(0, 64) } : {}),
    ...(statement.output_sha256 ? { output_sha256: String(statement.output_sha256) } : {}),
    ...(Number.isSafeInteger(statement.duration_ms) ? { duration_ms: statement.duration_ms } : {}),
  };
  rec.receipts.push(stored);
  if (rec.receipts.length > RECEIPT_RING) rec.receipts.splice(0, rec.receipts.length - RECEIPT_RING);
  rec.last_ok_at = now;
  rec.last_ok_kind = 'execution.receipt';
  try { _save(); } catch (e) { console.error('[IDENTITY] save failed: ' + e.message); }

  return { ok: true, problems: [], action: 'recorded', receipt: stored };
}

function listReceipts(nodeId, limit = 32) {
  const rec = getRecord(nodeId);
  if (!rec || !Array.isArray(rec.receipts)) return [];
  return rec.receipts.slice(-Math.max(1, Math.min(limit, RECEIPT_RING))).reverse();
}

// ── revocation (Phase 4) ────────────────────────────────────────────────────
// The CRL: a revoked principal can no longer authenticate ANYTHING — its
// statements are refused at every verifier (register/heartbeat/manifest/
// rotation/receipt), while the legitimate bee recovers by rotating to a
// fresh key with legacy proof (secret + hw_id). Revocation is key-level:
// removing a bee entirely stays quarantine/delete's job.
const REVOCATION_REASON_CAP = 200;

function _isRevoked(principal) {
  const store = _load();
  return !!(principal && store.revocations && store.revocations[principal]);
}

function _recordRevocation(principal, { nodeId, reason, by, now }) {
  const store = _load();
  store.revocations = store.revocations || {};
  store.revocations[principal] = {
    principal,
    node_id: nodeId || null,
    reason: String(reason || '').slice(0, REVOCATION_REASON_CAP),
    by: by === 'self' ? 'self' : 'operator',
    revoked_at: now,
  };
  const rec = store.principals[nodeId];
  if (rec && rec.principal === principal) rec.status = 'revoked';
  try { _save(); } catch (e) { console.error('[IDENTITY] save failed: ' + e.message); }
}

// Self-revocation: the BOUND key signs a statement revoking ITSELF —
// holding the key is the proof. Freshness is FATAL (interactive), nonce
// replay-protected.
function verifySelfRevocation({ nodeId, revocation, now = _nowS() }) {
  const fatal = [];
  const fail = (problems) => ({ ok: false, problems, action: 'failed' });

  if (!revocation || typeof revocation !== 'object') return fail(['malformed revocation block']);
  const rec = _load().principals[nodeId];
  if (!rec) return fail(['no identity binding — nothing to revoke']);

  const statement = revocation.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    return fail(['malformed revocation statement']);
  }
  if (String(revocation.public_key || '') !== rec.public_key) {
    return fail(['revocation must be signed by the CURRENT bound key']);
  }
  if (statement.v !== 1) fatal.push('unsupported revocation version ' + String(statement.v));
  if (statement.kind !== 'identity.revoke') fatal.push('wrong kind ' + String(statement.kind));
  if (String(statement.node_id || '') !== nodeId) fatal.push('statement node_id mismatch');
  if (!Number.isSafeInteger(statement.ts)) fatal.push('statement ts must be an integer');
  if (!NONCE_RE.test(String(statement.nonce || ''))) fatal.push('bad nonce');
  if (Math.abs(now - (Number.isSafeInteger(statement.ts) ? statement.ts : 0)) > FRESHNESS_S) {
    fatal.push('stale revocation (outside ±' + FRESHNESS_S + 's) — revocations must be fresh');
  }
  if (!statement.reason || typeof statement.reason !== 'string' ||
      statement.reason.length > REVOCATION_REASON_CAP) {
    fatal.push('revocation reason must be a string (≤' + REVOCATION_REASON_CAP + ' chars)');
  }
  // SELF only: the statement must revoke the key that signed it
  const raw = Buffer.from(String(revocation.public_key || ''), 'base64');
  if (raw.length === 32 && statement.principal !== undefined &&
      statement.principal !== attest.principalIdFromRaw(raw)) {
    fatal.push('statement.principal must equal the signing key (self-revocation only)');
  }

  let sigOk = false;
  if (!fatal.length) {
    try {
      sigOk = crypto.verify(
        null,
        Buffer.from(attest.canonicalize(statement), 'utf8'),
        attest.publicKeyFromRaw(raw),
        Buffer.from(String(revocation.signature || ''), 'base64')
      );
    } catch (err) {
      fatal.push('verify error: ' + err.message);
    }
    if (!sigOk) fatal.push('signature mismatch');
  }
  if (fatal.length) return fail(fatal);

  const nowMs = Date.now();
  if (!_consumeNonce(nodeId, statement, nowMs)) return fail(['replayed nonce']);

  const principal = attest.principalIdFromRaw(raw);
  _recordRevocation(principal, { nodeId, reason: statement.reason, by: 'self', now });
  return { ok: true, problems: [], action: 'revoked', principal, reason: statement.reason };
}

// Operator/admin revocation: no signature — the CALLER's authority is the
// control token or loopback (same anchor requireControlAuth uses). The
// target principal must be KNOWN (bound to this node or in history) so an
// anonymous caller cannot scribble arbitrary entries into the CRL.
function revokeByOperator({ nodeId, principal, reason, now = _nowS() }) {
  const store = _load();
  const rec = nodeId ? store.principals[nodeId] : null;
  const known = (rec && (rec.principal === principal ||
      (Array.isArray(rec.history) && rec.history.some((h) => h.principal === principal)))) ||
      _isRevoked(principal);
  if (!known) {
    return { ok: false, problems: ['principal not known for this node — nothing to revoke'] };
  }
  _recordRevocation(principal, { nodeId, reason, by: 'operator', now });
  return { ok: true, problems: [], action: 'revoked', principal };
}

function listRevocations() {
  const store = _load();
  return Object.values(store.revocations || {}).sort((a, b) => b.revoked_at - a.revoked_at);
}

// ── operator endorsements (Phase 4) ─────────────────────────────────────────
// An operator (a person/org with their OWN key, distinct from any bee)
// signs "node X is mine, role R". Web-of-trust: verifiable, opt-in, and
// the hub checks self-consistency (operator_principal derives from the
// signing key) plus node binding consistency when known.
const ENDORSEMENT_CAP = 512;
const ROLE_CAP = 32;

function verifyEndorsement({ endorsement, now = _nowS() }) {
  const fatal = [];
  const fail = (problems) => ({ ok: false, problems, action: 'failed' });

  if (!endorsement || typeof endorsement !== 'object') return fail(['malformed endorsement block']);
  const statement = endorsement.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    return fail(['malformed endorsement statement']);
  }
  const pubB64 = String(endorsement.public_key || '');
  if (!B64_32.test(pubB64)) return fail(['public_key must be 32 raw bytes, base64']);
  const raw = Buffer.from(pubB64, 'base64');
  const principal = attest.principalIdFromRaw(raw);

  if (statement.v !== 1) fatal.push('unsupported endorsement version ' + String(statement.v));
  if (statement.kind !== 'operator.endorse') fatal.push('wrong kind ' + String(statement.kind));
  if (statement.operator_principal !== principal) {
    fatal.push('operator_principal does not derive from the signing key');
  }
  if (!statement.node_id || typeof statement.node_id !== 'string') {
    fatal.push('endorsement needs a node_id');
  }
  if (!statement.role || typeof statement.role !== 'string' || statement.role.length > ROLE_CAP) {
    fatal.push('endorsement role must be a string (≤' + ROLE_CAP + ' chars)');
  }
  if (!Number.isSafeInteger(statement.ts)) fatal.push('statement ts must be an integer');
  if (!NONCE_RE.test(String(statement.nonce || ''))) fatal.push('bad nonce');
  if (statement.node_principal !== undefined &&
      !PRINCIPAL_PATTERN.test(String(statement.node_principal))) {
    fatal.push('node_principal must be a hivv_ principal');
  }
  // endorsements are long-lived: only refuse absurd clock skew
  if (Number.isSafeInteger(statement.ts) && Math.abs(now - statement.ts) > 86400) {
    fatal.push('endorsement older than 24h — refusing as stale');
  }

  let sigOk = false;
  if (!fatal.length) {
    try {
      sigOk = crypto.verify(
        null,
        Buffer.from(attest.canonicalize(statement), 'utf8'),
        attest.publicKeyFromRaw(raw),
        Buffer.from(String(endorsement.signature || ''), 'base64')
      );
    } catch (err) {
      fatal.push('verify error: ' + err.message);
    }
    if (!sigOk) fatal.push('signature mismatch');
  }
  if (fatal.length) return fail(fatal);

  const nowMs = Date.now();
  if (!_consumeNonce(statement.node_id, statement, nowMs)) return fail(['replayed nonce']);

  // if the hub knows this node, the endorsed principal must be ITS key
  const store = _load();
  const rec = store.principals[String(statement.node_id).toLowerCase()];
  if (rec && statement.node_principal && statement.node_principal !== rec.principal) {
    return { ok: false, problems: ['node_principal ' + statement.node_principal +
      ' does not match the bound principal ' + rec.principal] };
  }

  store.endorsements = Array.isArray(store.endorsements) ? store.endorsements : [];
  const key = (e) => e.operator_principal + '|' + e.node_id + '|' + e.role;
  const entry = {
    operator_principal: principal,
    node_id: String(statement.node_id).toLowerCase(),
    node_principal: statement.node_principal || (rec ? rec.principal : null),
    role: String(statement.role),
    statement_ts: statement.ts,
    verified_at: now,
  };
  const idx = store.endorsements.findIndex((e) => key(e) === key(entry));
  if (idx >= 0) store.endorsements[idx] = entry;
  else {
    store.endorsements.push(entry);
    if (store.endorsements.length > ENDORSEMENT_CAP) {
      store.endorsements.splice(0, store.endorsements.length - ENDORSEMENT_CAP);
    }
  }
  try { _save(); } catch (e) { console.error('[IDENTITY] save failed: ' + e.message); }
  return { ok: true, problems: [], action: idx >= 0 ? 'updated' : 'endorsed', entry };
}

function listEndorsements(nodeId = null) {
  const store = _load();
  const all = Array.isArray(store.endorsements) ? store.endorsements : [];
  return nodeId ? all.filter((e) => e.node_id === nodeId) : all.slice();
}

function getRecord(nodeId) {
  const store = _load();
  return store.principals[nodeId] || null;
}

function listIdentities() {
  const store = _load();
  return Object.values(store.principals).map((r) => ({
    node_id: r.node_id,
    principal: r.principal,
    status: r.status || 'active',
    algorithm: r.algorithm || ALGORITHM,
    bound_at: r.bound_at || null,
    bound_via: r.bound_via || null,
    last_ok_at: r.last_ok_at || null,
    last_fail: r.last_fail || null,
    rotations: Array.isArray(r.history) ? r.history.length : 0,
  }));
}

// Standalone verification for third parties (POST /api/identity/verify):
// checks a statement+signature against a KNOWN principal's key without any
// binding side effects — pure crypto, no store mutation, no nonce consumption.
function verifyStandalone({ statement, signature, public_key: pubB64, principal: claimed }) {
  const problems = [];
  if (!statement || typeof statement !== 'object') return { ok: false, problems: ['malformed statement'] };
  if (!B64_32.test(String(pubB64 || ''))) problems.push('public_key must be 32 raw bytes, base64');
  if (!B64_64.test(String(signature || ''))) problems.push('signature must be 64 raw bytes, base64');
  if (problems.length) return { ok: false, problems };

  const raw = Buffer.from(pubB64, 'base64');
  const principal = attest.principalIdFromRaw(raw);
  if (claimed && claimed !== principal) {
    problems.push(`claimed principal ${claimed} does not derive from public key (${principal})`);
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify(
      null,
      Buffer.from(attest.canonicalize(statement), 'utf8'),
      attest.publicKeyFromRaw(raw),
      Buffer.from(signature, 'base64')
    );
  } catch (e) {
    problems.push(`verify error: ${e.message}`);
  }
  if (!sigOk) problems.push('signature mismatch');
  return problems.length ? { ok: false, problems, principal } : { ok: true, problems: [], principal };
}

// ── enforcement (opt-in) ────────────────────────────────────────────────────
// Dual-mode stays the DEFAULT: advisory. An operator who is ready to demand
// signed registration sets HIVV_IDENTITY_ENFORCE=1 — then register AND
// heartbeat REQUIRE an identity block (403 IDENTITY_REQUIRED with an
// actionable hint). Read per-request so a config reload flips it live.
function enforcementRequired(env = process.env) {
  return String(env.HIVV_IDENTITY_ENFORCE || '') === '1';
}

// Test seam: forget the in-memory cache (the file remains).
function _resetForTests() {
  _cache = null;
  _nonces.clear();
}

module.exports = {
  IDENTITY_FILE,
  FRESHNESS_S,
  ALGORITHM,
  verifyIncoming,
  verifyStandalone,
  verifyManifest,
  verifyRotation,
  verifyReceipt,
  listReceipts,
  verifySelfRevocation,
  revokeByOperator,
  listRevocations,
  verifyEndorsement,
  listEndorsements,
  hubSigningKey,
  hubKeyInfo,
  routeReceipt,
  routeReceiptHeader,
  enforcementRequired,
  publicSummary,
  getRecord,
  listIdentities,
  _resetForTests,
};
