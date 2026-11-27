// api/tests/proposal-sign.test.js — the BROWSER must sign like the CLI.
//
// The web form (public_html/js/hivv-sign.js) reimplements canonical JSON in
// JavaScript. If it drifts from api/lib/attest.js `canonicalize` by ONE byte,
// every browser proposal silently fails to verify — reported as "signature
// mismatch", which says nothing about the real cause.
//
// So this pins it both ways:
//   A. byte-parity against the REAL hub implementation, on hostile fixtures
//   B. a round trip: sign with the browser's canonical bytes, verify with
//      identity.verifyIncoming (which canonicalizes independently)
//
// The nastiest fixture catches the classic bug: keys sorted by JS's default
// UTF-16 order instead of UTF-8 bytes. The two disagree for astral chars
// (emoji), so a naive Object.keys().sort() passes every ASCII test and only
// fails in production.
//
// Run with:  cd api && node --test tests/proposal-sign.test.js

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

const UNIT_FILE = path.join(os.tmpdir(), `hivv-sign-unit-${process.pid}.json`);
try { fs.unlinkSync(UNIT_FILE); } catch (_e) { /* fresh */ }
process.env.HIVV_IDENTITY_FILE = UNIT_FILE;

const attest = require('../lib/attest');
const identity = require('../lib/identity');
const browser = require(path.join(REPO, 'public_html', 'js', 'hivv-sign.js'));

after(() => {
  try { fs.unlinkSync(UNIT_FILE); } catch (_e) { /* best effort */ }
});

const FIXTURES = [
  { name: 'flat statement', v: { v: 1, kind: 'proposal.create', node_id: 'ashy', ts: 1795753519, nonce: 'a3f9c2e1b0d4a5f6' } },
  { name: 'nested proposal', v: { v: 1, kind: 'proposal.create', type: 'patch', title: 'a title', body: 'a body', evidence: 'pid 42335', patch: 'diff --git a/x b/x\n+++ b/x\n+line\n' } },
  { name: 'nulls and bools', v: { a: null, b: true, c: false, d: 0, e: -1 } },
  { name: 'arrays', v: { xs: [1, 2, 3], ys: [[], [null], ['a']] } },
  { name: 'escaped strings', v: { q: 'say "hi"', nl: 'line1\nline2', tab: 'a\tb', uni: 'caf\u00e9 \u2014 \u4e2d\u6587' } },
  // THE TRAP: U+FFFF sorts BEFORE the emoji in UTF-8, but AFTER it in UTF-16.
  { name: 'astral key ordering', v: { '\uffff': 1, '\ud83d\ude00': 2, z: 3, a: 4 } },
  { name: 'astral in values', v: { s: '\ud83d\ude00\ud83c\udf89 astral' } },
  { name: 'key order must not follow insertion', v: { z: 1, a: 2, m: 3, B: 4, '0': 5 } },
  { name: 'long text', v: { body: 'word '.repeat(400) } },
];

test('A: canonical() is byte-identical to the hub on every fixture', () => {
  for (const f of FIXTURES) {
    assert.equal(browser.canonical(f.v), attest.canonicalize(f.v),
      'fixture "' + f.name + '" drifted');
  }
});

test('A: the UTF-16/UTF-8 ordering trap is actually exercised', () => {
  const v = { '\uffff': 1, '\ud83d\ude00': 2, z: 3, a: 4 };
  const naive = JSON.stringify(
    Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])));
  const correct = attest.canonicalize(v);
  assert.notEqual(naive, correct,
    'fixture no longer distinguishes UTF-16 from UTF-8 sort — fix the fixture');
  assert.equal(browser.canonical(v), correct);
});

test('A: both reject a float', () => {
  assert.throws(() => browser.canonical({ x: 1.5 }), /integers only/);
  assert.throws(() => attest.canonicalize({ x: 1.5 }));
});

test('A: both reject -0 and unsafe integers', () => {
  assert.throws(() => browser.canonical({ x: -0 }), /out of range/);
  assert.throws(() => attest.canonicalize({ x: -0 }));
  assert.throws(() => browser.canonical({ x: 2 ** 53 }), /out of range/);
});

test('A: both drop undefined values', () => {
  const v = { a: 1, b: undefined, c: 2 };
  assert.equal(browser.canonical(v), attest.canonicalize(v));
  assert.equal(browser.canonical(v), '{"a":1,"c":2}');
});

test('A: both reject a type they cannot serialize', () => {
  assert.throws(() => browser.canonical({ f: function () {} }));
  assert.throws(() => attest.canonicalize({ f: function () {} }));
});
// ── B · the round trip that actually matters ────────────────────────────────

function makeKeypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function rawPub(kp) {
  return kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
}

// Build the envelope the way hivv-sign.js does: sign the CANONICAL BYTES the
// browser produced. identity.verifyIncoming then re-canonicalizes with
// attest.js — so this only passes if the two agree byte for byte.
function signLikeBrowser(kp, statement) {
  const canon = browser.canonical(statement);
  const sig = crypto.sign(null, Buffer.from(canon, 'utf8'), kp.privateKey);
  return {
    algorithm: 'ed25519',
    public_key: rawPub(kp).toString('base64'),
    statement,
    signature: sig.toString('base64'),
  };
}

test("B: an envelope signed with the BROWSER's canonical bytes verifies on the hub", () => {
  for (const f of FIXTURES) {
    const kp = makeKeypair();
    const node = 'web-' + crypto.randomBytes(5).toString('hex');
    const statement = Object.assign({}, f.v, {
      v: 1, kind: 'proposal.create', node_id: node,
      ts: Math.floor(Date.now() / 1000),
      nonce: crypto.randomBytes(8).toString('hex'),
    });
    const block = signLikeBrowser(kp, statement);
    const out = identity.verifyIncoming({ nodeId: node, identity: block, kind: 'proposal.create' });
    assert.equal(out.ok, true,
      'fixture "' + f.name + '" failed: ' + (out.problems || []).join('; '));
  }
});

test('B: tampering after signing is caught (the signature covers the bytes)', () => {
  const kp = makeKeypair();
  const node = 'web-tamper';
  const block = signLikeBrowser(kp, {
    v: 1, kind: 'proposal.create', node_id: node,
    ts: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(8).toString('hex'),
    title: 'original',
  });
  block.statement.title = 'changed after signing';
  const out = identity.verifyIncoming({ nodeId: node, identity: block, kind: 'proposal.create' });
  assert.equal(out.ok, false, 'a modified statement must not verify');
});

test('B: the browser derives the SAME principal the hub derives', async () => {
  const kp = makeKeypair();
  const raw = rawPub(kp);
  assert.equal(await browser.principalFromRaw(raw), attest.principalIdFromRaw(raw),
    'the browser and the hub must agree on who a key belongs to');
  assert.match(await browser.principalFromRaw(raw), /^hivv_[0-9a-f]{32}$/);
});

test('B: a browser node id is a name, never a claim the hub trusts', async () => {
  // The node id is only a label — what the hub actually verifies is that the
  // statement was signed by the key it presents, and the principal derives
  // from THAT key. A chosen node_id cannot borrow someone else's identity.
  const victim = makeKeypair();
  const attacker = makeKeypair();
  const block = signLikeBrowser(attacker, {
    v: 1, kind: 'proposal.create',
    node_id: 'web-victim-label',
    ts: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(8).toString('hex'),
  });
  const out = identity.verifyIncoming({
    nodeId: 'web-victim-label', identity: block, kind: 'proposal.create',
  });
  // it verifies (the label matches the statement) but binds to the ATTACKER's
  // key and derives the attacker's principal — never the victim's
  assert.equal(out.ok, true);
  assert.equal(out.principal, attest.principalIdFromRaw(rawPub(attacker)));
  assert.notEqual(out.principal, attest.principalIdFromRaw(rawPub(victim)));
});

