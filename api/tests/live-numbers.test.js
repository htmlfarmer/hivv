// api/tests/live-numbers.test.js — the site must never lie about the hive.
//
// WHY THIS FILE EXISTS
// --------------------
// The website used to bake its numbers into the HTML: "3 bees", "64 TOK/S",
// "~27 KB", "23 providers", "85% allowance", a chart of Math.random(), and
// NINE invented map markers in San Francisco / New York / London / Paris.
// The API was worse: it answered "+12845 agents", "+894520 actions",
// "+340 nodes online" — so a page that fetched the truth still rendered a
// lie.
//
// THE LAW (enforced here):
//   1. Every number that claims to describe NOW is MEASURED.
//   2. One endpoint is the source of truth: /api/hivv/stats.
//   3. Pages declare their numbers (data-hivv-stat) instead of typing them.
//   4. "no data" is null, never 0.
//
// Run with:  cd api && node --test tests/live-numbers.test.js

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

// Comments are where we EXPLAIN what the fabrication used to be, so they
// mention the old numbers on purpose. The law applies to CODE: strip the
// prose before asking whether a number is baked in.
function readCode(rel) {
  // 'api/...' and 'public_html/...' are repo paths; anything else is a
  // page under public_html.
  const abs = /^(api|public_html|scripts|tests)\//.test(rel)
    ? path.join(REPO, rel)
    : path.join(PUBLIC, rel);
  return fs.readFileSync(abs, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')          // html comments
    .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // line comments (keep http://)
}

// ── the ONE endpoint ───────────────────────────────────────────────────────

test('LIVE: /api/hivv/stats answers with every number the site shows', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  for (const door of ['/api/hivv/stats', '/api/hive/stats']) {
    const r = await fetch(BASE + door);
    assert.equal(r.status, 200, door + ' must answer');
    const j = await r.json();
    assert.equal(j.ok, true, door + ' must be ok');
    for (const key of ['bees', 'models', 'capacity', 'performance', 'honey', 'bridge', 'gateway']) {
      assert.ok(j[key], door + ' must carry ' + key);
    }
    assert.equal(typeof j.bees.online, 'number', 'bees.online is a number');
    assert.equal(typeof j.bees.registered, 'number', 'bees.registered is a number');
    assert.ok(j.bees.online <= j.bees.registered, 'online cannot exceed registered');
    assert.equal(j.bees.registered, j.bees.online + j.bees.offline, 'the roster adds up');
    assert.equal(typeof j.performance.requests_today, 'number');
    assert.equal(typeof j.models.providers_active, 'number');
  }
});

test('LIVE: both brand doors serve the SAME numbers', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const [a, b] = await Promise.all([
    fetch(BASE + '/api/hivv/stats').then((r) => r.json()),
    fetch(BASE + '/api/hive/stats').then((r) => r.json()),
  ]);
  assert.deepEqual(a.bees, b.bees, '/api/hivv and /api/hive must not disagree');
  assert.deepEqual(a.performance, b.performance, '/api/hivv and /api/hive must not disagree');
});

test('LIVE: the hub publishes where it actually is (the maps used to hard-code it)', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/public/status');
  const j = await r.json();
  assert.ok(j.hub, '/api/public/status must publish the hub location');
  assert.equal(typeof j.hub.lat, 'number');
  assert.equal(typeof j.hub.lon, 'number');
});

// ── the ORCHESTRATOR: a dead bee is not an online bee ─────────────────────

test('a bee whose heartbeat expired is NOT counted as online', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const nodes = await fetch(BASE + '/api/control/nodes').then((r) => r.json());
  const now = Date.now();
  const fresh = nodes.nodes.filter((n) => n.heartbeat_age_s != null && n.heartbeat_age_s <= 180);
  const stale = nodes.nodes.filter((n) => n.heartbeat_age_s != null && n.heartbeat_age_s > 180);
  assert.equal(nodes.online, fresh.length,
    'the online count must be the bees that heartbeated recently (a rehydrated ' +
    "'stale' roster used to count week-old boxes as alive)");
  for (const n of stale) {
    assert.notEqual(n.status, 'online', n.id + ' has not spoken in ' + n.heartbeat_age_s + 's');
  }
  void now;
});

test('the orchestrator exposes one isLive() truth for every counting site', () => {
  const src = fs.readFileSync(path.join(REPO, 'api', 'lib', 'orchestrator.js'), 'utf8');
  assert.ok(/isLive\s*\(node/.test(src), 'orchestrator.isLive must exist');
  // Every place that COUNTS online bees must ask the heartbeat, not the label.
  const counters = [
    'api/routes/control-routes.js',
    'api/routes/honey-routes.js',
    'api/routes/mcp-routes.js',
    'api/routes/partner-routes.js',
    'api/routes/tool-routes.js',
    'api/routes/telemetry-routes.js',
    'api/lib/capabilities.js',
  ];
  for (const c of counters) {
    const s = fs.readFileSync(path.join(REPO, c), 'utf8');
    // Every line that mentions the 'offline' LABEL must ALSO ask the
    // heartbeat (isLive) - otherwise it counts a week-old bee as alive.
    const offenders = s.split('\n').filter((l) =>
      /status\s*!==\s*'offline'/.test(l) && !/isLive/.test(l));
    assert.equal(offenders.length, 0,
      c + ' still counts bees by their status LABEL: ' + offenders.join(' | '));
    assert.ok(/isLive/.test(s), c + ' must ask the heartbeat (isLive) for the online count');
  }
});

// ── the API must not INVENT numbers ────────────────────────────────────────

test('the API never fabricates a count', () => {
  const src = readCode('api/lib/routes/hivv-routes.js');
  // These offsets used to make a 6-bee hive report 12,847 agents,
  // 894,525 actions and 341 online nodes.
  for (const lie of ['12845', '894520', '3400', '+ 340', '+ 342', '+ 298']) {
    assert.ok(!src.includes(lie),
      'hivv-routes.js still contains the fabricated offset "' + lie + '"');
  }
  assert.ok(/realHiveCounts/.test(src), 'the real measurement helper must be used');
});

test('no page multiplies a count to invent another one', () => {
  for (const p of ['system.html', 'index.html', 'command-center.html', 'live/index.html', 'nodes.html']) {
    const html = readCode(p);
    assert.ok(!/nodes_count\s*\*\s*\d/.test(html),
      p + ' multiplies a count to manufacture one');
  }
});

// ── the PAGES must declare their numbers, not type them ───────────────────

const PAGES_WITH_LIVE_NUMBERS = [
  'index.html', 'cli.html', 'api.html', 'veil/index.html',
  'system.html', 'live/index.html', 'map/index.html',
];

test('the pages that show numbers declare them (data-hivv-stat), not type them', () => {
  for (const p of PAGES_WITH_LIVE_NUMBERS) {
    const html = read(p);
    assert.ok(/data-hivv-stat=/.test(html), p + ' must bind its numbers to /api/hivv/stats');
  }
  assert.ok(/data-hivv-stat=/.test(read('system.html')), 'system.html must bind its numbers too');
});

test('the shared binding exists and every page that uses it loads it', () => {
  const js = path.join(PUBLIC, 'js', 'hivv-live.js');
  assert.ok(fs.existsSync(js), 'public_html/js/hivv-live.js must exist');
  const src = fs.readFileSync(js, 'utf8');
  assert.ok(/\/api\/hivv\/stats/.test(src), 'the binding must read the canonical endpoint');
  for (const p of PAGES_WITH_LIVE_NUMBERS) {
    const html = read(p);
    if (/data-hivv-stat=/.test(html)) {
      assert.ok(html.includes('hivv-live.js'), p + ' uses data-hivv-stat but never loads the binding');
    }
  }
});

test('the MAIN PANEL (the nav bee pill) is live-bound', () => {
  const html = read('index.html');
  assert.ok(/id="hivv-bee-pill"[^>]*data-hivv-pill/.test(html),
    'the nav pill must carry data-hivv-pill');
  assert.ok(/data-hivv-pill-count/.test(html), 'the pill needs a count slot');
  assert.ok(/data-hivv-pill-dot/.test(html), 'the pill needs a live status dot');
  // The pill must NOT carry a typed number any more.
  const pill = html.match(/<a[^>]*id="hivv-bee-pill"[^>]*>[\s\S]*?<\/a>/);
  assert.ok(pill, 'the pill must be findable');
  assert.ok(!/\d+\/\d+/.test(pill[0]),
    'the pill must not carry a hard-coded "3/6" - the count is measured');
});

test('the homepage charts are fed by measurements, not by chance', () => {
  const html = readCode('index.html');
  assert.ok(!/Math\.random\(\)\s*\*\s*\d/.test(html),
    'the throughput chart must not draw random bars');
  assert.ok(html.includes('/api/hive/timeline'), 'the charts read the measured timeline');
  assert.ok(!html.includes('~64 tok/s'), 'no hard-coded "~64 tok/s" label');
  assert.ok(!/Peak 64\.2/.test(html), 'no hard-coded "Peak 64.2"');
});

test('the map shows the hive, not an invented city', () => {
  const html = readCode('index.html');
  assert.ok(!html.includes('MCP Bridge 1'), 'the invented "MCP Bridge 1" marker must be gone');
  assert.ok(!html.includes('Community Pool'), 'the invented "Community Pool" marker must be gone');
  assert.ok(!html.includes('throughput: 64'), 'no invented throughput on a map marker');
  const map = readCode('map/index.html');
  assert.ok(!/const HIVV = \[/.test(map),
    'the map must not hard-code the hub coordinates');
  assert.ok(map.includes('s.hub'), 'the map reads the hub location from the API');
});

test('no page claims a fixed provider count or a fixed allowance', () => {
  assert.ok(!/23 providers/.test(readCode('cli.html')), 'cli.html still says "23 providers"');
  assert.ok(!/~27 KB/.test(readCode('cli.html')), 'cli.html still says "~27 KB"');
  assert.ok(!/~27 KB/.test(readCode('index.html')), 'index.html still says "~27 KB"');
  assert.ok(!/85% allowance/.test(readCode('veil/index.html')), 'veil still says "85% allowance"');
  assert.ok(!/supervised 85%/.test(readCode('live/index.html')), 'live still says "supervised 85%"');
  assert.ok(!/\|\| 847/.test(readCode('hivv-page.html')), 'hivv-page still fabricates 847 actions');
});

test('every script tag on the pages is closed (an unclosed one kills the page)', () => {
  for (const p of ['index.html', 'map/index.html', 'live/index.html', 'cli.html', 'api.html',
    'command-center.html', 'system.html', 'veil/index.html', 'dashboard.html', 'aihub.html']) {
    const html = read(p);
    const opens = (html.match(/<script\b/gi) || []).length;
    const closes = (html.match(/<\/script\s*>/gi) || []).length;
    assert.equal(opens, closes, p + ' has ' + opens + ' <script> and ' + closes + ' </script>');
  }
});

// ── the GitHub door (the CSP blocks the browser from GitHub) ────────────

test('LIVE: the GitHub proxy answers, and it is not an open proxy', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/github/issues');
  assert.equal(r.status, 200, 'the issues door must answer');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.issues), 'issues must be an array');

  // The avatar door must REFUSE anything that is not a github image.
  for (const bad of ['https://example.com/x.png', 'http://avatars.githubusercontent.com/u/1',
    'file:///etc/passwd', 'https://avatars.githubusercontent.com.evil.com/u/1']) {
    const a = await fetch(BASE + '/api/github/avatar?u=' + encodeURIComponent(bad));
    assert.notEqual(a.status, 200, 'must refuse ' + bad);
  }
});

test('no page talks to GitHub straight from the browser (the CSP forbids it)', () => {
  for (const p of ['bugs/index.html', 'contributors.html']) {
    const html = readCode(p);
    assert.ok(!/fetch\(\s*['"]https:\/\/api\.github\.com/.test(html),
      p + ' still fetches GitHub from the browser - the CSP blocks it');
    assert.ok(!/src=["']https:\/\/avatars\.githubusercontent\.com/.test(html),
      p + ' still loads a github avatar directly - the CSP blocks it');
  }
});

// ── the binding itself ─────────────────────────────────────────────────────

test('the binding: null is no data, never a zero', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'hivv-live.js'), 'utf8');
  assert.ok(/data-hivv-default/.test(src), 'no-data elements need a default slot');
  assert.ok(/data-hivv-state/.test(src), 'the binding must mark nodata vs ok');
  // A failed fetch must NOT leave the last number frozen on screen.
  assert.ok(/nodata/.test(src));
});
