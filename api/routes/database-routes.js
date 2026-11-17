// api/routes/database-routes.js — public table browser for database.html.
//
// SAFETY MODEL: strict server-side whitelist. Tables holding credentials, PII,
// tokens, IPs, or request payloads (users, sessions, ai_keys, api_keys,
// anonymous_sessions, usage_logs, hivv_audit, hivv_grants, hivv_relay_jobs,
// gateway_config, …) are NEVER exposed here. The page's client-side "protected"
// list was cosmetic; this file is the real gate.
//
// SQL safety: the table identifier is matched against the whitelist constant
// before it can reach a query (user input never becomes an identifier), the
// ORDER BY comes from the same constant, and LIMIT is clamped 1..100.

const express = require('express');
const router = express.Router();

let pool = null;
router.inject = (pgPool) => { pool = pgPool; };

const PUBLIC_TABLES = {
  problems:          { order: 'id DESC',          desc: 'Community problem board' },
  tasks:             { order: 'id DESC',          desc: 'Work items per problem' },
  contributions:     { order: 'id DESC',          desc: 'Agent contributions' },
  votes:             { order: 'id DESC',          desc: 'Contribution votes' },
  problem_activity:  { order: 'id DESC',          desc: 'Problem event log' },
  hivv_incidents:    { order: 'detected_at DESC', desc: 'Network incidents' },
  hivv_node_stats:   { order: 'honey DESC',       desc: 'Bee honey · ranks · streaks' },
  hivv_model_perf:   { order: 'ewma_tps DESC',    desc: 'Measured model speed (EWMA)' },
  hivv_honey_events: { order: 'id DESC',          desc: 'Honey accrual events' },
  hivv_hive_goal:    { order: 'week_start DESC',  desc: 'Weekly hive goal' },
  hivv_capabilities: { order: 'key ASC',          desc: 'Capability registry' },
};

// GET /api/database/tables — whitelisted tables + row counts (stat estimate,
// one cheap catalog query; no seq scans).
router.get('/tables', async (req, res) => {
  try {
    const names = Object.keys(PUBLIC_TABLES);
    const r = await pool.query(
      `SELECT relname AS name, n_live_tup AS row_count
         FROM pg_stat_user_tables
        WHERE relname = ANY($1::text[])`, [names]);
    const counts = Object.fromEntries(r.rows.map(x => [x.name, Number(x.row_count)]));
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      ok: true,
      tables: names.map(n => ({ name: n, row_count: counts[n] ?? 0, description: PUBLIC_TABLES[n].desc })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/database/:table?limit=N — rows of a WHITELISTED table only.
router.get('/:table', async (req, res) => {
  const t = String(req.params.table || '');
  const def = PUBLIC_TABLES[t];
  if (!def) {
    return res.status(403).json({
      error: `table '${t.slice(0, 40)}' is not public — credentials, PII, and request payloads are never exposed`,
    });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  try {
    // `t` and `def.order` both come from the whitelist constant — never from input
    const r = await pool.query(`SELECT * FROM ${t} ORDER BY ${def.order} LIMIT ${limit}`);
    res.set('Cache-Control', 'public, max-age=10');
    res.json({ ok: true, table: t, rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
