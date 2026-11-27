// api/tests/agent-fleet-truth.test.js — the AGENT FLEET must not be a fiction.
//
// WHY THIS FILE EXISTS
// --------------------
// Migration 003 ended with "SEED DATA: Sample Agents for Testing" and left
// 15 rows in hivv_agents (Alice, Bob, Carol, TechCorp, Code Assistant,
// Web Scraper, a Trading Bot, a Finance Agent, and so on), each with a
// hand-picked trust score and a creation timestamp frozen at 2026-09-07. A
// later development batch added 9 more. All of them sat in the PRODUCTION
// database.
//
// The public Control Center rendered them under "AGENT FLEET" beside a
// "REALTIME LIVE" badge: ten ACTIVE AGENTS, ten hand-picked trust scores,
// a SYSTEM RELATIONSHIP GRAPH of thirteen invented edges, and a pending
// intention to "Execute sell order for 1000 shares" -- none of which ever
// happened.
//
// THE LAW
//   1. A seeded sample row is SAMPLE DATA. It is never counted as an agent,
//      never counted as an authorization, never a node in the graph, and
//      never an event in the activity feed.
//   2. It is shown only when someone ASKS for it, and it is labelled.
//   3. The flag is permanent: migration 033 marks the rows once.
//
// Run with:  cd api && node --test tests/agent-fleet-truth.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'public_html');
const BASE = 'http://localhost:3011';
let gatewayUp = false;

before(async () => {
  try {
    const r = await fetch(BASE + '/api/health');
    gatewayUp = r.ok;
  } catch (_) { gatewayUp = false; }
});

function read(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

// ── the flag ───────────────────────────────────────────────────────────────

test('the migration that marks the sample rows exists and is explicit', () => {
  // Found by CONTENT, not by number: the migration number is a sequence, and
  // a concurrent session may renumber it. What matters is that ONE migration
  // adds the flag and marks the seed rows.
  const dir = path.join(REPO, 'api', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const hits = files.filter((f) =>
    /ADD COLUMN IF NOT EXISTS is_demo/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.equal(hits.length, 1,
    'exactly ONE migration may add the is_demo flag (found ' + hits.length + ')');
  const sql = fs.readFileSync(path.join(dir, hits[0]), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS is_demo/.test(sql),
    'the migration must add the is_demo flag');
  assert.ok(/SET is_demo = true/.test(sql),
    'the migration must MARK the seeded rows');
  // It must match by name AND window, so a real agent that happens to be
  // called "Carol" is never swept up.
  assert.ok(/public_name IN/.test(sql), 'the marker must name the seed rows');
  assert.ok(/created_at\s*</.test(sql), 'the marker must be bounded by the seed window');
});

test('the gateway ENSURES the flag even before the migration ran', () => {
  const src = fs.readFileSync(path.join(REPO, 'api', 'lib', 'routes', 'dashboard-routes.js'), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS is_demo/.test(src),
    'the gateway must ensure the column on a box where the migration never ran');
});

// ── the API ────────────────────────────────────────────────────────────────

test('LIVE: the fleet endpoint counts REAL registrations, not samples', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/dashboard/agents?perspective=public');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
  for (const a of j.agents) {
    assert.notEqual(a.is_demo, true,
      'the default fleet must not contain sample rows (' + a.public_name + ')');
  }
  assert.equal(typeof j.demo_total, 'number',
    'the endpoint must REPORT how many sample rows it is hiding');
});

test('LIVE: the samples are still reachable, and still labelled', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/dashboard/agents?perspective=public&demo=only');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
  for (const a of j.agents) {
    assert.equal(a.is_demo, true, a.public_name + ' must be flagged as a sample');
  }
  // A sample is still a sample: it is never silently promoted.
  const all = await fetch(BASE + '/api/dashboard/agents?perspective=public&demo=all').then((x) => x.json());
  const real = all.agents.filter((a) => !a.is_demo).length;
  assert.equal(real, j.agents.filter((a) => !a.is_demo).length,
    'demo=all must not change which rows are real');
});

test('LIVE: the relationship graph has no sample nodes or edges', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const j = await fetch(BASE + '/api/dashboard/universe-map').then((r) => r.json());
  assert.equal(j.success, true);
  for (const n of j.nodes) {
    assert.notEqual(n.is_demo, true, 'the live mesh must not contain sample nodes');
  }
  for (const e of j.edges) {
    assert.ok(e.source_agent_id && e.target_agent_id, 'every edge has two ends');
  }
});

test('LIVE: no sample event, intention or pending decision reaches the page', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const act = await fetch(BASE + '/api/dashboard/activity?limit=100').then((r) => r.json());
  for (const e of act.events || []) {
    assert.notEqual(e.is_demo, true, 'a sample tool call is not activity');
  }
  const intents = await fetch(BASE + '/api/dashboard/intentions').then((r) => r.json());
  for (const i of intents.intentions || []) {
    assert.notEqual(i.is_demo, true, 'a sample intention is not a pending action');
  }
  const maybe = await fetch(BASE + '/api/dashboard/maybe-machine').then((r) => r.json());
  const pending = maybe.pending_intentions || maybe.intentions || [];
  for (const i of pending) {
    assert.notEqual(i.is_demo, true, 'a sample intention is not awaiting a human');
  }
});

test('LIVE: a sample row cannot be paused into looking real', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const j = await fetch(BASE + '/api/dashboard/agents?perspective=public&demo=only').then((r) => r.json());
  if (!j.agents.length) { t.skip('no sample rows on this box'); return; }
  const id = j.agents[0].id;
  const r = await fetch(BASE + '/api/dashboard/agents/' + id + '/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'no' }),
  });
  // Unauthenticated writes are refused anyway; with a session they must be
  // refused as a SAMPLE, never applied.
  assert.ok(r.status === 401 || r.status === 409,
    'a sample row must not be mutable (got ' + r.status + ')');
});

// ── the PAGE ───────────────────────────────────────────────────────────────

test('the Control Center labels the sample rows and never counts them', () => {
  const html = read('hivv-dashboard.html');
  assert.ok(/demo=exclude/.test(html), 'the fleet must ask for the REAL agents');
  assert.ok(/demo_total/.test(html), 'the page must read the sample count');
  assert.ok(/SAMPLE/.test(html), 'a sample row must be labelled SAMPLE');
  assert.ok(/is_demo/.test(html), 'the page must know which rows are samples');
  // The counters must skip the samples even when the samples are on screen.
  assert.ok(/filter\(a => !a\.is_demo\)/.test(html),
    'the counters must never count a sample row');
  assert.ok(/toggleDemoAgents/.test(html), 'the sample rows must be behind a toggle');
  // The button calls a handler; the script is one IIFE, so the handler has
  // to be on window or the button is dead.
  assert.ok(/window\.toggleDemoAgents/.test(html),
    'the toggle handler must be exported on window or the button does nothing');
});

test('the seed data is not published anywhere else as live', () => {
  // The other agent list must not sweep the ownerless sample rows in.
  const src = fs.readFileSync(path.join(REPO, 'api', 'lib', 'routes', 'hivv-routes.js'), 'utf8');
  assert.ok(/is_demo = false/.test(src),
    '/api/hivv/agents must exclude the sample rows (they have no owner)');
});
