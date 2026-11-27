// api/tests/nav.test.js — ONE navigation, and it must list EVERY page.
//
// WHY THIS FILE EXISTS
// Every page used to carry its own hand-written nav, and every one of them
// listed a DIFFERENT subset of the site: nodes.html linked to /hivv.html
// (a page that does not exist), status.html linked to /api.html while every
// other page linked to /docs, the map had no Home link, and a dozen pages
// had no nav at all. "Some pages are missing" was not a feeling — it was
// forty different navs.
//
// THE LAW
//   1. There is ONE nav component (public_html/js/hivv-nav.js).
//   2. It lists EVERY page the site serves.
//   3. Every page that renders a nav uses THAT one — no second inventory.
//   4. It marks the page you are on.
//
// Run with:  cd api && node --test tests/nav.test.js

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

function allPages() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'lib' && e.name !== '__pycache__') walk(p); }
      else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(PUBLIC);
  return out;
}

// The pages that bounce straight to another page. A nav on a page that
// redirects instantly is noise, and the target is already in the menu.
const REDIRECT_STUBS = new Set(['watch.html', 'account.html', 'hivv-page.html']);

// ── the component ──────────────────────────────────────────────────────────

test('the nav component exists and is the only place the inventory lives', () => {
  const js = path.join(PUBLIC, 'js', 'hivv-nav.js');
  assert.ok(fs.existsSync(js), 'public_html/js/hivv-nav.js must exist');
  const src = fs.readFileSync(js, 'utf8');
  assert.ok(/var GROUPS/.test(src), 'the nav must hold THE inventory');
  assert.ok(/hivv-nav-toggle/.test(src), 'the nav must offer the full list');
  assert.ok(/hivv-nav-search/.test(src), 'the nav must be filterable');
  assert.ok(/data-hivv-pill/.test(src), 'the nav must carry the live bee pill');
  assert.ok(/is-current/.test(src), 'the nav must mark the current page');
});

// The server serves some pages under a shorter URL than the file:
//   /docs -> api.html   /account -> bee.html   /bee -> bee.html
//   /dashboard -> hivv-dashboard.html   /status -> status.html
//   /connect -> connect.html
// The nav uses the short URL; the FILE is still reachable and still real.
const ALIASES = {
  '/docs': 'api.html',
  '/account': 'bee.html',
  '/bee': 'bee.html',
  '/dashboard': 'hivv-dashboard.html',
  '/status': 'status.html',
  '/connect': 'connect.html',
};

test('the inventory lists every page the site actually serves', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'hivv-nav.js'), 'utf8');
  const listed = new Set((src.match(/href: '([^']+)'/g) || [])
    .map((x) => x.replace(/href: '/, '').replace(/'$/, '')));
  // A listed URL also covers the FILE it serves.
  for (const [alias, file] of Object.entries(ALIASES)) {
    if (listed.has(alias)) listed.add('/' + file);
  }

  // Every real page must be reachable from the menu.
  const missing = [];
  for (const p of allPages()) {
    const rel = path.relative(PUBLIC, p).replace(/\\/g, '/');
    const base = rel.replace(/index\.html$/, '').replace(/\.html$/, '');
    if (REDIRECT_STUBS.has(path.basename(rel))) continue;
    if (rel === 'index.html') continue;             // the homepage IS the brand link
    if (rel === '404.html') continue;               // the 404 page is not linked
    // The nav may use either /name or /name.html for the same page.
    const ok = listed.has('/' + rel)
      || listed.has('/' + base + '/')
      || listed.has('/' + base)
      || listed.has('/' + base + '.html');
    if (!ok) missing.push(rel);
  }
  assert.equal(missing.length, 0,
    'these pages are not in the nav: ' + missing.join(', '));
});

test('the inventory points at pages that EXIST (no dead links)', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'hivv-nav.js'), 'utf8');
  const hrefs = [...new Set((src.match(/href: '([^']+)'/g) || [])
    .map((x) => x.replace(/href: '/, '').replace(/'$/, '')))];
  const broken = [];
  for (const h of hrefs) {
    const r = await fetch(BASE + h, { method: 'GET', redirect: 'manual' });
    if (r.status >= 400) broken.push(h + ' -> ' + r.status);
  }
  assert.equal(broken.length, 0, 'the nav links to pages that do not exist: ' + broken.join(', '));
});

test('the nav does not link to a redirect stub (it links to the target)', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'hivv-nav.js'), 'utf8');
  for (const stub of ['/watch.html', '/account.html', '/hivv-page.html']) {
    assert.ok(!src.includes("href: '" + stub + "'"),
      'the nav must not link to ' + stub + ' - it bounces to another page');
  }
});

// ── the pages ──────────────────────────────────────────────────────────────

test('every page that renders a nav uses THE shared component', () => {
  const pages = allPages();
  const withBespoke = [];
  const withoutNav = [];
  for (const p of pages) {
    const rel = path.relative(PUBLIC, p).replace(/\\/g, '/');
    if (REDIRECT_STUBS.has(path.basename(rel))) continue;
    const src = fs.readFileSync(p, 'utf8');
    const hasBespoke = /<nav\b/i.test(src);
    const hasShared = src.includes('/js/hivv-nav.js');
    if (hasBespoke) withBespoke.push(rel);
    if (!hasShared) withoutNav.push(rel);
  }
  assert.equal(withBespoke.length, 0,
    'these pages still carry a hand-written nav: ' + withBespoke.join(', '));
  assert.equal(withoutNav.length, 0,
    'these pages do not load the shared nav: ' + withoutNav.join(', '));
});

test('the old broken link (/hivv.html) is gone', () => {
  for (const p of allPages()) {
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(!src.includes('/hivv.html'),
      path.relative(PUBLIC, p) + ' links to /hivv.html, which does not exist');
  }
});

test('the nav carries the live bee pill, never a typed count', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'hivv-nav.js'), 'utf8');
  assert.ok(/data-hivv-pill-count/.test(src), 'the pill count must be bound');
  assert.ok(!/\d+\/\d+ online/.test(src), 'the pill must not carry a typed count');
});

test('the nav is reachable and complete, page by page', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  // A sample of the pages a visitor actually lands on.
  const sample = ['/', '/chat/', '/map/', '/live/', '/nodes.html', '/status',
    '/hivv-dashboard.html', '/about.html', '/team/', '/party/'];
  for (const p of sample) {
    const html = await fetch(BASE + p).then((r) => r.text());
    assert.ok(html.includes('/js/hivv-nav.js'), p + ' must load the shared nav');
  }
});
