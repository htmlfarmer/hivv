// api/tests/polite.test.js — the responsible-fetch layer.
//
// Pins the promises made to the open web (2026-11-25, operator requirement:
// "follow terms of service as well as robots.txt … really not allow MASS
// REQUESTS … verify we are doing the correct thing"):
//   * robots.txt is parsed per RFC 9309: groups, prefix agent matching,
//     longest-match with Allow winning ties, Crawl-delay
//   * a Disallow REFUSES the fetch with an honest reason; absence allows
//   * decisions are cached (one robots.txt fetch per origin per 10 min)
//   * the per-host floor serializes rapid requests to ONE host and never
//     stalls different hosts; Crawl-delay is honored but capped at 10s
//   * the model cannot switch any of it off — only the operator can (env)
//   * toolkit.js actually CALLS the layer (wiring pins)
//
// No network: every fetch/checkUrl is injected.

const test = require('node:test');
const assert = require('node:assert');

const polite = require('../lib/polite');

function cannedFetch(status, body) {
    let calls = 0;
    const fn = async () => {
        calls++;
        return {
            status,
            body: {
                getReader() {
                    const buf = Buffer.from(body || '');
                    let sent = false;
                    return {
                        read: async () => {
                            if (sent) return { done: true };
                            sent = true;
                            return { done: false, value: buf };
                        },
                        cancel: async () => {},
                    };
                },
            },
        };
    };
    fn.calls = () => calls;
    return fn;
}

const allowAll = async () => ({ ok: true });

function withEnv(key, value, fn) {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    const done = () => {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
    };
    return Promise.resolve().then(fn).then(
        r => { done(); return r; },
        e => { done(); throw e; });
}

// ── parsing ─────────────────────────────────────────────────────────────────

test('parseRobots: groups, comments, crawl-delay, empty disallow', () => {
    const groups = polite.parseRobots([
        '# a comment',
        'User-agent: *',
        'Disallow: /private',
        'Crawl-delay: 4',
        '',
        'User-agent: hivv',
        'User-agent: hivv-toolkit',
        'Disallow: /nope',
        'Allow: /nope/ok',
    ].join('\n'));
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].agents, ['*']);
    assert.equal(groups[0].crawlDelay, 4);
    assert.deepEqual(groups[1].agents, ['hivv', 'hivv-toolkit']);
    assert.equal(groups[1].rules.length, 2);
});

test('parseRobots: rules before any user-agent are ignored', () => {
    const groups = polite.parseRobots('Disallow: /x\nUser-agent: *\nAllow: /y');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].rules.length, 1);
    assert.equal(groups[0].rules[0].allow, true);
});

// ── decisions ───────────────────────────────────────────────────────────────

test('decide: our agent group beats the star group', () => {
    const groups = polite.parseRobots([
        'User-agent: *', 'Disallow: /all',
        'User-agent: hivv', 'Allow: /all',
    ].join('\n'));
    assert.equal(polite.decide(groups, 'hivv-toolkit', '/all').allowed, true);
    assert.equal(polite.decide(groups, 'otherbot', '/all').allowed, false);
});

test('decide: prefix matching — "hivv" matches our token, "googlebot" does not', () => {
    const g1 = polite.parseRobots('User-agent: hivv\nDisallow: /x');
    assert.equal(polite.decide(g1, 'hivv-toolkit', '/x').allowed, false);
    const g2 = polite.parseRobots('User-agent: googlebot\nDisallow: /x');
    assert.equal(polite.decide(g2, 'hivv-toolkit', '/x').allowed, true);
});

test('rulesAllow: longest match wins, Allow wins ties, wildcards work', () => {
    const mk = lines => polite.parseRobots('User-agent: *\n' + lines)
        .flatMap(g => g.rules);
    // longest match
    assert.equal(polite.rulesAllow(mk('Disallow: /a\nAllow: /a/b'), '/a/b'), true);
    assert.equal(polite.rulesAllow(mk('Disallow: /a\nAllow: /a/b'), '/a/c'), false);
    // tie → Allow wins
    assert.equal(polite.rulesAllow(mk('Disallow: /p\nAllow: /p'), '/p'), true);
    // wildcard + trailing anchor: the PDF is DISALLOWED, the HTML is not
    assert.equal(polite.rulesAllow(mk('Disallow: /*.pdf$'), '/docs/x.pdf'), false);
    assert.equal(polite.rulesAllow(mk('Disallow: /*.pdf$'), '/docs/x.html'), true);
    // an empty Disallow restricts nothing
    assert.equal(polite.rulesAllow(mk('Disallow:'), '/anything'), true);
    // no rules at all → allowed
    assert.equal(polite.rulesAllow([], '/anything'), true);
});

test('decide: Crawl-delay is read from the matching group', () => {
    const groups = polite.parseRobots('User-agent: *\nCrawl-delay: 7\nDisallow: /x');
    assert.equal(polite.decide(groups, 'hivv-toolkit', '/y').crawlDelay, 7);
    const none = polite.parseRobots('User-agent: *\nDisallow: /x');
    assert.equal(polite.decide(none, 'hivv-toolkit', '/y').crawlDelay, null);
});

// ── checkRobots (injected fetch) ────────────────────────────────────────────

test('checkRobots: a Disallow refuses; the next decision comes from cache', async () => {
    polite._reset();
    const fetchImpl = cannedFetch(200, 'User-agent: *\nDisallow: /secret\n');
    const v = await polite.checkRobots('https://example.com/secret/page',
        { fetchImpl, checkUrl: allowAll });
    assert.equal(v.allowed, false);
    assert.equal(v.source, 'robots');

    const v2 = await polite.checkRobots('https://example.com/public',
        { fetchImpl, checkUrl: allowAll });
    assert.equal(v2.allowed, true);
    assert.equal(v2.source, 'cache');
    assert.equal(fetchImpl.calls(), 1, 'one robots.txt fetch per origin per TTL');
    polite._reset();
});

test('checkRobots: 404 robots.txt → fetching allowed (RFC 9309)', async () => {
    polite._reset();
    const v = await polite.checkRobots('https://nothing.example/anywhere',
        { fetchImpl: cannedFetch(404, ''), checkUrl: allowAll });
    assert.equal(v.allowed, true);
    assert.equal(v.source, 'no-robots');
    polite._reset();
});

test('checkRobots: /robots.txt itself is always fetchable, no request made', async () => {
    polite._reset();
    const fetchImpl = cannedFetch(200, 'User-agent: *\nDisallow: /\n');
    const v = await polite.checkRobots('https://example.com/robots.txt',
        { fetchImpl, checkUrl: allowAll });
    assert.equal(v.allowed, true);
    assert.equal(v.source, 'robots-txt');
    assert.equal(fetchImpl.calls(), 0);
});

test('checkRobots: a broken robots fetch never bricks the tool', async () => {
    polite._reset();
    const boom = async () => { throw new Error('connection reset'); };
    const v = await polite.checkRobots('https://flaky.example/page',
        { fetchImpl: boom, checkUrl: allowAll });
    assert.equal(v.allowed, true);
    assert.equal(v.source, 'no-robots');
    polite._reset();
});

test('checkRobots: the OPERATOR can turn it off — env read at call time', async () => {
    polite._reset();
    await withEnv('HIVV_FETCH_ROBOTS', '0', async () => {
        const fetchImpl = cannedFetch(200, 'User-agent: *\nDisallow: /\n');
        const v = await polite.checkRobots('https://example.com/x',
            { fetchImpl, checkUrl: allowAll });
        assert.equal(v.allowed, true);
        assert.equal(v.source, 'robots-disabled');
        assert.equal(fetchImpl.calls(), 0);
    });
    polite._reset();
});

// ── the no-mass-requests floor ──────────────────────────────────────────────

test('intervalFor: our floor, the site Crawl-delay, capped at 10s', async () => {
    await withEnv('HIVV_FETCH_MIN_INTERVAL_MS', '0', async () => {
        assert.equal(polite.intervalFor(null), 0);
        assert.equal(polite.intervalFor(3), 3000);
        assert.equal(polite.intervalFor(9999), polite.MAX_CRAWL_DELAY_S * 1000);
    });
    delete process.env.HIVV_FETCH_MIN_INTERVAL_MS;
    assert.equal(polite.intervalFor(null), 2000, 'default floor is 2 seconds');
});

test('hold: serializes ONE host, never stalls a different host', async () => {
    await withEnv('HIVV_FETCH_MIN_INTERVAL_MS', '70', async () => {
        polite._reset();
        const t0 = Date.now();
        const w1 = await polite.hold('a.example');
        const w2 = await polite.hold('a.example');
        const w3 = await polite.hold('b.example');
        const elapsed = Date.now() - t0;
        assert.equal(w1, 0, 'the first hit has no history');
        assert.ok(w2 >= 60, 'the second hit to the SAME host waits the interval, got ' + w2);
        assert.equal(w3, 0, 'a different host must not wait on a.example');
        assert.ok(elapsed >= 60);
        polite._reset();
    });
});

test('hold: interval 0 disables the pause entirely', async () => {
    await withEnv('HIVV_FETCH_MIN_INTERVAL_MS', '0', async () => {
        polite._reset();
        assert.equal(await polite.hold('x.example'), 0);
        assert.equal(await polite.hold('x.example'), 0);
    });
});

// ── toolkit wiring ──────────────────────────────────────────────────────────

test('toolkit web_fetch: a robots refusal reaches the caller, verbatim', async () => {
    const toolkit = require('../lib/toolkit');
    const handler = toolkit.TOOLS.find(t => t.name === 'web_fetch').handler;
    const origCheck = polite.checkRobots;
    try {
        polite.checkRobots = async () => ({
            allowed: false, origin: 'https://example.com',
            host: 'example.com', crawlDelay: null, source: 'robots',
        });
        const res = await handler({ url: 'https://example.com/secret' });
        assert.equal(res.ok, false);
        assert.equal(res.refused, true);
        assert.match(res.error, /robots\.txt/);
        assert.match(res.error, /asked crawlers not to read it/);
        assert.equal(res.data.robots, 'disallowed');
    } finally {
        polite.checkRobots = origCheck;
    }
});

test('toolkit web_fetch: the per-host hold runs before the fetch', async () => {
    const toolkit = require('../lib/toolkit');
    const handler = toolkit.TOOLS.find(t => t.name === 'web_fetch').handler;
    const origCheck = polite.checkRobots;
    const origHold = polite.hold;
    const held = [];
    try {
        polite.checkRobots = async () => ({
            allowed: true, origin: 'http://127.0.0.1:3011',
            host: '127.0.0.1:3011', crawlDelay: 5, source: 'robots',
        });
        polite.hold = async (host, delay) => { held.push([host, delay]); return 0; };
        // loopback is SSRF-refused by safeFetch — deterministic, no network
        const res = await handler({ url: 'http://127.0.0.1:3011/page' });
        assert.deepEqual(held, [['127.0.0.1:3011', 5]], 'hold(host, crawlDelay) must run first');
        assert.equal(res.ok, false);
        assert.equal(res.refused, true);
    } finally {
        polite.checkRobots = origCheck;
        polite.hold = origHold;
    }
});

test('toolkit http_request: the no-mass-requests floor runs before every call', async () => {
    const toolkit = require('../lib/toolkit');
    const handler = toolkit.TOOLS.find(t => t.name === 'http_request').handler;
    const origHold = polite.hold;
    const held = [];
    try {
        polite.hold = async host => { held.push(host); return 0; };
        const res = await handler({ url: 'http://127.0.0.1:3011/api/x' });
        assert.deepEqual(held, ['127.0.0.1:3011']);
        assert.equal(res.ok, false);      // SSRF refuses loopback
        assert.equal(res.refused, true);
    } finally {
        polite.hold = origHold;
    }
});

test('toolkit web_search: official APIs only, both backends throttled', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'toolkit.js'), 'utf8');
    assert.ok(!/duckduckgo|bing\.com|google\.com\/search|yahoo\.com\/search/i.test(src),
        'search must never hit a scraped search engine — official APIs only');
    assert.ok(src.includes("polite.hold('en.wikipedia.org')"),
        'the Wikipedia API backend must go through the floor');
    assert.ok(src.includes("polite.hold('news.google.com')"),
        'the Google News RSS backend must go through the floor');
});
