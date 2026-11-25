// api/lib/moon.js — moon phase for the hive's ritual layer. Pure synodic
// arithmetic: phase age since a known new moon, wrapped to one cycle.
// The full moon is a FIRST-CLASS event here — the hive celebrates it.

const SYNODIC_MS = 29.530588853 * 86400000;
// Reference new moon: 2000-01-06 18:14 UTC (standard epoch for phase math)
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14, 0);

const PHASE_NAMES = [
    [0.031, 'new moon'],
    [0.219, 'waxing crescent'],
    [0.281, 'first quarter'],
    [0.469, 'waxing gibbous'],
    [0.531, 'full moon'],
    [0.719, 'waning gibbous'],
    [0.781, 'last quarter'],
    [0.969, 'waning crescent'],
];

/** Phase at nowMs. frac: 0 = new, 0.5 = full. */
function phase(nowMs = Date.now()) {
    const ageMs = (((nowMs - NEW_MOON_EPOCH) % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS;
    const frac = ageMs / SYNODIC_MS;
    const illumination = (1 - Math.cos(2 * Math.PI * frac)) / 2;
    let name = 'new moon';
    for (const [limit, label] of PHASE_NAMES) {
        if (frac < limit) { name = label; break; }
    }
    return {
        age_days: Math.round((ageMs / 86400000) * 100) / 100,
        frac: Math.round(frac * 10000) / 10000,
        illumination: Math.round(illumination * 1000) / 1000,
        name,
    };
}

/** Full moon right now, within +/- tolH hours of exact full. */
function isFullMoon(nowMs = Date.now(), tolH = 12) {
    const p = phase(nowMs);
    const d = Math.abs(p.frac - 0.5);
    const within = Math.min(d, 1 - d) * SYNODIC_MS <= tolH * 3600000;
    return { ...p, full: within };
}

/** The next full moon after nowMs — exact: phase advances linearly, so the
 *  circular distance AHEAD to frac 0.5 times one synodic month IS the answer
 *  (a bisection here converged to a non-full instant — found by its own test). */
function nextFullMoon(nowMs = Date.now()) {
    const p = phase(nowMs);
    const ahead = (((0.5 - p.frac) % 1) + 1) % 1;   // cycles until full
    const atMs = ahead < 1e-9
        ? nowMs + SYNODIC_MS                        // already full → next cycle
        : Math.round(nowMs + ahead * SYNODIC_MS);
    return { at: atMs, ...phase(atMs) };
}

module.exports = { phase, isFullMoon, nextFullMoon, SYNODIC_MS, NEW_MOON_EPOCH };
