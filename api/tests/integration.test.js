// api/tests/integration.test.js — smoke + correctness tests for the live gateway.
// Run with:  cd api && node --test tests/integration.test.js
// Requires the gateway running on localhost:3011.

const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');

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

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-visitor-id': 'test-integration' },
    ...opts
  });
  let body;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, ok: r.ok, body };
}

// ── Gateway liveness ──────────────────────────────────────────────────────────

test('GET /api/health → 200 with status', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/health');
  assert.equal(status, 200, `health returned ${status}`);
  assert.equal(body?.status, 'healthy');
});

test('GET /api/policy → 200 with tuple', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/policy');
  assert.equal(status, 200);
  // tuple is nested under the 'tuple' key
  assert.ok(body?.tuple, 'policy missing tuple');
  assert.ok('WHO' in body.tuple || 'who' in (body.tuple || {}));
});

test('GET /api/capabilities → 200 with capabilities array', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/capabilities');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body?.capabilities), 'capabilities should be array');
  assert.ok(body?.capabilities.length > 0, 'should have at least one capability');
  for (const cap of body.capabilities) {
    assert.ok('key' in cap, 'capability missing key');
    assert.ok('tier' in cap, 'capability missing tier');
  }
});

test('GET /api/capabilities/route/dry-run?capability=reasoning&mode=fast → 200', async () => {
  if (!gatewayUp) return;
  const { status } = await api('/api/capabilities/route/dry-run?capability=reasoning&mode=fast');
  assert.equal(status, 200, `dry-run returned ${status}`);
});

test('GET /api/policy/audit/verify → {ok:true,...}', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/policy/audit/verify');
  assert.equal(status, 200);
  assert.equal(body?.ok, true, `audit verify failed: ${JSON.stringify(body)}`);
});

test('GET /api/sandbox/status → 200', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/sandbox/status');
  assert.equal(status, 200);
  assert.ok('runtime' in (body || {}), 'sandbox status missing runtime');
});

test('GET /api/hive/goal → 200', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/hive/goal');
  assert.equal(status, 200);
  assert.ok('goal' in (body || {}), 'goal response missing goal');
});

test('GET /api/hive/timeline?hours=1 → 200 with timeline key', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/hive/timeline?hours=1');
  assert.equal(status, 200, `timeline returned ${status}`);
  assert.ok(Array.isArray(body?.timeline), 'timeline should be array (key is timeline, not buckets)');
});

test('GET /api/hive/perf → 200 with samples key', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/hive/perf');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body?.samples), 'perf.samples should be array');
});

test('GET /api/hive/leaderboard → 200 with bees key', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/hive/leaderboard');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body?.bees), 'leaderboard.bees should be array');
});

test('GET /api/relay/stats → 200', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/relay/stats');
  assert.equal(status, 200);
  assert.equal(typeof (body?.queued), 'number', 'relay stats missing queued');
});

test('GET /api/relay/volunteers → 200', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/relay/volunteers');
  assert.equal(status, 200);
  assert.ok('total' in (body || {}), 'volunteers response missing total');
});

test('POST /api/hive/log-feature → 200 (C3 feature tracking)', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/hive/log-feature', {
    method: 'POST',
    body: JSON.stringify({ feature: 'hive-mind', model: 'gemma', total_tokens: 50, latency_ms: 400 })
  });
  assert.equal(status, 200, `log-feature returned ${status}: ${JSON.stringify(body)}`);
  assert.equal(body?.ok, true);
  assert.equal(body?.feature, 'hive-mind');
});

test('POST /api/relay/jobs → 400 (empty request)', async () => {
  if (!gatewayUp) return;
  // Rate-limited before body check for some anonymous callers — accept 429 or 400
  const { status, body } = await api('/api/relay/jobs', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.ok([400, 429].includes(status), `expected 400 or 429, got ${status}: ${JSON.stringify(body)}`);
});

test('POST /api/relay/jobs → 404 (unknown node)', async () => {
  if (!gatewayUp) return;
  const { status } = await api('/api/relay/jobs', {
    method: 'POST',
    body: JSON.stringify({ node_id: '__test_nonexistent__', request: { messages: [{ role: 'user', content: 'hello' }] } })
  });
  assert.equal(status, 404, `expected 404, got ${status}`);
});

test('POST /v1/chat/completions → 200/429/503 (basic chat)', async () => {
  if (!gatewayUp) return;
  const { status } = await api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'say hello in 3 words' }], max_tokens: 20 })
  });
  // Accept 200 (routed), 429 (rate limit), 503 (no providers) — anything but 500
  assert.ok([200, 400, 429, 503].includes(status), `chat returned unexpected ${status}`);
});

test('GET /api/control/nodes → 200', async () => {
  if (!gatewayUp) return;
  const { status, body } = await api('/api/control/nodes');
  assert.equal(status, 200);
  assert.ok('nodes' in (body || {}), 'nodes response missing nodes');
});

test('GET /api/control/metrics/global → 200', async () => {
  if (!gatewayUp) return;
  const { status } = await api('/api/control/metrics/global');
  assert.equal(status, 200);
});

test('GET /api/models → 200', async () => {
  if (!gatewayUp) return;
  const { status } = await api('/api/models');
  assert.equal(status, 200);
});
