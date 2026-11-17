// api/lib/local-mode.js — "local-first" operation for self-hosted HIVV.
//
// THE PROBLEM THIS SOLVES
// ───────────────────────
// A cloned HIVV must be useful on a laptop with no internet, no PostgreSQL,
// and no hivv.org. Today the gateway hard-requires a Postgres pool at import
// time and dies without it — which makes "git clone && run" impossible.
//
// THE MODEL
// ────────
//   1. LOCAL-FIRST: serve requests from local models / local key files.
//   2. DEGRADED, NOT DEAD: if the database is unreachable, the gateway still
//      answers /v1/chat/completions, /v1/models, /api/scan, /api/health, and
//      the partner surface — it just cannot persist users, usage, or node
//      registrations.
//   3. HIVE OPTIONAL: if hivv.org is reachable, the local instance can still
//      register as a node and serve the global hive. If it is not, the local
//      instance is completely self-sufficient.
//   4. NEVER PHONE HOME SILENTLY: the local instance only talks to the public
//      hub when explicitly enabled (HIVV_HIVE_JOIN=1) — a clone-and-run must
//      not leak anything by default.
//
// DETECTION
// ─────────
//   * HIVV_MODE=local        force local-only, never contact the hub
//   * HIVV_MODE=hive         prefer the hub, fall back to local
//   * HIVV_MODE=auto         (default) local-first; join the hive if enabled
//   * HIVV_HIVE_JOIN=1       opt in to registering with hivv.org
//   * HIVV_HIVE_URL          the hub to join (default https://hivv.org)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_HIVE_URL = 'https://hivv.org';

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function mode() {
  const raw = String(process.env.HIVV_MODE || 'auto').toLowerCase();
  return ['local', 'hive', 'auto'].includes(raw) ? raw : 'auto';
}

function hiveUrl() {
  return String(process.env.HIVV_HIVE_URL || DEFAULT_HIVE_URL).replace(/\/+$/, '');
}

function hiveJoinEnabled() {
  return boolEnv('HIVV_HIVE_JOIN', false);
}

function isLocalOnly() {
  return mode() === 'local';
}

function isHiveAllowed() {
  return mode() !== 'local' && hiveJoinEnabled();
}

// ── data directory (state that must survive restarts) ─────────────────────
function dataDir() {
  const custom = process.env.HIVV_DATA_DIR;
  if (custom) return path.resolve(custom);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'hivv');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'hivv');
  }
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'hivv')
    : path.join(os.homedir(), '.local', 'share', 'hivv');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  } catch (_e) { return false; }
}

// ── local provider keys (no database required) ────────────────────────────
// File-backed keys live in $HIVV_DATA_DIR/keys/<provider>.json:
//   { "api_key": "...", "api_endpoint": "https://api.openai.com/v1", "model": "gpt-4o-mini" }
// The file is the source of truth for a local install; the database (when
// present) still works exactly as before.
function localKeysDir() {
  return path.join(dataDir(), 'keys');
}

function readLocalKeys() {
  const dir = localKeysDir();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_e) { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!raw || !raw.api_key) continue;
      out.push({
        name: raw.name || path.basename(f, '.json'),
        api_key: String(raw.api_key),
        api_endpoint: raw.api_endpoint || raw.endpoint || null,
        model: raw.model || null,
        source: 'local-file',
      });
    } catch (_e) { /* skip malformed key file */ }
  }
  return out;
}

function writeLocalKey(name, spec) {
  const dir = localKeysDir();
  if (!ensureDir(dir)) throw new Error(`cannot create ${dir}`);
  const safe = String(name || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(dir, `${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(spec, null, 2), { mode: 0o600 });
  return file;
}

// ── local model discovery (no hub, no database) ───────────────────────────
const LOCAL_PROBE_PORTS = [
  { port: 8080, provider: 'llamacpp', label: 'llama.cpp' },
  { port: 8081, provider: 'llamacpp', label: 'llama.cpp' },
  { port: 8082, provider: 'llamacpp', label: 'llama.cpp' },
  { port: 8090, provider: 'llamacpp', label: 'llama.cpp' },
  { port: 11434, provider: 'ollama', label: 'ollama' },
  { port: 1234, provider: 'lmstudio', label: 'lm-studio' },
  { port: 5000, provider: 'oobabooga', label: 'oobabooga' },
  { port: 8000, provider: 'vllm', label: 'vllm' },
];

async function probeLocalModels(timeoutMs = 1200) {
  const found = [];
  for (const p of LOCAL_PROBE_PORTS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${p.port}/v1/models`, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'hivv-local' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const models = Array.isArray(data.data) ? data.data : [];
      for (const m of models) {
        const id = m && (m.id || m.model);
        if (!id) continue;
        found.push({
          provider: p.provider,
          label: p.label,
          port: p.port,
          model: String(id),
          url: `http://127.0.0.1:${p.port}/v1`,
        });
      }
      if (!models.length) {
        found.push({
          provider: p.provider, label: p.label, port: p.port,
          model: 'default', url: `http://127.0.0.1:${p.port}/v1`,
        });
      }
    } catch (_e) { /* nothing listening */ }
    finally { clearTimeout(timer); }
  }
  return found;
}

// ── hive reachability (never blocking, never automatic) ───────────────────
async function hiveStatus(timeoutMs = 2500) {
  const url = `${hiveUrl()}/api/health`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'hivv-local' } });
    const body = await res.json().catch(() => ({}));
    return {
      reachable: res.ok,
      url: hiveUrl(),
      status: body.status || (res.ok ? 'healthy' : 'degraded'),
      latency_ms: Date.now() - started,
      checked_at_ms: Date.now(),
    };
  } catch (e) {
    return {
      reachable: false,
      url: hiveUrl(),
      status: 'unreachable',
      reason: e.name === 'AbortError' ? 'timeout' : e.message,
      latency_ms: Date.now() - started,
      checked_at_ms: Date.now(),
    };
  } finally { clearTimeout(timer); }
}

// ── instance identity ─────────────────────────────────────────────────────
// A stable id for this installation so a local install can be recognized
// across restarts without a database.
function instanceId() {
  if (process.env.HIVV_INSTANCE_ID) return process.env.HIVV_INSTANCE_ID;
  const file = path.join(dataDir(), 'instance-id');
  ensureDir(dataDir());
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (_e) { /* first run */ }
  const id = 'local_' + crypto.randomBytes(8).toString('hex');
  try { fs.writeFileSync(file, id + '\n', { mode: 0o600 }); } catch (_e) { /* read-only fs */ }
  return id;
}

// ── the public descriptor ─────────────────────────────────────────────────
// One object that tells a partner site (or a human) exactly what this
// instance can do right now.
function describe({ dbConnected = false, localModels = [], hive = null, version = null } = {}) {
  return {
    name: 'HIVV',
    tagline: 'A distributed AI network — at home and around the world',
    pronunciation: 'HIVE (like a beehive)',
    version: version || process.env.HIVV_VERSION || '2.0.0',
    instance_id: instanceId(),
    mode: mode(),
    local_first: true,
    hub: hiveUrl(),
    hive_joined: isHiveAllowed(),
    database: dbConnected ? 'connected' : 'degraded',
    offline_capable: true,
    local_models: localModels.map((m) => ({
      provider: m.provider, model: m.model, port: m.port,
    })),
    hive_status: hive || null,
    endpoints: {
      openai: '/v1/chat/completions',
      models: '/v1/models',
      health: '/api/health',
      fast_scan: '/api/scan/fast',
      signed_scan: '/api/scan',
      attest_key: '/api/scan/key',
      capabilities: '/api/capabilities',
      route_preview: '/api/capabilities/route/dry-run',
      policy: '/api/policy',
      mcp: '/mcp',
      manifest: '/api/partner/manifest',
      partner_health: '/api/partner/health',
      partner_models: '/api/partner/models',
      partner_network: '/api/partner/network',
      partner_fast_scan: '/api/partner/fast-scan',
      partner_review: '/api/partner/review',
      partner_verify: '/api/partner/verify',
      partner_attestation_key: '/api/partner/attestation/key',
    },
    capabilities: [
      'openai-compatible-chat',
      'local-model-routing',
      'deterministic-fast-scan',
      'signed-source-review',
      'offline-first',
      'optional-hive-join',
    ],
  };
}

module.exports = {
  DEFAULT_HIVE_URL,
  mode,
  hiveUrl,
  hiveJoinEnabled,
  isLocalOnly,
  isHiveAllowed,
  dataDir,
  ensureDir,
  localKeysDir,
  readLocalKeys,
  writeLocalKey,
  probeLocalModels,
  hiveStatus,
  instanceId,
  describe,
  boolEnv,
};
