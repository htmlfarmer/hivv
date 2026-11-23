// api/tests/context-budget.test.js — the prompt-too-big path.
//
// WHY THIS FILE EXISTS
// --------------------
// An agent client (OpenCode) sends its system prompt + tool definitions +
// conversation as ONE HTTP body. Two defects made that fail:
//
//   1. `express.json()` with no `limit` → body-parser's 100kb default →
//      "request entity too large" → a 500 "Internal Server Error".
//      FIXED in server.js (MAX_BODY, default 10mb).
//
//   2. The request then reached the router, which sent the oversized
//      prompt to the bee WHOLE — because `_budgetTokens` only trimmed
//      when there were MORE THAN EIGHT non-system messages, and an agent
//      client sends exactly ONE. The bee answered llama.cpp's own 400
//      ("request (18766 tokens) exceeds the available context size
//      (16384 tokens)"), the router read `if (!response.ok) continue`
//      and THREW THE BODY AWAY, so every provider failed identically and
//      the client got "All providers unavailable" (503) — which says
//      "the hive is down" when the truth is "your prompt was too big".
//
// These tests pin the SECOND defect (the first is a config value, and
// is pinned by the 413 handler existing).
//
// Pure (no database, no network) so they run anywhere.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROUTER_PATH = path.join(__dirname, '..', 'lib', 'router.js');

// The router's private helpers are not exported, so they are lifted out
// of the source and evaluated — the SAME source the server runs, not a
// copy of it. A copy would drift, and a copy is how this bug survived
// the first fix.
function loadRouterInternals() {
    const src = fs.readFileSync(ROUTER_PATH, 'utf8');
    const classStart = src.indexOf('class AIRouter');
    assert.ok(classStart > 0, 'router.js must still declare class AIRouter');
    const helpers = src.slice(0, classStart);
    const mod = { exports: {} };
    const req = Module.createRequire(ROUTER_PATH);
    const fn = new Function(
        'module', 'exports', 'require', '__dirname', '__filename',
        helpers + '\nmodule.exports._budgetTokens = _budgetTokens;'
        + 'module.exports.isContextOverflow = isContextOverflow;'
        + 'module.exports.estimateTokens = estimateTokens;'
    );
    fn(mod, mod.exports, req, path.dirname(ROUTER_PATH), ROUTER_PATH);
    return mod.exports;
}

const { _budgetTokens, isContextOverflow, estimateTokens } = loadRouterInternals();

const CTX = 16384;                 // the local gemma-4 bee's n_ctx
const MODEL = 'gemma-4-E2B-it-Q4_K_M';

// ── THE CASE THAT BROKE ───────────────────────────────────────────────
// One message, 150kb — what OpenCode actually sends.
test('a single oversized message is trimmed to fit the context window', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(150000) }];
    const b = _budgetTokens(messages, { modelName: MODEL, contextWindow: CTX });

    assert.equal(b.trimmed, true, 'the oversized message must be trimmed');
    const t = estimateTokens(b.messages);
    assert.ok(
        t + 1024 <= Math.floor(CTX * 0.9) + 1024,
        `trimmed prompt must fit the window: ${t} tokens vs usable ${Math.floor(CTX * 0.9)}`
    );
});

test('the system prompt survives the trim — tools would break without it', () => {
    const messages = [
        { role: 'system', content: 'IDENTITY AND TOOL DEFINITIONS '.repeat(200) },
        { role: 'user', content: 'y'.repeat(150000) },
    ];
    const b = _budgetTokens(messages, { modelName: MODEL, contextWindow: CTX });

    const sys = b.messages.find((m) => m.role === 'system');
    assert.ok(sys, 'the system message must survive');
    assert.ok(sys.content.length > 0, 'the system message must not be empty');
    assert.ok(
        estimateTokens(b.messages) + 1024 <= Math.floor(CTX * 0.9) + 1024,
        'the trimmed conversation must fit'
    );
});

test('a small conversation is untouched', () => {
    const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
    ];
    const b = _budgetTokens(messages, { modelName: MODEL, contextWindow: CTX });
    assert.equal(b.trimmed, false);
    assert.equal(b.messages.length, 2);
});

test('a long conversation is still trimmed (the pre-existing rule)', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
        role: 'user', content: 'msg' + i + ' '.repeat(5000),
    }));
    const b = _budgetTokens(messages, { modelName: MODEL, contextWindow: CTX });
    assert.equal(b.trimmed, true);
    assert.ok(
        estimateTokens(b.messages) + 1024 <= Math.floor(CTX * 0.9) + 1024,
        'the trimmed conversation must fit'
    );
});

// ── THE OVERFLOW DETECTOR ──────────────────────────────────────────────
// llama.cpp's own 400. The router used to discard this body and try the
// next provider, which produced the misleading "All providers
// unavailable".
test('detects llama.cpp exceed_context_size_error', () => {
    const body = JSON.stringify({
        error: {
            code: 400,
            type: 'exceed_context_size_error',
            message: 'request (18766 tokens) exceeds the available context size (16384 tokens), try increasing it',
            n_prompt_tokens: 18766,
            n_ctx: 16384,
        },
    });
    assert.equal(isContextOverflow(400, body), true);
});

test('does not mistake an ordinary failure for an overflow', () => {
    assert.equal(isContextOverflow(400, JSON.stringify({ error: { message: 'bad request' } })), false);
    assert.equal(isContextOverflow(500, 'exceed_context_size'), false, 'a 500 is not an overflow');
    assert.equal(isContextOverflow(400, ''), false, 'an empty body is not an overflow');
    assert.equal(isContextOverflow(200, 'exceed_context_size'), false, 'a 200 is not an overflow');
});

// ── THE SERVER MUST NOT SAY "SERVER ERROR" FOR THIS ────────────────────
test('the server answers a context overflow with 413, not a 500', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(
        src.includes('exceed_context_size_error'),
        'server.js must map a context overflow to the OpenAI-shaped error type'
    );
    assert.ok(
        /contextOverflow[\s\S]{0,400}?res\.status\(413\)/.test(src),
        'server.js must answer a context overflow with HTTP 413'
    );
    // The body limit must not be left at body-parser's 100kb default.
    const limit = src.match(/express\.json\(\{\s*limit:\s*([^}]+)\}\)/);
    assert.ok(limit, 'express.json() must be given an explicit limit');
    assert.ok(
        /MAX_BODY/.test(limit[1]),
        'the body limit must be the configurable MAX_BODY, not a literal'
    );
});
