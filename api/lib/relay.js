// api/lib/relay.js — hub-mediated inference jobs for NAT'd volunteer nodes.
// Plan: HIVV_PLAN.md #5.
//
// Flow: caller → createJob(node) → hub pushes {type:'inference_job'} into the
// node's long-poll inbox (already exists) → node runs it locally → node POSTs
// the result back with the per-job secret → caller polls getJob(id).
//
// Everything is in-memory: jobs are short-lived (TTL), results are small,
// and a gateway restart mid-job just means the caller retries the normal way.

const crypto = require('crypto');

const store = new Map();     // jobId -> job (job.secret lives ONLY on the object)
const DEFAULT_TTL_MS = 90 * 1000;
const MAX_MSG_CHARS = 32000;
const MAX_MESSAGES = 50;

// B3: quotas are tunable via gateway_config key 'relay' (router.loadConfig →
// setConfig). Defaults match the old hardcoded values; setConfig clamps hard
// so a bad config row can't turn the relay into a DoS cannon.
const CFG = { maxActivePerNode: 2, maxTokens: 2000, defaultTokens: 500, ttlMs: DEFAULT_TTL_MS };
function _clampInt(v, min, max, dflt) {
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? Math.min(Math.max(x, min), max) : dflt;
}
function setConfig(cfg = {}) {
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.max_active_per_node !== undefined) CFG.maxActivePerNode = _clampInt(cfg.max_active_per_node, 1, 16, 2);
  if (cfg.max_tokens !== undefined) CFG.maxTokens = _clampInt(cfg.max_tokens, 64, 8000, 2000);
  if (cfg.default_tokens !== undefined) CFG.defaultTokens = _clampInt(cfg.default_tokens, 16, 8000, 500);
  if (CFG.defaultTokens > CFG.maxTokens) CFG.defaultTokens = CFG.maxTokens;
  if (cfg.ttl_ms !== undefined) CFG.ttlMs = _clampInt(cfg.ttl_ms, 15000, 600000, DEFAULT_TTL_MS);
}
function getConfig() { return { ...CFG }; }

let orchRef = null;
function setOrchestrator(orch) { orchRef = orch; }

function _validateRequest(request) {
  if (!request || !Array.isArray(request.messages) || request.messages.length === 0)
    return 'messages array is required';
  if (request.messages.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`;
  const chars = request.messages.reduce((a, m) => a + String(m.content || '').length, 0);
  if (chars > MAX_MSG_CHARS) return `prompt too large (max ${MAX_MSG_CHARS} chars)`;
  return null;
}

function activeForNode(nodeId) {
  let n = 0;
  for (const j of store.values()) {
    if (j.node_id === nodeId && (j.status === 'queued' || j.status === 'running')) n++;
  }
  return n;
}

function _jobPublic(j, { withSecret = false } = {}) {
  const out = {
    id: j.id, node_id: j.node_id, status: j.status,
    result: j.status === 'done' ? j.result : null,
    error: j.error || null, created_at: j.created_at, completed_at: j.completed_at || null,
  };
  if (withSecret) out.secret = j.secret;
  return out;
}

function createJob({ nodeId, request, requester = null, ttlMs = null }) {
  const err = _validateRequest(request);
  if (err) return { error: err };
  if (!orchRef) return { error: 'orchestrator not ready' };
  const node = orchRef.nodes.get(nodeId);
  if (!node) return { error: `node ${nodeId} not found` };
  if (node.status === 'offline') return { error: `node ${nodeId} is offline` };
  if (activeForNode(nodeId) >= CFG.maxActivePerNode) return { error: 'node busy', busy: true };

  const id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(16).toString('hex');
  const job = {
    id, secret, node_id: nodeId, status: 'queued', requester,
    request: { ...request, max_tokens: Math.min(request.max_tokens || CFG.defaultTokens, CFG.maxTokens) },
    result: null, error: null,
    created_at: Date.now(), expires_at: Date.now() + (_clampInt(ttlMs, 15000, 600000, CFG.ttlMs)), completed_at: null,
  };
  store.set(id, job);

  if (typeof orchRef.enqueueInbox === 'function') {
    orchRef.enqueueInbox(nodeId, {
      type: 'inference_job',
      payload: { job_id: id, secret, request: job.request },
    });
  } else {
    store.delete(id);
    return { error: 'node inbox not available' };
  }
  return { job: _jobPublic(job, { withSecret: true }) };
}

function getJob(id) {
  const j = store.get(id);
  if (!j) return null;
  if (j.status === 'queued' && Date.now() > j.created_at + 15000) j.status = 'running'; // node probably polled it
  return _jobPublic(j);
}

// B2 support: who owns this job (never expose the secret through this path)
function getJobOwner(id) {
  const j = store.get(id);
  return j ? (j.requester || null) : undefined; // undefined = unknown job, null = unowned
}

function timingSafeEq(a, b) {
  try {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch { return false; }
}

function completeJob(id, { secret, result, error } = {}) {
  const j = store.get(id);
  if (!j) return { error: 'job not found' };
  if (!timingSafeEq(secret, j.secret)) return { error: 'bad secret' };
  if (j.status === 'done' || j.status === 'error') return { error: 'already finished' };
  j.status = error ? 'error' : 'done';
  const content = error ? null : String((result && (result.content ?? result)) || '').slice(0, 16000);
  j.result = error ? null : { content, model: (result && result.model) || null,
                              tokens: (result && result.tokens) || null,
                              // A4: tool_calls must survive the relay or OpenAI-tool
                              // clients (OpenCode) break on NAT'd bees.
                              tool_calls: (!error && result && Array.isArray(result.tool_calls) && result.tool_calls.length)
                                ? result.tool_calls.slice(0, 32) : null,
                              finish_reason: (!error && result && result.finish_reason) || null };
  j.error = error ? String(error).slice(0, 500) : null;
  j.completed_at = Date.now();
  return { job: _jobPublic(j) };
}

// expiry sweep
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of store) {
    if (now > j.expires_at) {
      if (j.status === 'queued' || j.status === 'running') { j.status = 'expired'; j.error = 'expired'; }
      if (now > j.expires_at + 60000) store.delete(id);
    }
  }
}, 5000).unref();

function stats() {
  let queued = 0, running = 0, done = 0, failed = 0;
  for (const j of store.values()) {
    if (j.status === 'queued') queued++;
    else if (j.status === 'running') running++;
    else if (j.status === 'done') done++;
    else failed++;
  }
  return { queued, running, done, failed, total: store.size };
}

module.exports = { createJob, getJob, getJobOwner, completeJob, activeForNode, stats, setOrchestrator, setConfig, getConfig };
