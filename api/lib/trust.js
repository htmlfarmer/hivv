// api/lib/trust.js — MEASURED trust for a bee (Phase 5 of the identity layer).
//
// The routing `trust` factor used to be honey rank alone (an unranked bee
// scored 0 — a brand-new but honest bee was indistinguishable from a
// dishonest one). This computes a blended score from evidence we actually
// hold, per dimension, with the house rule: NO DATA IS null, NEVER 0 —
// "unknown" and "measured zero" are different truths.
//
// Dimensions (each 0..100 or null = no data):
//   identity     — the Ed25519 binding: unbound → null (unproven, not bad),
//                  revoked → 0, bound → recency of verification + a signed
//                  capability manifest + no recent failures.
//   reliability  — quarantine → 0, active flaps → low, fresh heartbeats →
//                  high, stale → scaled down. (In-memory node record —
//                  always available, local-first.)
//   history      — honey rank (needs the DB; null without one).
//   receipts     — the signed execution-receipt ring: all-ok → high,
//                  failures → scaled; no receipts → null.
//
// overall = mean of the KNOWN dimensions. score (0..6) is what the router's
// trustFactor already normalizes (/6) — so a fully-unknown bee falls back to
// the legacy behaviour (honey rank, else 0) instead of being reweighted.

const identity = require('./identity');

const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;
const VERIFY_FRESH_S = 5 * 60;

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mean(values) {
  const known = values.filter((v) => v != null && Number.isFinite(v));
  if (!known.length) return null;
  return known.reduce((s, v) => s + v, 0) / known.length;
}

// ── identity dimension ──────────────────────────────────────────────────────
function identityDimension(nodeId, nowS = Math.floor(Date.now() / 1000)) {
  const rec = identity.getRecord(nodeId);
  if (!rec) return { value: null, evidence: { bound: false } };

  const revocations = identity.listRevocations();
  if (revocations.some((r) => r.principal === rec.principal)) {
    return { value: 0, evidence: { bound: true, revoked: true } };
  }

  let v = 60;                                   // bound at all
  const evidence = { bound: true, bound_via: rec.bound_via || null };
  if (rec.last_ok_at && nowS - rec.last_ok_at <= VERIFY_FRESH_S) {
    v += 20;                                    // fresh successful verification
    evidence.last_ok_age_s = nowS - rec.last_ok_at;
  }
  if (rec.manifest) { v += 15; evidence.signed_manifest_seq = rec.manifest.seq; }
  const receipts = Array.isArray(rec.receipts) ? rec.receipts : [];
  if (receipts.length) { v += 5; evidence.receipts = receipts.length; }
  if (rec.last_fail && nowS - rec.last_fail.at <= VERIFY_FRESH_S) v -= 30;
  return { value: Math.max(0, Math.min(100, v)), evidence };
}

// ── reliability dimension (in-memory node record) ───────────────────────────
function reliabilityDimension(node, now = Date.now()) {
  if (!node) return { value: null, evidence: {} };
  const evidence = {};
  if (node.quarantined) {
    evidence.quarantined = node.quarantined.by || true;
    return { value: 0, evidence };
  }
  const hb = node.last_heartbeat || 0;
  if (!hb) return { value: null, evidence: { heartbeats: 0 } };
  const ageMs = now - hb;
  evidence.heartbeat_age_s = Math.round(ageMs / 1000);
  let v;
  if (ageMs <= HEARTBEAT_FRESH_MS) v = 70;
  else if (ageMs <= 15 * 60 * 1000) v = 45;
  else if (ageMs <= 60 * 60 * 1000) v = 20;
  else v = 5;
  if (Array.isArray(node.flap_events) && node.flap_events.length) {
    v -= Math.min(40, node.flap_events.length * 10);
    evidence.flap_events = node.flap_events.length;
  }
  if (node.status === 'online') v += 10;
  return { value: Math.max(0, Math.min(100, v)), evidence };
}

// ── receipts dimension (signed outcomes) ────────────────────────────────────
function receiptsDimension(nodeId) {
  const rec = identity.getRecord(nodeId);
  const receipts = rec && Array.isArray(rec.receipts) ? rec.receipts : [];
  if (!receipts.length) return { value: null, evidence: { receipts: 0 } };
  const ok = receipts.filter((r) => r.result === 'ok').length;
  const ratio = ok / receipts.length;
  return {
    value: Math.round(ratio * 100),
    evidence: { receipts: receipts.length, ok, failed: receipts.length - ok },
  };
}

// ── history dimension (honey rank — DB-backed, caller supplies) ─────────────
function historyDimension(beeRank) {
  const RANK_ORDER = { larva: 1, worker: 2, forager: 3, scout: 4, 'royal-jelly': 5, 'queen-bee': 6 };
  if (!beeRank || !RANK_ORDER[beeRank]) return { value: null, evidence: {} };
  return { value: Math.round((RANK_ORDER[beeRank] / 6) * 100), evidence: { bee_rank: beeRank } };
}

/**
 * Compute measured trust for a node.
 * @param {object|null} node in-memory orchestrator record (may be absent)
 * @param {object} [opts]
 * @param {string} [opts.honeyRank] bee_rank from the honey tables (DB mode)
 * @param {number} [opts.now] ms clock
 * @returns {{score: number|null, overall: number|null, dimensions: object, evidence: object}}
 *          score is 0..6 (router trustFactor's scale); null = no data at all.
 */
function computeTrust(node, opts = {}) {
  const now = opts.now || Date.now();
  const nowS = Math.floor(now / 1000);
  const nodeId = node && (node.node_id || node.id);

  const dims = {};
  const evidence = {};
  if (nodeId) {
    const idm = identityDimension(nodeId, nowS);
    dims.identity = idm.value;
    evidence.identity = idm.evidence;
    const rcm = receiptsDimension(nodeId);
    dims.receipts = rcm.value;
    evidence.receipts = rcm.evidence;
  } else {
    dims.identity = null;
    dims.receipts = null;
  }
  const relm = reliabilityDimension(node, now);
  dims.reliability = relm.value;
  evidence.reliability = relm.evidence;
  const hist = historyDimension(opts.honeyRank);
  dims.history = hist.value;
  evidence.history = hist.evidence;

  const overall = mean([dims.identity, dims.reliability, dims.history, dims.receipts]);
  return {
    overall: overall == null ? null : Math.round(overall * 10) / 10,
    score: overall == null ? null : Math.round((overall / 100) * 6 * 100) / 100,
    dimensions: dims,
    evidence,
  };
}

/**
 * The value the router should pass as trustScore: measured trust when we
 * have any, else the legacy honey-rank score (or 0) — so behaviour is
 * strictly additive for bees with no identity data yet.
 */
function routerTrustScore(node, honeyRankScore) {
  const t = computeTrust(node, { honeyRank: undefined });
  if (t.score != null) {
    // blend in the honey rank when present (history dimension needs the
    // rank NAME, not the score — approximate from the 0..6 score directly)
    if (Number.isFinite(honeyRankScore) && honeyRankScore > 0) {
      const honey = clamp01(honeyRankScore / 6);
      const overall = mean([t.dimensions.identity, t.dimensions.reliability,
                            t.dimensions.receipts, honey * 100]);
      if (overall != null) return Math.round((overall / 100) * 6 * 100) / 100;
    }
    return t.score;
  }
  return Number.isFinite(honeyRankScore) ? honeyRankScore : 0;
}

// ── persistence (DB optional) ───────────────────────────────────────────────
// Lights up hivv_trust_scores (migration 003) — read-time upsert: the
// endpoint that SHOWS trust also remembers it. Fire-and-forget: a DB hiccup
// must never fail the read.
async function persist(pool, nodeId, result) {
  if (!pool || !nodeId || !result || result.overall == null) return;
  const dims = result.dimensions;
  const rows = Object.entries(dims).filter(([, v]) => v != null);
  for (const [dimension, score] of rows) {
    try {
      await pool.query(
        `INSERT INTO hivv_trust_scores (agent_id, dimension, score, evidence, weighted_factors)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (agent_id, dimension) DO UPDATE
         SET score = EXCLUDED.score, evidence = EXCLUDED.evidence,
             weighted_factors = EXCLUDED.weighted_factors, updated_at = NOW()`,
        [nodeId, dimension, score,
         JSON.stringify(result.evidence[dimension] || {}),
         JSON.stringify({ source: 'identity-layer', overall: result.overall })]
      );
    } catch (e) {
      console.error('[TRUST] persist failed for ' + nodeId + '/' + dimension + ': ' + e.message);
      return; // one failure means the table likely doesn't exist — stop trying
    }
  }
}

module.exports = {
  computeTrust,
  routerTrustScore,
  identityDimension,
  reliabilityDimension,
  receiptsDimension,
  historyDimension,
  persist,
};
