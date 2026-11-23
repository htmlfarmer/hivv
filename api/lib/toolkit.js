// api/lib/toolkit.js — THE CATALOG. Twelve tools, one source of truth.
//
// WHY THIS FILE EXISTS
// ────────────────────
// HIVV had tools in three places that did not agree:
//   · api/server.js execToolCall — 6 tools, inline in a 188 KB file
//   · public_html/hivv-tools.py — the same 6 tools, a SECOND implementation
//   · api/routes/mcp-routes.js  — 6 different tools, and only 2 overlapped
//
// Six of the twelve tools the hive needs did not exist at all.
//
// This module is the catalog: for every tool it declares the canonical name,
// its aliases, the capability key the policy gate evaluates, a JSON schema,
// where it can run, and the handler that does the work. Every surface —
// MCP, the chat tool loop, POST /api/tools/:tool/invoke, the CLI — reads
// from here, so they can never drift apart again.
//
// THE TWELVE
// ──────────
//   1  web_search        search the internet        (web.search)
//   2  current_time      today's date and time      (local.computation)
//   3  calculator        exact math                 (local.computation)
//   4  web_fetch         read a page                (web.fetch)
//   5  http_request      call an API                (web.fetch)
//   6  code_interpreter  run code in a jail         (coding.execute)
//   7  file_read         read a document             (data.file.read)
//   8  file_search       search documents            (data.file.read)
//   9  memory            remember across chats       (data.memory)
//   10 text_parser       structure some text        (local.computation)
//   11 timezone_convert  time across the world      (local.computation)
//   12 translate         language A → B             (translation)
//
// POSTURE
// ───────
// Everything passes the policy gate (api/lib/policy.js) before it runs. The
// `ask` capabilities (web.search, web.fetch, coding.execute, data.file.read)
// mint a pending grant that a human approves — `hivv approve G_xxx` — and a
// standing grant then makes it frictionless.
//
// WEB SEARCH is built and tested but NOT granted by default: its capability
// is `ask`, its schema is not auto-advertised, and HIVV_ENABLE_WEB_SEARCH=1
// is what turns the advertisement on (and lets an admin run it un-gated).

const ssrf = require('./ssrf');
const mathLib = require('./math');
const fileStore = require('./file-store');
const fileExtract = require('./file-extract');
const memoryLib = require('./memory');
const textParse = require('./textparse');
const sandbox = require('./sandbox');

// ── limits (callers may lower these, never raise them) ─────────────────────
const LIMITS = {
    fetchTimeoutMs: 15000,
    fetchMaxBytes: 2 * 1024 * 1024,       // 2 MB of raw response
    textMaxChars: 20000,                 // what we hand back to a model
    httpTimeoutMs: 20000,
    searchTimeoutMs: 8000,
    searchLimit: 10,
    translateMaxChars: 8000,
};

let routerRef = null;
/** Injected by server.js — the router the `translate` tool uses. */
function inject(router) { routerRef = router || null; }

// ── helpers ─────────────────────────────────────────────────────────────────

function isWebSearchEnabled() {
    const v = String(process.env.HIVV_ENABLE_WEB_SEARCH || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** True when the caller is an operator (loopback or control token). */
function ctxIsAdmin(ctx) {
    if (!ctx) return false;
    if (ctx.isAdmin === true) return true;
    const ip = String(ctx.ip || '');
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Fetch a URL with SSRF protection that survives redirects.
 *
 * A redirect is a fresh URL: a public host can 302 to 127.0.0.1. So every
 * hop is re-checked, and the hop count is capped.
 */
async function safeFetch(url, { timeoutMs = LIMITS.fetchTimeoutMs, headers = {}, method = 'GET', body = null, maxBytes = LIMITS.fetchMaxBytes } = {}) {
    let current = String(url);
    const seen = [];
    for (let hop = 0; hop < 4; hop++) {
        const verdict = await ssrf.checkUrl(current);
        if (!verdict.ok) {
            return { ok: false, error: `refused to fetch ${current}: ${verdict.reason}`, refused: true, url: current };
        }
        seen.push(current);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(current, {
                method,
                headers: { 'User-Agent': 'hivv-toolkit/1.0 (+https://hivv.org)', ...headers },
                body: body === null || body === undefined ? undefined : body,
                redirect: 'manual',
                signal: ctrl.signal,
            });
        } catch (e) {
            clearTimeout(timer);
            const msg = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message;
            return { ok: false, error: `fetch failed: ${msg}`, url: current };
        }
        // A redirect we do not follow is a dead end, but 3xx with no Location
        // is not either — read the body like any other response.
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            clearTimeout(timer);
            const next = new URL(res.headers.get('location'), current).toString();
            try { await res.body?.cancel?.(); } catch (_e) { void _e; }
            current = next;
            continue;
        }
        let buf;
        try {
            const reader = res.body && res.body.getReader ? res.body.getReader() : null;
            if (reader) {
                const chunks = [];
                let total = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.length;
                    chunks.push(value);
                    if (total >= maxBytes) { try { await reader.cancel(); } catch (_e) { void _e; } break; }
                }
                buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
            } else {
                const ab = await res.arrayBuffer();
                buf = Buffer.from(ab);
            }
        } catch (e) {
            clearTimeout(timer);
            return { ok: false, error: `could not read the response body: ${e.message}`, url: current };
        }
        clearTimeout(timer);
        if (buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
        return {
            ok: true,
            url: current,
            status: res.status,
            content_type: res.headers.get('content-type') || '',
            headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => !/^(set-cookie|cookie)$/i.test(k))),
            body: buf,
            truncated: buf.length >= maxBytes,
            hops: seen,
        };
    }
    return { ok: false, error: 'too many redirects', refused: true, url: current };
}

function _clip(text, max = LIMITS.textMaxChars) {
    const s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} characters]` : s;
}

function _fmtDate(date, tz, opts = {}) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
        weekday: 'short',
        timeZoneName: 'short',
        ...opts,
    });
    const parts = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
    return parts;
}

function _isValidTz(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_e) { return false; }
}

// ── tool handlers ───────────────────────────────────────────────────────────

// 1 ─ web search ─────────────────────────────────────────────────────────────
async function _webSearch(args) {
    const query = String(args.query || args.q || '').trim();
    if (!query) return { ok: false, error: 'a search query is required' };
    const limit = Math.max(1, Math.min(parseInt(args.limit) || 5, LIMITS.searchLimit));
    const source = String(args.source || 'auto').toLowerCase();
    const location = String(args.location || '').trim();
    const full = location ? `${query} ${location}` : query;

    const results = [];
    const sources = [];

    if (source === 'auto' || source === 'wikipedia') {
        try {
            const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(full)}&srlimit=${limit}&format=json&origin=*`;
            const r = await safeFetch(url, { timeoutMs: LIMITS.searchTimeoutMs, maxBytes: 512 * 1024 });
            if (r.ok && r.status === 200) {
                const data = JSON.parse(r.body.toString('utf8'));
                for (const hit of (data.query && data.query.search) || []) {
                    results.push({
                        title: hit.title,
                        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(hit.title).replace(/ /g, '_'))}`,
                        snippet: String(hit.snippet || '').replace(/<[^>]+>/g, ''),
                        source: 'wikipedia',
                        date: hit.timestamp || null,
                    });
                }
                sources.push('wikipedia');
            }
        } catch (_e) { /* wikipedia unreachable — fall through */ }
    }

    if (source === 'auto' || source === 'news') {
        if (results.length < limit) {
            try {
                const url = `https://news.google.com/rss/search?q=${encodeURIComponent(full)}&hl=en-US&gl=US&ceid=US:en`;
                const r = await safeFetch(url, { timeoutMs: LIMITS.searchTimeoutMs, maxBytes: 1024 * 1024 });
                if (r.ok && r.status === 200) {
                    const xml = r.body.toString('utf8');
                    const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
                    for (const item of items) {
                        if (results.length >= limit) break;
                        const title = /<title>([\s\S]*?)<\/title>/i.exec(item);
                        const link = /<link>([\s\S]*?)<\/link>/i.exec(item);
                        const pub = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(item);
                        const desc = /<description>([\s\S]*?)<\/description>/i.exec(item);
                        const titleText = title ? textParse.decodeEntities(title[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : '';
                        if (!titleText || titleText === 'Google News') continue;
                        results.push({
                            title: titleText,
                            url: link ? textParse.decodeEntities(link[1].trim()) : null,
                            snippet: desc ? textParse.stripHtml(desc[1]).slice(0, 300) : '',
                            source: 'news',
                            date: pub ? pub[1].trim() : null,
                        });
                    }
                    sources.push('news');
                }
            } catch (_e) { /* news unreachable — fall through */ }
        }
    }

    if (!sources.length) {
        return { ok: false, error: 'no search backend answered (wikipedia and news both unreachable)' };
    }
    return { ok: true, data: { query, location: location || null, searched: sources, count: results.length, results } };
}

// 2 ─ current time ───────────────────────────────────────────────────────────
async function _currentTime(args) {
    const tz = args.timezone || args.tz;
    const useTz = _isValidTz(tz) ? tz : 'UTC';
    const now = new Date();
    const p = _fmtDate(now, useTz);
    const offsetMin = _offsetMinutes(now, useTz);
    return {
        ok: true,
        data: {
            unix: Math.floor(now.getTime() / 1000),
            iso: now.toISOString(),
            utc: now.toISOString(),
            human: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`,
            local: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`,
            timezone: useTz,
            timezone_name: p.timeZoneName,
            utc_offset: _formatOffset(offsetMin),
            day_of_week: p.weekday,
            is_dst: _isDst(now, useTz),
            requested_timezone: tz || null,
            timezone_valid: tz ? _isValidTz(tz) : true,
        },
    };
}

// Minutes EAST of UTC for a zone at a given instant.
//
// The trick: format the instant in the target zone, read the wall clock as
// if it were UTC, and subtract the real instant. The difference IS the
// zone's offset (Paris in winter → +60, Karachi → +300).
function _offsetMinutes(date, tz) {
    const p = _fmtDate(date, tz, { timeZoneName: undefined });
    const asUtc = Date.UTC(
        parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10),
        parseInt(p.hour, 10) % 24, parseInt(p.minute, 10), parseInt(p.second, 10));
    return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

// Is the zone observing daylight saving right now?
//
// A zone's STANDARD offset is the SMALLER of its January and July offsets
// (in the southern hemisphere the seasons swap, but the smaller one is
// still standard time). If today's offset is bigger, DST is on.
function _isDst(date, tz) {
    try {
        const y = date.getUTCFullYear();
        const jan = _offsetMinutes(new Date(Date.UTC(y, 0, 15)), tz);
        const jul = _offsetMinutes(new Date(Date.UTC(y, 6, 15)), tz);
        const standard = Math.min(jan, jul);
        return _offsetMinutes(date, tz) > standard;
    } catch (_e) {
        return null;
    }
}

/** "+05:00" / "-04:30" from minutes east of UTC. */
function _formatOffset(minutes) {
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(Math.round(minutes));
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// 3 ─ calculator ─────────────────────────────────────────────────────────────
async function _calculator(args) {
    let expr = args.expression;
    if (expr === undefined && args.a !== undefined && args.b !== undefined) {
        const op = String(args.operation || '+');
        const allowed = { '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '^': '^' };
        if (!allowed[op]) return { ok: false, error: `unsupported operation '${op}'` };
        expr = `(${args.a}) ${allowed[op]} (${args.b})`;
    }
    if (expr === undefined) expr = args.expr;
    if (expr === undefined) return { ok: false, error: 'an expression is required (e.g. expression: "2 + 2 * 3")' };
    const r = mathLib.evaluate(expr);
    if (!r.ok) return { ok: false, error: r.error, data: { expression: r.expression } };
    return { ok: true, data: { expression: r.expression, result: r.result } };
}

// 4 ─ web fetch / reader ─────────────────────────────────────────────────────
async function _webFetch(args) {
    const url = String(args.url || '').trim();
    if (!url) return { ok: false, error: 'a url is required' };
    const r = await safeFetch(url, {
        timeoutMs: Math.min(parseInt(args.timeout_ms) || LIMITS.fetchTimeoutMs, 30000),
        maxBytes: LIMITS.fetchMaxBytes,
    });
    if (!r.ok) return { ok: false, error: r.error, refused: r.refused, data: { url } };

    const ct = String(r.content_type || '').toLowerCase();
    const raw = r.body.toString('utf8');
    let text = raw;
    let title = null;
    let format = 'text';

    if (ct.includes('html') || /^\s*<(!doctype|html)/i.test(raw)) {
        title = textParse.htmlTitle(raw);
        text = textParse.stripHtml(raw);
        format = 'text/html';
    } else if (ct.includes('json') || /^\s*[[{]/.test(raw)) {
        try { text = JSON.stringify(JSON.parse(raw), null, 2); format = 'application/json'; }
        catch (_e) { format = 'text/plain'; }
    } else if (ct.includes('xml')) {
        try { text = JSON.stringify(textParse.parseXml(raw), null, 2); format = 'application/xml'; }
        catch (_e) { format = 'text/plain'; }
    }

    if (args.format === 'html') { text = raw; format = 'text/html (raw)'; }

    return {
        ok: true,
        data: {
            url: r.url,
            status: r.status,
            content_type: r.content_type || null,
            format,
            title,
            chars: text.length,
            truncated: r.truncated || text.length > LIMITS.textMaxChars,
            text: _clip(text, LIMITS.textMaxChars),
        },
    };
}

// 5 ─ http request ───────────────────────────────────────────────────────────
async function _httpRequest(args) {
    const url = String(args.url || '').trim();
    if (!url) return { ok: false, error: 'a url is required' };
    const method = String(args.method || 'GET').toUpperCase();
    const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    if (!allowed.has(method)) return { ok: false, error: `unsupported method '${method}' (allowed: ${[...allowed].join(', ')})` };

    let target = url;
    if (args.query && typeof args.query === 'object') {
        const u = new URL(url);
        for (const [k, v] of Object.entries(args.query)) {
            if (v === undefined || v === null) continue;
            u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
        }
        target = u.toString();
    }

    const headers = {};
    if (args.headers && typeof args.headers === 'object') {
        for (const [k, v] of Object.entries(args.headers)) {
            if (v === undefined || v === null) continue;
            headers[String(k).toLowerCase()] = String(v);
        }
    }
    let body = null;
    if (args.json !== undefined) {
        body = JSON.stringify(args.json);
        headers['content-type'] = headers['content-type'] || 'application/json';
    } else if (args.body !== undefined && args.body !== null) {
        body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
        headers['content-type'] = headers['content-type'] || 'text/plain';
    } else if (args.form && typeof args.form === 'object') {
        body = new URLSearchParams(Object.entries(args.form).map(([k, v]) => [k, String(v)])).toString();
        headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
    }

    const r = await safeFetch(target, {
        method, headers, body,
        timeoutMs: Math.min(parseInt(args.timeout_ms) || LIMITS.httpTimeoutMs, 30000),
        maxBytes: LIMITS.fetchMaxBytes,
    });
    if (!r.ok) return { ok: false, error: r.error, refused: r.refused, data: { url: target, method } };

    const text = r.body.toString('utf8');
    let parsed = null;
    if (/json/i.test(r.content_type)) { try { parsed = JSON.parse(text); } catch (_e) { parsed = null; } }

    return {
        ok: true,
        data: {
            url: r.url,
            method,
            status: r.status,
            content_type: r.content_type || null,
            headers: r.headers,
            bytes: r.body.length,
            truncated: r.truncated,
            json: parsed,
            body: parsed ? undefined : _clip(text, LIMITS.textMaxChars),
        },
    };
}

// 6 ─ code interpreter ───────────────────────────────────────────────────────
async function _codeInterpreter(args) {
    const code = args.code;
    if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'code is required' };
    const language = String(args.language || 'python').toLowerCase();
    const r = await sandbox.execute({
        code,
        language,
        timeoutMs: Math.min(parseInt(args.timeout_ms) || 10000, sandbox.LIMITS.timeoutMsMax),
    });
    if (r.refused) return { ok: false, error: r.error, refused: true };
    if (!r.ok) {
        return {
            ok: false,
            error: r.timedOut ? `the run exceeded its time limit and was killed` : (r.error || 'the sandbox run failed'),
            data: { stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode, timed_out: !!r.timedOut, runtime: r.runtime },
        };
    }
    return {
        ok: true,
        data: {
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exitCode,
            timed_out: !!r.timedOut,
            runtime: r.runtime,
            language,
        },
    };
}

// 7 ─ file reader ────────────────────────────────────────────────────────────
async function _fileRead(args) {
    const id = args.id || args.file_id || args.document_id;
    const url = args.url;
    if (!id && !url) {
        return { ok: false, error: 'a document id is required (upload the file first, then pass the id) — or give a url' };
    }
    if (id) {
        const r = fileStore.readDocument(id, { maxChars: fileStore.MAX_TEXT_CHARS });
        if (!r.ok) return { ok: false, error: r.error };
        const d = r.document;
        return {
            ok: true,
            data: {
                id: d.id, name: d.name, kind: d.kind, mime: d.mime, size: d.size,
                pages: d.pages, chars: d.chars, truncated: d.truncated,
                extract_error: d.extract_error,
                text: _clip(d.text, LIMITS.textMaxChars),
            },
        };
    }
    // a url: fetch it and extract text the same way
    const r = await safeFetch(url, { timeoutMs: LIMITS.fetchTimeoutMs, maxBytes: LIMITS.fetchMaxBytes });
    if (!r.ok) return { ok: false, error: r.error, refused: r.refused };
    const ct = String(r.content_type || '');
    const kind = fileExtract.kindOf(fileExtract.extOf(url), ct);
    if (kind === 'image' || kind === 'binary') {
        return { ok: true, data: { url: r.url, kind, mime: ct, bytes: r.body.length, note: 'binary content — no text to extract' } };
    }
    const extracted = await fileExtract.extractText(kind, fileExtract.extOf(url), r.body);
    return {
        ok: true,
        data: {
            url: r.url, kind, mime: ct, bytes: r.body.length,
            chars: (extracted.text || '').length,
            pages: extracted.pages,
            extract_error: extracted.error,
            text: _clip(extracted.text || '', LIMITS.textMaxChars),
        },
    };
}

// 8 ─ file search ────────────────────────────────────────────────────────────
async function _fileSearch(args) {
    const query = args.query || args.q;
    const r = fileStore.searchDocuments({
        query,
        regex: args.regex === true,
        caseInsensitive: args.case_sensitive !== true,
        context: args.context,
        maxResults: args.max_results,
        kinds: Array.isArray(args.kinds) ? args.kinds : null,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: r };
}

// 9 ─ memory ─────────────────────────────────────────────────────────────────
async function _memory(args, ctx) {
    const principal = String((ctx && ctx.principal) || 'anon');
    const action = String(args.action || (args.key && args.value !== undefined ? 'remember' : 'recall')).toLowerCase();
    switch (action) {
        case 'remember': {
            const key = args.key || args.name;
            if (!key) return { ok: false, error: 'a memory key is required' };
            const r = await memoryLib.remember(principal, key, args.value, {
                tags: args.tags,
                ttlSeconds: args.ttl_seconds,
            });
            if (!r.ok) return { ok: false, error: r.error };
            return { ok: true, data: { action: 'remember', key: r.key, created: r.created, value: r.memory.value, updated_at: r.memory.updated_at } };
        }
        case 'recall':
        case 'list': {
            const r = await memoryLib.recall(principal, { query: args.query || null, tag: args.tag || null, limit: args.limit });
            if (!r.ok) return { ok: false, error: r.error };
            return { ok: true, data: { action: 'recall', count: r.count, items: r.items } };
        }
        case 'forget': {
            const r = await memoryLib.forget(principal, args.key || null);
            if (!r.ok) return { ok: false, error: r.error };
            return { ok: true, data: { action: 'forget', removed: r.removed, scope: r.scope, key: r.key || null } };
        }
        default:
            return { ok: false, error: `unknown memory action '${action}' (use remember, recall, forget or list)` };
    }
}

// 10 ─ text / json parser ────────────────────────────────────────────────────
async function _textParser(args) {
    const input = args.input !== undefined ? args.input : args.text !== undefined ? args.text : args.json;
    if (input === undefined || input === null) return { ok: false, error: 'input text is required' };
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    const format = String(args.format || 'auto').toLowerCase();
    const operation = String(args.operation || 'parse').toLowerCase();
    const detected = format === 'auto' ? textParse.detectFormat(raw) : format;

    if (operation === 'extract') {
        return { ok: true, data: { operation: 'extract', detected_format: detected, extracted: textParse.extractEntities(raw) } };
    }
    if (operation === 'validate') {
        if (detected !== 'json') return { ok: false, error: `validation is only implemented for JSON (detected '${detected}')` };
        try {
            JSON.parse(raw);
            return { ok: true, data: { operation: 'validate', valid: true, detected_format: 'json' } };
        } catch (e) {
            return { ok: false, error: `invalid JSON: ${e.message}`, data: { operation: 'validate', valid: false } };
        }
    }

    let parsed = null;
    try {
        if (detected === 'json') parsed = JSON.parse(raw);
        else if (detected === 'xml') parsed = textParse.parseXml(raw);
        else if (detected === 'yaml') parsed = textParse.parseYaml(raw);
        else if (detected === 'csv') parsed = fileExtract.csvToObjects(raw);
        else if (detected === 'text') {
            // Unstructured prose is not a failure — there is simply nothing
            // to structure. Hand it back with the entities a caller usually
            // wanted (urls, emails, dates) instead of an error: a model that
            // hands prose to the parser should get the prose back, not a
            // failure it has to explain to the user.
            return {
                ok: true,
                data: {
                    operation: 'parse',
                    detected_format: 'text',
                    summary: { type: 'string', length: raw.length },
                    parsed: raw,
                    note: 'no structured format detected — pass format: json|csv|xml|yaml to force one',
                    extracted: textParse.extractEntities(raw),
                },
            };
        }
    } catch (e) {
        return { ok: false, error: `could not parse as ${detected}: ${e.message}` };
    }
    if (parsed === null) {
        return { ok: false, error: `could not parse the input as ${detected} (pass an explicit format if the detection was wrong)` };
    }
    if (operation === 'pretty') {
        const out = detected === 'xml' || detected === 'yaml'
            ? JSON.stringify(parsed, null, 2)
            : JSON.stringify(parsed, null, 2);
        return { ok: true, data: { operation: 'pretty', detected_format: detected, text: _clip(out, LIMITS.textMaxChars) } };
    }
    const summary = {
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
        keys: (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? Object.keys(parsed).slice(0, 50) : undefined,
        length: Array.isArray(parsed) ? parsed.length : undefined,
    };
    return {
        ok: true,
        data: {
            operation: 'parse',
            detected_format: detected,
            summary,
            parsed: JSON.parse(JSON.stringify(parsed)),
        },
    };
}

// 11 ─ timezone converter ────────────────────────────────────────────────────
async function _timezoneConvert(args) {
    const to = args.timezone || args.to || args.tz;
    if (!to) return { ok: false, error: 'a target timezone is required (IANA name, e.g. "Asia/Karachi")' };
    if (!_isValidTz(to)) {
        let sample = [];
        try { sample = Intl.supportedValuesOf('timeZone').slice(0, 40); } catch (_e) { void _e; }
        return { ok: false, error: `'${to}' is not a valid IANA timezone` + (sample.length ? ` (e.g. ${sample.slice(0, 8).join(', ')})` : '') };
    }
    const from = args.from_timezone || args.from || null;
    if (from && !_isValidTz(from)) return { ok: false, error: `'${from}' is not a valid IANA timezone` };

    let when;
    if (args.datetime) {
        const parsed = new Date(args.datetime);
        if (Number.isNaN(parsed.getTime())) return { ok: false, error: `'${args.datetime}' is not a parseable date-time` };
        when = parsed;
    } else {
        when = new Date();
    }

    const target = _fmtDate(when, to);
    const origin = from ? _fmtDate(when, from) : null;
    const offsetMin = _offsetMinutes(when, to);

    const out = {
        source_datetime: when.toISOString(),
        timezone: to,
        timezone_name: target.timeZoneName,
        local: `${target.year}-${target.month}-${target.day} ${target.hour}:${target.minute}:${target.second}`,
        date: `${target.year}-${target.month}-${target.day}`,
        time: `${target.hour}:${target.minute}:${target.second}`,
        day_of_week: target.weekday,
        utc_offset: _formatOffset(offsetMin),
        is_dst: _isDst(when, to),
    };
    if (from) {
        const fromOffset = _offsetMinutes(when, from);
        out.from_timezone = from;
        out.from_local = `${origin.year}-${origin.month}-${origin.day} ${origin.hour}:${origin.minute}:${origin.second}`;
        out.from_utc_offset = _formatOffset(fromOffset);
        out.from_is_dst = _isDst(when, from);
        const diffMin = offsetMin - fromOffset;
        out.difference = `${diffMin >= 0 ? '+' : ''}${(diffMin / 60).toFixed(2)} hours`;
    }
    if (!args.datetime) out.is_now = true;
    return { ok: true, data: out };
}

// 12 ─ translate ─────────────────────────────────────────────────────────────
const LANGUAGES = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    ar: 'Arabic', hi: 'Hindi', ur: 'Urdu', bn: 'Bengali', pa: 'Punjabi',
    tr: 'Turkish', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', no: 'Norwegian',
    fa: 'Persian', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', mr: 'Marathi',
    gu: 'Gujarati', kn: 'Kannada', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian',
    ms: 'Malay', sw: 'Swahili', he: 'Hebrew', el: 'Greek', uk: 'Ukrainian',
    ro: 'Romanian', cs: 'Czech', da: 'Danish', fi: 'Finnish', hu: 'Hungarian',
};

async function _translate(args) {
    const text = String(args.text || args.input || '').trim();
    if (!text) return { ok: false, error: 'text to translate is required' };
    const to = String(args.to || args.target_language || args.target || '').trim().toLowerCase();
    if (!to) return { ok: false, error: 'a target language is required (e.g. to: "ur")' };
    const toName = LANGUAGES[to] || LANGUAGES[to.split('-')[0]] || to;
    const from = String(args.from || args.source_language || '').trim().toLowerCase();
    const fromName = from ? (LANGUAGES[from] || LANGUAGES[from.split('-')[0]] || from) : null;

    if (!routerRef) {
        return { ok: false, error: 'the hive router is not ready yet — retry in a moment' };
    }
    if (text.length > LIMITS.translateMaxChars) {
        return { ok: false, error: `text too long (${text.length} characters; the limit is ${LIMITS.translateMaxChars})` };
    }

    const system = [
        `You are a precise translator. Translate the user's text into ${toName}${fromName ? ` from ${fromName}` : ''}.`,
        'Return ONLY the translation — no preamble, no notes, no quotes, no explanations.',
        'Preserve the formatting, line breaks and any placeholders exactly.',
    ].join(' ');

    const res = await routerRef.chatCompletion(
        [{ role: 'system', content: system }, { role: 'user', content: text }],
        {
            stream: false,
            capability: 'translation',
            route: { mode: args.mode || 'fast' },
            via: 'toolkit',
            reason: 'translate tool',
            timeout: 60000,
        }
    );
    if (!res || !res.ok) {
        return { ok: false, error: (res && res.error) || 'the hive could not translate that right now' };
    }
    const answer = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
        ? res.data.choices[0].message.content
        : '';
    return {
        ok: true,
        data: {
            source_text: text,
            source_language: fromName || 'auto-detected',
            target_language: toName,
            translation: String(answer || '').trim(),
            answered_by: res.answeredBy || null,
        },
    };
}

// 13 ─ sysinfo (pre-existing hive tool, kept alive) ─────────────────────────
// Not one of the twelve, but the bees have advertised it since day one and
// the CLI's tool schema still lists it — dropping it would break callers.
async function _sysinfo() {
    const os = require('os');
    const mem = os.freemem();
    const total = os.totalmem();
    let disk = null;
    try {
        const st = require('fs').statfsSync('/');
        disk = {
            total_gb: Math.round((st.blocks * st.bsize) / 1e9 * 10) / 10,
            free_gb: Math.round((st.bavail * st.bsize) / 1e9 * 10) / 10,
        };
    } catch (_e) { void _e; }
    return {
        ok: true,
        data: {
            cpu_model: (os.cpus()[0] || {}).model || null,
            cpus: os.cpus().length,
            memory_total_gb: Math.round(total / 1e9 * 10) / 10,
            memory_free_gb: Math.round(mem / 1e9 * 10) / 10,
            memory_used_gb: Math.round((total - mem) / 1e9 * 10) / 10,
            loadavg: os.loadavg(),
            uptime_days: Math.round(os.uptime() / 86400 * 10) / 10,
            disk,
            platform: `${os.platform()} ${os.release()}`,
        },
    };
}

// ── the catalog ─────────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'web_search',
        schema_description: 'Search the internet (Wikipedia + news). Use for facts, history, people, places, current events. NOT granted by default — returns MAYBE for a human to approve.',
        aliases: ['search', 'news', 'websearch'],
        capability: 'web.search',
        description: 'Search the internet for information. Returns titles, snippets and links. '
            + 'Use for facts, history, definitions, people and places, and for current events (it also '
            + 'reads the news feeds). NOTE: on this network web search is not granted by default — it '
            + 'returns a MAYBE asking a human to approve it.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to look up — the search terms or topic.' },
                limit: { type: 'integer', description: 'How many results to return (1-10).', minimum: 1, maximum: 10 },
                location: { type: 'string', description: 'Optional place/context to bias results.' },
                source: { type: 'string', enum: ['auto', 'wikipedia', 'news'], description: 'Which backend to search. Default auto (encyclopaedic first, then news).' },
            },
            required: ['query'],
        },
        runs: ['hub', 'bee'],
        advertise: () => isWebSearchEnabled(),
        handler: _webSearch,
    },
    {
        name: 'current_time',
        schema_description: "Today's date and time: unix, ISO-8601, day of week, UTC offset. Pass an IANA timezone (e.g. Asia/Karachi).",
        aliases: ['time', 'get_time', 'now', 'datetime'],
        capability: 'local.computation',
        description: "Know today's date and time. Returns the unix timestamp, ISO-8601, the "
            + 'human-readable local time, the day of week and the UTC offset. Optionally in a '
            + 'specific IANA timezone (e.g. "Asia/Karachi").',
        parameters: {
            type: 'object',
            properties: {
                timezone: { type: 'string', description: 'Optional IANA timezone name (e.g. "Europe/Paris"). Defaults to UTC.' },
            },
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _currentTime,
    },
    {
        name: 'calculator',
        schema_description: 'Accurate arithmetic: + - * / % ^, parentheses, pi, e, and functions (sqrt, log, sin, abs, min, max, factorial…). Never compute by hand — call this.',
        aliases: ['calculate', 'calc', 'math'],
        capability: 'local.computation',
        description: 'Accurate mathematical calculations. Supports + - * / % ^, parentheses, '
            + 'constants (pi, e) and functions (sqrt, cbrt, abs, round, floor, ceil, min, max, sum, '
            + 'prod, hypot, gcd, lcm, factorial, exp, ln, log, log10, log2, sin, cos, tan, asin, acos, '
            + 'atan, atan2, sinh, cosh, tanh, deg, rad). Exact — use this instead of doing arithmetic in your head.',
        parameters: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: 'The expression to evaluate, e.g. "(12 + 8) * 3 / 7".' },
            },
            required: ['expression'],
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _calculator,
    },
    {
        name: 'web_fetch',
        schema_description: 'Read a web page and return readable text (HTML stripped, JSON pretty-printed).',
        aliases: ['fetch', 'reader', 'web_reader', 'read_url'],
        capability: 'web.fetch',
        description: 'Read and extract the content of a web page. Fetches the URL, strips the HTML '
            + 'noise and returns readable text (JSON is pretty-printed, XML is converted). Private and '
            + 'internal addresses are refused for safety.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The absolute http(s) URL to read.' },
                timeout_ms: { type: 'integer', description: 'Give up after this many milliseconds (max 30000).' },
                format: { type: 'string', enum: ['text', 'html'], description: 'Return readable text (default) or the raw HTML.' },
            },
            required: ['url'],
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _webFetch,
    },
    {
        name: 'http_request',
        schema_description: 'Call an HTTP API: any method, headers, JSON or form body, query params. Returns status, headers, body.',
        aliases: ['request', 'curl', 'api_call'],
        capability: 'web.fetch',
        description: 'Call an HTTP API. Supports any method (GET, POST, PUT, PATCH, DELETE, HEAD), '
            + 'custom headers, a JSON body, form-encoded body and query parameters. Returns the status, '
            + 'headers and body. Private and internal addresses are refused.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The absolute http(s) URL to call.' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], description: 'HTTP method. Default GET.' },
                headers: { type: 'object', description: 'Request headers as key/value pairs.', additionalProperties: { type: 'string' } },
                json: { type: 'object', description: 'A JSON body (sent as application/json).' },
                body: { type: 'string', description: 'A raw string body.' },
                form: { type: 'object', description: 'A form body (sent as application/x-www-form-urlencoded).', additionalProperties: { type: 'string' } },
                query: { type: 'object', description: 'Query-string parameters.', additionalProperties: { type: 'string' } },
                timeout_ms: { type: 'integer', description: 'Give up after this many milliseconds (max 30000).' },
            },
            required: ['url'],
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _httpRequest,
    },
    {
        name: 'code_interpreter',
        schema_description: 'Run code in an isolated sandbox (no network, capped memory/CPU, read-only). python, bash or node. Returns stdout, stderr, exit code.',
        aliases: ['exec', 'coding.execute', 'run_code', 'python', 'sandbox'],
        capability: 'coding.execute',
        description: 'Execute code safely in an isolated sandbox — no network, capped memory/CPU/processes, '
            + 'read-only filesystem, destroyed after the run. Languages: python, bash, node. Returns stdout, '
            + 'stderr and the exit code. Use it for real computation, data wrangling and testing snippets.',
        parameters: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'The source code to run.' },
                language: { type: 'string', enum: ['python', 'bash', 'node'], description: 'Which language to run. Default python.' },
                timeout_ms: { type: 'integer', description: 'Kill the run after this many milliseconds (1000-30000).' },
            },
            required: ['code'],
        },
        runs: ['hub'],
        advertise: () => true,
        handler: _codeInterpreter,
    },
    {
        name: 'file_read',
        schema_description: 'Read a document: PDF, DOCX, TXT, CSV, JSON, YAML, Markdown. Pass an uploaded file id, or a URL.',
        aliases: ['read_file', 'read_document', 'open_file'],
        capability: 'data.file.read',
        description: 'Read a document and return its text. Works with PDF, DOCX, TXT, CSV, JSON, YAML, '
            + 'Markdown and other plain-text files. On the hub you pass the id of a file that was '
            + 'uploaded; you can also pass a URL. Images are reported by type and size, not decoded.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'The id of an uploaded document (from the upload response).' },
                url: { type: 'string', description: 'A URL to fetch and read instead of an uploaded document.' },
            },
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _fileRead,
    },
    {
        name: 'file_search',
        schema_description: 'Search uploaded documents for text or a regex. Returns matching lines with line numbers and context.',
        aliases: ['search_files', 'grep', 'search_documents'],
        capability: 'data.file.read',
        description: 'Search across the documents you have uploaded — a literal substring or a regular '
            + 'expression — and return the matching lines with their line numbers and surrounding context.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The text (or regular expression) to look for.' },
                regex: { type: 'boolean', description: 'Treat the query as a regular expression. Default false.' },
                case_sensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
                context: { type: 'integer', description: 'Lines of context around each hit (0-10). Default 1.' },
                max_results: { type: 'integer', description: 'Maximum hits per document (1-200). Default 20.' },
            },
            required: ['query'],
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _fileSearch,
    },
    {
        name: 'memory',
        schema_description: 'Remember something for later. action: remember (key+value), recall, forget, list. Private to this conversation.',
        aliases: ['remember', 'recall', 'memories'],
        capability: 'data.memory',
        description: 'Retain useful information between interactions. Actions: "remember" (store a '
            + 'value under a key), "recall" (read memories back, optionally filtered by a query), '
            + '"forget" (delete one key, or everything), "list". Memory is private to the conversation '
            + 'it belongs to.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['remember', 'recall', 'forget', 'list'], description: 'What to do. Default: remember when a key and value are given, else recall.' },
                key: { type: 'string', description: 'The key to store under or delete.' },
                value: { description: 'The value to remember (any JSON).' },
                query: { type: 'string', description: 'Filter recalled memories by this text.' },
                tag: { type: 'string', description: 'Filter recalled memories by this tag.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags to attach when remembering.' },
                ttl_seconds: { type: 'integer', description: 'Expire the memory after this many seconds.' },
                limit: { type: 'integer', description: 'How many memories to recall. Default 25.' },
            },
        },
        runs: ['hub'],
        advertise: () => true,
        handler: _memory,
    },
    {
        name: 'text_parser',
        schema_description: 'Parse JSON, CSV, XML or YAML into structure. operation: parse, pretty, validate, extract (urls/emails/dates).',
        aliases: ['parse', 'json_parse', 'structure'],
        capability: 'local.computation',
        description: 'Parse and structure information. Detects JSON, CSV, XML, YAML or plain text and '
            + 'returns structured output. Operations: "parse" (structured value + summary), "pretty" '
            + '(formatted JSON), "validate" (is this valid JSON?), "extract" (pull out URLs, emails, '
            + 'dates and numbers).',
        parameters: {
            type: 'object',
            properties: {
                input: { type: 'string', description: 'The text to parse.' },
                format: { type: 'string', enum: ['auto', 'json', 'csv', 'xml', 'yaml', 'text'], description: 'Force a format instead of detecting one. Default auto.' },
                operation: { type: 'string', enum: ['parse', 'pretty', 'validate', 'extract'], description: 'What to do with the input. Default parse.' },
            },
            required: ['input'],
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _textParser,
    },
    {
        name: 'timezone_convert',
        schema_description: 'Convert a moment between IANA timezones (DST-correct), or ask for the time in a zone.',
        aliases: ['tz', 'convert_time', 'time_zone'],
        capability: 'local.computation',
        description: 'Understand time across countries. Convert a moment in time from one IANA timezone '
            + 'to another (DST-correct), or ask for the current time in a timezone. Returns the local '
            + 'date and time, the day of week and the UTC offset of each zone.',
        parameters: {
            type: 'object',
            properties: {
                timezone: { type: 'string', description: 'The target IANA timezone, e.g. "America/New_York".' },
                from_timezone: { type: 'string', description: 'The source IANA timezone, when converting between two zones.' },
                datetime: { type: 'string', description: 'The moment to convert (ISO-8601). Omit for "now".' },
            },
            required: ['timezone'],
        },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _timezoneConvert,
    },
    {
        name: 'translate',
        schema_description: 'Translate text between languages — the hive does the translating.',
        aliases: ['translation', 'lang'],
        capability: 'translation',
        description: 'Translate text between languages. The hive does the translating — a model on the '
            + 'network handles it, so it works in every language the hive speaks.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'The text to translate.' },
                to: { type: 'string', description: 'Target language code (e.g. "ur", "es", "fr", "zh").' },
                from: { type: 'string', description: 'Source language code. Omit to auto-detect.' },
            },
            required: ['text', 'to'],
        },
        runs: ['hub'],
        advertise: () => true,
        handler: _translate,
    },
    {
        name: 'sysinfo',
        schema_description: 'CPU, memory, disk, load and uptime of the machine doing the work.',
        aliases: ['system_info', 'host_info'],
        capability: 'local.computation',
        description: 'A snapshot of the machine doing the work: CPU model and core count, memory '
            + 'used and free, load average, uptime, disk space. Useful before a heavy job.',
        parameters: { type: 'object', properties: {} },
        runs: ['hub', 'bee'],
        advertise: () => true,
        handler: _sysinfo,
    },
];

// ── registry helpers ────────────────────────────────────────────────────────

const BY_NAME = new Map();
for (const t of TOOLS) {
    BY_NAME.set(t.name, t);
    for (const a of (t.aliases || [])) BY_NAME.set(a, t);
}

/** Resolve any name or alias to a tool definition. */
function resolveTool(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return BY_NAME.get(key) || BY_NAME.get(key.replace(/_/g, '')) || null;
}

/** Every tool, in catalog order. */
function allTools() { return TOOLS; }

/** The tools that should be advertised to models right now. */
function advertisedTools() {
    return TOOLS.filter((t) => {
        try { return t.advertise ? t.advertise() !== false : true; } catch (_e) { return true; }
    });
}

/** The capability key a tool maps to (used by the policy gate). */
function toolCapability(name) {
    const t = resolveTool(name);
    if (t) return t.capability;
    return require('./capabilities').toolToCap(name);
}

/**
 * OpenAI-style function schemas — the shape a model expects.
 *
 * The tool-level description is the COMPACT one (`schema_description`). The
 * long description is for humans and for MCP (an agent reads the docs); a
 * model gets a tight instruction, because that is both cheaper and what
 * models follow best. The full text still ships in the catalog and at
 * GET /api/tools/catalog.
 *
 * @param {object} opts  { only?: string[], includeHidden?: boolean }
 */
function openaiSchemas({ only = null, includeHidden = false } = {}) {
    const list = includeHidden ? TOOLS : advertisedTools();
    return list
        .filter((t) => (!only || only.includes(t.name) || (t.aliases || []).some((a) => only.includes(a))))
        .map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.schema_description || t.description,
                parameters: t.parameters,
            },
        }));
}

/** MCP-shaped tool definitions (the MCP SDK wants {name, description, inputSchema}). */
function mcpDefs() {
    return advertisedTools().map((t) => ({
        name: t.name,
        title: t.name.replace(/_/g, ' '),
        description: t.description,
        inputSchema: t.parameters,
    }));
}

/**
 * The public catalog — what the hive can do, and what it takes to do it.
 */
function catalog() {
    const caps = require('./capabilities');
    return TOOLS.map((t) => {
        const cap = caps.get(t.capability);
        return {
            name: t.name,
            aliases: t.aliases || [],
            description: t.description,
            capability: t.capability,
            tier: cap ? cap.tier : 'unknown',
            default_verdict: cap ? cap.default_verdict : 'ask',
            requires_consent: cap ? !!cap.requires_consent : true,
            advertised: (() => { try { return t.advertise ? t.advertise() !== false : true; } catch (_e) { return true; } })(),
            runs_on: t.runs || ['hub'],
            parameters: t.parameters,
        };
    });
}

// ── execution ───────────────────────────────────────────────────────────────

/**
 * Run a tool.
 *
 * @param {string} name        the tool name or one of its aliases
 * @param {object} args        the arguments
 * @param {object} ctx         { principal, transport, nodeId, ip, isAdmin, skipGate, via }
 * @returns {Promise<{tool:string, ok:boolean, data?:object, error?:string,
 *                    via:string, policy?:object}>}
 */
async function execute(name, args = {}, ctx = {}) {
    const tool = resolveTool(name);
    if (!tool) {
        return { tool: String(name || ''), ok: false, error: `unknown tool '${name}'`, via: 'hub' };
    }
    const envelope = { tool: tool.name, via: ctx.via || 'hub' };

    // ── the gate ────────────────────────────────────────────────────────────
    try {
        const policy = require('./policy');
        const capKey = tool.capability;
        // Web search is granted to nobody by default. An operator (loopback /
        // control token) may run it un-gated when HIVV_ENABLE_WEB_SEARCH=1 —
        // that is the "test it" path, and it is never open to the public.
        const adminBypass = capKey === 'web.search' && isWebSearchEnabled() && ctxIsAdmin(ctx);
        if (!adminBypass && !ctx.skipGate) {
            const g = await policy.gate({
                capability: capKey,
                principal: ctx.principal || 'anon',
                transport: ctx.transport || 'toolkit',
                args_summary: { tool: tool.name, ...summarizeArgs(args) },
                reason: ctx.reason || `tool ${tool.name}`,
                via: ctx.nodeId || null,
                node: ctx.nodeId || null,
            });
            envelope.policy = { verdict: g.verdict, rule: g.rule, capability: g.key, risk: g.risk, tier: g.tier, grant_id: g.grant_id || null };
            if (g.verdict === 'deny') {
                return { ...envelope, ok: false, error: `policy refused '${g.key}' (${g.rule})`, policy: envelope.policy };
            }
            if (g.verdict === 'ask') {
                return {
                    ...envelope,
                    ok: false,
                    error: `MAYBE — human approval required for '${g.key}'. Ask the operator to run: hivv approve ${g.grant_id} — then ask again.`,
                    policy: envelope.policy,
                };
            }
        } else if (adminBypass) {
            envelope.policy = { verdict: 'allow', rule: 'admin:web-search-enabled', capability: capKey, risk: 0, tier: 'side-effect' };
        }
    } catch (e) {
        // The gate itself failed. Chat-style tools keep working (fail open);
        // code execution does not (fail closed) — see api/lib/sandbox.js.
        if (tool.capability === 'coding.execute') {
            return { ...envelope, ok: false, error: 'policy gate unavailable — refusing to execute code' };
        }
        console.warn('[TOOLKIT] policy gate error (fail-open):', e.message);
    }

    // ── run it ──────────────────────────────────────────────────────────────
    try {
        const r = await tool.handler(args || {}, ctx || {});
        if (!r || r.ok !== true) {
            // Keep the handler's extra flags (e.g. `refused` on an SSRF
            // refusal) — the HTTP layer needs them to say WHY it failed.
            const extra = {};
            for (const k of ['refused', 'verdict', 'grant_id']) {
                if (r && r[k] !== undefined) extra[k] = r[k];
            }
            return { ...envelope, ...extra, ok: false, error: (r && r.error) || 'the tool failed', data: r && r.data };
        }
        return { ...envelope, ok: true, data: r.data };
    } catch (e) {
        console.warn(`[TOOLKIT] ${tool.name} threw:`, e.message);
        return { ...envelope, ok: false, error: `the tool failed: ${e.message}` };
    }
}

/** A short, non-secret summary of the arguments for the audit ledger. */
function summarizeArgs(args) {
    const out = {};
    if (!args || typeof args !== 'object') return out;
    for (const key of ['query', 'url', 'expression', 'key', 'timezone', 'language', 'method', 'action', 'id', 'to']) {
        if (args[key] !== undefined && args[key] !== null) {
            out[key] = String(args[key]).slice(0, 120);
        }
    }
    return out;
}

module.exports = {
    TOOLS,
    LIMITS,
    LANGUAGES,
    inject,
    isWebSearchEnabled,
    resolveTool,
    allTools,
    advertisedTools,
    toolCapability,
    openaiSchemas,
    mcpDefs,
    catalog,
    execute,
    safeFetch,
};
