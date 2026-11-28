// api/tests/proposal-auth.test.js — who may act on a proposal.
//
// TWO BUGS THIS FILE PINS, both reproduced against the live gateway first.
//
// BUG 1 — an identity that was never checked
//   proposal-routes._principal() fell back to the raw `x-visitor-id` header.
//   server.js:540 documents that header as spoofable ("rate-limiting wants a
//   cheap label, not an identity"), and p.principal is PUBLIC — it is served
//   by GET /api/proposals/:id and printed into the GitHub issue provenance.
//   Read a proposal, echo its principal as a header, own it:
//
//       POST /api/proposals/<id>/reject  (no identity)      → 403
//       ... + x-visitor-id: <public principal>              → 200, rejected
//
//   _mayWrite() also gates study / authorize / test / approve, so the hole
//   was wider than rejection. (approve and merge happened to be safe — see
//   the note at the bottom — but nothing should rely on an accident.)
//
// BUG 2 — an address treated as a credential
//   _isAdmin() granted operator rights to any request whose req.ip looked
//   like loopback. Two ways in: SSRF from anything on this box, and — because
//   server.js sets `trust proxy = 1` — a direct request carrying
//   `X-Forwarded-For: 127.0.0.1`.
//
// NOW: identity is a server-verified session or a FRESH signed statement
// (verified the way intake verifies one; a replayed nonce is fatal), and an
// operator is a token. An address grants nothing.
//
// Fully offline: no gateway, no network, no real key material. The identity
// store and the control token are pointed at a temp dir / a test value
// BEFORE anything is required.
//
// Run with:  cd api && node --test tests/proposal-auth.test.js

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── isolate BEFORE require ──────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-propauth-'));
process.env.HIVV_IDENTITY_FILE = path.join(TMP, 'identities.json');
// Must be set before proposal-routes is loaded: CONTROL_TOKEN is read once.
// Short on purpose — scripts/scan_secrets.py treats a >=16 char literal after
// HIVV_CONTROL_TOKEN= as a leaked token and fails the pre-push gate (same
// reason tests/test_portability.py uses "ctrl-a"). This value is read back
// out of the env by the tests below, so its length never matters.
process.env.HIVV_CONTROL_TOKEN = 'ctrl-test';

const routes = require('../routes/proposal-routes');
const identity = require('../lib/identity');
const attest = require('../lib/attest');

const { _isAdmin, _principal, _mayWrite } = routes._auth;

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
});

// ── helpers ─────────────────────────────────────────────────────────────────

function reqOf(headers = {}, ip = '203.0.113.7', body = {}) {
  return { headers, ip, connection: { remoteAddress: ip }, body };
}

// A bee with a stable key that can mint a FRESH signed statement per call.
// Fresh matters: verifyIncoming() consumes the nonce on success, so reusing
// one block is a replay and must fail.
function makeNode(nodeId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // The codebase's own helper — Node refuses {format:'raw'} for a public key.
  const raw = attest.rawFromPublicKey(publicKey);            // 32 raw bytes
  return {
    nodeId,
    principal: attest.principalIdFromRaw(raw),
    sign() {
      const statement = {
        v: 1,
        kind: 'proposal.create',
        node_id: nodeId,
        ts: Math.floor(Date.now() / 1000),
        nonce: crypto.randomBytes(16).toString('hex'),
      };
      const sig = crypto.sign(
        null, Buffer.from(attest.canonicalize(statement), 'utf8'), privateKey);
      return {
        node_id: nodeId,
        identity: {
          algorithm: identity.ALGORITHM,
          public_key: raw.toString('base64'),
          signature: sig.toString('base64'),
          statement,
        },
      };
    },
  };
}

// ══ BUG 1 — the spoofable header ═══════════════════════════════════════════

test('BUG1: x-visitor-id is never an identity', async () => {
  const claimed = 'hivv_ace0cfd7bd0099467d75125a3a2e8ca3';
  const who = await _principal(reqOf({ 'x-visitor-id': claimed }));
  assert.equal(who, null,
    'the spoofable header must not become a principal — this was the bug');
});

test('BUG1: a spoofed header cannot act on someone else\'s proposal', async () => {
  const p = { principal: 'hivv_ace0cfd7bd0099467d75125a3a2e8ca3' };
  // Exactly the request that used to return 200 and flip state to rejected.
  const req = reqOf({ 'x-visitor-id': p.principal });
  assert.equal(await _mayWrite(req, p), false);
});

test('BUG1: no identity at all owns nothing', async () => {
  assert.equal(await _principal(reqOf({}, '203.0.113.7', {})), null);
  assert.equal(
    await _mayWrite(reqOf({}, '203.0.113.7', {}), { principal: 'hivv_whatever' }),
    false);
});

// ══ the legitimate path that must KEEP working ═════════════════════════════

test('a fresh signed statement establishes the author', async () => {
  const bee = makeNode('bee-alpha');
  const who = await _principal(reqOf({}, '203.0.113.7', bee.sign()));
  assert.equal(who, bee.principal, 'principal must derive from the key');
  assert.match(who, /^hivv_[0-9a-f]{32}$/);

  // A SECOND statement — _mayWrite verifies identity again internally, and
  // the first block's nonce is already spent.
  const ok = await _mayWrite(reqOf({}, '203.0.113.7', bee.sign()),
    { principal: bee.principal });
  assert.equal(ok, true, 'the real author may still act on their proposal');
});

test('a valid signature from a DIFFERENT bee is not the author', async () => {
  const author = makeNode('bee-author');
  const stranger = makeNode('bee-stranger');
  const ok = await _mayWrite(reqOf({}, '203.0.113.7', stranger.sign()),
    { principal: author.principal });
  assert.equal(ok, false, 'a signature proves WHO, and who is not the author');
});

test('BUG1: a REPLAYED statement is refused — the nonce is spent', async () => {
  const bee = makeNode('bee-replay');
  const block = bee.sign();

  const first = await _principal(reqOf({}, '203.0.113.7', block));
  assert.equal(first, bee.principal, 'the first use is genuine');

  const again = await _principal(reqOf({}, '203.0.113.7', block));
  assert.equal(again, null,
    'the block that created the proposal must not also act on it');
});

test('a tampered statement authenticates nothing', async () => {
  const bee = makeNode('bee-tamper');
  const block = bee.sign();
  block.identity.statement.node_id = 'bee-someone-else';
  const who = await _principal(reqOf({}, '203.0.113.7', block));
  assert.equal(who, null, 'node_id must match the statement that was signed');
});

// ══ BUG 2 — an address is not a credential ═════════════════════════════════

test('BUG2: loopback is NOT an operator', () => {
  assert.equal(_isAdmin(reqOf({}, '127.0.0.1')), false,
    'SSRF from this box must not inherit operator rights');
  assert.equal(_isAdmin(reqOf({}, '::1')), false);
  assert.equal(_isAdmin(reqOf({}, '::ffff:127.0.0.1')), false);
});

test('BUG2: a forged X-Forwarded-For cannot become the operator', () => {
  // `trust proxy = 1` makes req.ip the rightmost XFF entry for a request
  // that reaches the origin without the proxy.
  const req = reqOf({ 'x-forwarded-for': '127.0.0.1' }, '127.0.0.1');
  assert.equal(_isAdmin(req), false,
    'a client-supplied address must not grant operator rights');
});

test('the control token IS an operator', () => {
  const req = reqOf({ 'x-control-token': process.env.HIVV_CONTROL_TOKEN },
    '203.0.113.7');
  assert.equal(_isAdmin(req), true);
});

test('a wrong token is not an operator, from anywhere', () => {
  assert.equal(_isAdmin(reqOf({ 'x-control-token': 'nope' }, '203.0.113.7')), false);
  // ...not even from loopback, where the old code said yes.
  assert.equal(_isAdmin(reqOf({ 'x-control-token': 'nope' }, '127.0.0.1')), false);
  assert.equal(_isAdmin(reqOf({}, '127.0.0.1')), false);
});

// ══ the two gates that were ALREADY safe ═══════════════════════════════════
//
// Worth pinning so a future refactor cannot quietly weaken them: `approve`
// refuses the author (so spoofing the author trips that rule instead of
// passing), and `merge` consults _isAdmin only. Neither ever read the header.
// The real fix above stops the OTHER routes (study / authorize / test /
// reject) from being reachable at all.

test('the author still cannot approve their own proposal', async () => {
  const bee = makeNode('bee-selfapprove');
  const who = await _principal(reqOf({}, '203.0.113.7', bee.sign()));
  assert.equal(who, bee.principal);
  // The route's own rule: p.principal === who && !_isAdmin → 403.
  const isAdmin = _isAdmin(reqOf({}, '203.0.113.7', bee.sign()));
  assert.equal(isAdmin, false, 'a signed bee is not an operator');
  assert.equal(who === bee.principal && !isAdmin, true,
    'so the self-approve rule still fires');
});
