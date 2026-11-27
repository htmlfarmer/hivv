// K2 — the donor guard-rails (HIVV_PERSONAL_MODELS_PLAN.md §5 P2/P3/P4).
//
// api/lib/key-donation.js was fully written and EXPORTED — and referenced
// nowhere. This suite pins the four things it promises, plus the two new
// pieces K2 added (personal semantics + spend windows), and then hits the
// LIVE endpoint's rejection paths (all of which fire BEFORE any INSERT, so
// the suite never writes a row).
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const keyDonation = require('../lib/key-donation');
const ssrf = require('../lib/ssrf');

// Credential-shaped FIXTURES are BUILT, never spelled out: the pre-push
// scanner (scripts/scan_secrets.py) blocks any source line that ASSIGNS a
// quoted value to `api_key` — the same rule that protects real keys, and a
// test that defeats it blocks every push. Repo convention:
// tests/test_scan_secrets.py constructs its canaries as "sk-" + "y"*24.
const FAKE_KEY = 'sk-' + 'donation-fixture-key';

// ── helpers ────────────────────────────────────────────────────────────────
function fakeReq(over = {}) {
    return {
        ip: over.ip || '10.9.8.7',
        headers: { 'user-agent': over.ua || 'key-donation-test/1.0' },
    };
}

// SSRF is mocked per-test: unit tests must never depend on the network, and
// the real check is covered live below (localhost endpoint → refused).
const realCheckUrl = ssrf.checkUrl;
afterEach(() => { ssrf.checkUrl = realCheckUrl; keyDonation._resetKeyWindows(); });

async function validate(opts, req = fakeReq(), dopts = {}) {
    return keyDonation.validateDonation(req, opts, dopts);
}

// ── provider allow-list + key sanity ───────────────────────────────────────
test('missing provider / key → 400', async () => {
    assert.strictEqual((await validate({})).status, 400);
    assert.strictEqual((await validate({ provider: 'groq' })).status, 400);
});

test('unknown provider → 400 with the known list (custom must be spelled "custom")', async () => {
    const r = await validate({ provider: 'sketchy', api_key: FAKE_KEY });
    assert.strictEqual(r.status, 400);
    assert.match(r.error, /unknown provider/);
    assert.ok(r.detail.known.includes('custom'));
});

test('key sanity: too short, too long, and PEM private keys all refused', async () => {
    assert.strictEqual((await validate({ provider: 'groq', api_key: 'short' })).status, 400);
    assert.strictEqual(
        (await validate({ provider: 'groq', api_key: 'k'.repeat(501) })).status, 400);
    // The PEM header is ASSEMBLED, never spelled out: the pre-commit guard
    // blocks any literal private-key header in staged content (a header alone
    // is enough for it) — and a detector must not carry the thing it detects.
    const PEM_HDR = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const PEM = PEM_HDR + '\nmcvee\n' + PEM_HDR.replace('BEGIN', 'END');
    const pem = await validate({ provider: 'groq', api_key: PEM });
    assert.strictEqual(pem.status, 400);
    assert.match(pem.error, /private key/);
});

// ── endpoint: URL shape + THE SSRF CHECK ───────────────────────────────────
test('endpoint must be a valid http(s) URL', async () => {
    ssrf.checkUrl = async () => ({ ok: true });
    assert.strictEqual(
        (await validate({ provider: 'custom', api_key: FAKE_KEY, endpoint: 'not a url' })).status, 400);
    const file = await validate({
        provider: 'custom', api_key: FAKE_KEY, endpoint: 'file:///etc/passwd',
    });
    assert.strictEqual(file.status, 400);
    assert.match(file.error, /scheme/);
});

test('THE SSRF CHECK: an endpoint pointing inside is refused before anything is stored', async () => {
    ssrf.checkUrl = async () => ({ ok: false, reason: 'private address (blocked for test)' });
    const r = await validate({
        provider: 'custom', api_key: FAKE_KEY, endpoint: 'http://127.0.0.1:5432/v1',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.detail.code, 'ENDPOINT_BLOCKED');
});

// ── donor daily limit (5 keys / fingerprint / 24h) ─────────────────────────
test('the sixth key from one donor in a day → 429 DONOR_LIMIT', async () => {
    ssrf.checkUrl = async () => ({ ok: true });
    const req = fakeReq({ ip: '203.0.113.9', ua: 'donor-limit-probe' });
    for (let i = 0; i < keyDonation.MAX_KEYS_PER_DONOR; i++) {
        keyDonation.noteDonorKey(keyDonation.donorFingerprint(req));
    }
    const r = await validate({ provider: 'groq', api_key: FAKE_KEY }, req);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.detail.code, 'DONOR_LIMIT');
    assert.strictEqual(r.detail.limit, 5);
    // a DIFFERENT donor is unaffected
    const other = await validate(
        { provider: 'groq', api_key: FAKE_KEY },
        fakeReq({ ip: '203.0.113.10', ua: 'someone-else' }));
    assert.strictEqual(other.ok, true);
});

test('donorFingerprint: stable per donor, different across donors, never the raw IP', async () => {
    const a = keyDonation.donorFingerprint(fakeReq({ ip: '198.51.100.4' }));
    const b = keyDonation.donorFingerprint(fakeReq({ ip: '198.51.100.4' }));
    const c = keyDonation.donorFingerprint(fakeReq({ ip: '198.51.100.5' }));
    assert.strictEqual(a, b, 'same donor → same fingerprint');
    assert.notStrictEqual(a, c, 'different donor → different fingerprint');
    assert.match(a, /^[0-9a-f]{32}$/, 'hex digest, not an address');
    assert.ok(!a.includes('198.51.100.4'), 'raw IP never appears in the fingerprint');
});

// ── caps: defaults for donations, NONE for personal ────────────────────────
test('a donation gets the default spend caps spelled out in the plan', async () => {
    ssrf.checkUrl = async () => ({ ok: true });
    const r = await validate({ provider: 'groq', api_key: FAKE_KEY });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.plan.max_requests_per_hour, keyDonation.DEFAULT_MAX_REQUESTS_PER_HOUR);
    assert.strictEqual(r.plan.max_tokens_per_day, keyDonation.DEFAULT_MAX_TOKENS_PER_DAY);
    assert.strictEqual(r.plan.personal, false);
});

test('a PERSONAL key defaults to NO caps (only its owner can spend it)', async () => {
    ssrf.checkUrl = async () => ({ ok: true });
    const r = await validate(
        { provider: 'groq', api_key: FAKE_KEY }, fakeReq(), { personal: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.plan.max_requests_per_hour, null);
    assert.strictEqual(r.plan.max_tokens_per_day, null);
    assert.strictEqual(r.plan.personal, true);
});

test('explicit caps are honoured either way; non-positive caps refused', async () => {
    ssrf.checkUrl = async () => ({ ok: true });
    const r = await validate(
        { provider: 'groq', api_key: FAKE_KEY, max_requests_per_hour: '7' },
        fakeReq(), { personal: true });
    assert.strictEqual(r.plan.max_requests_per_hour, 7, 'owner may opt INTO a cap');
    const bad = await validate(
        { provider: 'groq', api_key: FAKE_KEY, max_tokens_per_day: '0' });
    assert.strictEqual(bad.status, 400);
});

// ── spend windows (the caps the router enforces) ───────────────────────────
test('hourly request window: fills to the cap, then the key bows out', () => {
    const key = { id: 501, maxRequestsPerHour: 3, maxTokensPerDay: null };
    assert.strictEqual(keyDonation.keyOverBudget(key), false);
    keyDonation.noteKeyRequest(501);
    keyDonation.noteKeyRequest(501);
    assert.strictEqual(keyDonation.keyOverBudget(key), false, '2 of 3 spent');
    keyDonation.noteKeyRequest(501);
    assert.strictEqual(keyDonation.keyOverBudget(key), true, '3 of 3 spent');
    const snap = keyDonation.keyWindowSnapshot(501);
    assert.strictEqual(snap.requestsLastHour, 3);
});

test('daily token window: tokens accumulate until the budget, midnight resets it', () => {
    const key = { id: 502, maxRequestsPerHour: null, maxTokensPerDay: 1000 };
    keyDonation.noteKeyTokens(502, 600);
    assert.strictEqual(keyDonation.keyOverBudget(key), false);
    keyDonation.noteKeyTokens(502, 400);
    assert.strictEqual(keyDonation.keyOverBudget(key), true, '1000/1000 spent');
    assert.strictEqual(keyDonation.keyWindowSnapshot(502).tokensToday, 1000);
});

test('a key with NO caps is never over budget; null/odd tokens count nothing', () => {
    const key = { id: 503, maxRequestsPerHour: null, maxTokensPerDay: null };
    for (let i = 0; i < 100; i++) keyDonation.noteKeyRequest(503);
    keyDonation.noteKeyTokens(503, 'not-a-number');
    keyDonation.noteKeyTokens(503, -5);
    assert.strictEqual(keyDonation.keyOverBudget(key), false);
    assert.strictEqual(keyDonation.keyWindowSnapshot(503).tokensToday, 0);
    // keys without an id (test fakes) are never budget-checked at all
    assert.strictEqual(keyDonation.keyOverBudget({ maxRequestsPerHour: 1 }), false);
});

// ── LIVE endpoint: rejection paths (all fire BEFORE any INSERT) ────────────
async function gatewayUp() {
    try {
        const r = await fetch('http://127.0.0.1:3011/api/health', { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch (_e) { return false; }
}

async function donate(body) {
    const r = await fetch('http://127.0.0.1:3011/api/keys/donate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
}

test('LIVE: unknown provider → 400, nothing written', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const r = await donate({ provider: 'definitely-not-a-provider', api_key: FAKE_KEY });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /unknown provider/);
});

test('LIVE: short key → 400', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const r = await donate({ provider: 'groq', api_key: 'short' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /too short/);
});

test('LIVE: an endpoint aimed at THIS box is refused by the SSRF guard', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const r = await donate({
        provider: 'custom', api_key: FAKE_KEY, endpoint: 'http://127.0.0.1:5432/v1',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.detail && r.json.detail.code, 'ENDPOINT_BLOCKED');
});

test('LIVE: personal without ANY verified identity → 401 IDENTITY_REQUIRED', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    // No signed cookie, no node secret, no session — exactly what an
    // anonymous curl presents. Must never bind a key to "nothing".
    const r = await donate({ provider: 'groq', api_key: FAKE_KEY, personal: true });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.code, 'IDENTITY_REQUIRED');
    assert.ok(r.json.hint && r.json.hint.length > 10, 'tells the caller how to fix it');
});

test('LIVE: missing provider+key → 400 with the documented example', async (t) => {
    if (!(await gatewayUp())) return t.skip('gateway not running on :3011');
    const r = await donate({});
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.example, 'keeps the self-describing error the site documents');
});
