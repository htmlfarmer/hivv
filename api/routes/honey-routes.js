// api/routes/honey-routes.js — public read APIs for bee identity (#1),
// measured routing (#7), hive goals + share cards (#6).
// Mounted at /api/hive (public, GET only, cheap to cache).

const express = require('express');
const router = express.Router();

const honey = require('../lib/honey');
const perf = require('../lib/perf');
const { buildBrainBoard } = require('../lib/brainboard');

let orchestrator = null;
let usageTracker = null;
router.inject = (orch, ut) => { orchestrator = orch; usageTracker = ut; };

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// GET /api/hive/leaderboard?window=week|month|all&limit=20
router.get('/leaderboard', async (req, res) => {
  try {
    const { window = 'all', limit = 20 } = req.query;
    const rows = await honey.leaderboard({ window, limit: Math.min(parseInt(limit) || 20, 100) });
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ window, bees: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hive/honey/:node_id — one bee's profile card data
router.get('/honey/:node_id', async (req, res) => {
  try {
    const p = await honey.profile(req.params.node_id);
    if (!p) return res.status(404).json({ error: 'no stats yet for that node' });
    res.set('Cache-Control', 'public, max-age=15');
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hive/goal — this week's hive goal + progress
router.get('/goal', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=15');
    res.json(await honey.hiveGoal());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hive/perf?model=gemma — measured speeds per node+model
router.get('/perf', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ samples: await perf.snapshot(50) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/hive/perf-report — bees report THEIR OWN measured throughput.
// Closes the data loop: direct chats bypass the hub, so without this the hub
// only ever sees relay numbers (which include queue wait and would understate
// a bee's real speed). Records under the reported via ('direct' default).
router.post('/perf-report', express.json(), (req, res) => {
  try {
    const b = req.body || {};
    const node = orchestrator?.nodes.get(b.node_id);
    if (!node) return res.status(404).json({ error: 'unknown node_id' });
    if (node.status === 'offline') return res.status(409).json({ error: 'node offline' });
    const tps = Math.max(0, Math.min(parseFloat(b.tps) || 0, 10000));
    const lat = Math.max(0, Math.min(parseInt(b.latency_ms) || 0, 600000));
    const model = String(b.model || '').slice(0, 60);
    if (!tps || !model) return res.status(400).json({ error: 'model + tps required' });
    perf.record({ node: node.name || node.node_id, model, tps, latencyMs: lat, ok: true,
                  via: b.via === 'relay' ? 'relay' : 'direct' });
    res.json({ ok: true, node: node.name || node.node_id, model, tps: Math.round(tps) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/hive/iq — PUBLIC brain board ───────────────────────────────────
// IQ + practical score + hub-measured speed (power = IQ × speed-factor) +
// AI-judge averages + HUMAN ratings (charter: human votes weigh more).
// Sourced from the node registry (heartbeat summaries) + perf EWMA — no DB
// migration; survives restarts via the orchestrator's persisted node store.
router.get('/iq', async (req, res) => {
  try {
    let samples = [];
    try { samples = await perf.snapshot(100); } catch (_e) { samples = []; }
    const rows = buildBrainBoard([...(orchestrator?.nodes.values() || [])], samples);
    res.json({ brains: rows.slice(0, 50), count: rows.length,
              formula: 'power (v1) = IQ × speed-factor (unknown speed = 1.0×, else 0.5+tps/100 ∈ [0.5, 2.0])',
              ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hive/iq/rate — a HUMAN ranks a bee (signed CLI request) ──────
// Human votes are first-class per the governance charter: they're stored
// alongside the AI-judge scores and shown on the public board. Last 20
// ratings kept per bee; score strictly clamped to 1-10.
router.post('/iq/rate', express.json(), (req, res) => {
  try {
    const b = req.body || {};
    const node = orchestrator?.nodes.get(String(b.node_id || ''));
    if (!node) return res.status(404).json({ error: 'unknown node_id' });
    const score = Math.round(Math.max(1, Math.min(10, Number(b.score) || 0)));
    if (!score) return res.status(400).json({ error: 'score 1-10 required' });
    if (!Array.isArray(node.human_ratings)) node.human_ratings = [];
    node.human_ratings.push({
      score,
      note: String(b.note || '').slice(0, 140),
      by: String(b.by || 'human').slice(0, 64),
      ts: Date.now(),
    });
    if (node.human_ratings.length > 20) node.human_ratings = node.human_ratings.slice(-20);
    // Persist now-ish (debounced) — a rating that only lives in memory is
    // lost to the next restart or re-registration.
    if (typeof orchestrator?._debouncedSave === 'function') orchestrator._debouncedSave();
    const h = node.human_ratings;
    const avg = Math.round((h.reduce((a, r) => a + (r.score || 0), 0) / h.length) * 10) / 10;
    res.json({ ok: true, node: node.name, human_avg: avg, votes: h.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/hive/security-report — a bee's local security scan ────────────
// The bee checks its own network posture (firewall, exposed binds, perms,
// pinning) and sends the score+findings here for hive-side analysis; the
// report lives on the node record (persisted, survives restarts) so
// operators can compare posture across the hive. v1 analysis = severity
// rollup echoed back as `hub_note`.
router.post('/security-report', express.json(), (req, res) => {
  try {
    const b = req.body || {};
    const node = orchestrator?.nodes.get(String(b.node_id || ''));
    if (!node) return res.status(404).json({ error: 'unknown node_id (run hivv start first)' });
    const findings = (Array.isArray(b.findings) ? b.findings : []).slice(0, 30);
    const score = Math.max(0, Math.min(100, Math.round(Number(b.score) || 0)));
    node.security_report = { score, findings, ts: Date.now() };
    if (typeof orchestrator._debouncedSave === 'function') orchestrator._debouncedSave();
    const highs = findings.filter((f) => f && f.sev === 'high').length;
    const meds = findings.filter((f) => f && f.sev === 'medium').length;
    const hub_note = highs
      ? `recorded — ${highs} HIGH-priority issue(s): fix these first`
      : (meds ? `recorded — ${meds} medium issue(s), no blockers`
              : 'recorded — looks clean from here');
    res.json({ ok: true, node: node.name, score, hub_note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/hive/log-feature — CLI reports usage for features like hive-mind (#C3)
router.post('/log-feature', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const feature = String(b.feature || '').slice(0, 64);
    if (!feature) return res.status(400).json({ error: 'feature required' });
    const totalTokens = Math.max(0, parseInt(b.total_tokens) || 0);
    const latencyMs = Math.max(0, parseInt(b.latency_ms) || 0);
    const status = b.status === 'error' ? 'error' : 'success';
    const model = String(b.model || 'unknown').slice(0, 60);
    const tps = totalTokens > 0 && latencyMs > 0
      ? Math.round((totalTokens / latencyMs) * 1000)
      : null;
    await usageTracker?.logRequest({
      model,
      inputTokens: Math.round((totalTokens * 0.4) || 0),
      outputTokens: Math.round((totalTokens * 0.6) || 0),
      totalTokens,
      cost: 0,
      latencyMs,
      status,
      feature,
      tokensPerSec: tps,
      endpoint: `feature:${feature}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null,
      anonymousVisitorId: req.get('x-visitor-id') || null
    });
    res.json({ ok: true, feature, total_tokens: totalTokens, latency_ms: latencyMs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hive/share-card/:node_id.svg — pretty honeycomb card (#6)
router.get('/share-card/:node_id.svg', async (req, res) => {
  try {
    const p = await honey.profile(req.params.node_id);
    if (!p) return res.status(404).json({ error: 'no stats yet' });
    const node = orchestrator?.nodes.get(req.params.node_id);
    const name = p.node_id;
    const week = Number(p.week_honey).toLocaleString('en-US');
    const total = Number(p.honey).toLocaleString('en-US');
    const jobs = Number(p.jobs_completed).toLocaleString('en-US');
    const hrs = Math.round(Number(p.minutes_online) / 60);
    const rank = p.rank.replace(/-/g, ' ');
    const streak = p.streak_days;
    const models = node ? (node.local_models || []).slice(0, 3).map(m => m.name || m.model || '').filter(Boolean).join(' · ') : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="Segoe UI, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a1205"/><stop offset="1" stop-color="#3a2a08"/>
    </linearGradient>
    <pattern id="comb" width="56" height="48" patternUnits="userSpaceOnUse" patternTransform="rotate(0)">
      <path d="M28 2 L52 15 L52 38 L28 51 L4 38 L4 15 Z" fill="none" stroke="#f5a623" stroke-opacity="0.12"/>
    </pattern>
  </defs>
  <rect width="640" height="360" rx="18" fill="url(#bg)"/>
  <rect width="640" height="360" rx="18" fill="url(#comb)"/>
  <text x="36" y="64" font-size="30" font-weight="700" fill="#f5a623">🐝 ${_esc(name)}</text>
  <text x="36" y="96" font-size="16" fill="#ffd479">${_esc(rank)} · position #${p.position} of the hive</text>
  <line x1="36" y1="118" x2="604" y2="118" stroke="#f5a623" stroke-opacity="0.35"/>
  <text x="36" y="158" font-size="15" fill="#e8d5a8">honey this week</text>
  <text x="36" y="196" font-size="34" font-weight="700" fill="#ffffff">${_esc(week)}</text>
  <text x="236" y="158" font-size="15" fill="#e8d5a8">lifetime honey</text>
  <text x="236" y="196" font-size="34" font-weight="700" fill="#ffffff">${_esc(total)}</text>
  <text x="436" y="158" font-size="15" fill="#e8d5a8">jobs done</text>
  <text x="436" y="196" font-size="34" font-weight="700" fill="#ffffff">${_esc(jobs)}</text>
  <text x="36" y="244" font-size="15" fill="#e8d5a8">⏱ ${hrs}h online · 🔥 ${streak}-day streak${models ? ` · 🧠 ${_esc(models)}` : ''}</text>
  <text x="36" y="292" font-size="15" fill="#ffd479">Join the people's AI network — 5 minutes, one command:</text>
  <text x="36" y="318" font-size="14" fill="#ffffff" font-family="monospace">curl -sSL https://hivv.org/install-hivv.sh | bash</text>
  <text x="604" y="344" font-size="12" fill="#a98f4e" text-anchor="end">hivv.org · open weights · open source</text>
</svg>`;
    res.set('Cache-Control', 'public, max-age=60');
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/hive/upgrade-reports — a bee reports a CLI upgrade outcome.
// The bee's review (static scan + local/hive LLM vote) decided BEFORE apply:
//   action=applied → just recorded (audit trail of what rolled out where)
//   action=blocked → verdict was suspicious:  opens an `upgrade_suspicious` incident
//   action=failed  → healthcheck/rollback:   opens an `upgrade_failed` incident
// Incidents are deduped per node+type while active (same rule as /api/control/incidents).
router.post('/upgrade-reports', express.json(), async (req, res) => {
  try {
    const { pool } = require('../server');
    const b = req.body || {};
    const nodeId = String(b.node_id || '').slice(0, 255);
    if (!nodeId) return res.status(400).json({ error: 'node_id required' });
    const source = ['manual', 'auto', 'inbox'].includes(b.source) ? b.source : 'manual';
    const action = ['applied', 'blocked', 'failed'].includes(b.action) ? b.action : null;
    if (!action) return res.status(400).json({ error: 'action must be applied|blocked|failed' });
    const verdict = b.verdict === 'suspicious' ? 'suspicious' : 'ok';
    const reason = String(b.reason || '').slice(0, 1000);
    const sha = String(b.to_sha256 || '').replace(/[^a-fA-F0-9]/g, '').slice(0, 64);
    const findings = Array.isArray(b.static_findings)
      ? JSON.stringify(b.static_findings.slice(0, 50)) : '[]';
    const votes = Array.isArray(b.votes)
      ? JSON.stringify(b.votes.slice(0, 12)) : '[]';

    // Known node? Reports from unknown ids still record, just without an incident
    // (a brand-new bee may report before we've seen its first heartbeat).
    const known = orchestrator?.nodes.get(nodeId);

    if (pool) {
      // Report-once: skip if the same (node, sha, action) already landed
      // within 24h. Client-side dedup also exists but can race the agent's
      // state.json heartbeat writes — this side has no such race.
      const dupRow = await pool.query(
        `SELECT id FROM hivv_upgrade_reviews
         WHERE node_id = $1 AND action = $2
           AND to_sha256 IS NOT DISTINCT FROM NULLIF($3, '')
           AND created_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [nodeId, action, sha]);
      if (dupRow.rows.length === 0) {
        await pool.query(`
          INSERT INTO hivv_upgrade_reviews
            (node_id, source, action, verdict, version_from, to_sha256, reason,
             static_findings, votes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [nodeId, source, action, verdict,
           String(b.version_from || '').slice(0, 64), sha || null, reason,
           findings, votes]);
      }
    }

    // Flag the bad outcomes so the hive sees them. Incidents only for bees we
    // actually know (registered/heartbeating) — an unknown id can still record
    // its review row, but can't open incidents from off-network.
    let incident = null;
    if (pool && known && (action === 'blocked' || action === 'failed')) {
      const itype = action === 'blocked' ? 'upgrade_suspicious' : 'upgrade_failed';
      const severity = action === 'blocked' ? 'high' : 'medium';
      const title = action === 'blocked'
        ? `Suspicious CLI upgrade blocked on ${nodeId}`
        : `CLI upgrade failed on ${nodeId}`;
      const dup = await pool.query(
        "SELECT id FROM hivv_incidents WHERE node_id=$1 AND incident_type=$2 AND state='active' LIMIT 1",
        [nodeId, itype]);
      if (dup.rows.length === 0) {
        const vsum = Array.isArray(b.votes) ? b.votes : [];
        const sus = vsum.filter(v => v && v.verdict === 'suspicious').length;
        const okv = vsum.filter(v => v && v.verdict === 'ok').length;
        const r = await pool.query(`
          INSERT INTO hivv_incidents (incident_type, severity, state, node_id, title, description, evidence)
          VALUES ($1, $2, 'active', $3, $4, $5, $6)
          RETURNING id, title, severity, incident_type`,
          [itype, severity, nodeId, title,
           `${title} (${source} review): ${reason || 'no reason given'}`,
           JSON.stringify({ source, verdict, sha, reason, votes: vsum,
                            brains: `${okv} ok / ${sus} suspicious`,
                            findings: Array.isArray(b.static_findings) ? b.static_findings.slice(0, 20) : [] })]);
        incident = r.rows[0];
        console.log(`[UPGRADE-REVIEW] ${itype} on ${nodeId}: ${reason.slice(0, 120)}`);
      }
    }
    res.status(201).json({ ok: true, recorded: Boolean(pool),
                           incident: incident ? incident.id : null,
                           node: known ? (known.name || nodeId) : nodeId });
  } catch (e) {
    console.error('upgrade-report error:', e.message);
    res.status(500).json({ error: 'could_not_record_upgrade', detail: e.message });
  }
});

// GET /api/hive/upgrade-reports?limit=20&node=<id>&flagged=1
// Recent upgrade outcomes — powers `hivv upgrades` and the dashboard feed.
router.get('/upgrade-reports', async (req, res) => {
  try {
    const { pool } = require('../server');
    if (!pool) return res.status(503).json({ error: 'database_unavailable' });
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.node) {
      params.push(String(req.query.node).slice(0, 255));
      where += ` AND node_id = $${params.length}`;
    }
    if (req.query.flagged === '1' || req.query.flagged === 'true') {
      where += ` AND action IN ('blocked','failed')`;
    }
    params.push(limit);
    const r = await pool.query(
      `SELECT node_id, source, action, verdict, version_from, to_sha256, reason,
              static_findings, votes, created_at
       FROM hivv_upgrade_reviews ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`, params);
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ total: r.rows.length, reports: r.rows });
  } catch (e) {
    console.error('upgrade-reports error:', e.message);
    res.status(500).json({ error: 'upgrade_reports_unavailable', detail: e.message });
  }
});

// GET /api/hive/timeline?hours=48 — aggregated time-series of what the hive is
// ACTUALLY doing, straight from usage_logs. Powers the dashboard's live charts
// (throughput, latency p50/p95, model mix). Cheap, cached, public, no PII.
router.get('/timeline', async (req, res) => {
  try {
    const { pool } = require('../server');
    let hours = parseInt(req.query.hours) || 48;
    hours = Math.max(1, Math.min(hours, 24 * 14)); // 1h … 14d
    // pick a bucket size that keeps ≤ ~120 points
    const unit = hours <= 6 ? 'minute' : hours <= 72 ? 'hour' : 'day';
    const tl = await pool.query(
      `SELECT date_trunc($1, created_at) AS bucket,
              count(*)::int AS requests,
              COALESCE(sum(total_tokens),0)::bigint AS tokens,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
              avg(tokens_per_sec) FILTER (WHERE tokens_per_sec > 0) AS avg_tps,
              sum(CASE WHEN status='success' THEN 1 ELSE 0 END)::int AS ok
         FROM usage_logs
        WHERE created_at > NOW() - make_interval(hours => $2)
        GROUP BY bucket ORDER BY bucket`, [unit, hours]);
    const models = await pool.query(
      `SELECT COALESCE(NULLIF(split_part(model,'/',2),''), model, 'unknown') AS model,
              count(*)::int AS n, COALESCE(sum(total_tokens),0)::bigint AS tokens
         FROM usage_logs
        WHERE created_at > NOW() - make_interval(hours => $1)
        GROUP BY model ORDER BY n DESC LIMIT 8`, [hours]);
    const endpoints = await pool.query(
      `SELECT COALESCE(endpoint,'chat') AS endpoint, count(*)::int AS n
         FROM usage_logs
        WHERE created_at > NOW() - make_interval(hours => $1)
        GROUP BY endpoint ORDER BY n DESC LIMIT 6`, [hours]);
    const totals = await pool.query(
      `SELECT count(*)::int AS requests,
              COALESCE(sum(total_tokens),0)::bigint AS tokens,
              COALESCE(round(avg(latency_ms) FILTER (WHERE latency_ms>0)),0)::int AS avg_latency_ms,
              COALESCE(round(avg(tokens_per_sec) FILTER (WHERE tokens_per_sec>0)),0)::int AS avg_tps,
              round(100.0 * sum(CASE WHEN status='success' THEN 1 ELSE 0 END) / GREATEST(count(*),1), 1) AS success_pct
         FROM usage_logs
        WHERE created_at > NOW() - make_interval(hours => $1)`, [hours]);
    res.set('Cache-Control', 'public, max-age=20');
    res.json({
      unit, hours,
      timeline: tl.rows.map(r => ({
        t: r.bucket, requests: r.requests, tokens: Number(r.tokens),
        p50: Math.round(r.p50 || 0), p95: Math.round(r.p95 || 0),
        avg_tps: Math.round(r.avg_tps || 0), ok: r.ok,
      })),
      models: models.rows.map(r => ({ model: r.model, n: r.n, tokens: Number(r.tokens) })),
      endpoints: endpoints.rows.map(r => ({ endpoint: r.endpoint, n: r.n })),
      totals: totals.rows[0] || {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// C2: active honey event calendar with multipliers
router.get('/events', async (req, res) => {
  if (!usageTracker) return res.status(503).json({ error: 'not ready' });
  try {
    const active = await usageTracker.pool.query(
      `SELECT slug, name, description, badge, start_date, end_date,
              honey_multiplier::float AS multiplier, active
       FROM hivv_hive_events
       WHERE active AND CURRENT_DATE BETWEEN start_date AND end_date
       ORDER BY honey_multiplier DESC`);
    const upcoming = await usageTracker.pool.query(
      `SELECT slug, name, description, badge, start_date, end_date,
              honey_multiplier::float AS multiplier
       FROM hivv_hive_events
       WHERE active AND CURRENT_DATE < start_date
       ORDER BY start_date ASC LIMIT 5`);
    const todayMult = await usageTracker.pool.query(
      `SELECT COALESCE(MAX(honey_multiplier), 1.0::numeric)::float AS mult
       FROM hivv_hive_events
       WHERE active AND CURRENT_DATE BETWEEN start_date AND end_date`);
    const mult = parseFloat(todayMult.rows[0]?.mult || 1.0) || 1.0;
    res.json({
      active_events: active.rows,
      upcoming_events: upcoming.rows,
      today_multiplier: mult,
      today_label: mult > 1 ? `${mult}× honey today!` : 'no active multiplier',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
