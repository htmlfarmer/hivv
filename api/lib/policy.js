// api/lib/policy.js — §3 of HIVV_CAPABILITY_POLICY_PLAN.md.
// YES / MAYBE / NO gate: every action that touches something (tools, money,
// other people's data, doors) is evaluated here BEFORE execution.
//   allow → execute · ask → pending grant + human decides · deny → refused
// Policies are DATA (hivv_policies.doc JSONB rules), the evaluator is tiny.
// Every non-trivial decision lands in an append-only hash-chained ledger.

const crypto = require('crypto');

let pool = null;
let policyCache = { docs: [], at: 0 };
const POLICY_TTL_MS = 30000;
let chainLock = Promise.resolve();
let counters = { allow: 0, ask: 0, deny: 0, fast_allow: 0 };

// MAYBE delivery (backlog F2): when a grant is minted we PUSH it to node-owner
// inboxes (via the notifier wired in server.js) so approval is one tap on any
// device, not just a poll. The notifier prefers the requesting node and falls
// back to a broadcast. Notifier errors must never block the gate.
let notifier = null;
function setNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }
function _notify(grant, action) {
  if (!notifier) return;
  try { Promise.resolve(notifier(grant, action)).catch(() => {}); } catch (_e) {}
}

const TIER_RISK = { read: 0, compute: 1, 'side-effect': 3, data: 4, money: 5, physical: 5, control: 2 };
const ASK_THRESHOLD = 3;           // risk at/above this refuses without a grant (v1: used via registry defaults)
const GENESIS = 'HIVV-GENESIS-0';

function init(pgPool) {
  // LOCAL/OFFLINE MODE: the audit ledger is persisted in Postgres. Without it
  // the policy gate still works (it fails open for chat), but there is no
  // durable audit chain to sweep or snapshot.
  if (!pgPool) {
    pool = null;
    console.warn('[POLICY] no database — audit chain disabled (local/offline mode)');
    return;
  }
  pool = pgPool;
  startAuditSweep(24);
}

// canonical JSON: jsonb reorders keys AND drops undefined values, so both
// write & verify must use a stable form (skip undefined, sorted keys).
function _canon(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canon).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + _canon(v[k])).join(',') + '}';
}

function _hash(prev, row) {
  return crypto.createHash('sha256')
    .update(`${prev}|${row.actor}|${_canon(row.action)}|${row.verdict}|${row.rule}|${row.risk}`)
    .digest('hex');
}

// ---- audit ledger (hash-chained, serialized through one promise chain) ----
async function audit({ actor, action, verdict, rule, risk = 0, receipt = null, grantId = null }) {
  // No database (local/offline install): keep the in-memory counters honest
  // but skip the durable chain — there is nowhere to write it.
  if (!pool) {
    counters[verdict] = (counters[verdict] || 0) + 1;
    return null;
  }
  const job = async () => {
    try {
      const last = await pool.query('SELECT hash FROM hivv_audit ORDER BY id DESC LIMIT 1');
      const prev = last.rows[0]?.hash || GENESIS;
      const row = { actor: actor || 'anon', action, verdict, rule, risk };
      const hash = _hash(prev, row);
      await pool.query(
        `INSERT INTO hivv_audit (actor, action, verdict, rule, risk, receipt, grant_id, prev_hash, hash)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)`,
        [row.actor, JSON.stringify(action), verdict, rule, risk, receipt, grantId, prev, hash]);
      counters[verdict] = (counters[verdict] || 0) + 1;
      return hash;
    } catch (e) {
      console.warn('[POLICY] audit write failed:', e.message);
      return null;
    }
  };
  chainLock = chainLock.then(job, job);
  return chainLock;
}

async function recentAudit({ limit = 50, verdict = null, actor = null } = {}) {
  const where = [];
  const params = [];
  if (verdict) { params.push(verdict); where.push(`verdict = $${params.length}`); }
  if (actor) { params.push(actor); where.push(`actor = $${params.length}`); }
  params.push(Math.min(parseInt(limit) || 50, 500));
  const r = await pool.query(
    `SELECT id, ts, actor, action, verdict, rule, risk, receipt, grant_id, prev_hash, hash
       FROM hivv_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function verifyChain() {
  const r = await pool.query('SELECT id, actor, action, verdict, rule, risk, prev_hash, hash FROM hivv_audit ORDER BY id ASC');
  let prev = GENESIS;
  for (const row of r.rows) {
    const expect = _hash(prev, { actor: row.actor, action: row.action, verdict: row.verdict, rule: row.rule, risk: row.risk });
    if (row.prev_hash !== prev || row.hash !== expect) {
      return { ok: false, broken_at: Number(row.id), rows_checked: r.rows.length,
               reason: row.prev_hash !== prev ? 'prev_hash mismatch (rows removed/reordered)' : 'hash mismatch (row edited)' };
    }
    prev = row.hash;
  }
  return { ok: true, rows_checked: r.rows.length, head: prev.slice(0, 16), last_id: r.rows.length ? Number(r.rows[r.rows.length - 1].id) : 0 };
}

// ---- policy docs (rules as data) ----
async function loadPolicies(principal) {
  if (Date.now() - policyCache.at > POLICY_TTL_MS || !policyCache.docs.length) {
    const r = await pool.query(
      'SELECT id, principal, doc, priority FROM hivv_policies WHERE active = TRUE ORDER BY priority ASC, id ASC');
    policyCache = { docs: r.rows, at: Date.now() };
  }
  const mine = policyCache.docs.filter(d => d.principal === 'global' || (principal && d.principal === principal));
  // principal-specific beats global
  return principal
    ? [...mine.filter(d => d.principal === principal), ...mine.filter(d => d.principal === 'global')]
    : mine;
}

function _ruleMatches(when, action) {
  if (!when || typeof when !== 'object') return false;
  if (when.capability && when.capability !== action.capability) return false;
  if (when.capability_prefix && !String(action.capability || '').startsWith(when.capability_prefix)) return false;
  if (when.tier && when.tier !== action.tier) return false;
  if (when.transport && when.transport !== action.transport) return false;
  if (when.provider && when.provider !== action.provider) return false;
  return Boolean(when.capability || when.capability_prefix || when.tier || when.transport || when.provider);
}

// ---- grants (the MAYBE survivors) ----
function _grantId() {
  return 'G_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

async function requestGrant({ principal, capability, argsSummary = {}, reason = null, via = null, ttlS = null, node = null }) {
  const id = _grantId();
  const r = await pool.query(
    `INSERT INTO hivv_grants (id, principal, capability, args_summary, reason, requested_via)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
    [id, principal || 'anon', capability, JSON.stringify(argsSummary), reason, via]);
  console.log(`[POLICY] MAYBE → grant ${id} asked (${capability} for ${principal || 'anon'})`);
  // F2: PUSH the approval request into the operator's node inbox so `hivv up`
  // nudges in real time (not just hub polling). The notifier prefers the
  // requesting node (action.node) and falls back to a broadcast. Best-effort:
  // a push failure NEVER blocks grant creation or the gate.
  _notify(r.rows[0], { args_summary: argsSummary, node: node || null, via: via || null });
  return r.rows[0];
}

async function decideGrant(id, verdict, decidedBy, { scope = 'once', ttlS = 60 * 60 * 24 * 30, memo = null } = {}) {
  if (!['approved', 'denied'].includes(verdict)) return null;
  const expires = verdict === 'approved' && scope === 'standing'
    ? new Date(Date.now() + Math.min(Math.max(parseInt(ttlS) || 0, 60), 60 * 60 * 24 * 365) * 1000)
    : (verdict === 'approved' ? new Date(Date.now() + 24 * 3600 * 1000) : null);
  const r = await pool.query(
    `UPDATE hivv_grants SET status = $2, decided_by = $3, decided_at = NOW(), memo = $4, expires_at = $5, scope = $6
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, verdict, decidedBy || 'admin', memo, expires, scope]);
  if (r.rows[0]) {
    await audit({ actor: decidedBy || 'admin', action: { capability: r.rows[0].capability, grant: id, kind: 'decide', verdict },
      verdict: verdict === 'approved' ? 'allow' : 'deny', rule: 'human-decision', risk: 0, grantId: id });
  }
  return r.rows[0] || null;
}

async function _consumeGrant(principal, capability) {
  // standing approved grant → allow until expiry; once grant → atomically claim
  const standing = await pool.query(
    `SELECT * FROM hivv_grants
      WHERE principal = $1 AND capability = $2 AND status = 'approved' AND scope = 'standing'
        AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1`, [principal, capability]);
  if (standing.rows[0]) return standing.rows[0];  const once = await pool.query(
    `UPDATE hivv_grants SET status = 'used', decided_at = COALESCE(decided_at, NOW())
      WHERE id = (SELECT id FROM hivv_grants
                   WHERE principal = $1 AND capability = $2 AND status = 'approved' AND scope = 'once'
                     AND (expires_at IS NULL OR expires_at > NOW())
                   ORDER BY decided_at DESC NULLS LAST LIMIT 1)
      RETURNING *`, [principal || 'anon', capability]);
  return once.rows[0] || null;
}

async function getGrant(id) {
  const r = await pool.query('SELECT * FROM hivv_grants WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function listGrants({ status = null, principal = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (principal) { params.push(principal); where.push(`principal = $${params.length}`); }
  params.push(Math.min(parseInt(limit) || 50, 200));
  const r = await pool.query(
    `SELECT * FROM hivv_grants ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function expireOldGrants() {
  await pool.query(
    `UPDATE hivv_grants SET status = 'expired'
      WHERE status IN ('pending','approved') AND created_at < NOW() - interval '7 days'`);
}

// ---- THE GATE -----------------------------------------------------------
// action: { capability, principal, transport?, provider?, args_summary?,
//           reason?, via?, data_class?, mode? }
// returns { verdict: 'allow'|'ask'|'deny', rule, risk, grant_id?, tier, memo? }

// F1: delegation chain — resolve `agent` → `parent` up the chain.
// Returns { root, depth, path } where path = [root, ..., immediate].
async function _resolveDelegationChain(principal) {
  const MAX_DEPTH = (parseInt(process.env.HIVV_DELEGATION_MAX_DEPTH) || 2) + 1;
  const visited = new Set();
  const path = [];
  let current = principal;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!current || visited.has(current)) break;
    visited.add(current);
    path.push(current);
    try {
      const r = await pool.query(
        `SELECT parent, capability, limits, revoked_at FROM hivv_delegations
         WHERE agent = $1 AND revoked_at IS NULL AND created_at < NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [current]);
      if (!r.rows[0]) break;
      const { parent, capability, limits } = r.rows[0];
      // If the delegation has a capability restriction, check it later via the gate's key
      if (capability && limits && limits.max_depth !== undefined) {
        // delegation limits apply to how deep we can go
        if (depth + 1 > limits.max_depth) break;
      }
      current = parent;
    } catch { break; }
  }
  const root = path[path.length - 1] || principal;
  return { root, depth: path.length - 1, path: path.reverse() };
}

async function gate(action, { dryRun = false } = {}) {
  const caps = require('./capabilities');
  await caps.loadRegistry();
  // LOCAL/OFFLINE MODE: no registry, no grants, no durable audit — the local
  // instance is a single-user gateway, so the default posture is ALLOW for
  // local compute and the caller still gets a receipt.
  if (!pool) {
    return {
      verdict: 'allow',
      rule: 'local:offline',
      risk: 0,
      tier: 'compute',
      key: action.capability || 'reasoning',
      offline: true,
    };
  }
  // Fail-open guard: if the registry didn't load (DB blip) never block the hive —
  // chat keeps flowing; policy comes back online with the registry.
  if (!caps.registryValues().length) {
    return { verdict: 'allow', rule: 'failopen:registry', risk: 0, tier: 'compute', key: action.capability || 'reasoning' };
  }

  // F1: resolve delegation chain — the gate evaluates policy against the root principal,
  // but we keep the immediate actor for audit. Delegation is agent→parent (node acts for user).
  const delegation = await _resolveDelegationChain(action.principal || 'anon');
  const effectivePrincipal = delegation.root;
  const actorChain = delegation.path;

  const cap = caps.resolve(action.capability || 'reasoning');
  const tier = cap ? cap.tier : 'side-effect';
  const key = cap ? cap.key : (action.capability || 'reasoning');
  const risk = (TIER_RISK[tier] ?? 3) + (action.data_class === 'secret' ? 2 : 0)
             + (action.transport === 'cloud' && tier === 'data' ? 1 : 0);

  // 1) explicit policy rules (principal docs then global), first match wins
  const docs = await loadPolicies(effectivePrincipal);
  let verdict = null, rule = null, memo = null;
  for (const d of docs) {
    for (const r0 of ((d.doc && Array.isArray(d.doc.rules)) ? d.doc.rules : [])) {
      if (_ruleMatches(r0.when, { ...action, tier })) {
        verdict = r0.verdict; rule = `policy:${d.principal}#${d.id}`; memo = r0.memo || null;
        break;
      }
    }
    if (verdict) break;
  }
  // 2) registry default
  if (!verdict) {
    verdict = cap ? cap.default_verdict : 'ask';
    rule = cap ? `default:${tier}` : 'default:unknown';
  }
  // 3) MAYBE → is there a survivor grant?
  if (verdict === 'ask' && dryRun) {
    // peek without consuming: a live standing grant means "you already said yes"
    try {
      const s = await pool.query(
        `SELECT id FROM hivv_grants
          WHERE principal = $1 AND capability = $2 AND status = 'approved'
            AND scope = 'standing' AND expires_at > NOW() LIMIT 1`, [effectivePrincipal, key]);
      if (s.rows[0]) { verdict = 'allow'; rule = `grant:${s.rows[0].id}`; }
    } catch (_e) {}
  }
  if (verdict === 'ask' && !dryRun) {
    const grant = await _consumeGrant(effectivePrincipal, key);
    if (grant) {
      verdict = 'allow';
      rule = `grant:${grant.id}`;
      if (!dryRun) await audit({ actor: action.principal, action: { ..._brief(action), kind: 'grant_used', delegation_chain: actorChain.length > 1 ? actorChain : undefined }, verdict: 'allow', rule, risk, grantId: grant.id });
      return { verdict: 'allow', rule, risk, tier, key, grant_id: grant.id, delegation_chain: actorChain.length > 1 ? actorChain : undefined };
    }
    const g = await requestGrant({ principal: effectivePrincipal, capability: key, argsSummary: _brief(action).args || {}, reason: action.reason, via: action.via, node: action.node || null });
    if (!dryRun) await audit({ actor: action.principal, action: { ..._brief(action), kind: 'ask', delegation_chain: actorChain.length > 1 ? actorChain : undefined }, verdict: 'ask', rule, risk, grantId: g.id });
    return { verdict: 'ask', rule, risk, tier, key, grant_id: g.id, delegation_chain: actorChain.length > 1 ? actorChain : undefined, memo: 'human approval required — run: hivv approve ' + g.id };
  }
  // 4) deny + plain allow: audit anything above compute tier (chat stays silent & instant)
  if (!dryRun && (verdict === 'deny' || risk >= 2)) {
    await audit({ actor: action.principal, action: { ..._brief(action), kind: verdict, delegation_chain: actorChain.length > 1 ? actorChain : undefined }, verdict, rule, risk });
  }
  if (verdict === 'allow') counters.fast_allow++;
  return { verdict, rule, risk, tier, key, memo, delegation_chain: actorChain.length > 1 ? actorChain : undefined };
}

function _brief(action) {
  const a = action || {};
  return {
    capability: a.capability || null,
    transport: a.transport || null,
    provider: a.provider || null,
    mode: a.mode || null,
    data_class: a.data_class || null,
    args: typeof a.args_summary === 'object' && a.args_summary ? _scrubObj(a.args_summary) : null,
  };
}
function _scrubObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 8)) {
    if (v === undefined) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s && s.length > 120 ? s.slice(0, 117) + '...' : s;
  }
  return out;
}

async function defaults() {
  const caps = require('./capabilities');
  await caps.loadRegistry();
  return [...caps.registryValues()].map(c => ({
    key: c.key, label: c.label, tier: c.tier, default_verdict: c.default_verdict,
    requires_consent: c.requires_consent, risk: TIER_RISK[c.tier] ?? 3,
  }));
}

function stats() {
  return { ...counters, pending: null };
}

async function pendingCount() {
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM hivv_grants WHERE status = 'pending'`);
    return r.rows[0].n;
  } catch { return -1; }
}

// ---- F5: audit chain pruning with signed monthly snapshots ---------------

let _signingKey = null;
let _auditSweepTimer = null;

function _getSigningKey() {
  if (_signingKey) return _signingKey;
  _signingKey = process.env.HIVV_AUDIT_SIGNING_KEY || null;
  if (!_signingKey) {
    _signingKey = crypto.randomBytes(32).toString('hex');
    console.warn('[POLICY] HIVV_AUDIT_SIGNING_KEY not set — generated ephemeral key. Set it for persistent signatures.');
  }
  return _signingKey;
}

function _signSnapshot(payload) {
  const key = _getSigningKey();
  const data = `${payload.year}-${payload.month}-${payload.row_count}-${payload.head_hash}`;
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

async function _takeMonthlySnapshot() {
  // Snapshot the last completed month (not the current one)
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed; 0=Jan
  // Previous month
  const pYear = month === 0 ? year - 1 : year;
  const pMonth = month === 0 ? 12 : month;

  try {
    // Check if snapshot already exists for this month
    const existing = await pool.query(
      'SELECT id FROM hivv_audit_snapshots WHERE year = $1 AND month = $2', [pYear, pMonth]);
    if (existing.rows[0]) return { skipped: true, year: pYear, month: pMonth };

    // Get stats for the previous month
    const range = await pool.query(`
      SELECT COUNT(*)::bigint AS cnt, MIN(id) AS first_id, MAX(id) AS last_id, MAX(hash) AS head_hash
      FROM hivv_audit
      WHERE EXTRACT(YEAR FROM ts) = $1 AND EXTRACT(MONTH FROM ts) = $2`,
      [pYear, pMonth]);
    const { cnt, first_id, last_id, head_hash } = range.rows[0];
    if (!cnt || cnt === '0') return { skipped: true, year: pYear, month: pMonth, reason: 'no rows' };

    const payload = { year: pYear, month: pMonth, row_count: parseInt(cnt), head_hash };
    const signature = _signSnapshot(payload);
    await pool.query(
      `INSERT INTO hivv_audit_snapshots (year, month, row_count, first_id, last_id, head_hash, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (year, month) DO NOTHING`,
      [pYear, pMonth, parseInt(cnt), parseInt(first_id), parseInt(last_id), head_hash, signature]);
    console.log(`[POLICY] audit snapshot taken: ${pYear}-${String(pMonth).padStart(2,'0')} count=${cnt} hash=${head_hash.slice(0,8)}`);
    return { ok: true, year: pYear, month: pMonth, row_count: parseInt(cnt), head_hash, signature };
  } catch (e) {
    console.warn('[POLICY] _takeMonthlySnapshot failed:', e.message);
    return { error: e.message };
  }
}

async function _pruneAuditChain(retentionMonths = 3) {
  // Keep at least `retentionMonths` full months; don't touch the current month.
  // Rows older than the oldest kept snapshot are deleted (snapshot row itself is kept).
  try {
    const oldest = await pool.query(`
      SELECT year, month FROM hivv_audit_snapshots
      ORDER BY year ASC, month ASC LIMIT 1`);
    let cutoffId = null;
    if (oldest.rows[0]) {
      // Get the first_id of the oldest snapshot's month — delete rows before it
      const snapRows = await pool.query(
        'SELECT first_id FROM hivv_audit_snapshots WHERE year = $1 AND month = $2',
        [oldest.rows[0].year, oldest.rows[0].month]);
      cutoffId = snapRows.rows[0]?.first_id;
    } else {
      // No snapshots yet — prune rows older than `retentionMonths` months ago
      const r = await pool.query(`
        SELECT MIN(id) AS cutoff FROM hivv_audit
        WHERE ts < DATE_TRUNC('month', NOW()) - (INTERVAL '1 month' * $1)`,
        [retentionMonths]);
      cutoffId = r.rows[0]?.cutoff;
    }
    if (!cutoffId) return { pruned: 0, reason: 'nothing to prune' };

    const del = await pool.query('DELETE FROM hivv_audit WHERE id < $1 RETURNING id', [cutoffId]);
    const n = del.rowCount;
    if (n > 0) console.log(`[POLICY] audit pruned ${n} rows (id < ${cutoffId})`);
    return { pruned: n, cutoff_id: cutoffId };
  } catch (e) {
    console.warn('[POLICY] _pruneAuditChain failed:', e.message);
    return { error: e.message };
  }
}

function startAuditSweep(intervalHours = 24) {
  if (_auditSweepTimer) clearInterval(_auditSweepTimer);
  // Run immediately on start, then every intervalHours
  _doAuditSweep().catch(e => console.warn('[POLICY] audit sweep error:', e.message));
  _auditSweepTimer = setInterval(() => {
    _doAuditSweep().catch(e => console.warn('[POLICY] audit sweep error:', e.message));
  }, intervalHours * 3600 * 1000).unref();
  console.log(`[POLICY] audit sweep started (every ${intervalHours}h)`);
}

async function _doAuditSweep() {
  const snap = await _takeMonthlySnapshot();
  const prune = await _pruneAuditChain(3);
  return { snapshot: snap, prune };
}

async function listSnapshots() {
  try {
    const r = await pool.query(
      'SELECT year, month, row_count, first_id, last_id, head_hash, signature, created_at FROM hivv_audit_snapshots ORDER BY year ASC, month ASC');
    return r.rows;
  } catch (e) { return []; }
}

// F1: delegation CRUD
async function listDelegations({ agent = null, principal = null, isAdmin = false } = {}) {
  try {
    let query, params;
    if (isAdmin && agent) {
      query = 'SELECT * FROM hivv_delegations WHERE agent = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50';
      params = [agent];
    } else if (isAdmin) {
      query = 'SELECT * FROM hivv_delegations WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 100';
      params = [];
    } else if (principal) {
      query = 'SELECT * FROM hivv_delegations WHERE (parent = $1 OR agent = $1) AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50';
      params = [principal];
    } else {
      return [];
    }
    const r = await pool.query(query, params);
    return r.rows;
  } catch (e) { return []; }
}

async function createDelegation({ parent, agent, capability = null, maxDepth = 2 }) {
  try {
    const limits = {};
    if (maxDepth !== undefined) {
      limits.max_depth = Math.min(Math.max(parseInt(maxDepth) || 2, 1), 5);
    }
    const r = await pool.query(
      `INSERT INTO hivv_delegations (parent, agent, capability, limits, created_by)
       VALUES ($1, $2, $3, $4, $1)
       RETURNING id, parent, agent, capability, limits, created_at`,
      [parent, agent, capability || null, Object.keys(limits).length ? JSON.stringify(limits) : null]);
    return r.rows[0];
  } catch (e) { return null; }
}

async function revokeDelegation({ id, principal, isAdmin = false }) {
  try {
    const r = await pool.query(
      `UPDATE hivv_delegations SET revoked_at = NOW()
       WHERE id = $1 AND revoked_at IS NULL AND (parent = $2 OR $3 = true)
       RETURNING id`,
      [id, principal, isAdmin]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

module.exports = {
  init, setNotifier, audit, recentAudit, verifyChain, gate,
  requestGrant, decideGrant, getGrant, listGrants, expireOldGrants,
  defaults, stats, pendingCount, startAuditSweep, listSnapshots,
  listDelegations, createDelegation, revokeDelegation,
  TIER_RISK, _hash, GENESIS
};
