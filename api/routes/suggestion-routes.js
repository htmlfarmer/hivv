// api/routes/suggestion-routes.js — the ONE suggestions door.
//
// Mounted at /api/suggestions.
//
// WHY A DOOR OF ITS OWN (and not a frame inside the chat stream)
// ───────────────────────────────────────────────────────────────
// The chat path has a HARD contract: when the assistant uses tools, the
// client must receive ONE consistent answer. A suggestions engine that ran
// inside that path — injecting a frame, mutating the message list, or
// answering with a tool_call of its own — would break it. So this door:
//
//   * NEVER emits an SSE frame and NEVER returns tool_calls;
//   * NEVER touches a conversation (the client sends a READ-ONLY view of the
//     thread; the server keeps nothing, stores nothing, logs no prompt);
//   * NEVER runs inside the tool loop — it is a separate request with its
//     own (short) deadline.
//
// GET /api/suggestions
//   ?mode=context|random|mixed   which channels to mix          (default mixed)
//   ?q=                          the visitor's DRAFT (unfinished thought)
//   ?conversation=<json>         a read-only view of the last turns
//   ?live=1                      also ask a bee to write two suggestions
//   ?limit=N                     how many chips                   (default 6)
//   ?seed=<anything>             rotate the random channel
//
// The answer is JSON, always — even when it fails (the site's law: a failed
// request may degrade the page, never break it).

const express = require('express');
const router = express.Router();

const suggestions = require('../lib/suggestions');
const perf = require('../lib/perf');

let orchestrator = null;
let aiRouter = null;
router.inject = (orch, rt) => { orchestrator = orch; aiRouter = rt; };

// The tools the catalog carries — the engine uses them to recognise when
// somebody is talking ABOUT a tool ("can you web_fetch this?").
let toolNames = [];
try {
    const toolkit = require('../lib/toolkit');
    const list = typeof toolkit.catalog === 'function' ? toolkit.catalog() : [];
    toolNames = (list || []).map((t) => t && t.name).filter(Boolean);
} catch (_e) { /* the toolkit is optional here */ }

// A short cache: the context channel is cheap, but the live channel asks a
// bee, and two people opening the page at the same moment should not ask
// the hive twice for the same thing.
const CACHE_MS = 20000;
const cache = new Map();

// The live channel asks a BEE. It is cheap (a tiny prompt, one tiny answer)
// but it is still model capacity, and this door is public — so one live
// generation per IP per 8s, whatever the seed says. A visitor clicking ↻
// gets new random chips (the instant channels); they do not get a new
// model call on every click.
const LIVE_COOLDOWN_MS = 8000;
const liveLast = new Map();
function liveAllowed(ip) {
    const key = String(ip || 'anon').slice(0, 40);
    const last = liveLast.get(key) || 0;
    const now = Date.now();
    if (now - last < LIVE_COOLDOWN_MS) return false;
    liveLast.set(key, now);
    if (liveLast.size > 500) {
        const oldest = [...liveLast.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
        for (const [k] of oldest) liveLast.delete(k);
    }
    return true;
}

function cacheKey(q, mode, conversation, seed, live) {
    return JSON.stringify([String(q || '').slice(0, 120), mode, live ? 1 : 0,
        (conversation || []).slice(-2).map((m) => String((m && m.content) || '').slice(0, 80)), seed || '']);
}

router.get('/', async (req, res) => {
    const t0 = Date.now();
    const mode = String(req.query.mode || 'mixed');
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 400) : '';
    const live = req.query.live === '1' || req.query.live === 'true' || req.query.live === true;
    const limit = Number(req.query.limit) || suggestions.DEFAULT_LIMIT;
    const seed = typeof req.query.seed === 'string' ? req.query.seed.slice(0, 80) : '';

    // a read-only view of the thread — parsed, never stored
    let conversation = [];
    if (typeof req.query.conversation === 'string' && req.query.conversation.length < 8000) {
        try {
            const parsed = JSON.parse(req.query.conversation);
            if (Array.isArray(parsed)) {
                conversation = parsed
                    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                    .slice(-6)
                    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
            }
        } catch (_e) { /* a broken view is not an error — the draft is enough */ }
    }

    // the live channel is rate-limited per IP (it asks a bee). A request that
    // ASKED for the live channel and was cooled down is never cached under the
    // live key — otherwise the same key would keep serving the live-less answer
    // long after the cooldown expired.
    const liveNow = live && liveAllowed(req.ip);
    const cacheable = !live || liveNow;

    const key = cacheKey(q, mode, conversation, seed, live);
    const hit = cache.get(key);
    if (cacheable && hit && (Date.now() - hit.at) < CACHE_MS) {
        res.set('Cache-Control', 'public, max-age=15');
        return res.json({ ...hit.body, cached: true });
    }

    try {
        let perfRows = [];
        try { perfRows = await perf.snapshot(20); } catch (_e) { perfRows = []; }
        const body = await suggestions.suggest(
            { orchestrator, router: aiRouter, perf: perfRows, tools: toolNames },
            { mode, q, conversation, seed, limit, live: liveNow }
        );
        body.took_ms = Date.now() - t0;
        // The live channel asks a BEE, so it spends model capacity — count it,
        // like every other request (a number that never moved is not a
        // measurement, and the hive's "requests today" must not lie).
        if (body.source && body.source.model_written > 0 && orchestrator && orchestrator.trackRequest) {
            try { orchestrator.trackRequest(0, 0, 'suggestions'); } catch (_e) { /* never break the answer */ }
        }
        if (cacheable) cache.set(key, { at: Date.now(), body });
        if (cache.size > 200) {
            // a bounded cache: the oldest entries go first
            const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
            for (const [k] of oldest) cache.delete(k);
        }
        res.set('Cache-Control', 'public, max-age=15');
        res.json(body);
    } catch (e) {
        // NEVER a 500 for a suggestion: the client has a static fallback.
        console.warn('[SUGGEST] engine failed:', e.message);
        res.set('Cache-Control', 'no-store');
        res.json({
            ok: true,
            mode,
            suggestions: [],
            degraded: true,
            error: 'the suggestion engine could not answer',
            took_ms: Date.now() - t0,
        });
    }
});

// The engine's own pool — so a client can show the curated list without a
// round trip (and the test can pin that the pool is about THIS hive).
router.get('/pool', (req, res) => {
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ ok: true, pool: suggestions.POOL.map((p) => ({ id: p.id, prompt: p.prompt })) });
});

module.exports = router;
module.exports.inject = router.inject;
