// api/routes/tips-routes.js — C4: tip analytics.
// Mounted at /api/tips.
//   GET  /            tip performance summary
//   POST /log        log a tip event (shown or clicked)

const express = require('express');
const router = express.Router();

let pool = null;
router.inject = (pgPool) => { pool = pgPool; };

router.get('/', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'not ready' });
  try {
    const r = await pool.query(
      `SELECT tip_key, tip_text, shown_count, click_count,
              ROUND(100.0 * NULLIF(click_count, 0) / NULLIF(shown_count, 0), 1) AS ctr,
              last_shown
         FROM hivv_tips
         ORDER BY shown_count DESC`);
    const total = r.rows.reduce((a, row) => ({ shown: a.shown + parseInt(row.shown_count), click: a.click + parseInt(row.click_count) }), { shown: 0, click: 0 });
    res.json({ tips: r.rows, totals: total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/log', express.json(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'not ready' });
  try {
    const { tip_key, event } = req.body || {};
    if (!tip_key || !event) return res.status(400).json({ error: 'tip_key and event (shown|clicked) required' });
    if (!['shown', 'clicked'].includes(event)) return res.status(400).json({ error: 'event must be shown or clicked' });
    const col = event === 'shown' ? 'shown_count' : 'click_count';
    await pool.query(
      `INSERT INTO hivv_tips (tip_key, ${col}, last_shown)
       VALUES ($1, 1, CASE WHEN $2 = 'shown' THEN NOW() ELSE NULL END)
       ON CONFLICT (tip_key) DO
         UPDATE SET ${col} = hivv_tips.${col} + 1,
                    last_shown = CASE WHEN $2 = 'shown' THEN NOW() ELSE hivv_tips.last_shown END`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
