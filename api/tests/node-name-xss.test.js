// api/tests/node-name-xss.test.js — a bee's name must never be markup.
//
// WHAT HAPPENED
// --------------
// POST /api/nodes/register took `name` straight from the request body into
// registerNode with no cleaning, and three render sites put it into
// innerHTML raw:
//
//   index.html          renderProviderRings() — fed realNodes, but the
//                       parameter is called `providers`, so p.name was
//                       interpolated unescaped
//   command-center.html  3 sites (a Leaflet popup, a card, the node list)
//                       while _hEsc WAS used for the version field on the
//                       same line — the author knew, and missed this one
//
// Reproduced end-to-end against the live gateway: registering
//   { "name": "<img src=x onerror=\"document.title='XSS-FIRED'\">..." }
// changed document.title on BOTH the homepage and the Command Center. An
// unauthenticated visitor's browser, on a public page, no interaction.
//
// THE FIX, in two layers
//   1. boundary — registerNode() strips < and > (what make a tag) and
//      control characters, caps the length. One choke point, so a new render
//      site cannot reopen the hole.
//   2. render   — every site escapes anyway. The boundary must not be the
//      only line of defense.
//
// Run with:  cd api && node --test tests/node-name-xss.test.js

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

const PAYLOAD = '<img src=x onerror="document.title=String.fromCharCode(88,83,83)">';

// ── the boundary ───────────────────────────────────────────────────────────

test('registerNode strips markup out of a node name', () => {
  const src = fs.readFileSync(path.join(REPO, 'api', 'lib', 'orchestrator.js'), 'utf8');
  const i = src.indexOf('registerNode(nodeData)');
  assert.ok(i > 0, 'registerNode must exist');
  const body = src.slice(i, i + 1200);
  assert.ok(/\.replace\(\/\[<>\]/.test(body),
    'registerNode must strip angle brackets — that is what makes a tag');
  assert.ok(/\.slice\(0,\s*64\)/.test(body),
    'registerNode must cap the name length');
});

test('the boundary runs, not just the comment', async () => {
  const Orchestrator = require(path.join(REPO, 'api', 'lib', 'orchestrator.js'));
  const orch = new Orchestrator();
  const node = orch.registerNode({ id: 'xss-unit-probe', name: PAYLOAD, ip: '' });
  try {
    assert.ok(!/[<>]/.test(node.name || ''),
      'a name with angle brackets survived the boundary: ' + node.name);
    assert.ok((node.name || '').length <= 64, 'name exceeds the cap');
  } finally {
    orch.nodes.delete('xss-unit-probe');
  }
});

// ── the render sites ──────────────────────────────────────────────────────

test('every place a node name reaches innerHTML escapes it', () => {
  // The homepage sink: renderProviderRings takes realNodes, so p.name is a
  // NODE name even though the parameter says "providers".
  const home = read('index.html');
  const ringStart = home.indexOf('function renderProviderRings');
  const ring = home.slice(ringStart, ringStart + 2500);
  assert.ok(!/provider-name">\$\{p\.name\}/.test(ring),
    'index.html interpolates a raw node name into the provider rings');
  assert.ok(/provider-name">\$\{escapeHtml\(p\.name\)\}/.test(ring),
    'index.html must escape the provider-ring name');

  const cc = read('command-center.html');
  for (const sink of ['bindPopup', 'font-weight:700;font-size:.9rem', 'class="node-name"']) {
    const line = cc.split('\n').find((l) => l.includes(sink) && l.includes('n.name'));
    if (!line) continue;   // a sink that is gone is a sink that is fixed
    assert.ok(line.includes('_hEsc(n.name)'),
      'command-center renders n.name raw in a ' + sink + ' sink: ' + line.trim().slice(0, 120));
  }
});

// ── LIVE: the whole path, end to end ──────────────────────────────────────

test('LIVE: a hostile name is inert by the time it is stored', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const id = 'xss-live-probe';
  // /api/control/nodes caches for 10s, so the node we just registered is
  // invisible until it expires. Wait it out rather than fail wrongly.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(11000);
  const reg = await fetch(BASE + '/api/nodes/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: PAYLOAD, hw_id: 'xss-live-hw' }),
  });
  if (reg.status !== 200) { t.skip('register refused: ' + reg.status); return; }
  try {
    await sleep(11000);
    const roster = await fetch(BASE + '/api/control/nodes').then((r) => r.json());
    const me = roster.nodes.find((n) => n.id === id);
    assert.ok(me, 'the probe node must appear in the roster');
    assert.ok(!/[<>]/.test(me.name || ''),
      'stored name still contains markup: ' + me.name);
    assert.ok(!/onerror/i.test(me.name || '') || !/[<>]/.test(me.name || ''),
      'the onerror attribute is inert without angle brackets');
  } finally {
    await fetch(BASE + '/api/control/nodes/' + id, { method: 'DELETE' }).catch(() => {});
  }
});
