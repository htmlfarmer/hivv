// K3/K4 — per-principal route defaults + privacy 'self'
// (HIVV_PERSONAL_MODELS_PLAN.md §6, backlog J3/J4).
//
// K3: gateway_config.routing.principal_defaults fills ONLY the fields a
//     request did not set — an explicit route.mode always wins.
// K4: privacy 'self' hard-filters candidates to the caller's own bees:
//     proven node:<id> scope + bees claimed via PUT /api/prefs {self_nodes}.
//     No verified scopes → owns NOTHING (empty set, never "everything").
const { test } = require('node:test');
const assert = require('node:assert');
const AIRouter = require('../lib/router');

// The constructor starts a 10s spare-time monitor — a live-process concern
// these tests don't need, and a setInterval that keeps the test PROCESS alive
// forever after the last assertion. Neutralize it for this file only.
AIRouter.prototype.startSpareTimeMonitor = function () {};

// routeDefaultFor / selfAllowedNodes / filterSelfTargets read only
// this._routeCfg — a bare instance with the config stamped on is exact.
function makeRouter(cfg = {}) {
    const rt = new AIRouter();
    rt._routeCfg = { ...rt._routeCfg, ...cfg };
    return rt;
}

// ── K3: routeDefaultFor ─────────────────────────────────────────────────────

test('K3: stored defaults come back for a matching scope', () => {
    const rt = makeRouter({
        principal_defaults: {
            'visitor:v_abc': { mode: 'fast', privacy: 'self' },
            'user:5': { mode: 'quality' },
        },
    });
    assert.deepStrictEqual(rt.routeDefaultFor(['visitor:v_abc']), { mode: 'fast', privacy: 'self' });
    assert.deepStrictEqual(rt.routeDefaultFor(['user:5']), { mode: 'quality' });
});

test('K3: scopes are checked strongest-first — the first stored match wins', () => {
    const rt = makeRouter({
        principal_defaults: {
            'user:5': { mode: 'quality' },
            'visitor:v_abc': { mode: 'fast' },
        },
    });
    assert.strictEqual(
        rt.routeDefaultFor(['user:5', 'visitor:v_abc']).mode, 'quality',
        'the session scope outranks the cookie scope it coexists with');
});

test('K3: garbage in storage is ignored — unknown mode/privacy never applies', () => {
    const rt = makeRouter({
        principal_defaults: {
            'visitor:v_abc': { mode: 'yolo', privacy: 'dmz' },
            'visitor:v_ok': { mode: 'fast', privacy: 'self' },
        },
    });
    assert.strictEqual(rt.routeDefaultFor(['visitor:v_abc']), null, 'both fields invalid → no pref');
    assert.deepStrictEqual(rt.routeDefaultFor(['visitor:v_ok']), { mode: 'fast', privacy: 'self' });
    assert.strictEqual(rt.routeDefaultFor(['visitor:v_none']), null, 'nothing stored → null');
    assert.strictEqual(rt.routeDefaultFor([]), null);
    assert.strictEqual(rt.routeDefaultFor(null), null, 'no scopes at all → null');
});

// ── K4: selfAllowedNodes / filterSelfTargets ────────────────────────────────

test('K4: a proven node scope reaches that node — and only that node', () => {
    const rt = makeRouter();
    const allowed = rt.selfAllowedNodes(['node:ashy']);
    assert.ok(allowed.has('ashy'));
    assert.strictEqual(allowed.size, 1);
});

test('K4: claimed bees (self_owners) join the set; other scopes claim nothing', () => {
    const rt = makeRouter({
        self_owners: {
            ashy: ['visitor:v_abc'],
            yalla: ['visitor:v_other'],
        },
    });
    const mine = rt.selfAllowedNodes(['visitor:v_abc']);
    assert.ok(mine.has('ashy'), 'my claim resolves');
    assert.ok(!mine.has('yalla'), "someone else's claim is not mine");
    assert.strictEqual(rt.selfAllowedNodes(['visitor:v_nobody']).size, 0,
        'an unclaimed scope owns NOTHING — never "everything"');
    assert.strictEqual(rt.selfAllowedNodes(null).size, 0);
    assert.strictEqual(rt.selfAllowedNodes(undefined).size, 0);
});

test('K4: filterSelfTargets keeps hub-local entries and my bees, drops the rest', () => {
    const rt = makeRouter({ self_owners: { ashy: ['node:ashy'] } });
    const targets = [
        { url: 'http://localhost:8090/v1', name: 'local' },            // no nodeId → hub-local
        { url: 'http://192.168.1.5:8080/v1', name: 'ashy:8080', nodeId: 'ashy' },
        { url: 'http://192.168.1.9:8080/v1', name: 'masjid:8080', nodeId: 'masjid' },
        { url: 'http://192.168.1.7:8080/v1', name: 'yalla:8080', nodeId: 'yalla' },
    ];
    const out = rt.filterSelfTargets(targets, ['node:ashy']);
    assert.deepStrictEqual(out.map(t => t.name), ['local', 'ashy:8080'],
        'hub-local + my bee survive; other bees are gone');
    const anon = rt.filterSelfTargets(targets, []);
    assert.deepStrictEqual(anon.map(t => t.name), ['local'],
        'no verified scope → hub-local only');
});

// ── K3 application: routeWithFailover fills what the request left out ──────

test('K3: routeWithFailover applies the stored default — and explicit route wins', async () => {
    const rt = makeRouter({
        principal_defaults: { 'visitor:v_abc': { mode: 'fast', privacy: 'self' } },
    });

    // No route given → the pref fills both fields (cloud blocked via self).
    const optsA = { keyScopes: ['visitor:v_abc'], route: {}, stream: false };
    await rt.routeWithFailover([], optsA);
    assert.strictEqual(optsA.route.mode, 'fast');
    assert.strictEqual(optsA.privacy, 'self');
    assert.strictEqual(optsA.route.privacy, 'self');

    // Explicit route given → the pref must NOT override THAT FIELD. Prefs are
    // per-field on purpose: saying --mode=fast must not silently disable your
    // stored privacy=safety-net.
    const optsB = { keyScopes: ['visitor:v_abc'], route: { mode: 'quality' }, stream: false };
    await rt.routeWithFailover([], optsB);
    assert.strictEqual(optsB.route.mode, 'quality', 'the explicit mode wins');
    assert.strictEqual(optsB.privacy, 'self',
        'the privacy pref still applies — a safety default is per-field');
});

// ── K4 preview: routePreview('self') shows exactly the allowed world ───────

test('K4: dry-run with privacy self shows no strangers — relay, cloud, order', async () => {
    const rt = makeRouter();
    rt.orchestrator = {
        nodes: new Map([
            ['ashy', { node_id: 'ashy', name: 'ashy', status: 'online', volunteer: true,
                local_models: [{ port: 8090, model: 'gemma' }] }],
            ['masjid', { node_id: 'masjid', name: 'masjid', status: 'online', volunteer: true,
                local_models: [{ port: 8081, model: 'qwen' }] }],
        ]),
    };
    rt.providers.set('openai', { name: 'openai', isCloud: true });

    // Anonymous caller: owns nothing → no relay, no cloud, local-only table.
    const anon = await rt.routePreview({ privacy: 'self', keyScopes: [] });
    assert.strictEqual(anon.transports.relay.length, 0, 'anonymous owns no bees');
    assert.strictEqual(anon.transports.cloud.length, 0, 'self never shows cloud');
    assert.deepStrictEqual(anon.order, ['local', 'direct', 'relay']);

    // The bee itself: its own volunteer appears, the stranger's does not.
    const mine = await rt.routePreview({ privacy: 'self', keyScopes: ['node:ashy'] });
    assert.deepStrictEqual(mine.transports.relay.map(r => r.node), ['ashy'],
        'only MY bee is offered for relay');

    // Contrast: privacy any DOES include cloud (the gate is per-privacy).
    const any = await rt.routePreview({ privacy: 'any', keyScopes: [] });
    assert.strictEqual(any.transports.cloud.length, 1, 'any keeps the cloud door open');
    assert.ok(any.transports.relay.length >= 1, 'any keeps every volunteer');
});

// ── LIVE: the prefs door itself ─────────────────────────────────────────────

async function gatewayUp() {
    try {
        const r = await fetch('http://127.0.0.1:3011/api/health', { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch (_e) { return false; }
}

async function api(path, { method = 'GET', body, cookie } = {}) {
    const r = await fetch('http://127.0.0.1:3011' + path, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
}

test('LIVE: prefs refuse an unverified caller — 403 NO_IDENTITY', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const r = await api('/api/prefs');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'NO_IDENTITY');
    assert.ok(r.json.hint, 'says how to get an identity');
});

test('LIVE: full round-trip on a signed-cookie identity (set → read → clear)', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    // 1. mint a signed visitor cookie (cheap endpoint, no model call)
    const v = await api('/api/visitor/id');
    const cookie = (v.setCookie || '').split(';')[0];
    if (!cookie || !cookie.startsWith('hivv_visitor=')) {
        return t.skip('no visitor cookie issued by this gateway');
    }

    // 2. the cookie is a VERIFIED scope → prefs readable
    const before = await api('/api/prefs', { cookie });
    assert.strictEqual(before.status, 200, JSON.stringify(before.json));
    assert.ok((before.json.scopes || [])[0].startsWith('visitor:'), 'scope from the signed cookie');

    // 3. set a default (mode fast + privacy self under THIS test's cookie —
    //    nobody else's traffic presents this cookie, so the hive is untouched)
    const put = await api('/api/prefs', { method: 'PUT', cookie, body: { mode: 'fast', privacy: 'self' } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));
    assert.deepStrictEqual(put.json.defaults, { mode: 'fast', privacy: 'self' });

    // 4. read it back
    const after = await api('/api/prefs', { cookie });
    assert.deepStrictEqual(after.json.defaults, { mode: 'fast', privacy: 'self' });

    // 5. unknown bee claim → 404, nothing written for it
    const bad = await api('/api/prefs', { method: 'PUT', cookie, body: { self_nodes: ['definitely-not-a-bee'] } });
    assert.strictEqual(bad.status, 404);
    assert.strictEqual(bad.json.code, 'UNKNOWN_NODE');

    // 6. clear everything — leave the store as we found it
    const clear = await api('/api/prefs', { method: 'PUT', cookie,
        body: { mode: null, privacy: null, self_nodes: [] } });
    assert.strictEqual(clear.status, 200);
    assert.strictEqual(clear.json.defaults, null);
    const final = await api('/api/prefs', { cookie });
    assert.strictEqual(final.json.defaults, null, 'cleared');
    assert.deepStrictEqual(final.json.self_nodes, [], 'no claims left');
});

test('LIVE: PUT without any body fields → 400 with the example shape', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const v = await api('/api/visitor/id');
    const cookie = (v.setCookie || '').split(';')[0];
    if (!cookie) return t.skip('no visitor cookie');
    const r = await api('/api/prefs', { method: 'PUT', cookie, body: {} });
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.example, 'self-describing error');
});

test('LIVE: dry-run privacy=self advertises the self world', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const r = await api('/api/capabilities/route/dry-run?privacy=self');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.order, ['local', 'direct', 'relay']);
    assert.strictEqual(r.json.transports.cloud.length, 0, 'self never routes to cloud');
});
