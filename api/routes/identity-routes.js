// api/routes/identity-routes.js — public read + verify surface for the
// Ed25519 bee identity store (lib/identity.js).
//
// Public keys are PUBLIC: these endpoints never expose private material,
// node secrets, or hw_ids (the store holds only what a bee published).
//
//   GET  /api/identity            — every binding (roster of principals)
//   GET  /api/identity/:nodeId    — one binding, incl. key + rotation history
//   POST /api/identity/verify     — pure-crypto check of a statement+signature
//                                   against a presented public key (no side
//                                   effects — safe for third parties)

const express = require('express');
const crypto = require('crypto');
const identity = require('../lib/identity');
const trust = require('../lib/trust');

const router = express.Router();

// Injected from server.js: the orchestrator (in-memory node records for the
// reliability dimension) and the pool (optional — hivv_trust_scores upsert,
// local-first: absent pool just skips persistence).
let _orch = null;
let _pool = null;
function inject(orch, pool) {
  _orch = orch;
  _pool = pool || null;
}

// Admin anchor — the SAME semantics requireControlAuth uses: loopback or
// the control token (timing-safe). Only admin revocations need it; a
// SELF-revocation is proven by the signature instead.
function isAdminRequest(req) {
  const tok = req.headers['x-control-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (process.env.HIVV_CONTROL_TOKEN && tok) {
    const a = Buffer.from(String(tok));
    const b = Buffer.from(process.env.HIVV_CONTROL_TOKEN);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '')
    .replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

router.get('/', (req, res) => {
  const identities = identity.listIdentities();
  res.json({
    count: identities.length,
    algorithm: identity.ALGORITHM,
    freshness_s: identity.FRESHNESS_S,
    identities,
  });
});

// Standalone verification — MUST be registered before /:nodeId would shadow
// a literal path segment (it is POST, so no GET conflict, but keep order
// explicit for future GET additions).
router.post('/verify', (req, res) => {
  const body = req.body || {};
  const out = identity.verifyStandalone({
    statement: body.statement,
    signature: body.signature,
    public_key: body.public_key,
    principal: body.principal,
  });
  res.status(out.ok ? 200 : 400).json(out);
});

// Rotation: the CURRENT bound key signs a statement naming its successor.
// No legacy proof needed — holding the current key IS the proof. (A bee
// that LOST its key uses the legacy-proof path at register instead.)
router.post('/rotate', (req, res) => {
  const body = req.body || {};
  const nodeId = String(body.node_id || '').toLowerCase();
  if (!nodeId) return res.status(400).json({ error: 'node_id required' });
  const out = identity.verifyRotation({ nodeId, rotation: body.rotation });
  if (!out.ok) {
    return res.status(400).json({
      error: 'rotation refused',
      code: 'IDENTITY_ROTATE_INVALID',
      problems: out.problems,
      hint: out.problems.some((p) => p.includes('CURRENT bound key'))
        ? 'the statement must be signed by the key the hub currently holds for this node'
        : 'rotations must be fresh (±300s) and signed by the current key — or use the legacy-proof rebind (hivv identity keygen)',
    });
  }
  res.json({ ok: true, node_id: nodeId, principal: out.principal, action: out.action });
});

// Execution receipts (Phase 3): the bee's signed testimony that it ran
// something. Verified against the BOUND key, kept as a bounded ring.
router.post('/receipts', (req, res) => {
  const body = req.body || {};
  const nodeId = String(body.node_id || '').toLowerCase();
  if (!nodeId) return res.status(400).json({ error: 'node_id required' });
  const out = identity.verifyReceipt({ nodeId, receipt: body.receipt });
  if (!out.ok) {
    return res.status(400).json({
      error: 'receipt refused',
      code: 'IDENTITY_RECEIPT_INVALID',
      problems: out.problems,
    });
  }
  res.json({ ok: true, node_id: nodeId, receipt: out.receipt });
});

// NOTE: /receipts/:nodeId is a GET under the same literal-prefix family as
// /:nodeId — registered BEFORE the parameterized route so 'receipts' is
// never captured as a node id.
router.get('/receipts/:nodeId', (req, res) => {
  const nodeId = String(req.params.nodeId).toLowerCase();
  const limit = Math.max(1, Math.min(64, parseInt(req.query.limit, 10) || 32));
  const receipts = identity.listReceipts(nodeId, limit);
  res.json({ node_id: nodeId, count: receipts.length, receipts });
});

// Revocation (Phase 4) — two doors:
//   {node_id, revocation} → SELF-revocation, proven by the bound key's signature
//   {principal, reason}   → operator revocation, proven by admin authority
router.post('/revoke', (req, res) => {
  const body = req.body || {};
  if (body.revocation) {
    const nodeId = String(body.node_id || '').toLowerCase();
    if (!nodeId) return res.status(400).json({ error: 'node_id required' });
    const out = identity.verifySelfRevocation({ nodeId, revocation: body.revocation });
    if (!out.ok) {
      return res.status(400).json({
        error: 'revocation refused', code: 'IDENTITY_REVOKE_INVALID',
        problems: out.problems,
      });
    }
    return res.json({ ok: true, principal: out.principal, by: 'self', reason: out.reason });
  }
  if (body.principal) {
    if (!isAdminRequest(req)) {
      return res.status(403).json({
        error: 'operator revocation requires admin (localhost or control token)',
        code: 'CONTROL_AUTH_REQUIRED',
      });
    }
    const out = identity.revokeByOperator({
      nodeId: String(body.node_id || '').toLowerCase() || null,
      principal: String(body.principal),
      reason: body.reason,
    });
    if (!out.ok) {
      return res.status(400).json({ error: 'revocation refused', problems: out.problems });
    }
    return res.json({ ok: true, principal: out.principal, by: 'operator' });
  }
  res.status(400).json({ error: 'provide {node_id, revocation} (self) or {principal, reason} (admin)' });
});

// The hub's own public key — verify any X-Hivv-Receipt header against this.
router.get('/hub-key', (req, res) => {
  const info = identity.hubKeyInfo();
  if (!info) return res.status(503).json({ error: 'hub signing key unavailable' });
  res.json(info);
});

// The public CRL — anyone may read who has been revoked and why.
router.get('/revocations', (req, res) => {
  const revocations = identity.listRevocations();
  res.json({ count: revocations.length, revocations });
});

// Endorsements (Phase 4): an operator's signed "node X is mine, role R".
router.post('/endorse', (req, res) => {
  const body = req.body || {};
  const out = identity.verifyEndorsement({ endorsement: body.endorsement });
  if (!out.ok) {
    return res.status(400).json({
      error: 'endorsement refused', code: 'IDENTITY_ENDORSE_INVALID',
      problems: out.problems,
    });
  }
  res.json({ ok: true, action: out.action, endorsement: out.entry });
});

router.get('/endorsements', (req, res) => {
  const nodeId = req.query.node_id ? String(req.query.node_id).toLowerCase() : null;
  const endorsements = identity.listEndorsements(nodeId);
  res.json({ count: endorsements.length, endorsements });
});

// MEASURED trust (Phase 5): the blended score the router uses, with every
// dimension and its evidence exposed — null dimensions mean NO DATA, never
// zero. Reading it also remembers it (hivv_trust_scores upsert, DB optional).
router.get('/trust/:nodeId', async (req, res) => {
  const nodeId = String(req.params.nodeId).toLowerCase();
  const node = _orch && _orch.nodes.get(nodeId);
  let honeyRank = null;
  if (_pool) {
    try {
      const r = await _pool.query('SELECT bee_rank FROM hivv_node_stats WHERE node_id = $1', [nodeId]);
      honeyRank = r.rows[0] ? r.rows[0].bee_rank : null;
    } catch (_e) { /* local-first: no DB → no history dimension */ }
  }
  const result = trust.computeTrust(node || null, { honeyRank });
  if (_pool) trust.persist(_pool, nodeId, result).catch(() => {});
  res.json({
    node_id: nodeId,
    score: result.score,            // 0..6 (the router's trustFactor scale)
    overall: result.overall,        // 0..100, null = no data at all
    dimensions: result.dimensions,  // each 0..100 or null (null = unknown)
    evidence: result.evidence,
    honey_rank: honeyRank,
    known: Object.values(result.dimensions).some((v) => v != null),
  });
});

router.get('/:nodeId', (req, res) => {
  const rec = identity.getRecord(String(req.params.nodeId).toLowerCase());
  if (!rec) {
    return res.status(404).json({
      error: 'no identity bound to this node',
      node_id: req.params.nodeId,
      status: 'unbound',
      hint: 'a bee binds its key on its first identity-bearing register/heartbeat',
    });
  }
  res.json({
    node_id: rec.node_id,
    principal: rec.principal,
    algorithm: rec.algorithm || identity.ALGORITHM,
    public_key: rec.public_key,
    status: rec.status || 'active',
    bound_at: rec.bound_at || null,
    bound_via: rec.bound_via || null,
    last_ok_at: rec.last_ok_at || null,
    last_ok_kind: rec.last_ok_kind || null,
    last_fail: rec.last_fail || null,
    // last SIGNED capability advertisement (tools/models the bee vouched
    // for with its key) + the seq that makes replay detectable
    manifest: rec.manifest || null,
    cap_seq: Number.isSafeInteger(rec.cap_seq) ? rec.cap_seq : null,
    revoked: identity.listRevocations().some((r) => r.principal === rec.principal) || undefined,
    endorsements: identity.listEndorsements(String(req.params.nodeId).toLowerCase()),
    history: Array.isArray(rec.history) ? rec.history : [],
  });
});

router.inject = inject;   // server.js passes the orchestrator + optional pool

module.exports = router;
