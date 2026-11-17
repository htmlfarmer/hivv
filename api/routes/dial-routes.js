// api/routes/dial-routes.js — "connect once, then go direct" (HIVV_OPENCODE_PLAN).
//
// The shim (`hivv dial`, a localhost OpenAI-compatible proxy) calls:
//   POST /api/route/dial   — rarely: scored candidate list (endpoints + stick
//                            keys + tickets) so requests can bypass the hub
//   POST /api/route/report — per request, async: perf + warm-sticky feedback
//                            without being in the hot path
// The routing brain does SELECTION here; the data plane goes point-to-point.
// NAT'd/unreachable bees fall back to the always-last "transport: hub"
// candidate (relay path), so the shim degrades to today's behavior, never dead.

const express = require('express');
const crypto = require('crypto');
const os = require('os');

const router = express.Router();

let orchestrator = null;
let aiRouter = null;
let perfLib = null;
router.inject = (orch, rtr, perf) => { orchestrator = orch; aiRouter = rtr; perfLib = perf; };

const HUB_BASE = (process.env.HIVV_HUB || 'https://hivv.org').replace(/\/+$/, '');
const MODES = ['balanced', 'quality', 'fast', 'cost', 'private', 'trusted'];
const DIAL_SECRET = crypto.randomBytes(32); // per-boot: tickets are freshness tokens, not identity

// simple per-IP dial limiter (dials are rare; 120/min is generous)
const _hits = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const e = _hits.get(ip);
  if (!e || now > e.reset) { _hits.set(ip, { n: 1, reset: now + 60000 }); return false; }
  e.n++;
  if (_hits.size > 5000) for (const [k, v] of _hits) if (now > v.reset) _hits.delete(k);
  return e.n > 120;
}

function _mintTicket(nodeId) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac('sha256', DIAL_SECRET)
    .update(`${nodeId}|${exp}`).digest('base64url');
  return Buffer.from(JSON.stringify({ n: nodeId, e: exp, s: sig })).toString('base64url');
}

// Bearer → user principal (same contract as /v1/chat/completions A2 auth).
async function _principal(req) {
  const h = req.headers.authorization || '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  try {
    const pool = require('../server').pool;
    const r = await pool.query('SELECT id FROM users WHERE api_key = $1 LIMIT 1', [token]);
    return r.rows.length ? `user:${r.rows[0].id}` : null;
  } catch (_e) {
    return null;
  }
}

// ── POST /api/route/dial ─────────────────────────────────────────────────
router.post('/dial', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '?';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'dial rate limit' });
  if (!aiRouter) return res.status(503).json({ error: 'router not ready' });

  const b = req.body || {};
  const mode = MODES.includes(b.mode) ? b.mode : 'balanced';
  const promptEst = Math.max(0, parseInt(b.prompt_est, 10) || 0);
  const tools = !!b.tools;
  const shim = String(b.shim || 'anon').slice(0, 64);
  const shimHost = String(b.shim_host || '').slice(0, 128);
  const principal = `shim:${shim}`; // shim-side stickiness (reports use the same key space)

  try {
    let targets = aiRouter.getAllEndpoints();
    // Hub-local endpoints (localhost:PORT) are only reachable when the shim
    // runs ON this box — hostname match, not IP (Caddy makes every caller
    // look like 127.0.0.1).
    if (shimHost !== os.hostname()) {
      targets = targets.filter(t => !aiRouter._isLocalUrl(t.url));
    }
    // Tool-capability filter — same rule as the chat path (A3), same fallback.
    if (tools && targets.length) {
      const capable = targets.filter(t => aiRouter._toolCapable(t));
      if (capable.length) targets = capable;
    }
    const ordered = await aiRouter._orderByMode(targets, mode, {
      promptEst, tools, principal,
    });

    const candidates = ordered.slice(0, 6).map(t => ({
      transport: 'direct',
      endpoint: t.url,
      node_id: t.nodeId || 'localhost',
      model: t.model || 'local',
      stick_key: aiRouter.stickyKeyFor(t),
      ticket: _mintTicket(t.nodeId || 'localhost'),
    }));
    // Always-present safety net: relay/NAT/direct-fail all land here, which is
    // exactly today's hub path — the shim degrades to status quo, never dead.
    candidates.push({
      transport: 'hub',
      endpoint: `${HUB_BASE}/v1/chat/completions`,
      node_id: 'hub',
      model: 'auto',
      stick_key: null,
      ticket: _mintTicket('hub'),
    });

    const dialId = crypto.randomBytes(8).toString('hex');
    console.log(`[DIAL] ${dialId} shim=${shim} mode=${mode} prompt_est=${promptEst} `
      + `tools=${tools} → ${candidates.length} candidate(s) `
      + `(${candidates.map(c => c.transport === 'hub' ? 'hub' : c.node_id).join(',')})`);
    res.json({ v: 1, dial_id: dialId, candidates });
  } catch (e) {
    console.log(`[DIAL] dial failed: ${e.message}`);
    res.status(500).json({ error: `dial failed: ${e.message}` });
  }
});

// ── POST /api/route/report ───────────────────────────────────────────────
// Async result from the shim: keeps perf + warm-sticky working while the hot
// path bypasses us. Report-only signal — never blocks, never trusted blindly
// (spoofing your own reports only poisons your own routing reputation).
router.post('/report', async (req, res) => {
  const b = req.body || {};
  try {
    const nodeId = String(b.node_id || '').slice(0, 128);
    const model = String(b.model || '').slice(0, 256);
    const stick = String(b.stick_key || '').slice(0, 320);
    const ok = !!b.ok;
    const latencyMs = Math.max(0, parseInt(b.latency_ms, 10) || 0);
    const tps = Math.max(0, parseInt(b.tps, 10) || 0);
    const promptTps = Math.max(0, parseInt(b.prompt_tps, 10) || 0);
    const via = b.transport === 'relay' ? 'relay' : 'direct';
    if (nodeId && model) {
      perfLib?.record({
        node: nodeId, model, tps, latencyMs, ok, via, promptTps,
      });
    }
    if (stick && ok) {
      const shim = String(b.shim || 'anon').slice(0, 64);
      aiRouter?._stickySet({ principal: `shim:${shim}` }, stick);
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e.message).slice(0, 120) });
  }
});

module.exports = router;
