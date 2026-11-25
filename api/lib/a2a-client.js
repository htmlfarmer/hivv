// api/lib/a2a-client.js — the OUTBOUND half of A2A interoperability.
//
// WHAT A2A IS
// ───────────
// A2A (Agent2Agent, v1.0) is the other standard in the same family as MCP,
// but it is about WORK rather than TOOLS:
//
//   MCP  — "here are my tools; call one"          (stateless-ish, tool-shaped)
//   A2A  — "here is my agent; give it a task"     (stateful, task-shaped)
//
// An A2A server publishes an AGENT CARD at
//     /.well-known/agent-card.json
// describing its identity, its skills, its transports, and its auth. A client
// then either:
//
//   * SendMessage    — hand it work, get a Task back
//   * SendStreamingMessage — the same, but watch it happen over SSE
//   * GetTask        — poll the task
//   * CancelTask     — stop it
//
// Two bindings are defined. We speak BOTH:
//   * JSON-RPC 2.0 over HTTP  (POST a single endpoint, method in the body)
//   * REST/JSON              (POST /message:send, GET /tasks/{id}, …)
//
// The JSON-RPC binding is the canonical one, so it is what we try first; the
// REST binding is the fallback for servers that only implemented that shape.
//
// TASK STATES (spec §4.1.3)
// ──────────────────────────
//   working     : TASK_STATE_SUBMITTED, TASK_STATE_WORKING
//   interrupted : TASK_STATE_INPUT_REQUIRED, TASK_STATE_AUTH_REQUIRED
//   terminal    : TASK_STATE_COMPLETED, TASK_STATE_FAILED,
//                 TASK_STATE_CANCELED, TASK_STATE_REJECTED
//
// The interrupted states are the interesting ones: the agent can stop and ask
// the client for more input mid-task. We surface them faithfully instead of
// flattening them into "failed".
//
// SAFETY
// ──────
//   * SSRF-guarded outbound URLs (lib/ssrf.js).
//   * Hard deadline (default 30s) and a response size cap.
//   * We NEVER invent a persona or rewrite the peer's content — we carry
//     bytes, not judgment (the bridge law, applied to A2A).

'use strict';

const ssrf = require('./ssrf');

const CFG = {
    timeoutMs: 30000,
    maxResponseBytes: 4 * 1024 * 1024,
    maxTextChars: 500000,
};

const TASK_STATES = [
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED',
];

const TERMINAL_STATES = new Set([
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED',
]);

const WORKING_STATES = new Set([
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
]);

function _err(code, message, extra = {}) {
    return { ok: false, error: { code, message: String(message).slice(0, 500), ...extra } };
}

function _nowIso() { return new Date().toISOString(); }

function _rpcId() {
    return 'a2a-' + Math.random().toString(36).slice(2, 12);
}

/**
 * Fetch an agent card.
 * @param {string} baseUrl  the agent's base URL (we append the well-known path)
 * @param {object} [opts]   {headers, timeoutMs}
 * @returns {Promise<{ok: boolean, error?: object, card?: object, url?: string}>}
 */
async function getAgentCard(baseUrl, opts = {}) {
    const url = normalizeCardUrl(baseUrl);
    const res = await _fetch(url, opts);
    if (!res.ok) return res;
    let card;
    try { card = JSON.parse(res.text); } catch (_e) {
        return _err('decode', 'the agent card was not JSON');
    }
    if (!card || typeof card !== 'object') return _err('decode', 'the agent card was not an object');
    return { ok: true, card, url };
}

/**
 * Where the agent card lives. A2A v1.0 says /.well-known/agent-card.json;
 * v0.2 said /.well-known/agent.json. We try the modern one first.
 */
function normalizeCardUrl(baseUrl) {
    const trimmed = String(baseUrl || '').replace(/\/+$/, '');
    if (/\/agent(-card)?\.json$/.test(trimmed)) return trimmed;
    if (/\/well-known\//.test(trimmed)) return trimmed;
    return `${trimmed}/.well-known/agent-card.json`;
}

async function _fetch(url, opts = {}) {
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || CFG.timeoutMs, 1000), 120000);
    const verdict = await ssrf.checkUrl(url);
    if (!verdict.ok) return _err('ssrf_blocked', `refused to contact ${url}: ${verdict.reason}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method: opts.method || 'GET',
            headers: {
                Accept: 'application/json, text/event-stream',
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
    try {
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader) {
            const chunks = [];
            let total = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > CFG.maxResponseBytes) {
                    try { await reader.cancel(); } catch (_e) { /* ignore */ }
                    return _err('too_large', `response exceeded ${CFG.maxResponseBytes} bytes`);
                }
                chunks.push(Buffer.from(value));
            }
            text = Buffer.concat(chunks).toString('utf8');
        } else {
            text = await res.text();
        }
    } catch (err) {
        return _err('decode', err && err.message ? err.message : 'could not read the response');
    }

    if (!res.ok) {
        return _err('upstream_' + res.status, `remote agent answered ${res.status}`, { status: res.status });
    }
    return { ok: true, text, status: res.status };
}

function _parseJsonRpc(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch (_e) { /* fall through */ }
    }
    if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
        const chunks = trimmed.split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter((l) => l && l !== '[DONE]');
        for (const c of chunks) {
            try { return JSON.parse(c); } catch (_e) { /* next frame */ }
        }
    }
    return null;
}

/**
 * Build an A2A Message from plain text.
 * @param {string} text
 * @param {object} [opts] {role, messageId, mediaType, metadata}
 */
function textMessage(text, opts = {}) {
    const body = String(text === undefined || text === null ? '' : text).slice(0, CFG.maxTextChars);
    return {
        messageId: opts.messageId || 'msg_' + Math.random().toString(36).slice(2, 14),
        role: opts.role || 'ROLE_USER',
        parts: [{ kind: 'text', text: body, mediaType: opts.mediaType || 'text/plain' }],
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };
}

/**
 * Send a message to a remote A2A agent.
 *
 * @param {string} baseUrl   the agent base URL
 * @param {object} message   an A2A Message
 * @param {object} [opts]    {headers, timeoutMs, taskId, contextId, configuration,
 *                            binding: 'jsonrpc'|'rest'|'auto', blocking}
 * @returns {Promise<{ok: boolean, error?: object, task?: object, message?: object}>}
 */
async function sendMessage(baseUrl, message, opts = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!base) return _err('validation', 'an agent URL is required');
    if (!message || !Array.isArray(message.parts)) return _err('validation', 'a message with parts is required');

    const binding = opts.binding || 'auto';
    const params = {
        message,
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.contextId ? { contextId: opts.contextId } : {}),
        ...(opts.configuration ? { configuration: opts.configuration } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };

    if (binding === 'jsonrpc' || binding === 'auto') {
        const res = await _fetch(base, {
            ...opts,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(opts.headers || {}),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId(), method: 'SendMessage', params }),
        });
        if (res.ok) {
            const parsed = _parseJsonRpc(res.text);
            if (parsed && parsed.error) {
                return _err('rpc_error', parsed.error.message || 'SendMessage failed', { rpc_error: parsed.error });
            }
            if (parsed && parsed.result) return _interpretResult(parsed.result);
            if (binding === 'jsonrpc') return _err('decode', 'no JSON-RPC result in the response');
        } else if (binding === 'jsonrpc') {
            return res;
        }
        // auto + a failure → try the REST binding below.
    }

    // REST binding: POST /message:send
    const res = await _fetch(`${base}/message:send`, {
        ...opts,
        method: 'POST',
        headers: {
            'Content-Type': 'application/a2a+json',
            ...(opts.headers || {}),
        },
        body: JSON.stringify(params),
    });
    if (!res.ok) return res;
    let parsed;
    try { parsed = JSON.parse(res.text); } catch (_e) {
        return _err('decode', 'the REST response was not JSON');
    }
    return _interpretResult(parsed);
}

function _interpretResult(result) {
    if (!result) return _err('decode', 'empty result');
    if (result.task) return { ok: true, task: normalizeTask(result.task) };
    if (result.message) return { ok: true, message: result.message };
    // Some servers return the task at the top level.
    if (result.id && result.status) return { ok: true, task: normalizeTask(result) };
    return _err('decode', 'the response contained neither a task nor a message');
}

/**
 * Normalize an A2A Task into the shape we store and serve.
 */
function normalizeTask(task) {
    if (!task) return null;
    const status = task.status || {};
    const state = status.state || task.state || 'TASK_STATE_SUBMITTED';
    return {
        id: task.id || task.taskId || null,
        contextId: task.contextId || task.context_id || null,
        state,
        terminal: TERMINAL_STATES.has(state),
        working: WORKING_STATES.has(state),
        message: status.message || status.update || null,
        artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
        history: Array.isArray(task.history) ? task.history : [],
        metadata: task.metadata || {},
        raw: task,
    };
}

/** Fetch one task by id (JSON-RPC first, REST second). */
async function getTask(baseUrl, taskId, opts = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!base || !taskId) return _err('validation', 'an agent URL and task id are required');

    const binding = opts.binding || 'auto';
    if (binding === 'jsonrpc' || binding === 'auto') {
        const res = await _fetch(base, {
            ...opts,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
            body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId(), method: 'GetTask', params: { id: taskId } }),
        });
        if (res.ok) {
            const parsed = _parseJsonRpc(res.text);
            if (parsed && parsed.error) return _err('rpc_error', parsed.error.message || 'GetTask failed');
            if (parsed && parsed.result) return { ok: true, task: normalizeTask(parsed.result) };
            if (binding === 'jsonrpc') return _err('decode', 'no JSON-RPC result in the response');
        } else if (binding === 'jsonrpc') {
            return res;
        }
    }

    const res = await _fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, opts);
    if (!res.ok) return res;
    let parsed;
    try { parsed = JSON.parse(res.text); } catch (_e) { return _err('decode', 'the REST response was not JSON'); }
    return { ok: true, task: normalizeTask(parsed) };
}

/** Cancel a running task. */
async function cancelTask(baseUrl, taskId, opts = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!base || !taskId) return _err('validation', 'an agent URL and task id are required');

    const binding = opts.binding || 'auto';
    if (binding === 'jsonrpc' || binding === 'auto') {
        const res = await _fetch(base, {
            ...opts,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
            body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId(), method: 'CancelTask', params: { id: taskId } }),
        });
        if (res.ok) {
            const parsed = _parseJsonRpc(res.text);
            if (parsed && parsed.error) return _err('rpc_error', parsed.error.message || 'CancelTask failed');
            if (parsed && parsed.result) return { ok: true, task: normalizeTask(parsed.result) };
            if (binding === 'jsonrpc') return { ok: true, task: null };
        } else if (binding === 'jsonrpc') {
            return res;
        }
    }

    const res = await _fetch(`${base}/tasks/${encodeURIComponent(taskId)}:cancel`, { ...opts, method: 'POST' });
    if (!res.ok) return res;
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch (_e) { /* empty body is fine for a cancel */ }
    return { ok: true, task: parsed ? normalizeTask(parsed) : null };
}

/** List tasks (JSON-RPC `ListTasks`, REST `GET /tasks`). */
async function listTasks(baseUrl, opts = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!base) return _err('validation', 'an agent URL is required');

    const binding = opts.binding || 'auto';
    if (binding === 'jsonrpc' || binding === 'auto') {
        const res = await _fetch(base, {
            ...opts,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
            body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId(), method: 'ListTasks', params: opts.params || {} }),
        });
        if (res.ok) {
            const parsed = _parseJsonRpc(res.text);
            if (parsed && parsed.error) return _err('rpc_error', parsed.error.message || 'ListTasks failed');
            if (parsed && parsed.result) {
                const items = parsed.result.tasks || parsed.result.items || [];
                return { ok: true, tasks: items.map(normalizeTask) };
            }
            if (binding === 'jsonrpc') return _err('decode', 'no JSON-RPC result in the response');
        } else if (binding === 'jsonrpc') {
            return res;
        }
    }

    const res = await _fetch(`${base}/tasks${opts.query ? '?' + opts.query : ''}`, opts);
    if (!res.ok) return res;
    let parsed;
    try { parsed = JSON.parse(res.text); } catch (_e) { return _err('decode', 'the REST response was not JSON'); }
    const items = Array.isArray(parsed) ? parsed : (parsed.tasks || parsed.items || []);
    return { ok: true, tasks: items.map(normalizeTask) };
}

/**
 * Pull the text out of an A2A task or message — the human-readable answer.
 * @returns {string}
 */
function extractText(thing) {
    if (!thing) return '';
    if (typeof thing === 'string') return thing;
    const parts = Array.isArray(thing.parts) ? thing.parts : [];
    const out = [];
    for (const p of parts) {
        if (!p) continue;
        if (typeof p.text === 'string') out.push(p.text);
        else if (p.data !== undefined) { try { out.push(JSON.stringify(p.data)); } catch (_e) { /* skip */ } }
        else if (typeof p.raw === 'string') out.push(p.raw);
    }
    if (out.length) return out.join('\n');
    // An artifact may carry the answer instead of the message.
    if (Array.isArray(thing.artifacts) && thing.artifacts.length) {
        const art = [];
        for (const a of thing.artifacts) {
            const t = extractText(a);
            if (t) art.push(t);
        }
        if (art.length) return art.join('\n');
    }
    if (thing.status && thing.status.message) return extractText(thing.status.message);
    return '';
}

module.exports = {
    CFG,
    TASK_STATES,
    TERMINAL_STATES,
    WORKING_STATES,
    getAgentCard,
    normalizeCardUrl,
    textMessage,
    sendMessage,
    getTask,
    cancelTask,
    listTasks,
    normalizeTask,
    extractText,
    _nowIso,
};
