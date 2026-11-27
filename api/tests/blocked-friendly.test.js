// api/tests/blocked-friendly.test.js — pins the law that a BLOCKED or FAILED
// request may DEGRADE the page, never BREAK it.
//
// THE REPORT (2026-11-26)
// -----------------------
// The homepage console:
//   static.cloudflareinsights.com/beacon.min.js → ERR_BLOCKED_BY_CLIENT
//   dashboard-stats:1  → 502
//   activity:1         → 502
//   status:1           → 502
//   Status refresh error: SyntaxError: Failed to execute 'json' on
//     'Response': Unexpected token '<', "<!DOCTYPE "... is not valid JSON
//
// THREE separate things were tangled together, and only ONE of them was a
// fault of ours:
//
//   1. THE BEACON IS NOT OURS. Cloudflare injects its Web-Analytics beacon
//      into the HTML it serves through its proxy. Every adblocker kills it.
//      That is the user's blocker doing its job on a script we never wrote,
//      and nothing of ours may DEPEND on it (law C below).
//   2. THE 502s were the gateway restarting. Transient — the site was fine
//      a second later. But the ERROR PAGE was HTML, and every page reads
//      these endpoints with `await res.json()`, so an HTML body threw a raw
//      SyntaxError: the live panels froze on STALE data and the console
//      filled with errors that LOOKED like the site's fault.
//   3. The API's own 404 was HTML too (Express's default handler answers
//      "Cannot GET /api/whatever" as a web page) — so a renamed or removed
//      endpoint broke every reader, permanently.
//
// THE LAW (three parts, each pinned below)
// ----------------------------------------
//   A. THE API ANSWERS JSON, EVEN WHEN IT FAILS. A 404 for an unknown
//      endpoint, and a proxy failure, both answer `application/json`. A
//      reader can then check `res.ok` and never meet a SyntaxError.
//   B. THE CLIENT NEVER THROWS ON A BROKEN BODY. The shared helper
//      (HIVV.json) returns null for a failed / HTML / blocked response.
//   C. NO PAGE DEPENDS ON A THIRD-PARTY SCRIPT. An adblocker may kill any
//      of them; our pages must work with every one of them dead.
//
// Run with:  cd api && node --test tests/blocked-friendly.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'public_html');
const BASE = 'http://localhost:3011';

let gatewayUp = false;
before(async () => {
    try {
        const r = await fetch(BASE + '/api/health');
        gatewayUp = r.ok;
    } catch (_) { gatewayUp = false; }
});

function read(p) {
    try { return fs.readFileSync(path.join(PUBLIC, p), 'utf8'); } catch (_e) { return ''; }
}
function readRepo(p) {
    try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch (_e) { return ''; }
}
function htmlPages() {
    const out = [];
    const walk = (dir, depth = 0) => {
        if (depth > 3) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'lib') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (e.name.endsWith('.html')) out.push(path.relative(PUBLIC, full));
        }
    };
    walk(PUBLIC);
    return out;
}

// ── LAW A: the API answers JSON, even when it fails ───────────────────────

describe('LAW A — the API answers JSON, even when it fails', () => {
    test('LIVE: an unknown API path answers JSON, not an HTML error page', async (t) => {
        if (!gatewayUp) return t.skip('gateway not running');
        const r = await fetch(BASE + '/api/definitely-not-a-real-endpoint-' + Date.now());
        assert.equal(r.status, 404);
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        assert.ok(ct.includes('json'),
            'an unknown API path must answer JSON — an HTML body makes every reader throw');
        const j = await r.json();
        assert.equal(j.error, 'no such endpoint');
        assert.ok(j.path, 'the answer says which path was asked for');
    });

    test('the JSON 404 names the surfaces that used to answer HTML', () => {
        const src = readRepo('api/server.js');
        assert.ok(src.includes('no such endpoint'),
            'the API must answer a JSON 404 for an unknown path');
        for (const p of ['/api/', '/v1/', '/mcp', '/nodes/', '/control/']) {
            assert.ok(src.includes(p),
                'the JSON 404 must cover the ' + p + ' surface');
        }
    });

    test('LIVE CONFIG: the proxy carries the rule (if Caddy is on this box)', async (t) => {
        // The Caddyfile lives on the box, not in the repo — so this asserts
        // the LIVE config, or skips. Without it, one careless edit of the
        // Caddyfile would put the HTML error page back and every reader on
        // the site would start throwing SyntaxErrors again.
        const cfgPath = '/etc/caddy/Caddyfile';
        if (!fs.existsSync(cfgPath)) return t.skip('no Caddyfile on this box');
        const cfg = fs.readFileSync(cfgPath, 'utf8');
        assert.ok(cfg.includes('handle_errors'), 'the site must handle proxy errors');
        assert.ok(/@api\s+path/.test(cfg),
            'the error handler must tell API paths from page paths');
        assert.ok(cfg.includes('Content-Type application/json'),
            'the API error branch must answer application/json');
        assert.ok(/respond\s+`\{[^`]*"error"/.test(cfg),
            'the API error branch must answer a JSON body');
    });

    test('a DEAD upstream on an API path answers JSON (the proxy drill)', async (t) => {
        // A throwaway Caddy carrying the production rule, proxying to a dead
        // port. No production traffic is touched.
        let caddyBin = null;
        try {
            caddyBin = execFileSync('which', ['caddy'], { encoding: 'utf8' }).trim();
        } catch (_e) {
            return t.skip('caddy is not installed on this box');
        }
        const port = 3900 + (process.pid % 90);
        const deadPort = port + 1;
        const body = '{"error":"the gateway is not answering right now - try again in a moment","status":502}';
        const cfg = [
            '{',
            '\tadmin off',
            '\tauto_https off',
            '}',
            ':' + port + ' {',
            '\thandle /api/* {',
            '\t\treverse_proxy 127.0.0.1:' + deadPort,
            '\t}',
            '\thandle_errors {',
            '\t\t@api path /api/*',
            '\t\thandle @api {',
            '\t\t\theader Content-Type application/json',
            '\t\t\trespond ' + String.fromCharCode(96) + body + String.fromCharCode(96) + ' 502',
            '\t\t}',
            '\t\thandle {',
            '\t\t\trespond "not json" 404',
            '\t\t}',
            '\t}',
            '}',
        ].join('\n');
        const cfgPath = path.join(os.tmpdir(), 'hivv-drill-' + process.pid + '.Caddyfile');
        fs.writeFileSync(cfgPath, cfg);
        const child = spawn(caddyBin, ['run', '--config', cfgPath, '--adapter', 'caddyfile'],
            { stdio: 'ignore', detached: true });
        try {
            let up = false;
            for (let i = 0; i < 40 && !up; i++) {
                await new Promise(r => setTimeout(r, 100));
                try {
                    await fetch('http://127.0.0.1:' + port + '/api/ping');
                    up = true;
                } catch (_e) { /* not yet */ }
            }
            assert.ok(up, 'the drill caddy never came up');
            const res = await fetch('http://127.0.0.1:' + port + '/api/ping');
            assert.equal(res.status, 502);
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            assert.ok(ct.includes('json'),
                'a dead upstream on an API path must answer JSON (got ' + ct + ')');
            const j = JSON.parse(await res.text());   // must NOT throw
            assert.ok(j.error, 'the JSON error says what happened');
        } finally {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_e) { /* gone */ }
            try { fs.unlinkSync(cfgPath); } catch (_e) { /* gone */ }
        }
    });
});

// ── LAW B: the client never throws on a broken body ──────────────────────

describe('LAW B — the client never throws on a broken body', () => {
    // The shared helper, evaluated in isolation with a stubbed fetch.
    function loadHelper(fakeFetch) {
        const src = read('js/shared.js');
        const cut = src.indexOf('window.HIVV = HIVV;');
        const body = cut > 0 ? src.slice(0, cut) : src;
        const sandbox = {
            fetch: fakeFetch,
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
            window: { location: { pathname: '/' } },
            console,
            document: { getElementById: () => null, querySelector: () => null },
            navigator: { clipboard: { writeText: async () => {} } },
            setTimeout, clearTimeout, setInterval, clearInterval,
        };
        const fn = new Function(...Object.keys(sandbox), body + '\nreturn HIVV;');
        return fn(...Object.values(sandbox));
    }

    test('the shared helper returns null for a 502 that carries an HTML page', async () => {
        const HIVV = loadHelper(async () => ({
            ok: false, status: 502,
            headers: { get: () => 'text/html; charset=utf-8' },
            json: async () => { throw new SyntaxError('Unexpected token <'); },
        }));
        assert.equal(await HIVV.json('/api/whatever'), null);
    });

    test('the shared helper returns null for a 404', async () => {
        const HIVV = loadHelper(async () => ({
            ok: false, status: 404,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: 'no such endpoint' }),
        }));
        assert.equal(await HIVV.json('/api/whatever'), null);
    });

    test('the shared helper returns null when the request never lands', async () => {
        const HIVV = loadHelper(async () => { throw new TypeError('Failed to fetch'); });
        assert.equal(await HIVV.json('/api/whatever'), null);
    });

    test('the shared helper returns null for a JSON body behind an HTML content type', async () => {
        const HIVV = loadHelper(async () => ({
            ok: true, status: 200,
            headers: { get: () => 'text/html' },
            json: async () => ({ ok: true }),
        }));
        assert.equal(await HIVV.json('/api/whatever'), null);
    });

    test('the shared helper still returns the body when the answer IS json', async () => {
        const HIVV = loadHelper(async () => ({
            ok: true, status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ ok: true, bees: 3 }),
        }));
        assert.deepEqual(await HIVV.json('/api/whatever'), { ok: true, bees: 3 });
    });

    test('a page may not parse a STATIC json file without checking the status', () => {
        // /api/* is safe now (the server answers JSON even when it fails).
        // A STATIC file is not: a missing one falls through to the HTML 404
        // page, and `await res.json()` on that throws a raw SyntaxError.
        const offenders = [];
        for (const p of htmlPages()) {
            const src = read(p);
            const lines = src.split('\n');
            lines.forEach((ln, i) => {
                const m = ln.match(/fetch\(['"]([^'"]+)['"]/);
                if (!m) return;
                const url = m[1];
                if (url.startsWith('/api/') || url.startsWith('/v1') || url.startsWith('/mcp')
                    || url.startsWith('/nodes/') || url.startsWith('/control/')) return;  // JSON by contract
                const win = lines.slice(i, i + 6).join('\n');
                if (!win.includes('.json()')) return;              // not a JSON read
                if (win.includes('.ok') || win.includes('HIVV.json(')) return;   // guarded
                offenders.push(p + ':' + (i + 1) + '  ' + ln.trim().slice(0, 90));
            });
        }
        assert.equal(offenders.length, 0,
            'a static json read must check res.ok first:\n  ' + offenders.join('\n  '));
    });

    test('the live panels on the homepage read through the safe helper', () => {
        const src = read('index.html');
        assert.ok(src.includes('/js/shared.js'), 'the homepage loads the shared utilities');
        assert.ok(src.includes('HIVV.json('), 'the homepage reads live data through the safe helper');
        assert.ok(!/Promise\.all\(\s*\[\s*fetch\('\/api\/public\/(status|dashboard-stats)/.test(src),
            'two live panels must not share one Promise.all — one failure took both down');
    });
});

// ── LAW C: no page depends on a third-party script ───────────────────────

describe('LAW C — no page depends on a third-party script', () => {
    test('no page loads a script from another origin', () => {
        const offenders = [];
        for (const p of htmlPages()) {
            const src = read(p);
            const re = /<script[^>]+src=["'](https?:)?\/\//gi;
            let m;
            while ((m = re.exec(src))) {
                offenders.push(p + ': ' + m[0].slice(0, 100));
            }
        }
        assert.equal(offenders.length, 0,
            'a third-party script is one blocker away from gone:\n  ' + offenders.join('\n  '));
    });

    test('no page references the Cloudflare beacon (it is Cloudflare\'s, and it gets blocked)', () => {
        for (const p of htmlPages()) {
            const src = read(p);
            assert.ok(!src.includes('cloudflareinsights'),
                p + ' references the Cloudflare beacon — an adblocker kills it');
        }
    });

    test('the libs the pages need are hosted by us', () => {
        for (const lib of ['lib/leaflet/leaflet.js', 'lib/d3/d3.v7.min.js']) {
            assert.ok(fs.existsSync(path.join(PUBLIC, lib)),
                'we host ' + lib + ' ourselves — a CDN is one blocker away from gone');
        }
    });
});