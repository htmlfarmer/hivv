// api/routes/earth-routes.js — the earth sensor, first organs.
//
// Cheap pulse: temperature, apparent temperature (wind chill), surface
// pressure, wind, humidity — from Open-Meteo (free, no key, CORS-clean),
// cached 10 minutes in-process. Approximate on purpose: a pulse, not an
// atlas. The atlas lives at xyzo.org (isobars, wind fields, temperature
// maps — our sibling hive's deep weather); this is the hive's own
// one-glance read, good enough to answer "should the dog walk now?" and
// "which nooks are warm?"
//
// Pressure is double-duty: falling barometric pressure = restless dogs
// (the storm-wander is documented) — so this sensor serves the search AND
// the understanding.

const express = require('express');
const ssrf = require('../lib/ssrf');
const router = express.Router();

// Moscow, Idaho (owner's neighborhood) — the Yalla default.
const DEFAULTS = { lat: 46.7331, lon: -116.9899 };
let cache = { at: 0, key: '', value: null };

router.get('/weather', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    const lat = Number(req.query && req.query.lat) || DEFAULTS.lat;
    const lon = Number(req.query && req.query.lon) || DEFAULTS.lon;
    const key = lat.toFixed(3) + ',' + lon.toFixed(3);
    if (cache.key === key && Date.now() - cache.at < 600000 && cache.value) {
        return res.json(cache.value);
    }
    try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat +
            '&longitude=' + lon +
            '&current=temperature_2m,apparent_temperature,surface_pressure,pressure_msl,wind_speed_10m,relative_humidity_2m' +
            '&timezone=auto';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const r = await ssrf.safeFetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const j = await r.json();
        const c = j.current || {};
        const t = Math.round(c.temperature_2m);
        const feels = Math.round(c.apparent_temperature);
        const value = {
            location: lat === DEFAULTS.lat && lon === DEFAULTS.lon ? 'Moscow, Idaho' : (lat + ', ' + lon),
            temp_c: t,
            temp_f: Math.round(t * 9 / 5 + 32),
            feels_f: Math.round(feels * 9 / 5 + 32),
            pressure_hpa: Math.round(c.surface_pressure),
            pressure_msl_hpa: Math.round(c.pressure_msl),
            wind_kmh: Math.round(c.wind_speed_10m),
            humidity_pct: Math.round(c.relative_humidity_2m),
            yalla_note: feels <= 4
                ? 'COLD — he is seeking warmth: garages, porches, warm engines (look first), sunny doorsteps, warm houses.'
                : (c.pressure_msl && c.pressure_msl < 1005
                    ? 'Pressure falling — restless-dog weather: widen the walk, check his favorite corners.'
                    : 'Mild — a good hour for the circle.'),
            source: 'open-meteo (pulse) · xyzo.org has the full atlas',
        };
        cache = { at: Date.now(), key, value };
        res.json(value);
    } catch (e) {
        res.status(502).json({ error: { message: 'weather unreachable: ' + String(e.message).slice(0, 120) } });
    }
});

module.exports = router;
