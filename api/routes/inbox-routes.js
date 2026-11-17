// api/routes/inbox-routes.js — long-poll inbox for hivv agents.
//
// Spec (from SITE-NOTES.md):
//   GET    /api/agents/<node_id>/inbox?wait=50   → long-poll; 50s max wait
//   POST   /api/agents/<node_id>/inbox/ack       → body {ids:["m_xxx",...]} → prunes
//
// Auth: per-node secret presented as `x-node-secret` (see lib/node-auth.js).
// Enforcement is automatic and staged: a node is only required to present its
// secret once it has proven it knows one (`secret_seen`), so legacy bees keep
// working until they pick up the new CLI. Previously NONE of this existed —
// the peek/poll/ack endpoints answered anyone on the internet.
//
// Message envelope:
//   {messages: [{id, type, payload, ts}]}
//
// `update_available` payload: {version, url, sha256}

const express = require('express');
const router = express.Router();

let orchestrator = null;
const TTL_MS = 24 * 60 * 60 * 1000;       // 24h
const POLL_DEFAULT_MS = 50 * 1000;        // 50s

// Store: nodeId -> [{id, type, payload, ts}]
// Persisted to disk as well as held in memory: a queued repair plan must
// survive gateway restarts. This hub gets restarted every few minutes during
// dev, and a plan that vanishes mid-flight is indistinguishable from "the bee
// ignored it" — which is exactly what happened before this existed.
const store = new Map();
const INBOX_FILE = require('path').join(__dirname, '..', 'data', 'inbox.json');
let _persistTimer = null;

function _persistSoon() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_persist, 250);
}

function _persist() {
  try {
    const fs = require('fs');
    const obj = {};
    for (const [k, v] of store) obj[k] = v;
    fs.writeFileSync(INBOX_FILE, JSON.stringify(obj));
    try { fs.chmodSync(INBOX_FILE, 0o600); } catch (_e) {}   // payloads carry plan sigs
  } catch (e) { console.error('[INBOX] persist failed:', e.message); }
}

function _load() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(INBOX_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) store.set(k, v);
    const n = [...store.values()].reduce((s, a) => s + a.length, 0);
    if (n) console.log(`[INBOX] restored ${n} pending message(s) across restart`);
  } catch (e) { console.error('[INBOX] restore failed:', e.message); }
}

function _prune(nodeId) {
  const list = store.get(nodeId);
  if (!list) return;
  const cutoff = Date.now() - TTL_MS;
  const kept = list.filter(m => m.ts >= cutoff);
  if (kept.length === 0) store.delete(nodeId);
  else store.set(nodeId, kept);
}

function enqueue(nodeId, msg) {
  const id = 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const full = { id, ts: Date.now(), ...msg };
  const list = store.get(nodeId) || [];
  list.push(full);
  store.set(nodeId, list);
  _prune(nodeId);
  _persistSoon();
  return id;
}

function pending(nodeId) {
  _prune(nodeId);
  return store.get(nodeId) || [];
}

function ack(nodeId, ids) {
  const list = store.get(nodeId);
  if (!list) return 0;
  const before = list.length;
  const kept = list.filter(m => !ids.includes(m.id));
  if (kept.length === 0) store.delete(nodeId);
  else store.set(nodeId, kept);
  _persistSoon();
  return before - kept.length;
}

// Gate every inbox route: only the bee that owns this inbox may read/ack it
// (once enrolled). Responds 403 and returns false on failure.
function nodeSecretGuard(req, res, node) {
  const auth = require('../lib/node-auth').verify(node, req.headers['x-node-secret']);
  if (auth.ok) return true;
  res.status(403).json({ error: 'Forbidden — node secret required for this inbox (x-node-secret)' });
  return false;
}

router.inject = (orch) => {
  orchestrator = orch;
  _load();   // queued plans/messages survive a gateway restart
  // Expose store via orchestrator so other routes (push-update) can enqueue.
  orchestrator.inboxStore = store;
  orchestrator.enqueueInbox = (nodeId, msg) => enqueue(nodeId, msg);
  orchestrator.pendingInbox = (nodeId) => pending(nodeId);
  orchestrator.ackInbox = (nodeId, ids) => ack(nodeId, ids);
};

// Long-poll: GET /api/agents/:nodeId/inbox?wait=50
router.get('/:nodeId/inbox', (req, res) => {
  const nodeId = req.params.nodeId;
  if (!orchestrator) return res.status(503).json({ error: 'inbox not initialized' });
  const node = orchestrator.nodes.get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  if (!nodeSecretGuard(req, res, node)) return;

  const wait = Math.min(parseInt(req.query.wait) || POLL_DEFAULT_MS, POLL_DEFAULT_MS);
  const deadline = Date.now() + wait;
  const POLL_MS = 250;

  const tick = () => {
    if (res.writableEnded || res.destroyed) return;
    const msgs = pending(nodeId);
    if (msgs.length > 0) {
      return res.json({ messages: msgs });
    }
    if (Date.now() >= deadline) {
      return res.json({ messages: [] });
    }
    setTimeout(tick, POLL_MS);
  };

  // Long-poll: hold the request open until messages arrive or wait expires.
  tick();

  // If the client disconnects, abort the polling.
  req.on('close', () => {
    try { res.end(); } catch (_e) {}
  });
});

// Ack: POST /api/agents/:nodeId/inbox/ack  body {ids: ["m_xxx", ...]}
router.post('/:nodeId/inbox/ack', express.json(), (req, res) => {
  const nodeId = req.params.nodeId;
  if (!orchestrator) return res.status(503).json({ error: 'inbox not initialized' });
  const node = orchestrator.nodes.get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  if (!nodeSecretGuard(req, res, node)) return;
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  const pruned = ack(nodeId, ids);
  res.json({ ok: true, pruned });
});

// Debug: GET /api/agents/:nodeId/inbox/peek — list pending without consuming.
// Not part of the SITE-NOTES spec; useful for the dashboard.
router.get('/:nodeId/inbox/peek', (req, res) => {
  const nodeId = req.params.nodeId;
  if (!orchestrator) return res.status(503).json({ error: 'inbox not initialized' });
  const node = orchestrator.nodes.get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  if (!nodeSecretGuard(req, res, node)) return;
  res.json({ messages: pending(nodeId) });
});

module.exports = router;
