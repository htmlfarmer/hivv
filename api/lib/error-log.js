// api/lib/error-log.js — structured, queryable error log.
//
// WHY THIS EXISTS
// ───────────────
// A raw `console.error` tells you something broke. It does not tell you
// *why*, *under what conditions*, or *whether it is getting worse*. For a
// distributed gateway that other people depend on, we need to answer:
//
//   * Is this a one-off or a pattern?
//   * Which endpoint / model / node produces it?
//   * What were the inputs when it happened (size, tokens, context)?
//   * How often, and is the rate going up?
//
// WHAT IT RECORDS
// ───────────────
// Every entry carries: a timestamp, an error class, the endpoint, the model,
// the node, input/output token counts, the context window, the max_tokens
// that were granted, whether the conversation was trimmed, and the raw
// message. Nothing here stores a prompt or a response body — only sizes,
// counts, and identifiers.
//
// The buffer is in-memory and bounded (a ring of the last N entries). It is
// a DIAGNOSTIC, not an audit trail: the durable record lives in Postgres
// (request provenance). Restarting the gateway clears it, which is fine —
// the point is real-time pattern spotting, not forensic reconstruction.

const crypto = require('crypto');

// The ring buffer. Bounded so a long-running gateway cannot grow without
// limit. 2000 entries is ~1-2 MB and covers several hours of normal traffic.
const MAX_ENTRIES = 2000;

const entries = [];

// Rolling counters for quick "is this getting worse?" answers.
const counters = new Map();   // error_class -> count
const endpointCounts = new Map();  // `${endpoint}::${class}` -> count

// Error classes we care about. A new class can be added anywhere; the
// classifier just falls back to 'unknown'.
const ERROR_CLASSES = {
    CONTEXT_OVERFLOW: 'context_overflow',
    TRUNCATED_RESPONSE: 'truncated_response',
    TIMEOUT: 'timeout',
    UPSTREAM_ERROR: 'upstream_error',
    CONNECTION_REFUSED: 'connection_refused',
    RATE_LIMITED: 'rate_limited',
    POLICY_DENIED: 'policy_denied',
    BODY_TOO_LARGE: 'body_too_large',
    UNPARSEABLE: 'unparseable',
    DB_UNAVAILABLE: 'db_unavailable',
    UNKNOWN: 'unknown',
};

// ── client attribution ─────────────────────────────────────────────────────
// When OpenCode fails, we need to KNOW it was OpenCode — not curl, not a
// script, not Continue. The User-Agent is the only reliable signal, and it
// varies by client version, so we match on substrings.
const CLIENT_PATTERNS = [
    [/opencode/i, 'opencode'],
    [/continue/i, 'continue'],
    [/cline|roo/i, 'cline'],
    [/cursor/i, 'cursor'],
    [/windsurf/i, 'windsurf'],
    [/visual studio code|vscode|code-server/i, 'vscode'],
    [/zed/i, 'zed'],
    [/aider/i, 'aider'],
    [/crush/i, 'crush'],
    [/librechat/i, 'librechat'],
    [/open-webui/i, 'open-webui'],
    [/lobechat/i, 'lobechat'],
    [/jan/i, 'jan'],
    [/gpt4all/i, 'gpt4all'],
    [/anythingllm/i, 'anythingllm'],
    [/claude desktop|claude-code/i, 'claude'],
    [/hivv/i, 'hivv-cli'],
    [/python|urllib|requests|httpx/i, 'python'],
    [/node|axios|got|undici/i, 'node'],
    [/curl/i, 'curl'],
    [/wget/i, 'wget'],
    [/postman/i, 'postman'],
    [/insomnia/i, 'insomnia'],
];

function classifyClient(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return 'unknown';
    for (const [re, name] of CLIENT_PATTERNS) {
        if (re.test(ua)) return name;
    }
    // A short, non-empty UA that matches nothing is still useful.
    return ua.length <= 60 ? ua.toLowerCase().replace(/[^a-z0-9._-]/g, '') : 'other';
}

function classify(err, context = {}) {
    const msg = String(err?.message || err || '').toLowerCase();
    const status = context.status;

    if (context.trimmed || msg.includes('truncat') || msg.includes('output token limit')) {
        return ERROR_CLASSES.TRUNCATED_RESPONSE;
    }
    if (context.input_tokens && context.context_window
        && context.input_tokens >= context.context_window) {
        return ERROR_CLASSES.CONTEXT_OVERFLOW;
    }
    if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('etimedout')) {
        return ERROR_CLASSES.TIMEOUT;
    }
    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
        return ERROR_CLASSES.CONNECTION_REFUSED;
    }
    if (status === 429 || msg.includes('rate limit')) {
        return ERROR_CLASSES.RATE_LIMITED;
    }
    if (status === 403 || msg.includes('policy') || msg.includes('denied')) {
        return ERROR_CLASSES.POLICY_DENIED;
    }
    if (msg.includes('entity too large') || msg.includes('payload too large')
        || status === 413) {
        return ERROR_CLASSES.BODY_TOO_LARGE;
    }
    if (msg.includes('json') || msg.includes('parse') || msg.includes('unparseable')) {
        return ERROR_CLASSES.UNPARSEABLE;
    }
    if (msg.includes('remaining connection') || msg.includes('database')
        || msg.includes('pool')) {
        return ERROR_CLASSES.DB_UNAVAILABLE;
    }
    if (status >= 500 || msg.includes('fetch failed') || msg.includes('upstream')) {
        return ERROR_CLASSES.UPSTREAM_ERROR;
    }
    return ERROR_CLASSES.UNKNOWN;
}

/**
 * Record an error.
 *
 * @param {object} input
 * @param {Error|string} input.error       the error (or a message)
 * @param {string}  input.endpoint         which route broke
 * @param {string}  [input.model]          the model involved
 * @param {string}  [input.node]           the node/provider involved
 * @param {number}  [input.input_tokens]   estimated input tokens
 * @param {number}  [input.output_tokens]  actual output tokens
 * @param {number}  [input.context_window] the context window in play
 * @param {number}  [input.max_tokens]     the max_tokens that were granted
 * @param {boolean} [input.trimmed]        whether the conversation was trimmed
 * @param {number}  [input.dropped]        how many messages were dropped
 * @param {number}  [input.status]         HTTP status, if any
 * @param {object}  [input.extra]          any other bounded fields
 * @returns {object} the stored entry
 */
function record(input = {}) {
    const err = input.error;
    const message = String(
        (err && (err.message || err)) || input.message || 'unknown error'
    ).slice(0, 500);
    const cls = input.error_class || classify(err, input);

    const entry = {
        id: crypto.randomBytes(8).toString('hex'),
        ts: Date.now(),
        iso: new Date().toISOString(),
        class: cls,
        client: classifyClient(input.user_agent),
        endpoint: String(input.endpoint || 'unknown').slice(0, 120),
        model: input.model ? String(input.model).slice(0, 160) : null,
        node: input.node ? String(input.node).slice(0, 120) : null,
        status: Number.isFinite(input.status) ? input.status : null,
        input_tokens: Number.isFinite(input.input_tokens) ? input.input_tokens : null,
        output_tokens: Number.isFinite(input.output_tokens) ? input.output_tokens : null,
        context_window: Number.isFinite(input.context_window) ? input.context_window : null,
        max_tokens: Number.isFinite(input.max_tokens) ? input.max_tokens : null,
        trimmed: input.trimmed === true,
        dropped_messages: Number.isFinite(input.dropped) ? input.dropped : null,
        message,
        ...(input.extra && typeof input.extra === 'object' ? { extra: input.extra } : {}),
    };

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

    counters.set(cls, (counters.get(cls) || 0) + 1);
    const key = `${entry.endpoint}::${cls}`;
    endpointCounts.set(key, (endpointCounts.get(key) || 0) + 1);

    // Also emit a compact one-liner so the raw log stays greppable.
    const bits = [
        entry.class,
        entry.client,
        entry.endpoint,
        entry.model && `model=${entry.model}`,
        entry.node && `node=${entry.node}`,
        entry.input_tokens != null && `in=${entry.input_tokens}`,
        entry.max_tokens != null && `max=${entry.max_tokens}`,
        entry.trimmed && `trimmed=${entry.dropped_messages}`,
    ].filter(Boolean).join(' ');
    console.error(`[ERRLOG] ${entry.iso} ${bits} — ${message}`);

    return entry;
}

// Fire-and-forget wrapper for hot paths.
function recordAsync(input) {
    try { record(input); } catch (_e) { /* logging must never break a request */ }
}

function recent({ limit = 100, cls = null, endpoint = null, client = null, sinceMs = null } = {}) {
    let rows = entries;
    if (cls) rows = rows.filter((e) => e.class === cls);
    if (endpoint) rows = rows.filter((e) => e.endpoint === endpoint);
    if (client) rows = rows.filter((e) => e.client === client);
    if (sinceMs) rows = rows.filter((e) => e.ts >= sinceMs);
    return rows.slice(-Math.min(Math.max(parseInt(limit, 10) || 100, 1), MAX_ENTRIES));
}

function summary({ windowMs = 3600_000 } = {}) {
    const cutoff = Date.now() - windowMs;
    const recentEntries = entries.filter((e) => e.ts >= cutoff);
    const byClass = {};
    const byEndpoint = {};
    for (const e of recentEntries) {
        byClass[e.class] = (byClass[e.class] || 0) + 1;
        const k = `${e.endpoint} · ${e.class}`;
        byEndpoint[k] = (byEndpoint[k] || 0) + 1;
    }
    return {
        window_ms: windowMs,
        total: recentEntries.length,
        by_class: byClass,
        by_endpoint: Object.fromEntries(
            Object.entries(byEndpoint).sort((a, b) => b[1] - a[1]).slice(0, 30)),
        buffer_size: entries.length,
        buffer_max: MAX_ENTRIES,
        lifetime_by_class: Object.fromEntries(counters),
    };
}

// A human-readable diagnosis for the most common failure modes, so an
// operator reading the log gets advice instead of just a stack trace.
function diagnose(entry) {
    switch (entry.class) {
        case ERROR_CLASSES.TRUNCATED_RESPONSE:
            return 'the model hit its output token limit — the response was cut off. '
                + 'Raise max_tokens, start a new conversation, or use a model with a '
                + 'larger context window.';
        case ERROR_CLASSES.CONTEXT_OVERFLOW:
            return 'the prompt exceeded the model context window. '
                + 'Start a new conversation, reduce attached files, or use a model '
                + 'with a larger context window.';
        case ERROR_CLASSES.CONNECTION_REFUSED:
            return 'the model endpoint is not reachable. '
                + 'Check that the local model server is running, or switch to the hive.';
        case ERROR_CLASSES.TIMEOUT:
            return 'the model did not answer in time. '
                + 'The request may be too large for this hardware — try a smaller model '
                + 'or a shorter prompt.';
        case ERROR_CLASSES.RATE_LIMITED:
            return 'rate limited. Wait a moment and retry, or add a provider key to '
                + 'raise your limit.';
        case ERROR_CLASSES.BODY_TOO_LARGE:
            return 'the request body exceeded the size limit. '
                + 'Reduce the number of attached files or messages.';
        case ERROR_CLASSES.DB_UNAVAILABLE:
            return 'the database is unavailable. '
                + 'The gateway is degraded — chat still works, but accounts and '
                + 'history will not persist.';
        case ERROR_CLASSES.POLICY_DENIED:
            return 'the policy gate denied this action. '
                + 'Run `hivv policy explain <capability>` to see why, and '
                + '`hivv approve <grant_id>` if it was a MAYBE.';
        default:
            return null;
    }
}

function clear() {
    entries.length = 0;
    counters.clear();
    endpointCounts.clear();
}

module.exports = {
    ERROR_CLASSES,
    classifyClient,
    record,
    recordAsync,
    recent,
    summary,
    diagnose,
    clear,
    // exposed for tests
    _entries: entries,
    _counters: counters,
};
