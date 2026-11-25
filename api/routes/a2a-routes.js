// api/routes/a2a-routes.js — HIVV AS AN A2A SERVER (v1.0).
//
// WHAT THIS IS
// ────────────
// MCP says "here are my tools". A2A says "here is my agent — give it a
// task". They are complements, not rivals:
//
//   MCP  — a MODEL calls our tools          (we already serve /mcp)
//   A2A  — an AGENT gives US a task          (this file)
//
// So the hive now answers both directions of both protocols:
//
//   inbound   POST /mcp                     (MCP server  — already shipped)
//   inbound   POST /api/a2a                 (A2A server  — this file)
//   outbound  api/lib/mcp-client.js         (MCP client  — call other MCP servers)
//   outbound  api/lib/a2a-client.js         (A2A client  — give other agents tasks)
//   outbound  api/lib/hive-clients.js       (the adapter layer that unifies them)
//
// THE AGENT CARD
// ─────────────
// Published at /.well-known/agent-card.json (the v1.0 well-known path; the
// v0.2 path /.well-known/agent.json is served too, because a card is a card
// and being liberal in what we accept is how interop works).
//
// The card is STATIC on disk (public_html/.well-known/agent-card.json) so
// Caddy can serve it without touching the gateway, and DYNAMIC at
// /api/a2a/agent-card so the live skill list can be included.
//
// THE TASK MODEL
// ─────────────
// A2A tasks and our own task-queue tasks are the same animal, so A2A tasks
// ARE task-queue tasks:
//
//   TASK_STATE_SUBMITTED    → queued
//   TASK_STATE_WORKING      → running
//   TASK_STATE_INPUT_REQUIRED → running (interrupted: we need more from you)
//   TASK_STATE_AUTH_REQUIRED → running (interrupted: a human must approve)
//   TASK_STATE_COMPLETED    → done
//   TASK_STATE_FAILED       → failed
//   TASK_STATE_CANCELED     → canceled
//   TASK_STATE_REJECTED     → rejected
//
// The interrupted states matter: the MAYBE verdict of our policy gate means
// "a human must decide". That maps to TASK_STATE_AUTH_REQUIRED, and the
// client is told exactly what to do (`hivv approve <grant>`). We do NOT
// pretend the work failed.
//
// THE POLICY GATE IS NOT BYPASSED
// ────────────────────────────────
// A2A is a transport, not an amnesty. Every message goes through the same
// gate as /api/chat. A denied action is TASK_STATE_REJECTED with the reason.
// An approval-needed action is TASK_STATE_AUTH_REQUIRED. The gate is
// visible in ONE place (lib/policy.js) and this file asks it, not guesses.
//
// BOTH BINDINGS
// ─────────────
//   JSON-RPC 2.0 : POST /api/a2a                     {method, params}
//   REST/JSON   : POST /api/a2a/message:send
//                  GET  /api/a2a/tasks/:id
//                  GET  /api/a2a/tasks
//                  POST /api/a2a/tasks/:id/cancel
//
// The JSON-RPC binding is canonical; REST is the fallback for clients that
// only speak that shape.

'use strict';

const express = require('express');
const crypto = require('crypto');

const taskQueue = require('../lib/task-queue');
const telemetry = require('../lib/telemetry');
const policy = require('../lib/policy');
const caps = require('../lib/capabilities');

const router = express.Router();

// The A2A REST binding uses the A2A content type (application/a2a+json).
// Express's json() parser only accepts application/json by default, so the
// type list is widened — a client that follows the spec EXACTLY must not get
// an empty body and a confusing "message.parts must carry text".
const A2A_JSON = express.json({
    limit: '1mb',
    type: ['application/json', 'application/a2a+json', 'application/*+json'],
});

// ── injected by server.js (same pattern as mcp-routes.js) ───────────────────
let aiRouter = null;
let orchestrator = null;
let hostBase = process.env.HIVV_PUBLIC_URL || 'https://hivv.org';

router.inject = (orch, rt, baseUrl) => {
    orchestrator = orchestrator || orch;
    aiRouter = aiRouter || rt;
    if (baseUrl) hostBase = baseUrl;
};

const PROTOCOL_VERSION = '1.0.0';

// The identity nudge the chat path uses — the same one, so a bee that
// answers an A2A message says "HIVE" exactly like it says "HIVE" on /api/chat.
const HIVV_IDENTITY_MSG = {
    role: 'system',
    content: 'IMPORTANT: When referring to the hivv.org distributed AI network, always write "HIVE" (pronounced /haɪv/, like a beehive) — never spell it as "HIV" or "H-I-V". The project name is HIVV and it rhymes with "hive".',
};

// ── the agent card ──────────────────────────────────────────────────────────

const SKILLS = [
    {
        id: 'hive-chat',
        name: 'Ask the hive',
        description: 'Send a question to the distributed AI network. The hive routes it to whichever bee can answer best — a local model on a volunteer machine, a peer hive, or a cloud model.',
        tags: ['chat', 'reasoning', 'distributed'],
        examples: ['Summarise the tradeoffs of leases versus locks in a job queue.', 'What is the capital of Bhutan?'],
    },
    {
        id: 'hive-tools',
        name: 'Use the hive toolkit',
        description: 'The twelve tools every bee carries: web search, calculator, clock, timezones, text parsing, translation, memory, file read, and more — all behind the same policy gate.',
        tags: ['tools', 'search', 'compute'],
        examples: ['What time is it in Karachi right now?', 'Convert 3.5 GB to MiB.'],
    },
    {
        id: 'hive-code',
        name: 'Coder bees',
        description: 'Hand a repository and a task to a coder bee: it clones to a scratch worktree, runs OpenCode headless, and returns a patch with a summary.',
        tags: ['code', 'patch', 'review'],
        examples: ['Add a --json flag to the parser and return the patch.'],
    },
    {
        id: 'hive-network',
        name: 'Inspect the network',
        description: 'The live roster: which bees are online, what they can do, how fast they are, and how busy the hive is right now.',
        tags: ['network', 'status', 'telemetry'],
        examples: ['How busy is the hive?', 'Which bee is the fastest right now?'],
    },
];

function agentCard() {
    const skills = SKILLS.map((s) => ({
        ...s,
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
    }));
    return {
        protocolVersion: PROTOCOL_VERSION,
        name: 'HIVV — The People\'s Distributed AI Network',
        description: 'A distributed AI network: a hive of volunteer machines and peer hives that answers questions, runs tools, and writes code. Policy-gated by humans (YES / MAYBE / NO).',
        version: '2.0.0',
        url: hostBase,
        preferredTransport: 'JSONRPC',
        additionalInterfaces: [
            { url: `${hostBase}/api/a2a`, transport: 'JSONRPC' },
            { url: `${hostBase}/api/a2a/message:send`, transport: 'HTTP+JSON' },
        ],
        capabilities: {
            streaming: true,
            pushNotifications: false,
            stateTransitionHistory: true,
            extensions: [
                { uri: 'https://hivv.org/extensions/telemetry/v1', description: 'Deeper telemetry — spans, histograms, SLOs and a Prometheus exposition.', params: { endpoint: '/api/telemetry' } },
                { uri: 'https://hivv.org/extensions/open-hives/v1', description: 'Hive-to-hive task submission (open-hives/0.1).', params: { endpoint: '/api/bridge/requests' } },
            ],
        },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills,
        securitySchemes: {
            apiKey: {
                type: 'apiKey',
                in: 'header',
                name: 'Authorization',
                description: 'Bearer <hivv api key>. Absent → anonymous visitor tier (still rate-limited and still policy-gated).',
            },
        },
        security: [{ apiKey: [] }],
        supportsAuthenticatedExtendedCard: false,
        // The house signature: the name of a hive is its own domain.
        'x-hivv': {
            hive: 'hivv.org',
            protocol: 'open-hives/0.1',
            mcp: `${hostBase}/mcp`,
            telemetry: `${hostBase}/api/telemetry/overview`,
        },
    };
}

router.get('/agent-card', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(agentCard());
});

// ── state mapping ───────────────────────────────────────────────────────────

const STATE_TO_TASK = {
    TASK_STATE_SUBMITTED: 'queued',
    TASK_STATE_WORKING: 'running',
    TASK_STATE_INPUT_REQUIRED: 'running',
    TASK_STATE_AUTH_REQUIRED: 'running',
    TASK_STATE_COMPLETED: 'done',
    TASK_STATE_FAILED: 'failed',
    TASK_STATE_CANCELED: 'canceled',
    TASK_STATE_REJECTED: 'rejected',
};

const TASK_TO_STATE = {
    queued: 'TASK_STATE_SUBMITTED',
    running: 'TASK_STATE_WORKING',
    done: 'TASK_STATE_COMPLETED',
    failed: 'TASK_STATE_FAILED',
    expired: 'TASK_STATE_FAILED',
    canceled: 'TASK_STATE_CANCELED',
    rejected: 'TASK_STATE_REJECTED',
};

function a2aState(task) {
    if (!task) return 'TASK_STATE_FAILED';
    // An interrupted task is ALIVE and waiting — it is not a failure.
    if (task.interrupted) {
        return task.interrupted.kind === 'auth' ? 'TASK_STATE_AUTH_REQUIRED' : 'TASK_STATE_INPUT_REQUIRED';
    }
    return TASK_TO_STATE[task.state] || 'TASK_STATE_SUBMITTED';
}

/**
 * Render a task-queue task as an A2A Task.
 */
function toA2ATask(task, { includeHistory = false } = {}) {
    if (!task) return null;
    const state = a2aState(task);
    const artifacts = [];
    const text = _resultText(task);
    if (text) {
        artifacts.push({
            artifactId: `${task.id}-out`,
            name: 'answer',
            parts: [{ kind: 'text', text, mediaType: 'text/plain' }],
        });
    }

    const out = {
        id: task.id,
        contextId: task.context_id || task.id,
        status: {
            state,
            message: task.interrupted
                ? {
                    messageId: `${task.id}-status`,
                    role: 'ROLE_AGENT',
                    parts: [{ kind: 'text', text: task.interrupted.reason || 'waiting for you', mediaType: 'text/plain' }],
                }
                : task.error
                    ? {
                        messageId: `${task.id}-status`,
                        role: 'ROLE_AGENT',
                        parts: [{ kind: 'text', text: `${task.error.class}: ${task.error.message}`, mediaType: 'text/plain' }],
                    }
                    : undefined,
        },
        artifacts,
        metadata: {
            kind: task.kind,
            origin: task.origin,
            state: task.state,
            attempts: task.attempts,
            usage: task.usage,
            trace_id: task.trace_id,
            created_at_ms: task.created_at_ms,
            completed_at_ms: task.completed_at_ms,
        },
    };
    if (includeHistory && task.metadata && Array.isArray(task.metadata.history)) {
        out.history = task.metadata.history;
    }
    return out;
}

function _resultText(task) {
    if (!task) return '';
    const r = task.result;
    if (typeof r === 'string') return r;
    if (r && typeof r.text === 'string') return r.text;
    if (r && r.content && typeof r.content === 'string') return r.content;
    if (r && r.answer && typeof r.answer === 'string') return r.answer;
    return '';
}

// ── message → task ──────────────────────────────────────────────────────────

function messageText(message) {
    if (!message) return '';
    if (typeof message === 'string') return message;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const out = [];
    for (const p of parts) {
        if (!p) continue;
        if (typeof p.text === 'string') out.push(p.text);
        else if (p.data !== undefined) { try { out.push(JSON.stringify(p.data)); } catch (_e) { /* skip */ } }
    }
    return out.join('\n').trim();
}

/**
 * Execute a task's work.
 *
 * For now the HIVV agent does ONE thing well: it asks the hive. A task whose
 * payload names a tool (`kind: 'tool'`) goes through the toolkit; anything
 * else is a chat message that the router answers.
 */
async function executeTask(task) {
    const payload = task.payload || {};
    const text = payload.text || payload.prompt || payload.message || '';

    if (task.kind === 'tool' && payload.tool) {
        try {
            const toolkit = require('../lib/toolkit');
            const result = await toolkit.execute(payload.tool, payload.arguments || {}, {
                principal: task.principal || 'anonymous',
                transport: 'a2a',
                via: 'a2a',
                reason: `a2a task ${task.id}`,
                node: null,
            });
            if (result.policy && result.policy.verdict === 'deny') {
                return { ok: false, rejected: true, reason: `policy refused '${result.policy.capability}' — ${result.policy.rule}` };
            }
            if (result.policy && result.policy.verdict === 'ask') {
                return {
                    ok: false,
                    interrupted: 'auth',
                    reason: `MAYBE — a human must approve this first. Ask the operator to run: hivv approve ${result.policy.grant_id} — then send the message again.`,
                };
            }
            if (!result.ok) return { ok: false, reason: String(result.error || 'the tool failed') };
            return { ok: true, result: { text: _stringify(result.data), tool: result.tool, via: result.via } };
        } catch (err) {
            return { ok: false, reason: err && err.message ? err.message : 'the tool threw' };
        }
    }

    if (!aiRouter) return { ok: false, reason: 'the hub is still starting — retry in a moment' };
    if (!text) return { ok: false, reason: 'the message carried no text' };

    try {
        const data = await aiRouter.chatCompletion([HIVV_IDENTITY_MSG, { role: 'user', content: text }], {
            stream: false,
            principal: task.principal || undefined,
            capability: 'reasoning',
            via: 'a2a',
            reason: `a2a task ${task.id}`,
            timeout: 120000,
        });
        if (data && data.denied) {
            return { ok: false, rejected: true, reason: `policy denied: ${data.error || 'denied by policy'}` };
        }
        if (data && data.asked) {
            const gid = (data.policy && data.policy.grant_id) || '<grant_id>';
            return {
                ok: false,
                interrupted: 'auth',
                reason: `MAYBE — a human must approve this first. Ask the operator to run: hivv approve ${gid} — then send the message again.`,
            };
        }
        if (!data || !data.ok) {
            return { ok: false, reason: (data && data.error) || 'no AI target was available — retry shortly' };
        }
        const answer = data.data && data.data.choices && data.data.choices[0] && data.data.choices[0].message
            ? data.data.choices[0].message.content
            : '';
        return {
            ok: true,
            result: {
                text: typeof answer === 'string' ? answer : '(empty answer)',
                answered_by: data.answeredBy || null,
                model: data.servedModel || null,
                provider: data.provider || null,
            },
        };
    } catch (err) {
        return { ok: false, reason: err && err.message ? err.message : 'the router threw' };
    }
}

function _stringify(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_e) { return String(value); }
}

/**
 * Run a task to completion (synchronously) — the default A2A behaviour is to
 * wait until the task reaches a terminal or interrupted state.
 */
async function runTask(taskId) {
    // Claim THIS task, not "the next a2a task" — claiming the next one and
    // releasing it is a race with every other runner.
    const claimed = taskQueue.claimId(taskId, { worker: 'a2a-runner' });
    if (!claimed) return taskQueue.get(taskId);
    const outcome = await executeTask(claimed);
    if (outcome.ok) {
        taskQueue.complete(taskId, { worker: 'a2a-runner', result: outcome.result });
    } else if (outcome.rejected) {
        taskQueue.reject(taskId, outcome.reason || 'rejected');
    } else if (outcome.interrupted) {
        // The task is INTERRUPTED, not failed. It stays alive and waits for
        // the caller (or a human) to supply what is missing.
        taskQueue.interrupt(taskId, {
            kind: outcome.interrupted,
            reason: outcome.reason || 'interrupted',
        });
    } else {
        taskQueue.fail(taskId, { worker: 'a2a-runner', error: outcome.reason || 'failed', retryable: false });
    }
    return taskQueue.get(taskId);
}

// ── JSON-RPC binding ────────────────────────────────────────────────────────

function _rpcError(id, code, message, data) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, ...(data ? { data } : {}) } };
}

function _rpcOk(id, result) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

async function rpcDispatch(method, params, ctx) {
    switch (method) {
    case 'SendMessage': {
        const message = params && params.message;
        const text = messageText(message);
        if (!text) return { error: { code: -32602, message: 'message.parts must carry text' } };

        const externalId = params.taskId || `a2a_${crypto.randomBytes(8).toString('hex')}`;
        const submitted = taskQueue.submit({
            id: externalId,
            kind: (params.metadata && params.metadata.kind) || 'a2a',
            payload: { text, message },
            principal: ctx.principal,
            origin: 'a2a',
            context_id: params.contextId || null,
            trace_id: ctx.traceId || null,
            metadata: { a2a: true, history: [message] },
            ttl_s: 900,
        });

        // The default A2A behaviour: wait for a terminal or interrupted state.
        if (params.configuration && params.configuration.returnImmediately) {
            return { result: { task: toA2ATask(submitted.task) } };
        }
        const finished = await runTask(externalId);
        return { result: { task: toA2ATask(finished) } };
    }

    case 'GetTask': {
        const id = params && params.id;
        if (!id) return { error: { code: -32602, message: 'id is required' } };
        const task = taskQueue.get(id);
        if (!task) return { error: { code: -404, message: 'task not found' } };
        return { result: toA2ATask(task, { includeHistory: true }) };
    }

    case 'ListTasks': {
        const tasks = taskQueue.list({ kind: 'a2a', limit: 50 });
        return { result: { tasks: tasks.map((t) => toA2ATask(t)) } };
    }

    case 'CancelTask': {
        const id = params && params.id;
        if (!id) return { error: { code: -32602, message: 'id is required' } };
        const res = taskQueue.cancel(id, { reason: 'canceled by the client' });
        if (!res.ok) return { error: { code: res.error === 'not_found' ? -404 : -32602, message: res.error } };
        return { result: toA2ATask(res.task) };
    }

    case 'GetAgentCard': {
        return { result: agentCard() };
    }

    default:
        return { error: { code: -32601, message: `unknown method '${method}'` } };
    }
}

router.post('/', A2A_JSON, async (req, res) => {
    const body = req.body || {};
    const ctx = {
        principal: req.principal || 'anonymous',
        traceId: telemetry.parseTraceparent(req.headers.traceparent)?.trace_id || null,
    };
    const messages = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of messages) {
        if (!m || typeof m.method !== 'string') {
            out.push(_rpcError(m && m.id, -32600, 'invalid request'));
            continue;
        }
        telemetry.counter('a2a_calls_total', { mcp_method: 'rpc', status: 'ok' });
        const started = Date.now();
        try {
            const r = await rpcDispatch(m.method, m.params || {}, ctx);
            if (r.error) {
                telemetry.counter('a2a_calls_total', { mcp_method: 'rpc', status: 'error' });
                telemetry.countError(r.error.message, { status: r.error.code === -32602 ? 400 : 500 });
                out.push(_rpcError(m.id, r.error.code, r.error.message));
            } else {
                out.push(_rpcOk(m.id, r.result));
            }
        } catch (err) {
            telemetry.counter('a2a_calls_total', { mcp_method: 'rpc', status: 'error' });
            telemetry.countError(err);
            out.push(_rpcError(m.id, -32603, err && err.message ? err.message : 'internal error'));
        }
        telemetry.histogram('a2a_duration_ms', { mcp_method: 'rpc' }, Date.now() - started);
    }
    res.json(Array.isArray(body) ? out : out[0]);
});

// ── REST binding ────────────────────────────────────────────────────────────

router.post('/message:send', A2A_JSON, async (req, res) => {
    const ctx = { principal: req.principal || 'anonymous' };
    const r = await rpcDispatch('SendMessage', req.body || {}, ctx);
    if (r.error) return res.status(r.error.code === -32602 ? 400 : 500).json({ error: r.error });
    res.json(r.result);
});

router.get('/tasks', (req, res) => {
    const tasks = taskQueue.list({ kind: 'a2a', limit: Math.min(parseInt(req.query.limit, 10) || 50, 200) });
    res.json({ tasks: tasks.map((t) => toA2ATask(t)) });
});

router.get('/tasks/:id', (req, res) => {
    const task = taskQueue.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(toA2ATask(task, { includeHistory: true }));
});

router.post('/tasks/:id/cancel', (req, res) => {
    const r = taskQueue.cancel(req.params.id, { reason: 'canceled by the client' });
    if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 409).json({ error: r.error });
    res.json(toA2ATask(r.task));
});

// ── telemetry for the A2A surface ───────────────────────────────────────────

router.get('/stats', (req, res) => {
    res.json({
        protocol_version: PROTOCOL_VERSION,
        card: `${hostBase}/.well-known/agent-card.json`,
        skills: SKILLS.length,
        queue: taskQueue.stats(),
        states: STATE_TO_TASK,
    });
});

// Keep the capability module referenced so the registry is loaded with the
// A2A surface (a2a work is 'reasoning' by default, 'coding' for code tasks).
void caps; void policy;

module.exports = router;
module.exports.agentCard = agentCard;
module.exports.toA2ATask = toA2ATask;
module.exports.a2aState = a2aState;
