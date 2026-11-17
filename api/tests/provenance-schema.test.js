// api/tests/provenance-schema.test.js — SQL/schema contract checks.
//
// The provenance tables are created in code (request-provenance.js) AND in a
// migration file (018_request_provenance.sql). These tests make sure the two
// definitions cannot drift silently, and that the SQL is injection-safe.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const prov = require('../lib/request-provenance');

const MIGRATION = path.join(__dirname, '..', 'migrations', '018_request_provenance.sql');

test('migration file exists and covers the same tables', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.ok(sql.includes('hivv_request_provenance'));
  assert.ok(sql.includes('hivv_node_provenance_stats'));
  assert.ok(sql.includes('hivv_provenance_daily'));
});

test('every column in the code schema appears in the migration', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const row = prov.buildRow({ request_id: 'r', endpoint: '/api/chat' });
  for (const col of Object.keys(row)) {
    assert.ok(
      new RegExp(`\\b${col}\\b`).test(sql),
      `migration is missing column: ${col}`
    );
  }
});

test('provenance tables are NOT in the public database browser whitelist', () => {
  const dbRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'database-routes.js'), 'utf8');
  assert.ok(!dbRoutes.includes('hivv_request_provenance'), 'request provenance must stay private');
  assert.ok(!dbRoutes.includes('hivv_review_registry'), 'review registry must stay private');
});

test('no raw secret material is stored in the review registry schema', () => {
  const registry = fs.readFileSync(path.join(__dirname, '..', 'lib', 'review-registry.js'), 'utf8');
  // Contact fields are allowed, but there must be a *_hash column next to them
  // and no column that stores a raw secret/token/password.
  assert.ok(registry.includes('account_email_hash'));
  assert.ok(registry.includes('account_phone_hash'));
  assert.ok(registry.includes('public_ip_hash'));
  assert.ok(!/api[_-]?key\s+TEXT/i.test(registry), 'must not store API keys');
});

test('buildRow produces SQL-safe bounded values', () => {
  const row = prov.buildRow({
    request_id: 'x'.repeat(500),
    endpoint: 'e'.repeat(500),
    user_agent: 'u'.repeat(5000),
    model: 'm'.repeat(1000),
    error_message: 'z'.repeat(5000),
    endpoint: '/api/chat',
  });
  assert.ok(row.request_id.length <= 120);
  assert.ok(row.endpoint.length <= 120);
  assert.ok(row.user_agent.length <= 400);
  assert.ok(row.model.length <= 160);
  assert.ok(row.error_message.length <= 1000);
});

test('no SQL injection through user-controlled identifier fields', () => {
  const row = prov.buildRow({
    request_id: "'; DROP TABLE users; --",
    endpoint: "'; DELETE FROM usage_logs; --",
    endpoint2: null,
  });
  // Values are parameterized in the INSERT, but they must also be bounded and
  // free of control characters so logs and dashboards stay sane.
  assert.ok(!/[\u0000-\u001f]/.test(row.request_id));
  assert.ok(row.request_id.length <= 120);
});
