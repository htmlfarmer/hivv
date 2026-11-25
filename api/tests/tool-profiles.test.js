// api/tests/tool-profiles.test.js — the speed/context-window lever.
//
// WHY THIS EXISTS
//   The full toolkit is ~1,845 tokens of JSON schema plus a ~270-token
//   briefing, attached to EVERY request. Default context windows are 8,192
//   (gemma/qwen) and 4,096 for llama-class models — so on a 4k bee the tool
//   payload is half the window before the user says anything.
//
//   Two orthogonal levers fix that and must not regress:
//     WHICH tools → X-Hivv-Tools: fast | all   (profiles in toolkit.js)
//     HOW fat     → X-Hivv-Tools: …,lean       (schema trimming)
//
// Run: node --test api/tests/tool-profiles.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Pin the advertised set: web_search is env-gated, and without it the briefing
// legitimately drops two rules — which would make the byte-identity guard below
// flap depending on the shell it runs in.
process.env.HIVV_ENABLE_WEB_SEARCH = '1';

const tk = require('../lib/toolkit');

const tok = (s) => Math.round(String(s).length / 4);
const schemaTok = (opts) => tok(JSON.stringify(tk.openaiSchemas(opts)));
const names = (opts) => tk.openaiSchemas(opts).map((t) => t.function.name);

// ── parsing ──────────────────────────────────────────────────────────────────

test('parseToolSpec: profiles, lean, explicit lists, and the empty default', () => {
  assert.deepStrictEqual(tk.parseToolSpec('fast'),
    { profile: 'fast', only: null, lean: false });
  assert.deepStrictEqual(tk.parseToolSpec('fast,lean'),
    { profile: 'fast', only: null, lean: true });
  assert.deepStrictEqual(tk.parseToolSpec('fast,web_search'),
    { profile: 'fast', only: ['web_search'], lean: false });
  assert.deepStrictEqual(tk.parseToolSpec('calculator,translate'),
    { profile: null, only: ['calculator', 'translate'], lean: false });
  assert.deepStrictEqual(tk.parseToolSpec(''),
    { profile: null, only: null, lean: false });
  assert.deepStrictEqual(tk.parseToolSpec(null),
    { profile: null, only: null, lean: false });
});

test('profile aliases all resolve to a real profile', () => {
  for (const alias of ['fast', 'quick', 'lite', 'small', 'mini']) {
    assert.strictEqual(tk.parseToolSpec(alias).profile, 'fast', alias);
  }
  for (const alias of ['all', 'full', 'detailed', 'wide']) {
    assert.strictEqual(tk.parseToolSpec(alias).profile, 'all', alias);
  }
});

test('profileNames: "all" means EVERYTHING, not nothing', () => {
  // Regression guard — this returned [] the first time, which would have made
  // X-Hivv-Tools: all attach ZERO tools while looking like a valid request.
  assert.strictEqual(tk.profileNames('all'), null, 'all must be null (= everything)');
  assert.strictEqual(tk.profileNames(''), null);
  assert.strictEqual(tk.profileNames('detailed'), null);
  assert.deepStrictEqual(tk.profileNames('fast'), tk.PROFILES.fast);
  assert.deepStrictEqual(tk.profileNames('fast,web_search'),
    [...tk.PROFILES.fast, 'web_search'], 'explicit extras compose onto the profile');
});

// ── schema size ──────────────────────────────────────────────────────────────

test('fast profile is dramatically smaller than the full set', () => {
  const full = schemaTok({});
  const fast = schemaTok({ only: tk.PROFILES.fast });
  assert.ok(full > 1500, `full set should be ~1845 tok, got ${full}`);
  assert.ok(fast < 500, `fast should be ~430 tok, got ${fast}`);
  assert.ok(fast < full * 0.3, `fast must be under 30% of full (${fast} vs ${full})`);
});

test('lean trims the schema without losing structure', () => {
  const full = tk.openaiSchemas({});
  const lean = tk.openaiSchemas({ lean: true });
  assert.strictEqual(lean.length, full.length, 'lean drops no tools');
  assert.ok(schemaTok({ lean: true }) < schemaTok({}), 'lean must be smaller');

  for (let i = 0; i < full.length; i++) {
    const f = full[i].function;
    const l = lean[i].function;
    assert.strictEqual(l.name, f.name);
    assert.ok(l.description, `${l.name}: lean must keep a description`);
    assert.ok(l.description.length <= f.description.length,
      `${l.name}: lean description must not grow`);
    // property NAMES and types survive — only prose is dropped
    const fp = (f.parameters && f.parameters.properties) || {};
    const lp = (l.parameters && l.parameters.properties) || {};
    assert.deepStrictEqual(Object.keys(lp).sort(), Object.keys(fp).sort(),
      `${l.name}: lean must keep every property name`);
    for (const [k, v] of Object.entries(fp)) {
      assert.deepStrictEqual(lp[k].type, v.type, `${l.name}.${k}: type must survive`);
    }
  }
});

test('lean strips prose but the tools still carry their enums', () => {
  // Enum VALUES are data, not prose — trimming must never remove a choice the
  // model has to pick from.
  const lean = tk.openaiSchemas({ lean: true });
  for (const t of lean) {
    const s = JSON.stringify(t);
    assert.ok(!/"description"\s*:\s*""/.test(s), `${t.function.name}: no empty descriptions`);
  }
});

// ── the briefing ─────────────────────────────────────────────────────────────

test('full-set briefing is byte-identical to the pre-profile briefing', () => {
  // If this fails, every existing prompt silently changed shape — that is a
  // regression even if all the other tests pass.
  const LEGACY = [
    'TOOL PRIORITY: current_time/calculator/timezone_convert for anything about the date, the time or arithmetic — never do it in your head.',
    'web_fetch/http_request for a specific URL or an API; web_search for facts, history and current events.',
    'file_read/file_search for documents the user uploaded; text_parser for JSON/CSV/XML/YAML.',
    'code_interpreter for real computation, data wrangling and testing code.',
    'memory to remember something for later; translate for languages.',
    'EXACT RULES: 1) "news" / "current events" / "what\'s happening in [place]" → use web_search. 2) "what is [fact]" → use web_search. 3) a specific URL → use web_fetch. 4) any arithmetic → use the calculator. 5) "what time is it in [place]" → use current_time or timezone_convert.',
    'Do NOT say you cannot access live news or the current date — you have the tools. Present results as natural language summaries, not raw data.',
  ].join(' ');
  const advertised = tk.advertisedTools().map((t) => t.name).join(', ');
  const expected = `You have access to the HIVV toolkit: ${advertised}. ${LEGACY}`;
  assert.strictEqual(tk.toolBriefing(null), expected);
});

test('fast briefing only mentions the tools it actually attached', () => {
  const fastSchemas = tk.openaiSchemas({ only: tk.PROFILES.fast });
  const b = tk.toolBriefing(fastSchemas);

  assert.ok(b.startsWith('You have access to the HIVV toolkit: '), b.slice(0, 80));
  for (const n of tk.PROFILES.fast) assert.ok(b.includes(n), `must mention ${n}`);

  // The whole point: a fast request must not be told to use a tool it lacks,
  // and must not claim a search ability it was not given.
  assert.ok(!b.includes('web_search'), 'fast must not mention web_search');
  assert.ok(!b.includes('web_fetch'), 'fast must not mention web_fetch');
  assert.ok(!b.includes('code_interpreter'), 'fast must not mention code_interpreter');
  assert.ok(!b.includes('EXACT RULES: 1) "news"'), 'the news rule needs web_search');
  assert.ok(!b.includes('cannot access live news'), 'the news reassurance needs web_search');
  assert.ok(b.includes('any arithmetic → use the calculator'), 'the calculator rule applies');
});

test('briefing shrinks with the profile', () => {
  const full = tok(tk.toolBriefing(null));
  const fast = tok(tk.toolBriefing(tk.openaiSchemas({ only: tk.PROFILES.fast })));
  assert.ok(fast < full, `${fast} must be under ${full}`);
  assert.ok(fast < 200, `fast briefing should be ~123 tok, got ${fast}`);
});

test('no tools attached → the honest empty briefing', () => {
  assert.strictEqual(tk.toolBriefing([]), 'You have no tools available on this request.');
  assert.strictEqual(tk.toolBriefing(null) !== '', true);
});

// ── the "fast" set must never be able to block ───────────────────────────────

test('fast contains only tools that cannot stall on an approval', () => {
  // web.search / web.fetch / coding.execute / data.file.read are `ask`-tier:
  // for a non-operator they mint a pending grant a human must approve. A
  // "fast" profile carrying one could wait on a person — the opposite of fast.
  const BLOCKING = new Set(['web.search', 'web.fetch', 'coding.execute', 'data.file.read']);
  for (const n of tk.PROFILES.fast) {
    const cap = tk.toolCapability(n);
    assert.ok(cap, `${n}: unknown capability`);
    assert.ok(!BLOCKING.has(cap), `${n} is ${cap} — it can block a fast request`);
  }
});

// ── the wiring in server.js ──────────────────────────────────────────────────

test('server.js passes the resolved set to the briefing at every call site', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!src.includes('TOOL_PRIORITY_RULES'), 'dead rules block must be gone from server.js');
  const calls = src.match(/toolSystemMessage\(/g) || [];
  const definition = src.match(/function toolSystemMessage\(/g) || [];
  assert.strictEqual(calls.length - definition.length, 4,
    'expected exactly 4 briefing call sites (v1, chat, chat-stream, continue)');
  // every non-definition use must pass the attached list
  assert.strictEqual((src.match(/toolSystemMessage\(effectiveTools\)/g) || []).length, 4,
    'every call site must pass effectiveTools so the briefing matches what is sent');
  assert.ok(src.includes("req.body.tool_profile"), 'body-level tool_profile must be honoured');
});
