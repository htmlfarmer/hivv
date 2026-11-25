// api/lib/hive-clients.js — ONE interface for reaching work that lives
// somewhere else.
//
// THE PROBLEM
// ──────────
// "Run this task somewhere else" means different things to different peers:
//
//   a bee in OUR hive          → the long-poll inbox (lib/relay.js)
//   another HIVE (kwaai, …)   → open-hives/0.1  POST /api/bridge/requests
//   another MCP SERVER        → tools/call over Streamable HTTP
//   another A2A AGENT         → SendMessage over JSON-RPC or REST
//   blnq.org's worker pool    → a signed claim on their jobs table
//
// Five protocols, five state vocabularies, five error shapes. Without a
// common shape, every caller grows its own special cases — and the caller
// that matters (the ROUTER) cannot choose.
//
// THE SHAPE
// ─────────
// Every adapter answers the same four questions:
//
//   probe(ctx)            → is this peer reachable, what can it do?
//   submit(spec, ctx)     → start the work; returns an external id + state
//   status(id, ctx)       → what happened to it?
//   cancel(id, ctx)       → stop it
//
// And every adapter maps the remote's vocabulary onto OUR task states
// (lib/task-queue.js): queued · running · done · failed · expired ·
// rejected · canceled. The mapping is explicit per adapter, never guessed.
//
// THE FIVE ADAPTERS
// ─────────────────
//   blnq     — blnq.org's worker pool. Worker-HMAC signed. We can CLAIM their
//              jobs and run them, which is the direction that needs no
//              session cookie and no account.
//   mcp      — any MCP server: tools/list + tools/call.
//   a2a      — any A2A agent: the agent card, SendMessage, GetTask, CancelTask.
//   bridge   — open-hives/0.1 peer hives: POST /api/bridge/requests.
//   local    — our own hive (the router). The default.
//
// SAFETY
// ──────
//   * Every outbound URL is SSRF-guarded (lib/ssrf.js).
//   * Every call has a hard deadline.
//   * The blnq adapter signs exactly as blnq.org verifies — same message
//     shape, same header names, same ±300s window. The two sides are a
//     contract; both implementations are pinned by the parity tests.
//
// THE NAMING LAW
// ──────────────
// A hive is named by its own domain. A peer adapter therefore reports its
// `peer` as the remote DOMAIN (kwaai.ai, blnq.org), never as "the other
// network". Two hives are two hives.

'use strict';

const crypto = require('crypto');
const ssrf = require('./ssrf');
const mcpClient = require('./mcp-client');
const a2aClient = require('./a2a-client');

// ── shared helpers ──────────────────────────────────────────────────────────

function _err(code, message, extra = {}) {
    return { ok: false, error: { code, message: String(message).slice(0, 500), ...extra } };
}

function _clampInt(v, min, max, dflt) {
    const x = parseInt(v, 10);
    if (!Number.isFinite(x)) return dflt;
    return Math.min(Math.max(x, min), max);
}

async function _http(url, opts = {}) {
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 120000);
    const verdict = await ssrf.checkUrl(url);
    if (!verdict.ok) return _err('ssrf_blocked', `refused to contact ${url}: ${verdict.reason}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method: opts.method || 'GET',
            headers: {
                Accept: 'application/json',
                ...(opts.headers || {}),
            },
            body: opts.body,
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
            return _err('timeout', `no response within ${timeoutMs}ms`);
        }
        return _err('connection', err && err.message ? err.message : 'connection failed');
    }
    clearTimeout(timer);

    let text = '';
    try { text = await res.text(); } catch (_e) { return _err('decode', 'could not read the response'); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not json — keep the text */ }

    if (!res.ok) {
        return _err('upstream_' + res.status, (json && json.error) || `remote answered ${res.status}`, {
            status: res.status, body: json || text.slice(0, 400),
        });
    }
    return { ok: true, json, text, status: res.status };
}

// ── the blnq.org adapter ────────────────────────────────────────────────────
//
// blnq.org runs its own worker pool with a jobs table, a worker inbox, and
// HMAC-signed worker calls. The signing format (lib/workerAuth.js there):
//
//   message   = `${ts}\n${nonce}\n${METHOD}\n${path}\n${sha256(rawBody)}`
//   signature = HMAC-SHA256(auth_token, message)
//   headers   = Authorization: Bearer <token>
//               X-Auth-Timestamp, X-Auth-Nonce, X-Auth-Signature
//
// `path` is the client-facing path INCLUDING the query string.
//
// We implement the WORKER direction: claim their jobs, run them, report
// output, complete. That direction needs only the worker token — no account,
// no session cookie. Submitting TO them requires a session, so it is left to
// the operator-facing path rather than faked here.

const BLNQ_DEFAULT_BASE = process.env.BLNQ_URL || 'https://blnq.org';

function _blnqSign({ token, method, path, body, timestamp, nonce }) {
    const ts = String(timestamp || Math.floor(Date.now() / 1000));
    const bodyBuf = Buffer.from(body || '', 'utf8');
    const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
    const message = `${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
    const signature = crypto.createHmac('sha256', token).update(message).digest('hex');
    return {
        'X-Auth-Timestamp': ts,
        'X-Auth-Nonce': nonce,
        'X-Auth-Signature': signature,
    };
}

const blnqAdapter = {
    id: 'blnq',
    protocol: 'blnq-jobs/1',

    describe() {
        return {
            id: this.id,
            protocol: this.protocol,
            base_url: BLNQ_DEFAULT_BASE,
            auth: 'worker-hmac',
            capabilities: ['claim', 'heartbeat', 'output', 'complete', 'inbox'],
            notes: 'blnq.org worker pool — signed claim/heartbeat/complete',
        };
    },

    _ctx(ctx = {}) {
        const base = String(ctx.base_url || BLNQ_DEFAULT_BASE).replace(/\/+$/, '');
        const token = ctx.token || process.env.BLNQ_WORKER_TOKEN || null;
        return { base, token };
    },

    async _signed(ctx, method, path, bodyObj) {
        const { base, token } = this._ctx(ctx);
        if (!token) return _err('auth', 'no blnq worker token (set one per peer)');
        const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
        const nonce = crypto.randomBytes(12).toString('hex');
        const headers = _blnqSign({ token, method, path, body, nonce });
        return _http(`${base}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...headers,
                ...(ctx.headers || {}),
            },
            body: body === '' ? undefined : body,
            timeoutMs: ctx.timeoutMs,
        });
    },

    /** Is the peer alive and what does it publish? */
    async probe(ctx = {}) {
        const { base } = this._ctx(ctx);
        const res = await _http(`${base}/api/workers/list`, { timeoutMs: ctx.timeoutMs, headers: ctx.headers });
        if (!res.ok) return res;
        const workers = (res.json && (res.json.workers || res.json)) || [];
        return {
            ok: true,
            peer: 'blnq.org',
            workers: Array.isArray(workers) ? workers.length : null,
            raw: res.json,
        };
    },

    /**
     * Claim a job from blnq's pool.
     * @param {object} ctx  {base_url, token, worker_id, langs, max_claims}
     */
    async claim(ctx = {}) {
        const workerId = ctx.worker_id || ctx.workerId;
        if (!workerId) return _err('validation', 'worker_id is required');
        const body = { worker_id: workerId };
        if (ctx.langs) body.langs = ctx.langs;
        if (ctx.max_claims) body.max_claims = _clampInt(ctx.max_claims, 1, 8, 1);
        const res = await this._signed(ctx, 'POST', '/api/jobs/claim', body);
        if (!res.ok) return res;
        const job = res.json && res.json.job;
        if (!job) return { ok: true, external_id: null, state: 'queued', raw: res.json, empty: true };
        return {
            ok: true,
            external_id: job.job_id || job.id,
            state: mapBlnqState(job.status),
            raw: job,
        };
    },

    /** The current state of one of their jobs. */
    async status(externalId, ctx = {}) {
        const { base } = this._ctx(ctx);
        const res = await _http(`${base}/api/jobs/${encodeURIComponent(externalId)}`, {
            timeoutMs: ctx.timeoutMs, headers: ctx.headers,
        });
        if (!res.ok) return res;
        const job = res.json && (res.json.job || res.json);
        return {
            ok: true,
            external_id: externalId,
            state: mapBlnqState(job && job.status),
            result: job,
            raw: job,
        };
    },

    /** Append output to a running job. */
    async output(externalId, ctx = {}) {
        const body = { worker_id: ctx.worker_id || ctx.workerId, line: ctx.line || '', line_number: ctx.line_number || 0 };
        const res = await this._signed(ctx, 'POST', `/api/jobs/${encodeURIComponent(externalId)}/output`, body);
        if (!res.ok) return res;
        return { ok: true, external_id: externalId, raw: res.json };
    },

    /** Keep the job alive (their reaper watches heartbeat_at). */
    async heartbeat(externalId, ctx = {}) {
        const body = { worker_id: ctx.worker_id || ctx.workerId };
        const res = await this._signed(ctx, 'POST', `/api/jobs/${encodeURIComponent(externalId)}/heartbeat`, body);
        if (!res.ok) return res;
        return { ok: true, external_id: externalId, raw: res.json };
    },

    /** Finish a claimed job. */
    async complete(externalId, ctx = {}) {
        const body = {
            worker_id: ctx.worker_id || ctx.workerId,
            status: ctx.status || 'success',
            output: ctx.output || '',
            exit_code: ctx.exit_code === undefined ? 0 : ctx.exit_code,
            duration_ms: ctx.duration_ms || 0,
            error: ctx.error || null,
        };
        const res = await this._signed(ctx, 'POST', `/api/jobs/${encodeURIComponent(externalId)}/complete`, body);
        if (!res.ok) return res;
        return { ok: true, external_id: externalId, state: body.status === 'success' ? 'done' : 'failed', raw: res.json };
    },

    /** Cancel one of their jobs (their cancel is owner-only; we try anyway). */
    async cancel(externalId, ctx = {}) {
        const { base } = this._ctx(ctx);
        const res = await _http(`${base}/api/jobs/${encodeURIComponent(externalId)}/cancel`, {
            method: 'POST', timeoutMs: ctx.timeoutMs, headers: ctx.headers,
        });
        if (!res.ok) return res;
        return { ok: true, external_id: externalId, state: 'canceled', raw: res.json };
    },

    /** Read the worker inbox (nudges from their hub: job_available, …). */
    async inbox(ctx = {}) {
        const workerId = ctx.worker_id || ctx.workerId;
        if (!workerId) return _err('validation', 'worker_id is required');
        const path = `/api/agents/${encodeURIComponent(workerId)}/inbox`;
        const res = await this._signed(ctx, 'GET', path, undefined);
        if (!res.ok) return res;
        return { ok: true, messages: (res.json && (res.json.messages || res.json)) || [], raw: res.json };
    },
};

function mapBlnqState(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'pending' || s === 'queued') return 'queued';
    if (s === 'claimed' || s === 'running') return 'running';
    if (s === 'success' || s === 'completed' || s === 'done') return 'done';
    if (s === 'failed' || s === 'timeout' || s === 'error') return 'failed';
    if (s === 'cancelled' || s === 'canceled') return 'canceled';
    return 'unknown';
}

// ── the MCP adapter ─────────────────────────────────────────────────────────

const mcpAdapter = {
    id: 'mcp',
    protocol: 'mcp/streamable-http',

    describe() {
        return {
            id: this.id,
            protocol: this.protocol,
            capabilities: ['tools/list', 'tools/call'],
            notes: 'any MCP server over Streamable HTTP (stateless JSON-RPC)',
        };
    },

    async probe(ctx = {}) {
        const res = await mcpClient.probe(ctx.url, ctx);
        if (!res.ok) return res;
        return { ok: true, peer: ctx.url, tools: res.tools.length, raw: { server: res.server, tools: res.tools } };
    },

    async submit(spec, ctx = {}) {
        // An MCP "task" is a tool call. The tool name is the work; the
        // arguments are the payload.
        const tool = spec.tool || (spec.payload && spec.payload.tool);
        if (!tool) return _err('validation', 'an MCP submit needs a tool name');
        const args = (spec.payload && spec.payload.arguments) || spec.payload || {};
        const res = await mcpClient.callTool(ctx.url, tool, args, ctx);
        if (!res.ok) return res;
        return {
            ok: true,
            external_id: `mcp:${tool}`,
            state: res.isError ? 'failed' : 'done',
            result: res.result,
            raw: res,
        };
    },

    async status() {
        // An MCP tool call is synchronous — there is nothing to poll.
        return { ok: true, state: 'done', note: 'MCP tool calls are synchronous' };
    },

    async cancel() {
        return { ok: true, state: 'canceled', note: 'MCP tool calls cannot be cancelled' };
    },
};

// ── the A2A adapter ─────────────────────────────────────────────────────────

const a2aAdapter = {
    id: 'a2a',
    protocol: 'a2a/1.0',

    describe() {
        return {
            id: this.id,
            protocol: this.protocol,
            capabilities: ['agent-card', 'SendMessage', 'GetTask', 'CancelTask'],
            notes: 'any A2A agent — JSON-RPC binding first, REST second',
        };
    },

    async probe(ctx = {}) {
        const res = await a2aClient.getAgentCard(ctx.url, ctx);
        if (!res.ok) return res;
        const card = res.card || {};
        return {
            ok: true,
            peer: ctx.url,
            name: card.name || null,
            skills: Array.isArray(card.skills) ? card.skills.length : 0,
            raw: card,
        };
    },

    async submit(spec, ctx = {}) {
        const text = typeof spec.payload === 'string'
            ? spec.payload
            : (spec.payload && (spec.payload.text || spec.payload.prompt)) || '';
        const message = spec.message || a2aClient.textMessage(text, { metadata: spec.metadata });
        const res = await a2aClient.sendMessage(ctx.url, message, {
            ...ctx,
            taskId: spec.external_task_id,
            contextId: spec.context_id,
        });
        if (!res.ok) return res;
        if (res.message) {
            return {
                ok: true,
                external_id: (res.message.messageId) || `a2a:${Date.now()}`,
                state: 'done',
                result: { text: a2aClient.extractText(res.message), message: res.message },
                raw: res.message,
            };
        }
        const task = res.task || {};
        return {
            ok: true,
            external_id: task.id || `a2a:${Date.now()}`,
            state: mapA2aState(task.state),
            result: task,
            raw: task,
        };
    },

    async status(externalId, ctx = {}) {
        const res = await a2aClient.getTask(ctx.url, externalId, ctx);
        if (!res.ok) return res;
        const task = res.task || {};
        return {
            ok: true,
            external_id: externalId,
            state: mapA2aState(task.state),
            result: task,
            raw: task,
        };
    },

    async cancel(externalId, ctx = {}) {
        const res = await a2aClient.cancelTask(ctx.url, externalId, ctx);
        if (!res.ok) return res;
        return { ok: true, external_id: externalId, state: 'canceled', raw: res.raw || null };
    },
};

function mapA2aState(state) {
    const s = String(state || '').toUpperCase();
    if (!s) return 'unknown';
    if (s === 'TASK_STATE_COMPLETED') return 'done';
    if (s === 'TASK_STATE_FAILED') return 'failed';
    if (s === 'TASK_STATE_CANCELED') return 'canceled';
    if (s === 'TASK_STATE_REJECTED') return 'rejected';
    if (s === 'TASK_STATE_SUBMITTED' || s === 'TASK_STATE_WORKING') return 'running';
    if (s === 'TASK_STATE_INPUT_REQUIRED' || s === 'TASK_STATE_AUTH_REQUIRED') return 'running';
    return 'unknown';
}

// ── the bridge adapter (open-hives/0.1) ────────────────────────────────────
//
// A peer hive accepts work at POST /api/bridge/requests and answers with a
// request id. The peer publishes an ALLOWANCE (0–85%); at 0% it REJECTS the
// work rather than failing it. We honour that: a rejection is terminal.

const bridgeAdapter = {
    id: 'bridge',
    protocol: 'open-hives/0.1',

    describe() {
        return {
            id: this.id,
            protocol: this.protocol,
            capabilities: ['submit', 'status', 'cancel', 'allowance', 'load'],
            notes: 'peer hive via open-hives/0.1 (/api/bridge/requests)',
        };
    },

    async probe(ctx = {}) {
        const base = String(ctx.base_url || '').replace(/\/+$/, '');
        if (!base) return _err('validation', 'a peer base_url is required');
        const res = await _http(`${base}/api/bridge/load`, { timeoutMs: ctx.timeoutMs, headers: ctx.headers });
        if (!res.ok) return res;
        return { ok: true, peer: base, raw: res.json };
    },

    async submit(spec, ctx = {}) {
        const base = String(ctx.base_url || '').replace(/\/+$/, '');
        if (!base) return _err('validation', 'a peer base_url is required');
        const body = {
            id: spec.external_id,
            kind: spec.kind || 'chat',
            payload: spec.payload,
            callback: spec.callback,
            priority: spec.priority || 0,
            not_before: spec.not_before || 0,
            ttl_s: spec.ttl_s || 3600,
            budget: spec.budget || undefined,
        };
        const res = await _http(`${base}/api/bridge/requests`, {
            method: 'POST',
            timeoutMs: ctx.timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'X-Hive-Origin': ctx.origin || 'hivv.org',
                'X-Hive-Request-Id': spec.external_id || '',
                ...(ctx.headers || {}),
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const status = res.error && res.error.status;
            if (status === 409) return { ok: false, state: 'rejected', error: res.error };
            return res;
        }
        const json = res.json || {};
        return {
            ok: true,
            external_id: json.id || spec.external_id,
            state: mapBridgeState(json.state),
            position: json.position,
            raw: json,
        };
    },

    async status(externalId, ctx = {}) {
        const base = String(ctx.base_url || '').replace(/\/+$/, '');
        const res = await _http(`${base}/api/bridge/requests/${encodeURIComponent(externalId)}`, {
            timeoutMs: ctx.timeoutMs, headers: ctx.headers,
        });
        if (!res.ok) return res;
        const json = res.json || {};
        return { ok: true, external_id: externalId, state: mapBridgeState(json.state), result: json.result || json, raw: json };
    },

    async cancel(externalId, ctx = {}) {
        const base = String(ctx.base_url || '').replace(/\/+$/, '');
        const res = await _http(`${base}/api/bridge/requests/${encodeURIComponent(externalId)}/cancel`, {
            method: 'POST', timeoutMs: ctx.timeoutMs, headers: ctx.headers,
        });
        if (!res.ok) return res;
        return { ok: true, external_id: externalId, state: 'canceled', raw: res.json };
    },

    /** The peer's live allowance — how much of their roof we may use. */
    async allowance(ctx = {}) {
        const base = String(ctx.base_url || '').replace(/\/+$/, '');
        const res = await _http(`${base}/api/bridge/allowance?peer=${encodeURIComponent(ctx.peer || 'hivv.org')}`, {
            timeoutMs: ctx.timeoutMs, headers: ctx.headers,
        });
        if (!res.ok) return res;
        return { ok: true, raw: res.json };
    },
};

function mapBridgeState(state) {
    const s = String(state || '').toLowerCase();
    if (s === 'queued' || s === 'pending') return 'queued';
    if (s === 'running') return 'running';
    if (s === 'done' || s === 'completed' || s === 'success') return 'done';
    if (s === 'failed' || s === 'error') return 'failed';
    if (s === 'expired') return 'expired';
    if (s === 'rejected') return 'rejected';
    if (s === 'canceled' || s === 'cancelled') return 'canceled';
    return 'unknown';
}

// ── the registry ────────────────────────────────────────────────────────────

const ADAPTERS = {
    blnq: blnqAdapter,
    mcp: mcpAdapter,
    a2a: a2aAdapter,
    bridge: bridgeAdapter,
};

/** Every adapter, described. */
function list() {
    return Object.values(ADAPTERS).map((a) => a.describe());
}

function get(id) {
    return ADAPTERS[String(id || '').toLowerCase()] || null;
}

/**
 * Submit work to a peer and return a normalized answer.
 *
 * @param {object} spec  {kind, payload, tool, priority, ttl_s, budget,
 *                         external_id, context_id, callback}
 * @param {object} ctx   {adapter, url, base_url, token, headers, …}
 * @returns {Promise<object>} {ok, external_id, state, result, raw}
 */
async function submit(spec, ctx = {}) {
    const adapter = get(ctx.adapter);
    if (!adapter) return _err('unknown_adapter', `no adapter named '${ctx.adapter}'`);
    try {
        return await adapter.submit(spec, ctx);
    } catch (err) {
        return _err('adapter_failed', err && err.message ? err.message : 'the adapter threw');
    }
}

/** Poll a peer's work. */
async function status(externalId, ctx = {}) {
    const adapter = get(ctx.adapter);
    if (!adapter) return _err('unknown_adapter', `no adapter named '${ctx.adapter}'`);
    try {
        return await adapter.status(externalId, ctx);
    } catch (err) {
        return _err('adapter_failed', err && err.message ? err.message : 'the adapter threw');
    }
}

/** Cancel a peer's work. */
async function cancel(externalId, ctx = {}) {
    const adapter = get(ctx.adapter);
    if (!adapter) return _err('unknown_adapter', `no adapter named '${ctx.adapter}'`);
    try {
        return await adapter.cancel(externalId, ctx);
    } catch (err) {
        return _err('adapter_failed', err && err.message ? err.message : 'the adapter threw');
    }
}

/** Probe a peer. */
async function probe(ctx = {}) {
    const adapter = get(ctx.adapter);
    if (!adapter) return _err('unknown_adapter', `no adapter named '${ctx.adapter}'`);
    try {
        return await adapter.probe(ctx);
    } catch (err) {
        return _err('adapter_failed', err && err.message ? err.message : 'the adapter threw');
    }
}

module.exports = {
    ADAPTERS,
    list,
    get,
    submit,
    status,
    cancel,
    probe,
    _blnqSign,
    mapBlnqState,
    mapA2aState,
    mapBridgeState,
};
