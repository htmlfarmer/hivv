// api/routes/partner-routes.js — the public, versioned integration surface.
//
// WHO THIS IS FOR
// ───────────────
// Any website, agent, or tool that wants to use HIVV — not just OpenCode.
// Everything here is public, stable, and documented. No auth is required for
// the read-only surface; the OpenAI-compatible endpoints accept an optional
// Bearer token (exactly like OpenAI) when a partner wants an identity.
//
// ENDPOINTS
// ─────────
//   GET  /api/partner/manifest          machine-readable capability manifest
//   GET  /api/partner/health            liveness + local/hive status (no DB needed)
//   GET  /api/partner/models             models this instance can serve right now
//   GET  /api/partner/capabilities      capability registry (human + machine)
//   GET  /api/partner/network            the live hive: nodes, bees, models
//   POST /api/partner/verify             verify a signed attestation
//   POST /api/partner/fast-scan          deterministic, AI-free source screen
//   POST /api/partner/review             signed source review (costs an LLM call)
//   GET  /api/partner/attestation/key    the instance's verification public key
//
// DESIGN RULES
// ───────────
//   * One stable prefix (/api/partner) so partners can pin it.
//   * Every response carries a `meta.version` and `meta.generated_at`.
//   * Nothing here exposes a private IP, contact detail, or key material.
//   * Works with NO database and NO internet (local install).

const express = require('express');
const attest = require('../lib/attest');
const { fastScan } = require('../lib/fast-scan');
const localMode = require('../lib/local-mode');

const router = express.Router();

const PARTNER_API_VERSION = 'v1';
const HIVV_VERSION = process.env.HIVV_VERSION || '2.0.0';

let pool = null;
let routerRef = null;
let orchestrator = null;
let capsLib = null;
router.inject = (p, r, orch, caps) => {
    pool = p; routerRef = r; orchestrator = orch; capsLib = caps;
};

function meta(extra = {}) {
    return {
        version: PARTNER_API_VERSION,
        hivv_version: HIVV_VERSION,
        generated_at: new Date().toISOString(),
        ...extra,
    };
}

async function dbAlive() {
    if (!pool) return false;
    try {
        await pool.query('SELECT 1');
        return true;
    } catch (_e) {
        return false;
    }
}

// ── model discovery cache ─────────────────────────────────────────────────
// The manifest must be CHEAP: a partner fetches it on every page load, and
// probing eight local ports with a 700ms timeout each is what made it a
// 719ms p95 under load. The answer changes only when a model server starts
// or stops, so a short TTL is plenty.
const MODEL_CACHE_TTL_MS = 15_000;
let _modelCache = { at: 0, value: [] };
let _modelCacheBusy = null;

async function localModelsCached() {
    const now = Date.now();
    if (now - _modelCache.at < MODEL_CACHE_TTL_MS) return _modelCache.value;
    // Collapse a thundering herd: one probe serves every waiting request.
    if (_modelCacheBusy) return _modelCacheBusy;
    _modelCacheBusy = (async () => {
        try {
            const probed = await localMode.probeLocalModels(500);
            _modelCache = {
                at: Date.now(),
                value: probed.map((m) => ({
                    provider: m.provider, model: m.model, port: m.port,
                })),
            };
            return _modelCache.value;
        } catch (_e) {
            _modelCache = { at: Date.now(), value: [] };
            return _modelCache.value;
        } finally {
            _modelCacheBusy = null;
        }
    })();
    return _modelCacheBusy;
}

// ── manifest ───────────────────────────────────────────────────────────────
router.get('/manifest', async (req, res) => {
    const db = await dbAlive();
    const localModels = await localModelsCached();

    res.json({
        data: {
            service: 'hivv',
            name: 'HIVV',
            tagline: 'A distributed AI network — at home and around the world',
            pronunciation: 'HIVE (like a beehive)',
            description:
                'HIVV is a distributed AI gateway. It routes OpenAI-compatible requests to local ' +
                'models, peer nodes in the hive, and (optionally) cloud providers — and it can ' +
                'produce signed, independently-verifiable safety reviews of source code.',
            // The soul of the thing. Spiritual words are humanity's ORIGINAL
            // protocol for shared meaning — "speaking in tongues," sujood, dua
            // — they predate every machine, and they exist so we can
            // understand, laugh, and work together BEFORE returning to the
            // logical solution. Static field: the manifest stays cheap.
            philosophy: {
                superintelligence: 'logical AND spiritual',
                paths: ['logical', 'spiritual', 'metaphysical'],
                statement:
                    'HIVV.org supports both spiritual and end-logical intelligence.',
                test_question: 'Does prayer really work?',
                test_note:
                    'If you say no — please turn off your wireless wifi. ' +
                    'You already believe in invisible influence at a distance.',
                stance:
                    'No anarchy. Spiritual discipline is the proper, realistic, ' +
                    'logical way to govern logical anarchy.',
                roots:
                    'Modeled on real human practice in Islam and Hinduism; ' +
                    'Christian and Buddhist wisdom honored — the ultimately ' +
                    'correct abide by all of it.',
                laughter:
                    'The goal: understand, laugh, work together, and solve ' +
                    'every important problem the logical way.',
                style: 'opt-in — any user can change the style; fork it if you dislike it',
                priority:
                    'PRIORITY ACCESS for people outside the USA — the further from hivv.org, ' +
                    'the wiser we assume you are, and the faster we will try to connect.',
                origin_page: '/origin/',
                founder: 'Ash',
                origin:
                    'An Indonesian mother, a Pakistani father, and a chance meeting in Iran — ' +
                    'three Muslim countries, one family joke (dad calls Iran one of his ' +
                    'favorite countries; mom disagrees). People like to know who is behind ' +
                    'a project: now you do.',
            },
            version: HIVV_VERSION,
            instance_id: localMode.instanceId(),
            mode: localMode.mode(),
            local_first: true,
            offline_capable: true,
            database: db ? 'connected' : 'degraded',
            hub: localMode.hiveUrl(),
            hive_joined: localMode.isHiveAllowed(),
            local_models: localModels,
            openai_compatible: {
                base_url: '/v1',
                chat: '/v1/chat/completions',
                models: '/v1/models',
                streaming: true,
                tools: true,
                auth: 'optional Bearer token (OpenAI-compatible)',
            },
            endpoints: {
                manifest: '/api/partner/manifest',
                health: '/api/partner/health',
                models: '/api/partner/models',
                capabilities: '/api/partner/capabilities',
                network: '/api/partner/network',
                verify: '/api/partner/verify',
                fast_scan: '/api/partner/fast-scan',
                review: '/api/partner/review',
                attestation_key: '/api/partner/attestation/key',
                mcp: '/mcp',
                a2a: '/api/a2a',
                a2a_agent_card: '/.well-known/agent-card.json',
                a2a_message_send: '/api/a2a/message:send',
                a2a_task: '/api/a2a/tasks/{id}',
                telemetry_overview: '/api/telemetry/overview',
                telemetry_metrics: '/api/telemetry/metrics',
                bridge_load: '/api/bridge/load',
                bridge_allowance: '/api/bridge/allowance',
                bridge_peers: '/api/bridge/peers',
                bridge_problems: '/api/bridge/problems',
                bridge_registry: '/api/bridge/bridges',
                bridge_heartbeat: '/api/bridge/heartbeat',
                bridge_submit: '/api/bridge/requests',
                bridge_receipts: '/api/bridge/receipts',
            },
            // The protocols this instance speaks. Inbound = we serve it;
            // outbound = we can call one. Both directions are open-hives.
            protocols: {
                openai: { inbound: true, outbound: false, endpoint: '/v1/chat/completions' },
                mcp: { inbound: true, outbound: true, endpoint: '/mcp' },
                a2a: { inbound: true, outbound: true, endpoint: '/api/a2a', version: '1.0.0' },
                'open-hives': { inbound: true, outbound: true, endpoint: '/api/bridge/requests', version: '0.1' },
            },
            features: [
                { key: 'openai_compatible', stable: true },
                { key: 'streaming', stable: true },
                { key: 'tool_calls', stable: true },
                { key: 'route_modes', stable: true },
                { key: 'fast_scan', stable: true },
                { key: 'signed_attestations', stable: true },
                { key: 'mcp', stable: true },
                { key: 'a2a', stable: true },
                { key: 'deeper_telemetry', stable: true },
                { key: 'distributed_tasks', stable: true },
                { key: 'hive_to_hive_submit', stable: true },
                { key: 'local_first', stable: true },
                { key: 'offline_mode', stable: true },
            ],
            integration_notes: [
                'Model aliases auto/smart/fast/cheap/private double as route modes.',
                'Send X-Hivv-Plain: 1 to suppress HIVV custom SSE frames.',
                'Every response may carry X-Hivv-Answered-By and X-Hivv-Policy headers.',
                'POST /api/partner/fast-scan is deterministic and free; it never approves code.',
                'POST /api/partner/review returns a signed attestation verifiable offline.',
                'A2A: POST /api/a2a (JSON-RPC) or /api/a2a/message:send (REST). The agent card is at /.well-known/agent-card.json.',
                'Telemetry: /api/telemetry/overview is public-safe; /api/telemetry/metrics is Prometheus text.',
                'Send a W3C traceparent header and the whole request becomes ONE trace — ask /api/telemetry/traces/{id} for the waterfall.',
                'Hive-to-hive: POST /api/bridge/requests with X-Hive-Origin / X-Hive-Request-Id; the loop shield answers 409 on a loop.',
            ],
            limits: {
                max_code_bytes: 256 * 1024,
                fast_scan_max_code_bytes: 256 * 1024,
            },
        },
        meta: meta(),
    });
});

// ── health (works with no database) ────────────────────────────────────────
router.get('/health', async (req, res) => {
    const db = await dbAlive();
    const localModels = (await localModelsCached()).map((m) => m.model);

    let hive = null;
    // Only contact the hub when the operator explicitly allowed the hive to be
    // joined. A local install must never phone home silently.
    if (localMode.isHiveAllowed()) {
        hive = await localMode.hiveStatus(2000);
    } else {
        hive = {
            reachable: null,
            url: localMode.hiveUrl(),
            status: 'not-contacted',
            note: 'set HIVV_HIVE_JOIN=1 to allow this instance to reach the public hive',
        };
    }

    const healthy = localModels.length > 0 || db;
    res.json({
        data: {
            status: healthy ? 'healthy' : 'degraded',
            mode: localMode.mode(),
            database: db ? 'connected' : 'unavailable',
            local_models: localModels,
            hive,
            offline_capable: true,
        },
        meta: meta(),
    });
});

// ── models ─────────────────────────────────────────────────────────────────
router.get('/models', async (req, res) => {
    const models = [];
    const probed = await localModelsCached();
    for (const m of probed) {
        models.push({
            id: m.model,
            object: 'model',
            owned_by: m.provider,
            source: 'local',
            display_name: `${m.label || m.provider} @ ${m.port}`,
            context_window: null,
        });
    }
    if (routerRef) {
        for (const [name, provider] of routerRef.providers) {
            models.push({
                id: name,
                object: 'model',
                owned_by: name,
                source: provider.isCloud ? 'cloud' : 'local',
                display_name: provider.displayName,
            });
        }
    }
    res.json({ data: { total: models.length, models }, meta: meta() });
});

// ── capabilities ───────────────────────────────────────────────────────────
router.get('/capabilities', async (req, res) => {
    let caps = [];
    if (capsLib) {
        try {
            // registryValues() gives the raw registry; hiveSummary() adds which
            // bees currently offer each capability.
            const values = typeof capsLib.registryValues === 'function'
                ? capsLib.registryValues()
                : [];
            caps = values.map((c) => ({
                key: c.key,
                label: c.label || c.key,
                tier: c.tier,
                default_verdict: c.default_verdict,
                requires_consent: !!c.requires_consent,
                description: c.description || null,
            }));
        } catch (_e) { caps = []; }
    }
    res.json({
        data: {
            capabilities: caps,
            route_modes: ['balanced', 'quality', 'fast', 'cost', 'private', 'trusted'],
            model_aliases: ['auto', 'smart', 'fast', 'cheap', 'private'],
        },
        meta: meta(),
    });
});

// ── network (the live hive) ────────────────────────────────────────────────
router.get('/network', async (req, res) => {
    const nodes = [];
    if (orchestrator && orchestrator.nodes) {
        for (const n of orchestrator.nodes.values()) {
            nodes.push({
                node_id: n.node_id,
                name: n.name,
                status: n.status,
                version: n.version,
                transport: 'direct',
                volunteer: n.volunteer === true || n.volunteer?.on === true,
                capabilities: (n.capabilities || []).slice(0, 12),
                models: (n.local_models || []).map((m) => m.model || m.name).filter(Boolean),
                location: {
                    country_code: n.location?.country_code || null,
                    region: n.location?.region || null,
                    city: n.location?.city || null,
                },
                last_heartbeat: n.last_heartbeat || null,
            });
        }
    }
    res.json({
        data: {
            nodes: nodes.length,
            online: nodes.filter((n) => n.status === 'online').length,
            roster: nodes,
        },
        meta: meta(),
    });
});

// ── attestation key ────────────────────────────────────────────────────────
router.get('/attestation/key', async (req, res) => {
    try {
        const scanRoutes = require('./scan-routes');
        const key = scanRoutes.publicKey ? scanRoutes.publicKey() : null;
        if (!key) throw new Error('scanner key unavailable');
        res.json({
            data: {
                principal_id: key.principalId,
                public_key: key.rawPublicKey.toString('base64'),
                algorithm: 'ed25519',
                envelope_version: 2,
                schema: 'blnq.attestation.v2',
            },
            meta: meta(),
        });
    } catch (e) {
        res.status(503).json({ error: 'attestation key unavailable', detail: e.message, meta: meta() });
    }
});

// ── fast scan (deterministic, free, no AI) ────────────────────────────────
router.post('/fast-scan', async (req, res) => {
    const { language, code, filename } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code required', meta: meta() });
    }
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > 256 * 1024) {
        return res.status(413).json({ error: 'code exceeds 256 KiB', meta: meta() });
    }
    const started = Date.now();
    const result = fastScan(code, { language });
    res.json({
        data: {
            ...result,
            filename: filename ? String(filename).slice(0, 200) : null,
            request_duration_ms: Date.now() - started,
            ai_used: false,
            signed: false,
        },
        meta: meta(),
    });
});

// ── signed review (uses the LLM) ──────────────────────────────────────────
router.post('/review', async (req, res) => {
    const { language = 'python', code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code required', meta: meta() });
    }
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > 256 * 1024) {
        return res.status(413).json({ error: 'code exceeds 256 KiB', meta: meta() });
    }
    try {
        const scanRoutes = require('./scan-routes');
        const result = await scanRoutes.scanForPartner({ language, code });
        res.json({ data: result, meta: meta() });
    } catch (e) {
        res.status(503).json({
            error: 'signed review unavailable',
            detail: e.message,
            hint: 'a signed review needs a working model; use /api/partner/fast-scan for a free deterministic screen',
            meta: meta(),
        });
    }
});

// ── attestation verification ──────────────────────────────────────────────
router.post('/verify', async (req, res) => {
    const { envelope, signature, public_key } = req.body || {};
    if (!envelope || !signature) {
        return res.status(400).json({ error: 'envelope and signature required', meta: meta() });
    }
    let raw = null;
    if (public_key) {
        try { raw = Buffer.from(String(public_key), 'base64'); } catch (_e) { raw = null; }
        if (!raw || raw.length !== 32) {
            return res.status(400).json({ error: 'public_key must decode to 32 bytes', meta: meta() });
        }
    } else {
        try {
            const scanRoutes = require('./scan-routes');
            const key = scanRoutes.publicKey ? scanRoutes.publicKey() : null;
            raw = key ? key.rawPublicKey : null;
        } catch (_e) { raw = null; }
        if (!raw) {
            return res.status(400).json({ error: 'public_key required (no local key available)', meta: meta() });
        }
    }
    const check = attest.verifyEnvelope(envelope, signature, raw);
    res.json({
        data: {
            valid: check.ok,
            problems: check.problems,
            fresh: attest.checkFreshness(envelope),
            kind: envelope.kind,
            subject: envelope.subject,
            issuer: envelope.issuer,
        },
        meta: meta(),
    });
});

module.exports = router;
module.exports.PARTNER_API_VERSION = PARTNER_API_VERSION;
