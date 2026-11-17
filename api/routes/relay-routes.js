// api/routes/relay-routes.js — HTTP surface for NAT relay (#5).
// Mounted at /api/relay.
//
//   POST /api/relay/jobs          {node_id, request:{messages,...}} → {job}
//   GET  /api/relay/jobs/:id      poll status + result
//   POST /api/relay/jobs/:id/result  {secret, result|error}  (node side)
//   GET  /api/relay/volunteers    online nodes that accept relay work
//   GET  /api/relay/stats         queue health

const express = require('express');
const router = express.Router();

const relay = require('../lib/relay');
const policy = require('../lib/policy');

let orchestrator = null;
router.inject = (orch) => { orchestrator = orch; relay.setOrchestrator(orch); };

// ── B1: per-requester sliding-window limiter (HIVV_BACKLOG) ──────────
// Abuse vector: this is a public endpoint on the hub. Jobs are also
// size-limited + capped at 2 concurrent per node (relay.js), but without
// a request budget anyone could spam the volunteer inboxes.
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_MAX = 10;          // job creates / minute / requester
const READ_WINDOW_MS = 60 * 1000;
const READ_MAX = 120;           // polls / minute / requester
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

function _volunteerOk(n) {
  // a relay candidate: online, hosts at least one local model, EXPLICITLY opted in.
  // The 'relay' capability only means the node *supports* relay jobs — never consent.
  if (n.status === 'offline') return false;
  if (!(n.local_models || []).length) return false;
  return n.volunteer === true || n.volunteer?.on === true;
}

router.get('/volunteers', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'not ready' });
  const list = Array.from(orchestrator.nodes.values())
    .filter(_volunteerOk)
    .map(n => ({ id: n.node_id, name: n.name, status: n.status,
                 models: (n.local_models || []).map(m => m.name || m.model).filter(Boolean),
                 active_relay_jobs: relay.activeForNode(n.node_id) }));
  res.json({ total: list.length, volunteers: list });
});

router.post('/jobs', express.json({ limit: '48kb' }), async (req, res) => {
  const rl = _limit(`c:${_requester(req)}`, CREATE_MAX, CREATE_WINDOW_MS);
  if (!rl.allowed) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'relay rate limit — 10 jobs/min', retry_after_s: 60 });
  }
  // F4: gate relay jobs through policy (capability check before creating job)
  const visitorId = req.headers['x-visitor-id'] || 'visitor';
  const verdict = await policy.gate({ capability: 'reasoning', principal: visitorId, transport: 'relay', via: 'relay' });
  if (verdict.verdict === 'deny') {
    return res.status(403).json({ error: 'relay denied: ' + (verdict.rule || 'policy') });
  }
  if (verdict.verdict === 'ask') {
    return res.status(202).json({ error: 'relay pending approval: ' + (verdict.rule || 'grant required') });
  }
  const { node_id, request } = req.body || {};
  if (!node_id || !request) return res.status(400).json({ error: 'node_id and request required' });
  const node = orchestrator?.nodes.get(node_id);
  if (!node) return res.status(404).json({ error: 'unknown node' });
  if (!_volunteerOk(node)) return res.status(403).json({ error: 'node is not a relay volunteer (needs volunteer on + a local model)' });
  const out = relay.createJob({ nodeId: node_id, request, requester: visitorId });
  if (out.error) return res.status(out.busy ? 429 : 400).json({ error: out.error });
  res.json(out);
});

router.get('/jobs/:id', (req, res) => {
  const rl = _limit(`r:${_requester(req)}`, READ_MAX, READ_WINDOW_MS);
  if (!rl.allowed) return res.status(429).json({ error: 'poll rate limit', retry_after_s: 30 });
  const job = relay.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  // B2: jobs created over HTTP belong to their requester (router-created
  // jobs have requester=null — their caller already holds the streamed result)
  const owner = relay.getJobOwner(req.params.id);
  const ip = req.ip || '';
  const isLocal = ip.includes('127.0.0.1') || ip.includes('::1');
  if (owner && !isLocal && req.headers['x-visitor-id'] !== owner) {
    return res.status(403).json({ error: 'not your job' });
  }
  res.json({ job });
});

router.post('/jobs/:id/result', express.json({ limit: '64kb' }), (req, res) => {
  const { secret, result, error } = req.body || {};
  const out = relay.completeJob(req.params.id, { secret, result, error });
  if (out.error) return res.status(out.error === 'job not found' ? 404 : 400).json({ error: out.error });
  res.json({ ok: true, status: out.job.status });
});

router.get('/stats', (req, res) => {
  res.json(relay.stats());
});

module.exports = router;
