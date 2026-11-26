// api/routes/tile-routes.js — keyless map tiles, proxied and cached.
//
// WHY THIS EXISTS
// The basemap CDN the map used to load (CARTO) now stamps
// "API KEY REQUIRED" into every single tile it serves — the map rendered
// as a wall of watermarks. A map that demands a key is a map we do not
// want: the hive runs with no accounts, no secrets, no signups.
//
// So the tiles come from OPEN data:
//   • OpenStreetMap standard tiles (ODbL) — free, no key, no signup.
//   • Esri's Canvas World_Dark_Gray — a dark, keyless fallback skin.
//
// Why proxy instead of linking tile.openstreetmap.org straight from the
// browser?
//   1. OSM's tile policy asks that an app identify itself and not hammer
//      the servers. One cached fetch per tile serves every visitor; a
//      browser-direct map fetches once PER VISITOR.
//   2. Our User-Agent names the app, as the policy asks.
//   3. If OSM is slow, or an ad-blocker eats it, the map still loads from
//      our own cache.
// The page keeps a direct-OSM fallback, so this route being down never
// means a blank map.
//
// Route: GET /api/tile/:z/:x/:y
//   → 200 image/png  (memory cache | disk cache | upstream)
//   → 404 tile_out_of_range (bad z/x/y)   → 502 tile_upstream_failed

const express = require('express');
const fs = require('fs');
const path = require('path');
const ssrf = require('../lib/ssrf');
const localMode = require('../lib/local-mode');

const router = express.Router();

// ── upstreams (fixed hosts, so this route can never be aimed elsewhere) ──
const UPSTREAMS = [
    { name: 'osm',  url: (z, x, y) => 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png' },
    { name: 'esri', url: (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/' + z + '/' + y + '/' + x },
];

// OSM's policy: identify the app. A browser UA alone gets you blocked.
const UA = 'hivv.org/2.0 (map tiles; +https://hivv.org)';
const MAX_ZOOM = 19;
const MAX_BYTES = 3 * 1024 * 1024;
const MEM_CAP = 900;          // ~900 PNGs in memory
const DISK_CAP_MB = 512;      // disk cache ceiling

// ── caches ───────────────────────────────────────────────────────────────
const mem = new Map();        // 'z/x/y' -> Buffer
const memOrder = [];

function tileDir() {
    return path.join(localMode.dataDir(), 'tiles');
}

function diskPath(z, x, y) {
    return path.join(tileDir(), String(z), String(x), y + '.png');
}

function memPut(key, buf) {
    if (mem.has(key)) mem.delete(key);
    mem.set(key, buf);
    memOrder.push(key);
    while (memOrder.length > MEM_CAP) {
        const old = memOrder.shift();
        mem.delete(old);
    }
}

function diskRead(z, x, y) {
    try {
        const p = diskPath(z, x, y);
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null;
        return fs.readFileSync(p);
    } catch (_e) { return null; }
}

function diskWrite(z, x, y, buf) {
    try {
        const p = diskPath(z, x, y);
        localMode.ensureDir(path.dirname(p));
        fs.writeFileSync(p, buf);
        pruneDisk();
    } catch (_e) { /* a cache is a nicety, never a hard failure */ }
}

// Keep the disk cache under its ceiling: oldest first, by mtime.
function pruneDisk() {
    try {
        const root = tileDir();
        let total = 0;
        const files = [];
        for (const z of fs.readdirSync(root)) {
            const zd = path.join(root, z);
            let zs = [];
            try { zs = fs.readdirSync(zd); } catch (_e) { continue; }
            for (const x of zs) {
                const xd = path.join(zd, x);
                let ys = [];
                try { ys = fs.readdirSync(xd); } catch (_e) { continue; }
                for (const y of ys) {
                    const f = path.join(xd, y);
                    try {
                        const st = fs.statSync(f);
                        total += st.size;
                        files.push({ f: f, m: st.mtimeMs, s: st.size });
                    } catch (_e) { /* raced with a prune */ }
                }
            }
        }
        const ceiling = DISK_CAP_MB * 1024 * 1024;
        if (total <= ceiling) return;
        files.sort(function (a, b) { return a.m - b.m; });
        for (const f of files) {
            if (total <= ceiling) break;
            try { fs.unlinkSync(f.f); total -= f.s; } catch (_e) { /* gone already */ }
        }
    } catch (_e) { /* no cache dir yet */ }
}

async function fetchTile(z, x, y) {
    let lastErr = null;
    for (const up of UPSTREAMS) {
        try {
            const url = up.url(z, x, y);
            const ctrl = new AbortController();
            const timer = setTimeout(function () { ctrl.abort(); }, 8000);
            const r = await ssrf.safeFetch(url, {
                signal: ctrl.signal,
                headers: { 'User-Agent': UA, 'Accept': 'image/png,image/*;q=0.8' },
            });
            clearTimeout(timer);
            if (!r.ok) { lastErr = new Error(up.name + ' HTTP ' + r.status); continue; }
            const buf = Buffer.from(await r.arrayBuffer());
            if (!buf.length || buf.length > MAX_BYTES) { lastErr = new Error(up.name + ' bad size'); continue; }
            return { buf: buf, source: up.name };
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('no upstream answered');
}

function send(res, buf, source, status) {
    res.status(status || 200);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('X-Hivv-Tile-Source', source);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(buf);
}

router.get(/^\/tile\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(\.png)?$/i, async function (req, res) {
    const z = parseInt(req.params[0], 10);
    const x = parseInt(req.params[1], 10);
    const y = parseInt(req.params[2], 10);

    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) ||
        z < 0 || z > MAX_ZOOM || x < 0 || y < 0 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
        return res.status(404).json({ error: 'tile_out_of_range', z: z, x: x, y: y });
    }

    const key = z + '/' + x + '/' + y;
    const hit = mem.get(key);
    if (hit) { mem.delete(key); mem.set(key, hit); return send(res, hit, 'memory'); }

    const onDisk = diskRead(z, x, y);
    if (onDisk) { memPut(key, onDisk); return send(res, onDisk, 'disk'); }

    try {
        const got = await fetchTile(z, x, y);
        memPut(key, got.buf);
        diskWrite(z, x, y, got.buf);
        return send(res, got.buf, 'upstream:' + got.source);
    } catch (e) {
        return res.status(502).json({ error: 'tile_upstream_failed', reason: String((e && e.message) || e).slice(0, 200) });
    }
});

module.exports = router;
module.exports.tileDir = tileDir;