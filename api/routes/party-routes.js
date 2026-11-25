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

module.exports = router;
