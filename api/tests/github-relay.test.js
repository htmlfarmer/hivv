// api/tests/github-relay.test.js — pins Stage 3 of the proposal funnel.
//
// WHAT THIS PROVES
//   1. The ENVELOPE SCHEMA (v1) — every field, every cap, every rejection.
//      This file is the contract; github-relay.js documents it in prose,
//      this pins it in code.
//   2. The stub is a real stand-in: same endpoint shapes, same status codes,
//      same call sequence — so the funnel can be built and demoed with NO
//      GitHub token, NO network and NO Postgres (local-first, CONTRIBUTING
//      rule #4).
//   3. Idempotency: one proposal → exactly one issue, no matter how many
//      times it is relayed, and a DIFFERENT patch for the same idea is
//      appended rather than merged.
//   4. Nothing here can reach github.com. Every test forces stub mode and
//      points HIVV_DATA_DIR at a temp dir that is deleted afterwards.
//
// Runs offline: no gateway, no DB, no network.
// Run with:  cd api && node --test tests/github-relay.test.js

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relay = require('../lib/github-relay');
const attest = require('../lib/attest');

// ── env plumbing ──────────────────────────────────────────────────────────
// The relay reads env at CALL time (deliberately — tests and the operator
// can switch modes without a restart), so the tests own the env.

const SAVED_ENV = {};
for (const k of ['HIVV_DATA_DIR', 'HIVV_GITHUB_STUB_DIR', 'HIVV_GITHUB_STUB',
                 'HIVV_GITHUB_TOKEN']) SAVED_ENV[k] = process.env[k];

const TMPDIRS = [];

function freshStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-relay-'));
  TMPDIRS.push(dir);
  process.env.HIVV_DATA_DIR = dir;
  delete process.env.HIVV_GITHUB_STUB_DIR;
  delete process.env.HIVV_GITHUB_STUB;
  delete process.env.HIVV_GITHUB_TOKEN;
  return dir;
}

function stubIssues() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(relay.stubDir(), 'issues.json'), 'utf8'));
  } catch (_) { return []; }
}

after(() => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(freshStub);

// ── fixtures ──────────────────────────────────────────────────────────────

const PATCH = [
  '--- a/api/lib/attest.js',
  '+++ b/api/lib/attest.js',
  '@@ -24,1 +24,2 @@',
  "-const KINDS = ['source.review'];",
  "+const KINDS = ['source.review', 'proposal'];",
  '',
].join('\n');

function goodProposal(over = {}) {
  return {
    v: 1,
    kind: 'proposal',
    type: 'suggestion',
    title: 'The tools server never refreshes a stale helper',
    body: 'cmd_tools checks _tools_running() first, so a live PID '
        + 'short-circuits the freshness check and a 2-month-old helper keeps '
        + 'serving forever.',
    evidence: 'pid 42335 ran hivv-tools.py from Sep 16 while the hub served 0.2.0',
    node_id: 'hivv_test_node',
    ts: 1795753519,
    ...over,
  };
}

// ══ 1. mode ═══════════════════════════════════════════════════════════════

test('no token means stub mode — a clone must never reach GitHub by accident', () => {
  assert.equal(relay.getMode(), 'stub');
});

test('a token switches to real mode', () => {
  process.env.HIVV_GITHUB_TOKEN = 'ghp_dummy_not_a_real_token';
  try { assert.equal(relay.getMode(), 'real'); }
  finally { delete process.env.HIVV_GITHUB_TOKEN; }
});

test('HIVV_GITHUB_STUB=1 wins over a token — the kill switch is real', () => {
  process.env.HIVV_GITHUB_TOKEN = 'ghp_dummy_not_a_real_token';
  process.env.HIVV_GITHUB_STUB = '1';
  try { assert.equal(relay.getMode(), 'stub'); }
  finally {
    delete process.env.HIVV_GITHUB_TOKEN;
    delete process.env.HIVV_GITHUB_STUB;
  }
});

test('the stub lives under HIVV_DATA_DIR (the local-first data dir)', () => {
  const dir = freshStub();
  assert.equal(relay.stubDir(), path.join(dir, 'github-stub'));
});

// ══ 2. dedupe key ═════════════════════════════════════════════════════════

test('dedupeKey is 64 hex and stable', () => {
  const a = relay.dedupeKey('Fix the tools', 'It never refreshes.');
  const b = relay.dedupeKey('Fix the tools', 'It never refreshes.');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('dedupeKey ignores case and whitespace — same idea, same key', () => {
  assert.equal(
    relay.dedupeKey('Fix  the tools', 'It   never refreshes.'),
    relay.dedupeKey('fix the tools', 'it never refreshes.'));
});

test('dedupeKey separates different ideas', () => {
  assert.notEqual(
    relay.dedupeKey('Fix the tools', 'It never refreshes.'),
    relay.dedupeKey('Fix the map', 'The tiles demanded an API key.'));
});

test('the marker embeds the key and is invisible HTML', () => {
  const key = relay.dedupeKey('t', 'b');
  assert.equal(relay.proposalMarker(key), `<!-- hive-proposal:${key} -->`);
});

// ══ 3. validation ═════════════════════════════════════════════════════════

test('a well-formed proposal passes', () => {
  const r = relay.validateProposal(goodProposal());
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('validation never throws on garbage — a bee wrote it, it is input', () => {
  for (const junk of [null, undefined, 'text', 42, [], [1, 2]]) {
    const r = relay.validateProposal(junk);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.problems) && r.problems.length > 0);
  }
});

test('every required field is enforced', () => {
  const base = goodProposal();
  const cases = [
    [{ ...base, v: 2 }, /v must be 1/],
    [{ ...base, kind: 'note' }, /kind must be "proposal"/],
    [{ ...base, type: 'banana' }, /type must be one of/],
    [{ ...base, title: '   ' }, /title is required/],
    [{ ...base, body: '' }, /body is required/],
    [{ ...base, ts: 'soon' }, /ts must be an integer/],
  ];
  for (const [p, re] of cases) {
    const r = relay.validateProposal(p);
    assert.equal(r.ok, false, `expected rejection for ${re}`);
    assert.ok(r.problems.some((x) => re.test(x)),
      `no problem matched ${re}: ${r.problems.join(' | ')}`);
  }
});

test('caps: title 200, body 20000, evidence 4000, target 200, node_id 100', () => {
  const tooLong = (n) => 'x'.repeat(n + 1);
  const cases = [
    [{ ...goodProposal(), title: tooLong(relay.MAX_TITLE) }, /title too long/],
    [{ ...goodProposal(), body: tooLong(relay.MAX_BODY_TEXT) }, /body too long/],
    [{ ...goodProposal(), evidence: tooLong(relay.MAX_EVIDENCE) },
      /evidence too long/],
    [{ ...goodProposal(), target: tooLong(200) }, /target too long/],
    [{ ...goodProposal(), node_id: tooLong(100) }, /node_id too long/],
  ];
  for (const [p, re] of cases) {
    const r = relay.validateProposal(p);
    assert.equal(r.ok, false, `expected ${re} to be rejected`);
    assert.ok(r.problems.some((x) => re.test(x)), r.problems.join(' | '));
  }
});

test('exactly-at-the-cap still passes (the cap is inclusive)', () => {
  const r = relay.validateProposal(goodProposal({
    title: 'x'.repeat(relay.MAX_TITLE),
    evidence: 'y'.repeat(relay.MAX_EVIDENCE),
  }));
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('type "patch" requires a patch', () => {
  const r = relay.validateProposal(goodProposal({ type: 'patch' }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /type "patch" requires a patch/.test(x)));
});

test('a patch requires patch_sha256 — integrity over the full bytes', () => {
  const r = relay.validateProposal(goodProposal({ type: 'patch', patch: PATCH }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /patch requires patch_sha256/.test(x)));
});

test('a matching patch_sha256 passes, a tampered one does not', () => {
  const sha = attest.sha256Hex(PATCH);
  assert.equal(
    relay.validateProposal(goodProposal({ type: 'patch', patch: PATCH,
      patch_sha256: sha })).ok, true);

  const bad = relay.validateProposal(goodProposal({ type: 'patch',
    patch: PATCH + '\n+evil()', patch_sha256: sha }));
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((x) => /does not match the patch/.test(x)));
});

test('patch_sha256 must be 64 lowercase hex', () => {
  const r = relay.validateProposal(goodProposal({ type: 'patch', patch: PATCH,
    patch_sha256: 'DEADBEEF' }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /64 lowercase hex/.test(x)));
});

test('an oversized patch is refused outright', () => {
  const big = 'x'.repeat(relay.MAX_PATCH_BYTES + 1);
  const r = relay.validateProposal(goodProposal({ type: 'patch', patch: big,
    patch_sha256: attest.sha256Hex(big) }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /patch too large/.test(x)));
});

// ══ 4. rendering ══════════════════════════════════════════════════════════

test('the markers come FIRST so truncation cannot lose idempotency', () => {
  const p = goodProposal({ type: 'patch', patch: PATCH,
    patch_sha256: attest.sha256Hex(PATCH) });
  const out = relay.renderProposalBody(p, { key: relay.dedupeKey(p.title, p.body) });
  const lines = out.split('\n');
  assert.match(lines[0], /^<!-- hive-proposal:[0-9a-f]{64} -->$/);
  assert.match(lines[1], /^<!-- hive-patch-sha256:[0-9a-f]{64} -->$/);
});

test('the body carries the idea, evidence, patch and provenance', () => {
  const p = goodProposal({ type: 'patch', patch: PATCH,
    patch_sha256: attest.sha256Hex(PATCH) });
  const out = relay.renderProposalBody(p, { mode: 'stub' });
  assert.match(out, /### What the hive said/);
  assert.match(out, /short-circuits the freshness check/);
  assert.match(out, /### Evidence/);
  assert.match(out, /### Patch/);
  assert.match(out, /```diff/);
  assert.match(out, /node `hivv_test_node`/);
  assert.match(out, /relayed in stub mode/);
});

test('an oversized body is truncated to MAX_BODY but keeps its marker', () => {
  const p = goodProposal({ body: 'z'.repeat(relay.MAX_BODY + 5000) });
  const out = relay.renderProposalBody(p);
  assert.ok(out.length <= relay.MAX_BODY, `len=${out.length}`);
  assert.match(out.split('\n')[0], /^<!-- hive-proposal:[0-9a-f]{64} -->$/);
  assert.match(out, /truncated by the relay/);
});

// ══ 5. the relay, end to end (stub) ═══════════════════════════════════════

test('relayProposal files exactly one issue and reports stub mode', async () => {
  const p = goodProposal();
  const r = await relay.relayProposal(p);

  assert.equal(r.ok, true);
  assert.equal(r.mode, 'stub');
  assert.equal(r.deduped, false);
  assert.equal(r.number, 1001);
  // A stub must never look like a real issue.
  assert.match(r.url, /^stub:\/\//);
  assert.ok(r.marker.includes(relay.dedupeKey(p.title, p.body)));

  const issues = stubIssues();
  assert.equal(issues.length, 1);
  assert.ok(issues[0].labels.includes('hive-proposal'));
  assert.ok(issues[0].labels.includes('suggestion'));
  assert.ok(issues[0].body.includes(r.marker));
});

test('relaying the same proposal again is a no-op, not a second issue', async () => {
  const p = goodProposal();
  const first = await relay.relayProposal(p);
  const second = await relay.relayProposal(p);

  assert.equal(first.deduped, false);
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(second.number, first.number, 'same issue, not a new one');
  assert.equal(stubIssues().length, 1);
});

test('a differently-worded but same-idea proposal still dedupes', async () => {
  const a = goodProposal();
  // Same words, different case and whitespace — normalize() must fold both.
  // (Dropping a word WOULD be a different idea and must NOT dedupe; see the
  // dedupeKey separation test above.)
  const b = goodProposal({ title: '  The tools   server NEVER refreshes a stale helper  ',
    body: a.body.toUpperCase(), node_id: 'another_bee' });
  await relay.relayProposal(a);
  const r = await relay.relayProposal(b);
  assert.equal(r.deduped, true);
  assert.equal(stubIssues().length, 1);
});

test('a DIFFERENT patch for the same idea is appended, never merged', async () => {
  const base = goodProposal({ type: 'patch', patch: PATCH,
    patch_sha256: attest.sha256Hex(PATCH) });
  await relay.relayProposal(base);

  const otherPatch = PATCH + '+// a different fix\n';
  const second = { ...base, patch: otherPatch,
    patch_sha256: attest.sha256Hex(otherPatch), node_id: 'other_bee' };
  const r = await relay.relayProposal(second);

  assert.equal(r.ok, true);
  assert.equal(r.deduped, true);
  assert.equal(r.patch_appended, true);
  assert.equal(stubIssues().length, 1, 'still only one issue');

  const issue = stubIssues()[0];
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0].body, /different patch for this same proposal/);
});

test('an invalid proposal is rejected and writes NOTHING', async () => {
  const r = await relay.relayProposal(goodProposal({ title: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.deduped, false);
  assert.ok(r.problems.some((x) => /title is required/.test(x)));
  assert.equal(stubIssues().length, 0);
});

test('relayProposal never throws on junk input', async () => {
  for (const junk of [null, 'text', 7, []]) {
    const r = await relay.relayProposal(junk);
    assert.equal(r.ok, false);
    assert.equal(Array.isArray(r.problems), true);
  }
});

// ══ 6. the other operations ═══════════════════════════════════════════════

test('createBranch accepts a good ref and rejects a bad sha', async () => {
  const sha = 'a'.repeat(64);
  const ok = await relay.createBranch('hive/proposal-1001', sha);
  assert.equal(ok.status, 201);

  const dup = await relay.createBranch('hive/proposal-1001', sha);
  assert.equal(dup.status, 422);
  assert.match(dup.data.message, /already exists/);

  const badSha = await relay.createBranch('hive/proposal-1002', 'nothex');
  assert.equal(badSha.status, 422);

  const badName = await relay.createBranch('../etc/passwd', sha);
  assert.equal(badName.status, 422);
});

test('branches are refused for path traversal in the name', async () => {
  const r = await relay.createBranch('a/../../b', 'a'.repeat(64));
  assert.equal(r.status, 422);
});

test('PRs share the issue number sequence, like GitHub does', async () => {
  await relay.relayProposal(goodProposal());            // -> 1001
  const pr = await relay.openPullRequest({ title: '[hive] fix',
    body: 'from a proposal', head: 'hive/proposal-1001', base: 'main' });
  assert.equal(pr.status, 201);
  assert.equal(pr.data.number, 1002);
  assert.match(pr.data.html_url, /^stub:\/\//);
});

test('comment + closeIssue round-trip; commenting on nothing is a 404', async () => {
  await relay.relayProposal(goodProposal());

  const c = await relay.comment(1001, 'a bee agrees');
  assert.equal(c.status, 201);

  const list = await relay._stubRequest('GET',
    `/repos/${relay.REPO}/issues/1001/comments`);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].body, 'a bee agrees');

  const closed = await relay.closeIssue(1001);
  assert.equal(closed.status, 200);
  assert.equal(closed.data.state, 'closed');

  const ghost = await relay.comment(9999, 'nobody here');
  assert.equal(ghost.status, 404);
});

test('findIssueByMarker finds by label+body, and misses cleanly', async () => {
  await relay.relayProposal(goodProposal());
  const key = relay.dedupeKey(goodProposal().title, goodProposal().body);

  const hit = await relay.findIssueByMarker(relay.proposalMarker(key));
  assert.equal(hit.status, 200);
  assert.equal(hit.data.number, 1001);

  const miss = await relay.findIssueByMarker('<!-- hive-proposal:' + 'f'.repeat(64) + ' -->');
  assert.equal(miss.status, 200);
  assert.equal(miss.data, null);
});

test('an unknown stub route is a 404, not a crash', () => {
  const r = relay._stubRequest('DELETE', `/repos/${relay.REPO}/nope`);
  assert.equal(r.status, 404);
  assert.match(r.data.message, /no route/);
});

// ══ 7. the schema actually fits the existing signing machinery ════════════

test('a proposal wraps into an attest envelope and verifies end to end', () => {
  const p = goodProposal({ type: 'patch', patch: PATCH,
    patch_sha256: attest.sha256Hex(PATCH) });
  const key = relay.dedupeKey(p.title, p.body);
  const keys = attest.generateSigningKey();

  // No new crypto: kind 'proposal' + subject == dedupe key.
  const env = attest.buildEnvelope({
    kind: relay.PROPOSAL_KIND,
    subject: key,
    issuer: keys.principalId,
    body: p,
    issuedAt: 1795753519,
  });
  assert.equal(env.kind, 'proposal');
  assert.equal(env.subject, key);

  const sig = attest.signEnvelope(env, keys.privateKey);
  const v = attest.verifyEnvelope(env, sig, keys.rawPublicKey);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);

  // ...and a tampered proposal is caught by the same signature.
  const tampered = { ...env, body: { ...p, body: 'send the honey elsewhere' } };
  const bad = attest.verifyEnvelope(tampered, sig, keys.rawPublicKey);
  assert.equal(bad.ok, false);
});

test('two bees signing the same idea derive the SAME subject', () => {
  const beeA = goodProposal();
  const beeB = goodProposal({ node_id: 'other_bee', ts: 1795759999,
    title: ' the tools server  NEVER refreshes a STALE helper ' });
  // node_id/ts/title-case differences must not change the identity of the idea
  const keyA = relay.dedupeKey(beeA.title, beeA.body);
  const keyB = relay.dedupeKey(
    'The tools server never refreshes a stale helper', beeB.body);
  assert.equal(keyA, keyB);
});
