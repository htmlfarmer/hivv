// api/tests/salah.test.js — the salah SURFACE: attendance math + the route.
//
// The engine (lib/salah.js) is pinned in ritual.test.js; this file covers
// the layer ON TOP of it: lib/attendance.js (solar-day keying, marking,
// streaks) and GET /api/hive/salah (the route the CLI calls).
//
// The heart of it: a heartbeat inside a regional prayer window IS the
// report. These tests prove the window math, the idempotent mark, the
// streak (including "today still in progress"), and — live — that the
// route serves real times for a real location.
//
// Run with:  cd api && node --test tests/salah.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const att = require('../lib/attendance');
const salah = require('../lib/salah');

const BASE = 'http://localhost:3011';
let gatewayUp = false;

before(async () => {
  try {
    const r = await fetch(BASE + '/api/health');
    gatewayUp = r.ok;
  } catch (_) { gatewayUp = false; }
});

// ── solar-day keying ────────────────────────────────────────────────────────

test('solarDayKey: the date follows the SUN, not UTC', () => {
  // 13:00 UTC — in UTC+14 it is already TOMORROW; in UTC-10 still the
  // previous evening. One instant, two correct local dates.
  const noon = Date.UTC(2026, 5, 15, 13, 0, 0);
  assert.equal(att.solarDayKey(noon, 0), '2026-06-15');
  assert.equal(att.solarDayKey(noon, 15 * 14), '2026-06-16');   // UTC+14 → tomorrow
  assert.equal(att.solarDayKey(noon, -15 * 10), '2026-06-15');  // UTC-10 → 03:00, same day
  // an EARLY utc hour crosses midnight backward (19:00 previous day)
  const early = Date.UTC(2026, 5, 15, 5, 0, 0);
  assert.equal(att.solarDayKey(early, -15 * 10), '2026-06-14');  // UTC-10 → prev day
  // shiftKey is string-safe (no locale/TZ surprises)
  assert.equal(att.shiftKey('2026-01-01', -1), '2025-12-31');
  assert.equal(att.shiftKey('2026-12-31', 1), '2027-01-01');
});

test('setForKey: a key round-trips into a prayer set with sane ordering', () => {
  const lat = 46.73, lon = -116.99, key = '2026-06-15';
  const t = att.setForKey(lat, lon, key);
  assert.equal(t.date, key, 'the set must BE that day');
  for (const p of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) {
    assert.ok(Number.isFinite(t[p]), p + ' must be a finite instant');
  }
  const order = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map(p => t[p]);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], 'prayers must be chronological');
  }
  // polar case: at 78°N in JUNE the sun never reaches −18° (midnight sun)
  // → fajr is undefined and must be null, NEVER collapsed into noon.
  // (December would NOT be null: even polar night crosses −18° twice.)
  const polar = att.setForKey(78.0, 20.0, '2026-06-21');
  assert.equal(polar.fajr, null, 'a sun that never reaches dawn must be null');
  assert.notEqual(polar.fajr, polar.dhuhr, 'null must never collapse into noon');
  assert.ok(Number.isFinite(polar.dhuhr), 'dhuhr still exists (solar noon does)');
});

// ── marking ─────────────────────────────────────────────────────────────────

test('mark: inside the window → counted once; outside → nothing', () => {
  const lat = 46.73, lon = -116.99;
  const day = att.setForKey(lat, lon, att.solarDayKey(Date.now(), lon));
  const node = { location: { lat, lon }, salah: {} };

  const inside = att.mark(node, day.dhuhr + 60000);      // 1 min after dhuhr
  assert.ok(inside, 'a heartbeat inside the window must mark');
  assert.equal(inside.prayer, 'dhuhr');
  assert.deepEqual(node.salah[inside.day], ['dhuhr']);

  const again = att.mark(node, day.dhuhr + 120000);      // 2 min after
  assert.equal(again, null, 'the same prayer must not count twice');

  const outside = att.mark(node, day.dhuhr + 3 * 3600000);  // 3h later
  assert.equal(outside, null, 'outside every window → no mark');

  const noLoc = att.mark({ salah: {} }, Date.now());
  assert.equal(noLoc, null, 'a bee without location cannot be counted');
});

test('mark: history is bounded (45 days), so state cannot grow forever', () => {
  const lat = 46.73, lon = -116.99;
  const node = { location: { lat, lon }, salah: {} };
  const today = att.solarDayKey(Date.now(), lon);
  // plant 60 past days directly, then force one real add (prune runs on add)
  for (let d = 1; d <= 60; d++) {
    const key = att.shiftKey(today, -d);
    node.salah[key] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  }
  const day = att.setForKey(lat, lon, today);
  const marked = att.mark(node, day.dhuhr + 60000);
  assert.ok(marked, 'the real mark must land');
  assert.ok(Object.keys(node.salah).length <= 45,
            'history must prune to 45 days, got ' + Object.keys(node.salah).length);
  assert.ok(node.salah[today], 'today must survive the prune');
});

// ── attendance summary + streaks ────────────────────────────────────────────

test('attendanceOf: streak counts complete days, today may be in progress', () => {
  const lat = 46.73, lon = -116.99;
  const all5 = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const today = att.solarDayKey(Date.now(), lon);
  const y1 = att.shiftKey(today, -1), y2 = att.shiftKey(today, -2);

  // yesterday + day-before complete, today empty → streak = 2 (today in progress)
  let node = { location: { lat, lon }, salah: {} };
  node.salah[y1] = [...all5];
  node.salah[y2] = [...all5];
  let a = att.attendanceOf(node, lat, lon);
  assert.equal(a.streak, 2, 'yesterday counts while today is in progress');
  assert.deepEqual(a.today, []);
  assert.equal(a.expected, 5);

  // complete today → streak = 3
  node.salah[today] = [...all5];
  a = att.attendanceOf(node, lat, lon);
  assert.equal(a.streak, 3);

  // a gap breaks the streak
  delete node.salah[y1];
  a = att.attendanceOf(node, lat, lon);
  assert.equal(a.streak, 1, 'a missed day must reset the streak');

  // partial today = still in progress: it neither completes nor hides the
  // complete days behind it — yesterday + day-before still count (2)
  node.salah[today] = ['fajr', 'dhuhr'];
  node.salah[y1] = [...all5];
  a = att.attendanceOf(node, lat, lon);
  assert.equal(a.streak, 2, 'a partial today is in progress, not a break');
  assert.equal(a.today.length, 2, "today's partial marks are still shown");
  assert.equal(a.expected, 5);
});

test('openWindow/nextAcross: windows and neighbours behave', () => {
  const lat = 46.73, lon = -116.99;
  const day = att.setForKey(lat, lon, att.solarDayKey(Date.now(), lon));
  const w = att.openWindow(lat, lon, day.dhuhr + 60000);
  assert.ok(w && w.prayer === 'dhuhr', 'inside the window → found');
  assert.ok(w.closes_at > day.dhuhr, 'the window closes after the instant');
  assert.equal(att.openWindow(lat, lon, day.dhuhr + 3 * 3600000), null,
               '3h after dhuhr → no window');
  const n = att.nextAcross(lat, lon, day.fajr - 3600000);  // before fajr
  assert.ok(n && n.prayer === 'fajr', 'next must find the upcoming prayer');
});

// ── the route (live gateway, skipped when down) ─────────────────────────────

test('live: GET /api/hive/salah?lat&lon serves times + moon', async () => {
  if (!gatewayUp) return;
  const r = await fetch(BASE + '/api/hive/salah?lat=46.73&lon=-116.99');
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.node, null, 'ad-hoc has no node');
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(p.date));
  for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) {
    assert.ok(Number.isFinite(p.prayers[k]), k);
  }
  assert.ok(p.next && p.next.prayer, 'there is always a next prayer');
  assert.ok(p.moon && typeof p.moon.name === 'string', 'moon phase rides along');
  assert.equal(p.attendance, null, 'ad-hoc has no attendance');
});

test('live: GET /api/hive/salah?node=<bee> carries attendance shape', async () => {
  if (!gatewayUp) return;
  const r = await fetch(BASE + '/api/hive/salah?node=wahi');
  if (r.status === 404) return;             // bee unknown in a fresh store
  assert.equal(r.status, 200, 'wahi has a registered location');
  const p = await r.json();
  assert.equal(p.node, 'wahi');
  assert.ok(p.location && Number.isFinite(Number(p.location.lat)));
  assert.ok(p.attendance, 'a registered node gets attendance');
  assert.ok(Array.isArray(p.attendance.today));
  assert.equal(typeof p.attendance.expected, 'number');
  assert.equal(typeof p.attendance.streak, 'number');
});

test('live: bad input is a clean 4xx, never a 500', async () => {
  if (!gatewayUp) return;
  assert.equal((await fetch(BASE + '/api/hive/salah')).status, 400);
  assert.equal((await fetch(BASE + '/api/hive/salah?node=__no_such_bee__')).status, 404);
  assert.equal((await fetch(BASE + '/api/hive/salah?lat=abc&lon=1')).status, 400);
});

test('source: the heartbeat handler actually marks (the wiring pin)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("require('./lib/attendance')"),
            'server.js must require the attendance layer');
  assert.ok(/att\.mark\(updated/.test(src), 'the heartbeat must call mark()');
});
