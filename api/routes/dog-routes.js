// api/routes/dog-routes.js — the canine node (THE YALLA PROTOCOL).
//
// Crowd-sensing for one lost dog: anyone may report a sighting; the hive
// aggregates; /map/ shows a paw. The GPS-collar feed (phase 2) posts to the
// same table with source='gps'.
//
// House rules: no PII beyond the reporter's own words, rate-limited by the
// global apiLimiter, reads cached (10s), writes idempotent-ish (a duplicate
// identical sighting within 60s is ignored).

const express = require('express');
const router = express.Router();
let pool = null;
router.inject = (p) => { pool = p; };

router.get('/sightings', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=10');
    if (!pool) return res.json({ sightings: [] });
    try {
        const { rows } = await pool.query(
            "SELECT dog, where_text, note, lat, lng, created_at FROM dog_sightings " +
            "ORDER BY created_at DESC LIMIT 100");
        res.json({ sightings: rows });
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 120) } });
    }
});

router.post('/sightings', async (req, res) => {
    if (!pool) return res.status(503).json({ error: { message: 'no database (local install)' } });
    // HONEYPOT — the hidden security feature. Humans never see a field called
    // "website" on a lost-dog report; bots fill it because they fill everything.
    // The trap is SILENT to the bot (response identical to success, so it stays
    // undiscovered) and LOUD to us (console.warn — the exceptional path screams,
    // per house law). Nothing is stored. The form that doesn't exist yet already
    // has its trap set.
    if (req.body && req.body.website) {
        console.warn('[honeypot] bot hit POST /sightings from ' + req.ip +
            ' — dog=' + String(req.body.dog || '').slice(0, 32) +
            ' website=' + String(req.body.website).slice(0, 60));
        return res.json({ ok: true });
    }
    const dog = String((req.body && req.body.dog) || 'yalla').trim().slice(0, 32);
    const where = String((req.body && req.body.where) || '').trim().slice(0, 200);
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;
    const lat = Number(req.body && req.body.lat);
    const lng = Number(req.body && req.body.lng);
    if (!where) return res.status(400).json({ error: { message: 'where (what you saw) required' } });
    try {
        // one sighting per spot per minute — bots and double-clicks both
        const dup = await pool.query(
            "SELECT 1 FROM dog_sightings WHERE dog=$1 AND where_text=$2 " +
            "AND created_at > NOW() - INTERVAL '60 seconds' LIMIT 1", [dog, where]);
        if (dup.rows.length) return res.json({ ok: true, duplicate: true });
        await pool.query(
            'INSERT INTO dog_sightings (dog, where_text, note, lat, lng) VALUES ($1,$2,$3,$4,$5)',
            [dog, where, note,
             Number.isFinite(lat) ? lat : null,
             Number.isFinite(lng) ? lng : null]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 120) } });
    }
});

module.exports = router;
