// api/routes/policy-routes.js — §3 of the capability/policy plan.
// Mounted at /api/policy. The YES/MAYBE/NO gate's human surface:
//   GET  /                     defaults per capability + global policy
//   POST /check               evaluate an action (dry-run, no side effects)
//   GET  /grants?status=…     pending/approved grants (mine=1 → your visitor)
//   POST /grants/:id/decide   approve/deny (the asked principal, or admin)
//   GET  /audit               hash-chained decision ledger
//   GET  /audit/verify        recompute the chain — tamper check
//   GET  /stats               gate counters + pending count + chain head
//   PUT  /policy              store a policy doc (own principal, or global if admin)

const express = require('express');
const router = express.Router();

const policy = require('../lib/policy');

const CONTROL_TOKEN = process.env.HIVV_CONTROL_TOKEN || '';
let orchestrator = null;
router.inject = (orch) => { orchestrator = orch; };

function _ip(req) { return req.ip || req.connection?.remoteAddress || ''; }
async function _isAdmin(req) {
  const ip = _ip(req);
  if (ip.includes('127.0.0.1') || ip.includes('::1')) return true;
  const token = req.headers['x-control-token'];
  if (CONTROL_TOKEN && token) {
    const crypto = require('crypto');
    try {
      const a = Buffer.from(CONTROL_TOKEN), b = Buffer.from(String(token));
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch (e) {}
  }
  try {
    const { getSession, pool } = require('../server');
    const session = await getSession(req);
    if (session?.userId) {
      const r = await pool.query('SELECT role FROM users WHERE id = $1', [session.userId]);
      return ['admin', 'owner'].includes(r.rows[0]?.role);
    }
  } catch (e) {}
  return false;
}

// principal of the caller: session user, else x-visitor-id header/cookie
async function _principal(req) {
  try {
    const { getSession, getVisitorId } = require('../server');
    const session = await getSession(req);
    if (session?.userId) return { kind: 'user', id: `user:${session.userId}`, admin: ['admin', 'owner'].includes(session.role), req };
    const v = getVisitorId(req, { cookie: () => {} });
    return { kind: 'visitor', id: v, admin: false, req };
  } catch (e) {
    return { kind: 'anon', id: req.headers['x-visitor-id'] || 'anon', admin: false, req };
  }
}

router.get('/', async (req, res) => {
  try {
    const defaults = await policy.defaults();
    const admin = await _isAdmin(req);
    const r = await require('../server').pool.query(
      `SELECT principal, doc, priority, updated_at FROM hivv_policies WHERE active = TRUE ${admin ? '' : `AND principal = 'global'`} ORDER BY priority`);
    res.json({
      capabilities: defaults,
      policies: r.rows,
      tuple: { WHO: 'principal (visitor/user/node) + delegation chain', WHAT: 'capability + tier',
               DATA: 'data_class (public|internal|secret)', WHERE: 'transport (local|direct|relay|cloud) + node',
               WHEN: 'grant expires_at + policy validity', COST: 'limits.max_cost_per_day_usd + route.max_cost',
               RISK: 'tier risk → ask threshold', AUDIT: 'GET /api/policy/audit (hash-chained)' },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// dry-run evaluation — never mints grants, never audits
router.post('/check', express.json(), async (req, res) => {
  try {
    const action = (req.body || {}).action || {};
    if (!action.capability) return res.status(400).json({ error: 'action.capability required' });
    const p = await _principal(req);
    const verdict = await policy.gate(
      { capability: action.capability, principal: action.principal || p.id, transport: action.transport || null,
        provider: action.provider || null, data_class: action.data_class || null, mode: action.mode || null },
      { dryRun: true });
    res.json(verdict);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// grants list: pending needs admin (or ?mine=1 for your own)
router.get('/grants', async (req, res) => {
  try {
    const p = await _principal(req);
    const status = req.query.status || 'pending';
    if (req.query.mine === '1') {
      return res.json({ grants: await policy.listGrants({ status: null, principal: p.id, limit: 100 }) });
    }
    if (!(await _isAdmin(p.req))) return res.status(401).json({ error: 'admin required (or use mine=1)' });
    res.json({ grants: await policy.listGrants({ status, limit: 100 }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// approve/deny — the asked principal answers their own, admin answers anything
router.post('/grants/:id/decide', express.json(), async (req, res) => {
  try {
    const p = await _principal(req);
    const { verdict, scope = 'standing', ttl_s, memo } = req.body || {};
    if (!['approve', 'approved', 'deny', 'denied'].includes(verdict)) {
      return res.status(400).json({ error: "verdict must be 'approve' or 'deny'" });
    }
    const v = verdict.startsWith('appr') ? 'approved' : 'denied';
    const grant = await policy.getGrant(req.params.id);
    if (!grant) return res.status(404).json({ error: 'grant not found' });
    if (grant.status !== 'pending') return res.status(409).json({ error: `grant already ${grant.status}` });
    const admin = await _isAdmin(req);
    // High-risk capabilities (code execution, money, physical world) must be
    // approved by an ADMIN — the requesting principal may NOT self-approve.
    const HIGH_RISK = new Set(['coding.execute', 'financial.transaction', 'physical.world']);
    if (HIGH_RISK.has(grant.capability) && !admin) {
      return res.status(403).json({ error: `${grant.capability} requires an admin to approve (self-approval not allowed)` });
    }
    if (!admin && grant.principal !== p.id) return res.status(403).json({ error: 'not your grant' });
    const row = await policy.decideGrant(grant.id, v, p.id, { scope, ttl_s, memo });
    if (!row) return res.status(409).json({ error: 'decision race — already decided' });
    res.json({ ok: true, grant: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/audit', async (req, res) => {
  try {
    const admin = await _isAdmin(req);
    const rows = await policy.recentAudit({
      limit: req.query.limit || 50, verdict: req.query.verdict || null, actor: admin ? (req.query.actor || null) : null });
    res.set('Cache-Control', 'public, max-age=5');
    res.json({
      rows: rows.map(r => ({
        ...r,
        actor: admin ? r.actor : String(r.actor || '').slice(0, 14) + '…',
        prev_hash: admin ? r.prev_hash : r.prev_hash?.slice(0, 12),
        hash: r.hash?.slice(0, 12),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/audit/verify', async (req, res) => {
  try {
    res.json(await policy.verifyChain());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// F5: list monthly signed snapshots
router.get('/audit/snapshots', async (req, res) => {
  try {
    const snapshots = await policy.listSnapshots();
    const { _getSigningKey } = require('../lib/policy');
    // Re-sign each snapshot so the client can verify tamper-evidence
    const { crypto } = require('crypto');
    const key = process.env.HIVV_AUDIT_SIGNING_KEY || '';
    const rows = snapshots.map(s => {
      const data = `${s.year}-${s.month}-${s.row_count}-${s.head_hash}`;
      const expectedSig = crypto.createHmac('sha256', key || 'ephemeral').update(data).digest('hex');
      return {
        year: s.year, month: s.month, row_count: s.row_count,
        first_id: s.first_id, last_id: s.last_id,
        head_hash: s.head_hash, signature: s.signature,
        signature_valid: key ? (expectedSig === s.signature) : null,
        created_at: s.created_at
      };
    });
    res.json({ snapshots: rows, signing_key_configured: !!key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// F1: delegation CRUD — visitor creates a delegation (parent=self, agent=target)
// GET /api/policy/delegations[?agent=xyz] — list delegations (own as parent, or any as admin)
router.get('/delegations', async (req, res) => {
  try {
    const visitorId = req.headers['x-visitor-id'] || 'visitor:' + (req.ip || 'anon');
    const isAdmin = await _isAdmin(req);
    const rows = await policy.listDelegations({ principal: visitorId, agent: req.query.agent || null, isAdmin });
    res.json({ delegations: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/policy/delegations — create a delegation (parent=own visitor id, agent=target node)
router.post('/delegations', express.json(), async (req, res) => {
  try {
    const visitorId = req.headers['x-visitor-id'] || 'visitor:' + (req.ip || 'anon');
    const { agent, capability, max_depth } = req.body || {};
    if (!agent) return res.status(400).json({ error: 'agent required' });
    const delegation = await policy.createDelegation({ parent: visitorId, agent, capability, maxDepth: max_depth });
    if (!delegation) return res.status(500).json({ error: 'create failed' });
    res.status(201).json({ ok: true, delegation });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/policy/delegations/:id — revoke a delegation (owner or admin)
router.delete('/delegations/:id', async (req, res) => {
  try {
    const visitorId = req.headers['x-visitor-id'] || 'visitor:' + (req.ip || 'anon');
    const isAdmin = await _isAdmin(req);
    const revoked = await policy.revokeDelegation({ id: req.params.id, principal: visitorId, isAdmin });
    if (!revoked) return res.status(404).json({ error: 'not found or not yours' });
    res.json({ ok: true, revoked: revoked.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const st = policy.stats();
    st.pending = await policy.pendingCount();
    res.json(st);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// store a policy doc: anyone can set their own (principal = their visitor id);
// global requires admin. rules validated to a strict shape.
router.put('/policy', express.json(), async (req, res) => {
  try {
    const p = await _principal(req);
    const { doc, principal } = req.body || {};
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
      return res.status(400).json({ error: 'doc.rules must be an array' });
    }
    for (const rule of doc.rules) {
      if (!rule.when || !['allow', 'ask', 'deny'].includes(rule.verdict)) {
        return res.status(400).json({ error: 'each rule needs {when:{…}, verdict:allow|ask|deny}' });
      }
    }
    const admin = await _isAdmin(req);
    const target = (principal && principal !== 'global') ? principal : (principal === 'global' ? 'global' : p.id);
    if (target === 'global' && !admin) return res.status(403).json({ error: 'global policy needs admin' });
    if (target !== 'global' && target !== p.id && !admin) return res.status(403).json({ error: 'not your principal' });
    const r = await require('../server').pool.query(
      `INSERT INTO hivv_policies (principal, scope, doc, priority, created_by)
       VALUES ($1, 'policy', $2::jsonb, 50, $3)
       ON CONFLICT (principal, scope) WHERE active = TRUE
       DO UPDATE SET doc = EXCLUDED.doc, updated_at = NOW()
       RETURNING id, principal, doc, updated_at`,
      [target, JSON.stringify(doc), p.id]);
    res.json({ ok: true, policy: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
