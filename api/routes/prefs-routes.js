// api/routes/prefs-routes.js — K3/K4: per-principal routing preferences.
//
//   GET  /api/prefs              → what YOUR identity has set (defaults + self bees)
//   PUT  /api/prefs              → set {mode?, privacy?, self_nodes?} for YOUR identity
//
// WHY THIS SHAPE
// The request itself always wins: a route.mode / route.privacy sent by the
// caller is applied verbatim, and these stored defaults only fill the fields
// the caller left out (router.routeWithFailover → routeDefaultFor). So a pref
// is a DEFAULT, never an override — "what I want when I don't say".
//
// IDENTITY IS VERIFIED, NEVER CLAIMED. The scope key comes from the same
// keyScopesOf() the chat path uses: session → user:<id>, SIGNED cookie →
// visitor:<id>, proven x-node-secret → node:<id>. The raw x-visitor-id header
// is spoofable and is deliberately never a key — a stranger cannot read or
// write anybody's prefs by sending a header.
//
// STORAGE: gateway_config.routing.{principal_defaults, self_owners} — the
// SAME row and the SAME loadConfig merge the weight tables already use. No
// migration, no extra read on the chat hot path (the router holds it in
// memory; PUT refreshes it with one loadConfig()).

const express = require('express');

const router = express.Router();

let pool = null;
let gatewayRouter = null;   // the AIRouter — loadConfig() refresh after writes
let keyScopes = null;       // server.js keyScopesOf(req) → verified scope list
let orchestrator = null;    // node existence checks for self_nodes claims

router.inject = (opts = {}) => {
    pool = opts.pool || null;
    gatewayRouter = opts.router || null;
    keyScopes = opts.keyScopes || null;
    orchestrator = opts.orchestrator || null;
};

const VALID_PRIVACY = ['localhost', 'hive', 'self', 'any'];
// The six route modes — the same set route-factors' DEFAULT_WEIGHTS defines
// (kept in sync by the router on read; validated here before any write).
const MODES = {
    balanced: true, quality: true, fast: true,
    cost: true, private: true, trusted: true,
};

function noIdentity(res) {
    return res.status(403).json({
        error: 'prefs need a verified identity',
        code: 'NO_IDENTITY',
        hint: 'set prefs from a logged-in session, a browser with the hivv_visitor cookie, or a registered bee (hivv start)',
    });
}

async function readRoutingCfg() {
    const r = await pool.query('SELECT value FROM gateway_config WHERE key = $1', ['routing']);
    if (!r.rows.length) {return {};}
    let v = r.rows[0].value;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (_e) { v = {}; }
    }
    return (v && typeof v === 'object') ? v : {};
}

async function writeRoutingCfg(cfg) {
    const json = JSON.stringify(cfg);
    const upd = await pool.query(
        'UPDATE gateway_config SET value = $1::jsonb WHERE key = $2', [json, 'routing']);
    if (!upd.rowCount) {
        try {
            await pool.query(
                'INSERT INTO gateway_config (key, value) VALUES ($1, $2::jsonb)', ['routing', json]);
        } catch (_e) {
            // lost a race with a concurrent insert — the UPDATE is the truth
            await pool.query(
                'UPDATE gateway_config SET value = $1::jsonb WHERE key = $2', [json, 'routing']);
        }
    }
}

// ── GET ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    if (!pool || !keyScopes) {return res.status(503).json({ error: 'prefs not initialized' });}
    try {
        const scopes = await keyScopes(req);
        if (!scopes.length) {return noIdentity(res);}
        const cfg = await readRoutingCfg();
        const defs = (cfg.principal_defaults && typeof cfg.principal_defaults === 'object')
            ? cfg.principal_defaults : {};
        const owners = (cfg.self_owners && typeof cfg.self_owners === 'object')
            ? cfg.self_owners : {};

        // Everything stored under ANY of my scopes (strongest first).
        const matches = {};
        for (const s of scopes) {
            if (defs[s]) {matches[s] = defs[s];}
        }
        const selfNodes = Object.entries(owners)
            .filter(([, sc]) => Array.isArray(sc) && sc.some(x => scopes.includes(x)))
            .map(([nid]) => nid);

        res.json({
            scopes,
            defaults: defs[scopes[0]] || null,
            by_scope: matches,
            self_nodes: selfNodes,
            modes: null,   // filled by the caller's knowledge of the catalog; router validates on write
        });
    } catch (err) {
        console.error('[PREFS] get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── PUT ─────────────────────────────────────────────────────────────────────
// Body fields are all OPTIONAL and all nullable:
//   {mode: 'fast'}            → my default route mode
//   {mode: null}              → clear it
//   {privacy: 'self'}         → my default privacy (localhost|hive|self|any)
//   {self_nodes: ['ashy']}    → REPLACE the list of bees I claim for 'self'
//   {self_nodes: []} / null   → release every bee I claimed
router.put('/', async (req, res) => {
    if (!pool || !keyScopes) {return res.status(503).json({ error: 'prefs not initialized' });}
    try {
        const scopes = await keyScopes(req);
        if (!scopes.length) {return noIdentity(res);}
        const primary = scopes[0];
        const body = req.body || {};

        if (!('mode' in body) && !('privacy' in body) && !('self_nodes' in body)) {
            return res.status(400).json({
                error: 'nothing to set',
                example: { mode: 'fast', privacy: 'self', self_nodes: ['ashy'] },
            });
        }

        // ── validate BEFORE touching storage ────────────────────────────────
        if ('mode' in body && body.mode !== null && body.mode !== '') {
            if (typeof body.mode !== 'string' || !(body.mode in MODES)) {
                return res.status(400).json({
                    error: `unknown route mode '${String(body.mode).slice(0, 32)}'`,
                    modes: Object.keys(MODES),
                });
            }
        }
        if ('privacy' in body && body.privacy !== null && body.privacy !== '') {
            if (typeof body.privacy !== 'string' || !VALID_PRIVACY.includes(body.privacy)) {
                return res.status(400).json({ error: 'privacy must be one of', privacy: VALID_PRIVACY });
            }
        }
        let claimNodes = null;
        if ('self_nodes' in body && body.self_nodes !== null) {
            if (!Array.isArray(body.self_nodes)) {
                return res.status(400).json({ error: 'self_nodes must be an array of bee ids' });
            }
            claimNodes = [];
            for (const raw of body.self_nodes) {
                const nid = String(raw || '').trim().slice(0, 64);
                if (!/^[A-Za-z0-9._-]+$/.test(nid)) {
                    return res.status(400).json({ error: `invalid bee id '${nid.slice(0, 32)}'` });
                }
                // A claim must name a bee that EXISTS — typos claim nothing,
                // and claiming a node you cannot see would be theatre anyway.
                if (orchestrator && !orchestrator.nodes.has(nid)) {
                    return res.status(404).json({ error: `unknown bee '${nid}'`, code: 'UNKNOWN_NODE' });
                }
                if (!claimNodes.includes(nid)) {claimNodes.push(nid);}
            }
        }

        // ── read → merge → write (rare op; the chat path reads memory) ──────
        const cfg = await readRoutingCfg();
        const defs = (cfg.principal_defaults && typeof cfg.principal_defaults === 'object')
            ? { ...cfg.principal_defaults } : {};
        const owners = (cfg.self_owners && typeof cfg.self_owners === 'object')
            ? { ...cfg.self_owners } : {};

        // mode / privacy — per-field: clearing one keeps the other.
        let mine = { ...(defs[primary] || {}) };
        if ('mode' in body) {
            if (body.mode === null || body.mode === '') {delete mine.mode;}
            else {mine.mode = body.mode;}
        }
        if ('privacy' in body) {
            if (body.privacy === null || body.privacy === '') {delete mine.privacy;}
            else {mine.privacy = body.privacy;}
        }
        if (Object.keys(mine).length) {defs[primary] = mine;}
        else {delete defs[primary];}

        // self_nodes — REPLACE this scope's claims everywhere, then add.
        if (claimNodes !== null) {
            for (const [nid, sc] of Object.entries(owners)) {
                if (!Array.isArray(sc)) {continue;}
                const kept = sc.filter(x => x !== primary);
                if (kept.length) {owners[nid] = kept;} else {delete owners[nid];}
            }
            for (const nid of claimNodes) {
                owners[nid] = [...(Array.isArray(owners[nid]) ? owners[nid] : []), primary];
            }
        }

        cfg.principal_defaults = defs;
        cfg.self_owners = owners;
        await writeRoutingCfg(cfg);
        try { await gatewayRouter.loadConfig(); } catch (_e) { /* next reload */ }

        console.log(`[PREFS] ${primary} → ${JSON.stringify({ ...(defs[primary] || {}), self_nodes: claimNodes ?? undefined })}`);

        res.json({
            ok: true,
            scope: primary,
            defaults: defs[primary] || null,
            self_nodes: Object.entries(owners)
                .filter(([, sc]) => Array.isArray(sc) && sc.includes(primary))
                .map(([nid]) => nid),
        });
    } catch (err) {
        console.error('[PREFS] put error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
