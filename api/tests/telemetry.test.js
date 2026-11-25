// api/tests/telemetry.test.js — the DEEPER TELEMETRY core.
//
// These tests need NO database and NO network: the whole point of
// api/lib/telemetry.js is that it works with nothing attached.
//
// What is pinned here:
//   * the label allow-list is a PRIVACY boundary (unknown labels are dropped)
//   * percentiles are computed from real bucket counts, not guesses
//   * the error taxonomy is stable and total (every error lands somewhere)
//   * a trace stitches spans together through their parents
//   * a metric with no samples reports null, never 0
//   * the Prometheus exposition is well-formed

const test = require('node:test');
const assert = require('node:assert');
const telemetry = require('../lib/telemetry');

test.beforeEach(() => { telemetry.reset(); });

// ── counters ────────────────────────────────────────────────────────────────

test('counter accumulates and is readable', () => {
    telemetry.counter('requests_total', { endpoint: '/v1/chat' });
    telemetry.counter('requests_total', { endpoint: '/v1/chat' });
    telemetry.counter('requests_total', { endpoint: '/v1/chat' }, 4);
    assert.equal(telemetry.counterValue('requests_total', { endpoint: '/v1/chat' }), 6);
});

test('a counter with no samples is null, not zero', () => {
    assert.equal(telemetry.counterValue('never_seen_total', { endpoint: '/x' }), null);
});

test('label order does not create two series', () => {
    telemetry.counter('c_total', { endpoint: '/a', transport: 'direct' });
    telemetry.counter('c_total', { transport: 'direct', endpoint: '/a' });
    const rows = telemetry.countersList().filter((c) => c.metric === 'c_total');
    assert.equal(rows.length, 1, 'the same labels in a different order are the same series');
    assert.equal(rows[0].value, 2);
});

// ── the privacy boundary ────────────────────────────────────────────────────

test('unknown label names are DROPPED (the allow-list is the boundary)', () => {
    telemetry.counter('c_total', { endpoint: '/a', prompt: 'the user said hello' });
    const rows = telemetry.countersList().filter((c) => c.metric === 'c_total');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].labels.prompt, undefined, 'a prompt must never become a label');
    assert.equal(rows[0].labels.endpoint, '/a');
});

test('label values are length-capped', () => {
    const long = 'x'.repeat(500);
    telemetry.counter('c_total', { endpoint: long });
    const row = telemetry.countersList().find((c) => c.metric === 'c_total');
    assert.ok(row.labels.endpoint.length <= telemetry.CFG.maxLabelValueChars);
});

test('spans drop non-allow-listed attributes', () => {
    const ctx = telemetry.startContext(null);
    // `raw_prompt` is NOT allow-listed, so it is dropped. (The fixture
    // deliberately avoids credential-shaped names: a test that trips the
    // pre-push secret scanner blocks the whole repo's pushes.)
    telemetry.span(ctx, { name: 'chat', attributes: { endpoint: '/v1/chat', raw_prompt: 'a private note' } });
    const [s] = telemetry.trace(ctx.trace_id);
    assert.equal(s.attributes.raw_prompt, undefined);
    assert.equal(s.attributes.endpoint, '/v1/chat');
});

// ── histograms ──────────────────────────────────────────────────────────────

test('histogram percentiles are EXACT while the reservoir holds every sample', () => {
    const labels = { transport: 'direct' };
    for (let i = 0; i < 100; i++) telemetry.histogram('request_duration_ms', labels, 100);
    for (let i = 0; i < 10; i++) telemetry.histogram('request_duration_ms', labels, 5000);
    const p = telemetry.percentiles('request_duration_ms', labels, [50, 95, 99]);
    assert.equal(p.count, 110);
    assert.equal(p.exact, true, 'a small series is measured, not estimated');
    assert.equal(p.p50, 100, `p50 was ${p.p50}`);
    assert.equal(p.p95, 5000, `p95 was ${p.p95}`);
    assert.equal(p.max, 5000);
});

test('a series that outgrows the reservoir falls back to bucketed estimates and says so', () => {
    const labels = { transport: 'relay' };
    const n = telemetry.CFG.reservoirSize + 50;
    for (let i = 0; i < n; i++) telemetry.histogram('big_ms', labels, 100);
    const p = telemetry.percentiles('big_ms', labels, [50, 95]);
    assert.equal(p.count, n);
    assert.equal(p.exact, false, 'an oversampled series must admit it is estimating');
    assert.ok(p.p50 > 0 && p.p50 <= 200, `p50 was ${p.p50}`);
});

test('a histogram with no samples reports null', () => {
    assert.equal(telemetry.percentiles('never', {}, [50]), null);
});

test('histogram min and max are tracked', () => {
    telemetry.histogram('h', {}, 5);
    telemetry.histogram('h', {}, 900);
    const p = telemetry.percentiles('h', {}, [50]);
    assert.equal(p.min, 5);
    assert.equal(p.max, 900);
    assert.equal(p.avg, 453);   // (5 + 900) / 2 = 452.5, rounded half-up
});

// ── the error taxonomy ──────────────────────────────────────────────────────

test('the taxonomy classifies the common failures', () => {
    assert.equal(telemetry.classifyError({ code: 'ETIMEDOUT' }), 'timeout');
    assert.equal(telemetry.classifyError({ status: 429 }), 'rate_limited');
    assert.equal(telemetry.classifyError({ status: 401 }), 'auth');
    assert.equal(telemetry.classifyError({ code: 'ECONNREFUSED' }), 'connection');
    assert.equal(telemetry.classifyError({ code: 'ENOTFOUND' }), 'dns');
    assert.equal(telemetry.classifyError({ status: 503 }), 'unavailable');
    assert.equal(telemetry.classifyError({ status: 500 }), 'upstream_5xx');
    assert.equal(telemetry.classifyError({ status: 400 }), 'upstream_4xx');
    assert.equal(telemetry.classifyError({ status: 404 }), 'not_found');
    assert.equal(telemetry.classifyError(new Error('policy denied this action')), 'policy_denied');
    assert.equal(telemetry.classifyError(new Error('MAYBE — human approval required')), 'policy_pending');
    assert.equal(telemetry.classifyError(null), 'unknown');
});

test('every classification lands inside the declared vocabulary', () => {
    const weird = [
        new Error(''), { status: 0 }, { code: 'WEIRD' },
        new Error('sandbox refused the call'),
        new Error('the worker aborted'),
        new Error('no content in the response'),
    ];
    for (const e of weird) {
        assert.ok(telemetry.ERROR_CLASSES.includes(telemetry.classifyError(e)),
            `unclassified: ${telemetry.classifyError(e)}`);
    }
});

test('the error breakdown counts by class', () => {
    telemetry.countError({ status: 429 });
    telemetry.countError({ status: 429 });
    telemetry.countError({ code: 'ETIMEDOUT' });
    const b = telemetry.errorBreakdown();
    assert.equal(b.total, 3);
    assert.equal(b.by_class.rate_limited, 2);
    assert.equal(b.by_class.timeout, 1);
});

// ── traces ──────────────────────────────────────────────────────────────────

test('a W3C traceparent round-trips', () => {
    const parsed = telemetry.parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    assert.equal(parsed.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(parsed.span_id, '00f067aa0ba902b7');
    assert.equal(parsed.sampled, true);
    const out = telemetry.formatTraceparent({ trace_id: parsed.trace_id, span_id: parsed.span_id, sampled: true });
    assert.equal(out, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
});

test('a malformed traceparent is refused, not guessed', () => {
    assert.equal(telemetry.parseTraceparent('garbage'), null);
    assert.equal(telemetry.parseTraceparent('00-short-00f067aa0ba902b7-01'), null);
    assert.equal(telemetry.parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null);
    assert.equal(telemetry.parseTraceparent(undefined), null);
});

test('an inbound trace is INHERITED by the child context', () => {
    const inbound = telemetry.parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    const ctx = telemetry.startContext(inbound);
    assert.equal(ctx.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(ctx.parent_span_id, '00f067aa0ba902b7');
    assert.notEqual(ctx.span_id, '00f067aa0ba902b7');
});

test('spans of one trace stitch together through their parents', async () => {
    const root = telemetry.startContext(null);
    telemetry.span(root, { name: 'hub.request', kind: 'server' });
    await telemetry.withSpan(root, { name: 'relay', kind: 'client' }, async (child) => {
        telemetry.childSpan(child, { name: 'bee.inference', kind: 'server' });
    });
    const spans = telemetry.trace(root.trace_id);
    assert.equal(spans.length, 3);
    const bee = spans.find((s) => s.name === 'bee.inference');
    const relay = spans.find((s) => s.name === 'relay');
    assert.equal(bee.parent_span_id, relay.span_id);
    assert.equal(relay.parent_span_id, root.span_id);
    assert.equal(spans.find((s) => s.name === 'hub.request').parent_span_id, null);
});

test('withSpan records the error class and rethrows', async () => {
    const root = telemetry.startContext(null);
    await assert.rejects(
        telemetry.withSpan(root, { name: 'boom' }, async () => { throw Object.assign(new Error('nope'), { code: 'ETIMEDOUT' }); }),
        /nope/
    );
    const spans = telemetry.trace(root.trace_id);
    assert.equal(spans[0].status, 'error');
    assert.equal(spans[0].error_class, 'timeout');
});

// ── gauges & series ─────────────────────────────────────────────────────────

test('a gauge keeps the latest value', () => {
    telemetry.gauge('queue_depth', { queue: 'relay' }, 3);
    telemetry.gauge('queue_depth', { queue: 'relay' }, 7);
    assert.equal(telemetry.gaugeValue('queue_depth', { queue: 'relay' }), 7);
});

test('the series ring returns points oldest first', () => {
    telemetry.counter('hits_total', { endpoint: '/a' }, 2);
    const pts = telemetry.series('hits_total', { endpoint: '/a' });
    assert.ok(Array.isArray(pts));
    assert.ok(pts.length >= 1);
    assert.equal(pts[pts.length - 1].v, 2);
});

// ── SLO ─────────────────────────────────────────────────────────────────────

test('an SLO with no samples is unknown, not breached', () => {
    const table = telemetry.slo();
    const chat = table.find((s) => s.id === 'chat.availability');
    assert.ok(chat);
    assert.equal(chat.status, 'unknown');
    assert.equal(chat.actual, null);
});

test('an SLO with samples reports a status and a burn rate', () => {
    telemetry.counter('requests_total', { endpoint: '/v1/chat/completions' }, 100);
    telemetry.counter('requests_total', { endpoint: '/v1/chat/completions', status: 'error' }, 2);
    const table = telemetry.slo();
    const chat = table.find((s) => s.id === 'chat.availability');
    // 98 successes out of 100 — a 2% error rate against a 99% target.
    assert.ok(Math.abs(chat.actual - 0.98) < 0.0001, `actual was ${chat.actual}`);
    assert.equal(chat.status, 'breach', 'a 2% error rate must breach a 99% target');
    assert.ok(chat.burn_rate > 1, `burn rate was ${chat.burn_rate}`);
    assert.equal(chat.samples, 100);
});

test('an SLO inside its target reports ok and a burn rate below one', () => {
    telemetry.counter('requests_total', { endpoint: '/v1/chat/completions' }, 1000);
    telemetry.counter('requests_total', { endpoint: '/v1/chat/completions', status: 'error' }, 1);
    const chat = telemetry.slo().find((s) => s.id === 'chat.availability');
    assert.equal(chat.status, 'ok');
    assert.ok(chat.burn_rate < 1);
});

// ── reporting ───────────────────────────────────────────────────────────────

test('the snapshot reports local-first honesty', () => {
    const snap = telemetry.snapshot();
    assert.equal(snap.database, 'memory-only');
    assert.ok(snap.slo.length > 0);
    assert.ok(snap.errors);
});

test('the Prometheus exposition is well-formed', () => {
    telemetry.counter('requests_total', { endpoint: '/v1/chat' }, 5);
    telemetry.gauge('queue_depth', { queue: 'relay' }, 2);
    telemetry.histogram('request_duration_ms', { transport: 'direct' }, 120);
    telemetry.countError({ status: 429 });
    const text = telemetry.prometheusText();
    assert.ok(text.includes('hivv_requests_total{endpoint="/v1/chat"} 5'));
    assert.ok(text.includes('hivv_queue_depth{queue="relay"} 2'));
    assert.ok(text.includes('hivv_request_duration_ms_count'));
    assert.ok(text.includes('hivv_errors_total{error_class="rate_limited"} 1'));
    for (const line of text.trim().split('\n')) {
        assert.ok(/^[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})? -?[0-9.]+$/.test(line), `bad exposition line: ${line}`);
    }
});

test('the label allow-list is exported so callers can see the boundary', () => {
    assert.ok(telemetry.LABEL_ALLOW.has('endpoint'));
    assert.ok(!telemetry.LABEL_ALLOW.has('prompt'));
    assert.ok(!telemetry.LABEL_ALLOW.has('api_key'));
});
