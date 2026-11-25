// api/tests/trust.test.js — pins Phase 5: MEASURED trust for the router.
//
// The rule this file defends: NO DATA IS null, NEVER 0 — "unknown" and
// "measured zero" are different truths (an unbound bee is unproven, not
// dishonest; a quarantined bee is measured zero). And the router's
// trustScore must fall back to the legacy honey-rank behaviour when there
// is nothing to measure, so Phase 5 is strictly additive.
//
// HIVV_IDENTITY_FILE is pointed at a tmp file BEFORE the require (trust.js
// pulls identity.js in).
//
// Run with:  cd api && node --test tests/trust.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UNIT_FILE = path.join(os.tmpdir(), `hivv-trust-unit-${process.pid}.json`);
try { fs.unlinkSync(UNIT_FILE); } catch (_e) { /* fresh */ }
process.env.HIVV_IDENTITY_FILE = UNIT_FILE;

const trust = require('../lib/trust');
const identity = require('../lib/identity');
const attest = require('../lib/attest');

const BASE = 'http://localhost:3011';
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
  return { kp, pubB64: raw.toString('base64'), principal: attest.principalIdFromRaw(raw) };
}

function sign(kp, statement) {
  return crypto.sign(null, Buffer.from(attest.canonicalize(statement), 'utf8'),
    kp.privateKey).toString('base64');
}

function block(kp, statement) {
  return { algorithm: 'ed25519',
           public_key: attest.rawFromPublicKey(kp.publicKey).toString('base64'),
           statement,
           signature: sign(kp, statement) };
}

const nowS = () => Math.floor(Date.now() / 1000);
const nonce = () => crypto.randomBytes(8).toString('hex');

function bindNode(nodeId, kp) {
  const st = { v: 1, kind: 'node.register', node_id: nodeId, ts: nowS(), nonce: nonce() };
  const r = identity.verifyIncoming({ nodeId, identity: block(kp, st), kind: 'node.register' });
  assert.equal(r.ok, true, 'bind must succeed');
}

function liveNode(nodeId, over = {}) {
  return { node_id: nodeId, status: 'online', last_heartbeat: Date.now(),
           max_concurrent_jobs: 1, active_tasks: 0, ...over };
}

// ═══════════════════════════ unit ══════════════════════════════════════════

test('unit: no node at all → everything unknown, score null (never 0)', () => {
  const t = trust.computeTrust(null, {});
  assert.equal(t.overall, null);
  assert.equal(t.score, null);
  for (const v of Object.values(t.dimensions)) assert.equal(v, null);
});

test('unit: bound bee + fresh heartbeat → known dimensions, score 0..6', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  const nodeId = 'trust-bound';
  bindNode(nodeId, kp);

  const t = trust.computeTrust(liveNode(nodeId), { honeyRank: 'forager' });
  assert.ok(t.dimensions.identity >= 60, `identity ${t.dimensions.identity}`);
  assert.ok(t.dimensions.reliability >= 70, `reliability ${t.dimensions.reliability}`);
  assert.equal(t.dimensions.history, Math.round((3 / 6) * 100), 'forager = rank 3');
  assert.equal(t.dimensions.receipts, null, 'no receipts = NO DATA, not 0');
  assert.ok(t.overall > 0 && t.overall <= 100);
  assert.ok(t.score >= 0 && t.score <= 6);
  assert.equal(t.evidence.identity.bound, true);
  assert.ok(t.evidence.reliability.heartbeat_age_s >= 0);
});

test('unit: unbound node → identity is UNKNOWN (neutral), not zero', () => {
  identity._resetForTests();
  const t = trust.computeTrust(liveNode('trust-unbound'), {});
  assert.equal(t.dimensions.identity, null, 'unbound = unproven = null');
  assert.ok(t.dimensions.reliability >= 70, 'reliability still measurable');
  // overall comes from the KNOWN dimensions only
  assert.ok(t.overall > 0, 'an honest unmeasured bee must not read as trust 0');
});

test('unit: revoked identity → 0 (measured zero)', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  const nodeId = 'trust-revoked';
  bindNode(nodeId, kp);
  const rec = identity.getRecord(nodeId);
  identity.revokeByOperator({ nodeId, principal: rec.principal, reason: 'compromised' });

  const t = trust.computeTrust(liveNode(nodeId), {});
  assert.equal(t.dimensions.identity, 0, 'a revoked key is MEASURED zero');
  assert.equal(t.evidence.identity.revoked, true);
});

test('unit: quarantined node → reliability 0 (measured zero)', () => {
  identity._resetForTests();
  const nodeId = 'trust-quar';
  const t = trust.computeTrust(
    liveNode(nodeId, { quarantined: { by: 'auto-flap', reason: 'crash loop' } }),
    { honeyRank: 'queen-bee' });
  assert.equal(t.dimensions.reliability, 0);
  assert.equal(t.evidence.reliability.quarantined, 'auto-flap');
  // history still contributes — one zero doesn't erase the rest
  assert.equal(t.dimensions.history, 100);
});

test('unit: history dimension maps the honey ranks', () => {
  assert.equal(trust.historyDimension('queen-bee').value, 100);
  assert.equal(trust.historyDimension('larva').value, Math.round((1 / 6) * 100));
  assert.equal(trust.historyDimension(null).value, null);
  assert.equal(trust.historyDimension('not-a-rank').value, null);
});

test('unit: receipts dimension = ratio of signed ok outcomes', () => {
  identity._resetForTests();
  const { kp } = makeKeypair();
  const nodeId = 'trust-receipts';
  bindNode(nodeId, kp);

  assert.equal(trust.receiptsDimension(nodeId).value, null, 'empty ring = no data');

  const mkReceipt = (result) => {
    const st = { v: 1, kind: 'execution.receipt', node_id: nodeId, ts: nowS(),
                 nonce: nonce(), receipt_id: crypto.randomBytes(16).toString('hex'),
                 op: 'selftest', result };
    return block(kp, st);
  };
  identity.verifyReceipt({ nodeId, receipt: mkReceipt('ok') });
  identity.verifyReceipt({ nodeId, receipt: mkReceipt('ok') });
  assert.equal(trust.receiptsDimension(nodeId).value, 100);

  identity.verifyReceipt({ nodeId, receipt: mkReceipt('failed') });
  assert.equal(trust.receiptsDimension(nodeId).value, Math.round((2 / 3) * 100));
});

test('unit: routerTrustScore falls back to legacy honey when nothing is measurable', () => {
  // cloud/unknown target: no node record → legacy behaviour exactly
  assert.equal(trust.routerTrustScore(null, 4), 4);
  assert.equal(trust.routerTrustScore(null, undefined), 0);
  assert.equal(trust.routerTrustScore(null, NaN), 0);

  // a measurable node blends — and is NOT silently equal to honey alone
  identity._resetForTests();
  const { kp } = makeKeypair();
  const nodeId = 'trust-blend';
  bindNode(nodeId, kp);
  const blended = trust.routerTrustScore(liveNode(nodeId), 1); // honey = larva (low)
  assert.ok(blended > 1, `identity+reliability must lift a low-rank bee (got ${blended})`);
  assert.ok(blended <= 6);
});

test('unit: persist writes known dimensions through the pool, survives pool death', async () => {
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const result = { overall: 80, dimensions: { identity: 90, reliability: 70, history: null },
                   evidence: { identity: { bound: true }, reliability: {} } };
  await trust.persist(fakePool, 'node-x', result);
  // history is null → NO row (no data must not become a zero row)
  assert.equal(calls.length, 2);
  assert.ok(calls[0].sql.includes('hivv_trust_scores'));
  assert.equal(calls[0].params[1], 'identity');
  assert.equal(calls[0].params[2], 90);

  // a dying pool must not throw out of persist
  const deadPool = { async query() { throw new Error('no db'); } };
  await assert.doesNotReject(() => trust.persist(deadPool, 'node-x', result));
  // and no-pool (local-first) is a no-op
  await assert.doesNotReject(() => trust.persist(null, 'node-x', result));
});

// ═══════════════════════════ live ══════════════════════════════════════════

test('live: GET /api/identity/trust/:nodeId — bound bee has known dimensions', async () => {
  if (!gatewayUp) return;
  const r = await fetch(`${BASE}/api/identity/trust/ashy`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.node_id, 'ashy');
  assert.equal(body.known, true, 'ashy is bound + heartbeating — trust must be known');
  assert.ok(body.score >= 0 && body.score <= 6);
  assert.ok(body.dimensions.identity > 0, 'bound key → identity dimension');
  assert.ok(body.dimensions.reliability > 0, 'fresh heartbeats → reliability dimension');
  assert.ok(body.evidence, 'evidence must be exposed');
  // null means no data — the API must distinguish, not fill zeros
  assert.ok('receipts' in body.dimensions);
});

test('live: unknown node → known:false and null score (not zero)', async () => {
  if (!gatewayUp) return;
  const r = await fetch(`${BASE}/api/identity/trust/__no_such_bee__`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.known, false);
  assert.equal(body.score, null, 'no data must serialize as null, never 0');
  assert.equal(body.overall, null);
});

test('live: the router carries measured trust in its factor rows', async () => {
  if (!gatewayUp) return;
  const r = await fetch(`${BASE}/api/capabilities/route/dry-run?q=hello&capability=chat`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const rows = (body.transports && body.transports.direct) || [];
  if (!rows.length) return; // no candidates right now — nothing to assert
  for (const row of rows) {
    assert.ok(Number.isFinite(row.trust), 'dbg.trust must be a number');
    assert.ok(row.factors && Number.isFinite(row.factors.trust),
      'every candidate row must carry factors.trust');
    assert.ok(row.factors.trust >= 0 && row.factors.trust <= 1);
  }
});
