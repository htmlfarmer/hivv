// api/tests/request-provenance.test.js — privacy + SQL-shape contract tests.
//
// These do NOT need a live database: they exercise the pure row builder and
// the SQL text so a schema/parameter mismatch is caught in CI.

const test = require('node:test');
const assert = require('node:assert');
const prov = require('../lib/request-provenance');

test('buildRow records WHO / WHAT / WHERE / WHEN / COST', () => {
  const row = prov.buildRow({
    request_id: 'req_1',
    endpoint: '/v1/chat/completions',
    method: 'post',
    feature: 'chat',
    user_id: 42,
    anonymous_visitor_id: 'vis_abc',
    ip_address: '203.0.113.9',
    user_agent: 'test-agent',
    request_sha256: 'a'.repeat(64),
    input_bytes: 100,
    output_bytes: 200,
    input_tokens: 10,
    output_tokens: 20,
    provider: 'local',
    model: 'gemma-4-E2B-it-Q4_K_M',
    answered_by: 'ashy/gemma (direct)',
    answered_by_node: 'ashy',
    transport: 'direct',
    route_mode: 'quality',
    capability: 'coding',
    worker: {
      node_id: 'ashy',
      hostname: 'ashy.local',
      public_ip: '198.51.100.5',
      lan_ip: '192.168.1.5',
      network_class: 'residential',
      trace_route: [{ ttl: 1, address: '192.168.1.1', rtt_ms: 1.5 }],
      rtt_ms: 12.5,
    },
    location: { lat: 37.7749295, lon: -122.419416, region: 'California', country_code: 'us', isp: 'Test ISP', asn: 'AS64500' },
    started_at_ms: 1700000000000,
    completed_at_ms: 1700000002500,
    ttfb_ms: 900,
    cost_usd: 0.0123,
    resource_cost_usd: 0.001,
    privacy: { privacy_class: 'public', share_hostname: true, share_public_ip: true, share_trace_route: true, share_exact_location: true },
  });

  assert.equal(row.request_id, 'req_1');
  assert.equal(row.endpoint, '/v1/chat/completions');
  assert.equal(row.method, 'POST');
  assert.equal(row.user_id, 42);
  assert.equal(row.anonymous_visitor_id, 'vis_abc');
  assert.equal(row.ip_address_hash.length, 64);
  assert.equal(row.answered_by_node, 'ashy');
  assert.equal(row.transport, 'direct');
  assert.equal(row.duration_ms, 2500);
  assert.equal(row.ttfb_ms, 900);
  assert.equal(row.cost_usd, 0.0123);
  assert.equal(row.resource_cost_usd, 0.001);
  assert.equal(row.worker_hostname, 'ashy.local');
  assert.equal(row.worker_public_ip, '198.51.100.5');
  assert.ok(row.trace_route);
  assert.equal(row.total_tokens, 10);
});

test('private rows never expose hostname / IP / trace', () => {
  const row = prov.buildRow({
    request_id: 'req_2',
    endpoint: '/api/chat',
    worker: {
      node_id: 'ashy',
      hostname: 'secret-host',
      public_ip: '198.51.100.5',
      trace_route: [{ ttl: 1, address: '10.0.0.1' }],
    },
    location: { lat: 37.7749295, lon: -122.419416 },
    privacy: { privacy_class: 'private' },
  });
  assert.equal(row.worker_hostname, null);
  assert.equal(row.worker_public_ip, null);
  assert.equal(row.trace_route, null);
  // Coarse geo is always safe-ish and rounded.
  assert.equal(row.latitude, 37.77);
  assert.equal(row.longitude, -122.42);
  // Hashes still exist so ops can correlate without reading the raw value.
  assert.equal(row.worker_public_ip_hash.length, 64);
});

test('coordinates are rounded to ~1.1 km', () => {
  const row = prov.buildRow({
    request_id: 'req_3',
    endpoint: '/api/chat',
    location: { lat: 37.7749295, lon: -122.419416 },
  });
  assert.equal(row.latitude, 37.77);
  assert.equal(row.longitude, -122.42);
});

test('sealed rows hide ISP and margin', () => {
  const row = prov.buildRow({
    request_id: 'req_4',
    endpoint: '/api/chat',
    location: { isp: 'Secret ISP' },
    margin_usd: 5,
    privacy: { privacy_class: 'sealed' },
  });
  assert.equal(row.isp, null);
  assert.equal(row.margin_usd, null);
});

test('operator projection exposes the private half; public does not', () => {
  const row = {
    request_id: 'r', endpoint: '/api/chat', method: 'POST', status: 'success',
    success: true, ip_address: '203.0.113.9', ip_address_hash: 'h'.repeat(64),
    user_id: 7, principal: 'user:7', worker_hostname: 'host',
    worker_public_ip: '198.51.100.5', latitude: 37.77, longitude: -122.42,
    isp: 'ISP', trace_route: '[]', margin_usd: 3, user_agent: 'ua',
    request_sha256: 's'.repeat(64), error_message: 'boom', error_code: 'E',
    answered_by_node: 'n', model: 'm', provider: 'p', duration_ms: 5,
    privacy_class: 'private',
  };
  const pub = prov.project(row, 'public');
  assert.equal(pub.ip_address, undefined);
  assert.equal(pub.worker_hostname, undefined);
  assert.equal(pub.trace_route, undefined);
  assert.equal(pub.margin_usd, undefined);

  const op = prov.project(row, 'operator');
  assert.equal(op.ip_address, '203.0.113.9');
  assert.equal(op.worker_hostname, 'host');
  assert.equal(op.margin_usd, 3);
});

test('privacy normalization defaults to private and refuses over-sharing', () => {
  const p = prov.normalizePrivacy({ privacy_class: 'public', share_contact: true, share_trace_route: true, share_internal_margin: true });
  assert.equal(p.privacy_class, 'public');
  assert.equal(p.share_contact, true);
  assert.equal(p.share_trace_route, true);
  // Internal margin never leaks, not even from a 'public' class.
  assert.equal(p.share_internal_margin, false);

  const q = prov.normalizePrivacy({ privacy_class: 'bogus' });
  assert.equal(q.privacy_class, 'private');
});

test('request digest is stable and does not expose the payload', () => {
  const a = prov.sha256('hello');
  const b = prov.sha256('hello');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, prov.sha256('hello2'));
});
