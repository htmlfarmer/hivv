// api/tests/ritual.test.js — pins the ritual layer's foundations:
//   1. reserved ritual vocabulary (no bee may be named fajr..isha)
//   2. the salah engine (solar math — anchored to known values)
//   3. the moon engine (synodic arithmetic + full-moon events)
//
// The engines are pure math, so most tests are exact invariants; the two
// ANCHORS (Greenwich equinox solar noon, Mecca ordering) are what catch a
// sign error in the equation of time — the classic way this math breaks.
//
// Run with:  cd api && node --test tests/ritual.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const bee = require('../lib/bee-identity');
const salah = require('../lib/salah');
const moon = require('../lib/moon');

const BASE = 'http://localhost:3011';
let gatewayUp = false;

before(async () => {
  try {
    const r = await fetch(BASE + '/api/health');
    gatewayUp = r.ok;
  } catch (_) { gatewayUp = false; }
});

// ── reserved vocabulary ─────────────────────────────────────────────────────

test('reserved: the five prayers + core ritual words cannot be bee ids', () => {
  for (const id of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha',
                    'salah', 'salat', 'wudu', 'adhan', 'sujud', 'sujood',
                    'dua', 'hajj', 'jihad', 'ramadan', 'eid', 'zakat',
                    'moon', 'tongue']) {
    assert.equal(bee.isReservedId(id), true, id + ' must be reserved');
  }
  // case-insensitive (a register lowercases first, but be safe)
  assert.equal(bee.isReservedId('FAJR'), true);
  // ordinary names stay available
  for (const id of ['masjid', 'yalla', 'ashy', 'wahi', 'bee-x', '__e2e__']) {
    assert.equal(bee.isReservedId(id), false, id + ' must stay available');
  }
});

test('live: registering a reserved name is refused with BEE_ID_RESERVED', async () => {
  if (!gatewayUp) return;
  // self-cleaning: an earlier run against pre-reservation code may have
  // actually created this node — remove it so the invariant is real
  await fetch(BASE + '/api/control/nodes/fajr', { method: 'DELETE' });
  const r = await fetch(BASE + '/api/nodes/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-visitor-id': 'ritual-e2e' },
    body: JSON.stringify({ id: 'fajr', hw_id: 'linux-ritual-e2e', hostname: 'nope',
                           capabilities: ['heartbeat'], max_concurrent_jobs: 1, metrics: {} }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.code, 'BEE_ID_RESERVED');
  assert.match(body.hint || '', /ritual/);
  // and the node was never created
  const nodes = await (await fetch(BASE + '/api/control/nodes')).json();
  assert.equal((nodes.nodes || []).some((n) => (n.id || n.node_id) === 'fajr'), false);
});

// ── salah engine ────────────────────────────────────────────────────────────

test('salah: Mecca day has all five prayers in order', () => {
  const t = salah.computeDay({ lat: 21.4225, lon: 39.8262, dateMs: Date.UTC(2026, 5, 15) });
  assert.ok(t.fajr < t.dhuhr, 'fajr before dhuhr');
  assert.ok(t.dhuhr < t.asr, 'dhuhr before asr');
  assert.ok(t.asr < t.maghrib, 'asr before maghrib');
  assert.ok(t.maghrib < t.isha, 'maghrib before isha');
  for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) {
    assert.equal(typeof t[k], 'number', k + ' must be an instant');
    assert.ok(Math.abs(t[k] - Date.UTC(2026, 5, 15)) < 2 * 86400000, k + ' within 2 days');
  }
});

test('salah: ANCHOR — Greenwich equinox solar noon ≈ 12:07 UTC', () => {
  // EoT ≈ −7.5 min that week; a flipped sign yields ≈ 11:53 and fails here.
  const g = salah.computeDay({ lat: 51.4769, lon: 0, dateMs: Date.UTC(2026, 2, 20) });
  const noon = new Date(g.solar_noon_utc);
  assert.equal(noon.getUTCDate(), 20);
  const minutes = noon.getUTCHours() * 60 + noon.getUTCMinutes();
  assert.ok(minutes >= 12 * 60 + 4 && minutes <= 12 * 60 + 11,
    'solar noon should be ~12:07, got ' + noon.toISOString());
});

test('salah: polar summer honestly reports null (no fajr/isha), not zero', () => {
  const t = salah.computeDay({ lat: 78.2, lon: 15.6, dateMs: Date.UTC(2026, 5, 21) }); // Svalbard, June
  assert.equal(t.fajr, null, 'midnight sun: no fajr');
  assert.equal(t.isha, null, 'midnight sun: no isha');
  assert.equal(typeof t.dhuhr, 'number');
});

test('salah: nextPrayer + currentWindow behave', () => {
  const t = salah.computeDay({ lat: 21.4225, lon: 39.8262, dateMs: Date.UTC(2026, 5, 15) });
  const afterFajr = salah.nextPrayer(t, t.fajr + 1000);
  assert.equal(afterFajr.name, 'dhuhr');
  const win = salah.currentWindow(t, t.asr + 60000);
  assert.equal(win.prayer, 'asr');
  const none = salah.currentWindow(t, t.asr + 40 * 60000);
  assert.equal(none, null, 'window closes after 30 min');
  const polar = salah.computeDay({ lat: 78.2, lon: 15.6, dateMs: Date.UTC(2026, 5, 21) });
  const np = salah.nextPrayer(polar, polar.dhuhr + 1);
  assert.ok(np === null || np.at > polar.dhuhr, 'nulls are skipped, never returned as events');
});

// ── moon engine ─────────────────────────────────────────────────────────────

test('moon: phase math wraps and names correctly', () => {
  const p = moon.phase(moon.NEW_MOON_EPOCH);
  assert.ok(p.frac < 0.01, 'reference epoch is a new moon');
  assert.equal(p.name, 'new moon');
  const full = moon.phase(moon.NEW_MOON_EPOCH + moon.SYNODIC_MS / 2);
  assert.ok(Math.abs(full.frac - 0.5) < 0.01, 'half a synodic month later is full');
  assert.equal(full.name, 'full moon');
  assert.ok(full.illumination > 0.97);
  for (const t of [Date.now(), Date.UTC(2026, 10, 25), Date.UTC(2027, 5, 1)]) {
    const q = moon.phase(t);
    assert.ok(q.frac >= 0 && q.frac <= 1);
    assert.ok(q.illumination >= 0 && q.illumination <= 1);
  }
});

test('moon: isFullMoon + nextFullMoon', () => {
  const exactFull = moon.NEW_MOON_EPOCH + moon.SYNODIC_MS / 2;
  assert.equal(moon.isFullMoon(exactFull).full, true);
  assert.equal(moon.isFullMoon(exactFull - 20 * 3600000).full, false, '20h early is not full');
  const nf = moon.nextFullMoon(Date.UTC(2026, 10, 25));
  assert.ok(nf.at > Date.UTC(2026, 10, 25), 'next full moon must be in the future');
  assert.ok(nf.at - Date.UTC(2026, 10, 25) <= moon.SYNODIC_MS, 'within one cycle');
  assert.equal(moon.isFullMoon(nf.at).full, true, 'the computed instant IS full');
});
