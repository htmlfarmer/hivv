// api/lib/polite.js — the responsible-fetch layer: robots.txt + per-host throttle.
//
// WHY: the hive's web tools must be good citizens on the open web.
//   1. ROBOTS.TXT is obeyed before a page is read (RFC 9309 semantics: no
//      file, or 404/410 → fetching is allowed; a Disallow matching the path
//      refuses it with an honest, human-readable reason — the SITE asked
//      crawlers not to read it). /robots.txt itself is always fetchable.
//   2. NO MASS REQUESTS: at most one request per host per interval
//      (default 2s, env HIVV_FETCH_MIN_INTERVAL_MS), and a site's
//      Crawl-delay is honored on top of that, capped at 10s so one strict
//      site cannot stall the whole tool loop.
//   3. TERMS OF SERVICE: the search backends are official APIs (Wikipedia
//      API, Google News RSS — never a scraped search engine), and every
//      request carries an honest, identifiable User-Agent with a contact
//      URL (set in toolkit.js safeFetch).
//
// robots.txt is fetched through the same SSRF guard as content, cached per
// origin for 10 minutes (positive AND negative), and a robots.txt we cannot
// read (timeout, 5xx) does not brick the tool — absence of rules means no
// rules (RFC 9309 §2.3.1.3). Every knob is env-tunable; nothing here can be
// switched off by the MODEL, only by the operator.

const ssrf = require('./ssrf');

const ROBOTS_TTL_MS = 10 * 60 * 1000;
const MAX_CRAWL_DELAY_S = 10;
const ROBOTS_MAX_BYTES = 256 * 1024;
const UA_HEADER = 'hivv-toolkit/1.0 (+https://hivv.org)';
const UA_TOKEN = 'hivv-toolkit';

const robotsCache = new Map();   // origin → { groups, fetchedAt }
const lastHit = new Map();       // host → ms timestamp of our reserved slot

/** Per-host floor between requests. Env-tunable (tests use 0). */
function minIntervalMs() {
    const v = parseInt(process.env.HIVV_FETCH_MIN_INTERVAL_MS, 10);
    return Number.isFinite(v) && v >= 0 ? v : 2000;
}

function robotsEnabled() {
    const v = String(process.env.HIVV_FETCH_ROBOTS || '').trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// ── robots.txt parsing ──────────────────────────────────────────────────────

/**
 * Parse robots.txt into groups: { agents: [..], rules: [{allow, path}],
 * crawlDelay: number|null }. A run of User-agent lines starts a group; the
 * first rule after them marks it closed, so the next User-agent opens a new
 * one (the standard grouping).
 */
function parseRobots(text) {
    const groups = [];
    let cur = null;
    let touched = false;
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const field = m[1].toLowerCase();
        const value = m[2].trim();
        if (field === 'user-agent') {
            if (!cur || touched) {
                cur = { agents: [], rules: [], crawlDelay: null };
                groups.push(cur);
                touched = false;
            }
            cur.agents.push(value.toLowerCase());
        } else if (!cur) {
            continue;                       // rules before any agent — ignore
        } else if (field === 'allow' || field === 'disallow') {
            touched = true;
            cur.rules.push({ allow: field === 'allow', path: value });
        } else if (field === 'crawl-delay') {
            touched = true;
            const d = parseFloat(value);
            if (Number.isFinite(d) && d >= 0) cur.crawlDelay = d;
        }
    }
    return groups;
}

/** robots pattern → RegExp (supports * and a trailing $). */
function patternToRegex(pattern) {
    let body = pattern;
    let anchored = false;
    if (body.endsWith('$')) { anchored = true; body = body.slice(0, -1); }
    let out = '';
    for (const ch of body) {
        if (ch === '*') out += '.*';
        // char class written with an escaped dollar — same regex, and it
        // keeps this file pasteable through a JS template literal
        else out += ch.replace(/[.+?^\${}()|[\]\\]/g, '\\$&');
    }
    try {
        return new RegExp('^' + out + (anchored ? '$' : ''));
    } catch (_e) {
        return null;
    }
}

/**
 * Decide allow/deny for a path from a rule list. Longest match wins; on a
 * tie Allow wins (the conventional reading of RFC 9309 §2.2.2). An empty
 * Disallow ("Disallow:") restricts nothing and is skipped.
 */
function rulesAllow(rules, path) {
    let best = null;
    for (const r of rules) {
        if (!r.path) continue;
        const re = patternToRegex(r.path);
        if (!re || !re.test(path)) continue;
        const len = r.path.length;
        if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) {
            best = { allow: r.allow, len };
        }
    }
    return best ? best.allow : true;
}

/** Pick the groups that apply to OUR agent (specific beats *).
 *  Match rule: the declared agent is a prefix of our token (RFC 9309 §2.2.1 —
 *  "hivv" matches "hivv-toolkit", "googlebot" does not). */
function matchingGroups(groups, uaToken) {
    const token = String(uaToken || UA_TOKEN).toLowerCase();
    const specific = groups.filter(g => g.agents.some(a =>
        a !== '*' && (a === token || token.startsWith(a))));
    if (specific.length) return specific;
    return groups.filter(g => g.agents.includes('*'));
}

/**
 * Pure decision from parsed groups — split out so tests never need a network.
 * Returns { allowed, crawlDelay }.
 */
function decide(groups, uaToken, path) {
    const use = matchingGroups(groups || [], uaToken || UA_TOKEN);
    if (!use.length) return { allowed: true, crawlDelay: null };
    const rules = use.flatMap(g => g.rules);
    const delays = use.map(g => g.crawlDelay).filter(d => d != null);
    return {
        allowed: rulesAllow(rules, path),
        crawlDelay: delays.length ? Math.max(...delays) : null,
    };
}

// ── robots.txt fetch (SSRF-guarded, cached, size-capped) ────────────────────

async function checkRobots(rawUrl, opts = {}) {
    const timeoutMs = opts.timeoutMs || 5000;
    const fetchImpl = opts.fetchImpl || fetch;
    const checkUrl = opts.checkUrl || ssrf.checkUrl;
    const uaToken = opts.uaToken || UA_TOKEN;

    let u;
    try { u = new URL(String(rawUrl)); } catch (_e) {
        return { allowed: true, crawlDelay: null, source: 'invalid-url' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { allowed: true, crawlDelay: null, source: 'non-http' };
    }
    if (u.pathname === '/robots.txt') {
        // robots.txt itself is always fetchable — that is the point of it.
        return { allowed: true, crawlDelay: null, source: 'robots-txt',
                 origin: u.origin, host: u.host };
    }
    if (!robotsEnabled()) {
        return { allowed: true, crawlDelay: null, source: 'robots-disabled',
                 origin: u.origin, host: u.host };
    }

    const path = u.pathname + u.search;
    const now = Date.now();
    const hit = robotsCache.get(u.origin);
    if (hit && now - hit.fetchedAt < ROBOTS_TTL_MS) {
        const d = decide(hit.groups, uaToken, path);
        return { ...d, source: 'cache', origin: u.origin, host: u.host };
    }

    let groups = [];
    let source = 'no-robots';
    const robotsUrl = u.origin + '/robots.txt';
    try {
        const verdict = await checkUrl(robotsUrl);
        if (verdict.ok) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const res = await fetchImpl(robotsUrl, {
                    headers: { 'User-Agent': UA_HEADER },
                    redirect: 'manual',
                    signal: ctrl.signal,
                });
                if (res.status === 200) {
                    // size-capped read — a hostile host must not stream forever
                    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
                    let text = '';
                    if (reader) {
                        const chunks = [];
                        let total = 0;
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            total += value.length;
                            chunks.push(Buffer.from(value));
                            if (total >= ROBOTS_MAX_BYTES) {
                                try { await reader.cancel(); } catch (_e) { void _e; }
                                break;
                            }
                        }
                        text = Buffer.concat(chunks).toString('utf8');
                    } else {
                        const ab = await res.arrayBuffer();
                        text = Buffer.from(ab).slice(0, ROBOTS_MAX_BYTES).toString('utf8');
                    }
                    groups = parseRobots(text);
                    source = 'robots';
                }
                // 404/410 → no rules (allowed); other statuses → no usable rules
            } finally {
                clearTimeout(timer);
            }
        }
    } catch (_e) {
        source = 'no-robots';               // unreachable/timeout — no usable rules
    }

    robotsCache.set(u.origin, { groups, fetchedAt: now });
    const d = decide(groups, uaToken, path);
    return { ...d, source, origin: u.origin, host: u.host };
}

// ── per-host throttle ───────────────────────────────────────────────────────

/** The interval this host owes: our floor, or the site's Crawl-delay (capped). */
function intervalFor(crawlDelaySec) {
    const fromSite = Math.min(Number(crawlDelaySec) || 0, MAX_CRAWL_DELAY_S) * 1000;
    return Math.max(minIntervalMs(), fromSite);
}

/**
 * Reserve the next slot for this host and sleep until it. Reserving BEFORE
 * sleeping serializes concurrent callers: two rapid requests to one host
 * become interval-spaced, while different hosts never wait on each other.
 * Returns the ms actually waited.
 */
async function hold(host, crawlDelaySec = null) {
    const key = String(host || '').toLowerCase();
    const interval = intervalFor(crawlDelaySec);
    if (!key || interval <= 0) return 0;
    const now = Date.now();
    const last = lastHit.get(key) || 0;
    const at = Math.max(last + interval, now);
    lastHit.set(key, at);
    const wait = at - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    return wait;
}

/** Inspection + test hooks. */
function stats() {
    return { robots_cached: robotsCache.size, throttled_hosts: lastHit.size,
             min_interval_ms: minIntervalMs(), robots_enabled: robotsEnabled() };
}

function _reset() {
    robotsCache.clear();
    lastHit.clear();
}

module.exports = {
    parseRobots,
    rulesAllow,
    matchingGroups,
    decide,
    checkRobots,
    intervalFor,
    hold,
    stats,
    _reset,
    UA_TOKEN,
    MAX_CRAWL_DELAY_S,
};
