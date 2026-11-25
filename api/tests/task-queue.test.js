// api/tests/task-queue.test.js — the DISTRIBUTED TASK FOUNDATION.
//
// These tests need NO database and NO network.
//
// What is pinned here:
//   * idempotency: the same id NEVER produces two tasks
//   * LEASES: a worker that dies loses nothing — the work comes back
//   * failed ≠ rejected: a retryable failure comes back, a rejection never does
//   * interruption is NOT failure: a task waiting for a human is still alive
//   * the TTL expires forgotten work instead of stranding it forever
//   * no silent loss: every terminal state says WHY

const test = require('node:test');
const assert = require('node:assert');
const q = require('../lib/task-queue');

test.beforeEach(() => { q.reset(); });

// ── idempotency ─────────────────────────────────────────────────────────────

test('submitting the same id twice yields the SAME task', () => {
    const a = q.submit({ id: 'req_abc', kind: 'chat', payload: { x: 1 } });
    const b = q.submit({ id: 'req_abc', kind: 'chat', payload: { x: 2 } });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.task.id, b.task.id);
    assert.equal(b.task.payload.x, 1, 'the second submit must NOT overwrite the first');
    assert.equal(q.list().length, 1);
});

test('a generated id is unique', () => {
    const a = q.submit({ kind: 'chat' });
    const b = q.submit({ kind: 'chat' });
    assert.notEqual(a.task.id, b.task.id);
});

// ── the happy path ──────────────────────────────────────────────────────────

test('claim → complete moves a task to done', () => {
    const { task } = q.submit({ id: 't1', kind: 'chat' });
    const claimed = q.claim({ worker: 'bee-1' });
    assert.equal(claimed.id, task.id);
    assert.equal(claimed.state, 'running');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.lease_worker, 'bee-1');

    const res = q.complete('t1', { worker: 'bee-1', result: { text: 'hi' } });
    assert.equal(res.ok, true);
    assert.equal(res.task.state, 'done');
    assert.equal(res.task.result.text, 'hi');
    assert.ok(res.task.duration_ms >= 0);
});

test('a task that was never claimed has NO duration (no 0s lies)', () => {
    const { task } = q.submit({ id: 't2', kind: 'chat' });
    assert.equal(task.duration_ms, null);
    assert.equal(task.started_at_ms, null);
});

test('claimId leases ONE SPECIFIC task, not the next one', () => {
    q.submit({ id: 'first', kind: 'a2a' });
    q.submit({ id: 'second', kind: 'a2a' });
    const claimed = q.claimId('second', { worker: 'runner' });
    assert.equal(claimed.id, 'second');
    assert.equal(claimed.state, 'running');
    // the FIRST task is untouched — a targeted claim is not a "claim the next"
    assert.equal(q.get('first').state, 'queued');
});

test('claimId refuses a task that is not claimable', () => {
    q.submit({ id: 'x1', kind: 'chat' });
    assert.equal(q.claimId('x1', { worker: 'w' }).id, 'x1');
    assert.equal(q.claimId('x1', { worker: 'w' }), null, 'a running task is not claimable again');
    assert.equal(q.claimId('never-existed', { worker: 'w' }), null);
});

test('claimId respects not_before', () => {
    q.submit({ id: 'x2', kind: 'chat', not_before_ms: Date.now() + 60000 });
    assert.equal(q.claimId('x2', { worker: 'w' }), null);
});

test('a worker that does not own the lease cannot complete the task', () => {
    q.submit({ id: 't3', kind: 'chat' });
    q.claim({ worker: 'bee-1' });
    const res = q.complete('t3', { worker: 'bee-2' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_owner');
});

// ── leases: a dead worker loses nothing ─────────────────────────────────────

test('a lapsed lease returns the work to the queue', () => {
    q.submit({ id: 't4', kind: 'chat', max_attempts: 3 });
    const claimed = q.claim({ worker: 'bee-1', lease_s: 1 });
    assert.equal(claimed.state, 'running');
    // Fast-forward: the lease expires one second from now.
    const t = q.get('t4');
    assert.ok(t.lease_expires_at_ms > Date.now());
    // Force the lease into the past.
    expireLease('t4');
    const swept = q.sweep();
    assert.equal(swept.reclaimed, 1);
    assert.equal(q.get('t4').state, 'queued');
});

test('a task that burns its attempts ends as failed, never silently dropped', () => {
    q.submit({ id: 't5', kind: 'chat', max_attempts: 1 });
    q.claim({ worker: 'bee-1' });
    expireLease('t5');
    const swept = q.sweep();
    assert.equal(swept.exhausted, 1);
    const task = q.get('t5');
    assert.equal(task.state, 'failed');
    assert.equal(task.error.class, 'lease_expired');
});

test('extendLease keeps a task alive', () => {
    q.submit({ id: 't6', kind: 'chat' });
    q.claim({ worker: 'bee-1', lease_s: 1 });
    const before = q.get('t6').lease_expires_at_ms;
    const after = q.extendLease('t6', { worker: 'bee-1', lease_s: 60 });
    assert.ok(after > before);
});

test('extendLease refuses a worker that does not hold the lease', () => {
    q.submit({ id: 't7', kind: 'chat' });
    q.claim({ worker: 'bee-1' });
    assert.equal(q.extendLease('t7', { worker: 'bee-2' }), null);
});

// ── failed vs rejected ──────────────────────────────────────────────────────

test('a retryable failure comes back to the queue', () => {
    q.submit({ id: 't8', kind: 'chat', max_attempts: 3 });
    q.claim({ worker: 'bee-1' });
    const res = q.fail('t8', { worker: 'bee-1', error: 'the bee went away', retryable: true });
    assert.equal(res.ok, true);
    assert.equal(res.requeued, true);
    assert.equal(res.task.state, 'queued');
    assert.equal(res.task.error.message, 'the bee went away');
});

test('a failure past the attempt cap is terminal', () => {
    q.submit({ id: 't9', kind: 'chat', max_attempts: 1 });
    q.claim({ worker: 'bee-1' });
    const res = q.fail('t9', { worker: 'bee-1', error: 'dead', retryable: true });
    assert.equal(res.requeued, false);
    assert.equal(res.task.state, 'failed');
});

test('a rejection is terminal — a rejection is never retried', () => {
    q.submit({ id: 't10', kind: 'chat' });
    const res = q.reject('t10', 'allowance_zero');
    assert.equal(res.ok, true);
    assert.equal(res.task.state, 'rejected');
    assert.equal(res.task.error.class, 'rejected');
    assert.equal(q.claim({ worker: 'bee-1' }), null, 'a rejected task is never claimed again');
});

// ── interruption (the MAYBE verdict) ────────────────────────────────────────

test('an interrupted task is ALIVE, not failed', () => {
    q.submit({ id: 't11', kind: 'a2a' });
    q.claim({ worker: 'a2a-runner' });
    const res = q.interrupt('t11', { kind: 'auth', reason: 'a human must approve this' });
    assert.equal(res.ok, true);
    assert.equal(res.task.state, 'running');
    assert.equal(res.task.interrupted.kind, 'auth');
    assert.equal(res.task.interrupted.reason, 'a human must approve this');
});

test('an interrupted task can be resumed', () => {
    q.submit({ id: 't12', kind: 'a2a' });
    q.claim({ worker: 'a2a-runner' });
    q.interrupt('t12', { kind: 'input', reason: 'what did you mean?' });
    const res = q.resume('t12', { worker: 'a2a-runner' });
    assert.equal(res.ok, true);
    assert.equal(res.task.state, 'running');
    assert.equal(res.task.interrupted, null);
});

test('resuming a task that was never interrupted is refused', () => {
    q.submit({ id: 't13', kind: 'a2a' });
    assert.equal(q.resume('t13', {}).error, 'not_interrupted');
});

// ── cancellation & expiry ───────────────────────────────────────────────────

test('cancel works on a queued task and refuses a terminal one', () => {
    q.submit({ id: 't14', kind: 'chat' });
    const res = q.cancel('t14', { reason: 'the user changed their mind' });
    assert.equal(res.ok, true);
    assert.equal(res.task.state, 'canceled');
    assert.equal(res.task.error.message, 'the user changed their mind');
    assert.equal(q.cancel('t14', {}).error, 'already_terminal');
});

test('an expired task is expired, not stuck', () => {
    q.submit({ id: 't15', kind: 'chat', ttl_s: 1 });
    expireCreated('t15');
    const swept = q.sweep();
    assert.equal(swept.expired, 1);
    assert.equal(q.get('t15').state, 'expired');
    assert.equal(q.get('t15').error.class, 'expired');
});

// ── scheduling ──────────────────────────────────────────────────────────────

test('not_before holds a task back until it is due', () => {
    q.submit({ id: 't16', kind: 'chat', not_before_ms: Date.now() + 60000 });
    assert.equal(q.due().length, 0, 'a task in the future is not due');
    assert.equal(q.claim({ worker: 'w' }), null);
});

test('priority orders the queue', () => {
    q.submit({ id: 'low', kind: 'chat', priority: 1 });
    q.submit({ id: 'high', kind: 'chat', priority: 90 });
    const due = q.due();
    assert.equal(due[0].id, 'high');
    assert.equal(q.claim({ worker: 'w' }).id, 'high');
});

test('a claim can be restricted to one kind', () => {
    q.submit({ id: 'code', kind: 'code' });
    q.submit({ id: 'chat', kind: 'chat' });
    assert.equal(q.claim({ worker: 'w', kind: 'chat' }).id, 'chat');
});

// ── the budget is carried, not enforced here ────────────────────────────────

test('the budget travels with the task', () => {
    const { task } = q.submit({ id: 't17', kind: 'chat', budget: { max_tokens: 100, max_cost_usd: 0.01 } });
    assert.equal(task.budget.max_tokens, 100);
    assert.equal(task.budget.max_cost_usd, 0.01);
});

// ── stats ───────────────────────────────────────────────────────────────────

test('stats count by state and by kind', () => {
    q.submit({ id: 'a', kind: 'chat' });
    q.submit({ id: 'b', kind: 'code' });
    q.submit({ id: 'c', kind: 'chat' });
    q.claim({ worker: 'w' });
    const s = q.stats();
    assert.equal(s.total, 3);
    assert.equal(s.by_state.queued, 2);
    assert.equal(s.by_state.running, 1);
    assert.equal(s.by_kind.chat, 2);
    assert.equal(s.by_kind.code, 1);
    assert.equal(s.database, 'memory-only');
});

test('the queue reports the oldest waiting task', () => {
    q.submit({ id: 'old', kind: 'chat' });
    ageCreated('old', 5000);
    const s = q.stats();
    assert.ok(s.oldest_queued_age_ms >= 4000, 'oldest was ' + s.oldest_queued_age_ms);
});

// ── helpers: reach into the private state to simulate time passing ─────────
//
// The queue deliberately has no clock injection (a fake clock in production
// code is a footgun), so the tests reach in through the public API where
// they can and use these two shims where they cannot.

function expireLease(id) {
    const t = q._internal().get(id);
    if (t && t.lease) t.lease.expires_at_ms = Date.now() - 1;
}

function expireCreated(id) {
    const t = q._internal().get(id);
    if (t) {
        t.expires_at_ms = Date.now() - 1;
        t.created_at_ms = Date.now() - 1000;
    }
}

function ageCreated(id, ms) {
    const t = q._internal().get(id);
    if (t) t.created_at_ms = Date.now() - ms;
}
