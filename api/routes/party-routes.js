// api/routes/party-routes.js — the offline party RSVP.
//
// The premise: if hivv.org crashes, gets hacked, or the world ends, the
// hive goes ANALOG — same room, acoustic honey, no rate limits. This is the
// signup for that party. File-backed (local-first, like everything here),
// minimal fields, and the public board shows names + cities only — contact
// details stay with the operator (delete by asking).

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const PARTY_FILE = process.env.HIVV_PARTY_FILE ||
  path.join(__dirname, '..', 'data', 'party.json');
const CAP = 500;

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(PARTY_FILE, 'utf8'));
    if (s && Array.isArray(s.rsvps)) return s;
  } catch (_e) { /* fresh */ }
  return { version: 1, rsvps: [] };
}

function save(s) {
  fs.mkdirSync(path.dirname(PARTY_FILE), { recursive: true });
  const tmp = PARTY_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, PARTY_FILE);
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// Links are the injection surface: only real web URLs pass — never
// javascript:, data:, vbscript:, file: — and anything else is DROPPED
// (not stored, not rendered). Pentest-proofed before the pentest. :)
function safeUrl(v) {
  const s = clean(v, 300);
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

// RSVP — dedupe on name+city so refreshes do not double the count.
router.post('/rsvp', (req, res) => {
  const body = req.body || {};
  const name = clean(body.name, 60);
  const city = clean(body.city, 80);
  const contact = clean(body.contact, 120);
  if (!name) return res.status(400).json({ error: 'name required' });
  const s = load();
  if (s.rsvps.length >= CAP) {
    return res.status(409).json({ error: 'the party is full — the room only holds so many bees' });
  }
  const dup = s.rsvps.some((r) => r.name === name && r.city === city);
  if (!dup) {
    s.rsvps.push({ name, city, contact, ts: Date.now() });
    save(s);
  }
  res.json({ ok: true, count: s.rsvps.length, duplicate: dup });
});

// The public board: names + cities + count. NO contact details — those stay
// with the operator (a party list is not a mailing list).
router.get('/board', (req, res) => {
  const s = load();
  res.json({
    count: s.rsvps.length,
    cities: [...new Set(s.rsvps.map((r) => r.city).filter(Boolean))],
    rsvps: s.rsvps.map((r) => ({ name: r.name, city: r.city })),
  });
});

// ── music recommendations ───────────────────────────────────────────────
// Everyone gets to recommend music to hivv.org — including classical
// Indian music of their choice — and hopefully the hive picks a song they
// like. File-backed, same rules: the list is public, nothing else is.

const REC_FILE = process.env.HIVV_RECS_FILE ||
  path.join(__dirname, '..', 'data', 'recommendations.json');
const REC_CAP = 300;

function loadRecs() {
  try {
    const s = JSON.parse(fs.readFileSync(REC_FILE, 'utf8'));
    if (s && Array.isArray(s.items)) return s;
  } catch (_e) { /* fresh */ }
  return { version: 1, items: [] };
}

function saveRecs(s) {
  fs.mkdirSync(path.dirname(REC_FILE), { recursive: true });
  const tmp = REC_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, REC_FILE);
}

router.post('/recommend', (req, res) => {
  const body = req.body || {};
  const song = clean(body.song, 120);
  const artist = clean(body.artist, 120);
  const url = safeUrl(body.url);
  const note = clean(body.note, 240);
  if (!song) return res.status(400).json({ error: 'song required' });
  const s = loadRecs();
  if (s.items.length >= REC_CAP) {
    return res.status(409).json({ error: 'the jukebox is full — the hive can only hold so many bangers' });
  }
  const dup = s.items.some((i) => i.song === song && i.artist === artist);
  if (!dup) {
    s.items.push({ song, artist, url, note, picked: false, ts: Date.now() });
    saveRecs(s);
  }
  res.json({ ok: true, count: s.items.length, duplicate: dup });
});

router.get('/recommendations', (req, res) => {
  const s = loadRecs();
  res.json({
    count: s.items.length,
    picked: s.items.filter((i) => i.picked).map((i) => ({ song: i.song, artist: i.artist, url: i.url })),
    items: s.items,
  });
});

// The hive picks: localhost/control-token only (same anchor as identity
// admin actions) — picking is a CURATORIAL act, not a public one.
router.post('/recommend/pick', (req, res) => {
  const tok = req.headers['x-control-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
    (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''));
  const tokenOk = process.env.HIVV_CONTROL_TOKEN && tok &&
    Buffer.byteLength(tok) === Buffer.byteLength(process.env.HIVV_CONTROL_TOKEN) &&
    require('crypto').timingSafeEqual(Buffer.from(tok), Buffer.from(process.env.HIVV_CONTROL_TOKEN));
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: 'only the hive picks (localhost or control token)' });
  }
  const body = req.body || {};
  const song = clean(body.song, 120);
  const s = loadRecs();
  const item = s.items.find((i) => i.song === song);
  if (!item) return res.status(404).json({ error: 'no such recommendation' });
  item.picked = body.unpick ? false : true;
  saveRecs(s);
  res.json({ ok: true, song: item.song, picked: item.picked });
});

// ── the wish page ──────────────────────────────────────────────────────
// We can't honestly hold cash bounties — the hive keeps no money. So
// people post their OWN wishes (and their own info, if they choose to)
// and the community grants wishes instead of paying them. The only
// currency is honey.

const WISH_FILE = process.env.HIVV_WISHES_FILE ||
  path.join(__dirname, '..', 'data', 'wishes.json');
const WISH_CAP = 500;

function loadWishes() {
  try {
    const s = JSON.parse(fs.readFileSync(WISH_FILE, 'utf8'));
    if (s && Array.isArray(s.items)) return s;
  } catch (_e) { /* fresh */ }
  return { version: 1, items: [] };
}

function saveWishes(s) {
  fs.mkdirSync(path.dirname(WISH_FILE), { recursive: true });
  const tmp = WISH_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, WISH_FILE);
}

router.post('/wish', (req, res) => {
  const body = req.body || {};
  const wish = clean(body.wish, 400);
  const name = clean(body.name, 60);       // their OWN info — posted BY them
  const link = safeUrl(body.link);         // optional: how to grant it (http(s) only)
  if (!wish) return res.status(400).json({ error: 'wish required' });
  const s = loadWishes();
  if (s.items.length >= WISH_CAP) {
    return res.status(409).json({ error: 'the wish well is full — wishes need room to breathe' });
  }
  const dup = s.items.some((i) => i.wish === wish && i.name === name);
  if (!dup) {
    s.items.push({ wish, name, link, ts: Date.now(), granted: false });
    saveWishes(s);
  }
  res.json({ ok: true, count: s.items.length, duplicate: dup });
});

router.get('/wishes', (req, res) => {
  const s = loadWishes();
  res.json({ count: s.items.length, items: s.items });
});

// granting: localhost/control token — a granted wish is marked, not paid
router.post('/wish/grant', (req, res) => {
  const tok = req.headers['x-control-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
    (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''));
  const tokenOk = process.env.HIVV_CONTROL_TOKEN && tok &&
    Buffer.byteLength(tok) === Buffer.byteLength(process.env.HIVV_CONTROL_TOKEN) &&
    require('crypto').timingSafeEqual(Buffer.from(tok), Buffer.from(process.env.HIVV_CONTROL_TOKEN));
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: 'only the hive grants (localhost or control token)' });
  }
  const body = req.body || {};
  const wish = clean(body.wish, 400);
  const s = loadWishes();
  const item = s.items.find((i) => i.wish === wish);
  if (!item) return res.status(404).json({ error: 'no such wish' });
  item.granted = body.ungrant ? false : true;
  saveWishes(s);
  res.json({ ok: true, wish: item.wish, granted: item.granted });
});

module.exports = router;
