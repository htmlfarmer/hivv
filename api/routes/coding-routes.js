// api/routes/coding-routes.js — HTTP surface for coder bees (HIVV_OPENCODE_PLAN §4).
// Mounted at /api/coding:
//   const CodingRoutes = require('./routes/coding-routes');
//   CodingRoutes.inject(orch);
//   app.use('/api/coding', CodingRoutes);
//
//   POST /api/coding/jobs            {task, repo:{url,ref,subdir}, timeout_s?} → 202 {job_id, node_id, status, poll}
//   GET  /api/coding/jobs/:id        poll status + result (requester / control-token admin / anonymous)
//   POST /api/coding/jobs/:id/result {secret, result:{...}}   (node side — per-job secret)
//   GET  /api/coding/stats           queue health: counts by status + active per node
//
// Same job/secret/inbox pattern as the NAT relay (lib/relay.js): the hub mints
// a per-job secret, pushes `coding_job` into the volunteer bee's long-poll
// inbox, the bee runs OpenCode headless, then POSTs the patch back with the
// secret. Everything is in-memory — jobs expire timeout_s + 120s after create,
// a janitor sweeps stale jobs, and a gateway restart mid-job just means the
// caller re-dispatches. Candidate bees must be online + opted-in + advertise
// `opencode` in `tools`; there is NO fallback to non-coder nodes.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const policy = require('../lib/policy');

const CONTROL_TOKEN = process.env.HIVV_CONTROL_TOKEN || '';

let orchestrator = null;
router.inject = (orch) => { orchestrator = orch; };

// ── config (house pattern: relay-routes B1 limiter + relay.js CFG clamp) ─────
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_MAX = 20;          // job creates / min / requester (relay uses 10; coder flows batch)
const READ_WINDOW_MS = 60 * 1000;
const READ_MAX = 240;           // polls / min / requester (agents poll at ~2/s)
const RESULT_MAX = 240;         // result posts / min / requester (secret-gated, keep generous)
const MAX_TASK_CHARS = 8000;
const MAX_REPO_URL_CHARS = 2000;
const MAX_ACTIVE_PER_NODE = 2;  // contract: 2 active coding jobs per bee (own counter)
const TTL_PAD_S = 120;          // expires_at = created + timeout_s + 120s
const RUNNING_AFTER_MS = 15000; // queued → running once the bee has had time to pick it up
const MAX_PATCH_CHARS = 300000;
const MAX_SUMMARY_CHARS = 16000;
const MAX_FILES = 1000;
const MAX_FILE_CHARS = 1024;
const FINISHED_GRACE_MS = 60 * 1000; // keep finished/expired jobs this long past expiry

const store = new Map();        // job_id -> job (job.secret lives ONLY on the object)

// ── small helpers (copies of relay.js / relay-routes.js) ─────────────────────
function _clampInt(v, min, max, dflt) {
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? Math.min(Math.max(x, min), max) : dflt;
}

function timingSafeEq(a, b) {
  try {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch { return false; }
}

// B1-style sliding-window limiter (relay-routes): public hub endpoint → bound the flood.
const hits = new Map();          // key -> [timestamps]
function _limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return { allowed: arr.length <= max, remaining: Math.max(0, max - arr.length) };
}
setInterval(() => {
  const cutoff = Date.now() - CREATE_WINDOW_MS;
  for (const [k, arr] of hits) {
    const keep = arr.filter(t => t > cutoff);
    if (keep.length) hits.set(k, keep); else hits.delete(k);
  }
}, 60000).unref();

function _requester(req) {
  return String(req.headers['x-visitor-id'] || req.ip || 'anon').slice(0, 128);
}

// Principal: session user first (policy-routes convention), else the visitor id
// (relay-routes convention), else null = anonymous job (viewable by anyone).
// The session lookup only runs when server.js is already loaded — a standalone
// require of this file (tests) never boots the gateway.
async function _principal(req) {
  try {
    const serverPath = require.resolve('../server');
    if (require.cache[serverPath]) {
      const s = await require('../server').getSession(req);
      if (s && s.userId) return 'user:' + s.userId;
    }
  } catch (_e) { /* fall through to visitor id */ }
  const v = req.headers['x-visitor-id'];
  return v ? String(v).slice(0, 128) : null;
}

// Admin: hub-local (relay's isLocal bypass) or control-token (timing-safe).
function _isAdmin(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip.includes('127.0.0.1') || ip.includes('::1')) return true;
  const t = req.headers['x-control-token'];
  return Boolean(CONTROL_TOKEN && t && timingSafeEq(t, CONTROL_TOKEN));
}

// A coder bee: online + explicitly opted in + actually runs OpenCode.
// (The 'relay'/'volunteer' flags are consent — never infer them; `tools` is
// what the bee has advertised, exactly what capabilities.js derives from.)
function _coderOk(n) {
  if (!n || n.status !== 'online') return false;
  if (!(n.volunteer === true || n.volunteer?.on === true)) return false;
  return Array.isArray(n.tools) && n.tools.includes('opencode');
}

function activeForNode(nodeId) {
  let n = 0;
  for (const j of store.values()) {
    if (j.nodeId === nodeId && (j.status === 'queued' || j.status === 'running')) n++;
  }
  return n;
}

function _expire(j) {
  j.status = 'expired';
  j.error = 'node did not report in time';
  console.log(`[CODING] job ${j.id} expired (node ${j.nodeId} did not report in time)`);
  return j;
}

// Lazy expiry on access (plus relay's read-time running heuristic — but only
// while the bee is still online: offline mid-job → stays queued until expiry).
function _touch(j) {
  const now = Date.now();
  if (j.status !== 'queued' && j.status !== 'running') return j;
  if (now > j.expiresAt) return _expire(j);
  if (j.status === 'queued' && now - j.createdAt > RUNNING_AFTER_MS) {
    const node = orchestrator?.nodes?.get(j.nodeId);
    if (node && node.status === 'online') j.status = 'running';
  }
  return j;
}

// Janitor (mirrors lib/relay.js): expire stale jobs, then drop corpses.
function _sweep() {
  const now = Date.now();
  for (const [id, j] of store) {
    if (now > j.expiresAt) {
      if (j.status === 'queued' || j.status === 'running') _expire(j);
      if (now > j.expiresAt + FINISHED_GRACE_MS) store.delete(id);
    }
  }
}
setInterval(_sweep, 5000).unref();

function _jobPublic(j) {
  return {
    job_id: j.id,
    status: j.status,
    node_id: j.nodeId,
    result: j.result || null,
    error: j.error || null,
    created_at: j.createdAt,
    expires_at: j.expiresAt,
  };
}

// ── POST /api/coding/jobs — validate → policy gate → dispatch to a coder bee ─
router.post('/jobs', express.json({ limit: '48kb' }), async (req, res) => {
  const rl = _limit(`c:${_requester(req)}`, CREATE_MAX, CREATE_WINDOW_MS);
  if (!rl.allowed) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'coding rate limit — 20 jobs/min', retry_after_s: 60 });
  }

  const body = req.body || {};
  // Validate BEFORE the gate: never mint a grant for a malformed request.
  const task = typeof body.task === 'string' ? body.task : '';
  if (!task.trim()) return res.status(400).json({ error: 'task required' });
  if (task.length > MAX_TASK_CHARS) {
    return res.status(400).json({ error: `task too long (max ${MAX_TASK_CHARS} chars)` });
  }
  const repo = body.repo;
  if (!repo || typeof repo !== 'object') {
    return res.status(400).json({ error: 'repo required ({url, ref?, subdir?})' });
  }
  if (typeof repo.url !== 'string' || !repo.url.trim()) {
    return res.status(400).json({ error: 'repo.url required (git URL or local path)' });
  }
  if (repo.url.length > MAX_REPO_URL_CHARS) {
    return res.status(400).json({ error: `repo.url too long (max ${MAX_REPO_URL_CHARS} chars)` });
  }
  let ref, subdir;
  if (repo.ref !== undefined && repo.ref !== null) {
    if (typeof repo.ref !== 'string') return res.status(400).json({ error: 'repo.ref must be a string' });
    ref = repo.ref.slice(0, 256);
  }
  if (repo.subdir !== undefined && repo.subdir !== null) {
    if (typeof repo.subdir !== 'string') return res.status(400).json({ error: 'repo.subdir must be a string' });
    subdir = repo.subdir.slice(0, 512);
  }
  const timeout_s = _clampInt(body.timeout_s, 60, 1800, 600);
  const mode = typeof body.mode === 'string' && body.mode ? body.mode.slice(0, 64) : undefined;

  // §3 policy gate — capability 'coding' (deny → 403, ask → 202 MAYBE + grant).
  const principal = await _principal(req);
  let verdict;
  try {
    verdict = await policy.gate({
      capability: 'coding',
      principal: principal || 'visitor',
      transport: 'relay',
      via: 'coding',
      ...(mode ? { mode } : {}),
      args_summary: { repo: repo.url.trim(), task_chars: task.length },
    });
  } catch (e) {
    // Fail closed: dispatching code-writing work never proceeds on a gate error.
    return res.status(503).json({ error: `policy gate unavailable — refusing to dispatch coding job: ${e.message}` });
  }
  if (verdict.verdict === 'deny') {
    return res.status(403).json({ error: 'coding denied: ' + (verdict.rule || 'policy') });
  }
  if (verdict.verdict === 'ask') {
    return res.status(202).json({
      verdict: 'MAYBE',
      grant_id: verdict.grant_id,
      message: 'human approval required — hivv approve ' + verdict.grant_id,
    });
  }

  // ── dispatch: online + opted-in bees that actually run OpenCode ───────────
  if (!orchestrator || !orchestrator.nodes) return res.status(503).json({ error: 'not ready' });
  if (typeof orchestrator.enqueueInbox !== 'function') {
    return res.status(400).json({ error: 'node inbox not available' });
  }
  const candidates = Array.from(orchestrator.nodes.values()).filter(_coderOk);
  if (!candidates.length) {
    // Never fall back to nodes without `opencode` — they can't run the task.
    return res.status(409).json({
      error: 'no coder bees online',
      hint: 'run `hivv volunteer coding` on a node with OpenCode installed',
    });
  }
  const eligible = candidates.filter(n => activeForNode(n.node_id) < MAX_ACTIVE_PER_NODE);
  if (!eligible.length) {
    res.set('Retry-After', '30');
    return res.status(429).json({ error: 'all coder bees busy', retry_after_s: 30 });
  }
  // Prefer the least-busy bee; break ties at random so load spreads.
  const minLoad = Math.min(...eligible.map(n => activeForNode(n.node_id)));
  const best = eligible.filter(n => activeForNode(n.node_id) === minLoad);
  const node = best[Math.floor(Math.random() * best.length)];

  const job_id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const repoClean = { url: repo.url.trim() };
  if (ref !== undefined) repoClean.ref = ref;
  if (subdir !== undefined) repoClean.subdir = subdir;
  const job = {
    id: job_id, secret, status: 'queued',
    task, repo: repoClean, timeout_s,
    nodeId: node.node_id, principal,
    createdAt: now, expiresAt: now + (timeout_s + TTL_PAD_S) * 1000,
    result: null, error: null, completedAt: null,
  };
  store.set(job_id, job);
  try {
    // Same enqueue path as relay (inbox-routes long-poll inbox).
    orchestrator.enqueueInbox(node.node_id, {
      type: 'coding_job',
      payload: { job_id, secret, task, repo: repoClean, timeout_s },
    });
  } catch (e) {
    store.delete(job_id);
    return res.status(400).json({ error: 'node inbox not available: ' + e.message });
  }
  console.log(`[CODING] job ${job_id} dispatched to ${node.node_id} (timeout ${timeout_s}s)`);
  res.status(202).json({ job_id, node_id: node.node_id, status: 'queued', poll: `GET /api/coding/jobs/${job_id}` });
});

// ── GET /api/coding/jobs/:id — poll status + result ──────────────────────────
router.get('/jobs/:id', async (req, res) => {
  const rl = _limit(`r:${_requester(req)}`, READ_MAX, READ_WINDOW_MS);
  if (!rl.allowed) return res.status(429).json({ error: 'poll rate limit', retry_after_s: 30 });

  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  _touch(job);

  // Owner check (relay B2 pattern): anonymous jobs are public; owned jobs
  // belong to their requester — control-token / localhost admins see all.
  if (job.principal && !_isAdmin(req)) {
    const cur = await _principal(req);
    if (cur !== job.principal) return res.status(403).json({ error: 'not your job' });
  }
  res.json(_jobPublic(job));
});

// ── POST /api/coding/jobs/:id/result — the bee posts its patch back ──────────
router.post('/jobs/:id/result', express.json({ limit: '1mb' }), (req, res) => {
  const rl = _limit(`x:${_requester(req)}`, RESULT_MAX, READ_WINDOW_MS);
  if (!rl.allowed) return res.status(429).json({ error: 'result rate limit', retry_after_s: 60 });

  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const { secret, result } = req.body || {};
  // Timing-safe per-job secret (relay.js pattern) — only the dispatched bee has it.
  if (!timingSafeEq(secret, job.secret)) return res.status(401).json({ error: 'bad secret' });

  _touch(job); // lazy expiry: a result after TTL is a 410, never a completion
  if (job.status === 'expired') return res.status(410).json({ error: 'job expired' });
  if (job.status === 'done' || job.status === 'error') {
    return res.status(409).json({ error: 'job already finished' });
  }

  if (!result || typeof result !== 'object') {
    return res.status(400).json({ error: 'result required ({status, summary, patch, files_changed})' });
  }
  const st = result.status;
  if (st !== 'ok' && st !== 'error') {
    return res.status(400).json({ error: "result.status must be 'ok' or 'error'" });
  }

  const summary = String(result.summary || '').slice(0, MAX_SUMMARY_CHARS);
  const rawPatch = typeof result.patch === 'string' ? result.patch : '';
  const patch = rawPatch.slice(0, MAX_PATCH_CHARS);
  const files_changed = (Array.isArray(result.files_changed) ? result.files_changed : [])
    .map(f => String(f).slice(0, MAX_FILE_CHARS))
    .slice(0, MAX_FILES);
  const stored = {
    status: st,
    summary,
    patch,
    patch_truncated: rawPatch.length > MAX_PATCH_CHARS,
    files_changed,
  };
  if (result.tests && typeof result.tests === 'object') {
    stored.tests = {
      ran: Math.max(0, Math.floor(Number(result.tests.ran) || 0)),
      passed: Math.max(0, Math.floor(Number(result.tests.passed) || 0)),
    };
  }
  if (result.session_id !== undefined && result.session_id !== null) {
    stored.session_id = String(result.session_id).slice(0, 256);
  }
  if (result.usage && typeof result.usage === 'object') {
    stored.usage = {
      input_tokens: Math.max(0, Math.floor(Number(result.usage.input_tokens) || 0)),
      output_tokens: Math.max(0, Math.floor(Number(result.usage.output_tokens) || 0)),
    };
  }

  job.status = st === 'ok' ? 'done' : 'error';
  job.result = stored;
  job.error = st === 'error' ? (summary || 'coding job failed') : null;
  job.completedAt = Date.now();

  const nodeName = orchestrator?.nodes?.get(job.nodeId)?.name || job.nodeId;
  if (st === 'ok') {
    console.log(`[CODING] job ${job.id} done by ${nodeName} (${files_changed.length} files)`);
  } else {
    console.log(`[CODING] job ${job.id} error by ${nodeName}: ${summary.slice(0, 120)}`);
  }
  res.json({ ok: true, status: job.status });
});

// ── GET /api/coding/stats — queue health (relay /api/relay/stats shape) ──────
router.get('/stats', (req, res) => {
  _sweep();
  const counts = { queued: 0, running: 0, done: 0, error: 0, expired: 0 };
  const active_per_node = {};
  for (const j of store.values()) {
    if (counts[j.status] !== undefined) counts[j.status]++;
    if (j.status === 'queued' || j.status === 'running') {
      active_per_node[j.nodeId] = (active_per_node[j.nodeId] || 0) + 1;
    }
  }
  res.json({ ...counts, total: store.size, active_per_node });
});

module.exports = router;
