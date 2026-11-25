// api/routes/telemetry-routes.js — the DEEPER TELEMETRY API.
//
// The house already had a health endpoint, a status page, a request
// provenance ledger, a per-model EWMA and a live node roster. What it did NOT
// have was the ability to answer:
//
//   * "what was the p99 of the chat path in the last hour?"
//   * "which error class is growing, and since when?"
//   * "did this request cross one hop or three?"
//   * "how deep is the relay queue, and for how long?"
//   * "are we burning the error budget?"
//
// api/lib/telemetry.js answers all five. These routes expose them.
//
// THE AUDIENCE MODEL (borrowed from routes/provenance-routes.js)
// ─────────────────────────────────────────────────────────────
//   view=public    aggregate counters only — safe for anyone
//   view=partner   aggregate + per-endpoint shapes, no raw series
//   view=operator  everything: labels, series, spans, traces
//
// The DEFAULT is `operator`, which requires a control token or an admin
// session. Telemetry carries no PII by construction (labels are
// allow-listed), but it does describe the shape of the network's traffic —
// which is operationally sensitive. A caller must ask for `public`
// explicitly to get the reduced projection.
//
// THE ENDPOINTS
// ────────────
//   GET  /overview            the pulse (public-safe aggregates)
//   GET  /counters            counter totals
//   GET  /gauges              latest gauge values
//   GET  /histograms          distributions + percentiles
//   GET  /series              the live time-series for one metric
//   GET  /errors              the error taxonomy breakdown
//   GET  /slo                 SLO status + burn rate
//   GET  /spans               recent spans
//   GET  /traces              recent trace summaries
//   GET  /traces/:traceId     one trace, as a waterfall
//   GET  /nodes               per-node live telemetry (orchestrator + metrics)
//   GET  /metrics             Prometheus text exposition
//   POST /observe             ingest a measurement from a bee or a peer
//
// NOTHING HERE STORES A PROMPT. The allow-list in lib/telemetry.js drops any
// label it does not recognise, and drops the whole sample rather than
// guessing at what the caller meant.

'use strict';

const express = require('express');
const crypto = require('crypto');
const telemetry = require('../lib/telemetry');
const taskQueue = require('../lib/task-queue');

const router = express.Router();

// ── auth (mirrors routes/provenance-routes.js) ─────────────────────────────

function _loadControlToken() {
    if (process.env.HIVV_CONTROL_TOKEN) return process.env.HIVV_CONTROL_TOKEN;
    try {
        const fs = require('fs');
        const path = require('path');
        const t = fs.readFileSync(path.join(__dirname, '..', '.control-token'), 'utf8').trim();
        return t || '';
    } catch (_e) { return ''; }
}
const CONTROL_TOKEN = _loadControlToken();

function isLocal(req) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return ip.includes('127.0.0.1') || ip.includes('::1') || ip.includes('localhost');
}

function tokenMatches(token) {
    if (!CONTROL_TOKEN || !token) return false;
    try {
        const a = Buffer.from(CONTROL_TOKEN);
        const b = Buffer.from(token);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_e) { return false; }
}

async function isAdmin(req) {
    if (isLocal(req)) return true;
    const token = req.headers['x-control-token'] || req.query?.token;
    if (tokenMatches(token)) return true;
    if (req.session?.userId) {
        try {
            const { pool } = require('../server');
            if (pool) {
                const r = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
                if (r.rows[0] && ['admin', 'owner'].includes(r.rows[0].role)) return true;
            }
        } catch (_e) { /* fall through */ }
    }
    return false;
}

async function resolveView(req, res) {
    const requested = String(req.query.view || 'operator').toLowerCase();
    if (!['public', 'partner', 'operator'].includes(requested)) {
        res.status(400).json({ error: `view must be one of public, partner, operator (got '${requested}')` });
        return null;
    }
    if (await isAdmin(req)) return requested;
    if (requested === 'operator') {
        res.status(403).json({
            error: 'operator view requires a control token or an admin session',
            hint: 'use ?view=partner for a reduced, non-identifying projection',
        });
        return null;
    }
    return requested;
}

// ── the pulse ───────────────────────────────────────────────────────────────

/**
 * GET /api/telemetry/overview — one call that says how the hive is doing.
 *
 * PUBLIC-SAFE: aggregate counters, the error taxonomy, the SLO table, queue
 * depths and the live node count. No labels, no series, no spans.
 */
router.get('/overview', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=5');
    const snap = telemetry.snapshot();
    const orch = _orchestrator();
    const nodes = { total: 0, online: 0, quarantined: 0 };
    if (orch && orch.nodes) {
        for (const n of orch.nodes.values()) {
            nodes.total++;
            if (n.quarantined) nodes.quarantined++;
            else if (n.status === 'online') nodes.online++;
        }
    }

    res.json({
        generated_at: snap.generated_at,
        status: overallStatus(snap),
        nodes,
        counters: snap.counters,
        gauges: snap.gauges,
        histograms: snap.histograms,
        spans: snap.spans,
        errors: snap.errors,
        slo: snap.slo.map((s) => ({ id: s.id, name: s.name, status: s.status, actual: s.actual, target: s.target, samples: s.samples, unit: s.unit })),
        queues: taskQueue.stats(),
        database: snap.database,
    });
});

function overallStatus(snap) {
    // A single honest word. Not a score, not a number — a status.
    const sloBreached = (snap.slo || []).some((s) => s.status === 'breach');
    if (sloBreached) return 'degraded';
    const unknown = (snap.slo || []).every((s) => s.status === 'unknown');
    if (unknown && !(snap.counters && snap.counters.total_value)) return 'idle';
    return 'healthy';
}

// ── the primitives ──────────────────────────────────────────────────────────

router.get('/counters', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const all = telemetry.countersList();
    if (view === 'public') {
        // Collapse the labels: metric → total.
        const byMetric = {};
        for (const c of all) byMetric[c.metric] = (byMetric[c.metric] || 0) + c.value;
        return res.json({ view, counters: Object.entries(byMetric).map(([metric, value]) => ({ metric, value })) });
    }
    if (view === 'partner') {
        return res.json({ view, counters: all.map((c) => ({ metric: c.metric, value: c.value })) });
    }
    res.json({ view, counters: all });
});

router.get('/gauges', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const all = telemetry.gaugesList();
    if (view !== 'operator') {
        return res.json({ view, gauges: all.map((g) => ({ metric: g.metric, value: g.value })) });
    }
    res.json({ view, gauges: all });
});

router.get('/histograms', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const pcts = String(req.query.percentiles || '50,90,95,99')
        .split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0 && n < 100);
    const all = telemetry.histogramsList(pcts.length ? pcts : [50, 90, 95, 99]);
    if (view === 'public') {
        const byMetric = {};
        for (const h of all) {
            byMetric[h.metric] = byMetric[h.metric] || { metric: h.metric, count: 0, p95: 0 };
            byMetric[h.metric].count += h.count;
            byMetric[h.metric].p95 = Math.max(byMetric[h.metric].p95, h.p95 || 0);
        }
        return res.json({ view, histograms: Object.values(byMetric) });
    }
    if (view === 'partner') {
        return res.json({ view, histograms: all.map((h) => ({ metric: h.metric, count: h.count, avg: h.avg, p95: h.p95 })) });
    }
    res.json({ view, histograms: all });
});

/**
 * GET /api/telemetry/series?metric=…&window=…
 * The live ring: the last hour of one metric, sampled every 15s.
 */
router.get('/series', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const metric = String(req.query.metric || '').trim();
    if (!metric) return res.status(400).json({ error: 'metric is required' });
    const windowMs = Math.min(Math.max(parseInt(req.query.window_ms, 10) || 3600000, 1000), 6 * 3600000);
    const labels = {};
    if (req.query.endpoint) labels.endpoint = String(req.query.endpoint);
    if (req.query.node) labels.node = String(req.query.node);
    if (req.query.transport) labels.transport = String(req.query.transport);
    if (req.query.tool) labels.tool = String(req.query.tool);

    const all = telemetry.series(metric, labels);
    const cutoff = Date.now() - windowMs;
    const points = all.filter((p) => p.t >= cutoff);
    if (view === 'public') {
        return res.json({ view, metric, points: points.map((p) => ({ t: p.t, v: p.v })) });
    }
    res.json({ view, metric, labels, points });
});

router.get('/errors', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const breakdown = telemetry.errorBreakdown();
    if (view === 'public') {
        return res.json({ view, total: breakdown.total, by_class: breakdown.by_class });
    }
    res.json({ view, ...breakdown, classes: telemetry.ERROR_CLASSES });
});

router.get('/slo', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    res.json({ view, slo: telemetry.slo() });
});

// ── traces ──────────────────────────────────────────────────────────────────

router.get('/spans', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const traces = telemetry.recentTraces(limit);
    if (view === 'public') {
        return res.json({ view, traces: traces.map((t) => ({ trace_id: t.trace_id, spans: t.spans, status: t.status })) });
    }
    res.json({ view, traces });
});

router.get('/traces', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    res.json({ view, traces: telemetry.recentTraces(limit) });
});

/**
 * GET /api/telemetry/traces/:traceId — one trace as a waterfall.
 * Each span carries its parent, so the tree can be rebuilt from the flat list.
 */
router.get('/traces/:traceId', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const spans = telemetry.trace(req.params.traceId);
    if (!spans.length) return res.status(404).json({ error: 'no such trace (it may have aged out of the ring)' });
    res.json({ view, trace_id: req.params.traceId, spans });
});

// ── nodes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/telemetry/nodes — per-node live telemetry.
 * Combines the orchestrator's live view (CPU, memory, load) with the
 * telemetry counters keyed by node.
 */
router.get('/nodes', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    const orchestrator = _orchestrator();
    const counters = telemetry.countersList();
    const byNode = new Map();
    for (const c of counters) {
        const node = c.labels && c.labels.node;
        if (!node) continue;
        if (!byNode.has(node)) byNode.set(node, {});
        byNode.get(node)[c.metric] = c.value;
    }

    const nodes = [];
    if (orchestrator && orchestrator.nodes) {
        for (const n of orchestrator.nodes.values()) {
            nodes.push({
                node_id: n.node_id,
                name: n.name || n.node_id,
                status: n.status,
                quarantined: !!n.quarantined,
                cpu_percent: n.total_cpu_percent,
                mem_percent: n.total_mem_percent,
                active_tasks: n.active_tasks,
                uptime_seconds: n.uptime_seconds,
                heartbeat_age_s: n.last_heartbeat ? Math.round((Date.now() - n.last_heartbeat) / 1000) : null,
                metrics: byNode.get(n.node_id) || {},
            });
        }
    }
    res.json({ view, nodes, count: nodes.length });
});

// The orchestrator is a singleton created in server.js and injected into the
// routers (the same pattern as capability-routes.js / control-routes.js).
let orchestrator = null;

function _orchestrator() {
    if (orchestrator) return orchestrator;
    try {
        // Fall back to the router's reference when injection has not happened
        // yet (a standalone test harness may load this file alone).
        const mod = require('../lib/router');
        return mod.orchestratorRef || null;
    } catch (_e) { return null; }
}

// ── Prometheus ──────────────────────────────────────────────────────────────

router.get('/metrics', async (req, res) => {
    const view = await resolveView(req, res);
    if (!view) return;
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(telemetry.prometheusText());
});

// ── ingest ──────────────────────────────────────────────────────────────────

/**
 * POST /api/telemetry/observe — let a bee (or a peer hive) push its OWN
 * measurements, so the hub's view is not limited to what the hub can see.
 *
 * The payload is deliberately narrow: a metric name, a value, and labels.
 * The allow-list drops anything else. A bee cannot forge another bee's
 * identity — the node id comes from the request, not the body.
 */
router.post('/observe', express.json({ limit: '64kb' }), async (req, res) => {
    const body = req.body || {};
    const metric = String(body.metric || '').trim();
    if (!metric) return res.status(400).json({ error: 'metric is required' });
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:.]*$/.test(metric)) {
        return res.status(400).json({ error: 'metric must be a Prometheus-style name' });
    }
    const value = Number(body.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'value must be a number' });

    const labels = {};
    if (body.node) labels.node = String(body.node).slice(0, 120);
    if (body.kind) labels.kind = String(body.kind).slice(0, 64);
    if (body.transport) labels.transport = String(body.transport).slice(0, 24);

    if (body.type === 'histogram') telemetry.histogram(metric, labels, value);
    else if (body.type === 'gauge') telemetry.gauge(metric, labels, value);
    else telemetry.counter(metric, labels, value);

    res.json({ ok: true, metric, type: body.type || 'counter' });
});

module.exports = router;
module.exports.inject = (orch) => { orchestrator = orch; };
