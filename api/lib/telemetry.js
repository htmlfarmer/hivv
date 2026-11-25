// api/lib/telemetry.js — DEEPER TELEMETRY: spans, counters, histograms, gauges,
// a live time-series ring, an error taxonomy and SLO evaluation.
//
// WHY THIS EXISTS
// ───────────────
// The hive already knows a LOT: hivv_request_provenance has one durable row
// per request (who, which node, how long, what it cost), hivv_model_perf has
// an EWMA per node+model+transport, hivv_node_stats has lifetime counters,
// and the orchestrator holds a live snapshot of every bee.
//
// What it could NOT answer (the questions that actually matter at 3am):
//
//   * "what was the p99 latency of /v1/chat/completions last hour?"
//       → only AVG existed, and only in a daily rollup.
//   * "which endpoint is failing right now, and with WHAT error?"
//       → errors were a boolean, not a taxonomy.
//   * "did that request cross two hops (hub → relay → bee) or one?"
//       → nothing joined the hops together.
//   * "is the tool loop slower than last week?"
//       → tools recorded nothing at all.
//   * "how deep is the relay queue, and for how long?"
//       → depth was a number in memory; it had no history.
//   * "are we burning our error budget?"
//       → there was no SLO, so there was nothing to burn.
//
// This module is the answer to all six: ONE in-memory core that is always
// available (local-first!), plus an optional Postgres mirror for the parts
// that must survive a restart.
//
// HOUSE LAWS HONOURED HERE
// ───────────────────────
//   * LOCAL-FIRST — with no database attached it still answers every question
//     from memory. `start(null)` is a valid, fully-useful configuration.
//   * PRIVACY — a span carries LABELS (low-cardinality strings), never raw
//     prompts, never raw model output, never an IP. Labels are allow-listed
//     by LABEL_ALLOW and length-capped.
//   * CHEAP — every write is O(1) and synchronous. The DB mirror is batched
//     on a timer; a slow database can never slow a request down.
//   * HONEST — a metric with no samples reports `null`, never 0. "No data" and
//     "measured zero" are different truths and this module never conflates them.
//
// THE FOUR PRIMITIVES
// ──────────────────
//   counter    — monotonic total.  requests_total{endpoint="/v1/chat"}
//   histogram  — distribution.   request_duration_ms{transport="direct"}
//   gauge      — last value.     queue_depth{queue="relay"}
//   span       — one unit of work with a parent.  hub → relay → bee
//
// A SPAN CARRIES A TRACE. That is the whole point: `trace_id` is minted once
// at the edge (or read from a W3C `traceparent` header) and every downstream
// hop inherits it, so a request that crossed a relay and a peer hive still
// reads as ONE story instead of three unrelated rows.

'use strict';

const crypto = require('crypto');

// ── configuration ───────────────────────────────────────────────────────────

const CFG = {
    // Latency buckets (ms). Chosen so the interesting region (10ms–10s) has
    // ~1.6x resolution while the long tail stays cheap.
    latencyBuckets: [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
    sizeBuckets: [256, 1024, 4096, 16384, 65536, 262144, 1048576],

    // A bounded RESERVOIR of raw observations per series. Percentiles are
    // EXACT while the reservoir holds every sample, and bucket-estimated
    // after that. Buckets alone would put a 100ms request in the 50–100
    // bucket and report a p50 of 78 — an honest estimate, but a useless one
    // for a young hive whose whole history fits in memory.
    reservoirSize: 2048,

    // How many distinct label-sets one metric may hold. Beyond this the
    // metric is "hot" and further series are dropped + counted — a runaway
    // label (a raw request id, a URL) must not eat the heap.
    maxSeriesPerMetric: 500,
    // Label name/value caps. Keeps a 4KB label from becoming a 4KB index key.
    maxLabelValueChars: 120,
    maxLabels: 8,

    // Live ring: 240 samples × 15s = 1 hour of chartable history.
    seriesIntervalMs: 15000,
    seriesPoints: 240,

    // Span ring: the last N spans stay queryable so a trace can be assembled
    // after the fact.
    spanRingSize: 2000,

    // DB mirror cadence.
    flushMs: 30000,
};

// Labels we are willing to store. Anything else is dropped (and counted), so
// a future caller cannot accidentally start recording prompt text in a label.
const LABEL_ALLOW = new Set([
    'endpoint', 'method', 'transport', 'route_mode', 'provider', 'model',
    'node', 'node_id', 'answered_by', 'status', 'outcome', 'error_class',
    'capability', 'policy_verdict', 'queue', 'kind', 'tool', 'mcp_method',
    'worker', 'origin', 'hive', 'direction', 'peer', 'state', 'source',
    'agent', 'binding', 'protocol', 'code', 'limit', 'reason', 'class',
]);

// ── error taxonomy ─────────────────────────────────────────────────────────
//
// One stable vocabulary so "what is broken" is answerable by COUNTING rather
// than by reading logs. Order matters: the first matching rule wins.

const ERROR_CLASSES = [
    'timeout',
    'rate_limited',
    'policy_denied',
    'policy_pending',
    'sandbox_denied',
    'not_found',
    'unavailable',
    'upstream_5xx',
    'upstream_4xx',
    'connection',
    'dns',
    'tls',
    'decode',
    'empty_completion',
    'cancelled',
    'validation',
    'auth',
    'unknown',
];

/**
 * Classify an arbitrary error into the stable taxonomy above.
 * @param {any} err
 * @param {{status?: number}} [hint]
 * @returns {string} one of ERROR_CLASSES
 */
function classifyError(err, hint = {}) {
    if (!err) return 'unknown';
    const status = Number(hint.status) || Number(err.status || err.statusCode || err.status_code) || 0;
    const code = String(err.code || '').toUpperCase();
    const name = String(err.name || '').toLowerCase();
    const msg = String(err.message || err.error || err).toLowerCase();

    if (code === 'ETIMEDOUT' || code === 'ETIMEDOUT' || name === 'timeouterror' || /timed? ?out/.test(msg)) return 'timeout';
    if (status === 429 || code === 'RATE_LIMITED' || /rate ?limit|too many requests/.test(msg)) return 'rate_limited';
    if (status === 401 || status === 403 || code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || /unauthorized|forbidden|invalid (api )?key/.test(msg)) {
        // A policy refusal is NOT an auth failure — they are different lessons.
        if (/policy|denied by|refused/.test(msg)) return 'policy_denied';
        return 'auth';
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || /connection refused|reset by peer|socket hang up/.test(msg)) return 'connection';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|dns/.test(msg)) return 'dns';
    if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /tls|ssl|certificate/.test(msg)) return 'tls';
    if (name === 'aborterror' || /aborted/.test(msg)) return 'cancelled';
    if (/policy/.test(msg) && /denied|refused|may not/.test(msg)) return 'policy_denied';
    if (/approval required|maybe/.test(msg)) return 'policy_pending';
    if (/sandbox/.test(msg) && /denied|refused|not allowed/.test(msg)) return 'sandbox_denied';
    if (status === 404 || code === 'NOT_FOUND' || /not found/.test(msg)) return 'not_found';
    if (status === 503 || code === 'SERVICE_UNAVAILABLE' || /unavailable|no healthy|shed/.test(msg)) return 'unavailable';
    if (status >= 500) return 'upstream_5xx';
    if (status >= 400) return 'upstream_4xx';
    if (/empty|no content|blank response/.test(msg)) return 'empty_completion';
    if (/invalid|required|must be|too large|exceeds/.test(msg)) return 'validation';
    return 'unknown';
}

// ── labels ──────────────────────────────────────────────────────────────────

function sanitizeLabelValue(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (s.length > CFG.maxLabelValueChars) s = s.slice(0, CFG.maxLabelValueChars);
    return s;
}

/**
 * Turn a label object into a canonical, order-independent key.
 * Unknown label names are DROPPED (and counted) — the allow-list is the
 * privacy boundary, not a suggestion.
 */
function labelKey(labels) {
    if (!labels) return '';
    const parts = [];
    for (const key of Object.keys(labels).sort()) {
        if (!LABEL_ALLOW.has(key)) continue;
        const val = sanitizeLabelValue(labels[key]);
        if (!val) continue;
        parts.push(`${key}=${val}`);
        if (parts.length >= CFG.maxLabels) break;
    }
    return parts.join(',');
}

function labelObject(key) {
    if (!key) return {};
    const out = {};
    for (const part of key.split(',')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        out[part.slice(0, idx)] = part.slice(idx + 1);
    }
    return out;
}

// ── the store ───────────────────────────────────────────────────────────────

let pool = null;
let flushTimer = null;

const counters = new Map();    // `${metric}|${labelKey}` -> {metric, labels, value, ts}
const gauges = new Map();      // `${metric}|${labelKey}` -> {metric, labels, value, ts}
const histograms = new Map();  // `${metric}|${labelKey}` -> {metric, labels, buckets, counts, sum, count, min, max, ts}
const seriesStore = new Map();      // `${metric}|${labelKey}` -> [ {t, v} ]
const spans = [];              // ring of span records
const errorCounts = new Map(); // error_class -> count
const dropped = { labels: 0, series: 0 };

function _seriesKey(metric, labels) { return `${metric}|${labelKey(labels)}`; }

function _bump(map, metric, labels, apply) {
    const key = _seriesKey(metric, labels);
    let entry = map.get(key);
    if (!entry) {
        if (map.size >= CFG.maxSeriesPerMetric * 8) { dropped.series++; return null; }
        entry = { metric, labels: labelObject(labelKey(labels)), key };
        map.set(key, entry);
    }
    apply(entry);
    entry.ts = Date.now();
    return entry;
}

function _pushSeries(metric, labels, value) {
    const key = _seriesKey(metric, labels);
    let arr = seriesStore.get(key);
    if (!arr) { arr = []; seriesStore.set(key, arr); }
    const now = Date.now();
    const last = arr[arr.length - 1];
    if (last && now - last.t < CFG.seriesIntervalMs) {
        // Same bucket — keep the LATEST value (a gauge) or the SUM (a counter).
        if (metric.endsWith('_total')) last.v += value; else last.v = value;
        return;
    }
    arr.push({ t: now, v: value });
    while (arr.length > CFG.seriesPoints) arr.shift();
}

// ── public: counters ────────────────────────────────────────────────────────

/**
 * Add `delta` to a counter. Returns the new total.
 */
function counter(metric, labels = {}, delta = 1) {
    const d = Number(delta);
    if (!metric || !Number.isFinite(d)) return 0;
    const entry = _bump(counters, metric, labels, (e) => { e.value = (e.value || 0) + d; });
    if (!entry) return 0;
    _pushSeries(metric, labels, d);
    return entry.value;
}

function counterValue(metric, labels = {}) {
    const e = counters.get(_seriesKey(metric, labels));
    return e ? e.value : null;
}

// ── public: gauges ──────────────────────────────────────────────────────────

/** Set a gauge to its latest value. */
function gauge(metric, labels = {}, value = 0) {
    const v = Number(value);
    if (!metric || !Number.isFinite(v)) return;
    const entry = _bump(gauges, metric, labels, (e) => { e.value = v; });
    if (!entry) return;
    _pushSeries(metric, labels, v);
}

function gaugeValue(metric, labels = {}) {
    const e = gauges.get(_seriesKey(metric, labels));
    return e ? e.value : null;
}

// ── public: histograms ──────────────────────────────────────────────────────

function _bucketsFor(metric) {
    if (/bytes|size|payload/.test(metric)) return CFG.sizeBuckets;
    return CFG.latencyBuckets;
}

/**
 * Record one observation into a distribution.
 * @param {string} metric
 * @param {object} labels
 * @param {number} value
 */
function histogram(metric, labels = {}, value = 0) {
    const v = Number(value);
    if (!metric || !Number.isFinite(v)) return;
    const bounds = _bucketsFor(metric);
    const entry = _bump(histograms, metric, labels, (e) => {
        if (!e.buckets || e.buckets.length !== bounds.length) {
            e.buckets = bounds.slice();
            e.counts = new Array(bounds.length).fill(0);
        }
        e.sum = (e.sum || 0) + v;
        e.count = (e.count || 0) + 1;
        if (e.min === undefined || v < e.min) e.min = v;
        if (e.max === undefined || v > e.max) e.max = v;
        let idx = bounds.findIndex((b) => v <= b);
        if (idx < 0) idx = bounds.length - 1;
        e.counts[idx]++;
        // The reservoir keeps the raw values so small series are EXACT.
        if (!e.reservoir) e.reservoir = [];
        if (e.reservoir.length < CFG.reservoirSize) {
            e.reservoir.push(v);
        } else {
            // Reservoir sampling: replace a random slot. Deterministic enough
            // for telemetry and keeps memory flat forever.
            const i = Math.floor(Math.random() * e.count);
            if (i < CFG.reservoirSize) e.reservoir[i] = v;
        }
    });
    if (!entry) return;
}

/**
 * Percentiles.
 *
 * EXACT while the reservoir holds every observation; bucket-INTERPOLATED once
 * the series outgrows it. The result says which it is (`exact: true|false`)
 * so a reader never mistakes an estimate for a measurement.
 *
 * Returns null when there are no samples — never 0.
 */
function percentiles(metric, labels = {}, percentilesWanted = [50, 90, 95, 99]) {
    const e = histograms.get(_seriesKey(metric, labels));
    if (!e || !e.count) return null;
    const total = e.count;
    const reservoir = e.reservoir || [];
    const exact = total > 0 && reservoir.length >= total;

    const out = { exact };
    if (exact) {
        const sorted = reservoir.slice().sort((a, b) => a - b);
        for (const p of percentilesWanted) {
            const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
            out[`p${p}`] = Math.round(sorted[idx]);
        }
    } else {
        const bounds = e.buckets || [];
        const counts = e.counts || [];
        for (const p of percentilesWanted) {
            const rank = (p / 100) * total;
            let cum = 0;
            let value = e.max !== undefined ? e.max : 0;
            for (let i = 0; i < counts.length; i++) {
                const next = cum + counts[i];
                if (rank <= next) {
                    const lower = i === 0 ? 0 : bounds[i - 1];
                    const upper = bounds[i];
                    const within = counts[i] === 0 ? 0 : (rank - cum) / counts[i];
                    value = lower + (upper - lower) * Math.min(1, Math.max(0, within));
                    break;
                }
                cum = next;
            }
            out[`p${p}`] = Math.round(value);
        }
    }
    out.count = total;
    out.avg = Math.round((e.sum || 0) / total);
    out.min = Math.round(e.min === undefined ? 0 : e.min);
    out.max = Math.round(e.max === undefined ? 0 : e.max);
    return out;
}

// ── public: spans & traces ──────────────────────────────────────────────────

function _hex(n) { return crypto.randomBytes(n).toString('hex'); }

/**
 * Parse a W3C `traceparent` header.
 * Format: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`
 * @returns {{trace_id: string, span_id: string, sampled: boolean}|null}
 */
function parseTraceparent(header) {
    if (!header || typeof header !== 'string') return null;
    const parts = header.trim().split('-');
    if (parts.length < 4) return null;
    const [version, traceId, parentId, flags] = parts;
    if (!/^[0-9a-f]{2}$/i.test(version)) return null;
    if (!/^[0-9a-f]{32}$/i.test(traceId) || /^0+$/.test(traceId)) return null;
    if (!/^[0-9a-f]{16}$/i.test(parentId) || /^0+$/.test(parentId)) return null;
    return { trace_id: traceId.toLowerCase(), span_id: parentId.toLowerCase(), sampled: (parseInt(flags, 16) & 1) === 1 };
}

/** Build a W3C `traceparent` for a context. */
function formatTraceparent(ctx) {
    if (!ctx || !ctx.trace_id || !ctx.span_id) return null;
    const flags = ctx.sampled === false ? '00' : '01';
    return `00-${ctx.trace_id}-${ctx.span_id}-${flags}`;
}

/**
 * Start a trace context. If an inbound `traceparent` exists, it is INHERITED
 * (same trace_id, new span_id) so the story continues across hops.
 */
function startContext(inbound) {
    const inherited = inbound && inbound.trace_id ? inbound : null;
    return {
        trace_id: inherited ? inherited.trace_id : _hex(16),
        span_id: _hex(8),
        parent_span_id: inherited ? inherited.span_id : null,
        sampled: inherited ? inherited.sampled !== false : true,
        started_ms: Date.now(),
    };
}

/** Derive a child context (a child span of `ctx`). */
function childContext(ctx) {
    const base = ctx && ctx.trace_id ? ctx : startContext(null);
    return {
        trace_id: base.trace_id,
        span_id: _hex(8),
        parent_span_id: base.span_id,
        sampled: base.sampled !== false,
        started_ms: Date.now(),
    };
}

/**
 * Record a span. `attributes` are LABEL-ALLOWED ONLY (strings/numbers), so a
 * span can never become a place where a prompt is kept.
 */
function span(ctx, { name, kind = 'internal', attributes = {}, status = 'ok', error_class = null } = {}) {
    if (!ctx || !ctx.trace_id) return null;
    const now = Date.now();
    const end = ctx.ended_ms || now;
    const clean = {};
    for (const key of Object.keys(attributes || {})) {
        if (!LABEL_ALLOW.has(key)) { dropped.labels++; continue; }
        const v = attributes[key];
        if (v === null || v === undefined) continue;
        clean[key] = typeof v === 'number' ? v : sanitizeLabelValue(v);
    }
    const rec = {
        trace_id: ctx.trace_id,
        span_id: ctx.span_id,
        parent_span_id: ctx.parent_span_id || null,
        name: String(name || 'unnamed').slice(0, 120),
        kind: String(kind || 'internal').slice(0, 24),
        start_ms: ctx.started_ms || now,
        end_ms: end,
        duration_ms: Math.max(0, end - (ctx.started_ms || now)),
        status: status === 'ok' ? 'ok' : 'error',
        error_class: error_class || null,
        attributes: clean,
    };
    spans.push(rec);
    while (spans.length > CFG.spanRingSize) spans.shift();

    histogram('span_duration_ms', { kind: rec.kind }, rec.duration_ms);
    counter('spans_total', { status: rec.status });
    if (rec.error_class) counter('span_errors_total', { error_class: rec.error_class });

    return rec;
}

/**
 * Record a NEW child span of `parentCtx`.
 *
 * `span(ctx, spec)` records the span that `ctx` REPRESENTS. This helper
 * mints a fresh child context first, so nesting reads correctly:
 *
 *   const root  = telemetry.startContext(null);
 *   const relay = telemetry.childSpan(root, {name: 'relay'});
 *   const bee   = telemetry.childSpan(relay, {name: 'bee'});
 *   // bee.parent_span_id === relay.span_id
 *
 * @returns {object} the child context (so it can be nested further)
 */
function childSpan(parentCtx, spec = {}) {
    const child = childContext(parentCtx);
    span(child, spec);
    return child;
}

/**
 * Time an async function as a span. Errors are classified and re-thrown.
 * @param {object} ctx   the parent context (may be null)
 * @param {object} spec  {name, kind, attributes}
 * @param {Function} fn
 */
async function withSpan(ctx, spec, fn) {
    const child = childContext(ctx);
    try {
        const out = await fn(child);
        child.ended_ms = Date.now();
        span(child, { ...spec, status: 'ok' });
        return out;
    } catch (err) {
        child.ended_ms = Date.now();
        span(child, { ...spec, status: 'error', error_class: classifyError(err) });
        throw err;
    }
}

/** All spans sharing a trace_id, ordered by start time. */
function trace(traceId) {
    if (!traceId) return [];
    return spans.filter((s) => s.trace_id === traceId).sort((a, b) => a.start_ms - b.start_ms);
}

/** The most recent traces (a summary per trace, not every span). */
function recentTraces(limit = 20) {
    const byTrace = new Map();
    for (const s of spans) {
        let t = byTrace.get(s.trace_id);
        if (!t) {
            t = { trace_id: s.trace_id, spans: 0, root: null, start_ms: s.start_ms, duration_ms: 0, status: 'ok', error_class: null, names: [] };
            byTrace.set(s.trace_id, t);
        }
        t.spans++;
        t.names.push(s.name);
        if (!s.parent_span_id) t.root = s.name;
        t.duration_ms = Math.max(t.duration_ms, s.duration_ms);
        if (s.status === 'error') { t.status = 'error'; t.error_class = s.error_class; }
    }
    return [...byTrace.values()].sort((a, b) => b.start_ms - a.start_ms).slice(0, limit);
}

// ── public: errors ──────────────────────────────────────────────────────────

/** Count an error occurrence under its taxonomy class. */
function countError(err, hint = {}) {
    const cls = typeof err === 'string' ? err : classifyError(err, hint);
    const key = ERROR_CLASSES.includes(cls) ? cls : 'unknown';
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    counter('errors_total', { error_class: key });
    return key;
}

function errorBreakdown() {
    const out = {};
    let total = 0;
    for (const cls of ERROR_CLASSES) {
        const n = errorCounts.get(cls) || 0;
        out[cls] = n;
        total += n;
    }
    return { total, by_class: out };
}

// ── public: series ──────────────────────────────────────────────────────────

/**
 * The live time-series for a metric.
 * @returns {Array<{t: number, v: number}>} oldest → newest
 */
function series(metric, labels = {}) {
    const arr = seriesStore.get(_seriesKey(metric, labels));
    return arr ? arr.slice() : [];
}

/** Every series key known, with the latest value. */
function seriesIndex() {
    const out = [];
    for (const [key, arr] of seriesStore.entries()) {
        if (!arr.length) continue;
        const metric = key.split('|')[0];
        out.push({ metric, labels: labelObject(key.split('|')[1] || ''), points: arr.length, latest: arr[arr.length - 1].v, at: arr[arr.length - 1].t });
    }
    return out.sort((a, b) => b.at - a.at);
}

// ── public: SLO ─────────────────────────────────────────────────────────────
//
// An SLO says: "over this window, at least this fraction of requests must
// succeed" and/or "this fraction must finish under this latency".
// The status is computed from the ERROR TAXONOMY + HISTOGRAM, not from a
// separate counter that nobody fills in.
//
//   burn_rate = (1 - actual) / (1 - target)
//   burn_rate > 1  → the budget is burning faster than time passes (bad)
//   burn_rate ≈ 0  → comfortable
//
// This is the Google SRE multiwindow burn-rate shape, simplified: one window,
// one rate, clearly labelled.

const SLO_DEFS = [
    { id: 'chat.availability', name: 'Chat availability', metric: 'requests_total', filter: { endpoint: '/v1/chat/completions' }, target: 0.99, window_s: 3600 },
    { id: 'chat.latency', name: 'Chat latency (p95 < 10s)', metric: 'request_duration_ms', filter: {}, target: 0.95, threshold_ms: 10000, window_s: 3600 },
    { id: 'tool.availability', name: 'Tool availability', metric: 'tool_calls_total', filter: {}, target: 0.99, window_s: 3600 },
    { id: 'relay.availability', name: 'Relay availability', metric: 'relay_jobs_total', filter: {}, target: 0.99, window_s: 3600 },
];

/**
 * Evaluate the SLO set against the live counters.
 * NOTE: the counters are LIFETIME totals in this process (they reset on
 * restart). A restart therefore resets the SLO too — which is exactly why
 * the DB mirror exists and why `slo` is always reported together with the
 * sample size it was computed from.
 */
function slo() {
    const out = [];
    for (const def of SLO_DEFS) {
        const entry = { id: def.id, name: def.name, target: def.target, window_s: def.window_s };
        if (def.threshold_ms) {
            const p = percentiles(def.metric, def.filter, [95]);
            entry.actual = p ? p.p95 : null;
            entry.samples = p ? p.count : 0;
            entry.unit = 'ms';
            entry.status = p ? (p.p95 <= def.threshold_ms ? 'ok' : 'breach') : 'unknown';
            entry.burn_rate = null;
            entry.threshold_ms = def.threshold_ms;
        } else {
            const total = counterValue(def.metric, def.filter);
            const errors = total === null ? null : counterValue('errors_total', { ...def.filter, error_class: 'unknown' });
            // Success rate is approximated by (total - recorded failures).
            const fails = _failuresFor(def);
            entry.samples = total || 0;
            entry.actual = (total === null) ? null : (total > 0 ? (total - fails) / total : 1);
            entry.unit = 'ratio';
            entry.status = entry.actual === null ? 'unknown' : (entry.actual >= def.target ? 'ok' : 'breach');
            entry.burn_rate = entry.actual === null ? null
                : (def.target >= 1 ? null : (1 - entry.actual) / (1 - def.target));
            void errors;
        }
        out.push(entry);
    }
    return out;
}

function _failuresFor(def) {
    let fails = 0;
    for (const [key, e] of counters.entries()) {
        if (!key.startsWith(`${def.metric}|`)) continue;
        const labels = e.labels || {};
        let match = true;
        for (const [lk, lv] of Object.entries(def.filter || {})) {
            if (labels[lk] !== lv) { match = false; break; }
        }
        if (!match) continue;
        // A counter's "failure" companion is `..._errors_total`; if the caller
        // recorded failures via countError they land in errors_total instead.
        if (labels.status === 'error' || labels.outcome === 'error' || labels.outcome === 'failed') fails += e.value;
    }
    return fails;
}

// ── public: overview ────────────────────────────────────────────────────────

/**
 * The single "how is the hive doing" snapshot. Cheap enough to poll at 1Hz.
 */
function snapshot() {
    let counterTotal = 0;
    for (const e of counters.values()) counterTotal += e.value || 0;
    const spanStats = (() => {
        let n = 0, err = 0, total = 0, max = 0;
        for (const s of spans) {
            n++;
            if (s.status === 'error') err++;
            total += s.duration_ms;
            if (s.duration_ms > max) max = s.duration_ms;
        }
        return { count: n, errors: err, avg_duration_ms: n ? Math.round(total / n) : null, max_duration_ms: n ? max : null };
    })();
    return {
        generated_at: new Date().toISOString(),
        counters: { series: counters.size, total_value: counterTotal },
        gauges: { series: gauges.size },
        histograms: { series: histograms.size },
        series: { series: seriesStore.size },
        spans: spanStats,
        errors: errorBreakdown(),
        dropped,
        slo: slo(),
        database: pool ? 'connected' : 'memory-only',
    };
}

/** All counters as a flat, PromQL-ish list. */
function countersList() {
    const out = [];
    for (const e of counters.values()) {
        out.push({ metric: e.metric, labels: e.labels || {}, value: e.value });
    }
    return out.sort((a, b) => a.metric.localeCompare(b.metric) || JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
}

/** All gauges as a flat list. */
function gaugesList() {
    const out = [];
    for (const e of gauges.values()) {
        out.push({ metric: e.metric, labels: e.labels || {}, value: e.value, at: e.ts });
    }
    return out.sort((a, b) => a.metric.localeCompare(b.metric));
}

/** All histograms with their percentiles. */
function histogramsList(percentilesWanted = [50, 90, 95, 99]) {
    const out = [];
    for (const e of histograms.values()) {
        const p = percentiles(e.metric, e.labels, percentilesWanted);
        if (!p) continue;
        out.push({ metric: e.metric, labels: e.labels || {}, ...p });
    }
    return out.sort((a, b) => a.metric.localeCompare(b.metric));
}

/**
 * Prometheus-style text exposition — so an operator can point Prometheus at
 * /api/telemetry/metrics and get real graphs without a custom exporter.
 */
function prometheusText() {
    const lines = [];
    for (const e of counters.values()) {
        const lbl = promLabels(e.labels);
        lines.push(`hivv_${e.metric}${lbl} ${e.value}`);
    }
    for (const e of gauges.values()) {
        const lbl = promLabels(e.labels);
        lines.push(`hivv_${e.metric}${lbl} ${e.value}`);
    }
    for (const e of histograms.values()) {
        const lbl = promLabels(e.labels);
        const p = percentiles(e.metric, e.labels, [50, 90, 95, 99]);
        if (!p) continue;
        lines.push(`hivv_${e.metric}_count${lbl} ${p.count}`);
        lines.push(`hivv_${e.metric}_sum${lbl} ${Math.round(e.sum || 0)}`);
        for (const q of [50, 90, 95, 99]) {
            lines.push(`hivv_${e.metric}_quantile{q="${q / 100}"}${lbl} ${p[`p${q}`]}`);
        }
    }
    for (const [cls, n] of errorCounts.entries()) {
        lines.push(`hivv_errors_total{error_class="${cls}"} ${n}`);
    }
    return lines.join('\n') + '\n';
}

function promLabels(labels) {
    const keys = Object.keys(labels || {}).filter((k) => labels[k] !== undefined && labels[k] !== null && labels[k] !== '');
    if (!keys.length) return '';
    const body = keys.sort().map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',');
    return `{${body}}`;
}

// ── DB mirror (optional) ────────────────────────────────────────────────────
//
// Two tables:
//   hivv_telemetry_counters — one row per (metric, label_key), cumulative
//   hivv_telemetry_spans    — recent spans (TTL-pruned), for the trace viewer
//
// The mirror is a convenience, never a dependency. If the database is
// missing, slow, or broken, the in-memory core keeps working untouched.

let schemaReady = null;

async function ensureSchema() {
    if (!pool) return false;
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS hivv_telemetry_counters (
                    id           BIGSERIAL PRIMARY KEY,
                    metric       TEXT NOT NULL,
                    label_key    TEXT NOT NULL DEFAULT '',
                    labels       JSONB NOT NULL DEFAULT '{}'::jsonb,
                    value        DOUBLE PRECISION NOT NULL DEFAULT 0,
                    kind         TEXT NOT NULL DEFAULT 'counter',
                    samples      BIGINT NOT NULL DEFAULT 0,
                    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (metric, label_key, kind)
                );
                CREATE INDEX IF NOT EXISTS idx_hivv_telemetry_metric ON hivv_telemetry_counters (metric, updated_at DESC);
                CREATE TABLE IF NOT EXISTS hivv_telemetry_spans (
                    id            BIGSERIAL PRIMARY KEY,
                    trace_id      TEXT NOT NULL,
                    span_id       TEXT NOT NULL,
                    parent_span_id TEXT,
                    name          TEXT NOT NULL,
                    kind          TEXT NOT NULL DEFAULT 'internal',
                    status        TEXT NOT NULL DEFAULT 'ok',
                    error_class   TEXT,
                    duration_ms   BIGINT NOT NULL DEFAULT 0,
                    start_ms      BIGINT NOT NULL DEFAULT 0,
                    attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_hivv_telemetry_span_trace ON hivv_telemetry_spans (trace_id, start_ms);
                CREATE INDEX IF NOT EXISTS idx_hivv_telemetry_span_created ON hivv_telemetry_spans (created_at DESC);
            `);
            return true;
        } catch (err) {
            console.warn('[telemetry] schema setup failed:', err.message);
            return false;
        }
    })();
    return schemaReady;
}

async function flush() {
    if (!pool) return;
    const ok = await ensureSchema();
    if (!ok) return;
    try {
        for (const e of counters.values()) {
            await pool.query(
                `INSERT INTO hivv_telemetry_counters (metric, label_key, labels, value, kind, samples)
                 VALUES ($1, $2, $3::jsonb, $4, 'counter', 1)
                 ON CONFLICT (metric, label_key, kind) DO UPDATE SET
                   value = hivv_telemetry_counters.value + EXCLUDED.value,
                   samples = hivv_telemetry_counters.samples + 1,
                   labels = EXCLUDED.labels,
                   updated_at = NOW()`,
                [e.metric, e.key.split('|')[1] || '', JSON.stringify(e.labels || {}), e.value]
            );
        }
        for (const e of gauges.values()) {
            await pool.query(
                `INSERT INTO hivv_telemetry_counters (metric, label_key, labels, value, kind, samples)
                 VALUES ($1, $2, $3::jsonb, $4, 'gauge', 1)
                 ON CONFLICT (metric, label_key, kind) DO UPDATE SET
                   value = EXCLUDED.value,
                   samples = hivv_telemetry_counters.samples + 1,
                   labels = EXCLUDED.labels,
                   updated_at = NOW()`,
                [e.metric, e.key.split('|')[1] || '', JSON.stringify(e.labels || {}), e.value]
            );
        }
    } catch (err) {
        console.warn('[telemetry] flush failed:', err.message);
    }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function start(pgPool, flushMs = CFG.flushMs) {
    pool = pgPool || null;
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => { flush().catch(() => {}); }, flushMs);
    if (flushTimer.unref) flushTimer.unref();
    console.log(`[telemetry] started (${pool ? 'db mirror on' : 'memory only'})`);
}

function stop() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
}

/** Wipe the in-memory state. Used by tests and by a manual operator reset. */
function reset() {
    counters.clear();
    gauges.clear();
    histograms.clear();
    seriesStore.clear();
    spans.length = 0;
    errorCounts.clear();
    dropped.labels = 0;
    dropped.series = 0;
}

module.exports = {
    CFG,
    ERROR_CLASSES,
    SLO_DEFS,
    LABEL_ALLOW,
    // primitives
    counter, counterValue,
    gauge, gaugeValue,
    histogram, percentiles,
    // spans & traces
    startContext, childContext, parseTraceparent, formatTraceparent,
    span, withSpan, childSpan, trace, recentTraces,
    // errors
    classifyError, countError, errorBreakdown,
    // series
    series, seriesIndex,
    // reporting
    snapshot, countersList, gaugesList, histogramsList, prometheusText, slo,
    // lifecycle
    start, stop, reset, flush, ensureSchema,
    // internals (exported for tests)
    labelKey, labelObject,
};
