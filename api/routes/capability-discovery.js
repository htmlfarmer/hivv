// api/routes/capability-discovery.js — tell clients what HIVV adds.
//
// WHY THIS EXISTS
// ───────────────
// An OpenAI-compatible client (OpenCode, Continue, Cline, a script, an
// agent) connects to `/v1` and sees a normal chat API. It has no way to
// discover that this endpoint ALSO offers:
//
//   * deterministic source screening (free, no AI)
//   * signed, offline-verifiable safety reviews
//   * route modes (smart/fast/cheap/private) as model aliases
//   * the hive's node network
//   * MCP tools
//
// This endpoint is that advertisement. It is deliberately plain JSON at a
// predictable path, so a client can probe it with one GET and decide what to
// offer its user.
//
// WHAT IT IS NOT
// ──────────────
// It is not an OpenAI spec endpoint (OpenAI has none). It is not MCP (that is
// `/mcp`, for MCP-aware clients). It is the thin discovery layer between the
// two: enough for any HTTP client to learn what is here.

const express = require('express');
const router = express.Router();

const toolkit = require('../lib/toolkit');

let pool = null;
let routerRef = null;
let capsLib = null;
router.inject = (p, r, c) => { pool = p; routerRef = r; capsLib = c; };

const HIVV_VERSION = process.env.HIVV_VERSION || '2.0.0';

// The tools HIVV itself provides, independent of any node.
// `tier` mirrors the capability registry: compute = free/local,
// data = leaves the box, side-effect = changes something.
const HIVV_TOOLS = [
    {
        name: 'fast_scan',
        description: 'Deterministic, AI-free source screening. Counts bytes, '
            + 'chars, lines, entropy, commands, file paths, network targets; '
            + 'flags hard-danger patterns and embedded secrets (fingerprints '
            + 'only). NEVER approves code — it can only make a verdict worse.',
        endpoint: '/api/partner/fast-scan',
        method: 'POST',
        cost: 'free',
        tier: 'compute',
        input: { language: 'string', code: 'string', filename: 'string?' },
        stable: true,
    },
    {
        name: 'signed_review',
        description: 'Signed, offline-verifiable safety review of source code. '
            + 'Returns an Ed25519-signed envelope binding the verdict and '
            + 'plain-English explanation to the exact source hash. Fails closed '
            + 'if no model is available.',
        endpoint: '/api/partner/review',
        method: 'POST',
        cost: 'model',
        tier: 'data',
        input: { language: 'string', code: 'string' },
        stable: true,
    },
    {
        name: 'verify_attestation',
        description: 'Verify a signed attestation envelope against a public '
            + 'key. Offline-capable: no hub, no database, no network needed.',
        endpoint: '/api/partner/verify',
        method: 'POST',
        cost: 'free',
        tier: 'compute',
        input: { envelope: 'object', signature: 'string', public_key: 'string?' },
        stable: true,
    },
    {
        name: 'hive_status',
        description: 'Live view of the node network: who is online, what '
            + 'models they serve, coarse location.',
        endpoint: '/api/partner/network',
        method: 'GET',
        cost: 'free',
        tier: 'compute',
        input: {},
        stable: true,
    },
    {
        name: 'route_preview',
        description: 'Dry-run the routing planner: which node/model would '
            + 'answer a request, and why. Never executes anything.',
        endpoint: '/api/capabilities/route/dry-run',
        method: 'GET',
        cost: 'free',
        tier: 'compute',
        input: { capability: 'string', mode: 'string' },
        stable: true,
    },
];

// The route-mode aliases that double as model names.
const ROUTE_MODES = {
    auto: 'let the router decide',
    smart: 'highest quality (route.mode=quality)',
    fast: 'lowest latency (route.mode=fast)',
    cheap: 'lowest cost (route.mode=cost)',
    private: 'local/hive only — never leaves your network (route.mode=private)',
};

router.get('/', async (req, res) => {
    let dbOk = false;
    if (pool) {
        try {
            await pool.query('SELECT 1');
            dbOk = true;
        } catch (_e) { /* degraded */ }
    }

    // Node-shared tools (search, fetch, calculate, …) from live bees.
    const sharedTools = [];
    if (routerRef && routerRef.orchestrator) {
        for (const n of routerRef.orchestrator.nodes.values()) {
            if (n.status === 'offline' || !Array.isArray(n.tools)) continue;
            for (const t of n.tools) {
                if (!sharedTools.includes(t)) sharedTools.push(t);
            }
        }
    }

    // Capability registry (what the policy gate knows about).
    let capabilities = [];
    if (capsLib && typeof capsLib.registryValues === 'function') {
        try {
            capabilities = capsLib.registryValues().map((c) => ({
                key: c.key,
                label: c.label || c.key,
                tier: c.tier,
                default_verdict: c.default_verdict,
            }));
        } catch (_e) { /* registry not loaded */ }
    }

    res.json({
        data: {
            service: 'hivv',
            name: 'HIVV',
            tagline: 'A distributed AI network — at home and around the world',
            version: HIVV_VERSION,
            openai_compatible: {
                base_url: '/v1',
                chat: '/v1/chat/completions',
                models: '/v1/models',
                streaming: true,
                tools: true,
                auth: 'optional Bearer token (OpenAI-compatible)',
            },
            route_modes: ROUTE_MODES,
            model_aliases: Object.keys(ROUTE_MODES),
            hivv_tools: HIVV_TOOLS,
            hive_shared_tools: sharedTools,
            capabilities,
            // The toolkit: twelve tools (plus sysinfo) that ANY model on the
            // network can call. The hub attaches them automatically — a client
            // does not have to implement a tool loop to use them.
            toolkit: {
                count: toolkit.allTools().length,
                advertised: toolkit.advertisedTools().map((t) => t.name),
                web_search_enabled: toolkit.isWebSearchEnabled(),
                auto_attached: true,
                opt_out: 'send "tools": false, or the header X-Hivv-Tools: off',
                invoke: 'POST /api/tools/:tool/invoke',
                catalog: 'GET /api/tools/catalog',
                tools: toolkit.catalog().map((t) => ({
                    name: t.name,
                    aliases: t.aliases,
                    description: t.description,
                    capability: t.capability,
                    tier: t.tier,
                    default_verdict: t.default_verdict,
                    advertised: t.advertised,
                    runs_on: t.runs_on,
                    parameters: t.parameters,
                })),
            },
            mcp: {
                endpoint: '/mcp',
                transport: 'streamable-http',
                tools: ['chat', 'route', 'nodes', 'search', 'news', 'honey']
                    .concat(toolkit.advertisedTools().map((t) => t.name)),
            },
            receipts: {
                'X-Hivv-Answered-By': 'which node/model answered, and how (direct|relay)',
                'X-Hivv-Policy': 'which policy rule allowed the request (ALLOW …)',
                'X-Hivv-Plain': 'set to 1 to suppress HIVV custom SSE frames',
            },
            notes: [
                'Model aliases auto/smart/fast/cheap/private double as route modes.',
                'POST /api/partner/fast-scan is deterministic, free, and never approves code.',
                'POST /api/partner/review returns a signed attestation verifiable offline.',
                'Use the MCP endpoint (/mcp) if your client speaks MCP.',
            ],
        },
        meta: {
            version: 'v1',
            hivv_version: HIVV_VERSION,
            generated_at: new Date().toISOString(),
            database: dbOk ? 'connected' : 'degraded',
        },
    });
});

module.exports = router;
