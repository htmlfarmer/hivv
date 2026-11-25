// api/tests/horizon.test.js — pins the physical-horizon layer:
//   1. classification (within / beyond / unverifiable) — the warning vocabulary
//   2. haversine + the FIXED reference (setHubLoc)
//   3. the ping floor: ~1 foot per nanosecond, round trip x2 — physics as
//      evidence (impossible claims vs proven-within neighbors)
//   4. forAnsweredBy — server-side classification from X-Hivv-Answered-By
//   5. LIVE: the header exists on a real answer AND the verdict is SIGNED
//      into the receipt (unstrippable warning)
//
// Run with:  cd api && node --test tests/horizon.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const horizon = require('../lib/horizon');

const BASE = 'http://localhost:3011';
let gatewayUp = false;

before(async () => {
  try {
    const r = await fetch(BASE + '/api/health');
    gatewayUp = r.ok;
  } catch (_) { gatewayUp = false; }
});

// ── classification ──────────────────────────────────────────────────────────

test('classify: the warning vocabulary', () => {
  assert.equal(horizon.classify({ isLocal: true }).status, 'within');
  assert.equal(horizon.classify({ isPeer: false }).status, 'beyond'); // cloud
  assert.equal(horizon.classify({ isPeer: true, isPrivatePath: true }).status, 'unverifiable');
  assert.equal(horizon.classify({ isPeer: true }).status, 'unverifiable'); // no location
  const near = horizon.classify({
    isPeer: true,
    nodeLoc: { lat: 46.7331, lon: -116.9899 },
    hubLoc: { lat: 46.74, lon: -116.99 },
    miles: 5,
  });
  assert.equal(near.status, 'within');
  const far = horizon.classify({
    isPeer: true,
    nodeLoc: { lat: 34.05, lon: -118.24 },   // LA
    hubLoc: { lat: 46.7331, lon: -116.9899 }, // Idaho
    miles: 5,
  });
  assert.equal(far.status, 'beyond');
  assert.match(far.reason, /miles from the hive core/);
  assert.equal(horizon.header(near).startsWith('within'), true);
});

test('haversine: NYC -> LA is ~2450 miles', () => {
  const d = horizon.haversineMiles({ lat: 40.71, lon: -74.01 }, { lat: 34.05, lon: -118.24 });
  assert.ok(d > 2400 && d < 2500, 'got ' + d);
  assert.equal(horizon.haversineMiles(null, { lat: 1, lon: 1 }), null);
});

test('setHubLoc: the fixed reference point sticks', () => {
  horizon.setHubLoc({ lat: 46.7331, lon: -116.9899 });
  assert.deepEqual(horizon.getHubLoc(), { lat: 46.7331, lon: -116.9899 });
  // a located peer without explicit hubLoc now measures against the core
  const v = horizon.classify({ isPeer: true, nodeLoc: { lat: 46.74, lon: -116.99 } });
  assert.equal(v.status, 'within');
});

// ── the ping floor (physics) ───────────────────────────────────────────────

test('ping floor: ~1 ft/ns — 5 miles needs >= 52,800ns round trip', () => {
  assert.equal(horizon.impliedMiles(52800), 5);          // exact at 1 ft/ns
  assert.ok(horizon.impliedMiles(105600) === 10);        // 10 mi at 100us
  assert.equal(horizon.impliedMiles(0), null);
});

test('proveHorizon: impossible vs proven-within vs inconclusive', () => {
  // a node claiming 3 miles answering in 20us is faster than physics
  const lie = horizon.proveHorizon({ minRttNs: 20000, claimedMiles: 3 });
  assert.equal(lie.verdict, 'impossible');
  assert.match(lie.note, /faster than physics/);

  // 40us on the home LAN proves distance <= ~3.8mi — WITHIN a 5mi horizon
  const proof = horizon.proveHorizon({ minRttNs: 40000 });
  assert.equal(proof.verdict, 'proven-within');
  assert.ok(proof.implied_miles < 5);

  // a normal internet ping proves nothing (10ms implies <= ~947mi)
  const vague = horizon.proveHorizon({ minRttNs: 10000000 });
  assert.equal(vague.verdict, 'inconclusive');
  assert.equal(horizon.proveHorizon({}).verdict, 'inconclusive');
});

// ── answered-by classification ─────────────────────────────────────────────

test('forAnsweredBy: localhost / bee path / cloud', () => {
  assert.equal(horizon.forAnsweredBy('localhost/gemma (direct)').status, 'within');
  const bee = horizon.forAnsweredBy('ashy/gemma (direct)', {
    ip: '192.168.1.5', location: { lat: 46.73, lon: -116.98 },
  });
  assert.equal(bee.status, 'unverifiable', 'private LAN address = unverifiable');
  const publicBee = horizon.forAnsweredBy('masjid/qwen (direct)', {
    ip: '203.0.113.9', location: { lat: 46.73, lon: -116.98 },
  });
  assert.ok(publicBee.status === 'within' || publicBee.status === 'beyond');
  assert.equal(horizon.forAnsweredBy('openai/gpt-4o (cloud)').status, 'beyond');
  // no node suffix and no lookup: classified as outside (beyond) — a
  // warning either way, which is the point
  assert.equal(horizon.forAnsweredBy('mystery/node', null).status, 'beyond');
});

test('isPrivateIp: RFC1918 + friends', () => {
  assert.equal(horizon.isPrivateIp('192.168.1.1'), true);
  assert.equal(horizon.isPrivateIp('10.0.0.7'), true);
  assert.equal(horizon.isPrivateIp('172.16.0.1'), true);
  assert.equal(horizon.isPrivateIp('100.64.0.1'), true);   // CGNAT
  assert.equal(horizon.isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(horizon.isPrivateIp('203.0.113.9'), false);
});

// ── live ───────────────────────────────────────────────────────────────────

test('live: an answer carries X-Hivv-Horizon AND the signed verdict in the receipt', async () => {
  if (!gatewayUp) return;
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-visitor-id': 'horizon-e2e' },
    body: JSON.stringify({ message: 'reply with one word: horizon', stream: false }),
  });
  const bodyText = await res.text();
  if (!res.headers.get('x-hivv-answered-by')) return; // no bee answered — nothing to classify

  const hor = res.headers.get('x-hivv-horizon');
  assert.ok(hor, 'every answer must carry the horizon verdict');
  assert.match(hor, /^(within|beyond|unverifiable);/);

  const rcpt = res.headers.get('x-hivv-receipt');
  if (rcpt) {
    const receipt = JSON.parse(Buffer.from(rcpt, 'base64').toString('utf8'));
    assert.equal(receipt.statement.horizon, hor.split(';')[0],
      'the verdict inside the SIGNATURE must match the header');
    // verify it really is hub-signed with the published key
    const hubKey = await (await fetch(BASE + '/api/identity/hub-key')).json();
    const v = await (await fetch(BASE + '/api/identity/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receipt),
    })).json();
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(v.principal, hubKey.principal);
  }
  assert.ok(bodyText.length > 0);
});
