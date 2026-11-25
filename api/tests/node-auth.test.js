// api/tests/node-auth.test.js — pins the 2026-11-14 node-secret work:
//   1. GET /api/control/nodes/:id must NOT leak secret/hw_id/token (it used to
//      hand the inbox HMAC key to any internet caller — defeating node-auth),
//   2. inbox polls enforce x-node-secret once a node has enrolled,
//   3. a bee that lost its local secret can recover it by re-registering with
//      the SAME hw_id it enrolled with (else a state wipe bricks its inbox
//      forever — masjid/ashy 2026-11-14),
//   4. repair plans are signed over the SORTED-compact canonical ops string
//      (hub JSON.stringify used to sign insertion order while the bee verified
//      sort_keys → every cli_update plan failed HMAC),
//   5. upgrade-reports rows land, dedup per (node, action, sha)/24h, blocked
//      reports on a KNOWN bee open an upgrade_suspicious incident, unknown
//      bees record without incident.
//
// Runs against the live gateway (same contract as integration.test.js) and
// cleans up after itself: inbox acked, fake node deleted, incident resolved.
// Run with:  cd api && node --test tests/node-auth.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BASE = 'http://localhost:3011';
const VISITOR = 'test-node-auth';

// Fixed identity so re-runs are idempotent even after a crashed run left the
// node behind (same hw_id → registerNode keeps the id and existing secret).
const FAKE_ID = '__node_auth_e2e__';
const FAKE_HW = 'linux-e2e-nodeauth-hwid';
const FAKE_SECRET = 'e2e-node-secret-fixed-0123456789';
const GHOST_ID = '__ghost_node_e2e__';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

let gatewayUp = false;

before(async () => {
  try {
    const r = await fetch(`${BASE}/api/health`);
    gatewayUp = r.ok;
  } catch (_) {
    gatewayUp = false;
  }
});

async function api(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts;
  const r = await fetch(`${BASE}${path}`, {
    ...rest,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    // merge AFTER spreading opts — opts.headers must not clobber Content-Type
    headers: {
      'Content-Type': 'application/json',
      'x-visitor-id': VISITOR,
      ...(extraHeaders || {}),
    },
  });
  let body;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, ok: r.ok, body };
}

async function registerNode({ withSecret }) {
  const headers = {};
  if (withSecret) headers['x-node-secret'] = FAKE_SECRET;
  return api('/api/nodes/register', {
    method: 'POST',
    headers,
    body: {
      id: FAKE_ID, token: FAKE_ID, hw_id: FAKE_HW,
      hostname: 'e2e-node', name: 'e2e-node',
      version: '0.2.e2e', capabilities: ['heartbeat'],
      max_concurrent_jobs: 1, metrics: {},
    },
  });
}

// Python's json.dumps(ops, sort_keys=True, separators=(",", ":")) for the
// exact ops shapes the hub signs — the cross-language contract both the hub
// signer and tests/test_upgrade_review.py::TestRepairSignatureParity pin.
const CANONICAL_CLI_UPDATE = '[{"force":true,"op":"cli_update"}]';
const INSERTION_CLI_UPDATE = '[{"op":"cli_update","force":true}]'; // the OLD buggy form

function sign(secret, ts, ttl, canonical) {
  return crypto.createHmac('sha256', secret)
    .update(`${ts}\n${ttl}\n${canonical}`)
    .digest('hex');
}

// ── 1. register adopts a presented secret (no fresh issue, no leak) ─────────
test('register with x-node-secret adopts it and returns no node_secret', async () => {
  if (!gatewayUp) return;
  const { status, body } = await registerNode({ withSecret: true });
  assert.equal(status, 200, `register returned ${status}: ${JSON.stringify(body)}`);
  assert.equal(body?.registered, true);
  assert.equal(body?.node_id, FAKE_ID, 'node id must not be renamed');
  // Adopted (bee owns the secret) → hub has nothing new to hand back.
  // Recovery/re-issue happens in the dedicated test below.
  assert.equal('node_secret' in (body || {}), false,
    'adopt path must not echo a secret back');
});

// ── 2. inbox enforces the secret after enrolment ────────────────────────────
test('inbox: 403 without/with-wrong secret, 200 with the enrolled one', async () => {
  if (!gatewayUp) return;
  const noSecret = await api(`/api/agents/${FAKE_ID}/inbox?wait=1`);
  assert.equal(noSecret.status, 403, 'missing secret must be refused');

  const wrong = await api(`/api/agents/${FAKE_ID}/inbox?wait=1`, {
    headers: { 'x-node-secret': 'not-the-secret' },
  });
  assert.equal(wrong.status, 403, 'wrong secret must be refused');

  // wait=0: this case is about AUTH, so it must not sit through a long-poll.
  const right = await api(`/api/agents/${FAKE_ID}/inbox?wait=0`, {
    headers: { 'x-node-secret': FAKE_SECRET },
  });
  assert.equal(right.status, 200, `enrolled secret must pass: ${JSON.stringify(right.body)}`);
  assert.ok(Array.isArray(right.body?.messages), 'inbox must return a messages array');
});

// ── 3. recovery: state-wiped bee re-registers with hw_id → secret re-issued ─
test('re-register without secret re-issues the ORIGINAL secret (hw_id proven)', async () => {
  if (!gatewayUp) return;
  // No x-node-secret header — exactly what a bee whose state.json got wiped sends.
  const { status, body } = await registerNode({ withSecret: false });
  assert.equal(status, 200, `re-register returned ${status}: ${JSON.stringify(body)}`);
  assert.equal(body?.node_id, FAKE_ID);
  assert.ok(body?.node_secret, 'recovery must re-issue node_secret');
  assert.equal(body?.node_secret, FAKE_SECRET,
    'must re-issue the ORIGINAL secret — a fresh random one would desync the hub signer');
  // And the inbox works with it again:
  const inbox = await api(`/api/agents/${FAKE_ID}/inbox?wait=0`, {
    headers: { 'x-node-secret': body.node_secret },
  });
  assert.equal(inbox.status, 200, 'recovered secret must grant inbox access');
});

// -- 3b. long-poll honours SECONDS (the unit bug) ----------------------------
test('inbox: wait=N holds N SECONDS, not N milliseconds', async () => {
  if (!gatewayUp) return;

  // Drain whatever is already queued, so the timing below measures the HOLD
  // rather than an immediate hit on a pending message.
  const drain = await api(`/api/agents/${FAKE_ID}/inbox?wait=0`, {
    headers: { 'x-node-secret': FAKE_SECRET },
  });
  if (drain.status === 200 && (drain.body?.messages || []).length > 0) {
    await api(`/api/agents/${FAKE_ID}/inbox/ack`, {
      method: 'POST',
      headers: { 'x-node-secret': FAKE_SECRET },
      body: { ids: drain.body.messages.map((m) => m.id).filter(Boolean) },
    });
  }

  // wait=0 must return at once - a legitimate "just check, do not hold".
  const t0 = Date.now();
  const fast = await api(`/api/agents/${FAKE_ID}/inbox?wait=0`, {
    headers: { 'x-node-secret': FAKE_SECRET },
  });
  const fastMs = Date.now() - t0;
  assert.equal(fast.status, 200, `wait=0 must still work: ${JSON.stringify(fast.body)}`);
  assert.ok(fastMs < 500, `wait=0 must not hold (took ${fastMs}ms)`);

  // wait=1 must hold for about a second. Before the fix it returned in ~1ms:
  //   Math.min(parseInt('1') || 50000, 50000) === 1 MILLISECOND
  // so the agent's long-poll held for a single 250ms tick and then slept a
  // whole heartbeat -- a ~0.4% duty cycle that made every relay job wait ~30s
  // for pickup and often blew the CLI's 45s `hivv ask <bee>` timeout.
  const t1 = Date.now();
  const slow = await api(`/api/agents/${FAKE_ID}/inbox?wait=1`, {
    headers: { 'x-node-secret': FAKE_SECRET },
  });
  const slowMs = Date.now() - t1;
  assert.equal(slow.status, 200, `wait=1 must still work: ${JSON.stringify(slow.body)}`);
  assert.ok(slowMs >= 900,
    `wait=1 held only ${slowMs}ms - seconds are being read as milliseconds again`);
  assert.ok(slowMs < 5000, `wait=1 overshot badly (${slowMs}ms)`);
});

// ── 4. public node detail strips credentials ─────────────────────────────────
test('GET /api/control/nodes/:id strips secret/hw_id/token', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api(`/api/control/nodes/${FAKE_ID}`);
  assert.equal(status, 200);
  for (const k of ('secret', 'hw_id', 'token', 'auth_token')) {
    assert.equal(k in (body || {}), false,
      `node detail leaks ${k} — this endpoint is public (GETs skip control auth)`);
  }
  assert.equal(body?.node_id, FAKE_ID, 'non-credential fields must still be served');
  assert.ok('health_history' in body, 'detail fields must survive the strip');

  const list = await api('/api/control/nodes');
  assert.equal(list.status, 200);
  for (const n of list.body?.nodes || []) {
    assert.equal('secret' in n, false, 'nodes list must never expose secret');
  }
});

// ── 5. repair plan HMAC parity (sorted-compact canonical) ────────────────────
test('repair plan is signed over SORTED compact ops (bee-canonical)', async () => {
  if (!gatewayUp) return;
  const push = await api(`/api/control/agents/${FAKE_ID}/repair`, {
    method: 'POST',
    body: { ops: [{ op: 'cli_update', force: true }], ttl_s: 300,
            reason: 'e2e canonical parity' },
  });
  assert.equal(push.status, 200, `repair push: ${JSON.stringify(push.body)}`);
  assert.ok(push.body?.plan_id, 'hub must return plan_id');

  const peek = await api(`/api/agents/${FAKE_ID}/inbox/peek`, {
    headers: { 'x-node-secret': FAKE_SECRET },
  });
  assert.equal(peek.status, 200);
  const msg = (peek.body?.messages || [])
    .find(m => m.type === 'repair' && m.payload?.plan_id === push.body.plan_id);
  assert.ok(msg, 'signed plan must arrive in the bee inbox');
  const p = msg.payload;
  assert.equal(p.ts > 1e10 ? p.ts / 1000 : p.ts, Math.floor(p.ts > 1e10 ? p.ts / 1000 : p.ts),
    'ts must be a sane epoch value');

  const expected = sign(FAKE_SECRET, p.ts, p.ttl_s, CANONICAL_CLI_UPDATE);
  assert.equal(p.sig, expected,
    'hub must sign ts\\nttl\\nSORTED-compact ops (Python sort_keys parity)');
  // The 2026-11-14 bug: signing insertion order instead of sorted keys.
  const buggy = sign(FAKE_SECRET, p.ts, p.ttl_s, INSERTION_CLI_UPDATE);
  assert.notEqual(p.sig, buggy,
    'sig must depend on key ORDER — insertion-order canonical is the old bug');

  // Unknown ops are refused before anything is signed/queued.
  const bad = await api(`/api/control/agents/${FAKE_ID}/repair`, {
    method: 'POST',
    body: { ops: [{ op: 'not_an_allowed_op' }], ttl_s: 300 },
  });
  assert.equal(bad.status, 400, 'unknown op must be refused');
  const noUnit = await api(`/api/control/agents/${FAKE_ID}/repair`, {
    method: 'POST',
    body: { ops: [{ op: 'service_restart' }], ttl_s: 300 },
  });
  assert.equal(noUnit.status, 400, 'service_restart without --unit must be refused');
});

// ── 6. upgrade-reports: record, dedup, incident-on-block ─────────────────────
test('upgrade-reports: rows record+dedup; blocked known bee opens an incident', async () => {
  if (!gatewayUp) return;

  // applied → recorded, no incident
  const applied = await api('/api/hive/upgrade-reports', {
    method: 'POST',
    body: { node_id: FAKE_ID, source: 'manual', action: 'applied', verdict: 'ok',
            to_sha256: SHA_A, reason: 'e2e applied row' },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body?.incident, null, 'applied must not open an incident');

  const countRows = async () => {
    const g = await api(`/api/hive/upgrade-reports?node=${FAKE_ID}&limit=50`);
    assert.equal(g.status, 200);
    return (g.body?.reports || []).filter(r => r.to_sha256 === SHA_A).length;
  };
  const n1 = await countRows();
  assert.ok(n1 >= 1, 'applied row must be recorded');

  // identical (node, action, sha) again → report-once dedup within 24h
  await api('/api/hive/upgrade-reports', {
    method: 'POST',
    body: { node_id: FAKE_ID, source: 'manual', action: 'applied', verdict: 'ok',
            to_sha256: SHA_A, reason: 'e2e applied row' },
  });
  const n2 = await countRows();
  assert.equal(n2, n1, 'duplicate (node, action, sha) must not insert a second row');

  // blocked on a KNOWN bee → upgrade_suspicious incident
  const blocked = await api('/api/hive/upgrade-reports', {
    method: 'POST',
    body: { node_id: FAKE_ID, source: 'auto', action: 'blocked', verdict: 'suspicious',
            to_sha256: SHA_B, reason: 'e2e blocked row',
            static_findings: [{ severity: 'critical', why: 'e2e', line_no: 1, line: 'x' }],
            votes: [{ brain: 'e2e', verdict: 'suspicious', reason: 'e2e' }] },
  });
  assert.equal(blocked.status, 201);
  const active = await api('/api/control/incidents?state=active');
  assert.equal(active.status, 200);
  const inc = (active.body?.incidents || []).find(
    i => i.node_id === FAKE_ID && i.incident_type === 'upgrade_suspicious');
  assert.ok(inc, 'a blocked report on a known bee must open upgrade_suspicious');
  const resolved = await api(`/api/control/incidents/${inc.id}`, {
    method: 'PATCH',
    body: { state: 'resolved', resolution_notes: 'e2e test — resolved' },
  });
  assert.equal(resolved.status, 200);

  // blocked on an UNKNOWN bee → row only, no incident (can't attribute)
  const ghost = await api('/api/hive/upgrade-reports', {
    method: 'POST',
    body: { node_id: GHOST_ID, source: 'auto', action: 'blocked', verdict: 'suspicious',
            to_sha256: SHA_B, reason: 'e2e ghost row' },
  });
  assert.equal(ghost.status, 201);
  assert.equal(ghost.body?.incident, null,
    'unknown bees record rows but cannot open incidents');
  const activeAfter = await api('/api/control/incidents?state=active');
  const ghostInc = (activeAfter.body?.incidents || []).find(
    i => i.node_id === GHOST_ID);
  assert.equal(ghostInc, undefined, 'unknown bee must not create an incident');
});

// ── 7. cleanup: ack inbox, delete the fake node ──────────────────────────────
test('cleanup: acks inbox messages and deletes the e2e node', async () => {
  if (!gatewayUp) return;
  const peek = await api(`/api/agents/${FAKE_ID}/inbox/peek`, {
    headers: { 'x-node-secret': FAKE_SECRET },
  });
  if (peek.status === 200 && (peek.body?.messages || []).length > 0) {
    const ids = peek.body.messages.map(m => m.id).filter(Boolean);
    const ack = await api(`/api/agents/${FAKE_ID}/inbox/ack`, {
      method: 'POST',
      headers: { 'x-node-secret': FAKE_SECRET },
      body: { ids },
    });
    assert.equal(ack.status, 200, `ack failed: ${JSON.stringify(ack.body)}`);
  }

  const del = await api(`/api/control/nodes/${FAKE_ID}`, { method: 'DELETE' });
  assert.equal(del.status, 200, `delete failed: ${JSON.stringify(del.body)}`);
  assert.equal(del.body?.removed, true);

  const gone = await api(`/api/control/nodes/${FAKE_ID}`);
  assert.equal(gone.status, 404, 'deleted node must 404');

  // no leftover active upgrade incident for our node
  const active = await api('/api/control/incidents?state=active');
  const left = (active.body?.incidents || []).find(i => i.node_id === FAKE_ID);
  assert.equal(left, undefined, 'e2e node must have no active incident at exit');
});
