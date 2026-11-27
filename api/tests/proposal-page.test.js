// api/tests/proposal-page.test.js — the PUBLIC proposals page.
//
// The page is the public half of the funnel: anyone can read every proposal
// and see what each brain thought. Three things can rot silently:
//   1. the page stops loading THE shared nav (or grows its own) — nav law
//   2. the nav stops listing it — then it is unreachable from the site
//   3. the page hard-codes a count instead of deriving it from the API,
//      so the site starts publishing a number that is not true
//
// Run with:  cd api && node --test tests/proposal-page.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'public_html');
const PAGE = path.join(PUBLIC, 'proposals', 'index.html');
const NAVJS = path.join(PUBLIC, 'js', 'hivv-nav.js');
const BASE = 'http://localhost:3011';

let gatewayUp = false;
before(async () => {
  try {
    const r = await fetch(BASE + '/api/health');
    gatewayUp = r.ok;
  } catch (_) { gatewayUp = false; }
});

test('the page exists', () => {
  assert.ok(fs.existsSync(PAGE), 'public_html/proposals/index.html must exist');
});

test('the page loads THE shared nav and carries no bespoke one', () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  assert.ok(src.includes('/js/hivv-nav.js'), 'every page loads the shared nav');
  // nav.test.js greps /<nav\b/i across every page; this pins it here too so a
  // regression names the page that grew its own navigation.
  assert.ok(!/<nav\b/i.test(src), 'the page must not carry a hand-written nav');
  // and no link to the dead page the site used to bounce to
  assert.ok(!src.includes('/hivv.html'), '/hivv.html does not exist');
});

test('the nav inventory lists it', () => {
  const src = fs.readFileSync(NAVJS, 'utf8');
  assert.ok(/href: '\/proposals\/'/.test(src),
    'the shared inventory must list /proposals/ or the page is unreachable');
});

test('no count on the page is typed into the HTML', () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  // The stats bar must be BUILT from the fetched rows. A static
  // `<div class="stat"><b>7</b>` would be a number the site publishes
  // without measuring it — the exact lie the live-numbers law forbids.
  const staticStats = src.match(/<div class="stat">[\s\S]{0,40}?<b>\s*\d+\s*<\/b>/g);
  assert.equal(staticStats, null,
    'these counts are hard-coded instead of derived: ' + JSON.stringify(staticStats));
  // the derivation has to be there
  assert.ok(/vote_count/.test(src), 'vote counts come from the API rows');
  assert.ok(/\/api\/proposals\?limit=/.test(src), 'the page fetches the API');
});

test('the page renders the fields the API actually returns', () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  // Every one of these is read by the page; if the API drops one, the page
  // silently shows a blank. Pinned on both sides.
  for (const field of ['title', 'verdict', 'state', 'type', 'vote_count',
    'votes', 'reviews', 'screen', 'evidence', 'issue_url', 'node_id',
    'protected_hit', 'created_at']) {
    assert.ok(src.includes(field), 'the page reads "' + field + '"');
  }
});

test('LIVE: the page is served', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/proposals/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('/js/hivv-nav.js'));
  assert.ok(html.includes('/api/proposals'), 'the page must fetch the API');
});

test('LIVE: the API answers the shape the page reads', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/proposals?limit=200');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.proposals), 'proposals must be an array');
  // With at least one proposal filed this session, the contract is checkable.
  if (d.proposals.length) {
    const p = d.proposals[0];
    for (const field of ['id', 'title', 'state', 'verdict', 'created_at']) {
      assert.ok(field in p, 'a proposal must carry "' + field + '"');
    }
    assert.ok(Array.isArray(p.votes), 'votes must be an array (the public sees who agreed)');
    assert.ok(Array.isArray(p.reviews), 'reviews must be an array (the hive\'s reply)');
  }
});


test('the page offers a SIGNED compose form and loads the signer', () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  // A web form that does not sign would be an unsigned side door — the law
  // is every proposal is signed, so the signer must be loaded and used.
  assert.ok(src.includes('/js/hivv-sign.js'), 'the page must load the signer');
  for (const id of ['compose-form', 'f-title', 'f-body', 'f-evidence', 'f-send']) {
    assert.ok(src.includes('id="' + id + '"'), 'missing form field: ' + id);
  }
  assert.ok(src.includes("kind: 'proposal.create'"),
    'the form must sign the same kind the CLI signs');
  assert.ok(src.includes('HIVVSign.sign('), 'the form must actually sign');
  // and it must tell a browser with no Ed25519 to use the CLI rather than
  // silently downgrading to an unsigned submit
  assert.ok(src.includes('no Ed25519 support'),
    'an unsupported browser must be told to use the CLI');
});

test('the page renders the activity feed', () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  assert.ok(src.includes('id="activity-list"'), 'the feed element must exist');
  assert.ok(src.includes('/api/proposals/activity'), 'the feed must fetch the API');
});

test('LIVE: the activity feed answers with chronological events', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const r = await fetch(BASE + '/api/proposals/activity?limit=50');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.events), 'events must be an array');
  assert.ok(Number.isFinite(d.total), 'total must be a number');
  // newest first, and every event carries a real timestamp and a proposal id
  for (let i = 1; i < d.events.length; i++) {
    assert.ok(d.events[i - 1].at >= d.events[i].at, 'events must be newest-first');
  }
  for (const e of d.events.slice(0, 5)) {
    assert.ok(e.id && e.id.startsWith('prop_'), 'an event must name its proposal');
    assert.ok(Number(e.at) > 0, 'an event must carry a timestamp');
    assert.ok(['filed', 'voted', 'gate', 'merged', 'published'].includes(e.kind),
      'unknown event kind: ' + e.kind);
  }
});

test('LIVE: a browser-shaped signed envelope is accepted', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  // Mirrors what the page does: canonical bytes signed with Ed25519, a
  // web-* node id. Proves there is no hidden 'web submissions are treated
  // differently' path — the hub verifies a browser bee like any other.
  const crypto = require('crypto');
  const browser = require(path.join(REPO, 'public_html', 'js', 'hivv-sign.js'));
  const kp = crypto.generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const public_key = raw.toString('base64');
  const node_id = 'web-' + public_key.replace(/[+/=]/g, '').slice(0, 16).toLowerCase();
  const statement = {
    v: 1, kind: 'proposal.create', node_id,
    ts: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(8).toString('hex'),
    type: 'suggestion',
    title: 'browser parity probe ' + Date.now(),
    body: 'signed in the page, verified by the hub.',
    evidence: 'proposal-sign live probe',
  };
  const canon = browser.canonical(statement);
  const signature = crypto.sign(null, Buffer.from(canon, 'utf8'), kp.privateKey);
  const res = await fetch(BASE + '/api/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      node_id,
      identity: { algorithm: 'ed25519', public_key, statement,
                  signature: signature.toString('base64') },
      type: statement.type, title: statement.title,
      body: statement.body, evidence: statement.evidence,
    }),
  });
  const j = await res.json().catch(() => ({}));
  assert.equal(res.status, 201, 'a browser-signed proposal must be accepted: '
    + JSON.stringify(j).slice(0, 300));
  assert.ok(j.proposal && j.proposal.id, 'it must create a proposal');
});
test('LIVE: the stats endpoint the page could use agrees with the list', async (t) => {
  if (!gatewayUp) { t.skip('gateway not running'); return; }
  const list = await (await fetch(BASE + '/api/proposals?limit=500')).json();
  const stats = await (await fetch(BASE + '/api/proposals/stats')).json();
  assert.ok(Number.isFinite(stats.total), 'stats.total must be a number');
  // The page derives its own totals from the rows; they must not disagree
  // with what the stats door reports, or the two numbers on the site differ.
  const sum = Object.values(stats.counts || {}).reduce((a, b) => a + b, 0);
  assert.equal(sum, stats.total, 'counts must add up to total');
  assert.ok(stats.total <= (list.proposals || []).length + 0,
    'stats may not exceed the rows it counts');
});
