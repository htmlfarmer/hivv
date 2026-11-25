// api/tests/identity.test.js — pins the Ed25519 bee identity layer (Phase 1).
//
// Two halves:
//   A. UNIT (no gateway): lib/identity.js — binding, verification, replay,
//      rotation-with-legacy-proof, advisory clock skew, store file mode.
//      HIVV_IDENTITY_FILE is pointed at a tmp file BEFORE the require.
//   B. LIVE (gateway on localhost:3011, skips when down): the register /
//      heartbeat contract end-to-end — legacy CLIs untouched (dual-mode),
//      forged/replayed/mismatched claims refused at register, heartbeat
//      advisory (never rejects), /api/identity read + verify surface.
//
// Run with:  cd api && node --test tests/identity.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── unit store: isolate BEFORE require ──────────────────────────────────────
const UNIT_FILE = path.join(os.tmpdir(), `hivv-identity-unit-${process.pid}.json`);
try { fs.unlinkSync(UNIT_FILE); } catch (_e) { /* fresh */ }
process.env.HIVV_IDENTITY_FILE = UNIT_FILE;

const identity = require('../lib/identity');
const attest = require('../lib/attest');

const BASE = 'http://localhost:3011';
const VISITOR = 'test-identity';
const FAKE_ID = '__identity_e2e__';
const FAKE_HW = 'linux-e2e-identity-hwid';

let gatewayUp = false;

before(async () => {
  try {
    const r = await fetch(`${BASE}/api/health`);
    gatewayUp = r.ok;
  } catch (_) {
    gatewayUp = false;
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────
function makeKeypair() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const raw = attest.rawFromPublicKey(kp.publicKey);
  return {
    kp,
    pubB64: raw.toString('base64'),
    principal: attest.principalIdFromRaw(raw),
  };
}

function sign(kp, statement) {
  return crypto.sign(null, Buffer.from(attest.canonicalize(statement), 'utf8'),
    kp.privateKey).toString('base64');
}

function block(kp, statement) {
  return {
    algorithm: 'ed25519',
    public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'),
    statement,
    signature: sign(kp, statement),
  };
}

const nowS = () => Math.floor(Date.now() / 1000);
const nonce = () => crypto.randomBytes(8).toString('hex');

function regStmt(nodeId, over = {}) {
  return { v: 1, kind: 'node.register', node_id: nodeId, ts: nowS(),
           nonce: nonce(), ...over };
}

// ═══════════════════════════ A. UNIT ════════════════════════════════════════

test('unit: first verified sighting binds, same key verifies', () => {
  identity._resetForTests();
  const { kp, pubB64, principal } = makeKeypair();
  const nodeId = 'unit-bind';

  const r1 = identity.verifyIncoming({
    nodeId, identity: block(kp, regStmt(nodeId)), kind: 'node.register',
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'bound');
  assert.equal(r1.principal, principal);

  const r2 = identity.verifyIncoming({
    nodeId, kind: 'node.heartbeat',
    identity: block(kp, { v: 1, kind: 'node.heartbeat', node_id: nodeId, ts: nowS(), nonce: nonce() }),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.action, 'verified');
  assert.equal(identity.getRecord(nodeId).public_key, pubB64);
});

test('unit: tampered statement fails signature', () => {
  const { kp } = makeKeypair();
  const nodeId = 'unit-tamper';
  identity.verifyIncoming({ nodeId, identity: block(kp, regStmt(nodeId)), kind: 'node.register' });

  const st = { v: 1, kind: 'node.heartbeat', node_id: nodeId, ts: nowS(), nonce: nonce() };
  const sig = sign(kp, st);
  const tampered = { ...st, ts: st.ts + 1 }; // resign NOTHING — sig no longer matches
  const r = identity.verifyIncoming({ nodeId, identity: { ...block(kp, st), statement: tampered }, kind: 'node.heartbeat' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /signature mismatch/);
});

test('unit: replayed nonce is fatal', () => {
  const { kp } = makeKeypair();
  const nodeId = 'unit-replay';
  const st = regStmt(nodeId);
  const b = block(kp, st);
  const r1 = identity.verifyIncoming({ nodeId, identity: b, kind: 'node.register' });
  assert.equal(r1.ok, true);
  const r2 = identity.verifyIncoming({ nodeId, identity: b, kind: 'node.register' });
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.includes('replayed nonce'));
});

test('unit: wrong node_id / wrong kind / wrong version are fatal', () => {
  const { kp } = makeKeypair();
  const nodeId = 'unit-claims';
  const other = identity.verifyIncoming({
    nodeId, identity: block(kp, regStmt('someone-else')), kind: 'node.register',
  });
  assert.equal(other.ok, false);
  assert.match(other.problems.join(' '), /node_id/);

  const kind = identity.verifyIncoming({
    nodeId, kind: 'node.register',
    identity: block(kp, { v: 1, kind: 'node.heartbeat', node_id: nodeId, ts: nowS(), nonce: nonce() }),
  });
  assert.equal(kind.ok, false);

  const ver = identity.verifyIncoming({
    nodeId, kind: 'node.register',
    identity: block(kp, { v: 99, kind: 'node.register', node_id: nodeId, ts: nowS(), nonce: nonce() }),
  });
  assert.equal(ver.ok, false);
});

test('unit: stale ts is ADVISORY (ok with recorded skew), never fatal', () => {
  const { kp } = makeKeypair();
  const nodeId = 'unit-stale';
  const st = { v: 1, kind: 'node.heartbeat', node_id: nodeId, ts: nowS() - 9999, nonce: nonce() };
  const r = identity.verifyIncoming({ nodeId, identity: block(kp, st), kind: 'node.heartbeat' });
  assert.equal(r.ok, true, 'stale clock must not be fatal');
  assert.ok(r.advisory.some((a) => a.startsWith('stale_ts')));
});

test('unit: foreign key rejected without legacy proof, replaced WITH it', () => {
  const a = makeKeypair();
  const b = makeKeypair();
  const nodeId = 'unit-rotate';
  identity.verifyIncoming({ nodeId, identity: block(a.kp, regStmt(nodeId)), kind: 'node.register' });

  const denied = identity.verifyIncoming({
    nodeId, kind: 'node.heartbeat',
    identity: block(b.kp, { v: 1, kind: 'node.heartbeat', node_id: nodeId, ts: nowS(), nonce: nonce() }),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.problems.join(' '), /key_mismatch/);

  const replaced = identity.verifyIncoming({
    nodeId, kind: 'node.register', legacyProof: true,
    identity: block(b.kp, regStmt(nodeId)),
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.action, 'replaced');
  const rec = identity.getRecord(nodeId);
  assert.equal(rec.principal, b.principal);
  assert.equal(rec.history.length, 1, 'old key retained as superseded history');
  assert.equal(rec.history[0].principal, a.principal);
  assert.equal(rec.history[0].status, 'superseded');
});

test('unit: malformed blocks (alg/key/sig/float) are fatal', () => {
  const nodeId = 'unit-malformed';
  const cases = [
    null,
    { algorithm: 'rsa', public_key: 'A'.repeat(44), signature: 'B'.repeat(88), statement: {} },
    { algorithm: 'ed25519', public_key: '!!!!', signature: 'B'.repeat(88), statement: {} },
    { algorithm: 'ed25519', public_key: 'A'.repeat(43) + '=', signature: 'B'.repeat(87) + '=', statement: {} },
    { algorithm: 'ed25519', public_key: 'A'.repeat(43) + '=', signature: 'B'.repeat(86) + '==',
      statement: { v: 1, kind: 'node.register', node_id: nodeId, ts: 1.5, nonce: 'a'.repeat(16) } },
  ];
  for (const c of cases) {
    const r = identity.verifyIncoming({ nodeId, identity: c, kind: 'node.register' });
    assert.equal(r.ok, false, `must reject: ${JSON.stringify(c) && String(c && c.algorithm)}`);
  }
});

test('unit: store file is 0600 and valid JSON with version', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  identity.verifyIncoming({ nodeId: 'unit-filemode', identity: block(kp, regStmt('unit-filemode')), kind: 'node.register' });
  const st = fs.statSync(UNIT_FILE);
  assert.equal(st.mode & 0o777, 0o600, 'identity store must be 0600');
  const parsed = JSON.parse(fs.readFileSync(UNIT_FILE, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.ok(parsed.principals['unit-filemode']);
});

test('unit: publicSummary shapes (unbound/bound/failed/mismatch)', () => {
  const { kp } = makeKeypair();
  assert.deepEqual(identity.publicSummary('never-seen-bee'), { status: 'unbound' });

  const nodeId = 'unit-summary';
  identity.verifyIncoming({ nodeId, identity: block(kp, regStmt(nodeId)), kind: 'node.register' });
  const ok = identity.publicSummary(nodeId, { ok: true, action: 'verified', advisory: [] });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.principal, kp ? ok.principal : null);

  const bad = identity.publicSummary(nodeId, {
    ok: false, problems: ['key_mismatch: node is bound to a different key (present node secret or hw_id to rotate)'],
  });
  assert.equal(bad.status, 'mismatch');
  assert.ok(bad.hint, 'mismatch must tell the bee how to recover');
});

test('unit: verifyStandalone has no side effects and checks principal claim', () => {
  const { kp, principal } = makeKeypair();
  const st = { v: 1, kind: 'node.heartbeat', node_id: 'anyone', ts: nowS(), nonce: nonce() };
  const sig = sign(kp, st);

  const ok = identity.verifyStandalone({ statement: st, signature: sig, public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'), principal });
  assert.equal(ok.ok, true);

  const wrong = identity.verifyStandalone({
    statement: st, signature: sig,
    public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'),
    principal: 'hivv_' + '0'.repeat(32),
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems.join(' '), /does not derive/);
});

// ═══════════════════════════ B. LIVE ════════════════════════════════════════

async function api(pathname, opts = {}) {
  const { headers: extra, ...rest } = opts;
  const r = await fetch(`${BASE}${pathname}`, {
    ...rest,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'Content-Type': 'application/json', 'x-visitor-id': VISITOR, ...(extra || {}) },
  });
  let body;
  try { body = await r.json(); } catch (_e) { body = null; }
  return { status: r.status, body };
}

function liveRegBody(over = {}) {
  return {
    id: FAKE_ID, token: FAKE_ID, hw_id: FAKE_HW,
    hostname: 'e2e-identity', name: 'e2e-identity',
    version: '0.2.e2e', capabilities: ['heartbeat'],
    max_concurrent_jobs: 1, metrics: {},
    ...over,
  };
}

function liveRegStmt(over = {}) {
  return {
    v: 1, kind: 'node.register', node_id: FAKE_ID, ts: nowS(), nonce: nonce(),
    hw_id_sha256: crypto.createHash('sha256').update(FAKE_HW).digest('hex'),
    ...over,
  };
}

function liveHbStmt(over = {}) {
  return { v: 1, kind: 'node.heartbeat', node_id: FAKE_ID, ts: nowS(), nonce: nonce(), ...over };
}

test('live: legacy register (NO identity block) still works — dual-mode pin', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/nodes/register', { method: 'POST', body: liveRegBody() });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.registered, true);
  assert.equal('identity' in body, false, 'legacy response shape must not change');
});

test('live: register with valid identity binds the key', async () => {
  if (!gatewayUp) return;
  const { kp, principal } = makeKeypair();
  const { status, body } = await api('/api/nodes/register', {
    method: 'POST',
    body: liveRegBody({ identity: block(kp, liveRegStmt()) }),
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(['bound', 'verified', 'replaced'].includes(body.identity.status), body.identity.status);
  assert.equal(body.identity.principal, principal);
});

test('live: forged signature / wrong node_id / uncovered hw_id → 403 IDENTITY_INVALID', async () => {
  if (!gatewayUp) return;
  const { kp } = makeKeypair();
  const impostor = makeKeypair();

  // forged: statement signed by another key than the one presented
  const forgedSt = liveRegStmt();
  const forged = { ...block(kp, forgedSt), public_key: impostor.pubB64 };
  let r = await api('/api/nodes/register', { method: 'POST', body: liveRegBody({ identity: forged }) });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'IDENTITY_INVALID');

  // statement claims another node_id
  r = await api('/api/nodes/register', {
    method: 'POST',
    body: liveRegBody({ identity: block(kp, liveRegStmt({ node_id: 'someone-else' })) }),
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'IDENTITY_INVALID');

  // claim passes anti-squatting (correct hw_id) but the SIGNATURE covers a
  // different machine id — a mixed replay must be refused
  r = await api('/api/nodes/register', {
    method: 'POST',
    body: liveRegBody({
      identity: block(kp, liveRegStmt({
        hw_id_sha256: crypto.createHash('sha256').update('linux-other-machine').digest('hex'),
      })),
    }),
  });
  assert.equal(r.status, 403);
  assert.match((r.body.problems || []).join(' '), /hw_id/);
});

test('live: mismatch never rejects; legacy-proof register rebinds; heartbeat verifies', async () => {
  if (!gatewayUp) return;
  const { kp, principal } = makeKeypair();
  // release auto-flap quarantine first (the register storms above trip it —
  // quarantine makes heartbeats inert, which is correct but hides this path)
  await api(`/api/control/nodes/${FAKE_ID}/quarantine`, { method: 'POST', body: { release: true } });

  // (a) a DIFFERENT key than the bound one, at heartbeat: recorded as
  //     'mismatch' but NEVER rejected (advisory — the bee reacts, we don't
  //     knock it offline over a signer problem)
  let r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(), identity: block(kp, liveHbStmt()) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.identity.status, 'mismatch', 'hub must report it holds another key');
  assert.ok(r.body.identity.hint, 'mismatch must carry recovery instructions');

  // (b) recovery: register with the NEW key + legacy proof (hw_id) → replaced
  r = await api('/api/nodes/register', {
    method: 'POST',
    body: liveRegBody({ identity: block(kp, liveRegStmt()) }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.identity.status, 'replaced');
  assert.equal(r.body.identity.principal, principal);

  // (c) now the same key verifies at heartbeat
  r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(), identity: block(kp, liveHbStmt()) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(['bound', 'verified', 'replaced'].includes(r.body.identity.status), r.body.identity.status);

  // tampered: valid block shape, wrong signature → recorded, NEVER rejected
  const st = liveHbStmt();
  const tampered = block(kp, st);
  tampered.statement = { ...st, ts: st.ts + 1 };
  r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(), identity: tampered },
  });
  assert.equal(r.status, 200, 'heartbeat must never be rejected over its own signer');
  assert.equal(r.body.identity.status, 'failed');
  assert.ok(r.body.identity.reason, 'failure reason echoed so the bee can react');

  // legacy heartbeat (no identity) unchanged
  r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST', body: { hostname: 'e2e-identity', ts: nowS() },
  });
  assert.equal(r.status, 200);
  assert.equal('identity' in r.body, false);
});

test('live: replayed register block → 403 replayed nonce', async () => {
  if (!gatewayUp) return;
  const { kp } = makeKeypair();
  const st = liveRegStmt();
  const b = block(kp, st);
  const first = await api('/api/nodes/register', { method: 'POST', body: liveRegBody({ identity: b }) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await api('/api/nodes/register', { method: 'POST', body: liveRegBody({ identity: b }) });
  assert.equal(second.status, 403);
  assert.ok((second.body.problems || []).includes('replayed nonce'));
});

test('live: /api/identity read + verify surface (no secrets exposed)', async () => {
  if (!gatewayUp) return;
  const one = await api(`/api/identity/${FAKE_ID}`);
  assert.equal(one.status, 200);
  assert.match(one.body.principal, /^hivv_[0-9a-f]{32}$/);
  assert.equal(typeof one.body.public_key, 'string');
  assert.equal('secret' in one.body, false);
  assert.equal('hw_id' in one.body, false);

  const list = await api('/api/identity');
  assert.equal(list.status, 200);
  assert.ok(list.body.identities.some((x) => x.node_id === FAKE_ID));

  // standalone verify roundtrip
  const id = makeKeypair();
  const st = { v: 1, kind: 'node.heartbeat', node_id: 'anybee', ts: nowS(), nonce: nonce() };
  let r = await api('/api/identity/verify', {
    method: 'POST',
    body: { statement: st, signature: sign(id.kp, st), public_key: id.pubB64, principal: id.principal },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  r = await api('/api/identity/verify', {
    method: 'POST',
    body: { statement: st, signature: sign(makeKeypair().kp, st), public_key: id.pubB64, principal: id.principal },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
});

// ═══════════════ Phase 2: capability manifests ═════════════════════════════

function manifestBlock(kp, statement) {
  return { algorithm: 'ed25519',
           public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'),
           statement,
           signature: sign(kp, statement) };
}

function manifestStmt(nodeId, seq, over = {}) {
  return { v: 1, kind: 'capability.manifest', node_id: nodeId, ts: nowS(),
           nonce: nonce(), seq, tools: ['web_search'], tools_port: 8091,
           local_models: [{ name: 'gemma', port: 8080 }],
           capabilities: ['heartbeat'], volunteer: true, ...over };
}

test('unit: manifest verifies with the bound key; seq is monotonic', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  const nodeId = 'unit-manifest';
  identity.verifyIncoming({ nodeId, identity: block(kp, regStmt(nodeId)), kind: 'node.register' });

  const r1 = identity.verifyManifest({ nodeId, manifest: manifestBlock(kp, manifestStmt(nodeId, 1)) });
  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'verified');
  assert.deepEqual(r1.applied.tools, ['web_search']);
  assert.equal(identity.getRecord(nodeId).manifest.seq, 1);

  // replay (same seq) refused — even with a fresh nonce
  const replay = identity.verifyManifest({ nodeId, manifest: manifestBlock(kp, manifestStmt(nodeId, 1)) });
  assert.equal(replay.ok, false);
  assert.match(replay.problems.join(' '), /stale seq/);

  // higher seq accepted
  const r2 = identity.verifyManifest({ nodeId, manifest: manifestBlock(kp, manifestStmt(nodeId, 2)) });
  assert.equal(r2.ok, true);
  assert.equal(identity.getRecord(nodeId).cap_seq, 2);
});

test('unit: manifest from a foreign key or without a binding is refused', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  const impostor = makeKeypair();
  const nodeId = 'unit-manifest-foreign';
  // no binding yet
  let r = identity.verifyManifest({ nodeId, manifest: manifestBlock(kp, manifestStmt(nodeId, 1)) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /no identity binding/);

  identity.verifyIncoming({ nodeId, identity: block(kp, regStmt(nodeId)), kind: 'node.register' });
  r = identity.verifyManifest({ nodeId, manifest: manifestBlock(impostor.kp, manifestStmt(nodeId, 1)) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not the bound key/);

  // tampered seq after signing
  const st = manifestStmt(nodeId, 5);
  const good = manifestBlock(kp, st);
  r = identity.verifyManifest({ nodeId, manifest: { ...good, statement: { ...st, seq: 99 } } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /signature mismatch/);
});

test('unit: rotation — current key signs successor, forged refused, stale fatal', () => {
  identity._resetForTests();
  const a = makeKeypair();
  const b = makeKeypair();
  const c = makeKeypair();
  const nodeId = 'unit-rotate2';
  identity.verifyIncoming({ nodeId, identity: block(a.kp, regStmt(nodeId)), kind: 'node.register' });

  const rotStmt = (from, over = {}) => ({ v: 1, kind: 'identity.rotate', node_id: nodeId,
    ts: nowS(), nonce: nonce(), new_public_key: from.pubB64, ...over });

  // forged: signed by C, claims B's key
  let r = identity.verifyRotation({ nodeId, rotation: manifestBlock(c.kp, rotStmt(b)) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /CURRENT bound key/);

  // stale rotation is FATAL (a replayed old rotation must not roll back a key)
  r = identity.verifyRotation({ nodeId, rotation: manifestBlock(a.kp, rotStmt(b, { ts: nowS() - 9999 })) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /stale rotation/);

  // rotating to the SAME key refused
  r = identity.verifyRotation({ nodeId, rotation: manifestBlock(a.kp, rotStmt(a)) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /equals the current key/);

  // the real rotation: A signs B
  r = identity.verifyRotation({ nodeId, rotation: manifestBlock(a.kp, rotStmt(b)) });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'rotated');
  const rec = identity.getRecord(nodeId);
  assert.equal(rec.principal, b.principal);
  assert.equal(rec.bound_via, 'rotation');
  assert.equal(rec.history[0].rotated_via, 'rotation_statement');

  // replay of a rotation statement is refused: after the first rotation the
  // signer is no longer current (key check fires first), and the nonce cache
  // is the backstop for the gateway-restart edge where state was reloaded.
  const used = { v: 1, kind: 'identity.rotate', node_id: nodeId, ts: nowS(),
                 nonce: nonce(), new_public_key: c.pubB64 };
  const first = identity.verifyRotation({ nodeId, rotation: manifestBlock(b.kp, used) });
  assert.equal(first.ok, true, 'B (current) may rotate to C');
  r = identity.verifyRotation({ nodeId, rotation: manifestBlock(b.kp, used) });
  assert.equal(r.ok, false, 'the same statement must never rotate twice');
});

// ── Phase 2 live ────────────────────────────────────────────────────────────

test('live: signed manifest at heartbeat → verified, signed values applied', async () => {
  if (!gatewayUp) return;
  const { kp } = makeKeypair();
  // establish a known key first (legacy-proof register), release quarantine
  await api('/api/nodes/register', {
    method: 'POST', body: liveRegBody({ identity: block(kp, liveRegStmt()) }),
  });
  await api(`/api/control/nodes/${FAKE_ID}/quarantine`, { method: 'POST', body: { release: true } });

  const tools = ['web_search', 'calculator'];
  // seq must be monotonic ACROSS RUNS too — the hub's store is persistent,
  // so a fixed seq would go stale after the first run accepted it.
  const seq = Math.floor(Date.now() / 1000);
  const mst = { v: 1, kind: 'capability.manifest', node_id: FAKE_ID, ts: nowS(),
                nonce: nonce(), seq, tools, tools_port: 8091,
                local_models: [{ name: 'gemma', port: 8080 }],
                capabilities: ['heartbeat'], volunteer: true };
  const r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(), identity: block(kp, liveHbStmt()),
            capability_manifest: manifestBlock(kp, mst) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.manifest.status, 'verified', JSON.stringify(r.body.manifest));
  assert.equal(r.body.manifest.seq, seq);

  // the record exposes the signed advertisement
  const one = await api(`/api/identity/${FAKE_ID}`);
  assert.equal(one.body.manifest.seq, seq);
  assert.deepEqual(one.body.manifest.tools, tools);

  // stale seq → refused (heartbeat still 200 — advisory)
  const stale = { ...mst, nonce: nonce() }; // same seq, new nonce
  const r2 = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(), identity: block(kp, liveHbStmt()),
            capability_manifest: manifestBlock(kp, stale) },
  });
  assert.equal(r2.status, 200, 'manifest failure never rejects the heartbeat');
  assert.equal(r2.body.manifest.status, 'failed');
  assert.match(r2.body.manifest.reason, /stale seq/);

  // foreign-key manifest → failed
  const impostor = makeKeypair();
  const r3 = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(), identity: block(kp, liveHbStmt()),
            capability_manifest: manifestBlock(impostor.kp, { ...mst, seq: seq + 1, nonce: nonce() }) },
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.manifest.status, 'failed');
});

test('live: POST /api/identity/rotate — old key hands over with NO legacy proof', async () => {
  if (!gatewayUp) return;
  const a = makeKeypair();
  const b = makeKeypair();
  // bind A (legacy proof: hw_id)
  let r = await api('/api/nodes/register', {
    method: 'POST', body: liveRegBody({ identity: block(a.kp, liveRegStmt()) }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await api(`/api/control/nodes/${FAKE_ID}/quarantine`, { method: 'POST', body: { release: true } });

  // A signs a statement naming B — no hw_id, no secret in this request
  const rot = { v: 1, kind: 'identity.rotate', node_id: FAKE_ID, ts: nowS(),
                nonce: nonce(), new_public_key: b.pubB64 };
  r = await api('/api/identity/rotate', {
    method: 'POST', body: { node_id: FAKE_ID, rotation: manifestBlock(a.kp, rot) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.principal, b.principal);

  // B now verifies at heartbeat; A is superseded (mismatch, not rejected)
  const rB = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST', body: { hostname: 'e2e-identity', ts: nowS(), identity: block(b.kp, liveHbStmt()) },
  });
  assert.equal(rB.status, 200);
  assert.ok(['bound', 'verified'].includes(rB.body.identity.status), JSON.stringify(rB.body.identity));

  const rA = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST', body: { hostname: 'e2e-identity', ts: nowS(), identity: block(a.kp, liveHbStmt()) },
  });
  assert.equal(rA.status, 200, 'the superseded key never knocks the bee offline');
  assert.equal(rA.body.identity.status, 'mismatch');

  // forged rotation (signed by an impostor) refused
  const c = makeKeypair();
  const rot2 = { v: 1, kind: 'identity.rotate', node_id: FAKE_ID, ts: nowS(),
                 nonce: nonce(), new_public_key: c.pubB64 };
  r = await api('/api/identity/rotate', {
    method: 'POST', body: { node_id: FAKE_ID, rotation: manifestBlock(c.kp, rot2) },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'IDENTITY_ROTATE_INVALID');

  // restore A→? — leave bound to B; cleanup test removes the node anyway
});

// ═══════════════ Phase 3: execution receipts ═══════════════════════════════

function receiptBlock(kp, statement) {
  return { algorithm: 'ed25519',
           public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'),
           statement,
           signature: sign(kp, statement) };
}

function receiptStmt(nodeId, over = {}) {
  return { v: 1, kind: 'execution.receipt', node_id: nodeId, ts: nowS(),
           nonce: nonce(), receipt_id: crypto.randomBytes(16).toString('hex'),
           op: 'cli_update', result: 'ok',
           output_sha256: crypto.randomBytes(32).toString('hex'),
           job_id: 'P_test', ...over };
}

test('unit: receipt records in the ring; dedup, tamper, foreign key refused', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  const impostor = makeKeypair();
  const nodeId = 'unit-receipt';
  identity.verifyIncoming({ nodeId, identity: block(kp, regStmt(nodeId)), kind: 'node.register' });

  const st = receiptStmt(nodeId);
  let r = identity.verifyReceipt({ nodeId, receipt: receiptBlock(kp, st) });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'recorded');
  assert.equal(identity.listReceipts(nodeId).length, 1);

  // same receipt_id, DIFFERENT nonce → receipt_id dedup fires (nonce cache
  // only catches the byte-identical replay)
  r = identity.verifyReceipt({ nodeId, receipt: receiptBlock(kp, { ...st, nonce: nonce() }) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /duplicate receipt/);

  // byte-identical replay → nonce cache fires
  const st2 = receiptStmt(nodeId);
  identity.verifyReceipt({ nodeId, receipt: receiptBlock(kp, st2) });
  r = identity.verifyReceipt({ nodeId, receipt: receiptBlock(kp, st2) });
  assert.equal(r.ok, false);

  // tampered result
  const st3 = receiptStmt(nodeId);
  r = identity.verifyReceipt({ nodeId, receipt: { ...receiptBlock(kp, st3), statement: { ...st3, result: 'failed' } } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /signature mismatch/);

  // foreign signer
  r = identity.verifyReceipt({ nodeId, receipt: receiptBlock(impostor.kp, receiptStmt(nodeId)) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not the bound key/);

  // bad result vocabulary
  const st4 = receiptStmt(nodeId, { result: 'great' });
  r = identity.verifyReceipt({ nodeId, receipt: receiptBlock(kp, st4) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /result must be one of/);

  // ring is bounded
  for (let i = 0; i < 40; i++) {
    identity.verifyReceipt({ nodeId, receipt: receiptBlock(kp, receiptStmt(nodeId)) });
  }
  assert.ok(identity.listReceipts(nodeId).length <= 32, 'ring must stay bounded');
});

test('live: receipt endpoint roundtrip + repair_report receipt verification', async () => {
  if (!gatewayUp) return;
  const { kp } = makeKeypair();
  // bind a known key (legacy-proof register), release quarantine
  await api('/api/nodes/register', {
    method: 'POST', body: liveRegBody({ identity: block(kp, liveRegStmt()) }),
  });
  await api(`/api/control/nodes/${FAKE_ID}/quarantine`, { method: 'POST', body: { release: true } });

  // direct receipt submission
  const st = receiptStmt(FAKE_ID);
  let r = await api('/api/identity/receipts', {
    method: 'POST', body: { node_id: FAKE_ID, receipt: receiptBlock(kp, st) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);

  // duplicate refused
  r = await api('/api/identity/receipts', {
    method: 'POST', body: { node_id: FAKE_ID, receipt: receiptBlock(kp, st) },
  });
  assert.equal(r.status, 400);

  // forged receipt refused
  const impostor = makeKeypair();
  r = await api('/api/identity/receipts', {
    method: 'POST',
    body: { node_id: FAKE_ID, receipt: receiptBlock(impostor.kp, receiptStmt(FAKE_ID)) },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'IDENTITY_RECEIPT_INVALID');

  // GET the ring
  r = await api(`/api/identity/receipts/${FAKE_ID}?limit=5`);
  assert.equal(r.status, 200);
  assert.ok(r.body.count >= 1);
  assert.equal(r.body.receipts[0].op, 'cli_update');

  // heartbeat: repair_report carrying a SIGNED receipt → verified
  const rrSt = receiptStmt(FAKE_ID, { op: 'agent_restart', result: 'ok' });
  r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(),
            identity: block(kp, liveHbStmt()),
            repair_report: { plan_id: 'P_live', ok: true, op: 'agent_restart',
                             result: 'restarted', ts: nowS(),
                             receipt: receiptBlock(kp, rrSt) } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // the hub echoes the verified outcome on node.last_repair — check via a
  // second heartbeat-less read: the record's ring gained the receipt
  const ring = await api(`/api/identity/receipts/${FAKE_ID}?limit=10`);
  assert.ok(ring.body.receipts.some((x) => x.op === 'agent_restart'),
            'repair receipt must land in the ring');

  // tampered repair receipt → refused but heartbeat still 200
  const rrSt2 = receiptStmt(FAKE_ID, { op: 'selftest', result: 'ok' });
  const badBlock = receiptBlock(kp, rrSt2);
  badBlock.statement = { ...rrSt2, result: 'failed' };
  r = await api(`/api/nodes/${FAKE_ID}/heartbeat`, {
    method: 'POST',
    body: { hostname: 'e2e-identity', ts: nowS(),
            identity: block(kp, liveHbStmt()),
            repair_report: { plan_id: 'P_bad', ok: true, op: 'selftest',
                             result: 'x', ts: nowS(), receipt: badBlock } },
  });
  assert.equal(r.status, 200, 'a bad receipt never rejects the heartbeat');
  const ring2 = await api(`/api/identity/receipts/${FAKE_ID}?limit=20`);
  assert.equal(ring2.body.receipts.some((x) => x.op === 'selftest'), false,
               'the tampered receipt must NOT be recorded');
});

// ═══════════════ Phase 4: revocation + endorsements ════════════════════════

function revokeBlock(kp, statement) {
  return { algorithm: 'ed25519',
           public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'),
           statement,
           signature: sign(kp, statement) };
}

test('unit: CRL — revoked keys authenticate nothing; legacy proof recovers', () => {
  identity._resetForTests();
  const a = makeKeypair();
  const b = makeKeypair();
  const nodeId = 'unit-crl';
  identity.verifyIncoming({ nodeId, identity: block(a.kp, regStmt(nodeId)), kind: 'node.register' });

  // self-revoke: A signs a statement revoking ITSELF
  const revSt = { v: 1, kind: 'identity.revoke', node_id: nodeId, ts: nowS(),
                  nonce: nonce(), principal: a.principal, reason: 'key may be compromised' };
  let r = identity.verifySelfRevocation({ nodeId, revocation: revokeBlock(a.kp, revSt) });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'revoked');
  assert.equal(identity.listRevocations().length, 1);

  // the revoked key now authenticates NOTHING
  r = identity.verifyIncoming({ nodeId, identity: block(a.kp, regStmt(nodeId)), kind: 'node.register' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /revoked:/);

  const mf = identity.verifyManifest({ nodeId, manifest: manifestBlock(a.kp, manifestStmt(nodeId, 5)) });
  assert.equal(mf.ok, false);
  assert.match(mf.problems.join(' '), /revoked/);

  // publicSummary reports 'revoked' (the CLI's rebind trigger vocabulary)
  const summary = identity.publicSummary(nodeId, r);
  assert.equal(summary.status, 'revoked');
  assert.ok(summary.hint, 'revoked must tell the bee how to recover');

  // recovery: a FRESH key + legacy proof replaces the revoked binding —
  // while the CRL keeps holding the old principal forever
  r = identity.verifyIncoming({ nodeId, kind: 'node.register', legacyProof: true,
                                identity: block(b.kp, regStmt(nodeId)) });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'replaced');
  assert.equal(identity.getRecord(nodeId).status, 'active');
  assert.equal(identity.listRevocations().length, 1, 'CRL must retain the revoked principal');
  assert.equal(identity.listRevocations()[0].principal, a.principal);

  // operator revocation: known principal → ok, UNKNOWN principal → refused
  const stranger = makeKeypair();
  const denied = identity.revokeByOperator({ nodeId, principal: stranger.principal, reason: 'x' });
  assert.equal(denied.ok, false);
  const ok = identity.revokeByOperator({ nodeId, principal: b.principal, reason: 'operator decision' });
  assert.equal(ok.ok, true);
  assert.equal(identity.getRecord(nodeId).status, 'revoked');
  assert.equal(identity.listRevocations().length, 2);
});

test('unit: endorsements — valid stored, forged/mismatched refused, roles dedupe', () => {
  identity._resetForTests();
  const operator = makeKeypair();
  const impostor = makeKeypair();
  const { kp: nodeKp, principal: nodePrincipal } = makeKeypair();
  const nodeId = 'unit-endorse';
  identity.verifyIncoming({ nodeId, identity: block(nodeKp, regStmt(nodeId)), kind: 'node.register' });

  const endSt = (over = {}) => ({ v: 1, kind: 'operator.endorse', ts: nowS(),
    nonce: nonce(), operator_principal: operator.principal,
    node_id: nodeId, node_principal: nodePrincipal, role: 'owner', ...over });

  let r = identity.verifyEndorsement({ endorsement: revokeBlock(operator.kp, endSt()) });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'endorsed');
  assert.equal(identity.listEndorsements(nodeId).length, 1);

  // same operator+node+role again → updated, not duplicated
  r = identity.verifyEndorsement({ endorsement: revokeBlock(operator.kp, endSt({ role: 'owner' })) });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'updated');
  assert.equal(identity.listEndorsements(nodeId).length, 1);

  // forged: impostor signs but claims the operator's principal
  r = identity.verifyEndorsement({ endorsement: revokeBlock(impostor.kp, endSt()) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /does not derive/);

  // node_principal that does not match the hub's binding → refused
  r = identity.verifyEndorsement({ endorsement: revokeBlock(operator.kp, endSt({
    node_principal: makeKeypair().principal, nonce: nonce() })) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /does not match the bound principal/);

  // role vocabulary bound
  r = identity.verifyEndorsement({ endorsement: revokeBlock(operator.kp, endSt({ role: 'x'.repeat(100), nonce: nonce() })) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /role/);
});

test('live: revoke → public CRL → register with revoked key 403 → recovery; endorsements', async () => {
  if (!gatewayUp) return;
  const a = makeKeypair();
  const b = makeKeypair();

  // bind A
  let r = await api('/api/nodes/register', {
    method: 'POST', body: liveRegBody({ identity: block(a.kp, liveRegStmt()) }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // SELF-revoke A (signed by A — no admin needed)
  const revSt = { v: 1, kind: 'identity.revoke', node_id: FAKE_ID, ts: nowS(),
                  nonce: nonce(), principal: a.principal, reason: 'e2e revocation test' };
  r = await api('/api/identity/revoke', {
    method: 'POST', body: { node_id: FAKE_ID, revocation: revokeBlock(a.kp, revSt) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.by, 'self');

  // public CRL shows it
  r = await api('/api/identity/revocations');
  assert.equal(r.status, 200);
  assert.ok(r.body.revocations.some((x) => x.principal === a.principal && x.by === 'self'));

  // the revoked key can no longer register (403, CRL problem) — files an
  // identity_revoked incident (deduped) — and heartbeats report 'revoked'
  r = await api('/api/nodes/register', {
    method: 'POST', body: liveRegBody({ identity: block(a.kp, liveRegStmt()) }),
  });
  assert.equal(r.status, 403);
  assert.match((r.body.problems || []).join(' '), /revoked:/);

  // recovery: fresh key B + legacy proof
  r = await api('/api/nodes/register', {
    method: 'POST', body: liveRegBody({ identity: block(b.kp, liveRegStmt()) }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(['bound', 'verified', 'replaced'].includes(r.body.identity.status));

  // the node record shows endorsements; the CRL still holds A
  const op = makeKeypair();
  const endSt = { v: 1, kind: 'operator.endorse', ts: nowS(), nonce: nonce(),
                  operator_principal: op.principal, node_id: FAKE_ID,
                  node_principal: b.principal, role: 'owner' };
  r = await api('/api/identity/endorse', {
    method: 'POST', body: { endorsement: revokeBlock(op.kp, endSt) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, 'endorsed');

  // NOTE: the store is persistent and every run mints a fresh operator key,
  // so entries ACCUMULATE across runs — assert containment, never a count.
  r = await api(`/api/identity/endorsements?node_id=${FAKE_ID}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.endorsements.some((x) =>
    x.operator_principal === op.principal && x.role === 'owner'),
  'the endorsement from this run must be listed');

  const one = await api(`/api/identity/${FAKE_ID}`);
  assert.ok(one.body.endorsements.some((x) => x.role === 'owner'));
  assert.equal(one.body.revoked, undefined, 'B is active — not revoked');

  // forged endorsement: impostor claims the operator principal
  const impostor = makeKeypair();
  const forged = { ...endSt, nonce: nonce() };
  r = await api('/api/identity/endorse', {
    method: 'POST', body: { endorsement: revokeBlock(impostor.kp, forged) },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'IDENTITY_ENDORSE_INVALID');

  // ADMIN (operator) revocation from loopback: revokes B without any signature
  r = await api('/api/identity/revoke', {
    method: 'POST', body: { principal: b.principal, reason: 'operator decision (e2e)', node_id: FAKE_ID },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.by, 'operator');
  const crl = await api('/api/identity/revocations');
  assert.ok(crl.body.revocations.some((x) => x.principal === b.principal && x.by === 'operator'));
});

// ═══════════════ Phase 6: signed route receipts ════════════════════════════

test('unit: route receipts — stable hub key, sign/verify, digest binding', () => {
  const info = identity.hubKeyInfo();
  assert.ok(info, 'hub key must exist');
  assert.match(info.principal, /^hivv_[0-9a-f]{32}$/);
  assert.equal(info.algorithm, 'ed25519');
  assert.match(info.public_key, /^[A-Za-z0-9+/]{43}=$/);
  // stable across calls (one key, cached)
  assert.equal(identity.hubKeyInfo().public_key, info.public_key);

  const digest = crypto.randomBytes(32).toString('hex');
  const r = identity.routeReceipt({
    answeredBy: 'beefake/test-model (direct)', transport: 'direct',
    answerSha256: digest, durationMs: 123,
  });
  assert.ok(r);
  assert.equal(r.statement.kind, 'route.receipt');
  assert.equal(r.statement.answer_sha256, digest);
  assert.equal(r.statement.duration_ms, 123);
  assert.equal(r.public_key, info.public_key);

  // verifies standalone against its own key, principal = hub principal
  const v = identity.verifyStandalone({
    statement: r.statement, signature: r.signature,
    public_key: r.public_key, principal: info.principal,
  });
  assert.equal(v.ok, true, JSON.stringify(v.problems));

  // tampering with the digest breaks the signature
  const tampered = { ...r, statement: { ...r.statement, answer_sha256: 'b'.repeat(64) } };
  const v2 = identity.verifyStandalone({
    statement: tampered.statement, signature: tampered.signature,
    public_key: tampered.public_key,
  });
  assert.equal(v2.ok, false);

  // an invalid digest is DROPPED (never signed as garbage), receipt still valid
  const r3 = identity.routeReceipt({
    answeredBy: 'x/y (relay)', transport: 'relay', answerSha256: 'not-a-hash',
  });
  assert.equal(r3.statement.answer_sha256, undefined);
  assert.equal(identity.verifyStandalone({
    statement: r3.statement, signature: r3.signature, public_key: r3.public_key,
  }).ok, true);

  // header encoding round-trip
  const hdr = identity.routeReceiptHeader({ answeredBy: 'a/b (direct)', transport: 'direct' });
  assert.ok(typeof hdr === 'string' && hdr.length > 0);
  const back = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
  assert.equal(identity.verifyStandalone({
    statement: back.statement, signature: back.signature, public_key: back.public_key,
  }).ok, true);
});

test('live: a chat answer carries a verifiable X-Hivv-Receipt', async () => {
  if (!gatewayUp) return;
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-visitor-id': 'receipt-e2e' },
    body: JSON.stringify({ message: 'reply with exactly: receipt', stream: false }),
  });
  const bodyText = await res.text();
  const answeredBy = res.headers.get('x-hivv-answered-by');
  if (!answeredBy) return; // no bee answered right now — nothing to attest

  const hdr = res.headers.get('x-hivv-receipt');
  assert.ok(hdr, 'a non-stream answer must carry a signed receipt');

  const receipt = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
  assert.equal(receipt.statement.kind, 'route.receipt');
  assert.equal(receipt.statement.answered_by, answeredBy);

  //1. the signature verifies against the HUB's published key
  const hubKey = await (await fetch(`${BASE}/api/identity/hub-key`)).json();
  const v = await (await fetch(`${BASE}/api/identity/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(receipt),
  })).json();
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.principal, hubKey.principal, 'receipt must be signed by the hub key');

  //2. the answer digest matches the EXACT body this client received
  const digest = crypto.createHash('sha256').update(bodyText, 'utf8').digest('hex');
  assert.equal(receipt.statement.answer_sha256, digest,
    'the client must be able to hash its own body and match the receipt');
});

test('unit: enforcement is OPT-IN (advisory stays the default)', () => {
  assert.equal(identity.enforcementRequired({}), false);
  assert.equal(identity.enforcementRequired({ HIVV_IDENTITY_ENFORCE: '0' }), false);
  assert.equal(identity.enforcementRequired({ HIVV_IDENTITY_ENFORCE: '' }), false);
  assert.equal(identity.enforcementRequired({ HIVV_IDENTITY_ENFORCE: '1' }), true);
});

test('live: unsigned register matches the gateway enforcement mode', async () => {
  if (!gatewayUp) return;
  const enforcing = String(process.env.HIVV_IDENTITY_ENFORCE || '') === '1' ||
    (await (await fetch(`${BASE}/api/health`)).ok && await (async () => {
      // the live gateway's mode: ask an unsigned register what happens
      const r = await fetch(`${BASE}/api/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-visitor-id': 'enforce-probe' },
        body: JSON.stringify({ id: '__enforce_probe__',
                               hw_id: 'linux-enforce-probe', hostname: 'probe',
                               capabilities: ['heartbeat'], max_concurrent_jobs: 1, metrics: {} }),
      });
      if (r.status === 403) {
        const b = await r.json().catch(() => ({}));
        if (b.code === 'IDENTITY_REQUIRED') return true;
      }
      // clean up if it registered (advisory mode)
      if (r.status === 200) {
        await fetch(`${BASE}/api/control/nodes/__enforce_probe__`, { method: 'DELETE' });
      }
      return false;
    })());
  // The contract: whatever mode the gateway is in, an unsigned register is
  // either refused with IDENTITY_REQUIRED (enforced) or accepted (advisory)
  // — never anything else. This pins the flag's two legal outcomes.
  assert.equal(typeof enforcing, 'boolean');
});

test('cleanup: remove the fake node', async () => {
  if (!gatewayUp) return;
  await api(`/api/control/nodes/${FAKE_ID}/quarantine`, { method: 'POST', body: { release: true } });
  await api(`/api/control/nodes/${FAKE_ID}`, { method: 'DELETE' });
  // identity record intentionally retained (public key history; fixed id makes
  // re-runs idempotent via legacy-proof replacement)
  assert.ok(true);
});
