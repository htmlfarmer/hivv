// api/tests/route-factors.test.js — the routing factor vector.
//
// Two layers, on purpose:
//   A) route-factors.js in isolation — every normalizer is monotone in the
//      thing it measures, and "no data" is NEUTRAL rather than 0 or 1.
//   B) AIRouter._scoreTargets end-to-end — the MODE INTENT contracts. These
//      are the promises the old switch(mode) used to make implicitly; if a
//      weight table edit breaks one of them, routing quietly changes
//      personality and nobody notices. This is where they get noticed.
//
// Run: node --test api/tests/route-factors.test.js
const test = require('node:test');
const assert = require('node:assert');

const rf = require('../lib/route-factors');
const AIRouter = require('../lib/router');

// ═══════════════════════════════════════════════════════════════════════════
// A) the factors themselves
// ═══════════════════════════════════════════════════════════════════════════

test('computeFactors emits every declared factor, finite and inside [0,1]', () => {
  const { factors } = rf.computeFactors({});
  assert.deepStrictEqual(Object.keys(factors).sort(), [...rf.FACTORS].sort());
  for (const k of rf.FACTORS) {
    assert.ok(Number.isFinite(factors[k]), `${k} is not finite: ${factors[k]}`);
    assert.ok(factors[k] >= 0 && factors[k] <= 1, `${k} out of range: ${factors[k]}`);
  }
});

test('garbage input can never produce a NaN factor (a NaN score sorts nowhere)', () => {
  const { factors } = rf.computeFactors({
    ttfbMs: NaN, latMs: Infinity, tps: 'nope', okRate: 'x', qualityScore: null,
    memPct: undefined, maxJobs: -5, activeTasks: 'busy', priceUsd: -1,
    gpus: [{ mem_total_mb: 'lots', mem_used_mb: null }],
    hubLoc: { lat: 'here', lon: null }, nodeLoc: 42, trustScore: {},
    contextOk: 'maybe', toolsOk: 0,
  });
  for (const k of rf.FACTORS) assert.ok(Number.isFinite(factors[k]), `${k} = ${factors[k]}`);
});

test('missing data is NEUTRAL, not 0 and not 1', () => {
  const { factors } = rf.computeFactors({});
  // Two documented exceptions: reliability (unknown = full credit, so a new bee
  // is not locked out) and speed (unknown = the low unknown_tps prior).
  assert.strictEqual(factors.reliability, 1);
  assert.strictEqual(factors.speed, rf.sat(8, 30));
  for (const k of ['latency', 'capacity', 'queue', 'geography', 'capability']) {
    assert.strictEqual(factors[k], rf.NEUTRAL, `${k} should be NEUTRAL with no data`);
  }
});

test('latency: lower TTFT scores higher, and TTFT wins over completion time', () => {
  const fast = rf.latencyFactor({ ttfbMs: 150 });
  const slow = rf.latencyFactor({ ttfbMs: 4000 });
  assert.ok(fast > slow, `${fast} should beat ${slow}`);
  assert.strictEqual(rf.latencyFactor({ ttfbMs: 0 }), 1);
  // A completion-shaped latency must not mask a measured TTFT.
  assert.ok(rf.latencyFactor({ ttfbMs: 200, latMs: 30000 }) > rf.latencyFactor({ latMs: 30000 }));
});

test('speed: more tokens/sec scores higher; unknown uses the low prior', () => {
  assert.ok(rf.speedFactor({ tps: 90 }) > rf.speedFactor({ tps: 20 }));
  assert.strictEqual(rf.speedFactor({}), rf.speedFactor({ tps: 8 }), 'unknown = unknown_tps prior');
  assert.ok(rf.speedFactor({ tps: 40 }) > rf.speedFactor({}), 'measured beats unmeasured');
  assert.strictEqual(rf.speedFactor({ tps: 0 }), rf.speedFactor({}), '0 tps is not a measurement');
});

test('capacity: free VRAM and free slots both raise it', () => {
  const idleGpu = rf.capacityFactor({ gpus: [{ mem_total_mb: 8000, mem_used_mb: 1000 }] });
  const fullGpu = rf.capacityFactor({ gpus: [{ mem_total_mb: 8000, mem_used_mb: 7500 }] });
  assert.ok(idleGpu > fullGpu);
  const idleSlots = rf.capacityFactor({ maxJobs: 10, activeTasks: 0 });
  const busySlots = rf.capacityFactor({ maxJobs: 10, activeTasks: 9 });
  assert.ok(idleSlots > busySlots);
  assert.strictEqual(idleSlots, 1);
  assert.strictEqual(busySlots, 0.1);
  // No GPU reported → system RAM is the honest fallback, not "no capacity".
  assert.ok(rf.capacityFactor({ memPct: 20 }) > rf.capacityFactor({ memPct: 90 }));
  // Nothing at all → neutral, and a node that is OVER its slot budget clamps.
  assert.strictEqual(rf.capacityFactor({}), rf.NEUTRAL);
  assert.strictEqual(rf.capacityFactor({ maxJobs: 4, activeTasks: 40 }), 0);
});

test('queue: more waiting work scores lower; relay jobs count double', () => {
  assert.strictEqual(rf.queueFactor({ activeTasks: 0 }), 1);
  assert.ok(rf.queueFactor({ activeTasks: 0 }) > rf.queueFactor({ activeTasks: 3 }));
  assert.ok(rf.queueFactor({ activeTasks: 2 }) > rf.queueFactor({ activeTasks: 2, relayActive: 1 }));
  assert.strictEqual(rf.queueFactor({}), rf.NEUTRAL);
});

test('reliability: higher success rate scores higher, floor at 0.25', () => {
  const good = rf.reliabilityFactor({ okRate: 1 });
  const flaky = rf.reliabilityFactor({ okRate: 0.5 });
  const dead = rf.reliabilityFactor({ okRate: 0 });
  assert.ok(good > flaky && flaky > dead);
  assert.strictEqual(good, 1);
  assert.strictEqual(dead, 0.25, 'a broken bee keeps a floor so it stays reachable');
  assert.strictEqual(rf.reliabilityFactor({}), 1, 'unknown = full credit (documented exception)');
});

test('quality: the model-name tier maps onto [0.5, 1.0]', () => {
  assert.strictEqual(rf.qualityFactor({ qualityScore: 5 }), 0.5, 'unknown model = neutral');
  assert.strictEqual(rf.qualityFactor({ qualityScore: 10 }), 1);
  assert.ok(rf.qualityFactor({ qualityScore: 9 }) > rf.qualityFactor({ qualityScore: 6 }));
  assert.strictEqual(rf.qualityFactor({}), 0.5);
});

test('cost: donated compute beats priced, and pricier beats nothing', () => {
  assert.strictEqual(rf.costFactor({ free: true }), 1);
  assert.strictEqual(rf.costFactor({ free: true, priceUsd: 99 }), 1, 'free wins even against a huge price');
  const cheap = rf.costFactor({ priceUsd: 0.0005 });
  const dear = rf.costFactor({ priceUsd: 0.02 });
  assert.ok(cheap > dear);
  assert.ok(dear > 0 && dear < 1);
  assert.strictEqual(rf.costFactor({}), rf.NEUTRAL, 'unpriced = neutral, not free');
});

test('privacy: local > LAN peer > public peer > cloud', () => {
  const local = rf.privacyFactor({ isLocal: true });
  const lan = rf.privacyFactor({ isPeer: true, isPublicPeer: false });
  const wan = rf.privacyFactor({ isPeer: true, isPublicPeer: true });
  const cloud = rf.privacyFactor({});
  assert.ok(local > lan && lan > wan && wan > cloud, `${local} ${lan} ${wan} ${cloud}`);
});

test('geography: nearer scores higher; unknown coordinates are NEUTRAL', () => {
  const hub = { lat: 51.5074, lon: -0.1278 }; // London
  const near = rf.geographyFactor({ hubLoc: hub, nodeLoc: { lat: 51.51, lon: -0.12 } });
  const far = rf.geographyFactor({ hubLoc: hub, nodeLoc: { lat: -33.86, lon: 151.21 } }); // Sydney
  assert.ok(near > far, `${near} should beat ${far}`);
  assert.ok(near > 0.99, 'same city is essentially full proximity');
  assert.strictEqual(rf.geographyFactor({ hubLoc: hub }), rf.NEUTRAL, 'no node coords = neutral');
  assert.strictEqual(rf.geographyFactor({ nodeLoc: hub }), rf.NEUTRAL, 'no hub coords = neutral');
  assert.strictEqual(rf.geographyFactor({}), rf.NEUTRAL);
});

test('capability: satisfies what the request needs, neutral when it needs nothing', () => {
  assert.strictEqual(rf.capabilityFactor({ contextOk: true, toolsOk: true }), 1);
  assert.strictEqual(rf.capabilityFactor({ contextOk: false, toolsOk: false }), 0);
  assert.strictEqual(rf.capabilityFactor({ contextOk: true, toolsOk: false }), 0.5);
  assert.strictEqual(rf.capabilityFactor({ contextOk: null, toolsOk: null }), rf.NEUTRAL);
  assert.strictEqual(rf.capabilityFactor({}), rf.NEUTRAL);
});

test('trust: honey rank normalizes, unknown rank is 0 (unranked = unvouched)', () => {
  assert.strictEqual(rf.trustFactor({ trustScore: 6 }), 1);
  assert.strictEqual(rf.trustFactor({ trustScore: 0 }), 0);
  assert.strictEqual(rf.trustFactor({}), 0);
  assert.ok(rf.trustFactor({ trustScore: 5 }) > rf.trustFactor({ trustScore: 2 }));
});

test('haversine: same point is 0 km, London→NYC is ~5570 km', () => {
  const lon = { lat: 51.5074, lon: -0.1278 };
  const nyc = { lat: 40.7128, lon: -74.0060 };
  assert.strictEqual(rf.haversineKm(lon, lon), 0);
  const km = rf.haversineKm(lon, nyc);
  assert.ok(km > 5500 && km < 5650, `got ${km}`);
  assert.strictEqual(rf.haversineKm(lon, {}), null, 'incomplete coords = unknown, not 0');
});

test('weightsFor: every mode has a weight for every factor', () => {
  for (const mode of Object.keys(rf.DEFAULT_WEIGHTS)) {
    const w = rf.weightsFor(mode);
    for (const k of rf.FACTORS) {
      assert.ok(Number.isFinite(w[k]), `${mode}.${k} missing`);
      assert.ok(w[k] >= 0, `${mode}.${k} negative`);
    }
    assert.ok(rf.weightTotal(w) > 0, `${mode} has no positive weight at all`);
  }
  // Unknown mode degrades to balanced rather than to an empty table.
  assert.deepStrictEqual(rf.weightsFor('nonsense'), rf.weightsFor('balanced'));
});

test('weightsFor: gateway_config.routing.weights overrides only the named mode', () => {
  const cfg = { fast: { latency: 9, bogus: 3, speed: -1 } };
  const fast = rf.weightsFor('fast', cfg);
  assert.strictEqual(fast.latency, 9, 'override applies');
  assert.strictEqual(fast.speed, rf.DEFAULT_WEIGHTS.fast.speed, 'negative override ignored');
  assert.ok(!('bogus' in fast), 'unknown factor names do not leak into the table');
  const balanced = rf.weightsFor('balanced', cfg);
  assert.deepStrictEqual(balanced, rf.DEFAULT_WEIGHTS.balanced, 'other modes untouched');
});

test('scoreWith: bounded 0..100, midpoint when nothing is weighted', () => {
  const w = { latency: 1, speed: 1 };
  assert.strictEqual(rf.scoreWith(w, { latency: 1, speed: 1 }), 100);
  assert.strictEqual(rf.scoreWith(w, { latency: 0, speed: 0 }), 0);
  assert.strictEqual(rf.scoreWith(w, { latency: 1, speed: 0 }), 50);
  assert.strictEqual(rf.scoreWith({}, { latency: 1 }), 50, 'no weights = midpoint, never NaN');
  assert.strictEqual(rf.scoreWith(w, { latency: 'x' }), 50, 'a bad factor reads as NEUTRAL');
});

// ═══════════════════════════════════════════════════════════════════════════
// B) mode intent, through the real scorer
// ═══════════════════════════════════════════════════════════════════════════

// Build a router WITHOUT running the constructor: the real one starts a
// spare-time monitor on setInterval, which would keep the test process alive.
function makeRouter({ perfRows = [], cfg = {}, ranks = null } = {}) {
  const r = Object.create(AIRouter.prototype);
  r.perf = { ranking: () => perfRows };
  r.orchestrator = null;
  r.relay = null;
  r.pool = null;
  r.policy = null;
  r.caps = null;
  r.providers = new Map();
  r.localEndpoints = [];
  r._priceMap = new Map();
  r._rankCache = { map: new Map(), at: 0 };
  r._hubGeo = null;
  r._hubGeoAt = 0;
  r._sticky = new Map();
  r._routeCfg = {
    jitter: 0, // determinism: no epsilon-greedy noise in an intent test
    unknown_tps: 8,
    quality_weights: { 'gpt-4': 10, claude: 10, gemini: 9, llama: 8, qwen: 8, gemma: 7, mistral: 7, phi: 5 },
    ...cfg,
  };
  if (ranks) r._ensureRanks = async () => ranks;
  return r;
}

// Two candidates that differ ONLY in the factor under test.
function row(node, model, over = {}) {
  return { node, model, via: 'direct', tps: 50, latency_ms: 400, prompt_tps: 600,
           ttfb_ms: 300, ok: 20, err: 0, ...over };
}
// The endpoint's LABEL is its hostname (router._routeLabel resolves a node
// first, and these fixtures have none), so the hostname IS the fixture name.
function target(name, model, over = {}) {
  return { url: `http://${name}:8080/v1/chat/completions`,
           name, provider: 'local', model, ...over };
}

async function rank(router, targets, mode, options = {}) {
  return router._scoreTargets(targets, mode, options);
}
const names = scored => scored.map(s => s.dbg.node);

test('every scored candidate carries a full factor vector in dbg', async () => {
  const r = makeRouter({ perfRows: [row('bee-a', 'gemma-4-E2B')] });
  const scored = await rank(r, [target('bee-a', 'gemma-4-E2B')], 'balanced');
  assert.strictEqual(scored.length, 1);
  assert.deepStrictEqual(Object.keys(scored[0].dbg.factors).sort(), [...rf.FACTORS].sort());
  assert.strictEqual(scored[0].dbg.ttfb_ms, 300, 'TTFT is reported alongside total latency');
});

// A bee that publishes its REAL slot window. llama.cpp divides its context
// across parallel slots, so "-c 4096 -np 4" is FOUR 1024-token slots behind
// a model name the name-table calls 32768 (yalla 2026-11-27).
function beeWithSlot(name, ctxSlot, slots, model = 'gemma-4-E2B-it-Q4_K_M.gguf') {
  return { node_id: name, name,
           local_models: [{ provider: 'llama.cpp:8080', model, ctx_slot: ctxSlot, slots }] };
}

test('a bee PUBLISHED slot window beats the model-name table', async () => {
  const r = makeRouter({ perfRows: [row('small-slot', 'gemma-4-E2B')] });
  r.orchestrator = { nodes: new Map([
    ['small-slot', beeWithSlot('small-slot', 1024, 4)],
  ]) };
  const scored = await rank(r, [target('small-slot', 'gemma-4-E2B-it-Q4_K_M.gguf')],
                            'balanced', { promptEst: 5000 });
  assert.strictEqual(scored[0].dbg.factors.capability, 0,
    'a 5k-token prompt does NOT fit in a published 1024-token slot');

  // The SAME bee without a published number: the name table says 32768, so
  // the router believes the prompt fits. That guess is what produced the
  // HTTP 400 (yalla 2026-11-27).
  const r2 = makeRouter({ perfRows: [row('small-slot', 'gemma-4-E2B')] });
  const s2 = await rank(r2, [target('small-slot', 'gemma-4-E2B-it-Q4_K_M.gguf')],
                        'balanced', { promptEst: 5000 });
  assert.strictEqual(s2[0].dbg.factors.capability, 1,
    'with no published window the name table still guesses');
});

test('a published window big enough keeps the candidate', async () => {
  const r = makeRouter({ perfRows: [row('big-slot', 'gemma-4-E2B')] });
  r.orchestrator = { nodes: new Map([
    ['big-slot', beeWithSlot('big-slot', 32768, 1)],
  ]) };
  const scored = await rank(r, [target('big-slot', 'gemma-4-E2B-it-Q4_K_M.gguf')],
                            'balanced', { promptEst: 5000 });
  assert.strictEqual(scored[0].dbg.factors.capability, 1,
    'a 32k slot holds a 5k prompt');
});

test('fast mode: the bee with the lower TTFT wins', async () => {
  const r = makeRouter({
    perfRows: [row('quick', 'gemma-4-E2B', { ttfb_ms: 150, latency_ms: 400 }),
               row('sluggish', 'gemma-4-E2B', { ttfb_ms: 4000, latency_ms: 4400 })],
  });
  const scored = await rank(r, [target('sluggish', 'gemma-4-E2B'), target('quick', 'gemma-4-E2B')], 'fast');
  assert.strictEqual(names(scored)[0], 'quick');
});

test('balanced mode: faster and more reliable both win', async () => {
  const r = makeRouter({
    perfRows: [row('swift', 'gemma-4-E2B', { tps: 90 }),
               row('slow', 'gemma-4-E2B', { tps: 15 })],
  });
  const scored = await rank(r, [target('slow', 'gemma-4-E2B'), target('swift', 'gemma-4-E2B')], 'balanced');
  assert.strictEqual(names(scored)[0], 'swift');

  const r2 = makeRouter({
    perfRows: [row('healthy', 'gemma-4-E2B', { ok: 40, err: 0 }),
               row('sickly', 'gemma-4-E2B', { ok: 10, err: 30 })],
  });
  const s2 = await rank(r2, [target('sickly', 'gemma-4-E2B'), target('healthy', 'gemma-4-E2B')], 'balanced');
  assert.strictEqual(names(s2)[0], 'healthy');
});

test('quality mode: the better model wins when speed is equal', async () => {
  const r = makeRouter({ perfRows: [row('bee-a', 'gpt-4o'), row('bee-b', 'gemma-4-E2B')] });
  const scored = await rank(r, [target('bee-b', 'gemma-4-E2B'), target('bee-a', 'gpt-4o')], 'quality');
  assert.strictEqual(names(scored)[0], 'bee-a');
});

test('cost mode: donated compute beats a priced endpoint by a wide margin', async () => {
  const r = makeRouter({
    perfRows: [row('localhost', 'gemma-4-E2B'), row('api.openai.com', 'gpt-4o-mini')],
  });
  r._priceMap.set('openai', { in: 2.5, out: 10 });
  const priced = { url: 'https://api.openai.com/v1/chat/completions',
                   name: 'api.openai.com', provider: 'openai', model: 'gpt-4o-mini' };
  // The free candidate must actually BE free: donated hub-local compute.
  const donated = { url: 'http://localhost:8080/v1/chat/completions', name: 'local-box',
                    provider: 'local', model: 'gemma-4-E2B' };
  const scored = await rank(r, [priced, donated], 'cost');
  assert.strictEqual(names(scored)[0], 'localhost', 'the donated local endpoint wins');
  const gap = scored[0].score - scored[1].score;
  assert.ok(gap >= 20, `free must beat priced decisively, got a gap of ${gap}`);
});

test('trusted mode: honey rank decides between otherwise equal bees', async () => {
  const ranks = new Map([['bee-a', { bee_rank: 'queen-bee' }], ['bee-b', { bee_rank: 'larva' }]]);
  const r = makeRouter({
    perfRows: [row('bee-a', 'gemma-4-E2B'), row('bee-b', 'gemma-4-E2B')],
    ranks,
  });
  const scored = await rank(r, [target('bee-b', 'gemma-4-E2B'), target('bee-a', 'gemma-4-E2B')], 'trusted');
  assert.strictEqual(names(scored)[0], 'bee-a');
});

test('private mode: a LAN peer outranks a public peer outranks cloud', async () => {
  const r = makeRouter({
    perfRows: [row('lan', 'gemma-4-E2B'), row('wan', 'gemma-4-E2B'), row('cloudbox', 'gemma-4-E2B')],
  });
  const lan = { url: 'http://192.168.1.9:8080/v1/chat/completions', name: 'lan',
                provider: 'local', model: 'gemma-4-E2B', nodeId: 'n-lan' };
  const wan = { url: 'http://203.0.113.7:8080/v1/chat/completions', name: 'wan',
                provider: 'local', model: 'gemma-4-E2B', nodeId: 'n-wan' };
  const cloudbox = { url: 'https://api.openai.com/v1/chat/completions', name: 'cloudbox',
                     provider: 'openai', model: 'gemma-4-E2B' };
  const scored = await rank(r, [cloudbox, wan, lan], 'private');
  // compare by endpoint NAME: a target's label is its hostname, and these
  // fixtures deliberately have no registered node to resolve to.
  assert.deepStrictEqual(scored.map(s => s.t.name), ['lan', 'wan', 'cloudbox']);
});

test('queue/capacity: the idle node outranks the loaded one', async () => {
  const mk = (id, name, ip, activeTasks) => ({
    node_id: id, name, ip, status: 'online', last_heartbeat: Date.now(),
    active_tasks: activeTasks, max_concurrent_jobs: 10,
    local_models: [], location: {},
  });
  const r = makeRouter({
    perfRows: [row('idle-bee', 'gemma-4-E2B'), row('busy-bee', 'gemma-4-E2B')],
    cfg: {},
  });
  r.orchestrator = {
    nodes: new Map([
      ['n-idle', mk('n-idle', 'idle-bee', '10.0.0.1', 0)],
      ['n-busy', mk('n-busy', 'busy-bee', '10.0.0.2', 8)],
    ]),
  };
  const idle = { url: 'http://10.0.0.1:8080/v1/chat/completions', name: 'idle-bee',
                 provider: 'local', model: 'gemma-4-E2B', nodeId: 'n-idle' };
  const busy = { url: 'http://10.0.0.2:8080/v1/chat/completions', name: 'busy-bee',
                 provider: 'local', model: 'gemma-4-E2B', nodeId: 'n-busy' };
  const scored = await rank(r, [busy, idle], 'balanced');
  assert.strictEqual(names(scored)[0], 'idle-bee');
  // …and the reasons are visible, not just the outcome.
  assert.ok(scored[0].dbg.factors.queue > scored[1].dbg.factors.queue);
  assert.ok(scored[0].dbg.factors.capacity > scored[1].dbg.factors.capacity);
});

test('capability: a request that needs tools prefers a bee that has them', async () => {
  const r = makeRouter({
    perfRows: [row('toolbee', 'qwen2.5-7b'), row('plainbee', 'vicuna-13b')],
  });
  const options = { tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] };
  // nodeId matters here: a target with no node and no localhost URL reads as a
  // cloud endpoint, which is tool-capable by assumption — the regex never runs.
  const plain = { ...target('plainbee', 'vicuna-13b'), nodeId: 'n-plain' };
  const tool = { ...target('toolbee', 'qwen2.5-7b'), nodeId: 'n-tool' };
  const scored = await rank(r, [plain, tool], 'balanced', options);
  assert.strictEqual(names(scored)[0], 'toolbee');
  assert.strictEqual(scored[0].dbg.factors.capability, 1);
  assert.strictEqual(scored[1].dbg.factors.capability, 0);
});

test('capability: a prompt too big for the model ranks that model last', async () => {
  const r = makeRouter({
    perfRows: [row('big-ctx', 'gemma-4-E2B'), row('small-ctx', 'tinyllama-1.1b')],
  });
  // contextWindowFor(): 'vicuna-13b' falls through to the 8192 default while
  // 'gemma-4-E2B' is 32768 — so 20k tokens fits one and not the other.
  const scored = await rank(r, [target('small-ctx', 'vicuna-13b'), target('big-ctx', 'gemma-4-E2B')],
                            'balanced', { promptEst: 20000 });
  assert.strictEqual(names(scored)[0], 'big-ctx');
  assert.strictEqual(scored[1].dbg.factors.capability, 0, 'cannot hold the prompt');
  assert.strictEqual(scored[0].dbg.factors.capability, 1);
});

test('an unmeasured bee stays reachable but never outranks a measured one', async () => {
  const r = makeRouter({ perfRows: [row('known', 'gemma-4-E2B', { tps: 60, ttfb_ms: 200 })] });
  const scored = await rank(r, [target('unknown', 'gemma-4-E2B'), target('known', 'gemma-4-E2B')], 'balanced');
  assert.strictEqual(names(scored)[0], 'known');
  // Unknown bees get PESSIMISTIC priors, not neutral ones: speed falls back to
  // cfg.unknown_tps (8 t/s) and latency to the 5000ms the old fast mode used.
  // Neutral would read as "probably fine", and fast mode must not hand its
  // promise to a bee nobody has ever watched. NEUTRAL is reserved for factors
  // that have no prior at all — capacity, queue, geography, capability.
  assert.strictEqual(scored[1].dbg.factors.speed, Number(rf.sat(8, 30).toFixed(3)));
  assert.strictEqual(scored[1].dbg.factors.latency, Number((1000 / 6000).toFixed(3)));
  assert.strictEqual(scored[1].dbg.factors.capacity, rf.NEUTRAL);
  assert.ok(scored[1].score < scored[0].score, 'unmeasured must still lose to measured');
});

test('routePreview publishes the weight table and per-candidate factors', async () => {
  const r = makeRouter({ perfRows: [row('bee-a', 'gemma-4-E2B')] });
  r.localEndpoints = [{ url: 'http://localhost:8080/v1/chat/completions', name: 'local-1',
                        provider: 'local', model: 'gemma-4-E2B' }];
  const out = await r.routePreview({ capability: 'reasoning', mode: 'fast' });
  assert.strictEqual(out.mode, 'fast');
  assert.ok(out.routing, 'routing block missing');
  assert.deepStrictEqual([...out.routing.factors].sort(), [...rf.FACTORS].sort());
  assert.strictEqual(out.routing.weight_total, rf.weightTotal(rf.weightsFor('fast')));
  assert.strictEqual(out.routing.score, '100 · Σ(weight × factor) / Σ(weight)');
  assert.ok(out.transports.direct[0].factors, 'per-candidate factors missing');
  assert.strictEqual(out.routing.hub_location, 'unknown', 'no geoIP yet = say so, do not guess');
});

test('gateway_config.routing.weights reaches the scorer', async () => {
  const r = makeRouter({
    perfRows: [row('bee-a', 'gpt-4o'), row('bee-b', 'gemma-4-E2B')],
    cfg: { weights: { balanced: { quality: 50, speed: 0 } } },
  });
  const scored = await rank(r, [target('bee-b', 'gemma-4-E2B'), target('bee-a', 'gpt-4o')], 'balanced');
  assert.strictEqual(names(scored)[0], 'bee-a', 'a configured weight override must actually route');
});

test('a FLAT routing.weights map is reported, never applied', async () => {
  const r = makeRouter({ cfg: { weights: { tps: 0.6, latency: 0.4 } } });
  const out = await r.routePreview({ mode: 'fast' });
  assert.deepStrictEqual(out.routing.unapplied_weights, { tps: 0.6, latency: 0.4 });
  assert.ok(out.routing.unapplied_note, 'the operator must be told, not ignored');
  assert.deepStrictEqual(out.routing.overrides, [], 'a flat map is not a mode');
  // The whole point: {latency: 0.4} must NOT rewrite fast mode's 2.0.
  assert.strictEqual(out.routing.weights.latency, rf.DEFAULT_WEIGHTS.fast.latency,
                     'a legacy flat map would silently gut fast mode');
});

test('a PER-MODE routing.weights table is applied and reported', async () => {
  const r = makeRouter({ cfg: { weights: { fast: { latency: 7 }, tps: 0.6 } } });
  const out = await r.routePreview({ mode: 'fast' });
  assert.deepStrictEqual(out.routing.overrides, ['fast']);
  assert.strictEqual(out.routing.weights.latency, 7, 'per-mode override applies');
  assert.deepStrictEqual(out.routing.unapplied_weights, { tps: 0.6 },
                         'the flat sibling is still reported separately');
  // other modes keep their defaults
  assert.strictEqual(rf.weightsFor('balanced', r._routeCfg.weights).latency,
                     rf.DEFAULT_WEIGHTS.balanced.latency);
});

test('two models on ONE host are measured separately, not aggregated', async () => {
  // masjid serves Qwen AND gemma. A label-only perf match gave both candidates
  // the same tps/latency, so the router could not tell them apart on speed.
  const r = makeRouter({
    perfRows: [row('hive', 'gpt-4o', { tps: 90, ttfb_ms: 100, latency_ms: 300 }),
               row('hive', 'gemma-4-E2B', { tps: 10, ttfb_ms: 4000, latency_ms: 4400 })],
  });
  const fast = { url: 'http://hive:8080/v1/chat/completions', name: 'a', model: 'gpt-4o' };
  const slow = { url: 'http://hive:8080/v1/chat/completions', name: 'b', model: 'gemma-4-E2B' };
  const scored = await rank(r, [slow, fast], 'fast');
  assert.strictEqual(scored[0].dbg.tps, 90, 'the fast model must see its OWN tps');
  assert.strictEqual(scored[1].dbg.tps, 10);
  assert.notStrictEqual(scored[0].dbg.factors.speed, scored[1].dbg.factors.speed);
  assert.strictEqual(scored[0].dbg.model, 'gpt-4o');
});

test('a model with no TTFT of its own does not borrow a sibling\'s', async () => {
  // Seen live: three localhost endpoints all reported ttfb=293 because only one
  // had ever answered — the per-signal caches fell back to the host prefix.
  const r = makeRouter({
    perfRows: [
      { node: 'hive', model: 'gpt-4o', via: 'direct', tps: 90, latency_ms: 300,
        prompt_tps: 600, ttfb_ms: 120, ok: 10, err: 0 },
      { node: 'hive', model: 'gemma-4-E2B', via: 'direct', tps: 40, latency_ms: 900,
        prompt_tps: 400, ttfb_ms: 0, ok: 10, err: 0 },
    ],
  });
  const a = { url: 'http://hive:8080/v1/chat/completions', name: 'a', model: 'gpt-4o' };
  const b = { url: 'http://hive:8080/v1/chat/completions', name: 'b', model: 'gemma-4-E2B' };
  const scored = await rank(r, [a, b], 'fast');
  const byModel = Object.fromEntries(scored.map(s => [s.dbg.model, s.dbg]));
  assert.strictEqual(byModel['gpt-4o'].ttfb_ms, 120, 'its own TTFT');
  assert.strictEqual(byModel['gemma-4-E2B'].ttfb_ms, null, 'must NOT borrow the sibling TTFT');
  assert.ok(byModel['gemma-4-E2B'].factors.latency < byModel['gpt-4o'].factors.latency,
            'its latency factor must use its own 900ms, not the sibling\'s 300ms');
  assert.strictEqual(byModel['gemma-4-E2B'].ttfb_ms, null);
});

test('an ERROR-ONLY model does not inherit a healthy sibling\'s numbers', async () => {
  // Live finding: localhost|qwen2.5:0.5b had ok_count=0, err_count=6. Skipping
  // error-only rows deleted the exact pair, so it fell back to the host and
  // borrowed gemma's 43 tps / 240ms TTFT — a model that had failed 6/6 looked
  // exactly as fast as the one actually serving traffic.
  const r = makeRouter({
    perfRows: [
      { node: 'hive', model: 'gpt-4o', via: 'direct', tps: 90, latency_ms: 300,
        prompt_tps: 600, ttfb_ms: 120, ok: 40, err: 0 },
      { node: 'hive', model: 'broken-7b', via: 'direct', tps: 0, latency_ms: 0,
        prompt_tps: 0, ttfb_ms: 0, ok: 0, err: 6 },
    ],
  });
  const good = { url: 'http://hive:8080/v1/chat/completions', name: 'a', model: 'gpt-4o' };
  const bad = { url: 'http://hive:8080/v1/chat/completions', name: 'b', model: 'broken-7b' };
  const scored = await rank(r, [good, bad], 'balanced');
  const byModel = Object.fromEntries(scored.map(s => [s.dbg.model, s.dbg]));
  assert.strictEqual(byModel['gpt-4o'].tps, 90, 'the healthy model keeps its own measurement');
  assert.strictEqual(byModel['broken-7b'].tps, 8, 'error-only rows carry NO speed signal');
  assert.strictEqual(byModel['broken-7b'].ttfb_ms, null, 'must not borrow the sibling TTFT');
  assert.strictEqual(byModel['broken-7b'].reliability, 0.25, 'the reliability FLOOR, not 1.0');
  assert.strictEqual(scored[0].dbg.model, 'gpt-4o', 'the healthy bee must win');
});

test('an unseen model name still falls back to the host measurements', async () => {
  const r = makeRouter({ perfRows: [row('hive', 'gemma-4-E2B', { tps: 70 })] });
  const unknownModel = { url: 'http://hive:8080/v1/chat/completions', name: 'a',
                         model: 'some-model-we-never-saw' };
  const scored = await rank(r, [unknownModel], 'balanced');
  assert.strictEqual(scored[0].dbg.tps, 70, 'no exact pair → use the host numbers');
});

// ── C) the stream loop's TTFT / token capture, against a real fake upstream ──
const http = require('http');

test('a NON-STREAMING reply still records TTFT and a speed signal', async () => {
  // `/api/chat` defaults to stream:false (it is what `hivv eval` uses), and a
  // non-streaming upstream sends ONE JSON body with message.content — no deltas.
  // The loop used to look only for delta.content, so those replies counted ZERO
  // tokens (no speed signal at all) and never set a TTFT.
  const upstream = http.createServer((_req, res) => {
    // A real delay so TTFT cannot be 0 by coincidence: the assertion proves the
    // timer started at request send, not at "some time".
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        model: 'gemma-4-E2B',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' },
                    finish_reason: 'stop' }],
        usage: { completion_tokens: 3, prompt_tokens: 10 },
      }));
    }, 40);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  try {
    const recorded = [];
    const router = makeRouter();
    router.perf = { ranking: () => [], record: o => recorded.push(o) };
    router.localEndpoints = [{ url: `http://127.0.0.1:${port}/v1/chat/completions`,
                               name: 'fake-upstream', provider: 'local', model: 'gemma-4-E2B' }];
    const chunks = [];
    const res = { setHeader() {}, write(s) { chunks.push(String(s)); }, end() {}, statusCode: 200 };
    const out = await router.tryLocalAI([{ role: 'user', content: 'hi' }], res, { stream: false });

    assert.ok(recorded.length >= 1, 'router recorded nothing: ' + JSON.stringify(out));
    const rec = recorded.find(r => r.ok !== false);
    assert.ok(rec, 'no successful completion was recorded: ' + JSON.stringify(recorded));
    assert.ok(rec.ttfbMs >= 30, `TTFT must span the 40ms upstream delay, got ${rec.ttfbMs}`);
    assert.ok(rec.ttfbMs <= (rec.latencyMs || 0), 'TTFT cannot exceed total latency');
    assert.ok(rec.tps > 0, 'a non-streaming reply must still contribute a speed signal');
    assert.ok(chunks.join('').includes('hello'), 'the answer was not forwarded to the client');
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('CANARY: the ad-hoc switch(mode) formulas are gone from the scorer', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'router.js'), 'utf8');
  assert.ok(!src.includes('20000 / Math.max(lat'), 'fast mode regressed to the ad-hoc latency formula');
  assert.ok(!src.includes("score = free + tps * 0.1 * rel"), 'cost mode regressed to the binary free term');
  assert.ok(src.includes('routeFactors.computeFactors'), 'scorer no longer builds a factor vector');
  assert.ok(src.includes('firstTokenAt'), 'TTFT is no longer captured from the stream');
});
