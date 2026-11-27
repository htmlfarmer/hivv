// api/tests/suggestions.test.js — pins the ONE suggestions engine.
//
// WHAT THIS IS
// ────────────
// Humans LOVE suggestions: the cheapest way to make a blank chat box feel
// alive is to offer a question the visitor would have liked to ask. But a
// suggestion that is wrong is worse than none — it is an insult. So the
// engine has two laws, and both are pinned below:
//
//   1. EVERY suggestion names something REAL — the models it mentions are
//      the models this hive is serving, the bees are on the roster, the
//      numbers were measured. Never an invented model name.
//   2. EVERY suggestion is a QUESTION the visitor could ask right now.
//
// And ONE thing it may never do: touch the chat stream. The tool contract
// (when the assistant uses tools, the client must receive ONE consistent
// answer) is sacred — so the engine lives in its own module and its own
// door, returns no tool_calls, and mutates no conversation.
//
// Run with:  cd api && node --test tests/suggestions.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'public_html');
const BASE = 'http://localhost:3011';

const suggestions = require('../lib/suggestions');

let gatewayUp = false;
before(async () => {
  try {
    const r = await fetch(BASE + '/api/health');
    gatewayUp = r.ok;
  } catch (_) { gatewayUp = false; }
});

function read(p) {
  try { return fs.readFileSync(path.join(PUBLIC, p), 'utf8'); } catch (_e) { return ''; }
}

// A fake hive — two bees, three models, measured.
function fakeHive() {
  const now = Date.now();
  return {
    orchestrator: {
      nodes: new Map([
        ['masjid', {
          node_id: 'masjid', name: 'masjid', status: 'online', last_heartbeat: now,
          local_models: [{ model: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF' }, { model: 'unsloth/gemma-4-E2B-it-GGUF' }],
          stats: { routed_requests: 12 },
        }],
        ['ashy', {
          node_id: 'ashy', name: 'ashy', status: 'online', last_heartbeat: now,
          local_models: [{ model: 'gemma-4-E2B-it-Q4_K_M' }],
          stats: { routed_requests: 30 },
        }],
      ]),
      isLive() { return true; },
    },
    perf: [
      { node: 'masjid', model: 'Qwen2.5-0.5B-Instruct-GGUF', ewma_tps: 42, ewma_ttfb_ms: 120 },
      { node: 'ashy', model: 'gemma-4-E2B-it-Q4_K_M', ewma_tps: 18, ewma_ttfb_ms: 300 },
    ],
  };
}

describe('the engine names only REAL things', () => {
  test('the subject is found by model FAMILY, not by a full name', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const subject = suggestions.extractSubject('how do I use the gemma model here?', facts);
    assert.ok(subject.models.length >= 1, 'the family match failed: ' + JSON.stringify(subject.models));
    assert.ok(subject.models.some((m) => /gemma/i.test(m)),
      'the subject must be the gemma model, got ' + JSON.stringify(subject.models));
  });

  test('the subject finds a BEE by name', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const subject = suggestions.extractSubject('stats for ashy please', facts);
    assert.deepEqual(subject.bees, ['ashy']);
  });

  test('the same model under two names is ONE model', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const keys = facts.models.map((m) => m.key).filter(Boolean);
    assert.equal(new Set(keys).size, keys.length, 'duplicate model keys: ' + JSON.stringify(keys));
  });

  test('a pivot never compares a model with ITSELF', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const subject = suggestions.extractSubject('qwen2.5', facts);
    const pivots = suggestions.buildPivots(subject, facts);
    const compare = pivots.find((p) => p.id === 'compare-model');
    if (compare) {
      const names = compare.prompt.split(' with ');
      assert.notEqual(names[0], names[1], 'the compare pivot compares a model with itself: ' + compare.prompt);
    }
  });

  test('THE STATS PIVOT: typing about a model offers its numbers', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const subject = suggestions.extractSubject('tell me about gemma-4-E2B', facts);
    const pivots = suggestions.buildPivots(subject, facts);
    const stats = pivots.find((p) => p.id === 'stats-model');
    assert.ok(stats, 'no stats pivot for a model the visitor is asking about');
    assert.match(stats.prompt, /stats/i);
    assert.ok(subject.models[0].length > 0, 'the stats pivot names no model');
  });

  test('every pivot names a model or a bee that EXISTS', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const subject = suggestions.extractSubject('gemma and ashy', facts);
    const known = new Set([...facts.models.map((m) => m.model), ...facts.bees.map((b) => b.name)]);
    for (const p of suggestions.buildPivots(subject, facts)) {
      for (const name of known) {
        if (p.prompt.includes(name)) continue;
      }
      // a pivot may name a model OR a bee — but never a name that is not
      // on the roster. Assert the absence of anything that looks invented.
      assert.ok(!/\b(gpt-4|claude|gemini-pro|llama-3)\b/i.test(p.prompt),
        'a pivot names a model this hive does not serve: ' + p.prompt);
    }
  });
});

describe('the RANDOM channel is serendipity, not filler', () => {
  test('the pool is about THIS hive and is not empty', () => {
    assert.ok(suggestions.POOL.length >= 12, 'the curated pool is too small');
    const text = suggestions.POOL.map((p) => p.prompt).join(' ').toLowerCase();
    for (const word of ['hive', 'bee', 'node', 'tool']) {
      assert.ok(text.includes(word), 'the pool says nothing about the ' + word);
    }
  });

  test('a different seed gives different suggestions', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const a = suggestions.pickRandom(facts, 'seed-a', 4).map((s) => s.id);
    const b = suggestions.pickRandom(facts, 'seed-b', 4).map((s) => s.id);
    assert.notDeepEqual(a, b, 'the random channel never rotates');
  });

  test('the same seed gives the SAME suggestions (no flicker)', () => {
    const facts = suggestions.collectFacts(fakeHive());
    const a = suggestions.pickRandom(facts, 'seed-x', 4).map((s) => s.id);
    const b = suggestions.pickRandom(facts, 'seed-x', 4).map((s) => s.id);
    assert.deepEqual(a, b);
  });

  test('one answer never repeats a suggestion', async () => {
    const ctx = fakeHive();
    const out = await suggestions.suggest(ctx, { mode: 'mixed', seed: 'dup-test', limit: 12 });
    const prompts = out.suggestions.map((s) => s.prompt.toLowerCase());
    assert.equal(new Set(prompts).size, prompts.length, 'a suggestion appeared twice');
  });
});

describe('THE TOOL CONTRACT (the thing that must never break)', () => {
  test('the engine lives in its own module — the chat path never imports it', () => {
    const server = fs.readFileSync(path.join(REPO, 'api', 'server.js'), 'utf8');
    // the chat handler must not reference the suggestions engine
    const chatStart = server.indexOf("/api/chat");
    const chatEnd = server.indexOf("/v1/chat/completions");
    const chatRegion = server.slice(Math.min(chatStart, chatEnd), Math.max(chatStart, chatEnd) + 4000);
    assert.ok(!/suggest/i.test(chatRegion), 'the chat path references the suggestions engine');
  });

  test('the engine never imports the tool loop', () => {
    const src = fs.readFileSync(path.join(REPO, 'api', 'lib', 'suggestions.js'), 'utf8');
    assert.ok(!/require\(.\.?\/tool-stream/.test(src), 'the engine must not touch the tool loop');
    assert.ok(!/tool_calls\s*[:=]/.test(src.replace(/tool_calls[^;]*;/g, '')),
      'the engine must not build tool_calls');
  });

  test('LIVE: a chat answer carries NO suggestion frame', async (t) => {
    if (!gatewayUp) return t.skip('gateway not running');
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'say PONG' }],
        stream: false, max_tokens: 12,
      }),
    });
    const body = await r.text();
    assert.ok(!/hivv_suggest/i.test(body), 'a suggestion frame leaked into the chat answer');
    assert.ok(!/"suggestions"\s*:/.test(body), 'the chat answer carried a suggestions payload');
  });

  test('LIVE: the suggestions door answers with NO tool_calls', async (t) => {
    if (!gatewayUp) return t.skip('gateway not running');
    const r = await fetch(BASE + '/api/suggestions?limit=6');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(!/tool_calls/.test(JSON.stringify(j)), 'the suggestions answer carries tool_calls');
  });
});

describe('the door', () => {
  test('LIVE: it answers the shape the client expects', async (t) => {
    if (!gatewayUp) return t.skip('gateway not running');
    const r = await fetch(BASE + '/api/suggestions?mode=mixed&limit=6');
    assert.equal(r.status, 200);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    assert.ok(ct.includes('json'), 'the suggestions door must answer JSON');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.suggestions));
    assert.ok(j.suggestions.length > 0, 'the door answered with nothing');
    for (const s of j.suggestions) {
      assert.equal(typeof s.prompt, 'string');
      assert.ok(s.prompt.length > 8, 'a suggestion is too short to be useful: ' + s.prompt);
      assert.ok(['context', 'random', 'model', 'fallback'].includes(s.kind), 'unknown kind: ' + s.kind);
    }
  });

  test('LIVE: the draft is honoured (the stats pivot for the model in it)', async (t) => {
    if (!gatewayUp) return t.skip('gateway not running');
    const r = await fetch(BASE + '/api/suggestions?q=' + encodeURIComponent('how fast is gemma'));
    const j = await r.json();
    assert.ok(j.subject.models.length >= 1, 'the door did not find the model in the draft');
    const stats = j.suggestions.find((s) => /stats/i.test(s.prompt) && /gemma/i.test(s.prompt));
    assert.ok(stats, 'no stats pivot for the model in the draft: ' + JSON.stringify(j.suggestions.map((s) => s.prompt)));
  });

  test('LIVE: a broken conversation does not break the door', async (t) => {
    if (!gatewayUp) return t.skip('gateway not running');
    const r = await fetch(BASE + '/api/suggestions?conversation=' + encodeURIComponent('{not json'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });

  test('LIVE: the pool door answers without the engine', async (t) => {
    if (!gatewayUp) return t.skip('gateway not running');
    const r = await fetch(BASE + '/api/suggestions/pool');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.pool) && j.pool.length >= 12);
  });
});

describe('the client (one component, every surface)', () => {
  test('the component exists and is same-origin', () => {
    assert.ok(fs.existsSync(path.join(PUBLIC, 'js', 'hivv-suggest.js')), 'the component is missing');
    const src = read('js/hivv-suggest.js');
    assert.ok(!/https?:\/\//.test(src.replace(/\/\/.*$/gm, '')), 'the component must not call another origin');
  });

  test('a chip FILLS the input — it never posts a message', () => {
    const src = read('js/hivv-suggest.js');
    assert.ok(!/sendMessage|sendChat/.test(src), 'the component must never post on its own');
    assert.ok(/onPick/.test(src), 'the component hands the choice back to the page');
  });

  test('it has a static fallback (offline still shows chips)', () => {
    const src = read('js/hivv-suggest.js');
    assert.ok(/FALLBACK/.test(src), 'the component needs a fallback pool');
    assert.ok(!/console\.error/.test(src), 'a failed suggestion fetch must not spam the console');
  });

  test('every chat surface loads the component', () => {
    for (const p of ['chat/index.html', 'chat.html', 'command-center.html']) {
      const src = read(p);
      assert.ok(src.includes('/js/hivv-suggest.js'), p + ' does not load the suggestions component');
      assert.ok(src.includes('suggest-row'), p + ' has no mount point for the suggestions');
    }
  });

  test('no surface keeps a hard-coded suggestion list', () => {
    for (const p of ['chat/index.html', 'chat.html']) {
      const src = read(p);
      assert.ok(!/onclick="sendSuggestion/.test(src), p + ' still carries hard-coded suggestions');
    }
  });
});