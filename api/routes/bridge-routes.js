// api/routes/bridge-routes.js — hive-to-hive load & allowance (open-hives/0.1).
//
// WHO THIS IS FOR
// ───────────────
// Other hives (starting with kwaai / KwaaiNet) that want to know how busy we
// are BEFORE they send work, and how much of our traffic they may use right
// now — without asking a single bee. Two GETs, both cheap:
//
//   GET /api/bridge/load          zero-DB glance: cluster/capacity/relay
//   GET /api/bridge/allowance     dynamic 0..85% for one peer hive
//
// DESIGN RULES (from the house laws)
// ──────────────────────────────────
//   * Reads IN-MEMORY counters only; at most one indexed latency query, and
//     even that is raced against a short deadline so a wedged pool can never
//     hang a peer hive's poller (the 2026-11-22 outage lesson).
//   * Explicit Cache-Control — guests poll this every 60s.
//   * Local-first: with no database attached it still answers from memory.
//   * No PII, no node secrets, no key material. Counts only.
//   * Numbers are rounded: floats never enter a signed envelope later.
//
// The allowance tier rule (the "nice" dynamic rule):
//   success < 99% or latency > 10s  -> 0%      (busy: guests back off)
//   latency 3–10s                   -> ceiling x 0.25
//   latency 1–3s                    -> ceiling x 0.50
//   latency <= 1s                   -> ceiling (20% steady, 85% supervised)
// The authoritative value wins whenever the peer hive publishes its own
// allowance for us at /.well-known/hive.json — guests always obey the host.

const express = require('express');

const router = express.Router();

const BRIDGE_API_VERSION = 'open-hives/0.1';
const HIVV_VERSION = process.env.HIVV_VERSION || '2.0.0';

// Ceilings: steady-state is polite (20%), supervised test mode is generous
// (85%). A human flips this; nothing automatic ever raises it.
const CEILING = { steady: 0.20, supervised: 0.85 };
const PEER_ALLOWANCE_MODE = process.env.HIVV_BRIDGE_MODE === 'supervised' ? 'supervised' : 'steady';

let pool = null;
let routerRef = null;
let orchestrator = null;
router.inject = (p, r, orch) => {
    pool = p; routerRef = r; orchestrator = orch;
};

function meta(extra = {}) {
    return {
        version: BRIDGE_API_VERSION,
        hivv_version: HIVV_VERSION,
        generated_at: new Date().toISOString(),
        ...extra,
    };
}

// One indexed latency window, raced against a deadline. Returns null rather
// than hanging: a guest must get "unknown, retry later", never a stall.
async function latencyWindow(timeoutMs = 600) {
    if (!pool) return null;
    try {
        const q = pool.query(
            "SELECT COUNT(*)::int AS requests, " +
            "AVG(latency_ms) FILTER (WHERE status='success' AND latency_ms > 0) AS avg_ms, " +
            "COALESCE(100.0 * AVG((status = 'success')::int), 100) AS ok_pct " +
            "FROM usage_logs WHERE created_at > NOW() - INTERVAL '5 minutes'"
        );
        const timeout = new Promise((_r, rej) =>
            setTimeout(() => rej(new Error('latency window timeout')), timeoutMs));
        const { rows } = await Promise.race([q, timeout]);
        const row = rows && rows[0];
        if (!row) return null;
        return {
            requests: row.requests || 0,
            avg_ms: row.avg_ms == null ? null : Math.round(Number(row.avg_ms)),
            ok_pct: Math.round(Number(row.ok_pct == null ? 100 : row.ok_pct)),
        };
    } catch (_e) {
        return null; // local-first: memory answers instead
    }
}

// In-memory fallback so a no-DB install still publishes a sane signal.
function memoryLoad() {
    const out = { source: 'memory' };
    try {
        if (orchestrator && typeof orchestrator.getGlobalStats === 'function') {
            const g = orchestrator.getGlobalStats();
            out.cluster = g.cluster || null;
            out.capacity = g.capacity || null;
            out.performance = g.performance || null;
        }
    } catch (_e) { /* counters reset mid-read is fine */ }
    try {
        const relay = require('../lib/relay');
        if (relay && typeof relay.stats === 'function') out.relay = relay.stats();
    } catch (_e) { /* relay is optional */ }
    try {
        const eps = routerRef && routerRef.localEndpoints;
        if (Array.isArray(eps)) out.local_endpoints = eps.length;
    } catch (_e) { /* ignore */ }
    return out;
}

// ── GET /api/bridge/load ──────────────────────────────────────────────────
// The cheapest honest answer to "how busy are you?". Memory first; the
// latency window is added only if it answers inside the deadline.
router.get('/load', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=10');
    const [win] = await Promise.all([latencyWindow()]);
    const load = memoryLoad();
    res.json(meta({
        hive: 'hivv.org',
        mode: PEER_ALLOWANCE_MODE,
        latency_5m: win,
        ...load,
    }));
});

// ── GET /api/bridge/allowance?peer=<name> ─────────────────────────────────
// The authoritative number a guest obeys. Tiered on the 5-minute window;
// falls back to "calm ceiling" only when we genuinely cannot measure (a
// guest then stays within the conservative ceiling either way).
router.get('/allowance', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=10');
    const peer = String((req.query && req.query.peer) || 'anonymous').slice(0, 64);
    const ceiling = CEILING[PEER_ALLOWANCE_MODE];
    const win = await latencyWindow();

    let percent, reason;
    if (!win) {
        percent = Math.round(ceiling * 100);
        reason = 'unmeasured: using conservative ceiling';
    } else if (win.ok_pct < 99 || (win.avg_ms != null && win.avg_ms > 10000)) {
        percent = 0;
        reason = `busy: latency ${win.avg_ms}ms, success ${win.ok_pct}%`;
    } else if (win.avg_ms != null && win.avg_ms > 3000) {
        percent = Math.round(ceiling * 0.25 * 100);
        reason = `loaded: latency ${win.avg_ms}ms`;
    } else if (win.avg_ms != null && win.avg_ms > 1000) {
        percent = Math.round(ceiling * 0.50 * 100);
        reason = `moderate: latency ${win.avg_ms}ms`;
    } else {
        percent = Math.round(ceiling * 100);
        reason = `calm: latency ${win.avg_ms}ms, success ${win.ok_pct}%`;
    }

    res.json(meta({
        hive: 'hivv.org',
        peer,
        percent,
        reason,
        mode: PEER_ALLOWANCE_MODE,
        retry_after_s: percent === 0 ? 60 : 0,
        receipts_required: true,
        latency_5m: win,
    }));
});

// ── bridges: any node may propose one; we always try; failures go public ──
const ssrf = require('../lib/ssrf');

const ALLOWED_SCOPES = new Set(['hive', 'local']);
const FETCH_TIMEOUT_MS = 5000;
const RECHECK_MS = 10 * 60 * 1000;   // re-verify every bridge every 10 minutes
let peersCache = { at: 0, value: null };

function timedFetch(url) {
    // Manual abort instead of AbortSignal.timeout: works on every Node the
    // gateway has ever run on, and a hung remote must never hang our route.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    return ssrf.safeFetch(url, { signal: ctrl.signal })
        .finally(() => clearTimeout(timer));
}

function normaliseRemote(input) {
    let raw = String(input || '').trim().toLowerCase();
    if (!raw) return null;
    if (!/^https?:\/\//.test(raw)) raw = 'https://' + raw;
    let u;
    try { u = new URL(raw); } catch (_e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.pathname !== '/' || u.search || u.hash) return null;  // origin only
    return { url: u.origin, hive: u.hostname };
}

// The heart of "try and connect no matter what": one attempt, always recorded.
async function attemptVerify(row) {
    const t0 = Date.now();
    try {
        // Two doors, same content: our branded /.bridge first, then the
        // IETF-standard /.well-known slot (RFC 8615).
        let manifest = null, lastErr = null;
        const doors = [];
        if (row.manifest_url) doors.push(row.manifest_url);   // explicit door first (git-hosted hives)
        doors.push('/.bridge/hivv.json', '/.well-known/hivv.json', '/.well-known/hive.json');
        for (const path of doors) {
            try {
                const url = /^https?:\/\//.test(path) ? path : row.remote_url + path;
                const res = await timedFetch(url);
                if (!res.ok) { lastErr = new Error(path + ' HTTP ' + res.status); continue; }
                const j = await res.json();
                if (j && typeof j === 'object') { manifest = j; break; }
            } catch (e) { lastErr = e; }
        }
        if (!manifest) throw lastErr || new Error('no manifest found');
        const proto = String(manifest.protocol || '');
        if (!proto.startsWith('open-hive')) throw new Error('bad protocol: ' + (proto || 'none'));

        let percent = null;
        try {
            const a = await timedFetch(row.remote_url + '/api/bridge/allowance?peer=hivv.org');
            if (a.ok) percent = (await a.json()).percent;
        } catch (_e) { /* allowance is optional; the manifest is the gate */ }

        return {
            ok: true, protocol: proto, endpoints: manifest.endpoints || null,
            latency_ms: Date.now() - t0, allowance_percent:
                percent == null ? null : Math.round(Number(percent)),
            reason: null,
        };
    } catch (e) {
        const reason = String((e && e.message) || e).slice(0, 200);
        return { ok: false, reason, latency_ms: Date.now() - t0 };
    }
}

async function recordAttempt(poolRef, row, a) {
    try {
        await poolRef.query(
            'INSERT INTO hivv_bridge_attempts (bridge_id, ok, reason, latency_ms) VALUES ($1,$2,$3,$4)',
            [row.id, a.ok, a.reason, a.latency_ms]);
        await poolRef.query(
            'UPDATE hivv_bridges SET status=$2, status_reason=$3, protocol=$4, latency_ms=$5, ' +
            'allowance_percent=$6, endpoints=$7, last_check_at=NOW() WHERE id=$1',
            [row.id, a.ok ? 'verified' : 'failed', a.reason, a.protocol || null,
             a.latency_ms, a.allowance_percent,
             a.endpoints ? JSON.stringify(a.endpoints) : null]);
    } catch (_e) { /* a failed bookkeeping write must not break the request */ }
}

// Best effort: if they publish a submit endpoint and the reporter left a note,
// hand the idea back to the remote hive. Never blocks the response.
function relaySuggestion(row, note) {
    if (!note || !row.endpoints || !row.endpoints.submit) return;
    const payload = JSON.stringify({
        id: 'suggest_' + Date.now().toString(36),
        kind: 'suggestion',
        payload: { note: String(note).slice(0, 2000), from: 'hivv.org', about: row.remote_hive },
        ttl_s: 86400,
    });
    timedFetch(row.remote_url + String(row.endpoints.submit)).then(async (res) => {
        if (!res.ok) return;
        try {
            await pool.query(
                'INSERT INTO hivv_bridge_attempts (bridge_id, ok, reason, latency_ms) VALUES ($1,true,$2,0)',
                [row.id, 'suggestion relayed: ' + String(note).slice(0, 120)]);
        } catch (_e) { /* ignore */ }
    }).catch(() => { /* unreachable remote — the failure is already recorded */ });
}

// POST /api/bridges — propose a bridge. Always attempts. scope honoured.
router.post('/bridges', async (req, res) => {
    if (!pool) return res.status(503).json({ error: { message: 'no database (local install)' } });
    const body = req.body || {};
    const norm = normaliseRemote(body.remote);
    if (!norm) return res.status(400).json({ error: { message: 'remote must be a bare host or https origin' } });
    const scope = ALLOWED_SCOPES.has(body.scope) ? body.scope : 'hive';
    const requestedBy = String(body.requested_by || 'anonymous').slice(0, 64);
    const note = body.note ? String(body.note).slice(0, 2000) : null;
    const manifestUrl = body.manifest_url ? String(body.manifest_url).slice(0, 300) : null;
    if (manifestUrl && !/^https:\/\/[a-z0-9.-]+(:[0-9]+)?\//i.test(manifestUrl)) {
        return res.status(400).json({ error: { message: 'manifest_url must be a plain https URL' } });
    }

    let row;
    try {
        const up = await pool.query(
            'INSERT INTO hivv_bridges (remote_hive, remote_url, scope, requested_by, note, manifest_url) ' +
            'VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (remote_url) DO UPDATE SET ' +
            'scope=EXCLUDED.scope, requested_by=EXCLUDED.requested_by, note=COALESCE(EXCLUDED.note, hivv_bridges.note) ' +
            ', manifest_url=COALESCE(EXCLUDED.manifest_url, hivv_bridges.manifest_url) ' +
            'RETURNING *',
            [norm.hive, norm.url, scope, requestedBy, note, manifestUrl]);
        row = up.rows[0];
    } catch (e) {
        return res.status(500).json({ error: { message: 'store failed: ' + String(e.message).slice(0, 120) } });
    }

    const a = await attemptVerify(row);
    await recordAttempt(pool, row, a);
    relaySuggestion({ ...row, endpoints: a.endpoints }, note);

    res.status(a.ok ? 201 : 200).json(meta({
        id: row.id, remote: norm.url, scope,
        status: a.ok ? 'verified' : 'failed',
        reason: a.reason, protocol: a.protocol || null,
        latency_ms: a.latency_ms, allowance_percent: a.allowance_percent ?? null,
        listed: a.ok && scope === 'hive',
        hint: a.ok ? null : 'recorded on /api/bridge/problems — study it together',
    }));
});

// GET /api/bridges — the registry. Public sees scope=hive; operator (localhost
// or control token) sees everything with ?scope=all.
router.get('/bridges', async (req, res) => {
    if (!pool) return res.status(503).json({ error: { message: 'no database (local install)' } });
    const isOperator = req.ip === '127.0.0.1' || req.ip === '::1' ||
        req.get('x-control-token') != null;
    const wantAll = isOperator && req.query.scope === 'all';
    try {
        const q = wantAll
            ? 'SELECT * FROM hivv_bridges ORDER BY last_check_at DESC NULLS LAST'
            : "SELECT * FROM hivv_bridges WHERE scope='hive' ORDER BY last_check_at DESC NULLS LAST";
        const { rows } = await pool.query(q);
        res.set('Cache-Control', 'public, max-age=30');
        res.json(meta({
            bridges: rows.map(r => ({
                remote_hive: r.remote_hive, remote_url: r.remote_url, scope: r.scope,
                status: r.status, reason: r.status_reason, protocol: r.protocol,
                latency_ms: r.latency_ms, allowance_percent: r.allowance_percent,
                last_check_at: r.last_check_at,
                visible: wantAll ? undefined : undefined,
            })),
            hidden_local: wantAll ? undefined : undefined,
        }));
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 160) } });
    }
});

// GET /api/bridge/peers — verified, hive-scoped, cached (guests poll this).
router.get('/peers', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=15');
    if (!pool) return res.json(meta({ peers: [] }));
    if (Date.now() - peersCache.at < 15000 && peersCache.value) {
        return res.json(peersCache.value);
    }
    try {
        const { rows } = await pool.query(
            "SELECT remote_hive, remote_url, protocol, latency_ms, allowance_percent, last_check_at " +
            "FROM hivv_bridges WHERE scope='hive' AND status='verified' ORDER BY remote_hive");
        const value = meta({
            peers: rows.map(r => ({
                ...r,
                pulse: peerPulse.byHive[r.remote_hive] || null,
                age_ms: r.last_check_at ? Date.now() - new Date(r.last_check_at).getTime() : null,
            })),
        });
        peersCache = { at: Date.now(), value };
        res.json(value);
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 160) } });
    }
});

// GET /api/bridge/problems — FAILED connection attempts, public on purpose:
// "list all the failures to the public … and study them together".
router.get('/problems', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=30');
    if (!pool) return res.json(meta({ problems: [] }));
    try {
        const { rows } = await pool.query(
            "SELECT b.remote_hive, b.remote_url, b.status_reason, b.requested_by, b.note, " +
            "b.last_check_at, COUNT(a.id)::int AS attempts, " +
            "MAX(a.created_at) AS last_attempt " +
            "FROM hivv_bridges b LEFT JOIN hivv_bridge_attempts a ON a.bridge_id = b.id " +
            "WHERE b.status = 'failed' AND b.scope = 'hive' " +
            "GROUP BY b.id ORDER BY b.last_check_at DESC NULLS LAST LIMIT 100");
        res.json(meta({
            problems: rows.map(r => ({
                remote_hive: r.remote_hive, why: r.status_reason,
                attempts: r.attempts, last_attempt: r.last_attempt,
                idea_from_reporter: r.note || null,   // suggestions welcome
            })),
        }));
    } catch (e) {
        res.status(500).json({ error: { message: String(e.message).slice(0, 160) } });
    }
});

// Re-verify everything every 10 minutes — connections must stay true.
setInterval(async () => {
    if (!pool) return;
    try {
        const { rows } = await pool.query('SELECT * FROM hivv_bridges ORDER BY last_check_at ASC NULLS FIRST LIMIT 20');
        for (const row of rows) {
            const a = await attemptVerify(row);
            await recordAttempt(pool, row, a);
        }
        peersCache = { at: 0, value: null };
    } catch (_e) { /* never let the rechecker throw */ }
}, RECHECK_MS).unref();

// ── GET /api/bridge/heartbeat?peer=<name> — the cross-network pulse ────────
// Built for hives that poll every 30-60s: the work happens on a 5s timer,
// never on the request path. A request just serialises the snapshot —
// microseconds, no DB, no locks. Approximate on purpose: a heartbeat is a
// pulse, not an MRI. age_ms tells the peer how fresh the pulse is; stale
// (>90s) is the failure signal.
const HEARTBEAT_TICK_MS = 5000;
let heartbeatSnap = { generated_at: 0, data: null };

async function buildHeartbeat() {
    const mem = memoryLoad();                       // orchestrator + relay: pure memory
    const win = await latencyWindow(600);           // ONE indexed query, deadline, off-path
    const allow = (() => {
        const c = CEILING[PEER_ALLOWANCE_MODE];
        if (!win) return { percent: Math.round(c * 100), reason: 'unmeasured: conservative ceiling' };
        if (win.ok_pct < 99 || (win.avg_ms != null && win.avg_ms > 10000))
            return { percent: 0, reason: 'busy: ' + win.avg_ms + 'ms / ' + win.ok_pct + '%' };
        if (win.avg_ms != null && win.avg_ms > 3000) return { percent: Math.round(c * 25), reason: 'loaded: ' + win.avg_ms + 'ms' };
        if (win.avg_ms != null && win.avg_ms > 1000) return { percent: Math.round(c * 50), reason: 'moderate: ' + win.avg_ms + 'ms' };
        return { percent: Math.round(c * 100), reason: 'calm: ' + win.avg_ms + 'ms / ' + win.ok_pct + '%' };
    })();
    heartbeatSnap = {
        generated_at: Date.now(),
        data: {
            hive: 'hivv.org',
            mode: PEER_ALLOWANCE_MODE,
            ok: true,
            latency_5m: win,
            cluster: mem.cluster || null,
            capacity: mem.capacity || null,
            relay: mem.relay || null,
            allowance: allow,
        },
    };
}
buildHeartbeat().catch(() => {});
setInterval(() => buildHeartbeat().catch(() => {}), HEARTBEAT_TICK_MS).unref();

router.get('/heartbeat', (req, res) => {
    res.set('Cache-Control', 'public, max-age=5');
    const peer = String((req.query && req.query.peer) || 'anonymous').slice(0, 64);
    const age = heartbeatSnap.data ? Date.now() - heartbeatSnap.generated_at : -1;
    res.json(meta({
        ...heartbeatSnap.data,
        peer,
        age_ms: age < 0 ? null : age,               // stale > 90000 = "peer seems gone"
        beat_ms: HEARTBEAT_TICK_MS,
    }));
});

// ── peer pulse: "can we SEE kwaai?" — yes, from their own state feed ────────
// Every 60s (off the request path) we sample each verified peer's published
// endpoints.state URL. One tiny GET per peer per minute; approximate on
// purpose. This is what puts "kwaai: 4 nodes online" on our pages.
const PEER_PULSE_MS = 60000;
let peerPulse = { at: 0, byHive: {} };

function summarisePeerState(j) {
    // Generic best-effort: count anything that looks like nodes/models,
    // whatever shape the remote hive publishes.
    const out = {};
    try {
        if (Array.isArray(j.model_reports)) {
            let rows = 0, online = 0;
            for (const m of j.model_reports) for (const r of (m.server_rows || [])) {
                rows++; if (r.state === 'online') online++;
            }
            out.models = j.model_reports.length;
            out.server_rows = rows;
            out.online_rows = online;
        }
        if (j.total != null) out.declared_total = j.total;
        if (j.online != null) out.declared_online = j.online;
        if (j.nodes != null && Array.isArray(j.nodes)) {
            out.declared_total = j.nodes.length;
            out.declared_online = j.nodes.filter(n => n.status === 'online').length;
        }
    } catch (_e) { /* foreign schema — show what we got */ }
    return out;
}

async function samplePeerPulses() {
    if (!pool) return;
    try {
        const { rows } = await pool.query(
            "SELECT remote_hive, endpoints FROM hivv_bridges WHERE scope='hive' AND status='verified'");
        const next = { at: Date.now(), byHive: {} };
        for (const row of rows) {
            const stateUrl = row.endpoints && row.endpoints.state;
            if (!stateUrl) continue;
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 4000);
                const res = await ssrf.safeFetch(String(stateUrl), { signal: ctrl.signal });
                clearTimeout(timer);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                next.byHive[row.remote_hive] = { ok: true, ts: Date.now(), ...summarisePeerState(j) };
            } catch (e) {
                next.byHive[row.remote_hive] = { ok: false, ts: Date.now(), error: String(e.message || e).slice(0, 120) };
            }
        }
        peerPulse = next;
    } catch (_e) { /* never let the sampler throw */ }
}
samplePeerPulses().catch(() => {});
setInterval(() => samplePeerPulses().catch(() => {}), PEER_PULSE_MS).unref();

module.exports = router;
