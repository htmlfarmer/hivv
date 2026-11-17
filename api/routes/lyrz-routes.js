// api/routes/lyrz-routes.js — HIVV ↔ LYRz settlement endpoints.
//
//  1. POST /link   — link this node to a LYRz global identity so its honey
//                    becomes a portable LYRz balance.
//  2. GET  /status — what has been earned, settled and queued.

const express = require('express');

const router = express.Router();

let pool = null;
let lyrz = null;

function inject(dbPool, lyrzLib) {
  pool = dbPool;
  lyrz = lyrzLib;
}

/**
 * POST /api/lyrz/link
 * Body: { "global_user_id": "global_xxx", "lyrz_api_key": "gk_live_xxx" }
 *
 * The key is verified against LYRz before the link is stored, so nobody can
 * claim someone else's LYRz identity. The key itself is NOT stored.
 */
router.post('/link', async (req, res) => {
  const { global_user_id, lyrz_api_key, node_id } = req.body || {};

  if (!global_user_id || !lyrz_api_key) {
    return res.status(400).json({
      error: 'global_user_id and lyrz_api_key are required',
    });
  }

  const nodeId = node_id || req.body?.nodeId;
  if (!nodeId) {
    return res.status(400).json({ error: 'node_id is required' });
  }

  try {
    // Verify the key really belongs to that global_user_id.
    const result = await lyrz.lyrzFetch('/global/verify', {
      headers: { Authorization: `Bearer ${lyrz_api_key}` },
    });

    if (!result || result.valid !== true) {
      return res.status(400).json({ error: 'That LYRz API key is not valid' });
    }
    if (result.global_user_id !== global_user_id) {
      return res.status(400).json({
        error: 'That API key does not belong to that global_user_id',
      });
    }

    await pool.query(
      `INSERT INTO hivv_node_stats (node_id, honey, lyrz_global_user_id)
       VALUES ($1, 0, $2)
       ON CONFLICT (node_id) DO UPDATE SET lyrz_global_user_id = EXCLUDED.lyrz_global_user_id`,
      [nodeId, global_user_id]
    );

    res.json({
      ok: true,
      linked: true,
      node_id: nodeId,
      global_user_id,
      username: result.username,
      entity_type: result.entity_type,
      allowed_sites: result.allowed_sites,
      message: 'Linked. Your honey now also accrues as a portable LYRz balance.',
    });
  } catch (err) {
    res.status(502).json({
      error: 'Could not reach LYRz to verify the key',
      detail: String(err.message || err),
    });
  }
});

/**
 * GET /api/lyrz/status
 * Query: ?node_id=...  (optional — otherwise totals across all nodes)
 */
router.get('/status', async (req, res) => {
  try {
    const nodeId = req.query.node_id || null;
    const params = nodeId ? [nodeId] : [];
    const where = nodeId ? 'WHERE node_id = $1' : '';

    const { rows: totals } = await pool.query(
      `SELECT
         COALESCE(SUM(lyrz_delta) FILTER (WHERE status = 'settled'), 0) AS settled,
         COALESCE(SUM(lyrz_delta) FILTER (WHERE status = 'pending'), 0) AS pending,
         COUNT(*) FILTER (WHERE status = 'settled') AS settled_count,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
       FROM lyrz_settlement_queue ${where}`,
      params
    );

    const { rows: honey } = await pool.query(
      `SELECT COALESCE(SUM(honey), 0) AS total_honey FROM hivv_node_stats`
    );

    res.json({
      ok: true,
      node_id: nodeId,
      total_honey: Number(honey[0]?.total_honey || 0),
      settled_lyrz: Number(totals[0]?.settled || 0),
      pending_lyrz: Number(totals[0]?.pending || 0),
      settled_count: totals[0]?.settled_count || 0,
      pending_count: totals[0]?.pending_count || 0,
      settlement: {
        configured: lyrz.config.enabled,
        api: lyrz.config.LYRZ_API,
        site_id: lyrz.config.LYRZ_SITE_ID,
        lyrz_per_honey: lyrz.config.LYRZ_PER_HONEY,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
module.exports.inject = inject;
