// api/routes/tool-routes.js — the tool surface.
//
//   GET  /api/tools            — the bees that share tools (unchanged shape)
//   GET  /api/tools/catalog    — the twelve tools: schema, capability, verdict
//   GET  /api/tools/:tool/invoke   — invoke (query-string form, back-compat)
//   POST /api/tools/:tool/invoke   — invoke (JSON body form)
//
// THE HUB IS AUTHORITATIVE
// ───────────────────────
// api/lib/toolkit.js holds the one implementation of every tool. This router
// runs it here, on the hub, where the sandbox, the document store and the
// memory table live. Every bee can reach the hub, so every bee gets every
// tool without installing anything.
//
// A bee can still be used directly — pass {"via":"node"} (or ?via=node) and
// the call is proxied to a bee that advertises the tool instead. That is how
// a member reaches the files on its OWN disk.
//
// POLICY
// ──────
// The gate runs inside toolkit.execute(). Its verdict shapes the response:
//   deny → 403 {verdict:'NO', …}
//   ask  → 202 {verdict:'MAYBE', grant_id, …}   (approve: hivv approve G_xxx)
//   allow→ 200 {tool, ok, data, via, policy}
// The X-Hivv-Policy header carries the same receipt the chat path returns.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const toolkit = require('../lib/toolkit');
const policy = require('../lib/policy');
const caps = require('../lib/capabilities');

const ANONYMOUS_TTL = 90 * 24 * 60 * 60 * 1000;   // 90 days for anonymous

// ── injected by server.js ───────────────────────────────────────────────────
let orchestrator = null;
let aiRouter = null;
router.inject = (orch, rt) => {
    orchestrator = orchestrator || orch;
    aiRouter = aiRouter || rt;
};

/**
 * WHO is asking — the same identity the chat path uses.
 *
 * This used to fall back to `ip:<req.ip>`, which is WRONG behind a CDN: the
 * source IP is the edge node's, and it changes between requests. A standing
 * grant ("this person may fetch URLs") was therefore never reusable — every
 * call minted a fresh MAYBE and asked a human again.
 *
 * The signed `hivv_visitor` cookie is the stable identity. The CLI sends
 * `x-visitor-id`; a signed-in member gets `user:<id>` from the session.
 */
function getVisitorId(req, res) {
    let visitorId = req.signedCookies?.hivv_visitor
        || req.headers['x-visitor-id']
        || req.query?.visitor_id
        || req.session?.sessionId;
    if (!visitorId) {
        visitorId = `v_${crypto.randomBytes(16).toString('hex')}`;
    }
    if (!req.signedCookies?.hivv_visitor) {
        // Writing the cookie writes a header — which throws once the response
        // has started. Never let that break the call.
        if (!res.headersSent) {
            try {
                res.cookie('hivv_visitor', visitorId, {
                    signed: true,
                    httpOnly: true,
                    maxAge: ANONYMOUS_TTL,
                    sameSite: 'lax'
                });
            } catch (_e) { /* cookies disabled — the id still identifies this call */ }
        }
    }
    return String(visitorId).slice(0, 128);
}

function isAdmin(req) {
    try {
        const ip = String(req.ip || '');
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
        const token = req.headers['x-control-token'];
        const expected = process.env.HIVV_CONTROL_TOKEN;
        if (token && expected && token.length === expected.length &&
            require('crypto').timingSafeEqual(Buffer.from(String(token)), Buffer.from(String(expected)))) return true;
    } catch (_e) { void _e; }
    return false;
}

// ── GET /api/tools/catalog ──────────────────────────────────────────────────
router.get('/catalog', async (req, res) => {
    const tools = toolkit.catalog();
    const advertised = toolkit.advertisedTools().map((t) => t.name);
    let verdicts = {};
    try {
        const principal = getVisitorId(req, res);
        for (const t of tools) {
            const g = await policy.gate({
                capability: t.capability,
                principal,
                transport: 'tool-catalog',
            }, { dryRun: true });
            verdicts[t.name] = {
                verdict: g.verdict,
                rule: g.rule,
                tier: g.tier,
                risk: g.risk,
                grant_id: g.grant_id || null,
            };
        }
    } catch (_e) {
        verdicts = {};
    }
    res.json({
        total: tools.length,
        advertised,
        web_search_enabled: toolkit.isWebSearchEnabled(),
        tools: tools.map((t) => ({ ...t, for_you: verdicts[t.name] || null })),
    });
});

// ── GET /api/tools — the bees that share tools ──────────────────────────────
router.get('/', (req, res) => {
    const tool = req.query.tool;
    const all = orchestrator
        ? Array.from(orchestrator.nodes.values()).filter((n) => (typeof orchestrator.isLive === 'function' ? orchestrator.isLive(n) : n.status !== 'offline'))
        : [];
    const withTools = all
        .filter((n) => n.tools && n.tools.length > 0)
        .map((n) => ({
            node_id: n.node_id,
            name: n.name,
            tools: n.tools,
            tools_port: n.tools_port,
            location: n.location || {},
            lan_ip: n.lan_ip,
            uptime_seconds: n.uptime_seconds
        }));
    if (tool) {
        const filtered = withTools.filter((n) => n.tools.includes(tool));
        return res.json({ tool, available: filtered.length, nodes: filtered });
    }
    res.json({
        total: withTools.length,
        nodes: withTools,
        // the hub itself is always a provider — this is the authoritative list
        catalog: toolkit.catalog().map((t) => ({ name: t.name, capability: t.capability, tier: t.tier, default_verdict: t.default_verdict, advertised: t.advertised, runs_on: t.runs_on })),
    });
});

// ── the node proxy (used when a tool must run on a bee) ─────────────────────
async function invokeOnNode(tool, args, timeoutMs) {
    if (!orchestrator) return { ok: false, error: 'the node registry is not ready' };
    const all = Array.from(orchestrator.nodes.values())
        .filter((n) => (typeof orchestrator.isLive === 'function' ? orchestrator.isLive(n) : n.status !== 'offline')
          && (n.tools || []).includes(tool) && n.tools_port > 0);
    if (!all.length) return { ok: false, error: `no bee on the hive is sharing '${tool}'` };
    const node = all.sort((a, b) => (a.total_cpu_percent || 0) - (b.total_cpu_percent || 0))[0];
    const hosts = [];
    if (node.lan_ip) hosts.push(node.lan_ip);
    if (node.ip && node.ip !== node.lan_ip) hosts.push(node.ip);
    hosts.push('127.0.0.1', 'localhost');

    const payload = JSON.stringify(args || {});
    let lastError = null;
    for (const host of hosts) {
        for (const [method, url] of [
            ['POST', `http://${host}:${node.tools_port}/tool/${encodeURIComponent(tool)}`],
            ['GET', `http://${host}:${node.tools_port}/${encodeURIComponent(tool)}?${new URLSearchParams(
                Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
                    .map(([k, v]) => [k, String(v)])).toString()}`],
        ]) {
            let timer = null;
            try {
                const ctrl = new AbortController();
                timer = setTimeout(() => ctrl.abort(), timeoutMs);
                const r = await fetch(url, {
                    method,
                    signal: ctrl.signal,
                    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
                    body: method === 'POST' ? payload : undefined,
                });
                clearTimeout(timer);
                const text = await r.text();
                let data;
                try { data = JSON.parse(text); } catch (_e) { data = { raw: text }; }
                if (!r.ok) {
                    lastError = new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
                    continue;
                }
                return { ok: true, node: node.name, provider: node.node_id, data };
            } catch (e) {
                if (timer) clearTimeout(timer);
                lastError = e;
            }
        }
    }
    return { ok: false, error: `could not reach ${node.name}: ${lastError ? lastError.message : 'no route'}` };
}

// ── the invoke handler (shared by GET and POST) ────────────────────────────
async function handleInvoke(req, res) {
    const rawName = req.params.tool;
    const tool = toolkit.resolveTool(rawName);
    const wantsNode = String(req.query.via || (req.body && req.body.via) || '').toLowerCase() === 'node';

    // A tool the hub does not know (e.g. a bee-specific one) goes straight
    // to the node path. A tool the hub DOES know runs on the hub unless the
    // caller explicitly asked for a bee.
    if (!tool && !wantsNode) {
        const r = await invokeOnNode(rawName, req.body || {}, 8000);
        if (!r.ok) {
            return res.status(404).json({
                error: `unknown tool '${rawName}'`,
                hint: 'GET /api/tools/catalog lists every tool the hive knows',
            });
        }
        return res.json({ tool: rawName, ok: true, via: 'node', node: r.node, provider: r.provider, data: r.data });
    }

    const args = (req.method === 'POST' && req.body && typeof req.body === 'object') ? { ...req.body } : { ...req.query };
    delete args.via;

    if (wantsNode) {
        const r = await invokeOnNode(tool ? tool.name : rawName, args, 15000);
        if (!r.ok) return res.status(502).json({ error: r.error });
        return res.json({ tool: tool ? tool.name : rawName, ok: true, via: 'node', node: r.node, provider: r.provider, data: r.data });
    }

    const principal = getVisitorId(req, res);
    const result = await toolkit.execute(tool ? tool.name : rawName, args, {
        principal,
        transport: 'hive-tool',
        ip: req.ip,
        isAdmin: isAdmin(req),
        reason: `hivv call ${tool ? tool.name : rawName}`,
        via: 'hub',
    });

    const name = result.tool || rawName;

    // Policy verdicts get the same HTTP shapes the rest of the OS uses.
    if (result.policy && result.policy.verdict === 'deny') {
        return res.status(403).json({
            verdict: 'NO', capability: result.policy.capability, rule: result.policy.rule,
            error: `policy refused '${result.policy.capability}' — ${result.policy.rule}`,
        });
    }
    if (result.policy && result.policy.verdict === 'ask') {
        return res.status(202).json({
            verdict: 'MAYBE', capability: result.policy.capability, rule: result.policy.rule,
            grant_id: result.policy.grant_id,
            message: `human approval required — approve with: hivv approve ${result.policy.grant_id}`,
        });
    }
    if (result.policy) {
        res.setHeader('X-Hivv-Policy', `${String(result.policy.verdict || 'allow').toUpperCase()} ${result.policy.rule || ''}`.trim());
    }
    if (!result.ok) {
        return res.status(400).json({ tool: name, ok: false, error: result.error, policy: result.policy || null });
    }
    return res.json({ tool: name, ok: true, via: result.via || 'hub', data: result.data, policy: result.policy || null });
}

router.get('/:tool/invoke', handleInvoke);
router.post('/:tool/invoke', express.json({ limit: '1mb' }), handleInvoke);

// ── GET /api/tools/:tool — the schema for one tool ─────────────────────────
router.get('/:tool', (req, res) => {
    const tool = toolkit.resolveTool(req.params.tool);
    if (!tool) return res.status(404).json({ error: `unknown tool '${req.params.tool}'` });
    const cap = caps.get(tool.capability);
    res.json({
        name: tool.name,
        aliases: tool.aliases || [],
        description: tool.description,
        capability: tool.capability,
        tier: cap ? cap.tier : 'unknown',
        default_verdict: cap ? cap.default_verdict : 'ask',
        advertised: (() => { try { return tool.advertise ? tool.advertise() !== false : true; } catch (_e) { return true; } })(),
        runs_on: tool.runs || ['hub'],
        parameters: tool.parameters,
    });
});

module.exports = router;
