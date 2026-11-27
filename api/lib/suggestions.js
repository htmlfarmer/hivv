// api/lib/suggestions.js — ONE suggestions engine.
//
// THE IDEA
// ───────
// Humans LOVE suggestions: the cheapest way to make a blank box feel alive is
// to offer a question the visitor would have liked to ask. But a suggestion
// that is wrong is worse than no suggestion — it is an insult. So the engine
// has two rules:
//
//   1. EVERY suggestion names something REAL. The models it mentions are the
//      models this hive is actually serving, the bees are the bees on the
//      roster, the numbers are the numbers that were measured. Never a
//      hallucinated model name, never a plausible-looking lie.
//   2. EVERY suggestion is a QUESTION the visitor could ask RIGHT NOW —
//      grounded in what they are doing (the draft they are typing, the thread
//      they are in) or in something genuinely different (serendipity).
//
// THE THREE CHANNELS
// ──────────────────
//   CONTEXT  — "related to what you are doing". A subject is extracted from
//              the draft + the last turns; the pivots are built from that
//              subject and the live hive (stats, speed, compare, which bee).
//              THE STATS PIVOT lives here: someone typing about a model can
//              be handed "show me the stats for gemma-4-E2B" — because that is
//              the question they were about to ask anyway.
//   RANDOM   — "something different". A curated pool that is about THIS hive
//              (not generic filler), plus prompts derived from the live state
//              (the busiest bee, the fastest model, today's real numbers),
//              rotated by a seed so two visitors do not see the same four and
//              a shuffle gives NEW ones.
//   MODEL    — the hive suggests for itself: a local bee writes two or three
//              suggestions, in strict JSON, under a hard deadline. It is
//              OPT-IN and never on the critical path: the UI is already
//              usable before it answers, and if it fails, nothing is lost.
//
// THE TOOL LAW (why this file exists at all, separately)
// ──────────────────────────────────────────────────────
// The chat path has a HARD contract: when the assistant uses tools, the
// client must receive one consistent answer. A suggestion engine that ran
// inside that path — injecting a frame, mutating the message list, or
// answering with a tool_call of its own — would break that contract. So:
//   * the engine lives in its own module and its own endpoint;
//   * it NEVER returns tool_calls and NEVER emits an SSE frame;
//   * it NEVER mutates a conversation (the client sends a READ-ONLY view of
//     the thread, and the server keeps nothing);
//   * the client renders suggestions as chips that FILL the input — they
//     never post a message on their own, so the assistant's turn is never
//     interrupted.
// A test pins all four.

'use strict';

const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 6;

// ── the curated pool: about THIS hive, not generic filler ─────────────────
// Each entry may contain {t} placeholders filled from the live facts.
const POOL = [
    { id: 'how-hive-works', prompt: 'Explain how the HIVV network works in 3 points', kind: 'random' },
    { id: 'who-is-online', prompt: 'Which bees are online right now, and what are they serving?', kind: 'random' },
    { id: 'fastest-model', prompt: 'Which model on this hive is the fastest right now, and how fast?', kind: 'random' },
    { id: 'governance', prompt: 'How does the YES / MAYBE / NO gate decide what a bee may do?', kind: 'random' },
    { id: 'tools-list', prompt: 'What tools can I use here, and what do they cost?', kind: 'random' },
    { id: 'write-script', prompt: 'Write a Python script that calls this hive with the openai package and prints tokens per second', kind: 'random' },
    { id: 'compare-local', prompt: 'Compare a local bee with a cloud provider — cost, privacy, speed', kind: 'random' },
    { id: 'today-numbers', prompt: 'What has this hive served today — requests, tokens, bees?', kind: 'random' },
    { id: 'how-routing', prompt: 'How does the router choose which bee answers me?', kind: 'random' },
    { id: 'become-bee', prompt: 'How do I add my own machine to the hive?', kind: 'random' },
    { id: 'what-is-a-node', prompt: 'What is a node, and how do I become one?', kind: 'random' },
    { id: 'speak-to-bee', prompt: 'Talk to one bee of this hive and tell me what it can do', kind: 'random' },
    { id: 'signed-receipt', prompt: 'What is in the signed receipt my answer carries, and who signed it?', kind: 'random' },
    { id: 'salah', prompt: 'What are the prayer times for Karachi today?', kind: 'random' },
    { id: 'honey', prompt: 'What is honey, and who earned the most of it?', kind: 'random' },
    { id: 'opencode', prompt: 'How do I wire OpenCode to this hive as a provider?', kind: 'random' },
    { id: 'mcp', prompt: 'Show me how to call this hive over MCP', kind: 'random' },
    { id: 'cost', prompt: 'What would a hundred requests like mine cost on this hive?', kind: 'random' },
    { id: 'privacy', prompt: 'Which of my messages leave this machine?', kind: 'random' },
    { id: 'quality', prompt: 'Which bee gives the best answers, and how do you know?', kind: 'random' },
    { id: 'history', prompt: 'What can you tell me about the history of this project?', kind: 'random' },
    { id: 'bridge', prompt: 'What is the hive-to-hive bridge and who is on the other side?', kind: 'random' },
    { id: 'file-upload', prompt: 'How do I attach a file to a chat here?', kind: 'random' },
    { id: 'speak', prompt: 'Read your answer out loud to me', kind: 'random' },
    { id: 'debug', prompt: 'A request I sent was slow — how do I find out why?', kind: 'random' },
];

// ── live facts: the ground truth the suggestions are built on ──────────────
// Everything here is MEASURED or REGISTERED — never invented.

// ONE MODEL, ONE NAME. The roster says "Qwen/Qwen2.5-0.5B-Instruct-GGUF"
// and the perf table says "Qwen2.5-0.5B-Instruct-GGUF" — the same model.
// Without this key the engine would compare a model with itself.
function modelKey(name) {
    let s = String(name || '').replace(/\.(gguf|bin|safetensors)$/i, '');
    s = s.includes('/') ? s.split('/').pop() : s;
    s = s.toLowerCase();
    for (let i = 0; i < 4; i++) {
        const before = s;
        s = s.replace(/[-_](it|instruct|chat|q\d[0-9_a-z]*|iq\d[0-9_a-z]*|gguf|fp\d+|awq|ggml)$/i, '');
        if (s === before) break;
    }
    return s;
}

function collectFacts(ctx = {}) {
    const orch = ctx.orchestrator || null;
    const facts = {
        bees: [],            // {name, id, status, models:[], reqs}
        models: [],          // {model, node, tps, ttfb_ms}
        online: 0,
        total: 0,
        requestsToday: 0,
        fastest: null,
        busiest: null,
    };
    if (!orch || !orch.nodes) return facts;

    let reqsToday = 0;
    try {
        for (const node of orch.nodes.values()) {
            const name = node.name || node.node_id;
            const models = (node.local_models || [])
                .filter((m) => m && !m.locked)
                .map((m) => ({ model: m.model || m.name || '', port: m.port || null }));
            const live = typeof orch.isLive === 'function'
                ? orch.isLive(node)
                : node.status !== 'offline';
            const reqs = (node.stats && node.stats.routed_requests) || 0;
            facts.bees.push({ name, id: node.node_id, status: live ? 'online' : 'offline', models, reqs });
            if (live) facts.online++;
            facts.total++;
            reqsToday += reqs;
            if (models.length) {
                for (const m of models) facts.models.push({ model: m.model, node: name });
            }
        }
    } catch (_e) { /* the roster is optional */ }

    facts.requestsToday = reqsToday || (orch.quotas && orch.quotas.totalRequestsToday) || 0;

    // the busiest bee = the one that served the most requests (hub-measured)
    const ranked = facts.bees.filter((b) => b.reqs > 0).sort((a, b) => b.reqs - a.reqs);
    facts.busiest = ranked[0] || null;

    // the fastest model = the measured tps leader (never a guess)
    if (Array.isArray(ctx.perf) && ctx.perf.length) {
        const byTps = ctx.perf
            .filter((p) => Number(p.ewma_tps) > 0)
            .sort((a, b) => Number(b.ewma_tps) - Number(a.ewma_tps));
        for (const p of byTps.slice(0, 8)) {
            const model = p.model || '';
            if (!model) continue;
            const key = modelKey(model);
            const existing = facts.models.find((m) => modelKey(m.model) === key);
            if (existing) {
                // keep the ROSTER's name (that is what the hive serves) and
                // take the measurement
                existing.tps = Number(p.ewma_tps);
                existing.ttfb_ms = p.ewma_ttfb_ms != null ? Number(p.ewma_ttfb_ms) : null;
                existing.node = existing.node || p.node || null;
            } else {
                facts.models.push({ model, node: p.node || null, tps: Number(p.ewma_tps), ttfb_ms: p.ewma_ttfb_ms != null ? Number(p.ewma_ttfb_ms) : null });
            }
        }
        const fastest = byTps[0];
        if (fastest) {
            const known = facts.models.find((m) => modelKey(m.model) === modelKey(fastest.model));
            facts.fastest = { model: known ? known.model : fastest.model, node: fastest.node || null, tps: Number(fastest.ewma_tps) };
        }
    }
    // de-duplicate the model list by key (the same model on several bees —
    // the pivot should name the MODEL, not the bee)
    const seen = new Set();
    facts.models = facts.models.filter((m) => {
        const key = modelKey(m.model);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        m.key = key;
        return true;
    });
    return facts;
}

// ── the subject of the thread ──────────────────────────────────────────────
// "What are they actually doing?" — read from the draft and the last turns.
//
// PEOPLE DO NOT TYPE FULL MODEL NAMES. They type "gemma", "qwen", "the
// fast one". So a model is matched by its FAMILY (the leading letters of
// the name after the org prefix) as well as by its full stem — but only
// against the REAL names this hive serves, so nothing is ever invented.
function modelNeedles(name) {
    const bare = String(name || '').replace(/\.(gguf|bin|safetensors)$/i, '');
    if (!bare) return { stems: [], family: '' };
    const afterSlash = bare.includes('/') ? bare.split('/').pop() : bare;
    const stems = [afterSlash.toLowerCase()];
    // drop the quantisation / instruction suffixes: "gemma-4-E2B-it-Q4_K_M"
    // -> "gemma-4-E2B"
    const clean = afterSlash.replace(/[-_](it|instruct|chat|q\d.*|iq\d.*|gguf|fp\d.*)$/i, '');
    if (clean && clean !== afterSlash) stems.push(clean.toLowerCase());
    const family = (afterSlash.match(/^([a-z][a-z0-9]*)/i) || [])[1] || '';
    return { stems, family: family.toLowerCase() };
}

function extractSubject(text, facts) {
    const subject = { models: [], bees: [], tools: [], raw: String(text || '').slice(0, 400) };
    const hay = subject.raw.toLowerCase();
    if (!hay) return subject;

    // models — matched against the REAL model names this hive serves
    const matched = [];
    for (const m of facts.models) {
        const name = String(m.model || '');
        if (!name) continue;
        const { stems, family } = modelNeedles(name);
        let hit = null;
        for (const s of stems) {
            if (s.length >= 4 && hay.includes(s)) { hit = s; break; }
        }
        if (!hit && family.length >= 4 && new RegExp('\\b' + family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(hay)) {
            hit = family;
        }
        if (hit) matched.push({ name, key: modelKey(name), exact: stems.includes(hit) && hit.length >= 6, tps: m.tps || 0 });
    }
    // prefer the model the hive would actually recommend: an exact stem match
    // beats a family match, and a MEASURED model beats an unmeasured one.
    matched.sort((a, b) => (b.exact - a.exact) || (b.tps - a.tps));
    subject.models = [];
    const seenKeys = new Set();
    for (const m of matched) {
        if (seenKeys.has(m.key)) continue;   // the same model under two names
        seenKeys.add(m.key);
        subject.models.push(m.name);
    }

    // bees — the roster's names
    for (const b of facts.bees) {
        const n = String(b.name || '').toLowerCase();
        if (n.length >= 3 && new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(hay)) {
            subject.bees.push(b.name);
        }
    }
    // tools — the catalog's names (best effort; the engine may not have them)
    for (const t of (facts.tools || [])) {
        const n = String(t || '').toLowerCase();
        if (n.length >= 4 && hay.includes(n)) subject.tools.push(t);
    }
    return subject;
}

// ── the CONTEXT channel: pivots around the subject ─────────────────────────
// Every pivot names a REAL entity. If we do not know the subject, we do not
// guess one — we fall back to the hive-level pivots, which are always true.
function buildPivots(subject, facts) {
    const out = [];
    const push = (id, prompt, why, kind = 'context') => out.push({ id, prompt, why, kind });

    const model = subject.models[0] || null;
    const bee = subject.bees[0] || null;

    // ── THE STATS PIVOT ── the example that started this: someone typing
    // about a model may well want its numbers.
    if (model) {
        push('stats-model', `show me the stats for ${model}`, 'the numbers behind the model you are asking about');
        const m = facts.models.find((x) => x.model === model);
        if (m && m.tps) {
            push('speed-model', `how fast is ${model} right now?`, `measured: ${Math.round(m.tps)} tok/s`);
        }
        const other = facts.models.find((x) => modelKey(x.model) !== modelKey(model));
        if (other) {
            push('compare-model', `compare ${model} with ${other.model}`, 'the other model this hive is serving');
        }
    }
    if (bee) {
        const b = facts.bees.find((x) => x.name === bee);
        push('stats-bee', `show me the stats for the bee ${bee}`, 'the bee you are asking about', 'context');
        if (b && b.reqs > 0) {
            push('bee-load', `how busy is ${bee} right now?`, `${b.reqs} requests served`);
        }
    }
    // hive-level pivots — always available, always true
    push('hive-now', 'what is the hive doing right now?', 'the live state of this network');
    if (facts.fastest) {
        push('fastest-now', `which model is fastest right now, and how fast?`, `measured: ${Math.round(facts.fastest.tps)} tok/s`);
    }
    if (facts.busiest) {
        push('busiest-now', `which bee has served the most requests today?`, `${facts.busiest.name}: ${facts.busiest.reqs} requests`);
    }
    push('tools-now', 'what tools can I use here?', 'the toolkit this gateway carries');
    return out;
}

// ── the RANDOM channel ─────────────────────────────────────────────────────
// A seeded rotation over the curated pool + the live-state prompts, so the
// suggestions are different every time without being random noise.
function hashSeed(seed) {
    let h = 2166136261;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
}

function pickRandom(facts, seed, want = 4) {
    const rnd = hashSeed(seed);
    const live = [];

    if (facts.online > 0) {
        live.push({ id: 'live-online', prompt: `which ${facts.online} bee${facts.online === 1 ? ' is' : 's are'} online right now?`, why: `${facts.online} of ${facts.total} bees answering`, kind: 'random' });
    }
    if (facts.fastest) {
        live.push({ id: 'live-fastest', prompt: `how fast is ${facts.fastest.model} right now?`, why: `measured: ${Math.round(facts.fastest.tps)} tok/s`, kind: 'random' });
    }
    if (facts.requestsToday > 0) {
        live.push({ id: 'live-today', prompt: 'how many requests has this hive served today?', why: `${facts.requestsToday} measured`, kind: 'random' });
    }
    if (facts.busiest) {
        live.push({ id: 'live-busiest', prompt: `what has ${facts.busiest.name} been doing today?`, why: 'the busiest bee', kind: 'random' });
    }

    // deterministic rotation over the pool
    const pool = POOL.slice();
    const picked = [];
    const take = Math.min(want, pool.length);
    for (let i = 0; i < take; i++) {
        const idx = (rnd + i * 2654435761) % pool.length;
        picked.push(pool.splice(idx, 1)[0]);
    }
    // one live-state prompt in every batch (it is the most interesting one)
    if (live.length) {
        const livePick = live[(rnd >>> 3) % live.length];
        picked.splice(Math.min(1, picked.length), 0, livePick);
    }
    return picked.map((p) => ({ id: p.id, prompt: p.prompt, why: p.why || null, kind: p.kind || 'random' }));
}

// ── the MODEL channel: the hive suggests for itself ────────────────────────
// Strict JSON out, a hard deadline, and NEVER a tool call. If the model is
// slow, absent or answers nonsense, the caller keeps the other channels.
const MODEL_SYSTEM = [
    'You write SHORT clickable suggestions for an AI chat box.',
    'Rules:',
    '- 2 suggestions, each 4 to 12 words.',
    '- Each one is a question the person would genuinely want to ask next.',
    '- Ground them in the facts you are given.',
    '- Never invent a model, a bee or a number that is not in the facts.',
    '- No numbering, no quotes, no markdown.',
    'Answer with JSON only: {"suggestions":["...","..."]}',
].join('\n');

async function modelSuggestions(ctx, { subject, facts, limit = 2, deadlineMs = 8000 }) {
    const router = ctx.router;
    if (!router || typeof router.chatCompletion !== 'function') return [];
    const factsLine = facts.models.length
        ? `models: ${facts.models.map((m) => m.model).join(', ')}; bees online: ${facts.online}/${facts.total}`
        : `bees online: ${facts.online}/${facts.total}`;
    const ask = [
        { role: 'system', content: MODEL_SYSTEM },
        { role: 'user', content: `Facts: ${factsLine}${subject && subject.raw ? `\nThey are asking about: ${subject.raw}` : ''}\nWrite the suggestions.` },
    ];
    // Ask the FASTEST measured model, not the router's favourite: a suggestion
    // is a small, forgiving task and the visitor is waiting.
    const pin = facts.fastest && facts.fastest.model ? facts.fastest.model : (ctx.model || 'auto');
    try {
        const res = await Promise.race([
            router.chatCompletion(ask, { stream: false, model: pin, preferredModel: pin, max_tokens: 90, temperature: 0.6 }),
            new Promise((resolve) => {
                const t = setTimeout(() => resolve(null), deadlineMs);
                if (t && typeof t.unref === 'function') t.unref();
            }),
        ]);
        if (!res || !res.ok || !res.data) return [];
        const content = res.data?.choices?.[0]?.message?.content || '';
        if (!content) return [];
        // A tool_call here would be a CONTRACT violation — drop it.
        if (res.data?.choices?.[0]?.message?.tool_calls) return [];
        let parsed = null;
        try {
            const m = content.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(m ? m[0] : content);
        } catch (_e) {
            // a small model may answer with a bare list — try that shape too
            const quoted = [...content.matchAll(/["“']([^"”']{8,120})["”']/g)].map((m) => m[1]);
            if (quoted.length) parsed = { suggestions: quoted };
            else return [];
        }
        const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
        const out = [];
        for (const s of list) {
            const text = String(s || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
            if (!text || text.length < 8 || text.length > 160) continue;
            if (out.some((x) => x.prompt.toLowerCase() === text.toLowerCase())) continue;
            out.push({ id: 'model-' + out.length, prompt: text, why: 'written by a bee of this hive', kind: 'model' });
            if (out.length >= limit) break;
        }
        return out;
    } catch (_e) {
        return [];
    }
}

// ── the engine ─────────────────────────────────────────────────────────────
function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const s of list) {
        const key = String(s.prompt || '').toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

/**
 * suggest(ctx, opts) — the ONE entry point.
 *
 * ctx:  { orchestrator, router, perf, tools }
 * opts: { mode: 'context'|'random'|'mixed', q, conversation, seed, limit, live }
 */
async function suggest(ctx = {}, opts = {}) {
    const t0 = Date.now();
    const mode = ['context', 'random', 'mixed'].includes(opts.mode) ? opts.mode : 'mixed';
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(opts.limit) || DEFAULT_LIMIT));
    const facts = collectFacts(ctx);

    // the thread the visitor is in — a READ-ONLY view, never stored
    const draft = typeof opts.q === 'string' ? opts.q : '';
    const conversation = Array.isArray(opts.conversation) ? opts.conversation.slice(-6) : [];
    const text = [draft, ...conversation.map((m) => (m && m.content) || '')].join('\n');

    const subject = extractSubject(text, facts);
    const seed = opts.seed || (String(new Date().toISOString().slice(0, 10)) + '|' + (opts.nonce || ''));

    const out = [];
    // Each channel gets its own budget, so one channel can never crowd the
    // others out (the context pivots alone are seven strong).
    if (mode === 'context' || mode === 'mixed') out.push(...buildPivots(subject, facts).slice(0, 4));

    // the model channel — opt-in, never on the critical path
    let modelCount = 0;
    if (opts.live === true || opts.live === '1' || opts.live === 1) {
        const written = await modelSuggestions(ctx, { subject, facts, limit: 2 });
        modelCount = written.length;
        out.push(...written);
    }

    if (mode === 'random' || mode === 'mixed') out.push(...pickRandom(facts, seed, 3));

    const suggestions = dedupe(out).slice(0, limit);
    return {
        ok: true,
        mode,
        suggestions,
        subject: { models: subject.models, bees: subject.bees, tools: subject.tools },
        facts: {
            online: facts.online, total: facts.total,
            requests_today: facts.requestsToday,
            fastest: facts.fastest ? facts.fastest.model : null,
            busiest: facts.busiest ? facts.busiest.name : null,
        },
        source: { model_written: modelCount, channels: mode },
        took_ms: Date.now() - t0,
    };
}

module.exports = {
    suggest,
    collectFacts,
    extractSubject,
    buildPivots,
    pickRandom,
    modelSuggestions,
    POOL,
    MAX_LIMIT,
    DEFAULT_LIMIT,
};
