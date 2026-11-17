// api/lib/request-provenance.js — record EVERY HIVV request with rich,
// privacy-aware provenance.
//
// WHAT THIS SOLVES
// ────────────────
// The request ledger answers, for any request on HIVV:
//   * who asked (user / visitor / API key / principal)
//   * what was asked (hash + sizes — never raw prompts)
//   * which model and which NODE answered, over which transport
//   * exactly when, and how long it took (start, finish, TTFB, queue)
//   * what it cost (money + resource cost)
//   * where the worker was (coarse geo; exact coords/IP/trace only if allowed)
//   * the privacy policy that governed sharing
//
// PRIVACY MODEL
// ─────────────
//   * Raw prompts and raw model output are NEVER stored here — only SHA-256
//     digests and byte/token counts.
//   * IPs, contact fields, exact coordinates, traceroute, hostnames, and
//     internal margins are all gated behind explicit per-row share flags.
//   * The public API never returns this table's rows. The operator API returns
//     them through `project()`, which applies the row's own policy.
//   * Coordinates are rounded before storage (~1.1 km): a map dot, not a
//     house address.
//
// FAILURE POSTURE
// ──────────────
//   * Recording must never break a request. Every write is wrapped so a schema
//     problem logs once and then degrades to "no provenance" rather than a 500.
//   * Writes are fire-and-forget from the caller's perspective.

const crypto = require('crypto');

const TABLE = 'hivv_request_provenance';
const STATS_TABLE = 'hivv_node_provenance_stats';
const DAILY_TABLE = 'hivv_provenance_daily';

const PRIVACY_CLASSES = ['public', 'network', 'private', 'sealed'];

let _pool = null;
let _schemaReady = false;
let _schemaErrorLogged = false;
let _insertSql = null;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function clampText(value, max = 240) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

function nonNegInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Round coordinates to 2dp (~1.1 km). Exact location is never stored here.
function roundCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
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
    share_internal_margin: (cls === 'private' || cls === 'sealed') && input.share_internal_margin === true,
  };
}

// ── schema ─────────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  endpoint VARCHAR(120) NOT NULL,
  method VARCHAR(10) NOT NULL DEFAULT 'POST',
  feature VARCHAR(64),
  status VARCHAR(24) NOT NULL DEFAULT 'success',
  user_id INTEGER,
  anonymous_visitor_id VARCHAR(64),
  principal VARCHAR(120),
  api_key_id INTEGER,
  session_id VARCHAR(64),
  ip_address VARCHAR(45),
  ip_address_hash VARCHAR(64),
  user_agent TEXT,
  request_sha256 VARCHAR(64),
  input_bytes BIGINT NOT NULL DEFAULT 0,
  output_bytes BIGINT NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  tool_names JSONB NOT NULL DEFAULT '[]',
  provider VARCHAR(64),
  provider_id INTEGER,
  model VARCHAR(160),
  model_family VARCHAR(64),
  answered_by VARCHAR(160),
  answered_by_node VARCHAR(120),
  transport VARCHAR(24),
  route_mode VARCHAR(24),
  capability VARCHAR(64),
  privacy_filter VARCHAR(32),
  policy_receipt VARCHAR(160),
  policy_verdict VARCHAR(16),
  worker_node_id VARCHAR(120),
  worker_hostname VARCHAR(120),
  worker_public_ip VARCHAR(45),
  worker_public_ip_hash VARCHAR(64),
  worker_lan_ip VARCHAR(45),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  region VARCHAR(64),
  country_code VARCHAR(8),
  asn VARCHAR(48),
  isp VARCHAR(64),
  network_class VARCHAR(24) NOT NULL DEFAULT 'unknown',
  trace_route JSONB,
  hop_count INTEGER,
  rtt_ms INTEGER,
  started_at_ms BIGINT,
  completed_at_ms BIGINT,
  duration_ms BIGINT,
  ttfb_ms BIGINT,
  queue_ms INTEGER,
  cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  resource_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  margin_usd NUMERIC(20,10),
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  cost_estimated BOOLEAN NOT NULL DEFAULT TRUE,
  cpu_ms BIGINT NOT NULL DEFAULT 0,
  gpu_ms BIGINT NOT NULL DEFAULT 0,
  peak_rss_kb BIGINT NOT NULL DEFAULT 0,
  success BOOLEAN,
  error_code VARCHAR(64),
  error_message TEXT,
  tokens_per_sec DECIMAL(10,2),
  quality_score DECIMAL(6,3),
  reliability_score DECIMAL(6,3),
  privacy_class VARCHAR(24) NOT NULL DEFAULT 'private',
  share_contact BOOLEAN NOT NULL DEFAULT FALSE,
  share_exact_location BOOLEAN NOT NULL DEFAULT FALSE,
  share_public_ip BOOLEAN NOT NULL DEFAULT FALSE,
  share_trace_route BOOLEAN NOT NULL DEFAULT FALSE,
  share_hostname BOOLEAN NOT NULL DEFAULT FALSE,
  share_internal_margin BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_user ON ${TABLE} (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_visitor ON ${TABLE} (anonymous_visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_endpoint ON ${TABLE} (endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_node ON ${TABLE} (answered_by_node, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_worker ON ${TABLE} (worker_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_model ON ${TABLE} (model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_created ON ${TABLE} (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_privacy ON ${TABLE} (privacy_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_ip_hash ON ${TABLE} (ip_address_hash) WHERE ip_address_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
  node_id TEXT PRIMARY KEY,
  requests BIGINT NOT NULL DEFAULT 0,
  successes BIGINT NOT NULL DEFAULT 0,
  failures BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  avg_duration_ms BIGINT NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  total_resource_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  avg_ttfb_ms INTEGER NOT NULL DEFAULT 0,
  ewma_tps REAL NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hivv_node_prov_stats_seen ON ${STATS_TABLE} (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ${DAILY_TABLE} (
  day DATE NOT NULL,
  endpoint VARCHAR(120) NOT NULL,
  provider VARCHAR(64),
  model VARCHAR(160),
  privacy_class VARCHAR(24) NOT NULL DEFAULT 'private',
  requests BIGINT NOT NULL DEFAULT 0,
  successes BIGINT NOT NULL DEFAULT 0,
  failures BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  avg_duration_ms BIGINT NOT NULL DEFAULT 0,
  p95_duration_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, endpoint, privacy_class)
);
CREATE INDEX IF NOT EXISTS idx_hivv_prov_daily_day ON ${DAILY_TABLE} (day DESC);
`;

async function ensureSchema() {
  if (!_pool) return false;
  if (_schemaReady) return true;
  try {
    await _pool.query(SCHEMA_SQL);
    _schemaReady = true;
    return true;
  } catch (err) {
    if (!_schemaErrorLogged) {
      _schemaErrorLogged = true;
      console.error('[request-provenance] schema setup failed:', err.message);
    }
    return false;
  }
}

function start(pgPool) {
  _pool = pgPool;
  _schemaReady = false;
  _schemaErrorLogged = false;
  _insertSql = null;
  ensureSchema().catch(() => {});
}

// ── row construction ───────────────────────────────────────────────────────
function buildRow(input = {}) {
  const privacy = normalizePrivacy(input.privacy || {});
  const loc = input.location || {};
  const worker = input.worker || {};
  const started = nonNegInt(input.started_at_ms);
  const completed = nonNegInt(input.completed_at_ms);
  const duration = nonNegInt(input.duration_ms)
    ?? (started !== null && completed !== null ? Math.max(0, completed - started) : null);
  const ip = clampText(input.ip_address, 45) || null;
  const workerIp = clampText(worker.public_ip, 45) || null;
  const requestId = clampText(input.request_id, 120) || crypto.randomUUID();
  const endpoint = clampText(input.endpoint, 120) || 'unknown';
  const success = input.success === undefined ? null : !!input.success;

  return {
    request_id: requestId,
    endpoint,
    method: clampText(input.method || 'POST', 10).toUpperCase(),
    feature: clampText(input.feature, 64) || null,
    status: clampText(input.status || (success === false ? 'error' : 'success'), 24),
    user_id: nonNegInt(input.user_id),
    anonymous_visitor_id: clampText(input.anonymous_visitor_id, 64) || null,
    principal: clampText(input.principal, 120) || null,
    api_key_id: nonNegInt(input.api_key_id),
    session_id: clampText(input.session_id, 64) || null,
    ip_address: ip,
    ip_address_hash: ip ? sha256(ip) : null,
    user_agent: clampText(input.user_agent, 400) || null,
    request_sha256: input.request_sha256 ? clampText(input.request_sha256, 64) : null,
    input_bytes: nonNegInt(input.input_bytes) || 0,
    output_bytes: nonNegInt(input.output_bytes) || 0,
    input_tokens: nonNegInt(input.input_tokens) || 0,
    output_tokens: nonNegInt(input.output_tokens) || 0,
    total_tokens: nonNegInt(input.input_tokens) || 0,
    tool_call_count: nonNegInt(input.tool_call_count) || 0,
    tool_names: JSON.stringify(Array.isArray(input.tool_names) ? input.tool_names.slice(0, 32).map(clampText) : []),
    provider: clampText(input.provider, 64) || null,
    provider_id: nonNegInt(input.provider_id),
    model: clampText(input.model, 160) || null,
    model_family: clampText(input.model_family, 64) || null,
    answered_by: clampText(input.answered_by, 160) || null,
    answered_by_node: clampText(input.answered_by_node, 120) || null,
    transport: clampText(input.transport, 24) || null,
    route_mode: clampText(input.route_mode, 24) || null,
    capability: clampText(input.capability, 64) || null,
    privacy_filter: clampText(input.privacy_filter, 32) || null,
    policy_receipt: clampText(input.policy_receipt, 160) || null,
    policy_verdict: clampText(input.policy_verdict, 16) || null,
    worker_node_id: clampText(worker.node_id || input.worker_node_id, 120) || null,
    worker_hostname: privacy.share_hostname ? (clampText(worker.hostname, 120) || null) : null,
    worker_public_ip: privacy.share_public_ip ? workerIp : null,
    worker_public_ip_hash: workerIp ? sha256(workerIp) : null,
    worker_lan_ip: privacy.share_public_ip ? (clampText(worker.lan_ip, 45) || null) : null,
    latitude: roundCoord(loc.lat),
    longitude: roundCoord(loc.lon ?? loc.lng),
    region: clampText(loc.region, 64) || null,
    country_code: clampText(loc.country_code || loc.countryCode, 8).toUpperCase() || null,
    asn: clampText(loc.asn, 48) || null,
    isp: privacy.share_exact_location ? (clampText(loc.isp, 64) || null) : null,
    network_class: clampText(worker.network_class || 'unknown', 24),
    trace_route: privacy.share_trace_route && Array.isArray(worker.trace_route)
      ? JSON.stringify(worker.trace_route.slice(0, 64)) : null,
    hop_count: Array.isArray(worker.trace_route) ? worker.trace_route.length : null,
    rtt_ms: nonNegInt(worker.rtt_ms),
    started_at_ms: started,
    completed_at_ms: completed,
    duration_ms: duration,
    ttfb_ms: nonNegInt(input.ttfb_ms),
    queue_ms: nonNegInt(input.queue_ms),
    cost_usd: finiteNumber(input.cost_usd, 0) || 0,
    resource_cost_usd: finiteNumber(input.resource_cost_usd, 0) || 0,
    margin_usd: privacy.share_internal_margin && Number.isFinite(input.margin_usd) ? input.margin_usd : null,
    currency: 'USD',
    cost_estimated: input.cost_estimated === undefined ? true : !!input.cost_estimated,
    cpu_ms: nonNegInt(input.cpu_ms) || 0,
    gpu_ms: nonNegInt(input.gpu_ms) || 0,
    peak_rss_kb: nonNegInt(input.peak_rss_kb) || 0,
    success,
    error_code: clampText(input.error_code, 64) || null,
    error_message: clampText(input.error_message, 1000) || null,
    tokens_per_sec: finiteNumber(input.tokens_per_sec),
    quality_score: finiteNumber(input.quality_score),
    reliability_score: finiteNumber(input.reliability_score),
    privacy_class: privacy.privacy_class,
    share_contact: privacy.share_contact,
    share_exact_location: privacy.share_exact_location,
    share_public_ip: privacy.share_public_ip,
    share_trace_route: privacy.share_trace_route,
    share_hostname: privacy.share_hostname,
    share_internal_margin: privacy.share_internal_margin,
    metadata: JSON.stringify(input.metadata || {}),
  };
}

// ── write path ─────────────────────────────────────────────────────────────
async function record(input = {}) {
  if (!_pool) return { ok: false, error: 'provenance not started' };
  if (!(await ensureSchema())) return { ok: false, error: 'schema unavailable' };
  const row = buildRow(input);
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  try {
    await _pool.query(
      `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (request_id, endpoint) DO UPDATE SET
         status = EXCLUDED.status,
         completed_at_ms = EXCLUDED.completed_at_ms,
         duration_ms = EXCLUDED.duration_ms,
         ttfb_ms = EXCLUDED.ttfb_ms,
         output_bytes = EXCLUDED.output_bytes,
         output_tokens = EXCLUDED.output_tokens,
         total_tokens = EXCLUDED.total_tokens,
         success = EXCLUDED.success,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         cost_usd = EXCLUDED.cost_usd,
         resource_cost_usd = EXCLUDED.resource_cost_usd,
         tokens_per_sec = EXCLUDED.tokens_per_sec,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      vals
    );
    await rollups(row);
    return { ok: true };
  } catch (err) {
    console.error('[request-provenance] write failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Fire-and-forget variant for hot paths.
function recordAsync(input) {
  record(input).catch(() => {});
}

// ── rollups ────────────────────────────────────────────────────────────────
async function rollups(row) {
  try {
    if (row.answered_by_node) {
      await _pool.query(
        `INSERT INTO ${STATS_TABLE}
           (node_id, requests, successes, failures, input_tokens, output_tokens,
            total_duration_ms, avg_duration_ms, total_cost_usd,
            total_resource_cost_usd, avg_ttfb_ms, ewma_tps, last_seen_at, updated_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, NOW(), NOW())
         ON CONFLICT (node_id) DO UPDATE SET
           requests = ${STATS_TABLE}.requests + 1,
           successes = ${STATS_TABLE}.successes + EXCLUDED.successes,
           failures = ${STATS_TABLE}.failures + EXCLUDED.failures,
           input_tokens = ${STATS_TABLE}.input_tokens + EXCLUDED.input_tokens,
           output_tokens = ${STATS_TABLE}.output_tokens + EXCLUDED.output_tokens,
           total_duration_ms = ${STATS_TABLE}.total_duration_ms + EXCLUDED.total_duration_ms,
           avg_duration_ms = CASE WHEN ${STATS_TABLE}.requests + 1 = 0 THEN 0
             ELSE (( ${STATS_TABLE}.avg_duration_ms * ${STATS_TABLE}.requests
                     + EXCLUDED.avg_duration_ms) / (${STATS_TABLE}.requests + 1))::bigint END,
           total_cost_usd = ${STATS_TABLE}.total_cost_usd + EXCLUDED.total_cost_usd,
           total_resource_cost_usd = ${STATS_TABLE}.total_resource_cost_usd + EXCLUDED.total_resource_cost_usd,
           avg_ttfb_ms = CASE WHEN ${STATS_TABLE}.requests + 1 = 0 THEN 0
             ELSE (( ${STATS_TABLE}.avg_ttfb_ms * ${STATS_TABLE}.requests
                     + EXCLUDED.avg_ttfb_ms) / (${STATS_TABLE}.requests + 1))::int END,
           ewma_tps = CASE WHEN EXCLUDED.ewma_tps > 0
             THEN (0.3 * EXCLUDED.ewma_tps + 0.7 * ${STATS_TABLE}.ewma_tps)
             ELSE ${STATS_TABLE}.ewma_tps END,
           last_seen_at = NOW(),
           updated_at = NOW()`,
        [
          row.answered_by_node,
          row.success === true ? 1 : 0,
          row.success === false ? 1 : 0,
          row.input_tokens,
          row.output_tokens,
          row.duration_ms || 0,
          row.cost_usd,
          row.resource_cost_usd,
          row.ttfb_ms || 0,
          row.tokens_per_sec || 0,
        ]
      );
    }

    await _pool.query(
      `INSERT INTO ${DAILY_TABLE}
         (day, endpoint, provider, model, privacy_class, requests, successes,
          failures, input_tokens, output_tokens, total_cost_usd, avg_duration_ms,
          p95_duration_ms, updated_at)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $10, NOW())
       ON CONFLICT (day, endpoint, privacy_class) DO UPDATE SET
         requests = ${DAILY_TABLE}.requests + 1,
         successes = ${DAILY_TABLE}.successes + EXCLUDED.successes,
         failures = ${DAILY_TABLE}.failures + EXCLUDED.failures,
         input_tokens = ${DAILY_TABLE}.input_tokens + EXCLUDED.input_tokens,
         output_tokens = ${DAILY_TABLE}.output_tokens + EXCLUDED.output_tokens,
         total_cost_usd = ${DAILY_TABLE}.total_cost_usd + EXCLUDED.total_cost_usd,
         avg_duration_ms = CASE WHEN ${DAILY_TABLE}.requests + 1 = 0 THEN 0
           ELSE (( ${DAILY_TABLE}.avg_duration_ms * ${DAILY_TABLE}.requests
                   + EXCLUDED.avg_duration_ms) / (${DAILY_TABLE}.requests + 1))::bigint END,
         updated_at = NOW()`,
      [
        row.endpoint,
        row.provider,
        row.model,
        row.privacy_class,
        row.success === true ? 1 : 0,
        row.success === false ? 1 : 0,
        row.input_tokens,
        row.output_tokens,
        row.cost_usd,
        row.duration_ms || 0,
      ]
    );
  } catch (err) {
    // Rollups are best-effort; the primary row is the source of truth.
    console.error('[request-provenance] rollup failed:', err.message);
  }
}

// ── read path ──────────────────────────────────────────────────────────────
function project(row, view = 'operator') {
  const shared = {
    request_id: row.request_id,
    endpoint: row.endpoint,
    method: row.method,
    feature: row.feature,
    status: row.status,
    success: row.success,
    started_at_ms: row.started_at_ms,
    completed_at_ms: row.completed_at_ms,
    duration_ms: row.duration_ms,
    ttfb_ms: row.ttfb_ms,
    provider: row.provider,
    model: row.model,
    model_family: row.model_family,
    answered_by: row.answered_by,
    answered_by_node: row.answered_by_node,
    transport: row.transport,
    route_mode: row.route_mode,
    capability: row.capability,
    privacy_filter: row.privacy_filter,
    policy_receipt: row.policy_receipt,
    policy_verdict: row.policy_verdict,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    input_bytes: row.input_bytes,
    output_bytes: row.output_bytes,
    tool_call_count: row.tool_call_count,
    tool_names: row.tool_names,
    cost_usd: row.cost_usd,
    resource_cost_usd: row.resource_cost_usd,
    currency: row.currency,
    cost_estimated: row.cost_estimated,
    cpu_ms: row.cpu_ms,
    gpu_ms: row.gpu_ms,
    peak_rss_kb: row.peak_rss_kb,
    tokens_per_sec: row.tokens_per_sec,
    worker_node_id: row.worker_node_id,
    region: row.region,
    country_code: row.country_code,
    asn: row.asn,
    network_class: row.network_class,
    hop_count: row.hop_count,
    rtt_ms: row.rtt_ms,
    privacy_class: row.privacy_class,
    metadata: row.metadata,
    created_at: row.created_at,
  };

  if (view === 'public') {
    return shared;
  }

  if (view === 'partner') {
    if (row.share_contact) {
      shared.principal = row.principal;
      shared.user_id = row.user_id;
    }
    if (row.share_hostname) shared.worker_hostname = row.worker_hostname;
    if (row.share_public_ip) {
      shared.worker_public_ip = row.worker_public_ip;
      shared.worker_lan_ip = row.worker_lan_ip;
    }
    if (row.share_exact_location) {
      shared.latitude = row.latitude;
      shared.longitude = row.longitude;
      shared.isp = row.isp;
    }
    if (row.share_trace_route) shared.trace_route = row.trace_route;
    if (row.share_internal_margin) shared.margin_usd = row.margin_usd;
    return shared;
  }

  // operator view
  shared.user_id = row.user_id;
  shared.anonymous_visitor_id = row.anonymous_visitor_id;
  shared.principal = row.principal;
  shared.api_key_id = row.api_key_id;
  shared.session_id = row.session_id;
  shared.ip_address = row.ip_address;
  shared.ip_address_hash = row.ip_address_hash;
  shared.user_agent = row.user_agent;
  shared.request_sha256 = row.request_sha256;
  shared.worker_hostname = row.worker_hostname;
  shared.worker_public_ip = row.worker_public_ip;
  shared.worker_public_ip_hash = row.worker_public_ip_hash;
  shared.worker_lan_ip = row.worker_lan_ip;
  shared.latitude = row.latitude;
  shared.longitude = row.longitude;
  shared.isp = row.isp;
  shared.trace_route = row.trace_route;
  shared.margin_usd = row.margin_usd;
  shared.error_code = row.error_code;
  shared.error_message = row.error_message;
  shared.quality_score = row.quality_score;
  shared.reliability_score = row.reliability_score;
  return shared;
}

async function listRequests(filters = {}, view = 'operator') {
  if (!_pool) return { ok: false, error: 'provenance not started' };
  if (!(await ensureSchema())) return { ok: false, error: 'schema unavailable' };
  const params = [];
  const where = [];
  const add = (sql, value) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  add('user_id = ?', filters.user_id);
  add('anonymous_visitor_id = ?', filters.anonymous_visitor_id);
  add('endpoint = ?', filters.endpoint);
  add('answered_by_node = ?', filters.answered_by_node);
  add('worker_node_id = ?', filters.worker_node_id);
  add('model = ?', filters.model);
  add('provider = ?', filters.provider);
  add('privacy_class = ?', filters.privacy_class);
  if (filters.since) { params.push(filters.since); where.push(`created_at >= $${params.length}`); }
  params.push(Math.min(Math.max(parseInt(filters.limit, 10) || 100, 1), 1000));
  try {
    const r = await _pool.query(
      `SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return { ok: true, rows: r.rows.map((row) => project(row, view)) };
  } catch (err) {
    console.error('[request-provenance] list failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function getRequest(requestId, endpoint, view = 'operator') {
  if (!_pool) return { ok: false, error: 'provenance not started' };
  if (!(await ensureSchema())) return { ok: false, error: 'schema unavailable' };
  try {
    const r = await _pool.query(
      `SELECT * FROM ${TABLE} WHERE request_id = $1 AND ($2::text IS NULL OR endpoint = $2)`,
      [requestId, endpoint || null]
    );
    if (!r.rows[0]) return { ok: false, error: 'not found' };
    return { ok: true, row: project(r.rows[0], view) };
  } catch (err) {
    console.error('[request-provenance] get failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function stats(days = 30) {
  if (!_pool) return { ok: false, error: 'provenance not started' };
  if (!(await ensureSchema())) return { ok: false, error: 'schema unavailable' };
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  try {
    const overall = await _pool.query(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE success = TRUE)::int AS successes,
              count(*) FILTER (WHERE success = FALSE)::int AS failures,
              count(DISTINCT user_id)::int AS users,
              count(DISTINCT anonymous_visitor_id)::int AS visitors,
              count(DISTINCT answered_by_node)::int AS nodes,
              COALESCE(sum(input_tokens),0)::bigint AS input_tokens,
              COALESCE(sum(output_tokens),0)::bigint AS output_tokens,
              COALESCE(sum(cost_usd),0)::numeric AS cost_usd,
              COALESCE(sum(resource_cost_usd),0)::numeric AS resource_cost_usd,
              COALESCE(avg(duration_ms),0)::bigint AS avg_duration_ms,
              COALESCE(avg(ttfb_ms),0)::bigint AS avg_ttfb_ms
         FROM ${TABLE}
        WHERE created_at > NOW() - ($1 || ' days')::interval`,
      [String(d)]
    );
    const byNode = await _pool.query(
      `SELECT answered_by_node AS node_id, count(*)::int AS requests,
              count(*) FILTER (WHERE success = TRUE)::int AS successes,
              COALESCE(avg(duration_ms),0)::bigint AS avg_duration_ms,
              COALESCE(avg(ttfb_ms),0)::bigint AS avg_ttfb_ms,
              COALESCE(sum(cost_usd),0)::numeric AS cost_usd
         FROM ${TABLE}
        WHERE created_at > NOW() - ($1 || ' days')::interval
          AND answered_by_node IS NOT NULL
        GROUP BY answered_by_node ORDER BY requests DESC LIMIT 50`,
      [String(d)]
    );
    const byEndpoint = await _pool.query(
      `SELECT endpoint, count(*)::int AS requests,
              count(*) FILTER (WHERE success = FALSE)::int AS failures,
              COALESCE(avg(duration_ms),0)::bigint AS avg_duration_ms,
              COALESCE(sum(cost_usd),0)::numeric AS cost_usd
         FROM ${TABLE}
        WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY endpoint ORDER BY requests DESC LIMIT 50`,
      [String(d)]
    );
    return { ok: true, overall: overall.rows[0], by_node: byNode.rows, by_endpoint: byEndpoint.rows };
  } catch (err) {
    console.error('[request-provenance] stats failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  TABLE,
  STATS_TABLE,
  DAILY_TABLE,
  PRIVACY_CLASSES,
  start,
  ensureSchema,
  record,
  recordAsync,
  listRequests,
  getRequest,
  stats,
  project,
  buildRow,
  normalizePrivacy,
  sha256,
};
