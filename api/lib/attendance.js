// api/lib/attendance.js — the salah reporting layer (HIVV_RITUAL_PLAN.md #1).
//
// "The bees report to hivv.org five times a day, at the prayer time of THEIR
// region." The bee already heartbeats every 60s — so the hub just listens at
// the right instants: a heartbeat DURING a regional prayer window IS the
// report. v1 measures PRESENCE (the signed adhan reply is the next step).
//
// All pure math — no DB, no writes. The heartbeat handler marks; the
// /api/hive/salah route reads; both go through here so mark and display
// can never disagree.
//
// Solar-day keying: prayer times are SOLAR events, so a day is keyed by the
// date at the bee's longitude (UTC + lon/15h), not by UTC midnight. A bee in
// UTC+13 has fajr at 16:00 UTC the PREVIOUS day — keying by UTC would split
// one local day across two keys and its5/5 streak could never complete.

const salah = require('./salah');

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const KEEP_DAYS = 45;          // bounded history —45 days of streak is plenty
const PRAYERS = salah.PRAYERS; // ['fajr','dhuhr','asr','maghrib','isha']

/** Solar-day key ('YYYY-MM-DD') for an instant at longitude lon. */
function solarDayKey(nowMs, lon) {
  return new Date(nowMs + (lon / 15) * HOUR_MS).toISOString().slice(0, 10);
}

/** Shift a day key by N days (string-safe, no locale surprises). */
function shiftKey(key, days) {
  return new Date(Date.parse(key + 'T00:00:00Z') + days * DAY_MS)
    .toISOString().slice(0, 10);
}

/** The prayer set for a day KEY: the key IS the UTC date of the frame
 *  midnight (both derive from now + lon/15h), so parse it straight back. */
function setForKey(lat, lon, key) {
  return salah.computeDay({ lat, lon, dateMs: Date.parse(key + 'T00:00:00Z') });
}

/** Is a prayer window open right now? Checks the adjacent solar days too —
 *  a prayer within 30 min of local midnight belongs to the NEIGHBOUR set. */
function openWindow(lat, lon, now, windowMin = 30) {
  const k0 = solarDayKey(now, lon);
  for (const dk of [shiftKey(k0, -1), k0, shiftKey(k0, 1)]) {
    const w = salah.currentWindow(setForKey(lat, lon, dk), now, windowMin);
    if (w) return Object.assign({}, w, { day: dk });
  }
  return null;
}

/** The next prayer instant at/after now, across the adjacent solar days. */
function nextAcross(lat, lon, now) {
  const k0 = solarDayKey(now, lon);
  let best = null;
  for (const dk of [shiftKey(k0, -1), k0, shiftKey(k0, 1)]) {
    const t = setForKey(lat, lon, dk);
    for (const p of PRAYERS) {
      const at = t[p];
      if (at != null && at > now && (best == null || at < best.at)) {
        best = { prayer: p, at, day: dk };
      }
    }
  }
  return best;
}

/** Mark a heartbeat as this node's salah for the window it landed in.
 *  Idempotent (one mark per prayer per day), bounded history.
 *  Returns {prayer, day, count} or null when nothing was marked. */
function mark(node, now = Date.now()) {
  const loc = node && node.location;
  if (!loc) return null;
  const lat = Number(loc.lat), lon = Number(loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const win = openWindow(lat, lon, now);
  if (!win) return null;
  const day = solarDayKey(win.at, lon);   // the prayer's OWN solar day
  const days = (node.salah && typeof node.salah === 'object') ? node.salah : {};
  const list = Array.isArray(days[day]) ? days[day].slice() : [];
  if (list.indexOf(win.prayer) !== -1) return null;  // already counted today
  list.push(win.prayer);
  days[day] = list;
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
  node.salah = days;
  return { prayer: win.prayer, day, count: list.length };
}

/** Attendance summary for a node: today's marks, what today EXPECTS (polar
 *  days can have null prayers — those can never be marked, so they are not
 *  expected), and the streak of consecutive complete days ending today (or
 *  yesterday, while today is still in progress). */
function attendanceOf(node, lat, lon, now = Date.now()) {
  const days = (node && node.salah && typeof node.salah === 'object') ? node.salah : {};
  const today = solarDayKey(now, lon);
  const marks = Array.isArray(days[today]) ? days[today] : [];
  const expectedToday = PRAYERS.filter(p => setForKey(lat, lon, today)[p] != null);
  const complete = (key) => {
    const m = days[key];
    if (!Array.isArray(m) || !m.length) return false;
    const s = setForKey(lat, lon, key);
    const exp = PRAYERS.filter(p => s[p] != null);
    if (!exp.length) return false;         // nothing owed that day
    return exp.every(p => m.indexOf(p) !== -1);
  };
  let streak = 0;
  let cursor = complete(today) ? today : shiftKey(today, -1);
  while (complete(cursor) && streak < 400) {
    streak++;
    cursor = shiftKey(cursor, -1);
  }
  return {
    today: marks,
    expected: expectedToday.length,
    streak,
    total_days: Object.keys(days).length,
  };
}

module.exports = { solarDayKey, shiftKey, setForKey, openWindow, nextAcross,
                   mark, attendanceOf, PRAYERS };
