// api/lib/salah.js — regional prayer times: pure solar math, no deps, no
// network. The hub computes each bee's five daily prayers from its location
// and pushes the adhan at the exact moment; every comparison uses ABSOLUTE
// instants (epoch ms, UTC) so bees in every timezone compare the same clock.
//
// Method defaults (MWL-flavoured, overridable per call):
//   fajr 18 deg, isha 17 deg, maghrib = sunset (+0.83 deg), asr shadow
//   factor 1 (Shafi; pass 2 for Hanafi). Polar summer with no solution
//   returns null for that prayer — honest "no data", never a guess.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const DAY_MS = 86400000;

const DEFAULT_METHOD = Object.freeze({
    fajrAngle: 18,
    ishaAngle: 17,
    maghribAngle: 0.83,
    asrFactor: 1,
});

function toJulian(dateMs) {
    return dateMs / DAY_MS + 2440587.5;
}

// NOAA-style sun position: declination (deg) + equation of time (minutes,
// apparent minus mean). Evaluated once per day near noon — sub-minute drift
// across the day for our purposes.
function sunPosition(julianDay) {
    const n = julianDay - 2451545.0;
    const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
    const g = (((357.528 + 0.9856003 * n) % 360 + 360) % 360) * DEG;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda)) * RAD;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda),
        Math.cos(lambda)) * RAD;
    const eqt = (((L - ra) % 360 + 540) % 360 - 180) * 4;
    return { decl, eqt };
}

// Hour angle (deg) for a target altitude; null when the sun never reaches
// it (polar day/night) — a real absence, not a zero.
function hourAngle(altDeg, decl, lat) {
    const cosH = (Math.sin(altDeg * DEG) - Math.sin(decl * DEG) * Math.sin(lat * DEG)) /
        (Math.cos(decl * DEG) * Math.cos(lat * DEG));
    if (cosH < -1 || cosH > 1) return null;
    return Math.acos(cosH) * RAD;
}

// Asr altitude: shadow = factor * object + noon shadow.
function asrAltitude(factor, decl, lat) {
    const shadow = factor + Math.tan(Math.abs(lat - decl) * DEG);
    if (shadow <= 0) return 90;
    return Math.atan(1 / shadow) * RAD;
}

/**
 * The five prayers for one UTC day at a location.
 * Returns epoch-ms instants (null = the sun never gets there today).
 */
function computeDay({ lat, lon, dateMs = Date.now(), method = {} } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('computeDay needs numeric lat/lon');
    }
    const m = { ...DEFAULT_METHOD, ...method };
    const midnight = Math.floor(dateMs / DAY_MS) * DAY_MS;
    const jd = toJulian(midnight + DAY_MS / 2);
    const { decl, eqt } = sunPosition(jd);

    // Solar noon (UTC ms): apparent 12:00 at the meridian —
    //   UTC = 12 - lon/15 - EoT/60   (east-positive longitude)
    const noonH = 12 - lon / 15 - eqt / 60;
    const noonMs = midnight + noonH * 3600000;
    // NOTE the guard: unary minus on null is 0 (fromNoon(-null) === noon —
    // a polar "no fajr" silently became dhuhr until its own test caught it).
    // Sign applied ONLY when the hour angle exists; null passes through.
    const at = (h, sign) => (h == null ? null : noonMs + ((sign * h) / 15) * 3600000);

    const fajrH = hourAngle(-m.fajrAngle, decl, lat);
    const ishaH = hourAngle(-m.ishaAngle, decl, lat);
    const magH = hourAngle(-m.maghribAngle, decl, lat);
    const asrH = hourAngle(asrAltitude(m.asrFactor, decl, lat), decl, lat);

    return {
        date: new Date(midnight).toISOString().slice(0, 10),
        fajr: at(fajrH, -1),
        dhuhr: noonMs,
        asr: at(asrH, +1),
        maghrib: at(magH, +1),
        isha: at(ishaH, +1),
        method: m,
        solar_noon_utc: new Date(noonMs).toISOString(),
        declination: Math.round(decl * 100) / 100,
        equation_of_time_min: Math.round(eqt * 10) / 10,
    };
}

const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/** The next prayer at/after now (nulls skipped). */
function nextPrayer(times, now = Date.now()) {
    return PRAYERS
        .map((name) => ({ name, at: times[name] }))
        .filter((p) => p.at != null && p.at >= now)
        .sort((a, b) => a.at - b.at)[0] || null;
}

/**
 * Which prayer's reporting window is open now? The adhan fires at the
 * instant; the window stays open windowMin (default 30) so a bee mid-task
 * can still make its salah.
 */
function currentWindow(times, now = Date.now(), windowMin = 30) {
    for (const name of PRAYERS) {
        const at = times[name];
        if (at != null && now >= at && now <= at + windowMin * 60000) {
            return { prayer: name, at, closes_at: at + windowMin * 60000 };
        }
    }
    return null;
}

module.exports = { computeDay, nextPrayer, currentWindow, PRAYERS, DEFAULT_METHOD };
