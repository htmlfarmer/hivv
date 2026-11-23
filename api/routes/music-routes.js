// api/routes/music-routes.js — The Music Tests, the voting half.
//
// Humans vote on the musical taste of various AIs so other humans can pick
// their AI by vibe. Two routes, both cheap:
//
//   GET  /api/music/votes   -> counts per AI (10s cache, memory-cheap aggregate)
//   POST /api/music/vote    -> {ai: "gemma4-yalla"} — one vote per listener
//
// House rules honoured: no PII (voter = sha256(ip|ua)), one vote per
// (ai, voter) via ON CONFLICT DO NOTHING, rate-limited by the global
// apiLimiter on /api/*, and the response says "already" instead of lying.

const express = require('express');
const crypto = require('crypto');

const router = express.Router();
let pool = null;
router.inject = (p) => { pool = p; };

function voterId(req) {
    const ip = req.ip || '?';
    const ua = req.headers['user-agent'] || '';
    return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 32);
}

router.get('/votes', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=10');
    if (!pool) return res.json({ votes: {} });
    try {
        const { rows } = await pool.query(
            'SELECT ai, factor, COUNT(*)::int AS n FROM music_votes GROUP BY ai, factor');
        const factors = {};
        for (const r of rows) {
            if (!factors[r.factor]) factors[r.factor] = {};
            factors[r.factor][r.ai] = r.n;
        }
        // {votes: …} kept for music.html (factor "music" is the classic view)
        res.json({ votes: factors.music || {}, factors });
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 120) } });
    }
});

router.post('/vote', async (req, res) => {
    if (!pool) return res.status(503).json({ error: { message: 'no database (local install)' } });
    const ai = String((req.body && req.body.ai) || '').trim().slice(0, 64);
    if (!ai) return res.status(400).json({ error: { message: 'ai required' } });
    const factor = String((req.body && req.body.factor) || 'music').trim().slice(0, 32);
    try {
        const r = await pool.query(
            'INSERT INTO music_votes (ai, factor, voter) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',
            [ai, factor, voterId(req)]);
        if (!r.rows.length) {
            return res.json({ ok: true, already: true, message: 'one vote per listener' });
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 120) } });
    }
});

module.exports = router;
