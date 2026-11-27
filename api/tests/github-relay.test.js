// api/tests/github-relay.test.js — the relay's OWN surface.
//
// proposal-funnel.test.js pins the funnel's five laws and touches the relay
// once. This file pins the relay itself — in particular the idempotency
// lookup, which is the one place a bug quietly double-files an issue on a
// real repository.
//
// THE BUG THIS FILE EXISTS TO KEEP FIXED
// ───────────────────────────────────────
// The lookup used to call GET /search/issues. GitHub's search index is
// eventually consistent: an issue just created may not be searchable for
// seconds to minutes. A retry inside that window gets a clean 200 with no
// items — indistinguishable from "no issue yet" — and files a SECOND one.
// The old code correctly refused when search FAILED; it could not tell a
// stale SUCCESS from the truth.
//
// So: the lookup reads GET /repos/:repo/issues (consistent with the write),
// and this file asserts BOTH halves — that it uses the list endpoint, and
// that a failed lookup still throws instead of returning null.
//
// REAL MODE WITH A MOCKED fetch — set a dummy token and intercept global
// fetch, so the code path that would talk to GitHub is the one under test.
// Nothing here reaches the network, and no test can leave a stray token in
// the environment for the next file.
//
// Run with:  cd api && node --test tests/github-relay.test.js

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── isolate BEFORE require ──────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-relay-'));
process.env.HIVV_DATA_DIR = path.join(TMP, 'data');
delete process.env.HIVV_GITHUB_TOKEN;   // start in stub mode

const relay = require('../lib/github-relay');
const policy = require('../lib/policy');

const realFetch = global.fetch;
let calls = [];

after(() => {
  global.fetch = realFetch;
  delete process.env.HIVV_GITHUB_TOKEN;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
});

// Each test starts from an EMPTY stub store. Without this, a test that
// counts artifacts inherits every file the earlier tests wrote and asserts
// on the wrong number (which is exactly how test 19 first failed).
beforeEach(() => {
  calls = [];
  try { fs.rmSync(relay.stubDir(), { recursive: true, force: true }); }
  catch (_e) { /* dir may not exist yet */ }
});

// ── helpers ────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

// Switch the relay into REAL mode with fetch intercepted. Every request is
// recorded so a test can assert on endpoints and methods, not just results.
function useRealMode(handler) {
  process.env.HIVV_GITHUB_TOKEN = 'dummy-token-for-tests-only';
  global.fetch = async (url, opts = {}) => {
    const entry = { url: String(url), method: (opts.method || 'GET').toUpperCase() };
    calls.push(entry);
    return handler(entry.url, entry.method);
  };
}

// The relay asks lib/policy.js before every write (law D's sibling). Most
// tests care about the write, not the gate, so let the gate through and put
// it back — proposal-funnel.test.js already pins deny/ask.
function allowWrites() {
  const original = policy.gate;
  policy.gate = async () => ({ verdict: 'allow' });
  return () => { policy.gate = original; };
}

function backToStub() {
  delete process.env.HIVV_GITHUB_TOKEN;
  global.fetch = realFetch;
}

function stubIssueFiles() {
  try {
    return fs.readdirSync(relay.stubDir()).filter((f) => f.startsWith('issue-'));
  } catch (_e) { return []; }
}

const pageOf = (n, body = 'no marker here') =>
  Array.from({ length: n }, (_, i) => ({ number: 1000 + i, body }));

// ══ mode ══════════════════════════════════════════════════════════════════

test('stub mode by default: no token, no network, credential reported as none', () => {
  backToStub();
  assert.equal(relay.isStub(), true);
  const s = relay.status();
  assert.equal(s.stub, true);
  assert.equal(s.credential, 'none (offline stub)');
  assert.match(s.stub_dir, /github-stub$/);
});

test('status() reports token PRESENCE only — never the token itself', () => {
  process.env.HIVV_GITHUB_TOKEN = 'ghp_this_must_never_appear';
  try {
    assert.equal(relay.isStub(), false);
    const s = relay.status();
    assert.equal(s.credential, 'present');
    assert.ok(!JSON.stringify(s).includes('ghp_this_must_never_appear'),
      'the token leaked into status()');
    // ...and not through the token() accessor being stringified either.
    assert.ok(!JSON.stringify(s).includes('dummy'), 'a token leaked into status()');
  } finally {
    backToStub();
  }
});

// ══ the marker ═════════════════════════════════════════════════════════════

test('marker / hasMarker round-trip', () => {
  const id = 'prop_round_trip';
  const m = relay.marker(id);
  assert.equal(m, '<!-- hive-proposal:prop_round_trip -->');
  assert.equal(relay.hasMarker(id, 'body\n\n' + m), true);
  assert.equal(relay.hasMarker(id, 'body with no marker'), false);
  // A different proposal's marker must never match this one.
  assert.equal(relay.hasMarker(id, relay.marker('someone_else')), false);
});

test('withMarker appends ONCE — a second pass must not stack markers', () => {
  const id = 'prop_once';
  const once = relay.withMarker(id, 'the idea');
  assert.ok(once.endsWith(relay.marker(id)), 'marker belongs at the end');
  const twice = relay.withMarker(id, once);
  assert.equal(twice, once, 'idempotent: no second marker');
  const count = twice.split(relay.marker(id)).length - 1;
  assert.equal(count, 1, 'exactly one marker in the body');
});

// ══ the idempotency lookup — the point of this file ════════════════════════

test('the lookup reads the issues LIST endpoint, never /search/issues', async () => {
  useRealMode(() => jsonResponse([]));
  const hit = await relay._findByMarker('prop_list_only');

  assert.equal(hit, null, 'an empty repo has no marker');
  assert.ok(calls.length > 0, 'the lookup must actually ask GitHub');

  for (const c of calls) {
    assert.ok(!c.url.includes('/search/issues'),
      `search is eventually consistent — it can silently miss a fresh post: ${c.url}`);
    assert.ok(!c.url.includes('/api/search'),
      `no search endpoint either: ${c.url}`);
  }
  assert.match(calls[0].url, new RegExp(`/repos/${relay.REPO}/issues\\?state=all`));
  assert.equal(calls[0].method, 'GET');
});

test('a marker on page two is still found (the list is paginated)', async () => {
  const wanted = { number: 42, body: 'earlier\n' + relay.marker('prop_paged'),
    html_url: 'https://github.com/x/issues/42' };
  useRealMode((url) => {
    const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
    return jsonResponse(page === 1 ? pageOf(100) : [wanted]);
  });

  const hit = await relay._findByMarker('prop_paged');
  assert.ok(hit, 'page two must be reached, not skipped');
  assert.equal(hit.number, 42);
  assert.equal(calls.length, 2, 'walked exactly two pages');
});

test('a short page ends the walk — no needless requests', async () => {
  useRealMode(() => jsonResponse(pageOf(3)));
  const hit = await relay._findByMarker('prop_short');
  assert.equal(hit, null);
  assert.equal(calls.length, 1, 'a page under per_page means "that is all"');
});

test('pagination is BOUNDED — a full repo cannot become a rate-limit bill', async () => {
  useRealMode(() => jsonResponse(pageOf(100)));
  const hit = await relay._findByMarker('prop_never_there');
  assert.equal(hit, null);
  assert.ok(calls.length >= 1 && calls.length <= 5,
    `walked ${calls.length} pages — the walk must be bounded`);
});

test('a marker found on a page is returned WHOLE (PRs included)', async () => {
  // ensurePR branches on `existing.pull_request`, so the lookup must not
  // strip it — /search/issues returned PRs, and so must the list.
  const pr = { number: 77, body: relay.marker('prop_pr'),
    pull_request: { url: 'https://api.github.com/x/pulls/77' } };
  useRealMode(() => jsonResponse([pr]));
  const hit = await relay._findByMarker('prop_pr');
  assert.ok(hit && hit.pull_request, 'pull_request survives the lookup');
  assert.equal(hit.number, 77);
});

test('a FAILED lookup throws — it must never read as "no issue yet"', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  process.env.HIVV_GITHUB_TOKEN = 'dummy-token-for-tests-only';
  try {
    await assert.rejects(() => relay._findByMarker('prop_down'),
      (e) => {
        assert.equal(e.code, 'idempotency_unknown');
        assert.match(e.message, /refusing to risk a duplicate post/);
        return true;
      },
      'a lookup failure must surface, not silently return null');
  } finally { backToStub(); }
});

test('an HTTP 500 from GitHub is also "unknown", not "absent"', async () => {
  useRealMode(() => jsonResponse({ message: 'Server Error' }, 500));
  await assert.rejects(() => relay._findByMarker('prop_500'),
    (e) => e.code === 'idempotency_unknown');
});

// ══ createIssue, in real mode, against the mock ════════════════════════════

test('a retry that FINDS its marker does not POST a second issue', async () => {
  const restore = allowWrites();
  try {
    const existing = { number: 7, body: relay.marker('prop_dup'),
      html_url: 'https://github.com/x/issues/7', title: 'first' };
    useRealMode((url, method) =>
      method === 'GET' ? jsonResponse([existing]) : jsonResponse({ number: 99 }, 201));

    const out = await relay.createIssue({ id: 'prop_dup', title: 't', body: 'b',
      principal: 'hivv_test' });

    assert.equal(out.ok, true);
    assert.equal(out.deduped, true, 'the retry must be recognised as a dedupe');
    assert.equal(out.number, 7, 'and it must return the ORIGINAL issue');
    assert.ok(!calls.some((c) => c.method === 'POST'),
      'a duplicate POST would have filed a second issue');
  } finally { restore(); backToStub(); }
});

test('with no marker present, exactly ONE issue is posted', async () => {
  const restore = allowWrites();
  try {
    useRealMode((url, method) => method === 'GET'
      ? jsonResponse([])
      : jsonResponse({ number: 1001, html_url: 'https://github.com/x/issues/1001' }, 201));

    const out = await relay.createIssue({ id: 'prop_new', title: 'fresh idea',
      body: 'the body', labels: ['hive-proposal'], principal: 'hivv_test' });

    assert.equal(out.ok, true);
    assert.equal(out.deduped, undefined, 'a first filing is not a dedupe');
    assert.equal(out.number, 1001);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1, 'exactly one POST');
    assert.match(posts[0].url, new RegExp(`/repos/${relay.REPO}/issues$`));
  } finally { restore(); backToStub(); }
});

test('createIssue demands an id — an idempotency key is not optional', async () => {
  await assert.rejects(() => relay.createIssue({ title: 't', body: 'b' }),
    /id required/);
});

test('the marker rides along in the POSTed body', async () => {
  const restore = allowWrites();
  let posted = null;
  try {
    process.env.HIVV_GITHUB_TOKEN = 'dummy-token-for-tests-only';
    global.fetch = async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (method === 'POST') posted = opts.body;
      // GET is the idempotency lookup (empty repo), POST is the filing.
      return method === 'GET'
        ? jsonResponse([])
        : jsonResponse({ number: 1 }, 201);
    };

    await relay.createIssue({ id: 'prop_marked', title: 't', body: 'the idea',
      principal: 'hivv_test' });

    assert.ok(posted, 'the POST body must be captured');
    const sent = JSON.parse(posted);
    assert.ok(sent.body.includes(relay.marker('prop_marked')),
      'the idempotency marker must be in the body GitHub stores');
  } finally { restore(); backToStub(); }
});

// ══ stub mode: the offline twin ════════════════════════════════════════════

test('stub: two filings of one id produce ONE artifact, marked deduped', async () => {
  const restore = allowWrites();
  try {
    backToStub();
    const first = await relay.createIssue({ id: 'prop_stub', title: 'T',
      body: 'B', principal: 'hivv_test' });
    const second = await relay.createIssue({ id: 'prop_stub', title: 'T',
      body: 'B', principal: 'hivv_test' });

    assert.equal(first.stub, true, 'a stub artifact must say it is a stub');
    assert.equal(second.deduped, true);
    assert.equal(second.number, first.number);
    assert.equal(stubIssueFiles().length, 1, 'one id, one file');
  } finally { restore(); backToStub(); }
});

test('stub: the stored body carries the marker, so a later real lookup agrees', async () => {
  const restore = allowWrites();
  try {
    backToStub();
    await relay.createIssue({ id: 'prop_stub_marker', title: 'T', body: 'B',
      principal: 'hivv_test' });
    const file = path.join(relay.stubDir(), 'issue-prop_stub_marker.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(rec.body.includes(relay.marker('prop_stub_marker')),
      'the stub must store what GitHub would store');
    assert.equal(rec.stub, true);
  } finally { restore(); backToStub(); }
});

test('stub: ensurePR reuses the deterministic branch, never hive/proposal-1a', async () => {
  const restore = allowWrites();
  try {
    backToStub();
    const a = await relay.ensurePR({ id: 'prop_pr', title: 'T', body: 'B',
      patch: 'diff --git a/x b/x', principal: 'hivv_test' });
    const b = await relay.ensurePR({ id: 'prop_pr', title: 'T', body: 'B',
      patch: 'diff --git a/x b/x', principal: 'hivv_test' });

    assert.equal(a.branch, 'hive/proposal-prop_pr');
    assert.equal(b.deduped, true, 'a retry must not open a second PR');
    assert.equal(b.number, a.number);
    const prs = fs.readdirSync(relay.stubDir()).filter((f) => f.startsWith('pr-'));
    assert.equal(prs.length, 1, 'one id, one PR artifact');
  } finally { restore(); backToStub(); }
});

test('stub: two DIFFERENT ids are two different artifacts', async () => {
  const restore = allowWrites();
  try {
    backToStub();
    await relay.createIssue({ id: 'prop_a', title: 'one', body: 'x',
      principal: 'hivv_test' });
    await relay.createIssue({ id: 'prop_b', title: 'two', body: 'y',
      principal: 'hivv_test' });
    assert.equal(stubIssueFiles().length, 2);
  } finally { restore(); backToStub(); }
});

// ══ the law: one credential holder ═════════════════════════════════════════

test('law D: with no token, NOTHING reaches for the network', async () => {
  const restore = allowWrites();
  try {
    backToStub();
    global.fetch = async () => { throw new Error('network reached in stub mode'); };
    await relay.createIssue({ id: 'prop_offline', title: 't', body: 'b',
      principal: 'hivv_test' });
    assert.equal(calls.length, 0, 'stub mode must not touch fetch at all');
  } finally { restore(); backToStub(); }
});
