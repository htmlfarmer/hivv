// api/lib/mcp-client.js — the OUTBOUND half of MCP interoperability.
//
// THE GAP THIS FILLS
// ──────────────────
// HIVV is an MCP SERVER: `POST /mcp` speaks Model Context Protocol to any
// client (OpenCode, Claude Desktop, Cursor…). That is one direction.
//
// Every other AI network on the planet is also publishing MCP servers. HIVV
// can reach them, ask what tools they have, and CALL those tools — routing a
// job to a machine that is not in our hive, over the standard protocol,
// instead of inventing a private wire format.
//
// So: MCP in, MCP out, same protocol both ways.
//
// THE TRANSPORT
// ─────────────
// Streamable HTTP, STATELESS — exactly how our own server behaves:
//   POST <url>  Content-Type: application/json
//   Accept: application/json, text/event-stream
//   body: a JSON-RPC 2.0 message (or a batch)
//
// A stateless server answers with a single `application/json` body. We also
// tolerate `text/event-stream` (some servers stream one SSE frame) because
// being liberal in what we accept is how interop actually works.
//
// THE HANDSHAKE
// ─────────────
//   1. initialize  {protocolVersion, capabilities, clientInfo}
//   2. notifications/initialized   (a NOTIFICATION — no id, no reply)
//   3. tools/list  or  tools/call
//
// Protocol version we advertise: the latest we know, but we degrade to what
// the server answers with. The server's version WINS — that is the point of
// a negotiation.
//
// SAFETY
// ──────
//   * Every outbound URL goes through the SSRF guard (lib/ssrf.js) — a
//     remote MCP server must not become a way to reach 127.0.0.1 or the
//     cloud metadata endpoint.
//   * Hard deadline on every call (default 30s) via AbortController.
//   * The response is size-capped (default 4 MB) — a hostile peer cannot
//     stream us out of memory.
//   * Errors are returned, never thrown at the caller unlabelled: every
//     failure carries a taxonomy class (see lib/telemetry.js).
//
// This module performs NO policy gating by itself — it is a transport. The
// caller (the capability layer) decides whether an outbound MCP call is
// allowed. That separation is deliberate: the gate must be visible in ONE
// place, not smeared across adapters.

'use strict';

const ssrf = require('./ssrf');

// The protocol version we offer. The SERVER's answer wins — we never fail a
// handshake over a version mismatch, we adapt.
const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const CFG = {
    timeoutMs: 30000,
    maxResponseBytes: 4 * 1024 * 1024,
    maxTools: 200,
    maxToolResultChars: 200000,
};

function _err(code, message, extra = {}) {
    return { ok: false, error: { code, message: String(message).slice(0, 500), ...extra } };
}

/**
 * Parse an HTTP response body that may be JSON or a single SSE frame.
 * (Some Streamable HTTP servers answer `text/event-stream` with one frame.)
 */
function _parseBody(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch (_e) { /* fall through to SSE */ }
    }
    if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
        // Collect `data:` lines; the first parseable JSON wins.
        const chunks = trimmed.split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter((l) => l && l !== '[DONE]');
        for (const c of chunks) {
            try { return JSON.parse(c); } catch (_e) { /* try the next frame */ }
        }
    }
    return null;
}

function _rpcId() {
    return 'mcp-' + Math.random().toString(36).slice(2, 12);
}

/**
 * One JSON-RPC round trip to an MCP server.
 * @returns {Promise<object>} the parsed JSON-RPC response object
 */
async function rpc(url, message, opts = {}) {
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || CFG.timeoutMs, 1000), 120000);

    const verdict = await ssrf.checkUrl(url);
    if (!verdict.ok) return _err('ssrf_blocked', `refused to contact ${url}: ${verdict.reason}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'MCP-Protocol-Version': opts.protocolVersion || CLIENT_PROTOCOL_VERSION,
                ...(opts.headers || {}),
            },
            body: JSON.stringify(message),
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
        return _err('upstream_' + res.status, `remote MCP server answered ${res.status}`, { status: res.status });
    }

    const parsed = _parseBody(text);
    if (!parsed) return _err('decode', 'response was not JSON-RPC');
    if (Array.isArray(parsed)) return parsed.find((m) => m && m.id === message.id) || parsed[0];
    return parsed;
}

/**
 * Open a session: initialize + notifications/initialized.
 * @returns {Promise<{ok: boolean, error?: object, server?: object, protocolVersion?: string}>}
 */
async function initialize(url, opts = {}) {
    const initRes = await rpc(url, {
        jsonrpc: '2.0',
        id: _rpcId(),
        method: 'initialize',
        params: {
            protocolVersion: opts.protocolVersion || CLIENT_PROTOCOL_VERSION,
            capabilities: opts.capabilities || { tools: { listChanged: false } },
            clientInfo: opts.clientInfo || { name: 'hivv', version: opts.version || '2.0.0' },
        },
    }, opts);

    // A TRANSPORT failure (SSRF refusal, timeout, bad status) must keep its
    // own class — "handshake_failed" would hide the reason we refused.
    if (initRes && initRes.ok === false) return initRes;
    if (!initRes || initRes.error) {
        const msg = initRes && initRes.error ? initRes.error.message : 'initialize failed';
        return _err('handshake_failed', msg, { rpc_error: initRes && initRes.error });
    }
    const result = initRes.result || {};
    const serverVersion = result.protocolVersion || CLIENT_PROTOCOL_VERSION;

    // The notification has NO id — it is a one-way message. Servers usually
    // answer 202/204 with an empty body, which is not an error.
    try {
        await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, opts);
    } catch (_e) { /* a server that ignores the notification is fine */ }

    return {
        ok: true,
        server: result.serverInfo || null,
        protocolVersion: serverVersion,
        capabilities: result.capabilities || {},
        instructions: result.instructions || null,
    };
}

/**
 * List the tools a remote MCP server publishes.
 * @returns {Promise<{ok: boolean, error?: object, tools?: Array}>}
 */
async function listTools(url, opts = {}) {
    const session = opts.session || await initialize(url, opts);
    if (!session.ok) return session;

    const res = await rpc(url, { jsonrpc: '2.0', id: _rpcId(), method: 'tools/list' }, {
        ...opts,
        protocolVersion: session.protocolVersion,
    });
    if (res && res.ok === false) return res;
    if (!res || res.error) {
        return _err('rpc_error', (res && res.error && res.error.message) || 'tools/list failed', { rpc_error: res && res.error });
    }
    const tools = (res.result && res.result.tools) || [];
    return {
        ok: true,
        tools: tools.slice(0, CFG.maxTools).map((t) => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || t.input_schema || null,
        })),
        protocolVersion: session.protocolVersion,
        server: session.server,
    };
}

/**
 * Call one tool on a remote MCP server.
 *
 * @param {string} url
 * @param {string} tool
 * @param {object} args
 * @param {object} [opts] {headers, timeoutMs, session, principal, transport}
 * @returns {Promise<{ok: boolean, error?: object, result?: object}>}
 */
async function callTool(url, tool, args = {}, opts = {}) {
    if (!tool || typeof tool !== 'string') return _err('validation', 'tool name is required');

    const session = opts.session || await initialize(url, opts);
    if (!session.ok) return session;

    const res = await rpc(url, {
        jsonrpc: '2.0',
        id: _rpcId(),
        method: 'tools/call',
        params: { name: tool, arguments: args || {} },
    }, { ...opts, protocolVersion: session.protocolVersion });

    if (res && res.ok === false) return res;
    if (!res) return _err('decode', 'no response from the remote MCP server');
    if (res.error) {
        return _err('rpc_error', (res.error && res.error.message) || 'tools/call failed', { rpc_error: res.error });
    }

    const result = res.result || {};
    // A tool that reports isError is a TOOL failure, not a transport failure —
    // the call succeeded, the tool said no.
    let serialized = '';
    try { serialized = JSON.stringify(result); } catch (_e) { serialized = ''; }
    if (serialized.length > CFG.maxToolResultChars) {
        result.content = [{ type: 'text', text: `[truncated: ${serialized.length} chars]` }];
    }

    return {
        ok: true,
        result,
        isError: result.isError === true,
        protocolVersion: session.protocolVersion,
        server: session.server,
    };
}

/**
 * Probe an MCP endpoint: does it speak MCP, and what does it publish?
 * @returns {Promise<{ok: boolean, error?: object, tools?: Array, server?: object}>}
 */
async function probe(url, opts = {}) {
    const res = await listTools(url, opts);
    if (!res.ok) return res;
    return {
        ok: true,
        tools: res.tools,
        server: res.server,
        protocolVersion: res.protocolVersion,
    };
}

module.exports = {
    CLIENT_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    CFG,
    initialize,
    listTools,
    callTool,
    probe,
    rpc,
    _parseBody,
};
