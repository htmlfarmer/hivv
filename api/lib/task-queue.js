// api/lib/task-queue.js — THE TASK FOUNDATION for distributed execution.
//
// WHY A SHARED QUEUE
// ──────────────────
// The hive grew four separate job systems, each with its own idea of what a
// job is:
//
//   lib/relay.js            inference jobs to NAT'd bees      (in-memory)
//   routes/coding-routes.js coding jobs to coder bees          (in-memory)
//   routes/bridge-routes.js hive-to-hive load & allowance      (no jobs yet)
//   (blnq.org)              its own jobs table + worker inbox
//
// They share NINE needs and solve each separately:
//
//   1. a state machine a client can POLL          6. retries with a cap
//   2. idempotency on an external id               7. a budget (tokens/cost/time)
//   3. priority + not_before scheduling            8. cancellation
//   4. a TTL that expires forgotten work           9. a receipt of what happened
//   5. LEASES, so a worker that dies loses nothing
//
// This module is ONE implementation of those nine. Every skin above becomes
// a thin adapter over it. The queue is IN-MEMORY by default (fast,
// local-first, survives nothing) and mirrors to Postgres when a database is
// attached (survives a gateway restart).
//
// THE STATES
// ──────────
//   queued ──claim──▶ running ──complete──▶ done
//      │                  │
//      │                  └──fail──▶ failed (retryable) ──▶ queued again
//      │                  └──fail──▶ failed (terminal)
//      ├──cancel──▶ canceled
//      └──ttl─────▶ expired
//      └──reject──▶ rejected      (policy/allowance/loop — never retried)
//
// The distinction that matters: `failed` can be retried, `rejected` cannot.
// A peer hive that is at 0% allowance REJECTS work; it does not fail it.
//
// LEASES, NOT LOCKS
// ────────────────
// A bee behind NAT can die mid-job. A lock would strand the work forever.
// A lease EXPIRES: the worker must heartbeat to keep it. When a lease
// lapses the task returns to `queued` with attempts+1, and a task that
// burned through max_attempts is `failed` — never silently dropped.
//
// HOUSE LAWS
// ──────────
//   * LOCAL-FIRST — no database is a valid, fully-useful configuration.
//   * PRIVACY — the queue stores the PAYLOAD the caller gave us. Callers
//     must not put secrets in it; the queue never logs payload bodies.
//   * HONEST — a task that was never claimed has no duration. No 0s lies.
//   * NO SILENT LOSS — every terminal transition records WHY.

'use strict';

const crypto = require('crypto');

// ── configuration ───────────────────────────────────────────────────────────

const CFG = {
    maxTasks: 5000,          // bounded memory; oldest terminal tasks are evicted
    defaultTtlMs: 15 * 60 * 1000,
    maxTtlMs: 6 * 60 * 60 * 1000,
    defaultLeaseMs: 60 * 1000,
    maxLeaseMs: 15 * 60 * 1000,
    defaultMaxAttempts: 3,
    janitorMs: 5000,
    maxPayloadChars: 256 * 1024,
};

const STATES = ['queued', 'running', 'done', 'failed', 'expired', 'rejected', 'canceled'];
const TERMINAL = new Set(['done', 'failed', 'expired', 'rejected', 'canceled']);

// ── the store ───────────────────────────────────────────────────────────────

const tasks = new Map();     // id -> task
let pool = null;
let janitor = null;

// ── helpers ─────────────────────────────────────────────────────────────────

function _id() { return 'tsk_' + crypto.randomBytes(10).toString('hex'); }

function _clampInt(v, min, max, dflt) {
    const x = parseInt(v, 10);
    if (!Number.isFinite(x)) return dflt;
    return Math.min(Math.max(x, min), max);
}

function _now() { return Date.now(); }

function _public(t) {
    if (!t) return null;
    return {
        id: t.id,
        kind: t.kind,
        state: t.state,
        priority: t.priority,
        attempts: t.attempts,
        max_attempts: t.max_attempts,
        origin: t.origin,
        context_id: t.context_id,
        principal: t.principal,
        trace_id: t.trace_id,
        payload: t.payload,
        result: t.result,
        error: t.error,
        interrupted: t.interrupted || null,
        usage: t.usage,
        budget: t.budget,
        metadata: t.metadata,
        lease_worker: t.lease ? t.lease.worker : null,
        lease_expires_at_ms: t.lease ? t.lease.expires_at_ms : null,
        created_at_ms: t.created_at_ms,
        updated_at_ms: t.updated_at_ms,
        started_at_ms: t.started_at_ms,
        completed_at_ms: t.completed_at_ms,
        duration_ms: t.started_at_ms && t.completed_at_ms ? t.completed_at_ms - t.started_at_ms : null,
        expires_at_ms: t.expires_at_ms,
        not_before_ms: t.not_before_ms,
    };
}

function _evict() {
    if (tasks.size <= CFG.maxTasks) return;
    // Evict TERMINAL tasks oldest-first. Never evict live work.
    const terminal = [...tasks.values()]
        .filter((t) => TERMINAL.has(t.state))
        .sort((a, b) => a.updated_at_ms - b.updated_at_ms);
    for (const t of terminal) {
        if (tasks.size <= CFG.maxTasks) break;
        tasks.delete(t.id);
    }
    // Still over? The queue is entirely live — refuse to grow past the cap
    // by dropping the OLDEST QUEUED work (never running work).
    while (tasks.size > CFG.maxTasks) {
        const oldest = [...tasks.values()]
            .filter((t) => t.state === 'queued')
            .sort((a, b) => a.created_at_ms - b.created_at_ms)[0];
        if (!oldest) break;
        tasks.delete(oldest.id);
    }
}

// ── submit ──────────────────────────────────────────────────────────────────

/**
 * Submit a task.
 *
 * IDEMPOTENT on `id`: resubmitting the same id returns the EXISTING task
 * with `created:false`. A retry must never double-execute work.
 *
 * @param {object} spec
 * @param {string} [spec.id]           external id (idempotency key)
 * @param {string} spec.kind           'chat' | 'code' | 'task' | 'a2a' | ...
 * @param {any}    [spec.payload]
 * @param {number} [spec.priority]     higher = sooner (default 0, max 100)
 * @param {number} [spec.not_before_ms]
 * @param {number} [spec.ttl_s]
 * @param {number} [spec.max_attempts]
 * @param {object} [spec.budget]       {max_tokens, max_cost_usd, max_duration_ms}
 * @param {string} [spec.origin]       who submitted (hive, peer, user id)
 * @param {string} [spec.context_id]   conversation/grouping id
 * @param {string} [spec.principal]    who is accountable
 * @param {string} [spec.trace_id]     inherited trace
 * @param {object} [spec.metadata]
 * @param {boolean}[spec.reject]       submit already-rejected (policy etc.)
 * @param {string} [spec.reject_reason]
 * @returns {{task: object, created: boolean}}
 */
function submit(spec = {}) {
    const id = String(spec.id || _id()).slice(0, 120);
    const existing = tasks.get(id);
    if (existing) return { task: _public(existing), created: false };

    const now = _now();
    const ttlMs = _clampInt(spec.ttl_s !== undefined ? spec.ttl_s * 1000 : CFG.defaultTtlMs, 1000, CFG.maxTtlMs, CFG.defaultTtlMs);
    const priority = _clampInt(spec.priority, -100, 100, 0);

    let payload = spec.payload === undefined ? null : spec.payload;
    if (typeof payload === 'string' && payload.length > CFG.maxPayloadChars) {
        payload = payload.slice(0, CFG.maxPayloadChars);
    }

    const task = {
        id,
        kind: String(spec.kind || 'generic').slice(0, 64),
        state: spec.reject ? 'rejected' : 'queued',
        priority,
        attempts: 0,
        max_attempts: _clampInt(spec.max_attempts, 1, 10, CFG.defaultMaxAttempts),
        origin: spec.origin ? String(spec.origin).slice(0, 120) : null,
        context_id: spec.context_id ? String(spec.context_id).slice(0, 120) : null,
        principal: spec.principal ? String(spec.principal).slice(0, 120) : null,
        trace_id: spec.trace_id ? String(spec.trace_id).slice(0, 64) : null,
        payload,
        result: null,
        error: spec.reject
            ? { class: 'rejected', message: String(spec.reject_reason || 'rejected').slice(0, 500) }
            : null,
        usage: { tokens: 0, cost_usd: 0, duration_ms: 0 },
        budget: spec.budget && typeof spec.budget === 'object' ? spec.budget : null,
        metadata: spec.metadata && typeof spec.metadata === 'object' ? spec.metadata : {},
        lease: null,
        created_at_ms: now,
        updated_at_ms: now,
        started_at_ms: null,
        completed_at_ms: spec.reject ? now : null,
        expires_at_ms: now + ttlMs,
        not_before_ms: spec.not_before_ms ? Number(spec.not_before_ms) : now,
    };

    tasks.set(id, task);
    _evict();
    _persist(task);
    return { task: _public(task), created: true };
}

// ── read ────────────────────────────────────────────────────────────────────

function get(id) {
    return _public(tasks.get(String(id || '')));
}

function list(filter = {}) {
    const out = [];
    for (const t of tasks.values()) {
        if (filter.state && t.state !== filter.state) continue;
        if (filter.kind && t.kind !== filter.kind) continue;
        if (filter.origin && t.origin !== filter.origin) continue;
        if (filter.context_id && t.context_id !== filter.context_id) continue;
        if (filter.principal && t.principal !== filter.principal) continue;
        out.push(t);
    }
    out.sort((a, b) => (b.priority - a.priority) || (a.created_at_ms - b.created_at_ms));
    const limit = _clampInt(filter.limit, 1, 500, 50);
    return out.slice(0, limit).map(_public);
}

/** Tasks that are ready to run right now (queued, due, not expired). */
function due(filter = {}) {
    const now = _now();
    const out = [];
    for (const t of tasks.values()) {
        if (t.state !== 'queued') continue;
        if (t.not_before_ms > now) continue;
        if (t.expires_at_ms <= now) continue;
        if (filter.kind && t.kind !== filter.kind) continue;
        if (filter.origin && t.origin !== filter.origin) continue;
        out.push(t);
    }
    out.sort((a, b) => (b.priority - a.priority) || (a.created_at_ms - b.created_at_ms));
    return out.slice(0, _clampInt(filter.limit, 1, 100, 10)).map(_public);
}

// ── claim / lease ───────────────────────────────────────────────────────────

/**
 * Lease the next runnable task to a worker.
 * @param {object} opts
 * @param {string} opts.worker           who is claiming
 * @param {string} [opts.kind]           restrict to one kind
 * @param {number} [opts.lease_s]
 * @param {number} [opts.limit]
 * @returns {object|null} the claimed task
 */
function claim(opts = {}) {
    const worker = String(opts.worker || 'anonymous').slice(0, 120);
    const now = _now();
    const candidates = due({ kind: opts.kind, limit: 50 });
    for (const pub of candidates) {
        const t = tasks.get(pub.id);
        if (!t || t.state !== 'queued') continue;
        t.state = 'running';
        t.attempts += 1;
        t.started_at_ms = t.started_at_ms || now;
        t.updated_at_ms = now;
        t.lease = {
            worker,
            expires_at_ms: now + _clampInt(opts.lease_s !== undefined ? opts.lease_s * 1000 : CFG.defaultLeaseMs, 1000, CFG.maxLeaseMs, CFG.defaultLeaseMs),
        };
        _persist(t);
        return _public(t);
    }
    return null;
}

/** Extend a lease. Returns the new expiry, or null if the lease was lost. */
function extendLease(id, opts = {}) {
    const t = tasks.get(String(id || ''));
    if (!t || t.state !== 'running') return null;
    if (opts.worker && t.lease && t.lease.worker !== opts.worker) return null;
    const now = _now();
    t.lease = {
        worker: (t.lease && t.lease.worker) || String(opts.worker || 'anonymous'),
        expires_at_ms: now + _clampInt(opts.lease_s !== undefined ? opts.lease_s * 1000 : CFG.defaultLeaseMs, 1000, CFG.maxLeaseMs, CFG.defaultLeaseMs),
    };
    t.updated_at_ms = now;
    _persist(t);
    return t.lease.expires_at_ms;
}

// ── terminal transitions ────────────────────────────────────────────────────

function _ownedBy(t, worker) {
    if (!worker) return true;
    if (!t.lease) return true;
    return t.lease.worker === worker;
}

/**
 * Complete a task successfully.
 * @returns {{ok: boolean, error?: string, task?: object}}
 */
function complete(id, opts = {}) {
    const t = tasks.get(String(id || ''));
    if (!t) return { ok: false, error: 'not_found' };
    if (t.state !== 'running') return { ok: false, error: 'not_running', state: t.state };
    if (!_ownedBy(t, opts.worker)) return { ok: false, error: 'not_owner' };

    const now = _now();
    t.state = 'done';
    t.result = opts.result === undefined ? null : opts.result;
    t.lease = null;
    t.updated_at_ms = now;
    t.completed_at_ms = now;
    if (opts.usage && typeof opts.usage === 'object') {
        t.usage = {
            tokens: Number(opts.usage.tokens) || 0,
            cost_usd: Number(opts.usage.cost_usd) || 0,
            duration_ms: t.started_at_ms ? now - t.started_at_ms : 0,
        };
    } else if (t.started_at_ms) {
        t.usage.duration_ms = now - t.started_at_ms;
    }
    _persist(t);
    return { ok: true, task: _public(t) };
}

/**
 * Fail a task. A RETRYABLE failure returns the task to `queued` (up to
 * max_attempts); otherwise it is terminal.
 * @returns {{ok: boolean, error?: string, task?: object, requeued?: boolean}}
 */
function fail(id, opts = {}) {
    const t = tasks.get(String(id || ''));
    if (!t) return { ok: false, error: 'not_found' };
    if (t.state !== 'running') return { ok: false, error: 'not_running', state: t.state };
    if (!_ownedBy(t, opts.worker)) return { ok: false, error: 'not_owner' };

    const now = _now();
    const retryable = opts.retryable !== false;
    const err = {
        class: String(opts.error_class || opts.errorCode || 'unknown').slice(0, 64),
        message: String(opts.error || opts.error_message || 'failed').slice(0, 500),
    };
    t.error = err;
    t.lease = null;
    t.updated_at_ms = now;

    if (retryable && t.attempts < t.max_attempts) {
        t.state = 'queued';
        t.started_at_ms = null;
        // Exponential-ish backoff, capped.
        t.not_before_ms = now + Math.min(30000, 500 * Math.pow(2, t.attempts));
        _persist(t);
        return { ok: true, requeued: true, task: _public(t) };
    }
    t.state = 'failed';
    t.completed_at_ms = now;
    if (t.started_at_ms) t.usage.duration_ms = now - t.started_at_ms;
    _persist(t);
    return { ok: true, requeued: false, task: _public(t) };
}

/** Cancel a task. A running task is cancelled; the worker learns on its next lease check. */
function cancel(id, opts = {}) {
    const t = tasks.get(String(id || ''));
    if (!t) return { ok: false, error: 'not_found' };
    if (TERMINAL.has(t.state)) return { ok: false, error: 'already_terminal', state: t.state };
    const now = _now();
    t.state = 'canceled';
    t.error = { class: 'canceled', message: String(opts.reason || 'canceled').slice(0, 500) };
    t.lease = null;
    t.updated_at_ms = now;
    t.completed_at_ms = now;
    _persist(t);
    return { ok: true, task: _public(t) };
}

/**
 * INTERRUPT a running task — it needs something from the caller before it can
 * continue (more input, or a human's approval).
 *
 * The task stays ALIVE (state 'running', lease released): an interrupted task
 * is not a failed task. It carries `interrupted = {kind, reason}` so the
 * caller can render "waiting for you" instead of "it broke".
 *
 * The kind is 'input' (the agent needs more from you) or 'auth' (a human
 * must approve). A2A maps these onto TASK_STATE_INPUT_REQUIRED and
 * TASK_STATE_AUTH_REQUIRED.
 */
function interrupt(id, opts = {}) {
    const t = tasks.get(String(id || ''));
    if (!t) return { ok: false, error: 'not_found' };
    if (TERMINAL.has(t.state)) return { ok: false, error: 'already_terminal', state: t.state };
    const now = _now();
    t.state = 'running';
    t.lease = null;
    t.updated_at_ms = now;
    t.interrupted = {
        kind: String(opts.kind || 'input').slice(0, 16),
        reason: String(opts.reason || '').slice(0, 500),
        at_ms: now,
    };
    _persist(t);
    return { ok: true, task: _public(t) };
}

/**
 * RESUME an interrupted task — the caller supplied what was missing.
 * The task goes back to 'running' with a fresh lease.
 */
function resume(id, opts = {}) {
    const t = tasks.get(String(id || ''));
    if (!t) return { ok: false, error: 'not_found' };
    if (!t.interrupted) return { ok: false, error: 'not_interrupted', state: t.state };
    const now = _now();
    t.interrupted = null;
    t.state = 'running';
    t.updated_at_ms = now;
    t.lease = {
        worker: String(opts.worker || 'anonymous').slice(0, 120),
        expires_at_ms: now + _clampInt(opts.lease_s !== undefined ? opts.lease_s * 1000 : CFG.defaultLeaseMs, 1000, CFG.maxLeaseMs, CFG.defaultLeaseMs),
    };
    _persist(t);
    return { ok: true, task: _public(t) };
}

/** Reject a task (policy, allowance, loop detection). Never retried. */
function reject(id, reason) {
    const t = tasks.get(String(id || ''));
    if (!t) return { ok: false, error: 'not_found' };
    if (TERMINAL.has(t.state)) return { ok: false, error: 'already_terminal', state: t.state };
    const now = _now();
    t.state = 'rejected';
    t.error = { class: 'rejected', message: String(reason || 'rejected').slice(0, 500) };
    t.lease = null;
    t.updated_at_ms = now;
    t.completed_at_ms = now;
    _persist(t);
    return { ok: true, task: _public(t) };
}

// ── janitor ─────────────────────────────────────────────────────────────────

/**
 * Expire what is due and reclaim work whose lease lapsed.
 * Returns a summary of what changed (useful in tests and in the overview).
 */
function sweep() {
    const now = _now();
    let expired = 0, reclaimed = 0, exhausted = 0;

    for (const t of tasks.values()) {
        if (t.state === 'queued' && t.expires_at_ms <= now) {
            t.state = 'expired';
            t.error = { class: 'expired', message: 'ttl expired before pickup' };
            t.updated_at_ms = now;
            t.completed_at_ms = now;
            expired++;
            continue;
        }
        if (t.state === 'running' && t.lease && t.lease.expires_at_ms <= now) {
            t.attempts += 1;
            t.updated_at_ms = now;
            t.lease = null;
            if (t.attempts >= t.max_attempts) {
                t.state = 'failed';
                t.error = { class: 'lease_expired', message: 'worker stopped heartbeating' };
                t.completed_at_ms = now;
                exhausted++;
            } else {
                t.state = 'queued';
                t.started_at_ms = null;
                t.not_before_ms = now + 1000;
                reclaimed++;
            }
        }
    }
    if (expired || reclaimed || exhausted) _evict();
    return { expired, reclaimed, exhausted };
}

// ── stats ───────────────────────────────────────────────────────────────────

function stats() {
    const now = _now();
    const byState = {};
    for (const s of STATES) byState[s] = 0;
    const byKind = {};
    let oldestQueuedMs = null;
    let oldestTaskMs = null;
    for (const t of tasks.values()) {
        byState[t.state] = (byState[t.state] || 0) + 1;
        byKind[t.kind] = (byKind[t.kind] || 0) + 1;
        const age = now - t.created_at_ms;
        if (oldestTaskMs === null || age > oldestTaskMs) oldestTaskMs = age;
        if (t.state === 'queued') {
            const q = now - t.created_at_ms;
            if (oldestQueuedMs === null || q > oldestQueuedMs) oldestQueuedMs = q;
        }
    }
    return {
        total: tasks.size,
        by_state: byState,
        by_kind: byKind,
        queued: byState.queued || 0,
        running: byState.running || 0,
        terminal: tasks.size - (byState.queued || 0) - (byState.running || 0),
        oldest_queued_age_ms: oldestQueuedMs,
        oldest_task_age_ms: oldestTaskMs,
        database: pool ? 'connected' : 'memory-only',
    };
}

// ── optional Postgres mirror ────────────────────────────────────────────────

async function ensureSchema() {
    if (!pool) return false;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS hivv_task_queue (
                id            TEXT PRIMARY KEY,
                kind          TEXT NOT NULL DEFAULT 'generic',
                state         TEXT NOT NULL DEFAULT 'queued',
                priority      INTEGER NOT NULL DEFAULT 0,
                attempts      INTEGER NOT NULL DEFAULT 0,
                max_attempts  INTEGER NOT NULL DEFAULT 3,
                origin        TEXT,
                context_id    TEXT,
                principal     TEXT,
                trace_id      TEXT,
                payload       JSONB,
                result        JSONB,
                error         JSONB,
                usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
                budget        JSONB,
                metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
                lease_worker  TEXT,
                lease_expires_at_ms BIGINT,
                created_at_ms BIGINT NOT NULL DEFAULT 0,
                updated_at_ms BIGINT NOT NULL DEFAULT 0,
                started_at_ms BIGINT,
                completed_at_ms BIGINT,
                expires_at_ms BIGINT NOT NULL DEFAULT 0,
                not_before_ms BIGINT NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_hivv_task_queue_state ON hivv_task_queue (state, priority DESC, created_at_ms);
            CREATE INDEX IF NOT EXISTS idx_hivv_task_queue_context ON hivv_task_queue (context_id, created_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_hivv_task_queue_origin ON hivv_task_queue (origin, created_at_ms DESC);
        `);
        return true;
    } catch (err) {
        console.warn('[task-queue] schema setup failed:', err.message);
        return false;
    }
}

function _persist(t) {
    if (!pool) return;
    // Fire-and-forget: a slow database must never delay a task transition.
    const sql = `
        INSERT INTO hivv_task_queue
          (id, kind, state, priority, attempts, max_attempts, origin, context_id,
           principal, trace_id, payload, result, error, usage, budget, metadata,
           lease_worker, lease_expires_at_ms, created_at_ms, updated_at_ms,
           started_at_ms, completed_at_ms, expires_at_ms, not_before_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        ON CONFLICT (id) DO UPDATE SET
          state = EXCLUDED.state,
          priority = EXCLUDED.priority,
          attempts = EXCLUDED.attempts,
          result = EXCLUDED.result,
          error = EXCLUDED.error,
          usage = EXCLUDED.usage,
          lease_worker = EXCLUDED.lease_worker,
          lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
          updated_at_ms = EXCLUDED.updated_at_ms,
          started_at_ms = EXCLUDED.started_at_ms,
          completed_at_ms = EXCLUDED.completed_at_ms
    `;
    pool.query(sql, [
        t.id, t.kind, t.state, t.priority, t.attempts, t.max_attempts,
        t.origin, t.context_id, t.principal, t.trace_id,
        t.payload === undefined ? null : JSON.stringify(t.payload),
        t.result === undefined ? null : JSON.stringify(t.result),
        t.error ? JSON.stringify(t.error) : null,
        JSON.stringify(t.usage || {}),
        t.budget ? JSON.stringify(t.budget) : null,
        JSON.stringify(t.metadata || {}),
        t.lease ? t.lease.worker : null,
        t.lease ? t.lease.expires_at_ms : null,
        t.created_at_ms, t.updated_at_ms, t.started_at_ms, t.completed_at_ms,
        t.expires_at_ms, t.not_before_ms,
    ]).catch((err) => console.warn('[task-queue] persist failed:', err.message));
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function start(pgPool) {
    pool = pgPool || null;
    if (!janitor) {
        janitor = setInterval(() => { try { sweep(); } catch (_e) { /* never crash the loop */ } }, CFG.janitorMs);
        if (janitor.unref) janitor.unref();
    }
    if (pool) ensureSchema().catch(() => {});
    console.log(`[task-queue] started (${pool ? 'db mirror on' : 'memory only'})`);
}

function stop() {
    if (janitor) clearInterval(janitor);
    janitor = null;
}

/** Wipe in-memory state (tests / operator reset). */
function reset() {
    tasks.clear();
}

module.exports = {
    CFG,
    STATES,
    TERMINAL,
    submit,
    get,
    list,
    due,
    claim,
    extendLease,
    complete,
    fail,
    cancel,
    reject,
    interrupt,
    resume,
    sweep,
    stats,
    start,
    stop,
    reset,
    ensureSchema,
    // The raw store, for tests that need to simulate time passing (there is
    // deliberately no clock injection in production code — a fake clock is a
    // footgun — so the tests reach in here instead).
    _internal: () => tasks,
};
