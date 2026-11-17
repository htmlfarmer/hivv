// api/lib/review-registry.js — private, operator-side record of who reviewed
// what, where the reviewer was, and what it cost.
//
// WHY THIS IS SEPARATE FROM THE SIGNED ATTESTATION
// ───────────────────────────────────────────────────
// The signed envelope is PUBLIC: anyone can fetch and verify it. It therefore
// carries only fields that are safe to publish (verdict, score, explanation,
// source hash, model label, coarse region, timestamps, cost, resources).
//
// This registry keeps the private half — the things that tell an operator who
// they are actually working with:
//   * account identity (username / email / phone) when the reviewer is a person
//   * exact hostnames, public/private IPs
//   * precise coordinates and full traceroute hops
//   * internal cost/margin figures
//
// The two halves are joined by `attestation_id` + `principal_id`, so the public
// record can always be correlated with the private one without exposing it.
//
// PRIVACY RULES ENFORCED HERE
//   * No public endpoint may return this table's rows wholesale.
//   * `privacy_class` decides what a row may ever expose.
//   * Contact fields are redacted unless the row explicitly allows sharing.
//   * The registry NEVER stores raw code, prompts, or model output bodies —
//     only hashes and bounded metadata.

const crypto = require('crypto');

const TABLE = 'hivv_review_registry';

const PRIVACY_CLASSES = ['public', 'network', 'private', 'sealed'];

function nowIso() {
  return new Date().toISOString();
}

function clampText(value, max = 240) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function hash32(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex').slice(0, 32);
}

function normalizePrivacy(input = {}) {
  const cls = PRIVACY_CLASSES.includes(input.privacy_class) ? input.privacy_class : 'private';
  return {
    privacy_class: cls,
    share_contact: cls === 'public' && input.share_contact === true,
    share_exact_location: cls !== 'sealed' && input.share_exact_location === true,
    share_public_ip: cls === 'public' && input.share_public_ip === true,
    share_trace_route: cls === 'public' && input.share_trace_route === true,
    share_hostname: cls === 'public' && input.share_hostname === true,
    share_internal_margin: cls === 'private' || cls === 'sealed' ? input.share_internal_margin === true : false,
  };
}

// ── schema ─────────────────────────────────────────────────────────────────
async function ensureSchema(pool) {
  if (!pool) return false;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                    BIGSERIAL PRIMARY KEY,
      attestation_id        TEXT UNIQUE,
      principal_id          TEXT NOT NULL,
      source_sha256         TEXT NOT NULL,
      reviewer_name         TEXT,
      reviewer_system       TEXT,
      reviewer_model        TEXT,
      reviewer_node_id      TEXT,
      subject_kind          TEXT NOT NULL DEFAULT 'source.review',
      privacy_class         TEXT NOT NULL DEFAULT 'private',
      share_contact         BOOLEAN NOT NULL DEFAULT FALSE,
      share_exact_location  BOOLEAN NOT NULL DEFAULT FALSE,
      share_public_ip       BOOLEAN NOT NULL DEFAULT FALSE,
      share_trace_route     BOOLEAN NOT NULL DEFAULT FALSE,
      share_hostname        BOOLEAN NOT NULL DEFAULT FALSE,
      share_internal_margin BOOLEAN NOT NULL DEFAULT FALSE,
      account_username      TEXT,
      account_email         TEXT,
      account_email_hash    TEXT,
      account_phone         TEXT,
      account_phone_hash    TEXT,
      hostname              TEXT,
      public_ip             TEXT,
      public_ip_hash        TEXT,
      lan_ip                TEXT,
      latitude              DOUBLE PRECISION,
      longitude             DOUBLE PRECISION,
      region                TEXT,
      country_code          TEXT,
      asn                   TEXT,
      isp                   TEXT,
      trace_route           JSONB,
      started_at_ms         BIGINT,
      reviewed_at_ms        BIGINT,
      duration_ms           BIGINT,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cost_usd              NUMERIC(20,10) NOT NULL DEFAULT 0,
      margin_usd            NUMERIC(20,10),
      resource_cost_usd     NUMERIC(20,10) NOT NULL DEFAULT 0,
      cpu_ms                BIGINT NOT NULL DEFAULT 0,
      gpu_ms                BIGINT NOT NULL DEFAULT 0,
      peak_rss_kb           BIGINT NOT NULL DEFAULT 0,
      source_bytes          BIGINT NOT NULL DEFAULT 0,
      source_lines          INTEGER NOT NULL DEFAULT 0,
      risk_score            INTEGER NOT NULL DEFAULT 0,
      risk_level            TEXT,
      verdict               TEXT,
      complexity_score      INTEGER NOT NULL DEFAULT 0,
      complexity_class      TEXT,
      network_class         TEXT,
      metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hivv_review_registry_principal
    ON ${TABLE} (principal_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hivv_review_registry_source
    ON ${TABLE} (source_sha256, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hivv_review_registry_privacy
    ON ${TABLE} (privacy_class, created_at DESC)`);
    return true;
  } catch (err) {
    console.error('[review-registry] schema setup failed:', err.message);
    return false;
  }
}

// ── write path ─────────────────────────────────────────────────────────────
async function recordReview(pool, input = {}) {
  if (!pool) return { ok: false, error: 'no database pool' };
  const privacy = normalizePrivacy(input.privacy || {});
  const provenance = input.provenance || {};
  const cost = provenance.cost || {};
  const resources = provenance.resources || {};
  const worker = provenance.reviewer_node || {};
  const account = input.account || {};
  const loc = input.location || worker.location || {};

  const startedAt = Number.isSafeInteger(provenance.review_started_at_ms) ? provenance.review_started_at_ms : null;
  const reviewedAt = Number.isSafeInteger(provenance.reviewed_at_ms) ? provenance.reviewed_at_ms : null;
  const duration = Number.isSafeInteger(provenance.review_duration_ms) ? provenance.review_duration_ms : null;

  const row = {
    attestation_id: clampText(input.attestation_id, 80) || null,
    principal_id: clampText(input.principal_id, 40),
    source_sha256: clampText(input.source_sha256, 64),
    reviewer_name: clampText(provenance.reviewer_name || input.reviewer_name, 128) || null,
    reviewer_system: clampText(provenance.reviewer_system || input.reviewer_system, 64) || null,
    reviewer_model: clampText(provenance.reviewer_model && provenance.reviewer_model.id, 160) || null,
    reviewer_node_id: clampText(worker.node_id || input.node_id, 120) || null,
    subject_kind: clampText(input.subject_kind || 'source.review', 32),
    privacy_class: privacy.privacy_class,
    share_contact: privacy.share_contact,
    share_exact_location: privacy.share_exact_location,
    share_public_ip: privacy.share_public_ip,
    share_trace_route: privacy.share_trace_route,
    share_hostname: privacy.share_hostname,
    share_internal_margin: privacy.share_internal_margin,
    account_username: privacy.share_contact ? clampText(account.username, 120) || null : null,
    account_email: privacy.share_contact ? clampText(account.email, 240) || null : null,
    account_email_hash: account.email ? hash32(account.email) : null,
    account_phone: privacy.share_contact ? clampText(account.phone, 40) || null : null,
    account_phone_hash: account.phone ? hash32(account.phone) : null,
    hostname: clampText(input.hostname || worker.hostname, 120) || null,
    public_ip: clampText(input.public_ip || worker.public_ip, 64) || null,
    public_ip_hash: input.public_ip || worker.public_ip ? hash32(input.public_ip || worker.public_ip) : null,
    lan_ip: clampText(input.lan_ip, 64) || null,
    latitude: typeof loc.lat === 'number' && Number.isFinite(loc.lat) ? loc.lat : null,
    longitude: typeof loc.lon === 'number' && Number.isFinite(loc.lon) ? loc.lon : null,
    region: clampText(loc.region, 64) || null,
    country_code: clampText(loc.country_code || loc.countryCode, 8).toUpperCase() || null,
    asn: clampText(loc.asn, 48) || null,
    isp: clampText(loc.isp, 64) || null,
    trace_route: Array.isArray(input.trace_route) ? JSON.stringify(input.trace_route.slice(0, 64)) : null,
    started_at_ms: startedAt,
    reviewed_at_ms: reviewedAt,
    duration_ms: duration,
    input_tokens: Number.isSafeInteger(cost.input_tokens) ? cost.input_tokens : 0,
    output_tokens: Number.isSafeInteger(cost.output_tokens) ? cost.output_tokens : 0,
    cost_usd: Number.isFinite(cost.amount_usd) ? cost.amount_usd : 0,
    margin_usd: privacy.share_internal_margin && Number.isFinite(cost.margin_usd) ? cost.margin_usd : null,
    resource_cost_usd: Number.isFinite(cost.resource_cost_usd) ? cost.resource_cost_usd : 0,
    cpu_ms: Number.isSafeInteger(resources.cpu_ms) ? resources.cpu_ms : 0,
    gpu_ms: Number.isSafeInteger(resources.gpu_ms) ? resources.gpu_ms : 0,
    peak_rss_kb: Number.isSafeInteger(resources.peak_rss_kb) ? resources.peak_rss_kb : 0,
    source_bytes: Number.isSafeInteger(resources.source_bytes) ? resources.source_bytes : 0,
    source_lines: Number.isSafeInteger(input.lines) ? input.lines : 0,
    risk_score: Number.isSafeInteger(input.risk_score) ? input.risk_score : 0,
    risk_level: clampText(input.risk_level, 16) || null,
    verdict: clampText(input.verdict, 16) || null,
    complexity_score: Number.isSafeInteger(provenance.complexity && provenance.complexity.score)
      ? provenance.complexity.score : 0,
    complexity_class: provenance.complexity
      ? clampText(`${provenance.complexity.size_class}/${provenance.complexity.duration_class}`, 32) : null,
    network_class: clampText(worker.network_class || 'unknown', 24),
    metadata: JSON.stringify(input.metadata || {}),
  };

  if (!row.principal_id || !row.source_sha256) {
    return { ok: false, error: 'principal_id and source_sha256 are required' };
  }

  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols
    .filter((c) => !['principal_id', 'source_sha256', 'created_at'].includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  try {
    await pool.query(
      `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (attestation_id) DO UPDATE SET ${updates}, updated_at = NOW()`,
      vals
    );
    return { ok: true };
  } catch (err) {
    console.error('[review-registry] write failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── read path ──────────────────────────────────────────────────────────────
// `view` controls how much is returned:
//   'operator' — everything (admin/localhost only)
//   'partner'  — shareable fields only, respecting the row's privacy policy
//   'public'   — aggregate counters only
async function listReviews(pool, { principalId, sourceSha256, limit = 50, view = 'operator' } = {}) {
  if (!pool) return { ok: false, error: 'no database pool' };
  const params = [];
  const where = [];
  if (principalId) { params.push(principalId); where.push(`principal_id = $${params.length}`); }
  if (sourceSha256) { params.push(sourceSha256); where.push(`source_sha256 = $${params.length}`); }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500));
  try {
    const r = await pool.query(
      `SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    const rows = r.rows.map((row) => project(row, view));
    return { ok: true, rows };
  } catch (err) {
    console.error('[review-registry] read failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// One row, projected for the requested audience.
function project(row, view = 'operator') {
  if (view === 'public') {
    return {
      attestation_id: row.attestation_id,
      principal_id: row.principal_id,
      source_sha256: row.source_sha256,
      reviewer_name: row.reviewer_name,
      reviewer_system: row.reviewer_system,
      reviewed_at_ms: row.reviewed_at_ms,
      duration_ms: row.duration_ms,
      risk_score: row.risk_score,
      risk_level: row.risk_level,
      verdict: row.verdict,
      cost_usd: row.cost_usd,
      complexity_class: row.complexity_class,
    };
  }

  const shared = {
    attestation_id: row.attestation_id,
    principal_id: row.principal_id,
    source_sha256: row.source_sha256,
    reviewer_name: row.reviewer_name,
    reviewer_system: row.reviewer_system,
    reviewer_model: row.reviewer_model,
    reviewer_node_id: row.reviewer_node_id,
    privacy_class: row.privacy_class,
    started_at_ms: row.started_at_ms,
    reviewed_at_ms: row.reviewed_at_ms,
    duration_ms: row.duration_ms,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: row.cost_usd,
    cpu_ms: row.cpu_ms,
    gpu_ms: row.gpu_ms,
    peak_rss_kb: row.peak_rss_kb,
    source_bytes: row.source_bytes,
    source_lines: row.source_lines,
    risk_score: row.risk_score,
    risk_level: row.risk_level,
    verdict: row.verdict,
    complexity_score: row.complexity_score,
    complexity_class: row.complexity_class,
    network_class: row.network_class,
    region: row.region,
    country_code: row.country_code,
    asn: row.asn,
    metadata: row.metadata,
  };

  if (view === 'partner') {
    if (row.share_contact) {
      shared.account_username = row.account_username;
      shared.account_email = row.account_email;
      shared.account_phone = row.account_phone;
    }
    if (row.share_hostname) shared.hostname = row.hostname;
    if (row.share_public_ip) shared.public_ip = row.public_ip;
    if (row.share_exact_location) {
      shared.latitude = row.latitude;
      shared.longitude = row.longitude;
    }
    if (row.share_trace_route) shared.trace_route = row.trace_route;
    if (row.share_internal_margin) shared.margin_usd = row.margin_usd;
    return shared;
  }

  // operator view: everything, including contact details and hashes.
  shared.account_username = row.account_username;
  shared.account_email = row.account_email;
  shared.account_email_hash = row.account_email_hash;
  shared.account_phone = row.account_phone;
  shared.account_phone_hash = row.account_phone_hash;
  shared.hostname = row.hostname;
  shared.public_ip = row.public_ip;
  shared.public_ip_hash = row.public_ip_hash;
  shared.lan_ip = row.lan_ip;
  shared.latitude = row.latitude;
  shared.longitude = row.longitude;
  shared.isp = row.isp;
  shared.trace_route = row.trace_route;
  shared.margin_usd = row.margin_usd;
  shared.resource_cost_usd = row.resource_cost_usd;
  shared.created_at = row.created_at;
  return shared;
}

// ── aggregate analytics ────────────────────────────────────────────────────
async function reviewStats(pool, { days = 30 } = {}) {
  if (!pool) return { ok: false, error: 'no database pool' };
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS reviews,
              count(DISTINCT principal_id)::int AS reviewers,
              count(DISTINCT source_sha256)::int AS subjects,
              COALESCE(sum(duration_ms),0)::bigint AS total_duration_ms,
              COALESCE(avg(duration_ms),0)::bigint AS avg_duration_ms,
              COALESCE(sum(cost_usd),0)::numeric AS total_cost_usd,
              COALESCE(sum(input_tokens),0)::bigint AS input_tokens,
              COALESCE(sum(output_tokens),0)::bigint AS output_tokens,
              count(*) FILTER (WHERE verdict='safe')::int AS safe,
              count(*) FILTER (WHERE verdict='unsafe')::int AS unsafe,
              count(*) FILTER (WHERE verdict='review')::int AS review
         FROM ${TABLE}
        WHERE created_at > NOW() - ($1 || ' days')::interval`,
      [String(d)]
    );
    const byReviewer = await pool.query(
      `SELECT principal_id, reviewer_name, count(*)::int AS reviews,
              COALESCE(sum(duration_ms),0)::bigint AS duration_ms,
              COALESCE(sum(cost_usd),0)::numeric AS cost_usd,
              count(*) FILTER (WHERE verdict='unsafe')::int AS unsafe
         FROM ${TABLE}
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY principal_id, reviewer_name
        ORDER BY reviews DESC LIMIT 50`,
      [String(d)]
    );
    return { ok: true, stats: r.rows[0], by_reviewer: byReviewer.rows };
  } catch (err) {
    console.error('[review-registry] stats failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  TABLE,
  PRIVACY_CLASSES,
  ensureSchema,
  recordReview,
  listReviews,
  reviewStats,
  project,
  normalizePrivacy,
};
