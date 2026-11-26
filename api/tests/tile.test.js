// api/tests/tile.test.js — pins the keyless map:
//   1. the ROUTE: validation (out-of-range -> 404), the PNG headers, the
//      memory/disk cache, and the source header
//   2. the PAGES: no CARTO anywhere (its CDN now burns "API KEY REQUIRED"
//      into every tile), Leaflet served from OUR OWN box, the map page's
//      script tags BALANCED (the unclosed <script> that killed the map),
//      and the geolocation permission for the embedded world map
//
// Run with:  cd api && node --test tests/tile.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
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

// ── the route, on its own server ──────────────────────────────────────────
async function withServer(fn) {
  const express = require('express');
  const app = express();
  app.use('/api', require('../routes/tile-routes'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    return await fn('http://127.0.0.1:' + port);
  } finally {
    server.close();
  }
}

test('tile route: out-of-range coordinates are refused, never proxied', async () => {
  await withServer(async (base) => {
    for (const p of ['/api/tile/2/99/99', '/api/tile/2/0/99', '/api/tile/25/1/1', '/api/tile/-1/1/1']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, p + ' must be refused');
    }
  });
});

test('tile route: a real tile comes back as a PNG, and the cache answers next time', async () => {
  await withServer(async (base) => {
    const first = await fetch(base + '/api/tile/4/8/5');
    if (first.status !== 200) {
      // No network in this environment — the validation above still holds.
      assert.equal(first.status, 502);
      return;
    }
    assert.equal(first.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await first.arrayBuffer());
    assert.ok(buf.length > 100, 'a tile has bytes');
    assert.equal(buf[1], 0x50, 'PNG magic (\x89P)');
    assert.ok(/^(upstream|memory|disk)/.test(first.headers.get('x-hivv-tile-source') || ''),
      'the source header says where the bytes came from');
    const second = await fetch(base + '/api/tile/4/8/5');
    assert.equal(second.status, 200);
    assert.notEqual(second.headers.get('x-hivv-tile-source'), first.headers.get('x-hivv-tile-source'),
      'the second fetch is served from cache');
  });
});

test('tile route: the .png suffix is accepted (browsers ask for both)', async () => {
  await withServer(async (base) => {
    const r = await fetch(base + '/api/tile/4/8/5.png');
    assert.ok(r.status === 200 || r.status === 502, 'got ' + r.status);
  });
});

// ── the pages: the regression pins for what the reader actually saw ───────

function read(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

const MAP_PAGES = ['map/index.html', 'index.html', 'command-center.html'];

test('no page asks CARTO for tiles (it stamps "API KEY REQUIRED" on every tile)', () => {
  for (const p of MAP_PAGES) {
    const html = read(p);
    assert.ok(!/cartocdn/i.test(html), p + ' must not load CARTO tiles');
  }
});

test('no page loads a keyed tile provider at all', () => {
  for (const p of MAP_PAGES) {
    const html = read(p);
    for (const bad of ['maptiler.com', 'stadiamaps.com', 'api.mapbox.com', 'basemap.arcgis.com']) {
      assert.ok(!html.includes(bad), p + ' must not use ' + bad);
    }
  }
});

test('every script tag is closed — an unclosed one kills the whole page', () => {
  for (const p of MAP_PAGES) {
    const html = read(p);
    const opens = (html.match(/<script\b/gi) || []).length;
    const closes = (html.match(/<\/script\s*>/gi) || []).length;
    assert.equal(opens, closes, p + ' has ' + opens + ' <script> and ' + closes + ' </script>');
  }
});

test('Leaflet is served from our own box (a CDN is one blocker away from gone)', () => {
  assert.ok(fs.existsSync(path.join(PUBLIC, 'lib', 'leaflet', 'leaflet.js')), 'leaflet.js is vendored');
  assert.ok(fs.existsSync(path.join(PUBLIC, 'lib', 'leaflet', 'leaflet.css')), 'leaflet.css is vendored');
  for (const p of MAP_PAGES) {
    const html = read(p);
    assert.ok(html.includes('/lib/leaflet/leaflet.js'), p + ' loads the local Leaflet');
    assert.ok(html.includes('/lib/leaflet/leaflet.css'), p + ' loads the local Leaflet css');
  }
});

test('the map page tiles come from the keyless proxy', () => {
  const html = read('map/index.html');
  assert.ok(html.includes('/api/tile/{z}/{x}/{y}'), 'the hive map uses the proxy');
  assert.ok(html.includes('tile.openstreetmap.org'), 'direct OSM stays as the fallback');
});

test('the embedded world map may ask for a location (no Permissions-Policy violation)', () => {
  const html = read('map/index.html');
  assert.ok(/allow\s*=\s*['"]geolocation['"]/.test(html), 'the iframe grants geolocation');
});

test('the map pages credit OpenStreetMap (its licence requires the credit)', () => {
  for (const p of MAP_PAGES) {
    assert.ok(/OpenStreetMap/.test(read(p)), p + ' credits OpenStreetMap');
  }
  for (const p of ['index.html', 'command-center.html']) {
    assert.ok(!/attributionControl:\s*false/.test(read(p)), p + ' shows the credit control');
  }
});

// ── LIVE: the route is mounted on the running gateway ─────────────────────

test('LIVE: the gateway serves a keyless tile', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/tile/3/4/3');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const bad = await fetch(BASE + '/api/tile/3/99/99');
  assert.equal(bad.status, 404);
});