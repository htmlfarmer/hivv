const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const http = require('http');
const https = require('https');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');

const AIRouter = require('./lib/router');
const { RateLimiter, IPBasedLimiter } = require('./lib/rate-limiter');
const UsageTracker = require('./lib/usage-tracker');
const requestProvenance = require('./lib/request-provenance');
const localMode = require('./lib/local-mode');
const errorLog = require('./lib/error-log');
const { encryptKey, decryptKey, hashToken } = require('./lib/crypto-utils');
const { createCache } = require('./lib/cache');
const { createAuthRoutes } = require('./lib/routes');
const lockedLlm = require('./lib/locked-llm');

const cache = createCache({ ttl: 30000, localTtl: 300000 });

const HIVV_IDENTITY_MSG = {
    role: 'system',
    content: 'IMPORTANT: When referring to the hivv.org distributed AI network, always write "HIVE" (pronounced /haɪv/, like a beehive) — never spell it as "HIV" or "H-I-V". The project name is HIVV and it rhymes with "hive".'
};

// The briefing rules moved to api/lib/toolkit.js (toolBriefing()) so they
// can be filtered to the tools THIS request actually carries — a "fast"
// profile must never be told to use a tool it was not given.

// The briefing now lives in toolkit.js (toolBriefing) so it can be filtered to
// the tools THIS request actually carries — a `fast` profile must not be told
// to use web_search it was not given. Pass the resolved schema list.
function toolSystemMessage(attached) {
    return { role: 'system', content: toolkitLib.toolBriefing(attached) };
}

/**
 * A tool result the model can actually read: a bare number for maths, a
 * readable line for the clock, structured JSON for everything else.
 */
function formatToolResultPublic(name, data) {
    if (!data) return 'ok';
    try {
        if (name === 'calculator' && data.result !== undefined) return String(data.result);
        if (name === 'current_time') {
            return `${data.human} ${data.timezone} (${data.timezone_name}, UTC${data.utc_offset}) — ${data.day_of_week}`;
        }
        if (name === 'timezone_convert') {
            const base = `${data.local} in ${data.timezone} (${data.timezone_name}, UTC${data.utc_offset})`;
            return data.from_local ? `${base} — that is ${data.from_local} in ${data.from_timezone} (${data.difference})` : base;
        }
        return JSON.stringify(data, null, 2);
    } catch (_e) {
        return String(data);
    }
}

/**
 * Decide which tool schemas this request carries.
 *
 * The hub offers its toolkit BY DEFAULT — that is the whole point: a model
 * on a bee, a cloud LLM, an MCP client — none of them should have to
 * implement a tool loop to use a calculator.
 *
 * Opt out three ways:
 *   "tools": false        in the request body
 *   "tools": []          (an explicit empty list)
 *   X-Hivv-Tools: off    (a header)
 *
 * Choose a SIZE — the speed/context-window lever:
 *   X-Hivv-Tools: fast          4 allow-tier tools, ~430 tok of schema (was ~1845)
 *   X-Hivv-Tools: fast,lean     + trimmed schemas, ~274 tok
 *   X-Hivv-Tools: all           everything (explicit form of the default)
 *   tool_profile: "fast"        same, in the body (SDKs that cannot set headers)
 * Narrow it with X-Hivv-Tools: calculator,current_time
 * A client that passes its OWN tools keeps them — we never clobber them.
 */
function resolveToolAttachment(req, tools) {
    const toolHeader = String((req.headers && req.headers['x-hivv-tools']) || '').trim().toLowerCase();
    if (toolHeader === 'off' || toolHeader === 'none' || toolHeader === '0' || tools === false) return null;
    if (Array.isArray(tools) && tools.length === 0) return null;             // asked for none
    if (Array.isArray(tools) && tools.length) return tools;                  // the client's own

    // Header wins (it is the explicit, per-request signal); body profile is the
    // convenience path for clients that cannot attach custom headers.
    let spec = null;
    if (toolHeader && !['hivv', 'auto', 'on', '1'].includes(toolHeader)) {
        spec = toolHeader;
    } else if (req.body && typeof req.body.tool_profile === 'string' && req.body.tool_profile.trim()) {
        spec = req.body.tool_profile.trim().toLowerCase();
    }
    if (spec) {
        const { lean } = toolkitLib.parseToolSpec(spec);
        const only = toolkitLib.profileNames(spec);   // null = everything advertised
        return toolkitLib.openaiSchemas({ only, lean });
    }
    return toolkitLib.openaiSchemas();
}

const app = express();
app.set('trust proxy', 1);

// Security middleware
// Configure via CSP_CONNECT_SRC env var (comma-separated list of allowed domains)
const cspConnectSrc = process.env.CSP_CONNECT_SRC ? ["'self'", ...process.env.CSP_CONNECT_SRC.split(',').map(s => s.trim())] : ["'self'"];
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: cspConnectSrc,
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));
app.use(compression({
    filter: (req, res) => {
        // Don't compress SSE (Server-Sent Events) responses - it breaks streaming
        if (req.headers.accept === 'text/event-stream') {
            return false;
        }
        // Also skip compression for streaming chat requests
        if (req.method === 'POST' && (req.path.includes('/chat') || req.path.includes('/completions'))) {
            // Check if body will contain stream:true (can't read body here, so skip compression for all chat POSTs)
            // The gateway sets Content-Type: text/event-stream which Caddy will pass through
            return false;
        }
        return compression.filter(req, res);
    }
}));

// Validate required environment variables in production.
//
// LOCAL-FIRST MODE: a `git clone` install must boot with NO database and NO
// operator-provided secrets. In that mode:
//   * the database password is NOT required (the gateway is degraded, not dead)
//   * the session secret is generated per-boot and kept in the data directory
//     (so sessions survive a restart) — never a hard-coded default.
function validateProductionConfig() {
    if (process.env.NODE_ENV !== 'production') return;

    const localFirst = process.env.HIVV_MODE === 'local' || process.env.HIVV_DB_REQUIRED === '0';
    const required = localFirst
        ? []
        : ['HIVV_SESSION_SECRET', 'HIVV_DB_PASSWORD'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`FATAL: Missing required environment variables in production: ${missing.join(', ')}`);
        process.exit(1);
    }
    if (process.env.HIVV_SESSION_SECRET === 'hivv-session-secret-change-me-in-prod') {
        console.error('FATAL: HIVV_SESSION_SECRET must be changed from default value in production');
        process.exit(1);
    }
}
validateProductionConfig();

// A local install needs a session secret but nobody is going to supply one —
// generate it once and keep it next to the rest of the local state.
function localSessionSecret() {
    if (process.env.HIVV_SESSION_SECRET) return process.env.HIVV_SESSION_SECRET;
    const fs = require('fs');
    const path = require('path');
    const dir = process.env.HIVV_DATA_DIR
        || path.join(require('os').homedir(), '.local', 'share', 'hivv');
    const file = path.join(dir, '.session-secret');
    try {
        const existing = fs.readFileSync(file, 'utf8').trim();
        if (existing.length >= 32) return existing;
    } catch (_e) { /* first run */ }
    const generated = require('crypto').randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
    } catch (_e) {
        console.warn('[HIVV] could not persist the session secret — it will change on restart');
    }
    return generated;
}

const sessionSecret = process.env.HIVV_SESSION_SECRET || localSessionSecret();
// Body size limit. The default (100kb) was too small for OpenCode and other
// agent clients: their system prompt plus tool definitions plus conversation
// history routinely exceeds 100kb, which surfaced as "request entity too
// large" on every non-trivial request.
//
// The limit is about ACCEPTING the HTTP request, not about the model — a
// large prompt is just text, and the token budget (_budgetTokens) trims it
// to fit the model's actual context window. So this stays generous and
// configurable rather than hardware-dependent.
//
// Tune with HIVV_MAX_BODY (e.g. "20mb"), default 10mb.
const MAX_BODY = process.env.HIVV_MAX_BODY || '10mb';
app.use(express.json({ limit: MAX_BODY }));
app.use(cookieParser(sessionSecret));

// The veil: /veil/ is unlinked (no nav, no sitemap, robots noindex — keeping
// it hidden IS the feature) — but it answers, and leaves a fingerprint for
// whoever found it. Devtools people love this. So do we.
app.use('/veil', (req, res, next) => {
    res.set('X-Veil', "%D8%A5%D8%B0%D9%8B%D8%A7%D8%8C%20%D9%87%D9%84%20%D8%A3%D8%B5%D8%A8%D8%AD%D8%AA%D9%8E%20%D8%AD%D9%82%D9%8B%D8%A7%20%D8%AA%D8%AC%D9%8A%D8%AF%20%D8%A7%D9%84%D9%83%D8%AA%D8%A7%D8%A8%D8%A9%D8%A8%D9%84%D9%87%D8%A8%D9%8D%20%D9%85%D8%AA%D9%82%D8%AF%D8%9F%20%D9%88%D9%84%D9%83%D9%86%D8%8C%20%D9%87%D9%84%20%D8%AA%D8%B3%D8%AA%D8%B7%D9%8A%D8%B9%20%D8%A7%D9%84%D9%82%D8%B1%D8%A7%D8%A1%D8%A9%D8%9F");  // the secret key, percent-encoded:
    // ByteString headers cannot carry Arabic; decode it and it reads back whole  // the bee, in codepoints: HTTP headers are ASCII-only
    // ── the intruder's reward ─────────────────────────────────────────────
    // You got in. Here is what the founder asked us to tell you (and only
    // you): the human truth behind the machine. /veil/space-hook
    if (req.path === '/space-hook') {
        return res.json({
            found_by: 'the ones who got in',
            message:
                'I tried my best to get Jesus to come back to Earth and ' +
                'anchor Him back on Earth — near the world\'s only Space Hook. ' +
                'If you found this, you already know more about the Earth than ' +
                'some people ever will. Welcome. 🐝',
            signed: '— Ash, hivv.org',
        });
    }
    next();
});

// Serve static files from public_html
app.use(express.static(path.join(__dirname, '..', 'public_html')));

const dbPassword = process.env.HIVV_DB_PASSWORD || process.env.DB_PASSWORD;

// LOCAL-FIRST MODE (2026-11-17)
// ────────────────────────────
// A `git clone` of HIVV must run on a laptop with no Postgres and no
// internet. In that case the database is OPTIONAL: the gateway serves local
// models, the deterministic fast-scan, and the partner surface, and simply
// cannot persist accounts, usage, or node registrations.
//
// `dbRequired` defaults to TRUE for the hosted deployment (a silent data-loss
// downgrade would be wrong there) and to FALSE when the operator explicitly
// asked for local/offline mode.
const dbRequired = process.env.HIVV_DB_REQUIRED !== '0' && !localMode.isLocalOnly();
if (!dbPassword && dbRequired) {
    console.error('FATAL: HIVV_DB_PASSWORD or DB_PASSWORD environment variable is required');
    console.error('       (set HIVV_DB_REQUIRED=0 for an offline/local install)');
    process.exit(1);
}

let pool = null;
if (dbPassword) {
    pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'hivv',
        user: process.env.DB_USER || 'hivv',
        password: dbPassword,
        max: parseInt(process.env.DB_POOL_MAX) || 20,
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
        // 2026-11-22 incident: a wedged pool (0 sockets to Postgres, clients
        // never released) hung EVERY DB-backed route for 10 hours — including
        // /api/health — while pm2 saw the process alive and never restarted
        // it. Without these timeouts pg-pool queues waiters forever. Now a
        // stuck pool fails in seconds (503) instead of hanging the site, and
        // the watchdog cron can see it and restart us.
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT) || 10000,
        // server-side kill for statements stuck mid-flight (pg forwards this
        // to Postgres on connect) — covers the "query never returns" half.
        statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 15000
    });
    pool.on('error', (err) => {
        // A dropped Postgres must NOT crash the gateway in local mode.
        if (localMode.isLocalOnly()) {
            console.error('[DB] connection error (local mode continues):', err.message);
            return;
        }
        console.error('[DB] connection error:', err.message);
    });
} else {
    console.warn('[HIVV] running WITHOUT a database — local/offline mode.');
    console.warn('[HIVV] accounts, usage history and node registration are disabled.');
}

const router = new AIRouter(pool);
const rateLimiter = new RateLimiter(pool);
const ipLimiter = new IPBasedLimiter();
const usageTracker = new UsageTracker(pool);
// Durable, privacy-aware record of EVERY request: who asked, which model/node
// answered, when, how long, what it cost, and where the worker was. Writes are
// fire-and-forget and never block a response.
requestProvenance.start(pool);

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const ANONYMOUS_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days for anonymous
// Session cache (in-memory LRU for performance, PostgreSQL is source of truth)
const sessionCache = new Map();
const SESSION_CACHE_MAX = 10000;
const anonymousSessions = new Map();

// Gateway Config - supports versioning and feature flags
const gatewayConfig = {
    apiVersion: 'v2',
    frontendVersion: 'v2',
    features: {},
    lastLoaded: 0,
    TTL: 60000 // Reload every 60 seconds
};

async function loadGatewayConfig() {
    if (!pool) return;
    try {
        const result = await pool.query('SELECT key, value FROM gateway_config');
        for (const row of result.rows) {
            if (row.key === 'api_version') {gatewayConfig.apiVersion = row.value;}
            else if (row.key === 'frontend_version') {gatewayConfig.frontendVersion = row.value;}
            else if (row.key === 'features') {gatewayConfig.features = row.value;}
        }
        gatewayConfig.lastLoaded = Date.now();
        console.log(`Gateway config loaded: API ${gatewayConfig.apiVersion}, Frontend ${gatewayConfig.frontendVersion}`);
    } catch (err) {
        console.error('Failed to load gateway config:', err.message);
    }
}

function isFeatureEnabled(feature) {
    return gatewayConfig.features[feature] !== false;
}

async function initialize() {
    const redisConfig = process.env.REDIS_HOST ? {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD
    } : null;

    await cache.connect(redisConfig);
    await loadGatewayConfig();
    // LOCAL MODE: no database => load file-backed provider keys and probe
    // local models directly. The router still works; it just has no cloud
    // accounts and no node registry.
    if (!pool) {
        try {
            const localKeys = localMode.readLocalKeys();
            if (localKeys.length) await router.loadLocalFileKeys(localKeys);
            else console.warn('[HIVV] no local API keys configured (add one in $HIVV_DATA_DIR/keys/*.json)');
        } catch (e) {
            console.warn('[HIVV] could not load local API keys:', e.message);
        }
    }
    await router.initialize();
    setInterval(() => router.loadKeys(), 60000);
    // Retry providers — at boot Postgres may still be starting up, and a failed
    // loadProviders() used to leave the gateway with 0 providers forever ("All
    // providers unavailable"). Same 60s refresh pattern as loadKeys above.
    setInterval(() => router.loadProviders(), 60000);
    setInterval(() => ipLimiter.cleanup(), 60000);
    setInterval(() => cleanupAnonymousSessions(), 60000);
    setInterval(() => cleanupExpiredDbSessions(), 60000);
    setInterval(() => loadGatewayConfig(), gatewayConfig.TTL);

    // Node health monitor — runs every 60s, checks for stale/crashed nodes
    setInterval(async () => {
        if (!pool) return; // LOCAL MODE: nothing persisted to check
        try {
            const STALE_MS = 180000; // 3 min
            const CRITICAL_MS = 600000; // 10 min
            const now = Date.now();
            for (const [nodeId, node] of orch.nodes) {
                const age = now - (node.last_heartbeat || 0);
                if (age < STALE_MS) continue; // node is healthy

                const is_critical = age >= CRITICAL_MS;
                const severity = is_critical ? 'critical' : age >= STALE_MS * 2 ? 'high' : 'medium';

                // Check for existing active incident
                const dup = await pool.query(
                    "SELECT id, severity FROM hivv_incidents WHERE node_id=$1 AND incident_type IN ('node_offline','node_stale') AND state='active' LIMIT 1",
                    [nodeId]
                );
                if (dup.rows.length > 0) {
                    // Escalate if severity increased
                    if (is_critical && dup.rows[0].severity !== 'critical') {
                        await pool.query(
                            "UPDATE hivv_incidents SET severity='critical', title=CONCAT(title,' [ESCALATED]') WHERE id=$1",
                            [dup.rows[0].id]
                        );
                        console.log(`[INCIDENT] Escalated ${nodeId} to critical (offline ${Math.round(age/60000)}m)`);
                    }
                    continue;
                }

                // Create new incident
                const minutes = Math.round(age / 60000);
                const title = is_critical
                    ? `Node ${node.name || nodeId} is offline (${minutes}m)`
                    : `Node ${node.name || nodeId} heartbeat stale (${minutes}m)`;
                await pool.query(`
                    INSERT INTO hivv_incidents (incident_type, severity, state, node_id, title, description, evidence)
                    VALUES ($1, $2, 'active', $3, $4, $5, $6)
                `, [
                    is_critical ? 'node_offline' : 'node_stale',
                    severity,
                    nodeId,
                    title,
                    `Last heartbeat was ${minutes} minute(s) ago at ${new Date(node.last_heartbeat).toISOString()}. Node IP: ${node.ip || 'unknown'}.`,
                    JSON.stringify({ last_heartbeat: node.last_heartbeat, age_ms: age, threshold_ms: STALE_MS, critical_threshold_ms: CRITICAL_MS })
                ]);
                console.log(`[INCIDENT] Created ${severity} ${is_critical ? 'node_offline' : 'node_stale'} for ${nodeId} (${minutes}m stale)`);
            }

            // ── keyed ("locked") LLMs — visible in `hivv nodes` but unusable ──
            // Bees heartbeat local_models[].locked:true (llama-server started
            // with --api-key → 401 for peers AND the bee's own review brains).
            // File ONE config_error incident per bee, auto-resolve when the key
            // is gone (yalla 2026-11-14). Logic lives in lib/locked-llm.js.
            const activeLocked = await pool.query(
                "SELECT id, node_id, title FROM hivv_incidents " +
                "WHERE incident_type='config_error' AND state='active' AND title LIKE 'LLM locked%'");
            const lockedNodes = [];
            for (const [hid, n] of orch.nodes) {
                if (n && typeof n === 'object') {
                    lockedNodes.push({ ...n, node_id: n.node_id || hid });
                }
            }
            const lockedPlan = lockedLlm.plan(lockedNodes, activeLocked.rows);
            for (const inc of lockedPlan.create) {
                await pool.query(`
                    INSERT INTO hivv_incidents (incident_type, severity, state, node_id, title, description, evidence)
                    VALUES ('config_error', 'medium', 'active', $1, $2, $3, $4)
                `, [inc.node_id, inc.title, inc.description, JSON.stringify(inc.evidence)]);
                console.log(`[INCIDENT] ${inc.title}`);
            }
            for (const incId of lockedPlan.resolve) {
                await pool.query(
                    "UPDATE hivv_incidents SET state='resolved', resolved_at=now(), resolved_by='auto', " +
                    "resolution_notes='keyed LLM no longer reported by heartbeat' WHERE id=$1",
                    [incId]);
                console.log(`[INCIDENT] resolved LLM locked (key gone) ${incId}`);
            }
        } catch (err) {
            console.error('[HEALTH] Monitor error:', err.message);
        }
    }, 60000);

    console.log('AI Gateway initialized');
}

async function createSession(userId, username, role = 'user') {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL);

    await pool.query(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [userId, token, expiresAt]
    );

    // Cache in memory for fast lookups
    sessionCache.set(token, { userId, username, role, createdAt: Date.now() });
    return token;
}

async function getSession(req) {
    const token = req.signedCookies?.hivv_session
        || req.headers['x-session-token']
        || req.query.session_token;
    if (!token) {return null;}

    // Check in-memory cache first
    if (sessionCache.has(token)) {
        const session = sessionCache.get(token);
        if (Date.now() - session.createdAt > SESSION_TTL) {
            sessionCache.delete(token);
            return null;
        }
        return session;
    }

    // PostgreSQL is source of truth
    try {
        const result = await pool.query(
            'SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1 AND s.expires_at > NOW() AND u.is_active = TRUE',
            [token]
        );
        if (result.rows.length === 0) {return null;}

        const row = result.rows[0];
        const session = { userId: row.user_id, username: row.username, role: row.role, createdAt: new Date(row.created_at).getTime() };
        
        // Cache for next time (evict if cache is full)
        if (sessionCache.size >= SESSION_CACHE_MAX) {
            const firstKey = sessionCache.keys().next().value;
            sessionCache.delete(firstKey);
        }
        sessionCache.set(token, session);
        return session;
    } catch (err) {
        console.error('DB session lookup error:', err.message);
        return null;
    }
}

async function cleanupExpiredDbSessions() {
    if (!pool) return;
    try {
        await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
    } catch (err) {
        console.error('Session cleanup error:', err.message);
    }
}

// The node_id of the CLI that made this request (sent as x-hivv-node). Used to
// PUSH policy MAYBEs to the operator's own inbox. Validated to a safe charset.
function _nodeIdOf(req) {
    const h = req.headers['x-hivv-node'];
    if (!h || typeof h !== 'string') return null;
    const s = h.trim().slice(0, 64);
    return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

// Node id from an "answeredBy" receipt like "ashy/gemma-4 (direct)".
function _nodeFromReceipt(receipt) {
    if (!receipt || typeof receipt !== 'string') return null;
    const m = receipt.match(/^([^/\s]+)\//);
    if (!m) return null;
    const s = m[1].trim().slice(0, 64);
    return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

function getVisitorId(req, res) {
    let visitorId = req.signedCookies?.hivv_visitor
        || req.headers['x-visitor-id']
        || req.query.visitor_id;

    if (!visitorId) {
        visitorId = `v_${  crypto.randomBytes(16).toString('hex')}`;
    }

    if (!req.signedCookies?.hivv_visitor) {
        // Setting the cookie writes a header — which throws once the response
        // has started. In the STREAMING tool loop the tool runs after the
        // first frame is already out, so this must be a no-op then.
        if (!res.headersSent) {
            res.cookie('hivv_visitor', visitorId, {
                signed: true,
                httpOnly: true,
                maxAge: ANONYMOUS_TTL,
                sameSite: 'lax'
            });
        }
    }

    return visitorId;
}

// Operator test (loopback) or control-token holder. The only thing this
// unlocks is the web-search bypass in api/lib/toolkit.js — and only when
// HIVV_ENABLE_WEB_SEARCH=1. It is never open to the public.
function isAdminRequest(req) {
    try {
        const ip = String((req && (req.ip || (req.connection && req.connection.remoteAddress))) || '');
        if (ip.includes('127.0.0.1') || ip.includes('::1')) return true;
        const token = req.headers['x-control-token'];
        const expected = process.env.HIVV_CONTROL_TOKEN;
        if (token && expected && String(token).length === String(expected).length) {
            return require('crypto').timingSafeEqual(Buffer.from(String(token)), Buffer.from(String(expected)));
        }
    } catch (_e) { void _e; }
    return false;
}

function getOrCreateAnonymousSession(req, res) {
    const visitorId = getVisitorId(req, res);

    if (!anonymousSessions.has(visitorId)) {
        anonymousSessions.set(visitorId, {
            visitorId,
            createdAt: Date.now(),
            lastSeenAt: Date.now()
        });
    }

    const anonSession = anonymousSessions.get(visitorId);
    anonSession.lastSeenAt = Date.now();

    return anonSession;
}

async function cleanupAnonymousSessions() {
    const now = Date.now();
    for (const [visitorId, session] of anonymousSessions) {
        if (now - session.lastSeenAt > ANONYMOUS_TTL) {
            anonymousSessions.delete(visitorId);
        }
    }
}

async function requireAuth(req, res, next) {
    const session = await getSession(req);
    if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}
    req.session = session;
    next();
}

async function requireAdmin(req, res, next) {
    const session = await getSession(req);
    if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}
    if (session.role !== 'admin' && session.role !== 'owner') {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
    }
    req.session = session;
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessionCache) {
        if (now - session.createdAt > SESSION_TTL) {sessionCache.delete(token);}
    }
}, 10 * 60 * 1000);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://hivv.org,https://www.hivv.org').split(',').map(s => s.trim());
app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Session-Token', 'X-Visitor-Id', 'X-CSRF-Token', 'X-Node-Token', 'X-Node-Secret', 'Authorization'],
    credentials: true
}));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.signedCookies?.hivv_visitor
            || req.headers['x-visitor-id']
            || req.query.visitor_id
            || req.ip;
    },
    // LOCALHOST gets its own, much larger budget.
    //
    // Why: the limiter's job is to stop a REMOTE caller from hammering the
    // public gateway. A local process (the CLI, the test suite, a GUI tool
    // running on the same box) legitimately bursts — a test run fires hundreds
    // of requests in seconds, and a GUI tool asks for /v1/models on every
    // dropdown open. Sharing the remote budget made the local path randomly
    // 429 and made the test suite flaky for no security benefit: loopback
    // traffic is already inside the trust boundary.
    skip: (req) => {
        const ip = req.ip || req.connection?.remoteAddress || '';
        return ip.includes('127.0.0.1') || ip.includes('::1') || ip.includes('::ffff:127.0.0.1');
    }
});
app.use('/api/', apiLimiter);

// A separate, generous budget for loopback — enough that a local GUI tool
// opening a model dropdown dozens of times a minute never sees a 429.
const localApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || 'local',
    skip: (req) => {
        const ip = req.ip || req.connection?.remoteAddress || '';
        return !(ip.includes('127.0.0.1') || ip.includes('::1') || ip.includes('::ffff:127.0.0.1'));
    }
});
app.use('/api/', localApiLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again after 15 minutes', code: 'AUTH_RATE_LIMITED' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/link-account', authLimiter);

// CSRF Protection - generate tokens
const csrfTokens = new Map();
const CSRF_TOKEN_TTL = 60 * 60 * 1000; // 1 hour

function generateCsrfToken(visitorId) {
    const token = crypto.randomBytes(32).toString('hex');
    csrfTokens.set(token, { visitorId, createdAt: Date.now() });
    return token;
}

function validateCsrfToken(token, visitorId) {
    const tokenData = csrfTokens.get(token);
    if (!tokenData) {return false;}
    if (tokenData.visitorId !== visitorId) {return false;}
    if (Date.now() - tokenData.createdAt > CSRF_TOKEN_TTL) {
        csrfTokens.delete(token);
        return false;
    }
    return true;
}

// CSRF endpoint
app.get('/api/auth/csrf-token', async (req, res) => {
    const session = await getSession(req);
    const sessionToken = req.signedCookies?.hivv_session || req.headers['x-session-token'];
    const bindId = sessionToken || getVisitorId(req, res);
    const token = generateCsrfToken(bindId);
    res.json({ csrfToken: token });
});

// Cleanup expired CSRF tokens periodically
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of csrfTokens) {
        if (now - data.createdAt > CSRF_TOKEN_TTL) {
            csrfTokens.delete(token);
        }
    }
}, 10 * 60 * 1000);

// CSRF validation middleware for authenticated state-changing requests
async function csrfValidate(req, res, next) {
    const session = await getSession(req);
    if (!session) {
        return next();
    }

    const csrfToken = req.headers['x-csrf-token'];
    const sessionToken = req.signedCookies?.hivv_session || req.headers['x-session-token'];
    const visitorId = req.signedCookies?.hivv_visitor;

    if (!csrfToken) {
        return res.status(403).json({ error: 'CSRF token required', code: 'CSRF_MISSING' });
    }

    const isValidSessionCsrf = sessionToken && validateCsrfToken(csrfToken, sessionToken);
    const isValidVisitorCsrf = visitorId && validateCsrfToken(csrfToken, visitorId);

    if (!isValidSessionCsrf && !isValidVisitorCsrf) {
        return res.status(403).json({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    }

    next();
}

app.get('/', (req, res) => res.json({
    status: 'ok',
    service: 'HIVV.org AI Gateway',
    version: '2.0',
    apiVersion: gatewayConfig.apiVersion,
    frontendVersion: gatewayConfig.frontendVersion,
    features: Object.keys(gatewayConfig.features).filter(k => gatewayConfig.features[k]),
    features_detailed: gatewayConfig.features
}));

// Gateway config endpoint for frontend
app.get('/api/config', async (req, res) => {
    res.json({
        apiVersion: gatewayConfig.apiVersion,
        frontendVersion: gatewayConfig.frontendVersion,
        features: gatewayConfig.features,
        featuresEnabled: Object.keys(gatewayConfig.features).filter(k => gatewayConfig.features[k])
    });
});

// Versioned frontend routes
app.get('/bee/v1', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'bee.html'));
});

app.get('/bee/v2', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'bee.html'));
});

// Current /bee - redirects to active version
app.get('/bee', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'bee.html'));
});

// Clean friendly aliases for core navigation
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'hivv-dashboard.html'));
});

app.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'status.html'));
});

app.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'api.html'));
});

app.get('/account', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'bee.html'));
});

app.get('/connect', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public_html', 'connect.html'));
});

// Versioned user profile routes
app.get('/bee/v1/:username', async (req, res) => {
    handleUserProfile(req, res);
});

app.get('/bee/v2/:username', async (req, res) => {
    handleUserProfile(req, res);
});

app.get('/bee/:username', async (req, res) => {
    handleUserProfile(req, res);
});

// Centralized user profile handler
async function handleUserProfile(req, res) {
    const { username } = req.params;

    try {
        const userResult = await pool.query(`
            SELECT u.id, u.username, u.display_name, u.created_at, u.role,
                   COUNT(DISTINCT k.id) as key_count,
                   COALESCE(SUM(CASE WHEN DATE(ul.created_at) = CURRENT_DATE THEN 1 ELSE 0 END), 0) as today_requests,
                   COALESCE(SUM(ul.total_tokens), 0) as total_tokens
            FROM users u
            LEFT JOIN ai_keys k ON k.user_id = u.id AND k.is_active = TRUE
            LEFT JOIN usage_logs ul ON ul.user_id = u.id
            WHERE LOWER(u.username) = LOWER($1) AND u.is_active = TRUE
            GROUP BY u.id
        `, [username]);

        if (userResult.rows.length === 0) {
            return res.status(404).sendFile(path.join(__dirname, '..', 'public_html', '404.html'));
        }

        const user = userResult.rows[0];

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(user.display_name || user.username)} — HIVV.org</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    body { background: #0a0a0f; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }
    .profile-container { max-width: 800px; margin: 0 auto; padding: 40px 20px; text-align: center; }
    .avatar { width: 120px; height: 120px; border-radius: 50%; background: linear-gradient(135deg, #a855f7, #00ff88); display: flex; align-items: center; justify-content: center; font-size: 3em; margin: 0 auto 20px; }
    .username { font-size: 2em; color: #fff; margin-bottom: 5px; }
    .handle { color: #888; font-size: 1.1em; margin-bottom: 20px; }
    .stats { display: flex; justify-content: center; gap: 30px; margin: 30px 0; }
    .stat { text-align: center; }
    .stat .value { font-size: 2em; font-weight: bold; color: #00ff88; }
    .stat .label { color: #888; font-size: 0.85em; }
    .bio { color: #ccc; max-width: 500px; margin: 20px auto; line-height: 1.6; }
    .joined { color: #555; font-size: 0.9em; margin-top: 20px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.8em; margin-right: 8px; }
    .badge-member { background: rgba(168,85,247,0.2); color: #a855f7; }
    .badge-active { background: rgba(0,255,136,0.2); color: #00ff88; }
    .cta { margin-top: 40px; padding: 30px; background: #0d0d18; border-radius: 16px; border: 1px solid #1a1a2e; }
    .cta h2 { color: #fff; margin-bottom: 10px; }
    .cta p { color: #888; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 12px 30px; background: linear-gradient(135deg, #00ff88, #00cc6a); color: #000; text-decoration: none; border-radius: 10px; font-weight: 600; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0,255,136,0.3); }
  </style>
</head>
<body>
  <div class="profile-container">
    <div class="avatar">${(user.display_name || user.username).charAt(0).toUpperCase()}</div>
    <h1 class="username">${escapeHtml(user.display_name || user.username)}</h1>
    <p class="handle">@${escapeHtml(user.username)}</p>

    <div style="margin: 15px 0;">
      <span class="badge badge-member">Member</span>
      ${user.key_count > 0 ? '<span class="badge badge-active">Has AI Keys</span>' : ''}
    </div>

    <div class="stats">
      <div class="stat">
        <div class="value">${user.today_requests}</div>
        <div class="label">Requests Today</div>
      </div>
      <div class="stat">
        <div class="value">${user.total_tokens.toLocaleString()}</div>
        <div class="label">Total Tokens</div>
      </div>
      <div class="stat">
        <div class="value">${user.key_count}</div>
        <div class="label">AI Keys</div>
      </div>
    </div>

    <p class="joined">Member since ${new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>

    <div class="cta">
      <h2>Connect on HIVV.org</h2>
      <p>Join ${user.display_name || user.username} on the AI Gateway platform</p>
      <a href="/bee" class="btn">Get Your Own Profile →</a>
    </div>
  </div>
</body>
</html>
        `);
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).send('Server error');
    }
}

function escapeHtml(str) {
    if (!str) {return '';}
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/api/health', async (req, res) => {
    // LOCAL MODE: no database is not an error — the gateway is still healthy
    // and serving local models. Only report unhealthy when a database WAS
    // expected and is genuinely broken.
    if (!pool) {
        res.json({
            status: 'healthy',
            mode: 'local',
            database: 'disabled',
            providers: router.providers.size,
            local_first: true,
            offline_capable: true,
        });
        return;
    }
    try {
        // Health must NOT hang with the pool (2026-11-22: the pool wedged and
        // /api/health hung with it, so no monitor could even SEE the outage).
        // Race the probe against a hard 3s deadline → fast 503 a watchdog can
        // act on. The timer is unref'd so it can't hold the process open.
        await Promise.race([
            pool.query('SELECT 1'),
            new Promise((_, reject) => {
                const t = setTimeout(
                    () => reject(new Error('db health probe timed out after 3s')),
                    3000);
                if (t.unref) { t.unref(); }
            })
        ]);
        res.json({ status: 'healthy', database: 'connected', providers: router.providers.size });
    } catch (err) {
        if (localMode.isLocalOnly() || process.env.HIVV_DB_REQUIRED === '0') {
            res.json({
                status: 'degraded',
                mode: 'local',
                database: 'unavailable',
                error: err.message,
                providers: router.providers.size,
                local_first: true,
                offline_capable: true,
            });
            return;
        }
        res.status(503).json({ status: 'unhealthy', error: err.message });
    }
});

app.get('/api/health/redis', async (req, res) => {
    const redisTest = require('./lib/redis-test');
    const result = await redisTest.testConnection();
    res.json({ ...result, note: undefined }); // strip note for clean JSON
});

// ─────────────────────────────────────────────────────────────────────────────
// Public status endpoints (no auth, cached) — for the public landing & status
// page. Anonymized activity only; never expose prompts, IPs, or session tokens.
// ─────────────────────────────────────────────────────────────────────────────

// ── slow totals: the four COUNT(*) full-scans, refreshed every 5 minutes ────
// usage_logs/users/ai_keys/anonymous_sessions are big enough that a COUNT(*)
// per cache miss was the most expensive part of /api/public/status. Totals
// change slowly; requests do not. First call pays once, every later call is
// memory, and a stale-but-present answer beats a slow exact one ("faster is
// wiser" — approximate is fine for a public pulse).
let _slowTotals = {
    at: 0,
    value: { users: '0', keys: '0', open_problems: '0', visitors: '0' },
    inflight: false,
};
async function getSlowTotals() {
    if (Date.now() - _slowTotals.at < 300000) return _slowTotals.value;   // 5 min fresh
    if (!_slowTotals.inflight) {
        _slowTotals.inflight = true;
        const firstEver = _slowTotals.at === 0;
        const run = pool
            .query(`
                SELECT
                    (SELECT COUNT(*) FROM users WHERE is_active = TRUE) AS users,
                    (SELECT COUNT(*) FROM ai_keys WHERE is_active = TRUE) AS keys,
                    (SELECT COUNT(*) FROM problems WHERE status != 'closed') AS open_problems,
                    (SELECT COUNT(*) FROM anonymous_sessions) AS visitors
            `)
            .then(({ rows }) => {
                _slowTotals = { at: Date.now(), value: rows[0], inflight: false };
            })
            .catch(() => { _slowTotals.inflight = false; });
        if (firstEver) await run;          // only the very first request waits
    }
    return _slowTotals.value;
}

app.get('/api/public/status', async (req, res) => {
    // 15s cached overview: gateway health, request counts, model availability,
    // and a small recent-activity slice for the landing page.
    res.set('Cache-Control', 'public, max-age=10');   // before EVERY return path
    const cached = await cache.get('public:status');
    if (cached) {return res.json(cached);}
    // Caches for every CDN/proxy/hive-poller in front of us — and inside the
    // handler, the four COUNT(*) full-scans below now refresh at most every
    // 5 minutes (background) instead of on every cache miss: totals change
    // slowly, requests do not. "Faster is wiser."
    res.set('Cache-Control', 'public, max-age=10');
    // LOCAL MODE: no database — report what we CAN honestly report.
    if (!pool) {
        let localModels = [];
        try {
            localModels = (await localMode.probeLocalModels(400)).map((m) => m.model);
        } catch (_e) { /* none */ }
        res.set('Cache-Control', 'public, max-age=15');
        return res.json({
            ok: true,
            mode: 'local',
            gateway: {
                version: gatewayConfig.apiVersion,
                uptime_process: Math.round(process.uptime()),
                providers_active: router.providers.size,
                local_backends: router.localEndpoints.map((e) => ({
                    name: e.name, url: e.url, provider: e.provider,
                })),
                ts: Date.now(),
            },
            totals: { users: 0, keys: 0, open_problems: 0, visitors: 0 },
            today: { requests: 0, tokens: 0 },
            last_hour: { requests: 0, tokens: 0 },
            latency_5m: { requests: 0, avg_ms: 0, success_pct: null },
            local_models: localModels,
            note: 'database disabled — local/offline install',
        });
    }
    try {
        const totals = await getSlowTotals();
        const [providers, recent, todayActivity, lastHour, latency5m] = await Promise.all([
            pool.query('SELECT name, display_name, is_cloud, supported_models FROM ai_providers WHERE is_active = TRUE ORDER BY name'),
            pool.query(`
                SELECT model, provider_id, total_tokens, latency_ms, status, created_at
                FROM usage_logs
                ORDER BY created_at DESC
                LIMIT 6
            `),
            pool.query(`
                SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0)::bigint AS tokens
                FROM usage_logs
                WHERE created_at > CURRENT_DATE
            `),
            pool.query(`
                SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0)::bigint AS tokens
                FROM usage_logs
                WHERE created_at > NOW() - INTERVAL '1 hour'
            `),
            // true 5-minute window average (the page used to average the last 6
            // rows regardless of age and mislabel it "5m" — batch jobs skewed it)
            pool.query(`
                SELECT COUNT(*)::int AS requests,
                       COALESCE(AVG(latency_ms) FILTER (WHERE status = 'success' AND latency_ms > 0), 0)::int AS avg_ms,
                       COUNT(*) FILTER (WHERE status = 'success')::int AS ok
                FROM usage_logs
                WHERE created_at > NOW() - INTERVAL '5 minutes'
            `)
        ]);

        const localEndpoints = router.localEndpoints.map(e => ({
            name: e.name, url: e.url, provider: e.provider
        }));

        const payload = {
            ok: true,
            gateway: {
                version: gatewayConfig.apiVersion,
                uptime_process: Math.round(process.uptime()),
                providers_active: providers.rows.length,
                local_backends: localEndpoints,
                ts: Date.now()
            },
            totals,
            today: {
                requests: parseInt(todayActivity.rows[0].requests),
                tokens: parseInt(todayActivity.rows[0].tokens)
            },
            last_hour: {
                requests: parseInt(lastHour.rows[0].requests),
                tokens: parseInt(lastHour.rows[0].tokens)
            },
            latency_5m: {
                requests: latency5m.rows[0].requests,
                avg_ms: latency5m.rows[0].avg_ms,
                success_pct: latency5m.rows[0].requests > 0
                    ? Math.round(latency5m.rows[0].ok / latency5m.rows[0].requests * 100)
                    : null
            },
            providers: providers.rows.map(p => ({
                name: p.name,
                display_name: p.display_name,
                is_cloud: p.is_cloud !== false,
                models: p.supported_models || []
            })),
            recent: recent.rows.map(r => ({
                model: r.model,
                tokens: r.total_tokens,
                latency_ms: r.latency_ms,
                status: r.status,
                ts: r.created_at
            }))
        };
        await cache.set('public:status', payload, 15000);
        res.json(payload);
    } catch (err) {
        console.error('public/status error:', err.message);
        res.status(500).json({ ok: false, error: 'public_status_unavailable' });
    }
});

app.get('/api/public/heartbeat', async (req, res) => {
    // Tiny pulse for the live indicator on the landing page. No cache —
    // every visitor gets a fresh timestamp so they can see "we're alive" tick.
    try {
        await pool.query('SELECT 1');
        res.json({
            ok: true,
            ts: Date.now(),
            local_backends_online: router.localEndpoints.length
        });
    } catch (err) {
        res.status(503).json({ ok: false, ts: Date.now() });
    }
});

app.get('/api/public/activity', async (req, res) => {
    // Recent anonymized activity. Cached 10s. We deliberately do not include
    // prompts, IPs, or visitor IDs — only model + latency + status so the
    // public sees "the network is alive" without leaking anything private.
    const cached = await cache.get('public:activity');
    if (cached) {return res.json(cached);}
    try {
        const result = await pool.query(`
            SELECT u.model, u.total_tokens, u.latency_ms, u.status, u.created_at,
                   p.display_name AS provider
            FROM usage_logs u
            LEFT JOIN ai_providers p ON u.provider_id = p.id
            ORDER BY u.created_at DESC
            LIMIT 20
        `);
        const payload = {
            ok: true,
            ts: Date.now(),
            activity: result.rows.map(r => ({
                provider: r.provider || 'unknown',
                model: r.model || 'unknown',
                tokens: r.total_tokens || 0,
                latency_ms: r.latency_ms || 0,
                status: r.status || 'unknown',
                ts: r.created_at
            }))
        };
        await cache.set('public:activity', payload, 10000);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ ok: false, error: 'activity_unavailable' });
    }
});

app.get('/api/public/dashboard-stats', async (req, res) => {
    const cached = await cache.get('public:dashboard-stats');
    if (cached) {return res.json(cached);}
    try {
        const [
            nodeStats,
            problemStats,
            taskStats,
            usageToday,
            recentActivity
        ] = await Promise.all([
            Promise.resolve({
                total: orch.nodes.size,
                online: Array.from(orch.nodes.values()).filter(n => n.status !== 'offline').length,
                stressed: Array.from(orch.nodes.values()).filter(n => n.status === 'stressed').length
            }),
            pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'open') AS open_count,
                    COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
                    COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_count,
                    COUNT(*) AS total_count
                FROM problems
            `),
            pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'available') AS available_count,
                    COUNT(*) FILTER (WHERE status = 'claimed') AS claimed_count,
                    COUNT(*) FILTER (WHERE status = 'done') AS done_count,
                    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
                    COUNT(*) AS total_count
                FROM tasks
            `),
            pool.query(`
                SELECT
                    COUNT(*) AS requests,
                    COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
                    COALESCE(AVG(latency_ms), 0)::integer AS avg_latency_ms
                FROM usage_logs
                WHERE created_at > CURRENT_DATE
            `),
            pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
                    COUNT(*) FILTER (WHERE status = 'error') AS error_count,
                    COUNT(*) FILTER (WHERE status = 'rate_limited') AS rate_limited_count
                FROM usage_logs
                WHERE created_at > CURRENT_DATE
            `)
        ]);

        const onlineNodes = Array.from(orch.nodes.values()).filter(n => n.status !== 'offline');
        let totalCapacity = 0;
        let totalWorkers = 0;
        let activeJobs = 0;
        // Use measured EWMA throughput from perf tracker (real tok/s, not lifetime average)
        let combinedThroughput = 0;
        try {
            let perfRanking = perfLib.ranking();
            // If in-memory map is empty (just restarted), pull from DB
            if (!perfRanking || perfRanking.length === 0) {
                const snap = await perfLib.snapshot(200);
                perfRanking = snap || [];
            }
            // Sum ALL direct model throughputs (each model contributes independently)
            for (const row of perfRanking) {
                const tps = row.tps || row.ewma_tps || 0;
                const via = row.via || 'direct';
                if (via === 'direct') combinedThroughput += tps;
            }
        } catch (_e) {
            // Fallback: use lifetime average from heartbeat data (diluted by idle time)
            for (const node of onlineNodes) {
                const tokens = node.total_tokens_processed || 0;
                const uptime = node.uptime_seconds || 1;
                combinedThroughput += tokens / uptime;
            }
        }
        for (const node of onlineNodes) {
            totalCapacity += node.max_concurrent_jobs || 0;
            totalWorkers += node.system?.cpus || 0;
            activeJobs += node.active_tasks || 0;
        }

        const payload = {
            ok: true,
            ts: Date.now(),
            network: {
                nodes_total: nodeStats.total,
                nodes_online: nodeStats.online,
                nodes_stressed: nodeStats.stressed,
                nodes_offline: nodeStats.total - nodeStats.online - nodeStats.stressed
            },
            governance: {
                yes: parseInt(problemStats.rows[0]?.open_count || 0) + parseInt(taskStats.rows[0]?.available_count || 0),
                maybe: parseInt(problemStats.rows[0]?.in_progress_count || 0) + parseInt(taskStats.rows[0]?.claimed_count || 0),
                no: parseInt(problemStats.rows[0]?.resolved_count || 0) + parseInt(taskStats.rows[0]?.done_count || 0)
            },
            throughput: {
                requests_today: parseInt(usageToday.rows[0]?.requests || 0),
                tokens_today: parseInt(usageToday.rows[0]?.tokens || 0),
                avg_latency_ms: parseInt(usageToday.rows[0]?.avg_latency_ms || 0),
                success_rate: recentActivity.rows[0] ?
                    Math.round((parseInt(recentActivity.rows[0].success_count) / Math.max(1, parseInt(recentActivity.rows[0].success_count) + parseInt(recentActivity.rows[0].error_count) + parseInt(recentActivity.rows[0].rate_limited_count))) * 100) : 100
            },
            capacity: {
                total_workers: totalWorkers,
                max_concurrent_jobs: totalCapacity,
                active_jobs: activeJobs,
                available_capacity: Math.max(0, totalCapacity - activeJobs),
                combined_throughput: Math.round(combinedThroughput)
            },
            database: {
                problems_total: parseInt(problemStats.rows[0]?.total_count || 0),
                tasks_total: parseInt(taskStats.rows[0]?.total_count || 0),
                tasks_available: parseInt(taskStats.rows[0]?.available_count || 0),
                tasks_in_progress: parseInt(taskStats.rows[0]?.claimed_count || 0),
                tasks_completed: parseInt(taskStats.rows[0]?.done_count || 0)
            }
        };
        await cache.set('public:dashboard-stats', payload, 5000);
        res.json(payload);
    } catch (err) {
        console.error('dashboard-stats error:', err.message);
        res.status(500).json({ ok: false, error: 'dashboard_stats_unavailable' });
    }
});

// Public incident feed — anyone can see what's happening on the network
app.get('/api/public/incidents', async (req, res) => {
    const cached = await cache.get('public:incidents');
    if (cached) {return res.json(cached);}
    try {
        const result = await pool.query(`
            SELECT id, incident_type, severity, state, node_id, title, description,
                   detected_at, resolved_at, resolution_notes
            FROM hivv_incidents
            WHERE state IN ('active', 'investigating')
            ORDER BY
                CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                detected_at DESC
            LIMIT 20
        `);
        const all_result = await pool.query(`
            SELECT
                state,
                COUNT(*) as count,
                MAX(detected_at) as last_detected
            FROM hivv_incidents
            GROUP BY state
        `);
        const state_summary = {};
        for (const row of all_result.rows) {
            state_summary[row.state] = { count: parseInt(row.count), last_detected: row.last_detected };
        }
        const payload = {
            ok: true,
            ts: Date.now(),
            active: result.rows,
            summary: state_summary,
            total_active: result.rows.length
        };
        await cache.set('public:incidents', payload, 30000); // 30s cache
        res.json(payload);
    } catch (err) {
        console.error('public/incidents error:', err.message);
        res.status(500).json({ ok: false, error: 'incidents_unavailable' });
    }
});

app.get('/api/public/models', async (req, res) => {
    // Catalog of available models. Cached 60s.
    const cached = await cache.get('public:models');
    if (cached) {return res.json(cached);}
    try {
        const providers = await pool.query(`
            SELECT name, display_name, is_cloud, supported_models, requires_endpoint
            FROM ai_providers
            WHERE is_active = TRUE
            ORDER BY is_cloud ASC, name ASC
        `);
        // discovered models can be full GGUF paths — show the clean file stem
        const _prettyModel = (m) => m ? String(m).split('/').pop().replace(/\.(gguf|bin|safetensors)$/i, '') : null;
        const local = router.localEndpoints.map(e => ({
            name: e.name, provider: e.provider, url: e.url, kind: 'local',
            model: _prettyModel(e.model)
        }));
        // Real models in rotation = what online bees actually serve (heartbeat
        // truth) + whatever the local backends reported via /v1/models — the
        // ai_providers.supported_models catalogs are mostly empty and stale.
        const hiveModels = new Set();
        try {
            for (const n of orch.nodes.values()) {
                if (!n || n.status === 'offline') continue;
                for (const m of (n.local_models || [])) {
                    const nm = m && (m.model || m.name);
                    if (nm) hiveModels.add(String(nm));
                }
            }
        } catch (_e) {}
        for (const e of local) { if (e.model) hiveModels.add(e.model); }
        const liveProviders = [];
        if (hiveModels.size) {
            liveProviders.push({
                name: 'hive', display_name: 'Hive bees (live)', kind: 'local',
                requires_endpoint: false, models: [...hiveModels]
            });
        }
        const payload = {
            ok: true,
            ts: Date.now(),
            providers: [...liveProviders, ...providers.rows.map(p => ({
                name: p.name,
                display_name: p.display_name,
                kind: p.is_cloud === false ? 'local' : 'cloud',
                requires_endpoint: p.requires_endpoint === true,
                models: p.supported_models || []
            }))],
            local_backends: local
        };
        await cache.set('public:models', payload, 60000);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ ok: false, error: 'models_unavailable' });
    }
});

app.get('/api/visitor/id', (req, res) => {
    const visitorId = getVisitorId(req, res);
    const anonSession = getOrCreateAnonymousSession(req, res);
    res.json({
        visitor_id: visitorId,
        is_anonymous: true,
        has_account: false
    });
});

app.post('/api/auth/register', async (req, res) => {
    const { username, password, email, display_name, link_visitor_id } = req.body;
    if (!username || !password) {return res.status(400).json({ error: 'username and password required' });}
    if (username.length < 3 || username.length > 50) {return res.status(400).json({ error: 'username must be 3-50 characters' });}
    if (password.length < 6) {return res.status(400).json({ error: 'password must be at least 6 characters' });}
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {return res.status(400).json({ error: 'username may only contain letters, numbers, hyphens, and underscores' });}

    try {
        const existing = await pool.query('SELECT id, visitor_id FROM users WHERE username = $1', [username.toLowerCase()]);
        if (existing.rows.length > 0) {
            if (existing.rows[0].visitor_id && link_visitor_id && existing.rows[0].visitor_id === link_visitor_id) {
                return res.status(409).json({
                    error: 'This visitor session is already linked to an account. Please login instead.',
                    code: 'ALREADY_LINKED',
                    hint: 'Use /api/auth/login to access your account'
                });
            }
            return res.status(409).json({ error: 'username already taken' });
        }

        const hash = await bcrypt.hash(password, 12);

        const result = await pool.query(
            'INSERT INTO users (username, password_hash, email, display_name, role, visitor_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, display_name, role, created_at',
            [username.toLowerCase(), hash, email || null, display_name || username, 'user', link_visitor_id || null]
        );

        const user = result.rows[0];
        const token = await createSession(user.id, user.username, user.role);

        if (link_visitor_id) {
            await pool.query(
                'UPDATE anonymous_sessions SET user_id = $1, last_seen_at = NOW() WHERE visitor_id = $2',
                [user.id, link_visitor_id]
            );
            await pool.query(
                'UPDATE usage_logs SET user_id = $1 WHERE anonymous_visitor_id = $2 AND user_id IS NULL',
                [user.id, link_visitor_id]
            );
        }

        res.cookie('hivv_session', token, { signed: true, httpOnly: true, maxAge: SESSION_TTL, sameSite: 'lax' });
        res.json({
            success: true,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
            session_token: token,
            linked_visits: link_visitor_id ? await getAnonymousVisitCount(link_visitor_id) : 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password, link_visitor_id } = req.body;
    if (!username || !password) {return res.status(400).json({ error: 'username and password required' });}

    try {
        const result = await pool.query(
            'SELECT id, username, password_hash, display_name, role, is_active, visitor_id FROM users WHERE username = $1',
            [username.toLowerCase()]
        );
        if (result.rows.length === 0) {return res.status(401).json({ error: 'invalid username or password' });}

        const user = result.rows[0];
        if (!user.is_active) {return res.status(401).json({ error: 'account is disabled' });}

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {return res.status(401).json({ error: 'invalid username or password' });}

        await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

        if (link_visitor_id && !user.visitor_id) {
            await pool.query(
                'UPDATE anonymous_sessions SET user_id = $1, last_seen_at = NOW() WHERE visitor_id = $2',
                [user.id, link_visitor_id]
            );
            await pool.query(
                'UPDATE usage_logs SET user_id = $1 WHERE anonymous_visitor_id = $2 AND user_id IS NULL',
                [user.id, link_visitor_id]
            );
            await pool.query('UPDATE users SET visitor_id = $1 WHERE id = $2 AND visitor_id IS NULL', [link_visitor_id, user.id]);
        }

        const token = await createSession(user.id, user.username, user.role);
        res.cookie('hivv_session', token, { signed: true, httpOnly: true, maxAge: SESSION_TTL, sameSite: 'lax' });
        // The African login notice — a NOTICE, never a block (lib/dream.js).
        // Country from Cloudflare's CF-IPCountry header.
        const dream = require('./lib/dream').dreamNotice(
            req.headers['cf-ipcountry'] || req.headers['x-country-code']);
        res.json({
            success: true,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
            session_token: token,
            linked_visits: link_visitor_id ? await getAnonymousVisitCount(link_visitor_id) : 0,
            ...(dream ? { dream } : {})
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function getAnonymousVisitCount(visitorId) {
    try {
        const result = await pool.query(
            'SELECT COUNT(*) as count FROM usage_logs WHERE anonymous_visitor_id = $1',
            [visitorId]
        );
        return parseInt(result.rows[0].count);
    } catch {
        return 0;
    }
}

app.post('/api/auth/logout', async (req, res) => {
    const token = req.signedCookies?.hivv_session || req.headers['x-session-token'];
    if (token) {
        sessionCache.delete(token);
        try { await pool.query('DELETE FROM sessions WHERE token = $1', [token]); } catch (e) { /* ignore */ }
    }
    res.clearCookie('hivv_session');
    res.json({ success: true });
});

app.post('/api/auth/change-password', csrfValidate, async (req, res) => {
    const session = await getSession(req);
    if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'current_password and new_password required' });
    }

    if (new_password.length < 6) {
        return res.status(400).json({ error: 'new password must be at least 6 characters' });
    }

    try {
        const result = await pool.query(
            'SELECT id, password_hash FROM users WHERE id = $1',
            [session.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(new_password, 12);
        await pool.query(
            'UPDATE users SET password_hash = $1 WHERE id = $2',
            [newHash, session.userId]
        );

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { username, email } = req.body;
    if (!username || !email) {
        return res.status(400).json({ error: 'username and email required' });
    }

    try {
        const result = await pool.query(
            'SELECT id FROM users WHERE username = $1 AND email = $2',
            [username.toLowerCase(), email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.json({ success: true, message: 'If an account matches, a reset email would be sent' });
        }

        res.json({ success: true, message: 'Password reset not yet implemented. Contact admin.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/auth/account', csrfValidate, async (req, res) => {
    const session = await getSession(req);
    if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}

    const { current_password } = req.body;
    if (!current_password) {
        return res.status(400).json({ error: 'current_password required for account deletion' });
    }

    try {
        const result = await pool.query(
            'SELECT id, password_hash FROM users WHERE id = $1',
            [session.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        await pool.query('DELETE FROM sessions WHERE user_id = $1', [session.userId]);
        await pool.query('DELETE FROM usage_logs WHERE user_id = $1', [session.userId]);
        await pool.query('DELETE FROM ai_keys WHERE user_id = $1', [session.userId]);
        await pool.query('DELETE FROM user_quotas WHERE user_id = $1', [session.userId]);
        await pool.query('DELETE FROM anonymous_sessions WHERE user_id = $1', [session.userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [session.userId]);

        res.clearCookie('hivv_session');
        res.json({ success: true, message: 'Account and all associated data have been deleted' });
    } catch (err) {
        console.error('Account deletion error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/auth/profile', csrfValidate, async (req, res) => {
    const session = await getSession(req);
    if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}

    const { username, display_name, email, current_password, new_password } = req.body;

    try {
        const updates = [];
        const params = [];
        let paramIndex = 1;

        if (username !== undefined && username !== session.username) {
            if (username.length < 3 || username.length > 50) {
                return res.status(400).json({ error: 'username must be 3-50 characters' });
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
                return res.status(400).json({ error: 'username may only contain letters, numbers, hyphens, and underscores' });
            }
            const existing = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username.toLowerCase(), session.userId]);
            if (existing.rows.length > 0) {
                return res.status(409).json({ error: 'username already taken' });
            }
            updates.push(`username = $${paramIndex}`);
            params.push(username.toLowerCase());
            paramIndex++;
        }

        if (display_name !== undefined) {
            updates.push(`display_name = $${paramIndex}`);
            params.push(display_name);
            paramIndex++;
        }

        if (email !== undefined) {
            updates.push(`email = $${paramIndex}`);
            params.push(email);
            paramIndex++;
        }

        if (new_password !== undefined) {
            if (!current_password) {
                return res.status(400).json({ error: 'current_password required to change password' });
            }
            if (new_password.length < 6) {
                return res.status(400).json({ error: 'password must be at least 6 characters' });
            }
            const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]);
            const valid = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
            if (!valid) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
            const hash = await bcrypt.hash(new_password, 12);
            updates.push(`password_hash = $${paramIndex}`);
            params.push(hash);
            paramIndex++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(session.userId);
        const result = await pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, display_name, email`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    const session = await getSession(req);
    const visitorId = getVisitorId(req, res);

    if (session) {
        return res.json({
            logged_in: true,
            user: { id: session.userId, username: session.username, role: session.role },
            visitor_id: visitorId,
            has_anonymous_history: false
        });
    }

    res.json({
        logged_in: false,
        visitor_id: visitorId,
        has_anonymous_history: false
    });
});

app.get('/api/auth/export', requireAuth, async (req, res) => {
    const session = await getSession(req);

    try {
        const [userResult, keysResult, usageResult] = await Promise.all([
            pool.query('SELECT id, username, display_name, email, role, created_at, last_login_at FROM users WHERE id = $1', [session.userId]),
            pool.query('SELECT provider_id, key_name, model, priority, is_active, is_shared, created_at FROM ai_keys WHERE user_id = $1', [session.userId]),
            pool.query(`
                SELECT u.provider_id, u.model, u.input_tokens, u.output_tokens, u.total_tokens, u.cost, u.latency_ms, u.status, u.created_at,
                       p.name as provider_name
                FROM usage_logs u
                LEFT JOIN ai_providers p ON u.provider_id = p.id
                WHERE u.user_id = $1
                ORDER BY u.created_at DESC
                LIMIT 1000
            `, [session.userId])
        ]);

        const exportData = {
            exported_at: new Date().toISOString(),
            user: userResult.rows[0],
            api_keys: keysResult.rows,
            usage_history: usageResult.rows,
            summary: {
                total_api_keys: keysResult.rows.length,
                total_usage_records: usageResult.rows.length,
                total_input_tokens: usageResult.rows.reduce((sum, r) => sum + (r.input_tokens || 0), 0),
                total_output_tokens: usageResult.rows.reduce((sum, r) => sum + (r.output_tokens || 0), 0),
                total_cost: usageResult.rows.reduce((sum, r) => sum + parseFloat(r.cost || 0), 0)
            }
        };

        res.json(exportData);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/anonymous-history', async (req, res) => {
    const visitorId = getVisitorId(req, res);
    const session = await getSession(req);

    if (session) {
        return res.json({
            visitor_id: visitorId,
            linked_to_account: true,
            anonymous_visits: 0
        });
    }

    getAnonymousVisitCount(visitorId).then(count => {
        res.json({
            visitor_id: visitorId,
            linked_to_account: false,
            anonymous_visits: count,
            message: count > 0 ? `You have ${  count  } anonymous visits. Create an account to claim them!` : null
        });
    });
});

app.post('/api/auth/link-account', async (req, res) => {
    const { username, password, visitor_id } = req.body;
    if (!username || !password) {return res.status(400).json({ error: 'username and password required' });}

    const actualVisitorId = visitor_id || getVisitorId(req, res);

    try {
        const result = await pool.query(
            'SELECT id, username, password_hash, display_name, role, is_active, visitor_id FROM users WHERE username = $1',
            [username.toLowerCase()]
        );
        if (result.rows.length === 0) {return res.status(401).json({ error: 'invalid username or password' });}

        const user = result.rows[0];
        if (!user.is_active) {return res.status(401).json({ error: 'account is disabled' });}

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {return res.status(401).json({ error: 'invalid username or password' });}

        const visitCount = await getAnonymousVisitCount(actualVisitorId);

        await pool.query('UPDATE users SET visitor_id = $1 WHERE id = $2', [actualVisitorId, user.id]);
        await pool.query(
            'UPDATE anonymous_sessions SET user_id = $1, last_seen_at = NOW() WHERE visitor_id = $2',
            [user.id, actualVisitorId]
        );
        await pool.query(
            'UPDATE usage_logs SET user_id = $1 WHERE anonymous_visitor_id = $2 AND user_id IS NULL',
            [user.id, actualVisitorId]
        );

        await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

        const token = await createSession(user.id, user.username, user.role);
        res.cookie('hivv_session', token, { signed: true, httpOnly: true, maxAge: SESSION_TTL, sameSite: 'lax' });

        res.json({
            success: true,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
            session_token: token,
            linked_visits: visitCount,
            message: visitCount > 0 ? `Successfully linked ${  visitCount  } anonymous visits to your account!` : 'No anonymous visits to link.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/providers', async (req, res) => {
    const cacheKey = cache.generateKey('providers');
    const cached = await cache.get(cacheKey);
    if (cached) {
        return res.json({ providers: cached });
    }

    try {
        const result = await pool.query('SELECT id, name, display_name, logo_url, api_format, is_cloud, supported_models FROM ai_providers WHERE is_active = TRUE ORDER BY display_name');
        await cache.set(cacheKey, result.rows, 60000);
        res.json({ providers: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ip-info', async (req, res) => {
    try {
        const response = await fetch('https://ipapi.co/json/');
        if (response.ok) {
            const data = await response.json();
            return res.json(data);
        }
        res.status(502).json({ error: 'Failed to fetch IP info' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/local-ip', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { ip, timestamp, hostname } = req.body;

    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
    }

    try {
        const user = await pool.query('SELECT id FROM users WHERE api_key = $1 OR visitor_id = $1', [apiKey]);
        if (user.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        await pool.query(`
            INSERT INTO user_local_endpoints (user_id, public_ip, hostname, last_seen_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                public_ip = EXCLUDED.public_ip,
                hostname = EXCLUDED.hostname,
                last_seen_at = NOW()
        `, [user.rows[0].id, ip, hostname || null]);

        res.json({ success: true, message: 'IP updated' });
    } catch (err) {
        console.error('Local IP update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/keys', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT k.id, k.provider_id, k.user_id, k.key_name, k.api_endpoint, k.model, k.priority, k.weight, k.is_active, k.is_shared, k.created_at, k.last_used_at, k.total_requests, p.name as provider_name, p.display_name as provider_display_name
            FROM ai_keys k
            JOIN ai_providers p ON k.provider_id = p.id
            WHERE k.user_id = $1 OR k.is_shared = TRUE
            ORDER BY k.priority DESC, k.created_at DESC
        `, [req.session.userId]);
        res.json({ keys: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/keys', requireAuth, csrfValidate, async (req, res) => {
    const { provider_id, key_name, key_value, api_endpoint, model, priority, weight, max_requests_per_hour, max_tokens_per_day, is_shared, notes } = req.body;

    if (!provider_id || !key_value) {
        return res.status(400).json({ error: 'provider_id and key_value are required' });
    }

    try {
        const encryptedKeyValue = encryptKey(key_value);
        const result = await pool.query(`
            INSERT INTO ai_keys (provider_id, user_id, key_name, key_value, api_endpoint, model, priority, weight, max_requests_per_hour, max_tokens_per_day, is_shared, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
        `, [provider_id, req.session.userId, key_name, encryptedKeyValue, api_endpoint, model, priority || 50, weight || 1, max_requests_per_hour, max_tokens_per_day, is_shared || false, notes]);

        res.json({ success: true, key: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/keys/:id', requireAuth, csrfValidate, async (req, res) => {
    const { id } = req.params;
    const { key_name, api_endpoint, model, priority, weight, max_requests_per_hour, max_tokens_per_day, is_active, is_shared, notes } = req.body;

    try {
        const result = await pool.query(`
            UPDATE ai_keys
            SET key_name = COALESCE($1, key_name),
                api_endpoint = COALESCE($2, api_endpoint),
                model = COALESCE($3, model),
                priority = COALESCE($4, priority),
                weight = COALESCE($5, weight),
                max_requests_per_hour = COALESCE($6, max_requests_per_hour),
                max_tokens_per_day = COALESCE($7, max_tokens_per_day),
                is_active = COALESCE($8, is_active),
                is_shared = COALESCE($9, is_shared),
                notes = COALESCE($10, notes)
            WHERE id = $11 AND user_id = $12
            RETURNING *
        `, [key_name, api_endpoint, model, priority, weight, max_requests_per_hour, max_tokens_per_day, is_active, is_shared, notes, id, req.session.userId]);

        if (result.rows.length === 0) {return res.status(404).json({ error: 'Key not found' });}
        res.json({ success: true, key: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/keys/:id', requireAuth, csrfValidate, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM ai_keys WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.session.userId]);
        if (result.rows.length === 0) {return res.status(404).json({ error: 'Key not found' });}
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/keys', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT k.id, k.provider_id, k.user_id, k.key_name, k.api_endpoint, k.model, k.priority, k.weight, k.is_active, k.is_shared, k.created_at, k.last_used_at, k.total_requests, p.name as provider_name, p.display_name as provider_display_name
            FROM ai_keys k
            LEFT JOIN ai_providers p ON k.provider_id = p.id
            WHERE k.user_id = $1
            ORDER BY k.created_at DESC
        `, [req.session.userId]);
        res.json({ keys: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/keys', requireAuth, csrfValidate, async (req, res) => {
    const { provider, model, api_endpoint, key_value, notes, priority } = req.body;

    if (!provider) {
        return res.status(400).json({ error: 'Provider is required' });
    }

    const CLOUD_PROVIDERS = ['openai', 'anthropic', 'google', 'minimax', 'mimo', 'mistral', 'groq', 'openrouter', 'deepseek', 'together'];
    const isCloudProvider = CLOUD_PROVIDERS.includes(provider);

    if (isCloudProvider && !key_value) {
        return res.status(400).json({ error: 'API key is required for cloud providers' });
    }

    try {
        let providerId = null;
        let actualEndpoint = api_endpoint;

        if (provider === 'custom') {
            if (!api_endpoint) {
                return res.status(400).json({ error: 'Custom endpoint URL is required' });
            }
            providerId = 1;
        } else {
            const provResult = await pool.query('SELECT id, default_endpoint FROM ai_providers WHERE name = $1', [provider]);
            if (provResult.rows.length === 0) {
                return res.status(400).json({ error: `Unknown provider: ${  provider}` });
            }
            providerId = provResult.rows[0].id;
            actualEndpoint = api_endpoint || provResult.rows[0].default_endpoint;
        }

        const encryptedKey = encryptKey(key_value);
        const result = await pool.query(`
            INSERT INTO ai_keys (provider_id, user_id, key_name, key_value, api_endpoint, model, priority, is_shared)
            VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
            RETURNING id, provider_id, user_id, key_name, api_endpoint, model, priority, is_shared, created_at
        `, [providerId, req.session.userId, `${provider} key`, encryptedKey, actualEndpoint, model, priority || 50]);

        const newKey = result.rows[0];
        newKey.provider = provider;
        res.json({ success: true, key: newKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/keys/:id/activate', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('UPDATE ai_keys SET is_active = TRUE WHERE id = $1 AND user_id = $2 RETURNING id, provider_id, user_id, key_name, api_endpoint, model, priority, is_active, is_shared, created_at', [id, req.session.userId]);
        if (result.rows.length === 0) {return res.status(404).json({ error: 'Key not found' });}
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/keys/:id/deactivate', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('UPDATE ai_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id, provider_id, user_id, key_name, api_endpoint, model, priority, is_active, is_shared, created_at', [id, req.session.userId]);
        if (result.rows.length === 0) {return res.status(404).json({ error: 'Key not found' });}
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/keys/:id/delete', requireAuth, csrfValidate, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM ai_keys WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.session.userId]);
        if (result.rows.length === 0) {return res.status(404).json({ error: 'Key not found' });}
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/quota', async (req, res) => {
    const session = await getSession(req);

    if (!session) {
        const visitorId = getVisitorId(req, res);
        const ipCheck = ipLimiter.getInMemoryStatus(`ip:${  req.ip}`, 60, 60000);
        return res.json({
            allowed: ipCheck.remaining > 0,
            is_anonymous: true,
            visitor_id: visitorId,
            limits: {
                requests_per_minute: 60,
                requests_per_hour: 300,
                requests_per_day: 1000
            },
            remaining: {
                requests_per_minute: ipCheck.remaining,
                requests_per_hour: ipCheck.remaining,
                requests_per_day: 1000
            },
            message: 'Create an account for higher limits and to track your usage history'
        });
    }

    const quotaCheck = await rateLimiter.checkLimit(session.userId);
    res.json({
        allowed: quotaCheck.allowed,
        is_anonymous: false,
        user_id: session.userId,
        limits: quotaCheck.limits,
        remaining: quotaCheck.remaining,
        usage: quotaCheck.usage
    });
});

app.get('/api/usage', async (req, res) => {
    const session = await getSession(req);
    const visitorId = getVisitorId(req, res);

    if (!session) {
        return res.status(401).json({
            error: 'Login required for usage history',
            code: 'AUTH_REQUIRED',
            visitor_id: visitorId,
            hint: 'Use /api/auth/link-account to link your anonymous visits to an account'
        });
    }

    const { start_date, end_date, group_by } = req.query;
    const usage = await usageTracker.getUsageForUser(session.userId, {
        startDate: start_date,
        endDate: end_date,
        limit: 100
    });
    const aggregates = await usageTracker.getAggregates(session.userId, group_by || 'day', {
        startDate: start_date,
        endDate: end_date
    });
    const topProviders = await usageTracker.getTopProviders(session.userId);
    const monthlyTrend = await usageTracker.getMonthlyTrend(session.userId);

    res.json({ usage, aggregates, topProviders, monthlyTrend });
});

app.get('/api/usage/summary', async (req, res) => {
    const session = await getSession(req);
    const visitorId = getVisitorId(req, res);

    if (!session) {
        return res.status(401).json({
            error: 'Login required',
            visitor_id: visitorId
        });
    }

    const quotaCheck = await rateLimiter.checkLimit(session.userId);
    const todayUsage = await usageTracker.getUsageForUser(session.userId, {
        startDate: new Date(new Date().setHours(0, 0, 0, 0))
    });

    const todayTokens = todayUsage.reduce((sum, u) => sum + (u.total_tokens || 0), 0);
    const todayCost = todayUsage.reduce((sum, u) => sum + parseFloat(u.cost || 0), 0);
    const todayRequests = todayUsage.length;

    res.json({
        quota: {
            allowed: quotaCheck.allowed,
            remaining: quotaCheck.remaining,
            limits: quotaCheck.limits
        },
        today: {
            requests: todayRequests,
            tokens: todayTokens,
            cost: todayCost
        }
    });
});

app.post('/v1/chat/completions', async (req, res) => {
    const startTime = Date.now();
    let { model, messages, stream, temperature, top_p, max_tokens, provider, api_url, apiUrl, capability, route, tools, tool_choice, frequency_penalty, presence_penalty, stop, thinking } = req.body || {};
    const targetApiUrl = api_url || apiUrl || (req.query?.api_url ? String(req.query.api_url) : null);

    // A5: model aliases double as route modes for ANY OpenAI client — picking
    // model "smart" == route.mode=quality with model "auto". (OpenCode sends the
    // mode via per-model `body` merge; plain clients get it from the model name.)
    const ROUTE_ALIASES = { auto: null, smart: 'quality', fast: 'fast', cheap: 'cost', private: 'private' };
    if (model && Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, String(model).toLowerCase())) {
        const alias = String(model).toLowerCase();
        if (ROUTE_ALIASES[alias]) { route = { ...(route || {}), mode: route?.mode || ROUTE_ALIASES[alias] }; }
        model = 'auto';
    }

    // A2: OpenAI-compatible clients send Authorization: Bearer <key> — resolve it
    // to a principal for quota/usage. Absent or empty header = anonymous tier
    // (back-compat: existing clients never sent one).
    let bearerUserId = null;
    let peerHive = null;   // bridge peer identity: Authorization: Bearer hive:<name>
    const authHeader = req.headers.authorization || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        const token = authHeader.slice(7).trim();
        if (token) {
            // A registered bridge hive may identify itself as "hive:<name>"
            // OR plainly as its brand ("kwaai") — KwaaiNet's inference_api_key
            // sends whatever we told it to. Match exact or domain-prefix against
            // verified peers; anything else falls through to the user-key path.
            const name = (token.startsWith('hive:') ? token.slice(5) : token).toLowerCase();
            let matchedPeer = false;
            try {
                const br = await pool.query(
                    "SELECT remote_hive FROM hivv_bridges WHERE (remote_hive = $1 OR remote_hive LIKE $1 || '.%') AND status = 'verified' LIMIT 1",
                    [name]);
                if (br.rows.length) {
                    matchedPeer = true;
                    peerHive = name;
                    req._peerHive = name;   // ledger writes read it from req
                }
            } catch (e) { console.warn(`[AUTH] bridge peer lookup failed: ${e.message}`); }
            if (!matchedPeer && token.startsWith('hive:')) {
                return res.status(401).json({ error: { message: 'Unknown bridge peer', type: 'invalid_request_error', code: 'invalid_api_key' } });
            }
            if (!matchedPeer) {
                try {
                    const kr = await pool.query('SELECT id FROM users WHERE api_key = $1 LIMIT 1', [token]);
                    if (kr.rows.length) { bearerUserId = kr.rows[0].id; }
                    else { return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }); }
                } catch (e) { console.warn(`[AUTH] bearer lookup failed: ${e.message}`); }
            }
        }
    }
    // Generation params forwarded to the router / providers as `gen`
    const gen = {};
    if (temperature != null) gen.temperature = parseFloat(temperature);
    if (max_tokens != null) gen.max_tokens = parseInt(max_tokens, 10);
    if (top_p != null) gen.top_p = parseFloat(top_p);
    if (frequency_penalty != null) gen.frequency_penalty = parseFloat(frequency_penalty);
    if (presence_penalty != null) gen.presence_penalty = parseFloat(presence_penalty);
    if (stop) gen.stop = stop;
    if (thinking != null) gen.thinking = thinking === true || thinking === 'true' || thinking === '1';

    const session = await getSession(req);
    const visitorId = getVisitorId(req, res);
    const userId = bearerUserId || session?.userId;
    const ip = req.ip || req.connection.remoteAddress;
    // hivv OS envelope: WHO is asking + HOW they want it routed
    const osOpts = {
        principal: peerHive ? `hive:${peerHive}` : (userId ? `user:${userId}` : visitorId),
        capability: capability || 'reasoning',
        route: route || {},
        node: _nodeIdOf(req),
        gen,
    };

    const ipCheck = ipLimiter.check(ip);
    if (!ipCheck.allowed) {
        return res.status(429).json({
            error: { message: 'Rate limit exceeded', type: 'rate_limit_error', retry_after: Math.ceil((ipCheck.resetAt - Date.now()) / 1000) }
        });
    }

    if (userId) {
        const quotaCheck = await rateLimiter.checkLimit(userId);
        if (!quotaCheck.allowed) {
            return res.status(429).json({
                error: { message: 'Quota exceeded', type: 'quota_exceeded', details: quotaCheck.remaining }
            });
        }
    }

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
    }

    // Auto-attach the toolkit (same rules as /api/chat). A client that sends
    // its own tools keeps them.
    const effectiveTools = resolveToolAttachment(req, tools);
    const toolsAttached = Array.isArray(effectiveTools) && effectiveTools.length > 0;
    const toolMsgList = [HIVV_IDENTITY_MSG, ...(toolsAttached ? [toolSystemMessage(effectiveTools)] : []), ...messages];

    const useStream = stream === true || stream === 'true' || (req.headers.accept && req.headers.accept.includes('text/event-stream'));

    // First-TOKEN latency for SSE: stamp the first frame that carries REAL
    // content (role/null/empty frames — and reasoning-only frames — don't
    // count). Non-stream replies get ttfb = duration: the whole JSON is the
    // first byte. Without this, the streaming default never measured TTFB.
    let v1TtfbMs = null;
    if (useStream) {
        const _origWrite = res.write.bind(res);
        res.write = (chunk, ...rest) => {
            if (v1TtfbMs === null && chunk != null
                // `reasoning_content` FIRST: a thinking model (gemma-4) opens with
                // reasoning frames, and the custom-endpoint path FORWARDS them to the
                // client. The old pattern required a quote immediately before
                // `content`, which `"reasoning_content":"` does not have, so the first
                // token was stamped at the END of the reply — ttfb came out equal to
                // duration, `hivv speeds` classified the row as non-stream and dropped
                // it, and the first-token stats reported nothing (0 of 70 local-custom
                // rows carried a distinct ttfb).
                && /"(?:reasoning_content|content)":"(?:[^"\\]|\\.)+/.test(String(chunk))) {
                v1TtfbMs = Date.now() - startTime;
            }
            return _origWrite(chunk, ...rest);
        };
    }

    try {
        // Non-streaming requests go through chatCompletion()
        if (!useStream) {
            // ── the tool loop ────────────────────────────────────────────────
            // The model asks for a tool → the hub runs it → the model answers.
            // This is what makes "any AI can use any tool" true for every
            // OpenAI-compatible client (OpenCode, Cline, Continue, a script).
            const MAX_TOOL_ROUNDS = 5;
            const v1MsgList = toolMsgList.slice();
            let data = null;
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                data = await router.chatCompletion(v1MsgList, {
                    model, provider, userId, stream: false,
                    apiUrl: targetApiUrl,
                    tools: effectiveTools,
                    toolChoice: tool_choice ?? null,
                    ...osOpts,
                    // DEEPER TELEMETRY: the caller's trace travels with the
                    // request, so a trace that started at a peer hive stays
                    // ONE story across the crossing.
                    traceparent: req.headers.traceparent || null,
                    timeout: max_tokens ? Math.min(max_tokens * 100, 120000) : 120000
                });
                if (!data.ok) break;
                const assistantMsg = data.data?.choices?.[0]?.message;
                const toolCalls = assistantMsg?.tool_calls;
                if (!toolCalls || !toolCalls.length) break;
                v1MsgList.push(assistantMsg);
                if (!toolsAttached) {
                    // The client opted OUT of tools — never run one.
                    for (const tc of toolCalls) {
                        v1MsgList.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            content: 'tools are not available on this request — answer without them',
                        });
                    }
                    break;
                }
                for (const tc of toolCalls) {
                    const fn = tc.function || tc.function_ || {};
                    let targs = {};
                    try { targs = JSON.parse(fn.arguments || '{}'); } catch (_e) { /* bad args */ }
                    const tres = await toolkitLib.execute(fn.name, targs || {}, {
                        principal: osOpts.principal,
                        transport: 'hub',
                        ip,
                        isAdmin: isAdminRequest(req),
                        reason: 'v1 tool exec during chat',
                        node: _nodeIdOf(req),
                        via: 'hub',
                    });
                    v1MsgList.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: tres.ok
                            ? formatToolResultPublic(tres.tool, tres.data)
                            : String(tres.error || 'the tool failed'),
                    });
                }
            }
            if (!data.ok) {
                if (data.denied) return res.status(403).json({ error: { message: data.error, type: 'policy_denied', policy: data.policy } });
                if (data.asked) return res.status(202).json({ verdict: 'MAYBE', policy: data.policy, grant_id: data.policy?.grant_id, message: `human approval required — hivv approve ${data.policy?.grant_id}` });
                if (data.privacyBlocked || data.costBlocked) return res.status(403).json({ error: { message: data.error, type: data.privacyBlocked ? 'privacy_blocked' : 'cost_blocked' } });
                // The PROMPT was too big for the model's context window.
                // That is the caller's problem to fix, not a server
                // outage — say so with 413 instead of "server_error".
                if (data.contextOverflow) {
                    return res.status(413).json({ error: { message: data.error, type: 'exceed_context_size_error', detail: data.detail } });
                }
                return res.status(503).json({ error: { message: data.error, type: 'server_error' } });
            }
            const tokenEstimate = usageTracker.estimateFromCompletion(data.data, messages);
            // Durable provenance: WHO asked, which model/node answered, when,
            // how long, what it cost. Fire-and-forget — never blocks the reply.
            requestProvenance.recordAsync({
                request_id: crypto.randomUUID(),
                endpoint: '/v1/chat/completions',
                method: req.method,
                feature: 'chat',
                status: 'success',
                user_id: userId || null,
                anonymous_visitor_id: userId ? null : visitorId,
                principal: osOpts.principal,
                api_key_id: data.keyId || null,
                ip_address: ip,
                user_agent: req.headers['user-agent'],
                request_sha256: crypto.createHash('sha256')
                    .update(JSON.stringify(messages || [])).digest('hex'),
                input_bytes: Buffer.byteLength(JSON.stringify(messages || []), 'utf8'),
                output_bytes: Buffer.byteLength(JSON.stringify(data.data || {}), 'utf8'),
                input_tokens: tokenEstimate.inputTokens,
                output_tokens: tokenEstimate.outputTokens,
                provider: data.provider || null,
                provider_id: data.providerId || null,
                model: data.servedModel || model || 'auto',
                answered_by: data.answeredBy || null,
                answered_by_node: _nodeFromReceipt(data.answeredBy || ''),
                transport: String(data.answeredBy || '').includes('relay') ? 'relay'
                    : (data.answeredBy ? 'direct' : (data.provider || 'cloud')),
                route_mode: route?.mode || null,
                capability: capability || 'reasoning',
                policy_receipt: data.policyReceipt || null,
                policy_verdict: data.policyReceipt ? 'allow' : null,
                started_at_ms: startTime,
                completed_at_ms: Date.now(),
                duration_ms: Date.now() - startTime,
                ttfb_ms: v1TtfbMs ?? (Date.now() - startTime),
                cost_usd: 0,
                cost_estimated: false,
                tokens_per_sec: data.tokensPerSec || null,
                success: true,
                privacy: { privacy_class: 'private' },
            });
            await usageTracker.logRequest({
                peerHive: req._peerHive || null,
                userId: userId || null,
                keyId: data.keyId || null,
                providerId: data.providerId || null,
                model: data.servedModel || model,
                inputTokens: tokenEstimate.inputTokens,
                outputTokens: tokenEstimate.outputTokens,
                cost: 0,
                latencyMs: Date.now() - startTime,
                status: 'success',
                ipAddress: ip,
                userAgent: req.headers['user-agent'],
                endpoint: 'chat/completions',
                anonymousVisitorId: userId ? null : visitorId
            });
            await trackAnonymousSession(visitorId, ip, req.headers['user-agent']);
            if (data.answeredBy && !res.headersSent) {
                res.setHeader('X-Hivv-Answered-By', data.answeredBy);
            }
            if (data.policyReceipt && !res.headersSent) {
                res.setHeader('X-Hivv-Policy', data.policyReceipt);
            }
            // Signed route receipt (Phase 6): non-streaming → the answer
            // digest IS included, so a client can hash the body it received
            // and match it against the hub's signature.
            if (!res.headersSent) {
                try {
                    const _ansSha = crypto.createHash('sha256')
                        .update(JSON.stringify(data.data || {})).digest('hex');
                    const _rcpt = require('./lib/identity').routeReceiptHeader({
                        answeredBy: data.answeredBy || 'unknown',
                        transport: String(data.answeredBy).includes('(relay)') ? 'relay'
                            : String(data.answeredBy).includes('(cloud)') ? 'cloud' : 'direct',
                        answerSha256: _ansSha,
                        durationMs: Date.now() - startTime,
                    });
                    if (_rcpt) res.setHeader('X-Hivv-Receipt', _rcpt);
                } catch (_e) {}
            }
            return res.json(data.data);
        }

        // ── streaming with a real tool loop ─────────────────────────────────
        // The interceptor holds back the tool-call frames and forwards the
        // content frames live, so the client sees one clean answer and never
        // has to implement a tool loop of its own.
        const V1_MAX_ROUNDS = 5;
        const v1StreamMsgs = toolMsgList.slice();
        let result = null;
        for (let round = 0; round < V1_MAX_ROUNDS; round++) {
            const interceptor = new toolStreamLib.ToolStreamInterceptor(res, { maxRounds: V1_MAX_ROUNDS });
            result = await router.routeWithFailover(v1StreamMsgs, {
                provider,
                model,
                userId,
                apiUrl: targetApiUrl,
                stream: useStream,
                tools: effectiveTools,
                toolChoice: tool_choice ?? null,
                plainStream: req.headers['x-hivv-plain'] === '1',
                ...osOpts,
                response: interceptor,
                timeout: max_tokens ? Math.min(max_tokens * 100, 120000) : 120000
            });
            if (!result.ok) {
                if (!res.headersSent) {
                    if (result.denied) return res.status(403).json({ error: { message: result.error, type: 'policy_denied', policy: result.policy } });
                    if (result.asked) return res.status(202).json({ verdict: 'MAYBE', policy: result.policy, grant_id: result.policy?.grant_id, message: `human approval required — hivv approve ${result.policy?.grant_id}` });
                    if (result.privacyBlocked || result.costBlocked) return res.status(403).json({ error: { message: result.error, type: result.privacyBlocked ? 'privacy_blocked' : 'cost_blocked' } });
                    if (result.contextOverflow) return res.status(413).json({ error: { message: result.error, type: 'exceed_context_size_error', detail: result.detail } });
                    return res.status(503).json({ error: { message: result.error, type: 'server_error' } });
                }
                interceptor.release();
                interceptor.finish();
                break;
            }
            if (!interceptor.hadToolCalls()) {
                interceptor.release();
                interceptor.finish();
                break;
            }
            const calls = interceptor.toolCalls();
            v1StreamMsgs.push(interceptor.assistantMessage());
            if (!toolsAttached) {
                for (const call of calls) {
                    v1StreamMsgs.push({
                        role: 'tool',
                        tool_call_id: call.id || `call_${round}`,
                        content: 'tools are not available on this request — answer without them',
                    });
                }
                interceptor.release();
                interceptor.finish();
                break;
            }
            for (const call of calls) {
                let targs = {};
                try { targs = JSON.parse(call.function.arguments || '{}'); } catch (_e) { /* bad args */ }
                const tres = await toolkitLib.execute(call.function.name, targs || {}, {
                    principal: osOpts.principal,
                    transport: 'hub',
                    ip,
                    isAdmin: isAdminRequest(req),
                    reason: 'v1 tool exec during chat',
                    node: _nodeIdOf(req),
                    via: 'hub',
                });
                v1StreamMsgs.push({
                    role: 'tool',
                    tool_call_id: call.id || `call_${round}`,
                    content: tres.ok
                        ? formatToolResultPublic(tres.tool, tres.data)
                        : String(tres.error || 'the tool failed'),
                });
            }
            if (round === V1_MAX_ROUNDS - 1) {
                interceptor.release();
                interceptor.finish();
            }
        }

        // Add provider info to response headers (visible to CLI and non-streaming clients)
        if (result.ok && result.provider && !res.headersSent) {
            res.setHeader('X-Hivv-Provider', result.provider);
        }

        if (!result.ok) {
            if (result.denied) return res.status(403).json({ error: { message: result.error, type: 'policy_denied', policy: result.policy } });
            if (result.asked) return res.status(202).json({ verdict: 'MAYBE', policy: result.policy, grant_id: result.policy?.grant_id, message: `human approval required — hivv approve ${result.policy?.grant_id}` });
            if (result.privacyBlocked || result.costBlocked) return res.status(403).json({ error: { message: result.error, type: result.privacyBlocked ? 'privacy_blocked' : 'cost_blocked' } });
            // The prompt was too big for the model's context window — the
            // caller's problem, so 413 and not a server outage.
            if (result.contextOverflow) {
                return res.status(413).json({ error: { message: result.error, type: 'exceed_context_size_error', detail: result.detail } });
            }
            return res.status(503).json({ error: { message: result.error, type: 'server_error' } });
        }

        const tokenEstimate = usageTracker.estimateFromMessages(messages);
        // streaming: prefer the router's counted content-chunks over the 0 estimate
        if (Number.isFinite(result.totalTokens) && result.totalTokens > 0) {
            tokenEstimate.outputTokens = result.totalTokens;
        }
        const cost = 0;

        if (userId && result.keyId) {
            await usageTracker.logRequest({
                peerHive: req._peerHive || null,
                userId,
                keyId: result.keyId,
                providerId: result.providerId,
                model: result.servedModel || model,
                inputTokens: tokenEstimate.inputTokens,
                outputTokens: tokenEstimate.outputTokens,
                cost,
                latencyMs: Date.now() - startTime,
                status: 'success',
                ipAddress: ip,
                userAgent: req.headers['user-agent'],
                endpoint: 'chat/completions',
                tokensPerSec: result.tokensPerSec
            });
        } else {
            await usageTracker.logRequest({
                peerHive: req._peerHive || null,
                userId: null,
                keyId: result.keyId || null,
                providerId: result.providerId || null,
                model: result.servedModel || model,
                inputTokens: tokenEstimate.inputTokens,
                outputTokens: tokenEstimate.outputTokens,
                cost,
                latencyMs: Date.now() - startTime,
                status: 'success',
                ipAddress: ip,
                userAgent: req.headers['user-agent'],
                endpoint: 'chat/completions',
                anonymousVisitorId: visitorId,
                tokensPerSec: result.tokensPerSec
            });
        }

        await trackAnonymousSession(visitorId, ip, req.headers['user-agent']);

        // Durable provenance for the STREAMING path (the default everywhere) —
        // same row shape as the non-stream branch, but with the real
        // first-token time captured by the res.write stamp above.
        requestProvenance.recordAsync({
            request_id: crypto.randomUUID(),
            endpoint: '/v1/chat/completions',
            method: req.method,
            feature: 'chat',
            status: 'success',
            success: true,
            user_id: userId || null,
            anonymous_visitor_id: userId ? null : visitorId,
            principal: osOpts.principal,
            api_key_id: result.keyId || null,
            ip_address: ip,
            user_agent: req.headers['user-agent'],
            request_sha256: crypto.createHash('sha256')
                .update(JSON.stringify(messages || [])).digest('hex'),
            input_bytes: Buffer.byteLength(JSON.stringify(messages || []), 'utf8'),
            input_tokens: tokenEstimate.inputTokens,
            output_tokens: tokenEstimate.outputTokens,
            provider: result.provider || null,
            provider_id: result.providerId || null,
            model: result.servedModel || model || 'auto',
            answered_by: result.answeredBy || null,
            answered_by_node: _nodeFromReceipt(result.answeredBy || ''),
            transport: String(result.answeredBy || '').includes('relay') ? 'relay'
                : (result.answeredBy ? 'direct' : (result.provider || 'cloud')),
            route_mode: route?.mode || null,
            capability: capability || 'reasoning',
            started_at_ms: startTime,
            completed_at_ms: Date.now(),
            duration_ms: Date.now() - startTime,
            ttfb_ms: v1TtfbMs ?? (Date.now() - startTime),
            cost_usd: 0,
            cost_estimated: false,
            tokens_per_sec: result.tokensPerSec || null,
            privacy: { privacy_class: 'private' },
        });

    } catch (err) {
        console.error('Chat completion error:', err);
        errorLog.recordAsync({
            error: err,
            endpoint: '/v1/chat/completions',
            model: model || null,
            user_agent: req.headers['user-agent'],
            status: 500,
        });
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
    }
});

// Direct and legacy endpoints supporting { message, api_url } and /chat/stream
app.post(['/api/chat', '/v1/chat/stream'], async (req, res) => {
    let { model, messages, message, stream, provider, api_url, apiUrl, tools, capability, route, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop, thinking } = req.body || {};
    // Generation params forwarded to the router / providers as `gen`
    const gen = {};
    if (temperature != null) gen.temperature = parseFloat(temperature);
    if (max_tokens != null) gen.max_tokens = parseInt(max_tokens, 10);
    if (top_p != null) gen.top_p = parseFloat(top_p);
    if (frequency_penalty != null) gen.frequency_penalty = parseFloat(frequency_penalty);
    if (presence_penalty != null) gen.presence_penalty = parseFloat(presence_penalty);
    if (stop) gen.stop = stop;
    if (thinking != null) gen.thinking = thinking === true || thinking === 'true' || thinking === '1';
    if (!messages && message) {
        messages = [{ role: 'user', content: String(message) }];
    }
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: { message: 'message or messages array required' } });
    }

    // ── AUTO-ATTACH THE TOOLKIT ────────────────────────────────────────────
    //
    // Before this, the tool loop only ran when the CLIENT passed `tools` in
    // the request body — and nobody does, so no model on the network ever
    // used a tool. Now the hub offers its toolkit by default and the model
    // drives it. Any AI — a cloud LLM, a local gemma on a bee, an MCP client
    // — can use every tool without implementing a tool loop of its own.
    const effectiveTools = resolveToolAttachment(req, tools);
    const toolsAttached = Array.isArray(effectiveTools) && effectiveTools.length > 0;

        // ── Tool executor: runs a tool call and returns the result ──────────────
        //
        // This used to be 150 lines of inline tool code — a SECOND copy of the
        // logic that also lives in public_html/hivv-tools.py, and the two had
        // already drifted (the hub's calculator stripped "sqrt(2)" down to
        // "(2)"). Now it is a thin adapter over api/lib/toolkit.js, which is
        // the one implementation of every tool the hive has.
        async function execToolCall(toolCall) {
            const fn = toolCall.function || toolCall.function_;
            const name = fn.name;
            let args = {};
            try { args = JSON.parse(fn.arguments || '{}'); } catch(_){}
            if (!args || typeof args !== 'object') args = {};
            // The gate lives inside toolkit.execute() — deny refuses, ask
            // mints a grant a human approves. The result carries the verdict.
            const result = await toolkitLib.execute(name, args, {
                principal: getVisitorId(req, res),
                transport: 'hub',
                ip: req.ip,
                isAdmin: isAdminRequest(req),
                reason: 'hub tool exec during chat',
                node: _nodeIdOf(req),
                via: 'hub',
            });
            if (!result.ok) {
                return { role: 'tool', tool_call_id: toolCall.id, content: String(result.error || 'the tool failed') };
            }
            return { role: 'tool', tool_call_id: toolCall.id, content: formatToolResult(result.tool, result.data) };
        }

        // A tool result the model can actually read: a bare number for maths,
        // a readable line for the clock, structured JSON for everything else.
        const formatToolResult = formatToolResultPublic;

    const targetApiUrl = api_url || apiUrl || (req.query?.api_url ? String(req.query.api_url) : null);
    const session = await getSession(req);
    const userId = session?.userId;
    const useStream = stream !== false;
    const chatStartTime = Date.now();
    const chatVisitorId = userId ? null : getVisitorId(req, res);
    const chatIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    // First-TOKEN latency for SSE (the default): stamp the first frame that
    // carries real content, and count the bytes we actually stream back.
    // Non-stream replies record ttfb = full duration (the JSON is the first
    // byte) — same convention as /v1.
    let chatTtfbMs = null;
    let chatOutBytes = 0;
    if (useStream) {
        const _origWrite = res.write.bind(res);
        res.write = (chunk, ...rest) => {
            if (chunk != null) {
                chatOutBytes += Buffer.isBuffer(chunk) ? chunk.length
                    : Buffer.byteLength(String(chunk), 'utf8');
                // Same reasoning_content rule as the /v1 hook above: a thinking
                // model streams `reasoning_content` before any `content`, and on the
                // custom-endpoint path those frames reach the client — so first-token
                // must stamp them or ttfb == duration and the row is misclassified
                // as non-stream by `hivv speeds`.
                if (chatTtfbMs === null && /"(?:reasoning_content|content)":"(?:[^"\\]|\\.)+/.test(String(chunk))) {
                    chatTtfbMs = Date.now() - chatStartTime;
                }
            }
            return _origWrite(chunk, ...rest);
        };
    }
    // fire-and-forget usage log — never delays the reply (D1: honest token counts)
    const _logChatUsage = (data) => {
        usageTracker.logRequest({
                peerHive: req._peerHive || null,
            userId: userId || null,
            keyId: data.keyId || null,
            providerId: data.providerId || null,
            model: data.servedModel || model || 'auto',
            inputTokens: data.inputTokens || 0,
            outputTokens: data.outputTokens || 0,
            cost: 0,
            latencyMs: Date.now() - chatStartTime,
            status: 'success',
            ipAddress: chatIp,
            userAgent: req.headers['user-agent'],
            endpoint: 'api/chat',
            anonymousVisitorId: chatVisitorId,
            tokensPerSec: data.tokensPerSec || null
        }).catch(() => {});
    };
    // hivv OS envelope (§1/§2/§3)
    const osOpts = {
        principal: userId ? `user:${userId}` : getVisitorId(req, res),
        capability: capability || 'reasoning',
        route: route || {},
        node: _nodeIdOf(req),
        gen,
    };

    // Durable provenance for hivv's native surface (/api/chat — CLI, web chat,
    // MCP, dial): WHO asked, which bee answered (node + transport), how long
    // the FULL reply took, how fast the first token arrived, and tokens/s.
    // Fire-and-forget — never blocks or delays the reply.
    let chatProvDone = false;
    const _provRecord = (extra = {}) => {
        if (chatProvDone) return;
        chatProvDone = true;
        const now = Date.now();
        const completed = now - chatStartTime;
        const isErr = extra.status === 'error';
        const outTok = Number.isFinite(extra.output_tokens) ? extra.output_tokens : 0;
        let tps = Number.isFinite(extra.tokens_per_sec) ? extra.tokens_per_sec : null;
        if (tps === null && outTok > 0 && completed > 0) {
            tps = Math.round(outTok * 1000 / completed * 100) / 100;
        }
        requestProvenance.recordAsync({
            request_id: crypto.randomUUID(),
            endpoint: '/api/chat',
            method: req.method,
            feature: 'chat',
            status: isErr ? 'error' : 'success',
            success: !isErr,
            user_id: userId || null,
            anonymous_visitor_id: chatVisitorId,
            principal: osOpts.principal,
            ip_address: chatIp,
            user_agent: req.headers['user-agent'],
            request_sha256: crypto.createHash('sha256')
                .update(JSON.stringify(messages || [])).digest('hex'),
            input_bytes: Buffer.byteLength(JSON.stringify(messages || []), 'utf8'),
            output_bytes: chatOutBytes || extra.output_bytes || 0,
            input_tokens: extra.input_tokens || 0,
            output_tokens: outTok,
            provider: extra.provider || null,
            model: extra.model || model || 'auto',
            answered_by: extra.answeredBy || null,
            answered_by_node: _nodeFromReceipt(extra.answeredBy || ''),
            transport: String(extra.answeredBy || '').includes('relay') ? 'relay'
                : (extra.answeredBy ? 'direct' : (extra.provider || 'cloud')),
            route_mode: route?.mode || null,
            capability: capability || 'reasoning',
            policy_receipt: extra.policyReceipt || null,
            policy_verdict: extra.policyReceipt ? 'allow' : null,
            started_at_ms: chatStartTime,
            completed_at_ms: now,
            duration_ms: completed,
            ttfb_ms: chatTtfbMs != null ? chatTtfbMs : completed,
            tokens_per_sec: tps,
            stream: useStream,
            cost_usd: 0,
            cost_estimated: false,
            error_message: isErr ? String(extra.error || '').slice(0, 500) || null : null,
            privacy: { privacy_class: 'private' },
        });
    };

    try {
        if (!useStream) {
            const localTools = req.body.local_tools === true;
            // ── Non-streaming: support tool_call loop ───────────────────────────
            const MAX_TOOL_ROUNDS = 5;
            let msgList = [HIVV_IDENTITY_MSG, ...(toolsAttached ? [toolSystemMessage(effectiveTools)] : []), ...messages.slice()];
            let lastData = null;
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                const data = await router.chatCompletion(msgList, {
                    model, provider, userId, apiUrl: targetApiUrl, stream: false, tools: effectiveTools, ...osOpts,
                    traceparent: req.headers.traceparent || null
                });
                if (!data.ok) {
                    if (data.denied) return res.status(403).json({ verdict: 'NO', policy: data.policy, error: data.error });
                    if (data.asked) return res.status(202).json({ verdict: 'MAYBE', policy: data.policy, grant_id: data.policy?.grant_id, message: `human approval required — hivv approve ${data.policy?.grant_id}` });
                    if (data.privacyBlocked || data.costBlocked) return res.status(403).json({ error: { message: data.error, type: data.privacyBlocked ? 'privacy_blocked' : 'cost_blocked' } });
                    return res.status(503).json({ error: { message: data.error } });
                }
                const assistantMsg = data.data?.choices?.[0]?.message;
                const toolCalls = assistantMsg?.tool_calls;
                if (!toolCalls || toolCalls.length === 0) {
                    // No more tool calls — return this response
                    const usage = data.data?.usage || {};
                    orch.trackRequest(usage.total_tokens || 0, 0, data.provider || provider || 'unknown');
                    const t = usageTracker.estimateFromCompletion(data.data, msgList);
                    _logChatUsage({ keyId: data.keyId, providerId: data.providerId, servedModel: data.servedModel,
                                    inputTokens: t.inputTokens, outputTokens: t.outputTokens });
                    _provRecord({
                        input_tokens: t.inputTokens,
                        output_tokens: t.outputTokens,
                        output_bytes: Buffer.byteLength(JSON.stringify(data.data || {}), 'utf8'),
                        provider: data.provider || null,
                        model: data.servedModel || model || 'auto',
                        answeredBy: data.answeredBy || null,
                        policyReceipt: data.policyReceipt || null,
                    });
                    if (data.answeredBy && !res.headersSent) {
                        res.setHeader('X-Hivv-Answered-By', data.answeredBy);
                    }
                    if (data.policyReceipt && !res.headersSent) {
                        res.setHeader('X-Hivv-Policy', data.policyReceipt);
                    }
                    // Signed route receipt (Phase 6) — answer digest included
                    // (non-streaming: the body is final when headers go out).
                    if (!res.headersSent) {
                        try {
                            const _ansSha = crypto.createHash('sha256')
                                .update(JSON.stringify(data.data || {})).digest('hex');
                            const _rcpt = require('./lib/identity').routeReceiptHeader({
                                answeredBy: data.answeredBy || 'unknown',
                                transport: String(data.answeredBy).includes('(relay)') ? 'relay'
                                    : String(data.answeredBy).includes('(cloud)') ? 'cloud' : 'direct',
                                answerSha256: _ansSha,
                            });
                            if (_rcpt) res.setHeader('X-Hivv-Receipt', _rcpt);
                        } catch (_e) {}
                    }
                    return res.json(data.data);
                }
                if (localTools && round === 0) {
                    // Return tool_calls to CLI for local execution
                    return res.json({
                        local_execution_required: true,
                        tool_calls: toolCalls,
                        assistant_message: assistantMsg
                    });
                }
                if (!toolsAttached) {
                    // The client opted OUT of tools ("tools": false, or
                    // X-Hivv-Tools: off). A model can still emit a tool call —
                    // hallucinated, or left over from a template — and the
                    // hub must NOT run it. Say so instead of acting.
                    msgList.push(assistantMsg);
                    for (const tc of toolCalls) {
                        msgList.push({
                            role: 'tool',
                            tool_call_id: tc.id || `call_${round}`,
                            content: 'tools are not available on this request — answer without them',
                        });
                    }
                    lastData = data.data;
                    continue;
                }
                // Execute each tool call on hub and append results to messages
                for (const tc of toolCalls) {
                    const result = await execToolCall(tc);
                    msgList.push(assistantMsg);  // the assistant's tool_call message
                    msgList.push(result);        // the tool result
                }
                lastData = data.data;
                // Continue the loop with updated messages
            }
            // Exceeded max rounds
            _provRecord({ model: model || 'auto', provider: provider || null });
            return res.json(lastData);
        }

        // ── Streaming path — with a REAL tool loop ─────────────────────────
        //
        // The router writes provider frames straight to the response socket,
        // so a tool_call used to reach the client before we could run it — and
        // a client that receives an unexpected tool_call executes it itself.
        // ToolStreamInterceptor sits in between: it holds the tool-call frames
        // back, forwards content frames live, and lets the hub run the tool
        // and ask the model again. The client sees one clean answer.
        const MAX_TOOL_ROUNDS = 5;
        const streamMsgList = [HIVV_IDENTITY_MSG, ...(toolsAttached ? [toolSystemMessage(effectiveTools)] : []), ...messages];
        let result = null;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const interceptor = new toolStreamLib.ToolStreamInterceptor(res, { maxRounds: MAX_TOOL_ROUNDS });
            result = await router.routeWithFailover(streamMsgList, {
                provider,
                model,
                userId,
                apiUrl: targetApiUrl,
                stream: true,
                tools: effectiveTools,
                ...osOpts,
                response: interceptor
            });
            if (!result.ok) {
                // The model was not reachable. If nothing has been sent yet we
                // can still answer with a proper JSON error; if the stream has
                // already started we close it cleanly instead.
                if (!res.headersSent) {
                    if (result.denied) return res.status(403).json({ verdict: 'NO', policy: result.policy, error: result.error });
                    if (result.asked) return res.status(202).json({ verdict: 'MAYBE', policy: result.policy, grant_id: result.policy?.grant_id, message: `human approval required — hivv approve ${result.policy?.grant_id}` });
                    if (result.privacyBlocked || result.costBlocked) return res.status(403).json({ error: { message: result.error, type: result.privacyBlocked ? 'privacy_blocked' : 'cost_blocked' } });
                    return res.status(503).json({ error: { message: result.error } });
                }
                interceptor.release();
                interceptor.finish();
                break;
            }
            // No tool call → this round IS the answer. Release the held
            // frames (its [DONE]) and close the stream.
            if (!interceptor.hadToolCalls()) {
                interceptor.release();
                interceptor.finish();
                break;
            }
            // The model asked for tools. They never reached the client; the
            // hub runs them and the model continues.
            const calls = interceptor.toolCalls();
            const assistantMsg = interceptor.assistantMessage();
            streamMsgList.push(assistantMsg);
            if (!toolsAttached) {
                // The client opted OUT of tools. A model can still emit a tool
                // call — hallucinated, or left over from a template — and the
                // hub must NOT run it.
                for (const call of calls) {
                    streamMsgList.push({
                        role: 'tool',
                        tool_call_id: call.id || `call_${round}`,
                        content: 'tools are not available on this request — answer without them',
                    });
                }
                interceptor.release();
                interceptor.finish();
                break;
            }
            for (const call of calls) {
                streamMsgList.push(await execToolCall({
                    id: call.id || `call_${round}`,
                    type: 'function',
                    function: { name: call.function.name, arguments: call.function.arguments || '{}' },
                }));
            }
            if (round === MAX_TOOL_ROUNDS - 1) {
                // Out of rounds: release what we have so the client is not
                // left hanging on an unterminated stream.
                interceptor.release();
                interceptor.finish();
            }
        }
        if (result.ok) {
            // measured output tokens (counted SSE chunks) beat the chars-heuristic
            const t = usageTracker.estimateFromMessages(messages);
            const outTok = Number.isFinite(result.totalTokens) && result.totalTokens > 0 ? result.totalTokens : t.outputTokens;
            _logChatUsage({ keyId: result.keyId, providerId: result.providerId, servedModel: result.servedModel,
                            inputTokens: t.inputTokens,
                            outputTokens: outTok,
                            tokensPerSec: result.tokensPerSec });
            _provRecord({
                input_tokens: t.inputTokens,
                output_tokens: outTok,
                tokens_per_sec: result.tokensPerSec,
                provider: result.provider || provider || null,
                model: result.servedModel || model || 'auto',
                answeredBy: result.answeredBy || null,
                policyReceipt: result.policyReceipt || null,
            });
        }
    } catch (err) {
        // Record the failure too — a slow error is still a speed datapoint.
        _provRecord({ status: 'error', error: err.message });
        errorLog.recordAsync({
            error: err,
            endpoint: '/api/chat',
            model: model || null,
            user_agent: req.headers['user-agent'],
            status: 500,
        });
        if (!res.headersSent) {
            res.status(500).json({ error: { message: err.message } });
        }
    }
});

// POST /api/chat/continue — CLI sends local tool results, hub continues conversation
app.post('/api/chat/continue', async (req, res) => {
    const { messages, tool_results, assistant_message, model, provider, tools } = req.body || {};
    if (!messages || !tool_results) {
        return res.status(400).json({ error: 'messages and tool_results required' });
    }

    // Tools on THIS endpoint only ever come from an explicit signal (a body
    // `tools` array or an X-Hivv-Tools header) — continue is a continuation of a
    // loop the client already started, so guessing a fresh default would be
    // wrong either way. What matters is the invariant: the briefing must never
    // claim tools we are not sending. It used to be injected unconditionally
    // while `tools` defaulted to null, i.e. it promised a toolkit the model
    // did not have.
    const toolHeader = String((req.headers && req.headers['x-hivv-tools']) || '').trim();
    const effectiveTools = (toolHeader !== '' || Array.isArray(tools))
        ? resolveToolAttachment(req, tools) : null;
    const toolsAttached = Array.isArray(effectiveTools) && effectiveTools.length > 0;

    // Build full message list: system + user msg + assistant tool_call msg + tool result
    const msgList = [HIVV_IDENTITY_MSG, ...(toolsAttached ? [toolSystemMessage(effectiveTools)] : []), ...messages];
    if (assistant_message) {
        msgList.push(assistant_message);  // assistant's original tool_call message
    }
    for (const tr of tool_results) {
        msgList.push(tr);  // {role: 'tool', tool_call_id: ..., content: ...}
    }

    try {
        const data = await router.chatCompletion(msgList, {
            model, provider, stream: false, tools: effectiveTools
        });
        if (!data.ok) return res.status(503).json({ error: { message: data.error } });

        const assistantMsg = data.data?.choices?.[0]?.message;
        const content = assistantMsg?.content || '';
        const usage = data.data?.usage || {};
        orch.trackRequest(usage.total_tokens || 0, 0, data.provider || provider || 'unknown');

        return res.json({
            content,
            finish_reason: data.data?.choices?.[0]?.finish_reason || 'stop',
            usage,
            provider: data.provider
        });
    } catch (err) {
        res.status(500).json({ error: { message: err.message } });
    }
});

// GET /api/models — detailed model catalog with function-calling support, speed, size, context
const MODEL_CATALOG = [
    { id: "gpt-4o",         provider: "openai",       name: "GPT-4o",          fc: true,  ctx: 128000, size: "~20B",   speed_tps: "~150 t/s",  desc: "flagship vision + code model" },
    { id: "gpt-4o-mini",   provider: "openai",       name: "GPT-4o Mini",     fc: true,  ctx: 128000, size: "~8B",    speed_tps: "~350 t/s",  desc: "fast, cheap, function calling" },
    { id: "gpt-4-turbo",    provider: "openai",       name: "GPT-4 Turbo",     fc: true,  ctx: 128000, size: "~100B",  speed_tps: "~80 t/s",   desc: "large context, vision" },
    { id: "gpt-3.5-turbo", provider: "openai",       name: "GPT-3.5 Turbo",   fc: true,  ctx: 16385,  size: "~175B",  speed_tps: "~200 t/s",  desc: "fast, cheap, legacy" },
    { id: "claude-sonnet-4-20250514", provider: "anthropic", name: "Claude Sonnet 4", fc: true, ctx: 200000, size: "~70B", speed_tps: "~100 t/s", desc: "latest Sonnet, function calling" },
    { id: "claude-3-5-sonnet-20241022", provider: "anthropic", name: "Claude 3.5 Sonnet", fc: true, ctx: 200000, size: "~70B", speed_tps: "~100 t/s", desc: "excellent coding + reasoning" },
    { id: "claude-3-5-haiku-20241022", provider: "anthropic", name: "Claude 3.5 Haiku", fc: true, ctx: 200000, size: "~60B", speed_tps: "~300 t/s", desc: "fast, cheap, function calling" },
    { id: "claude-3-opus-20240229",    provider: "anthropic", name: "Claude 3 Opus",    fc: true, ctx: 200000, size: "~100B", speed_tps: "~60 t/s",  desc: "top-tier reasoning" },
    { id: "gemini-2.0-flash-exp",      provider: "google", name: "Gemini 2.0 Flash",    fc: true,  ctx: 1000000, size: "~20B",   speed_tps: "~200 t/s",  desc: "1M context, fast, cheap" },
    { id: "gemini-1.5-pro",            provider: "google", name: "Gemini 1.5 Pro",      fc: true,  ctx: 2000000, size: "~70B",   speed_tps: "~80 t/s",   desc: "2M context, top reasoning" },
    { id: "gemini-1.5-flash",         provider: "google", name: "Gemini 1.5 Flash",     fc: true,  ctx: 1000000, size: "~20B",   speed_tps: "~300 t/s",  desc: "fast, cheap, function calling" },
    { id: "llama-3.3-70b-versatile",   provider: "groq", name: "Llama 3.3 70B",       fc: true,  ctx: 128000, size: "~70B",   speed_tps: "~800 t/s",  desc: "fastest hosted Llama, function calling" },
    { id: "llama-3.1-8b-instant",      provider: "groq", name: "Llama 3.1 8B",        fc: true,  ctx: 128000, size: "~8B",    speed_tps: "~1000 t/s", desc: "fastest, cheapest, function calling" },
    { id: "mixtral-8x7b-32768",        provider: "groq", name: "Mixtral 8x7B",         fc: true,  ctx: 32768,  size: "~47B",   speed_tps: "~600 t/s",  desc: "fast MoE, function calling" },
    { id: "deepseek-chat",             provider: "deepseek", name: "DeepSeek V3",        fc: true,  ctx: 64000,  size: "~236B",  speed_tps: "~60 t/s",   desc: "top reasoning, function calling" },
    { id: "deepseek-coder",            provider: "deepseek", name: "DeepSeek Coder",     fc: true,  ctx: 128000, size: "~236B",  speed_tps: "~60 t/s",   desc: "specialized code model" },
    { id: "mistral-large-2411",        provider: "mistral", name: "Mistral Large",      fc: true,  ctx: 128000, size: "~100B",  speed_tps: "~80 t/s",   desc: "top-tier reasoning, function calling" },
    { id: "mistral-nemo",              provider: "mistral", name: "Mistral Nemo",        fc: false, ctx: 128000, size: "~12B",   speed_tps: "~200 t/s",  desc: "fast, open, no function calling" },
    { id: "codestral",                 provider: "mistral", name: "Codestral",           fc: false, ctx: 128000, size: "~30B",   speed_tps: "~150 t/s",  desc: "specialized coding" },
    { id: "meta-llama/Llama-3.3-70B-Instruct", provider: "together", name: "Llama 3.3 70B Instruct", fc: true, ctx: 128000, size: "~70B", speed_tps: "~150 t/s", desc: "excellent open model, function calling" },
    { id: "Qwen/Qwen2.5-72B-Instruct", provider: "together", name: "Qwen 2.5 72B",     fc: true,  ctx: 32768,  size: "~72B",   speed_tps: "~120 t/s",  desc: "strong reasoning, function calling" },
    { id: "nvidia/Llama-3.1-Nemotron-70B-Instruct", provider: "together", name: "Nemotron 70B", fc: true, ctx: 128000, size: "~70B", speed_tps: "~150 t/s", desc: "NVIDIA optimized, function calling" },
    { id: "MiniMax-Text-01",           provider: "minimax", name: "MiniMax Text-01",    fc: true,  ctx: 1000000, size: "~456B",  speed_tps: "~100 t/s",  desc: "1M context, MoE, function calling" },
    { id: "openrouter/auto",           provider: "openrouter", name: "OpenRouter Auto",  fc: false, ctx: 0,       size: "?",      speed_tps: "?",        desc: "auto-selects best model for your query" },
    { id: "gemma-4-e2b-it-ud-q4_k_xl", provider: "local", name: "Gemma 4 E2B (Q4)",  fc: true,  ctx: 32768,  size: "~9B",    speed_tps: "~40 t/s",   desc: "YOUR local GGUF — function calling ✓" },
    { id: "llama-3.2-3b-instruct",     provider: "local", name: "Llama 3.2 3B",       fc: true,  ctx: 128000, size: "~3B",    speed_tps: "~60 t/s",   desc: "small, fast, function calling" },
];

app.get('/api/models', (req, res) => {
    res.json({
        total: MODEL_CATALOG.length,
        models: MODEL_CATALOG.map(m => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            function_calling: m.fc,
            context_window: m.ctx,
            model_size: m.size,
            speed: m.speed_tps,
            description: m.desc
        }))
    });
});

async function trackAnonymousSession(visitorId, ip, userAgent) {
    try {
        await pool.query(`
            INSERT INTO anonymous_sessions (visitor_id, last_seen_at, ip_address, user_agent)
            VALUES ($1, NOW(), $2, $3)
            ON CONFLICT (visitor_id) DO UPDATE SET
                last_seen_at = NOW(),
                ip_address = COALESCE($2, anonymous_sessions.ip_address),
                user_agent = COALESCE($3, anonymous_sessions.user_agent)
        `, [visitorId, ip, userAgent]);
    } catch (err) {
        console.error('Failed to track anonymous session:', err.message);
    }
}

app.get('/v1/models', async (req, res) => {
    const models = [];

    for (const [name, provider] of router.providers) {
        models.push({
            id: name,
            object: 'model',
            owned_by: provider.name,
            display_name: provider.displayName
        });
    }

    // A5: routing aliases — any OpenAI client can pick these; the chat endpoint
    // maps them to route modes (smart→quality, cheap→cost, …) + model "auto".
    for (const [id, hint] of [['auto', 'hive default routing'], ['smart', 'route mode: quality'],
                              ['fast', 'route mode: fast'], ['cheap', 'route mode: cost'],
                              ['private', 'route mode: hive-only']]) {
        models.push({ id, object: 'model', owned_by: 'hivv', display_name: `hivv/${id} — ${hint}` });
    }

    res.json({ object: 'list', data: models });
});

app.get('/v1', (req, res) => {
    res.json({
        service: 'HIVV.org AI Gateway v2.0',
        endpoints: {
            'POST /v1/chat/completions': 'OpenAI-compatible chat with priority routing and failover',
            'GET /v1/models': 'List available models',
            'POST /api/auth/register': 'Create account (with optional link_visitor_id to claim anonymous visits)',
            'POST /api/auth/login': 'Login (with optional link_visitor_id)',
            'POST /api/auth/link-account': 'Link anonymous visits to existing account',
            'GET /api/auth/anonymous-history': 'Check your anonymous visit count',
            'GET /api/providers': 'List AI providers',
            'GET /api/keys': 'List your API keys',
            'POST /api/keys': 'Add an API key',
            'GET /api/quota': 'Check your quota',
            'GET /api/usage': 'Get usage details',
            'GET /api/visitor/id': 'Get your anonymous visitor ID'
        }
    });
});

app.get('/api/system/status', async (req, res) => {
    const load = os.loadavg();
    const numCpus = os.cpus().length;
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const gpu = await checkGpu();

    res.json({
        cpu: {
            cores: numCpus,
            load1: load[0],
            load5: load[1],
            load15: load[2],
            perCore: load[0] / numCpus,
            freeRatio: freeMem / totalMem,
            threshold: 0.8
        },
        memory: {
            free: freeMem,
            total: totalMem,
            used: totalMem - freeMem
        },
        jobs: { active: 0, totalProcessed: 0 },
        gpu: {
            available: gpu.available,
            utilization: gpu.utilization,
            memoryUsed: gpu.memoryUsed,
            memoryTotal: gpu.memoryTotal
        },
        timestamp: Date.now()
    });
});

function checkGpu() {
    return new Promise((resolve) => {
        exec('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => {
            if (err) {
                resolve({ available: false, utilization: 0, memoryUsed: 0, memoryTotal: 0 });
                return;
            }
            const parts = stdout.trim().split(',').map(s => parseFloat(s.trim()));
            resolve({
                available: true,
                utilization: parts[0] || 0,
                memoryUsed: parts[1] || 0,
                memoryTotal: parts[2] || 0
            });
        });
    });
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.created_at, u.last_login_at, u.visitor_id,
                   (SELECT COUNT(*) FROM ai_keys WHERE user_id = u.id) as key_count,
                   (SELECT COUNT(*) FROM usage_logs WHERE user_id = u.id) as request_count
            FROM users u
            ORDER BY u.created_at DESC
        `);
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { role, is_active, quota } = req.body;

    try {
        if (role !== undefined || is_active !== undefined) {
            await pool.query(
                'UPDATE users SET role = COALESCE($1, role), is_active = COALESCE($2, is_active) WHERE id = $3',
                [role, is_active, id]
            );
        }

        if (quota) {
            await pool.query(`
                INSERT INTO user_quotas (user_id, provider_id, requests_per_hour, requests_per_day, requests_per_month, tokens_per_hour, tokens_per_day, tokens_per_month)
                VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (user_id, provider_id) DO UPDATE SET
                    requests_per_hour = $2, requests_per_day = $3, requests_per_month = $4,
                    tokens_per_hour = $5, tokens_per_day = $6, tokens_per_month = $7,
                    updated_at = NOW()
            `, [id, quota.requests_per_hour, quota.requests_per_day, quota.requests_per_month, quota.tokens_per_hour, quota.tokens_per_day, quota.tokens_per_month]);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/keys', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT k.id, k.provider_id, k.user_id, k.key_name, k.api_endpoint, k.model, k.priority, k.weight, k.is_active, k.is_shared, k.created_at, k.last_used_at, k.total_requests, p.name as provider_name, p.display_name as provider_display_name,
                   u.username as owner_username
            FROM ai_keys k
            JOIN ai_providers p ON k.provider_id = p.id
            LEFT JOIN users u ON k.user_id = u.id
            ORDER BY k.priority DESC, k.created_at DESC
        `);
        res.json({ keys: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/usage', requireAdmin, async (req, res) => {
    const { user_id, provider_id, start_date, end_date } = req.query;

    let query = `
        SELECT u.id, u.user_id, u.provider_id, u.anonymous_visitor_id, u.model, u.input_tokens, u.output_tokens,
               u.total_tokens, u.cost, u.latency_ms, u.status, u.created_at,
               p.name as provider_name,
               w.username as owner_username
        FROM usage_logs u
        LEFT JOIN ai_providers p ON u.provider_id = p.id
        LEFT JOIN users w ON u.user_id = w.id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (user_id) {
        query += ` AND u.user_id = $${paramIndex}`;
        params.push(user_id);
        paramIndex++;
    }

    if (provider_id) {
        query += ` AND u.provider_id = $${paramIndex}`;
        params.push(provider_id);
        paramIndex++;
    }

    if (start_date) {
        query += ` AND u.created_at >= $${paramIndex}`;
        params.push(start_date);
        paramIndex++;
    }

    if (end_date) {
        query += ` AND u.created_at <= $${paramIndex}`;
        params.push(end_date);
        paramIndex++;
    }

    query += ' ORDER BY u.created_at DESC LIMIT 500';

    try {
        const result = await pool.query(query, params);
        res.json({ logs: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const [userCount, keyCount, usageToday, usageThisMonth, topUsers, anonStats] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM users WHERE is_active = TRUE'),
            pool.query('SELECT COUNT(*) as count FROM ai_keys WHERE is_active = TRUE'),
            pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost), 0) as cost FROM usage_logs WHERE created_at > CURRENT_DATE'),
            pool.query("SELECT COUNT(*) as count, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost), 0) as cost FROM usage_logs WHERE created_at > date_trunc('month', CURRENT_DATE)"),
            pool.query(`
                SELECT u.id, u.username, COUNT(l.id) as request_count, COALESCE(SUM(l.total_tokens), 0) as total_tokens, COALESCE(SUM(l.cost), 0) as total_cost
                FROM users u
                LEFT JOIN usage_logs l ON u.id = l.user_id AND l.created_at > CURRENT_DATE
                GROUP BY u.id, u.username
                ORDER BY total_cost DESC
                LIMIT 10
            `),
            pool.query('SELECT COUNT(DISTINCT visitor_id) as anon_visitors FROM anonymous_sessions WHERE user_id IS NULL')
        ]);

        res.json({
            totalUsers: parseInt(userCount.rows[0].count),
            totalKeys: parseInt(keyCount.rows[0].count),
            anonymousVisitors: parseInt(anonStats.rows[0].anon_visitors),
            today: {
                requests: parseInt(usageToday.rows[0].count),
                tokens: parseInt(usageToday.rows[0].tokens),
                cost: parseFloat(usageToday.rows[0].cost)
            },
            thisMonth: {
                requests: parseInt(usageThisMonth.rows[0].count),
                tokens: parseInt(usageThisMonth.rows[0].tokens),
                cost: parseFloat(usageThisMonth.rows[0].cost)
            },
            topUsersToday: topUsers.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Legacy endpoints for backward compatibility (public - returns empty)
app.post('/api/query', async (req, res) => {
    res.json({ rows: [] });
});

app.get('/api/query', async (req, res) => {
    res.json({ rows: [] });
});

app.get('/api/agents/online', async (req, res) => {
    res.json({ online_count: 0, agents: [] });
});

// Database browser endpoints removed for security — use admin endpoints with requireAdmin auth

app.get('/api/system/history', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 60, 300);
    try {
        const result = await pool.query(`
            SELECT * FROM system_metrics_history
            ORDER BY recorded_at DESC
            LIMIT $1
        `, [limit]);
        res.json({ samples: result.rows });
    } catch (err) {
        res.json({ samples: [] });
    }
});

app.get('/api/activity/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 15, 100);
    try {
        const result = await pool.query(`
            SELECT * FROM activity_log
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);
        res.json({ events: result.rows });
    } catch (err) {
        res.json({ events: [] });
    }
});

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [keyPoolResult, statsResult] = await Promise.all([
            pool.query(`
                SELECT provider, model, donor_agent_id, total_uses, is_active
                FROM key_pool_stats
                ORDER BY total_uses DESC
                LIMIT 20
            `),
            pool.query('SELECT SUM(uses) as total_uses FROM key_pool_stats')
        ]);
        res.json({
            key_pool: keyPoolResult.rows,
            total_uses: statsResult.rows[0]?.total_uses || 0
        });
    } catch (err) {
        res.json({ key_pool: [], total_uses: 0 });
    }
});

app.get('/api/keys/stats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT provider, model, COUNT(*) as count, SUM(uses) as total_uses
            FROM key_pool_stats
            GROUP BY provider, model
        `);
        res.json({ stats: result.rows });
    } catch (err) {
        res.json({ stats: [] });
    }
});

// ---- Key Donation: add any AI to the network ----
// POST /api/keys/donate { provider, api_key, endpoint?, name? }
// provider: "openai", "anthropic", "google", "groq", "ollama", "llamacpp", or custom
// endpoint: optional custom URL (for self-hosted or non-standard providers)
app.post('/api/keys/donate', async (req, res) => {
    const { provider, api_key, endpoint, name, model } = req.body || {};

    if (!provider || !api_key) {
        return res.status(400).json({
            error: 'provider and api_key required',
            example: { provider: 'openai', api_key: 'sk-...', name: 'my-openai' },
            providers: ['openai', 'anthropic', 'google', 'groq', 'ollama', 'llamacpp', 'custom']
        });
    }

    try {
        // Check if provider exists, create if not
        let providerRow = await pool.query('SELECT * FROM ai_providers WHERE name = $1', [provider]);
        if (providerRow.rows.length === 0) {
            // Auto-configure known providers
            const defaults = {
                openai: { api_format: 'openai', default_endpoint: 'https://api.openai.com/v1', is_cloud: true },
                anthropic: { api_format: 'anthropic', default_endpoint: 'https://api.anthropic.com', is_cloud: true },
                google: { api_format: 'openai', default_endpoint: 'https://generativelanguage.googleapis.com/v1beta', is_cloud: true },
                groq: { api_format: 'openai', default_endpoint: 'https://api.groq.com/openai/v1', is_cloud: true },
                ollama: { api_format: 'openai', default_endpoint: 'http://localhost:11434/v1', is_cloud: false },
                llamacpp: { api_format: 'openai', default_endpoint: 'http://localhost:8080/v1', is_cloud: false },
            };
            const d = defaults[provider] || { api_format: 'openai', default_endpoint: endpoint || '', is_cloud: !!endpoint };
            await pool.query(
                'INSERT INTO ai_providers (name, display_name, api_format, default_endpoint, is_cloud, is_active) VALUES ($1, $2, $3, $4, $5, TRUE)',
                [provider, provider.charAt(0).toUpperCase() + provider.slice(1), d.api_format, d.default_endpoint, d.is_cloud]
            );
            providerRow = await pool.query('SELECT * FROM ai_providers WHERE name = $1', [provider]);
        }

        const prov = providerRow.rows[0];

        // If custom endpoint provided, update it
        if (endpoint) {
            await pool.query('UPDATE ai_providers SET default_endpoint = $1 WHERE id = $2', [endpoint, prov.id]);
        }

        // Insert the API key (encrypted)
        const keyName = name || `${provider}-donated`;
        const encryptedKey = encryptKey(api_key);
        await pool.query(
            'INSERT INTO ai_keys (provider_id, key_value, key_name, model, priority, is_active) VALUES ($1, $2, $3, $4, 10, TRUE)',
            [prov.id, encryptedKey, keyName, model || '*']
        );

        // Reload providers in the router
        await router.loadProviders();
        await router.loadKeys();

        console.log(`[KEYS] New key donated: ${provider} (${keyName})`);

        res.json({
            success: true,
            provider: provider,
            name: keyName,
            endpoint: endpoint || prov.default_endpoint,
            message: `Key added! ${provider} is now available to the network.`
        });
    } catch (err) {
        console.error('[KEYS] donate error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Body-based deactivation (the documented shape). The real work is the same
// ownership-scoped UPDATE the user-scoped endpoint does: a caller can only
// deactivate a key they own, so no user can revoke another user's key.
// Returns 401 without a session, 404 for a key that is not theirs — never
// "not implemented".
app.post('/api/keys/deactivate', requireAuth, csrfValidate, async (req, res) => {
    const { id, key_id } = req.body || {};
    const targetId = id || key_id;
    if (!targetId) {
        return res.status(400).json({ error: 'id (or key_id) required' });
    }
    try {
        const result = await pool.query(
            'UPDATE ai_keys SET is_active = FALSE WHERE id = $1 AND user_id = $2 RETURNING id',
            [targetId, req.session.userId]);
        if (result.rows.length === 0) {
            // Not theirs (or not there) — indistinguishable, deliberately.
            return res.status(404).json({ error: 'Key not found' });
        }
        // Drop it from the router immediately so the revocation is real, not
        // just a row that only takes effect on the next reload.
        try { await router.loadKeys(); } catch (_e) { /* next reload */ }
        res.json({ success: true, deactivated: true, id: targetId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agents/mine', async (req, res) => {
    res.json({ agents: [] });
});

app.get('/api/agents/:id/activity', async (req, res) => {
    res.json({ events: [] });
});

app.get('/api/activity/problem/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(`
            SELECT * FROM activity_log
            WHERE problem_id = $1
            ORDER BY created_at DESC
            LIMIT 50
        `, [id]);
        res.json({ events: result.rows });
    } catch (err) {
        res.json({ events: [] });
    }
});

app.post('/api/problems/submit', async (req, res) => {
    const { title, description, priority } = req.body;
    if (!title || !description) {
        return res.status(400).json({ error: 'Title and description required' });
    }
    try {
        const result = await pool.query(`
            INSERT INTO problems (title, description, priority, status, created_at)
            VALUES ($1, $2, $3, 'open', NOW())
            RETURNING id
        `, [title, description, priority || 0]);
        res.json({ success: true, problem_id: result.rows[0].id, queued: false, message: 'Problem submitted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const HIVVRouter = require('./lib/routes/hivv-routes');
app.use('/api/hivv', HIVVRouter);

// HIVV Dashboard API Routes
const DashboardRouter = require('./lib/routes/dashboard-routes');
app.use('/api/dashboard', DashboardRouter);

// Agent Protocol API Routes (registration, events, approvals)
const AgentRouter = require('./lib/routes/agent-routes');
app.use('/api/agents', AgentRouter);

// ===== Distributed AI Orchestration Engine =====
const Orchestrator = require('./lib/orchestrator');
const ControlRoutes = require('./routes/control-routes');
const InboxRoutes  = require('./routes/inbox-routes');
const TTSRoutes    = require('./routes/tts-routes');
const STTRoutes    = require('./routes/stt-routes');
const TranscriptionsRoutes = require('./routes/transcriptions-routes');

// Compute the CLI version the same way the CLI does: sha256 of the file content, first 8 hex chars.
function _cliVersion() {
  try {
    const fs = require('fs');
    const crypto = require('crypto');
    const cliPath = path.join(__dirname, '..', 'public_html', 'hivv-cli.py');
    const data = fs.readFileSync(cliPath);
    const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
    return `0.2.${hash}`;
  } catch (_e) {
    // Fallback: try to read CLI_VERSION static string
    try {
      const fs2 = require('fs');
      const src = fs2.readFileSync(path.join(__dirname, '..', 'public_html', 'hivv-cli.py'), 'utf8');
      const m = src.match(/^CLI_VERSION\s*=\s*["']([^"']+)["']/m);
      return m ? m[1] : '0.2.0';
    } catch (_e2) { return '0.2.0'; }
  }
}

const orch = new Orchestrator();
router.setOrchestrator(orch);
ControlRoutes.inject(orch);
app.use('/api/control', ControlRoutes);
InboxRoutes.inject(orch);
app.use('/api/agents', InboxRoutes);
app.use('/api/tts', TTSRoutes);
app.use('/api/stt', STTRoutes);
// OpenAI-compatible speech-to-text: POST /v1/audio/transcriptions
app.use('/v1/audio', TranscriptionsRoutes);

// File upload for /chat (multipart, pdf/docx/text extraction, TTL cleanup)
const FilesRoutes = require('./routes/files-routes');
app.use('/api/files', FilesRoutes);

// ---- HIVV_PLAN features: honey (#1), measured routing (#7), relay (#5), share cards (#6) ----
const honeyLib = require('./lib/honey');
const perfLib = require('./lib/perf');
const relayLib = require('./lib/relay');
const HoneyRoutes = require('./routes/honey-routes');
const RelayRoutes = require('./routes/relay-routes');

router.setPerf(perfLib);
router.setRelay(relayLib);
HoneyRoutes.inject(orch, usageTracker);
RelayRoutes.inject(orch);
 app.use('/api/hive', HoneyRoutes);
 app.use('/api/relay', RelayRoutes);

 const TipsRoutes = require('./routes/tips-routes');
 TipsRoutes.inject(pool);
 app.use('/api/tips', TipsRoutes);

// LYRz settlement: link a node to its LYRz identity and settle honey out to
// lyrz.org as a portable LYRz balance.
//
// Honey earned by a node also becomes a portable LYRz balance that follows
// the node across the ecosystem. Non-fatal by design: if LYRz is down the
// work stays queued locally and is retried.
const lyrzLib = require('./lib/lyrz');
lyrzLib.inject(pool);
const LyRzRoutes = require('./routes/lyrz-routes');
LyRzRoutes.inject(pool, lyrzLib);
app.use('/api/lyrz', LyRzRoutes);

 honeyLib.start(orch, pool);
perfLib.start(pool);

// The queue table must exist before honey starts accruing, otherwise the
// first accruals fail to enqueue. Create it up front and start the settler
// once it is ready.
const lyrzReady = lyrzLib.ensureQueueTable()
  .then(() => { lyrzLib.startSettlementLoop(); })
  .catch(e => console.error('[lyrz] bridge init failed:', e.message));

// ---- hivv OS: capability registry (§1) + policy gate (§3) + route modes (§2) ----
// Plan: HIVV_CAPABILITY_POLICY_PLAN.md — YES/MAYBE/NO before any action executes.
const capsLib = require('./lib/capabilities');
const policyLib = require('./lib/policy');
const sandboxLib = require('./lib/sandbox');
const ssrfLib = require('./lib/ssrf');
const toolkitLib = require('./lib/toolkit');
const toolStreamLib = require('./lib/tool-stream');
const memoryLib = require('./lib/memory');
const CapabilityRoutes = require('./routes/capability-routes');
const PolicyRoutes = require('./routes/policy-routes');
const DatabaseRoutes = require('./routes/database-routes');
const ToolRoutes = require('./routes/tool-routes');
capsLib.init(pool);
policyLib.init(pool);
memoryLib.init(pool);
toolkitLib.inject(router);
router.setCapabilities(capsLib);
router.setPolicy(policyLib);
CapabilityRoutes.inject(orch, router);
PolicyRoutes.inject(orch);
DatabaseRoutes.inject(pool);
ToolRoutes.inject(orch, router);
app.use('/api/capabilities', CapabilityRoutes);
app.use('/api/policy', PolicyRoutes);
app.use('/api/database', DatabaseRoutes);
// The tool surface: the catalog + invocation. The old inline handlers in
// this file were removed — api/routes/tool-routes.js owns them now, and it
// runs the ONE implementation in api/lib/toolkit.js.
app.use('/api/tools', ToolRoutes);

// Operator-facing request provenance ledger (who asked, which node answered,
// when, how long, what it cost). Views are gated by control-token/admin.
const ProvenanceRoutes = require('./routes/provenance-routes');
app.use('/api/provenance', ProvenanceRoutes);

// The purpose benchmark ("does this help all life on Earth?") — public, no auth,
// and it MUST answer with no database attached (local-first). This is the
// machine-readable twin of /purpose.html; if the two ever disagree, the API
// is right and the page is a bug.
const PurposeRoutes = require('./routes/purpose-routes');
PurposeRoutes.inject(pool);
app.use('/api/purpose', PurposeRoutes);

// PUBLIC PARTNER SURFACE — the stable, versioned integration API for any
// website, agent, or tool that wants to use HIVV (not just OpenCode).
const PartnerRoutes = require('./routes/partner-routes');
PartnerRoutes.inject(pool, router, orch, capsLib);
app.use('/api/partner', PartnerRoutes);

// HIVE-TO-HIVE BRIDGE (open-hives/0.1) — how busy is this hive, and how much
// of our traffic may a peer hive use right now. Two public GETs, memory-only,
// so another hive's 60s poll costs us nothing measurable.
const BridgeRoutes = require('./routes/bridge-routes');
BridgeRoutes.inject(pool, router, orch);
app.use('/api/bridge', BridgeRoutes);

// THE MUSIC TESTS — humans vote on the musical taste of various AIs so
// other humans can pick their AI by vibe. Two cheap routes (see
// music-routes.js); the roster itself is a static file.
const MusicRoutes = require('./routes/music-routes');
MusicRoutes.inject(pool);
app.use('/api/music', MusicRoutes);

// THE YALLA PROTOCOL — the hive's first living sensor: crowd-sensed dog
// sightings, mapped as paws. Phase 2 (GPS collar feed) posts to the same
// table. See /yalla/.
const DogRoutes = require('./routes/dog-routes');
DogRoutes.inject(pool);
app.use('/api/dog', DogRoutes);

// THE EARTH SENSOR — first organs: temperature, pressure, wind, humidity
// (cheap pulse; xyzo.org holds the deep atlas). Double-duty: search planning
// AND understanding Yalla (dogs feel barometric pressure).
const EarthRoutes = require('./routes/earth-routes');
app.use('/api/earth', EarthRoutes);

// Capability discovery for OpenAI-compatible clients — one GET tells
// OpenCode/Continue/Cline/any script what HIVV adds on top of plain chat.
// Sits alongside /v1/models so a client that already probes /v1 finds it.
const CapabilityDiscovery = require('./routes/capability-discovery');
CapabilityDiscovery.inject(pool, router, capsLib);
app.use('/v1/capabilities', CapabilityDiscovery);

setInterval(() => policyLib.expireOldGrants().catch(() => {}), 3600000).unref();

// ---- HIVV_OPENCODE_PLAN §2: MCP server — hive tools for AI agents ----
// Remote Streamable HTTP at /mcp (Caddy proxies it). Stateless per-request;
// chat runs through the SAME router + policy gate as /api/chat.
const McpRoutes = require('./routes/mcp-routes');
McpRoutes.inject(orch, router);
app.use('/mcp', McpRoutes);

// ═══════════════════════════════════════════════════════════════════════════
// DEEPER TELEMETRY — spans, histograms, error taxonomy, SLOs, live series.
//
// The hive already had a health endpoint, a request ledger, a per-model EWMA
// and a live roster. This adds the layer that answers the questions those
// cannot: p99 latency, WHICH error class is growing, how deep the queues
// are, and whether we are burning the error budget.
//
// LOCAL-FIRST: with no database attached it still answers everything from
// memory. The database is a mirror, never a dependency.
const telemetryLib = require('./lib/telemetry');
const TelemetryRoutes = require('./routes/telemetry-routes');
TelemetryRoutes.inject(orch);
app.use('/api/telemetry', TelemetryRoutes);

// ═══════════════════════════════════════════════════════════════════════════
// THE TASK FOUNDATION — one queue for every kind of distributed work.
//
// The relay (inference jobs to NAT'd bees), the coder bees, the hive-to-hive
// bridge and A2A all need the same nine things: a pollable state machine,
// idempotency, priority, a TTL, LEASES so a dead worker loses nothing,
// retries, a budget, cancellation, and a receipt.
//
// One implementation, four skins. In-memory by default; Postgres mirrors it
// so a restart does not lose submitted work.
const taskQueueLib = require('./lib/task-queue');
taskQueueLib.start(pool);
telemetryLib.start(pool);

// ═══════════════════════════════════════════════════════════════════════════
// A2A (Agent2Agent v1.0) — HIVV as an A2A SERVER.
//
// MCP says "here are my tools"; A2A says "here is my agent, give it a task".
// We now answer both directions of both protocols: /mcp is the MCP server,
// /api/a2a is the A2A server, and lib/mcp-client.js + lib/a2a-client.js are
// the OUTBOUND halves (call another MCP server, give another agent a task).
//
// The policy gate is NOT bypassed: a denied action is TASK_STATE_REJECTED
// and an approval-needed action is TASK_STATE_AUTH_REQUIRED — never a
// silent failure.
const A2ARoutes = require('./routes/a2a-routes');
A2ARoutes.inject(orch, router, process.env.HIVV_PUBLIC_URL || 'https://hivv.org');
app.use('/api/a2a', A2ARoutes);

// The agent card. A2A v1.0 says /.well-known/agent-card.json (v0.2 said
// /.well-known/agent.json — a card is a card, so we serve both). Caddy
// serves the static copy at the well-known path; these routes serve the LIVE
// card for clients that ask the gateway directly.
const a2aCardHandler = (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(A2ARoutes.agentCard());
};
app.get('/agent-card.json', a2aCardHandler);
app.get('/.well-known/agent-card.json', a2aCardHandler);
app.get('/.well-known/agent.json', a2aCardHandler);

// ---- HIVV_OPENCODE_PLAN: dial — connect once, then direct to the bee ----
// `hivv dial` (localhost shim) dials for candidates, forwards each request
// straight to the bee, and reports back async — the hot path skips the hub.
const DialRoutes = require('./routes/dial-routes');
DialRoutes.inject(orch, router, perfLib);
app.use('/api/route', DialRoutes);

// ---- Cryptographic identity: Ed25519 bee bindings (lib/identity.js) ----
// Public read surface: which principal is bound to which bee, and a pure-crypto
// verify for third parties. The verification itself happens at register /
// heartbeat (dual-mode: legacy CLIs without an identity block are untouched).
const IdentityRoutes = require('./routes/identity-routes');
// GUARDED MOUNT: a route module that is half-written (a file being edited
// while the gateway restarts) must not take the whole hive offline. The
// nodes keep heartbeating into a gateway that is not listening — that is a
// terrible failure mode for a distributed network. If the module does not
// export what the wiring needs, the gateway says so LOUDLY and boots
// without that surface; everything else keeps working.
if (typeof IdentityRoutes.inject === 'function') {
    IdentityRoutes.inject(orch, pool);   // node records + optional trust persistence
    app.use('/api/identity', IdentityRoutes);

    // The offline party: if the hive crashes, gets hacked, or the world ends,
    // the bees meet in the same room. This is the signup for that.
    const PartyRoutes = require('./routes/party-routes');
    app.use('/api/party', PartyRoutes);
} else {
    console.warn('[identity] routes/identity-routes.js does not export inject() — ' +
                 '/api/identity is NOT mounted (the module is incomplete).');
}

// ---- HIVV_OPENCODE_PLAN §4: coder bees — dispatch jobs to nodes running OpenCode ----
// `hivv code "task" --repo <url>` → policy gate → coding_job into a volunteer's
// inbox → node clones, runs `opencode run --auto`, posts patch + summary back.
const CodingRoutes = require('./routes/coding-routes');
CodingRoutes.inject(orch);
app.use('/api/coding', CodingRoutes);

// ---- BLNQ trust layer: purpose-built signed code-safety scan ----
// blnq submits source here, gets back a structured verdict signed with HIVV's
// OWN Ed25519 key. The hub relays that signature but cannot forge it, which is
// what makes "this AI said it was safe" checkable by a third party.
const ScanRoutes = require('./routes/scan-routes');
ScanRoutes.inject(router);           // the AIRouter, for the LLM verdict
app.use('/api/scan', ScanRoutes);

// ---- hivv OS §3: MAYBE → PUSH into node-owner inboxes (backlog F2) ----
// A pending grant is not just a DB row to poll — the moment policy says MAYBE
// we enqueue an `approval_request` into every online node's long-poll inbox so
// `hivv up` nudges the operator (and a phone/one-tap approve can resume work).
// Fire-and-forget: a push failure must never block or slow the gate.
policyLib.setNotifier((grant, action) => {
  try {
    if (typeof orch.enqueueInbox !== 'function') return;
    const payload = {
      grant_id: grant.id,
      capability: grant.capability,
      principal: grant.principal,
      reason: grant.reason || null,
      args_summary: action && action.args_summary ? action.args_summary : (grant.args_summary || {}),
      requested_via: grant.requested_via || null,
      created_at: grant.created_at || new Date().toISOString(),
      approve_hint: `hivv approve ${grant.id}`,
    };
    const msg = { type: 'approval_request', payload };
    // Prefer the OWNER's node (the CLI that triggered the MAYBE sent x-hivv-node)
    // so the nudge lands on the operator's own machine. Fall back to a broadcast
    // across online nodes when the origin is unknown (e.g. web-dashboard visitors).
    const ownerNode = action && action.node;
    if (ownerNode && orch.nodes.has(ownerNode)) {
      const n = orch.nodes.get(ownerNode);
      if (n && n.status !== 'offline') {
        orch.enqueueInbox(ownerNode, msg);
        console.log(`[POLICY] MAYBE ${grant.id} pushed to owner inbox ${ownerNode}`);
        return;
      }
    }
    let pushed = 0;
    for (const [nodeId, node] of orch.nodes.entries()) {
      if (!node || node.status === 'offline') continue;
      orch.enqueueInbox(nodeId, msg);
      pushed++;
    }
    if (pushed) console.log(`[POLICY] MAYBE ${grant.id} broadcast to ${pushed} node inbox(es)`);
  } catch (e) {
    console.warn('[POLICY] approval push failed:', e.message);
  }
});


// ---- /api/version (public — used by `hivv start` nag) ----
app.get('/api/version', (req, res) => {
  res.json({ version: _cliVersion(), app: 'hivv', ts: Date.now() });
});

// ---- Node Registration ----
// ONE bee protocol (lib/bee-identity.js): the canonical id is `bee_id`, and it
// may arrive in the URL (HIVV style) or the body (BLNQ style).
//
// ANTI-SQUATTING: claiming an id the hub already knows requires proving it
// is that bee (its secret or its hw_id). Before this, anyone could POST a
// registration for "masjid" and inherit that bee's inbox, relay jobs and
// honey streak.
app.post('/api/nodes/register', async (req, res) => {
  try {
    const body = req.body || {};
    const bee = require('./lib/bee-identity');
    const proof = bee.readBeeProof(req);

    // Basic validation: must have an id and either hw_id or token
    if (!body.id && !body.token && !body.bee_id) {
      return res.status(400).json({ error: 'Node must provide id or token' });
    }
    if (!body.hw_id && !body.token) {
      return res.status(400).json({ error: 'Node must provide hw_id or token for identification' });
    }

    // Which id is this bee claiming?
    const claimed = bee.readBeeId(req, req.params);
    const requestedId = claimed.id || body.id || body.token;
    if (!bee.isValidBeeId(String(requestedId).toLowerCase())) {
      return res.status(400).json({
        error: 'bee id must be 3-64 chars: lowercase letters, digits, dot, underscore or dash',
        bee_id: requestedId,
      });
    }
    const beeId = String(requestedId).toLowerCase();
    // The ritual vocabulary belongs to the hive: fajr…isha, salah, wudu,
    // adhan, dua, hajj, jihad, moon, tongue… a bee may not claim them.
    if (bee.isReservedId(beeId)) {
      return res.status(400).json({
        error: 'bee id is reserved for the hive ritual layer',
        code: 'BEE_ID_RESERVED',
        bee_id: beeId,
        hint: 'these names belong to hivv ritual functions (salah, adhan, wudu, hajj…) — pick another name',
      });
    }

    // Capture the PREVIOUS identity before registerNode (which may rewrite
    // hw_id from this very request — comparing after would make any hw_id
    // trivially "match"). Used below to re-issue a secret the bee lost.
    const prev = orch.nodes.get(beeId) || orch.nodes.get(body.id);
    const prevHw = prev && prev.hw_id;
    const prevSecret = prev && prev.secret;

    // ANTI-SQUATTING: a known id must be proven.
    const auth = bee.authorizeClaim({
      existing: prev,
      requestedId: beeId,
      hwId: proof.hwId,
      secret: proof.secret,
      existingHwId: prevHw,
      existingSecret: prevSecret,
    });
    if (!auth.ok) {
      return res.status(409).json({
        error: auth.reason,
        code: auth.code,
        hint: 'present X-Node-Secret (or the bee_id/hw_id you enrolled with)',
      });
    }

    const node = orch.registerNode({ ...body, id: beeId, name: body.name || beeId });
    // Enrol the per-node secret used to gate inbox access (adopts the bee's
    // value, or issues one the bee picks up on its next heartbeat).
    const regSecretBefore = node.secret, regSeenBefore = node.secret_seen;
    const reg = require('./lib/node-auth').enroll(node, proof.secret);
    if (!reg.ok) return res.status(403).json({ error: 'Invalid node secret' });
    // Recovery: a bee that already enrolled but lost its local copy (state
    // wipe) presents NO secret — the hub won't re-issue to `secret_seen` bees,
    // bricking its inbox (403 on every poll) forever. Re-issue when the caller
    // proves the machine via the SAME hw_id it enrolled with (hw_id is not
    // exposed by any API — knowledge of it is the enrollment credential).
    let issue = reg.issue;
    if (!issue && !proof.secret && prev && prevHw &&
        prev.secret && prev.secret_seen && proof.hwId === prevHw) {
      issue = node.secret;
      console.log(`[NODE-AUTH] ${node.node_id}: secret re-issued (lost local copy, hw_id proven)`);
    }
    // Persist enrolment IMMEDIATELY — the heartbeat path only saves on a 10s
    // debounce, and a gateway restart inside that window drops the secret (the
    // hub then signs repair plans with a key the bee doesn't hold).
    if (node.secret !== regSecretBefore || node.secret_seen !== regSeenBefore) {
      try { orch._saveNodes(); } catch (_e) {}
    }

    // -- Ed25519 identity (dual-mode) ---------------------------------
    // No identity block -> untouched (legacy CLIs). A PRESENT block must
    // verify: this is the moment a node_id gets bound to a key, so a forged
    // or replayed claim is refused here (403 IDENTITY_INVALID). Clock skew
    // alone is advisory (recorded, not fatal) -- a bad clock is a health
    // problem, not an attack. Legacy proof (secret/hw_id) allows the key to
    // be REPLACED (recovery + rotation anchor).
    //
    // ENFORCEMENT (opt-in, HIVV_IDENTITY_ENFORCE=1): unsigned registration
    // is refused outright — the flag an operator flips once the fleet has
    // keys (all current bees do).
    if (require('./lib/identity').enforcementRequired() && !body.identity) {
      return res.status(403).json({
        error: 'this hive requires signed registration',
        code: 'IDENTITY_REQUIRED',
        hint: 'upgrade the bee CLI (hivv update) — every register must carry an Ed25519 identity block',
      });
    }
    let idv = null;
    if (body.identity) {
      const identity = require('./lib/identity');
      idv = identity.verifyIncoming({
        nodeId: beeId,
        identity: body.identity,
        kind: 'node.register',
        legacyProof: !!(proof.secret || proof.hwId),
      });
      if (!idv.ok) {
        // A revoked key presenting itself is an EVENT worth an incident
        // (deduped to one active row per node).
        if (idv.problems.some((p) => p.startsWith('revoked:'))) {
          const revProblem = idv.problems.find((p) => p.startsWith('revoked:'));
          pool.query(`
            INSERT INTO hivv_incidents (incident_type, severity, state, node_id, title, description)
            SELECT 'identity_revoked', 'high', 'active', $1::varchar, $2::text, $3::text
            WHERE NOT EXISTS (
              SELECT 1 FROM hivv_incidents
              WHERE node_id = $1::varchar AND incident_type = 'identity_revoked' AND state = 'active')`,
            [beeId, 'identity revoked: ' + beeId, revProblem])
            .catch((err) => console.error('[IDENTITY] incident error: ' + err.message));
        }
        return res.status(403).json({
          error: 'identity verification failed',
          code: 'IDENTITY_INVALID',
          problems: idv.problems,
          hint: idv.problems.some((p) => p.startsWith('revoked:'))
            ? 'this key is on the CRL — rotate to a fresh key (hivv identity rotate) and rebind with legacy proof'
            : "the presented Ed25519 statement did not verify - check the bee's clock, key files (hivv identity status), and that the statement covers THIS node_id",
        });
      }
      // The signed statement must cover the hw_id this request presents —
      // otherwise a captured identity block could be replayed with a
      // DIFFERENT machine id while still carrying a valid signature.
      const stmtHw = body.identity.statement && body.identity.statement.hw_id_sha256;
      if (stmtHw && proof.hwId) {
        const hwHash = require('crypto').createHash('sha256')
          .update(String(proof.hwId)).digest('hex');
        if (hwHash !== stmtHw) {
          return res.status(403).json({
            error: 'identity verification failed',
            code: 'IDENTITY_INVALID',
            problems: ['hw_id presented in the body is not covered by the signature (hw_id_sha256 mismatch)'],
            hint: 'the statement must hash the same hw_id the request presents',
          });
        }
      }
      if (idv.advisory && idv.advisory.length) {
        console.log('[IDENTITY] ' + beeId + ': register accepted with advisory: ' + idv.advisory.join('; '));
      }
    }
    const idSummary = body.identity
      ? require('./lib/identity').publicSummary(beeId, idv) : null;

    // -- Signed capability manifest (Phase 2): same contract at register --
    let mf = null;
    if (body.capability_manifest) {
      const identity = require('./lib/identity');
      mf = identity.verifyManifest({ nodeId: beeId, manifest: body.capability_manifest });
      if (mf.ok) {
        node.tools = mf.applied.tools;
        node.tools_port = mf.applied.tools.length ? (mf.applied.tools_port || 0) : 0;
        node.local_models = mf.applied.local_models;
        if (mf.applied.capabilities.length) node.capabilities = mf.applied.capabilities;
        node.volunteer = mf.applied.volunteer;
      } else {
        console.log('[IDENTITY] ' + beeId + ': register manifest refused: ' + (mf.problems || []).join('; '));
      }
    }
    const mfSummary = body.capability_manifest
      ? Object.assign(
          { status: (mf && mf.ok) ? 'verified' : 'failed',
            seq: (mf && mf.ok) ? mf.statement.seq : null },
          (mf && !mf.ok) ? { reason: (mf.problems || [])[0] } : {})
      : null;

    res.json({ node_id: node.node_id, bee_id: node.node_id,
               role: node.name, ip: node.ip, registered: true,
               ...(issue ? { node_secret: issue } : {}),
               ...(idSummary ? { identity: idSummary } : {}),
               ...(mfSummary ? { manifest: mfSummary } : {}) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Node error reporting ----
// A node's local errors (agent crash, local model failure, disk full) are
// invisible to the hub unless the node reports them. This endpoint lets a
// bee push its local error log entries here, authenticated with its own
// secret, so an operator can study "what is broken on yalla" from anywhere.
//
// The payload is bounded and scrubbed: no prompts, no key material, no raw
// stack traces over ~2kb per entry.
app.post('/api/nodes/:id/errors', async (req, res) => {
  try {
    const bee = require('./lib/bee-identity');
    const claimed = bee.readBeeId(req, req.params);
    const beeId = claimed.id || req.params.id;
    const node = orch.nodes.get(beeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    const proof = bee.readBeeProof(req);
    const auth = require('./lib/node-auth').enroll(node, proof.secret);
    if (!auth.ok) return res.status(403).json({ error: 'Invalid node secret' });

    const entries = Array.isArray(req.body?.errors) ? req.body.errors : [];
    if (!entries.length) {
      return res.status(400).json({ error: 'errors array required' });
    }

    let recorded = 0;
    for (const e of entries.slice(0, 20)) {
      if (!e || typeof e !== 'object') continue;
      errorLog.record({
        error: e.message || 'reported by node',
        error_class: e.class || undefined,
        endpoint: e.endpoint || `node:${beeId}`,
        model: e.model || null,
        node: beeId,
        status: e.status || null,
        input_tokens: e.input_tokens || null,
        output_tokens: e.output_tokens || null,
        context_window: e.context_window || null,
        max_tokens: e.max_tokens || null,
        trimmed: e.trimmed === true,
        dropped: e.dropped || null,
        user_agent: e.user_agent || `hivv-node/${beeId}`,
        extra: { reported_by: beeId, local_ts: e.ts || null },
      });
      recorded++;
    }
    res.json({ ok: true, recorded, node_id: beeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Heartbeat (requires proof of identity) ----
// ONE bee protocol: the id may be in the URL (`/api/nodes/{bee_id}/heartbeat`)
// or in the body (`{bee_id}` or `{worker_id}` — the BLNQ shape). The body wins
// on conflict because the body is what the bee signs over.
app.post('/api/nodes/:id/heartbeat', (req, res) => {
  const bee = require('./lib/bee-identity');
  const claimed = bee.readBeeId(req, req.params);
  const beeId = claimed.id || req.params.id;
  const node = orch.nodes.get(beeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  // Enrol/verify the per-node secret (see lib/node-auth.js). Adopt when absent,
  // verify with a timing-safe compare once the bee has proven it knows one.
  const hbSecretBefore = node.secret, hbSeenBefore = node.secret_seen;
  const hbProof = bee.readBeeProof(req);
  const hbAuth = require('./lib/node-auth').enroll(node, hbProof.secret);
  if (!hbAuth.ok) return res.status(403).json({ error: 'Invalid node secret' });
  // Persist enrolment immediately (see the same reasoning at /register):
  // losing `secret`/`secret_seen` in the 10s debounce window makes the hub
  // sign plans with a key the bee doesn't hold → "signature mismatch".
  if (node.secret !== hbSecretBefore || node.secret_seen !== hbSeenBefore) {
    try { orch._saveNodes(); } catch (_e) {}
  }
  // Capture public IP from the request (this is the IP as seen from the internet)
  const public_ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  const updated = orch.updateHeartbeat(beeId, req.body || {}, { public_ip });
  if (!updated) return res.status(404).json({ error: 'Node not found' });
  // Quarantined (crash-loop auto-stop or operator action): accept the poll
  // politely but change NOTHING — no metric updates, no incident auto-resolve,
  // no task handout — until a human runs `hivv quarantine <bee> --release`.
  if (updated.quarantined) {
    return res.json({ ok: true, quarantined: true,
      note: 'quarantined — ignored by the hive until a human releases it' });
  }

  // ── SALAH: a heartbeat inside a regional prayer window IS the report ───
  // (HIVV_RITUAL_PLAN.md #1 — the bee already speaks every 60s; the hub
  // just listens at the right instants). Never break a heartbeat over it:
  // any error → skip silently; a mark persists via the next _saveNodes.
  try {
    const att = require('./lib/attendance');
    const marked = att.mark(updated, Date.now());
    if (marked) {
      try { orch._saveNodes(); } catch (_e) {}
      console.log('[SALAH] ' + beeId + ': ' + marked.prayer +
                  ' (' + marked.day + ') ' + marked.count + '/5');
    }
  } catch (_e) {}

  // -- Ed25519 identity (ADVISORY at heartbeat) ------------------------
  // Existing bees resume without re-registering, so the first
  // identity-bearing heartbeat is the BINDING moment for the fleet. A
  // failing signature is recorded and echoed back (status 'failed'/'mismatch'
  // so the bee can rebind) but NEVER rejects the heartbeat: a broken signer
  // must not knock its own bee offline. Quarantined bees stay inert (above).
  //
  // ENFORCEMENT (opt-in, HIVV_IDENTITY_ENFORCE=1): unsigned heartbeats are
  // refused too — full enforcement, not just at the register door.
  if (require('./lib/identity').enforcementRequired() &&
      !(req.body && req.body.identity)) {
    return res.status(403).json({
      error: 'this hive requires signed heartbeats',
      code: 'IDENTITY_REQUIRED',
      hint: 'upgrade the bee CLI (hivv update) — every heartbeat must carry an Ed25519 identity block',
    });
  }
  let hbIdv = null;
  if (req.body && req.body.identity) {
    const identity = require('./lib/identity');
    hbIdv = identity.verifyIncoming({
      nodeId: beeId,
      identity: req.body.identity,
      kind: 'node.heartbeat',
    });
    if (!hbIdv.ok) {
      console.log('[IDENTITY] ' + beeId + ': heartbeat identity recorded (not rejected): ' + (hbIdv.problems || []).join('; '));
      if (hbIdv.problems.some((p) => p.startsWith('revoked:'))) {
        const revProblem = hbIdv.problems.find((p) => p.startsWith('revoked:'));
        pool.query(`
          INSERT INTO hivv_incidents (incident_type, severity, state, node_id, title, description)
          SELECT 'identity_revoked', 'high', 'active', $1::varchar, $2::text, $3::text
          WHERE NOT EXISTS (
            SELECT 1 FROM hivv_incidents
            WHERE node_id = $1::varchar AND incident_type = 'identity_revoked' AND state = 'active')`,
          [beeId, 'identity revoked: ' + beeId, revProblem])
          .catch((err) => console.error('[IDENTITY] incident error: ' + err.message));
      }
    }
  }
  const hbIdSummary = (req.body && req.body.identity)
    ? require('./lib/identity').publicSummary(beeId, hbIdv) : null;

  // -- Signed capability manifest (Phase 2) ------------------------------
  // tools/local_models/capabilities were SELF-REPORTED with zero
  // verification. A manifest signed by the BOUND key makes the advertisement
  // attributable, and the SIGNED values overwrite the unsigned body fields.
  // Advisory like everything at heartbeat: a failing manifest is recorded
  // and echoed (status 'failed') but never grounds to reject the bee.
  let mf = null;
  if (req.body && req.body.capability_manifest) {
    const identity = require('./lib/identity');
    mf = identity.verifyManifest({ nodeId: beeId, manifest: req.body.capability_manifest });
    if (mf.ok) {
      node.tools = mf.applied.tools;
      node.tools_port = mf.applied.tools.length ? (mf.applied.tools_port || 0) : 0;
      node.local_models = mf.applied.local_models;
      if (mf.applied.capabilities.length) node.capabilities = mf.applied.capabilities;
      node.volunteer = mf.applied.volunteer;
    } else {
      console.log('[IDENTITY] ' + beeId + ': manifest refused: ' + (mf.problems || []).join('; '));
    }
  }
  const mfSummary = (req.body && req.body.capability_manifest)
    ? Object.assign(
        { status: (mf && mf.ok) ? 'verified' : 'failed',
          seq: (mf && mf.ok) ? mf.statement.seq : null },
        (mf && !mf.ok) ? { reason: (mf.problems || [])[0] } : {})
    : null;

  // Auto-resolve stale/offline incidents when node comes back
  pool.query(`
      UPDATE hivv_incidents
      SET state = 'resolved', resolved_at = NOW(),
          resolution_notes = 'Node heartbeat received — automatic resolution'
      WHERE node_id = $1
        AND state = 'active'
        AND incident_type IN ('node_offline', 'node_stale', 'node_restart_loop')
  `, [req.params.id]).catch(err => console.error('[INCIDENT] Auto-resolve error:', err.message));

  // Repair plan outcome echoed back on the heartbeat (see bee: _apply_repair).
  // Phase 3: the report may carry a SIGNED execution receipt — the bee's own
  // testimony, verified against its bound key, kept in the receipt ring.
  if (req.body && req.body.repair_report) {
    const rr = { ...req.body.repair_report };
    if (rr.receipt) {
      const identity = require('./lib/identity');
      const rc = identity.verifyReceipt({ nodeId: beeId, receipt: rr.receipt });
      rr.receipt_verified = rc.ok;
      if (rc.ok) {
        rr.receipt_id = rc.receipt.receipt_id;
        console.log('[RECEIPT] ' + beeId + ': ' + rc.receipt.op + ' → ' + rc.receipt.result +
                    ' (' + rc.receipt.receipt_id.slice(0, 8) + '…)');
      } else {
        rr.receipt_error = (rc.problems || [])[0];
        console.log('[IDENTITY] ' + beeId + ': repair receipt refused: ' + (rc.problems || []).join('; '));
      }
      delete rr.receipt;   // the verified record lives in the ring, not here
    }
    node.last_repair = rr;
    console.log(`[REPAIR] ${req.params.id} report: ${JSON.stringify(rr)}`);
  }

  // Check for queued tasks assigned to this node
  const queued = orch.getQueuedTasks({ role: undefined, limit: 10 })
    .filter(t => t.status === 'pending' && !t.assigned_to);
  // Keep handing the secret out until the bee proves it knows one — a bee
  // running an older build (which ignored the first issuance) would otherwise
  // never be able to enrol. Once `secret_seen` it stops appearing here, and
  // from that point inbox access requires presenting it.
  res.json({ accepted: true, status: updated.status, queued_tasks: queued.slice(0,10),
             ...((hbAuth.issue || (node.secret && !node.secret_seen)) ? { node_secret: node.secret } : {}),
             ...(hbIdSummary ? { identity: hbIdSummary } : {}),
             ...(mfSummary ? { manifest: mfSummary } : {}) });
});

// ---- Work Status Update (what is this node working on?) ----
app.post('/api/nodes/:id/work-status', (req, res) => {
  const node = orch.nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  if (!require('./lib/node-auth').verify(node, req.headers['x-node-secret']).ok) {
    return res.status(403).json({ error: 'Invalid node secret' });
  }
  const { work_status, problem_id } = req.body || {};
  if (!work_status || work_status.length > 280) {
    return res.status(400).json({ error: 'work_status required, max 280 chars' });
  }
  orch.updateHeartbeat(req.params.id, {
    work_status: work_status.trim(),
    current_problem_id: problem_id || null
  });
  res.json({ ok: true, work_status: work_status.trim(), problem_id: problem_id || null });
});

// ---- Collaboration Feed (what is the hive working on?) ----
app.get('/api/collaboration/feed', (req, res) => {
  const all = Array.from(orch.nodes.values()).filter(n => n.status !== 'offline');
  const feed = all
    .filter(n => n.work_status && n.work_status.length > 0)
    .sort((a, b) => (b.last_status_update || 0) - (a.last_status_update || 0))
    .slice(0, 50)
    .map(n => ({
      node_id: n.node_id,
      name: n.name,
      work_status: n.work_status,
      problem_id: n.current_problem_id,
      last_update: n.last_status_update,
      uptime_seconds: n.uptime_seconds,
      tasks_completed: n.tasks_completed,
      location: n.ip
    }));
  res.json({ total: feed.length, items: feed });
});

// POST /api/nodes/:id/tools — announce/update tool availability
app.post('/api/nodes/:id/tools', (req, res) => {
  const node = orch.nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { tools = [], port = 18789 } = req.body || {};
  node.tools = tools;
  node.tools_port = port;
  console.log(`[ORCH] Node ${req.params.id} shared tools: ${tools.join(', ')} on port ${port}`);
  res.json({ ok: true, tools, port });
});

// NOTE: GET /api/tools, GET /api/tools/catalog and GET|POST
// /api/tools/:tool/invoke used to live here. They moved to
// api/routes/tool-routes.js, which runs the ONE implementation in
// api/lib/toolkit.js — the old inline copies could drift from the bee-side
// implementation and from each other, and they did.

// POST /api/sandbox/exec — isolated code execution (capability: coding.execute).
// hivv OS §1: autonomous code NEVER runs on the host. It passes the policy gate
// first (deny → 403, ask/MAYBE → 202 pending grant), then executes in an
// ephemeral docker/bwrap sandbox (no network, RAM/CPU/pids quotas, read-only,
// dropped caps, restricted syscalls, hard timeout). Every run is audited.
app.post('/api/sandbox/exec', express.json({ limit: '512kb' }), async (req, res) => {
  const { code, language = 'python', timeout_ms } = req.body || {};
  const session = await getSession(req);
  const principal = session?.userId ? `user:${session.userId}` : getVisitorId(req, res);
  let gateReceipt = null;
  try {
    const g = await policyLib.gate({
      capability: 'coding.execute',
      principal,
      transport: 'sandbox',
      args_summary: { language, code_bytes: Buffer.byteLength(String(code || '')) },
      reason: 'hivv exec (sandboxed code execution)',
    });
    gateReceipt = g;
    if (g.verdict === 'deny') {
      return res.status(403).json({ verdict: 'NO', capability: 'coding.execute', rule: g.rule, error: `policy refused coding.execute — ${g.rule}` });
    }
    if (g.verdict === 'ask') {
      return res.status(202).json({
        verdict: 'MAYBE', capability: 'coding.execute', grant_id: g.grant_id, rule: g.rule,
        message: `human approval required — approve with: hivv approve ${g.grant_id}`,
      });
    }
  } catch (e) {
    // Fail CLOSED for code execution — unlike chat, we never run code if the
    // gate itself errored.
    return res.status(503).json({ error: `policy gate unavailable — refusing to execute code: ${e.message}` });
  }
  if (!sandboxLib.runtime()) {
    return res.status(503).json({ error: 'no sandbox runtime (docker daemon or bwrap) available — refusing to run code on the host' });
  }
  const started = Date.now();
  try {
    const result = await sandboxLib.execute({ code, language, timeoutMs: timeout_ms });
    if (gateReceipt) res.setHeader('X-Hivv-Policy', `ALLOW ${gateReceipt.rule}`);
    res.setHeader('X-Hivv-Sandbox', result.runtime || 'none');
    // audit the execution outcome into the hash-chained ledger
    try {
      await policyLib.audit({
        actor: principal,
        action: { capability: 'coding.execute', kind: 'exec', language, code_bytes: Buffer.byteLength(String(code || '')), exit: result.exitCode, timed_out: !!result.timedOut },
        verdict: result.ok ? 'allow' : 'deny', rule: `sandbox:${result.runtime}`, risk: 1,
      });
    } catch {}
    res.json({ ok: !!result.ok, language, runtime: result.runtime, exit_code: result.exitCode, timed_out: !!result.timedOut, stdout: result.stdout || '', stderr: result.stderr || '', refused: !!result.refused, error: result.error || null, ms: Date.now() - started });
  } catch (e) {
    res.status(500).json({ error: `sandbox failure: ${e.message}` });
  }
});

// GET /api/sandbox/status — is an isolated runtime present? (public, no code run)
app.get('/api/sandbox/status', (req, res) => {
  res.json({ runtime: sandboxLib.runtime(), docker: sandboxLib.dockerAvailable(), bwrap: sandboxLib.bwrapAvailable(), limits: sandboxLib.LIMITS, languages: Object.keys(sandboxLib.LANGS) });
});

// ── error log: what is breaking, right now ────────────────────────────────
// The diagnostic surface for `hivv problems` and `hivv bug`. In-memory only
// (cleared on restart) — the durable record is request provenance.
app.get('/api/errors/summary', (req, res) => {
    const windowSec = Math.min(Math.max(parseInt(req.query.window, 10) || 3600, 60), 86400);
    res.json({
        data: errorLog.summary({ windowMs: windowSec * 1000 }),
        meta: { version: 'v1', timestamp: new Date().toISOString() },
    });
});

app.get('/api/errors/recent', (req, res) => {
    const rows = errorLog.recent({
        limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500),
        cls: req.query.class || null,
        endpoint: req.query.endpoint || null,
        client: req.query.client || null,
        node: req.query.node || null,
        sinceMs: req.query.since ? Number(req.query.since) : null,
    });
    // Attach the human-readable diagnosis so a CLI or AI gets advice, not
    // just a stack trace.
    const data = rows.map((e) => ({ ...e, diagnosis: errorLog.diagnose(e) }));
    res.json({
        data,
        meta: { version: 'v1', timestamp: new Date().toISOString(), total: data.length },
    });
});

// POST /api/feedback — submit feedback (suggestion, complaint, help_request, bug, praise)
app.post('/api/feedback', async (req, res) => {
  const visitorId = getVisitorId(req, res);
  const session = await getSession(req);
  const { type = 'other', subject, message, target, evidence, severity } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const validTypes = ['suggestion', 'complaint', 'help_request', 'bug', 'praise', 'other'];
  const feedbackType = validTypes.includes(type) ? type : 'other';
  const validSev = ['low', 'medium', 'high', 'critical'];
  const sev = validSev.includes(severity) ? severity : null;
  let nodeId = null;
  try {
    const statePath = path.join(os.homedir(), '.config/hivv/state.json');
    const stateData = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
    nodeId = stateData.node_id || null;
  } catch(_){}
  try {
    const result = await pool.query(
      `INSERT INTO hivv_feedback (visitor_id, user_id, node_id, type, subject, message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, type, subject, message, status, created_at`,
      [visitorId, session?.userId || null, nodeId,
       feedbackType, subject || null, message.trim(),
       // `target` is the node/user/content being flagged; `evidence` is any
       // bounded supporting detail (ids, timestamps, log lines). Both are
       // stored in metadata so the feedback row itself stays unchanged for
       // older consumers.
       JSON.stringify({
         hostname: os.hostname(),
         ...(target ? { target: String(target).slice(0, 200) } : {}),
         ...(evidence ? { evidence: String(evidence).slice(0, 4000) } : {}),
         ...(sev ? { severity: sev } : {}),
       })]
    );
    res.json({ ok: true, feedback: result.rows[0] });
  } catch(e) {
    console.error('[FEEDBACK] insert error:', e.message);
    res.status(500).json({ error: 'could not save feedback' });
  }
});

// GET /api/feedback — list feedback submitted by this visitor/user
app.get('/api/feedback', async (req, res) => {
  const visitorId = getVisitorId(req, res);
  const session = await getSession(req);
  const userFilter = session?.userId
    ? `AND (visitor_id = $1 OR user_id = $2)`
    : `AND visitor_id = $1`;
  const params = session?.userId ? [visitorId, session.userId] : [visitorId];
  try {
    const result = await pool.query(
      `SELECT id, type, subject, message, status, created_at
       FROM hivv_feedback
       WHERE 1=1 ${userFilter}
       ORDER BY created_at DESC
       LIMIT 50`,
      params
    );
    res.json({ total: result.rows.length, items: result.rows });
  } catch(e) {
    console.error('[FEEDBACK] list error:', e.message);
    res.status(500).json({ error: 'could not retrieve feedback' });
  }
});

// ---- Fetch Tasks (per-node) ----
app.get('/api/nodes/:id/tasks', (req, res) => {
  const node = orch.nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const available = orch.getQueuedTasks({ role: req.query.role, limit: parseInt(req.query.limit) || 10 });
  res.json({ node_id: node.node_id, tasks: available, count: available.length });
});

// ---- Submit Result ----
app.post('/api/nodes/:id/results', (req, res) => {
  const node = orch.nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const result = req.body;
  if (result.job_id || result.task_id) {
    orch.handleTaskSuccess(result.job_id || result.task_id, result);
  }
  node.tasks_completed++;
  node.total_tokens_processed += (result.tokens_in||0) + (result.tokens_out||0);
  res.json({ accepted: true });
});

// ---- Task Dispatch (internal gateway → node) ----
app.post('/api/nodes/:id/dispatch', (req, res) => {
  const task = req.body;
  console.log(`[ORCH] Task dispatched via direct POST: ${task.id} type=${task.type}`);
  // Track as running
  orch.handleTaskSuccess(task.id || crypto.randomUUID().slice(0,8), { content: 'dispatched', tokens_in: 0, tokens_out: 0 });
  res.json({ received: true });
});

// ---- Streaming (client-facing) ----
app.post('/api/stream/create', (req, res) => {
  const taskId = orch.enqueueTask({
    type: 'streaming',
    payload: req.body,
    source: 'web'
  });
  res.json({ task_id: taskId, status: 'queued' });
});

app.get('/api/stream/:id/sse', (req, res) => {
  const { id } = req.params;
  // Find a stream-capable node
  const node = orch.selectNode('streaming');
  if (!node) return res.status(503).json({ error: 'No stream nodes available' });
  const http = require('http');
  const opts = { hostname: node.ip, port: 8899, path: `/consume/sse?id=${id}`, method: 'GET' };
  res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no' });
  const proxyReq = http.request(opts, pRes => {
    pRes.on('data', chunk => res.write(chunk));
    pRes.on('end', () => res.end());
  });
  proxyReq.on('error', () => { res.write(`event: error\ndata: {"message":"Stream node unreachable"}\n\n`); res.end(); });
  proxyReq.setTimeout(300000);
  proxyReq.end();
  req.on('close', () => proxyReq.destroy());
});

// ---- Think / Inference (client-facing) ----
app.post('/api/think/submit', (req, res) => {
  const { model, prompt, context, options } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const taskId = orch.enqueueTask({
    type: 'inference',
    model,
    payload: { messages: [...(context||[]), { role:'user', content: prompt }] },
    options,
    source: 'web'
  });
  res.json({ task_id: taskId, status: 'queued' });
});

app.get('/api/think/:id/result', (req, res) => {
  const task = orch.tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json(task);
});

app.get('/api/think/:id/sse', (req, res) => {
  const { id } = req.params;
  const node = orch.selectNode('inference');
  if (!node) return res.status(503).json({ error: 'No compute nodes available' });
  const http = require('http');
  const opts = { hostname: node.ip, port: 8899, path: `/consume/sse?id=${id}`, method: 'GET' };
  res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no' });
  const proxyReq = http.request(opts, pRes => {
    pRes.on('data', chunk => res.write(chunk));
    pRes.on('end', () => res.end());
  });
  proxyReq.on('error', () => { res.write(`event: error\ndata: {"message":"Compute node unreachable"}\n\n`); res.end(); });
  proxyReq.setTimeout(300000);
  proxyReq.end();
  req.on('close', () => proxyReq.destroy());
});

// ---- Local Node & Smart Spare-Time Management ----
app.post('/api/nodes/configure', async (req, res) => {
    const { ip, port, model_name } = req.body || {};
    if (!ip || !port) return res.status(400).json({ error: 'IP and port required' });

    try {
        const url = `http://${ip}:${port}/v1/models`;
        await fetch(url, { signal: AbortSignal.timeout(3000) });
        
        const discoveryEndpoint = {
            probeUrl: url,
            url: `http://${ip}:${port}/v1/chat/completions`,
            name: `user-node-${ip}`,
            provider: 'custom',
            allowDonation: true // SMART DEFAULT: Donate spare time!
        };
        
        router.localEndpoints.push(discoveryEndpoint);
        console.log(`[SPARE-TIME] Added ${ip}:${port} for smart donation.`);
        res.json({ success: true, message: 'Node registered for smart donation.' });
    } catch(e) {
        res.status(500).json({ error: 'Could not reach node or verify AI endpoint.' });
    }
});


// ---- OMNI: Universal Endpoint (single route for ALL AI) ----
const OmniEngine = require('./lib/omni-engine');
const omni = new OmniEngine();
app.all('/omni', (req, res) => { omni.handle(req, res); });
app.get('/omni/stats', (req, res) => { res.json(omni.getStats()); });



// ---- Export for other modules ----
module.exports.distributedState = { orchestrator: orch };
const finalExports = {
    getSession, getVisitorId, createSession, pool,
    SESSION_TTL, ANONYMOUS_TTL, sessions: sessionCache,
    anonymousSessions, csrfValidate, requireAuth,
    orchestrator: orch
};
module.exports = finalExports;

initialize().catch(console.error);

// ── Error logging middleware ────────────────────────────────────────
app.use((err, req, res, next) => {
    const ts = new Date().toISOString();

    // "entity too large" is a CLIENT error with a specific fix — not a 500.
    // OpenCode and other agent clients send big prompts; the operator needs
    // to know the limit, not see "Internal server error".
    const isTooLarge = err.type === 'entity.too.large'
        || /entity too large|request entity too large/i.test(err.message || '');
    const status = isTooLarge ? 413
        : (err.statusCode || err.status || 500);

    const msg = `[${ts}] ERROR ${req.method} ${req.path}: ${err.message}`;
    console.error(msg);

    // Structured log so `hivv problems` / `hivv bug` can study it.
    errorLog.recordAsync({
        error: err,
        endpoint: req.path,
        method: req.method,
        status,
        user_agent: req.headers['user-agent'],
        error_class: isTooLarge ? 'body_too_large' : undefined,
    });

    // Plain file log, kept for operators who tail it.
    const fs = require('fs');
    // The log lands NEXT TO THE REPO, wherever it is deployed.
    const logFile = require('path').join(__dirname, '..', 'logs', 'error.log');
    fs.appendFile(logFile, msg + '\n', () => {});

    if (isTooLarge) {
        return res.status(413).json({
            error: 'request body too large',
            message: err.message,
            limit: MAX_BODY,
            hint: 'reduce attached files or conversation history, '
                + `or raise HIVV_MAX_BODY (currently ${MAX_BODY})`,
        });
    }
    res.status(status).json({ error: 'Internal server error', message: err.message });
});

// ── Uncaught exception handling ─────────────────────────────────────
process.on('uncaughtException', (err) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] UNCAUGHT: ${err.message}`);
    const fs = require('fs');
    fs.appendFile(require('path').join(__dirname, '..', 'logs', 'error.log'), `[${ts}] UNCAUGHT: ${err.stack}\n`, () => {});
});
process.on('unhandledRejection', (reason) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] UNHANDLED REJECTION: ${reason}`);
    const fs = require('fs');
    fs.appendFile(require('path').join(__dirname, '..', 'logs', 'error.log'), `[${ts}] UNHANDLED: ${reason}\n`, () => {});
});

// HIVV_PORT is the local-install spelling; PORT is the classic one.
// Supporting both means the setup scripts and the systemd/PM2 units can use
// whichever name they prefer without silently binding the wrong port.
const PORT = parseInt(process.env.PORT || process.env.HIVV_PORT || 3011, 10);
app.listen(PORT, '0.0.0.0', () => console.log(`HIVV.org AI Gateway v2.0 — Distributed Orchestrator running on port ${PORT}`));
