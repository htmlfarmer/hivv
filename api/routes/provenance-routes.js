// api/routes/provenance-routes.js — operator-facing request provenance API.
//
// Every request on HIVV is recorded with rich provenance (who asked, which
// model/node answered, when, how long, what it cost, where the worker was).
// These endpoints expose that ledger.
//
// ACCESS MODEL
// ────────────
//   * `view=operator` — everything, including contact details, IPs, exact
//     coordinates, traceroute and internal margins. LOCALHOST / control-token
//     only.
//   * `view=partner`  — only the fields each row's privacy policy allows.
//   * `view=public`   — aggregate counters and non-identifying metadata.
//
// The raw table is never exposed through the public database browser.

const express = require('express');
const crypto = require('crypto');
const prov = require('../lib/request-provenance');
const registry = require('../lib/review-registry');

const router = express.Router();

function _loadControlToken() {
  if (process.env.HIVV_CONTROL_TOKEN) return process.env.HIVV_CONTROL_TOKEN;
  try {
    const fs = require('fs');
    const path = require('path');
    const t = fs.readFileSync(path.join(__dirname, '..', '.control-token'), 'utf8').trim();
    return t || '';
  } catch (_e) { return ''; }
}
const CONTROL_TOKEN = _loadControlToken();

function isLocal(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip.includes('127.0.0.1') || ip.includes('::1') || ip.includes('localhost');
}

function tokenMatches(token) {
  if (!CONTROL_TOKEN || !token) return false;
  try {
    const a = Buffer.from(CONTROL_TOKEN);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_e) { return false; }
}

async function isAdmin(req) {
  if (isLocal(req)) return true;
  const token = req.headers['x-control-token'] || req.query?.token;
  if (tokenMatches(token)) return true;
  if (req.session?.userId) {
    try {
      const { pool } = require('../server');
      if (pool) {
        const r = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        if (r.rows[0] && ['admin', 'owner'].includes(r.rows[0].role)) return true;
      }
    } catch (_e) { /* fall through */ }
  }
  return false;
}

// Resolve the audience.
//
// SECURITY: the DEFAULT is `operator`, not `public`. The request ledger holds
// who asked, which IP they came from, which node answered, and what it cost —
// none of which is public. A caller must EXPLICITLY ask for `view=public` (or
// `view=partner`) to get a reduced projection; omitting the parameter used to
// silently hand out the operator view to anyone who guessed the URL.
//
// `view=partner` is the one anonymous-safe reduced view: aggregate counters
// and non-identifying metadata only.
async function resolveView(req, res) {
    const requested = String(req.query.view || 'operator').toLowerCase();
    if (!['public', 'partner', 'operator'].includes(requested)) {
        res.status(400).json({
            error: `view must be one of public, partner, operator (got '${requested}')`,
        });
        return null;
    }
    if (await isAdmin(req)) {
        // An explicit request is honored exactly — an admin asking for the
        // PUBLIC projection gets the public projection, so they can see what
        // everyone else sees. Never silently widened to `operator`.
        return requested;
    }
    // Not an admin. `operator` is never available; `public` and `partner` are.
    if (requested === 'operator') {
        res.status(403).json({
            error: 'operator view requires control-token or admin session',
            hint: 'use ?view=partner for a reduced, non-identifying projection',
        });
        return null;
    }
    return requested;
}

// ── request ledger ─────────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  const view = await resolveView(req, res);
  if (!view) return;
  const out = await prov.listRequests({
    user_id: req.query.user_id,
    anonymous_visitor_id: req.query.visitor_id,
    endpoint: req.query.endpoint,
    answered_by_node: req.query.node,
    worker_node_id: req.query.worker_node,
    model: req.query.model,
    provider: req.query.provider,
    privacy_class: req.query.privacy_class,
    since: req.query.since,
    limit: req.query.limit,
  }, view);
  if (!out.ok) return res.status(500).json({ error: out.error });
  res.json({
    data: { view, rows: out.rows },
    meta: { version: 'v1', timestamp: new Date().toISOString() },
  });
});

router.get('/requests/:requestId', async (req, res) => {
  const view = await resolveView(req, res);
  if (!view) return;
  const out = await prov.getRequest(req.params.requestId, req.query.endpoint || null, view);
  if (!out.ok) return res.status(out.error === 'not found' ? 404 : 500).json({ error: out.error });
  res.json({ data: out.row, meta: { version: 'v1', timestamp: new Date().toISOString() } });
});

// ── aggregate stats ─────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const view = await resolveView(req, res);
  if (!view) return;
  const out = await prov.stats(req.query.days);
  if (!out.ok) return res.status(500).json({ error: out.error });
  res.json({
    data: {
      view,
      overall: out.overall,
      by_node: out.by_node,
      by_endpoint: out.by_endpoint,
    },
    meta: { version: 'v1', timestamp: new Date().toISOString() },
  });
});

// ── review registry (the signed-review side) ───────────────────────────────
router.get('/reviews', async (req, res) => {
  const view = await resolveView(req, res);
  if (!view) return;
  const { pool } = require('../server');
  // The table is created on demand — a fresh install must not 500.
  await registry.ensureSchema(pool);
  const out = await registry.listReviews(pool, {
    principalId: req.query.principal_id,
    sourceSha256: req.query.source_sha256,
    limit: req.query.limit,
    view,
  });
  if (!out.ok) return res.status(500).json({ error: out.error });
  res.json({ data: { view, rows: out.rows }, meta: { version: 'v1', timestamp: new Date().toISOString() } });
});

router.get('/reviews/stats', async (req, res) => {
  const view = await resolveView(req, res);
  if (!view) return;
  const { pool } = require('../server');
  await registry.ensureSchema(pool);
  const out = await registry.reviewStats(pool, { days: req.query.days });
  if (!out.ok) return res.status(500).json({ error: out.error });
  res.json({ data: out, meta: { version: 'v1', timestamp: new Date().toISOString() } });
});

module.exports = router;
