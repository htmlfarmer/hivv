// api/lib/perf.js — measured model performance (EWMA) per node+model+transport.
// Plan: HIVV_PLAN.md #7 + HIVV_CAPABILITY_POLICY_PLAN.md §2 data honesty.
// The router records one sample per completion (tps + latency + ok/err); relay
// measurements are kept SEPARATE from direct ones — relay "tps" includes inbox
// queue + poll wait and would otherwise make fast-but-NAT'd bees look slow.
// Consumers (routing, CLI lottery, dashboard) prefer direct rows.

let pool = null;
let timer = null;
const ALPHA = 0.3;
// becomes false if migration 030 has not been applied (see flush)
let ttfbCol = true;

// key: `${node_id}::${model}::${via}` -> { tps, lat, samples, ok, err, dirty }
const mem = new Map();

function _key(nodeId, model, via) { return `${nodeId}::${model || 'unknown'}::${via || 'direct'}`; }

function record({ node, model, tps = 0, latencyMs = 0, ok = true, via = 'direct', promptTps = 0, ttfbMs = 0 }) {
  if (!node) return;
  const k = _key(node, model, via);
  let s = mem.get(k);
  // f* = cumulative counters already flushed to DB (flush ships DELTAS, not totals)
  if (!s) { s = { tps: 0, lat: 0, ptps: 0, ttfb: 0, samples: 0, ok: 0, err: 0, dirty: 0, fSamples: 0, fOk: 0, fErr: 0 }; mem.set(k, s); }
  if (ok) {
    // seed on first SUCCESS (s.ok===0), not first sample — an earlier error
    // must not drag the EWMA toward 0 (0 tps / 0 ms would poison fast-mode routing)
    if (tps > 0) s.tps = s.ok === 0 ? tps : (1 - ALPHA) * s.tps + ALPHA * tps;
    s.lat = s.ok === 0 ? latencyMs : (1 - ALPHA) * s.lat + ALPHA * latencyMs;
    // prompt-processing speed (tokens/s) — THE latency term for big cold
    // prompts (OpenCode ships ~5k-token system prompts on every request)
    if (promptTps > 0) s.ptps = s.ok === 0 ? promptTps : (1 - ALPHA) * s.ptps + ALPHA * promptTps;
    // TTFT (time to first token) — what the user actually waits on. latencyMs
    // is the WHOLE completion, so it always overstates the wait; routing's
    // latency factor prefers this whenever it exists.
    if (ttfbMs > 0) s.ttfb = s.ok === 0 ? ttfbMs : (1 - ALPHA) * s.ttfb + ALPHA * ttfbMs;
    s.ok++;
  } else {
    s.err++;
  }
  s.samples++;
  s.dirty++;
}

async function flush() {
  if (!pool) return;
  const dirty = [...mem.entries()].filter(([, s]) => s.dirty > 0);
  for (const [k, s] of dirty) {
    s.dirty = 0;
    // ship only what changed since the last flush — the upsert ADDS these to the
    // stored totals, so sending cumulative counters would inflate them every 30s.
    const dSamples = s.samples - s.fSamples;
    const dOk = s.ok - s.fOk;
    const dErr = s.err - s.fErr;
    s.fSamples = s.samples; s.fOk = s.ok; s.fErr = s.err;
    if (dSamples <= 0) continue;
    const [node, model, via] = k.split('::');
    // ewma_ttfb_ms arrives with migration 030. If it has not been applied yet
    // the INSERT would fail and take tps/latency persistence down with it, so
    // fall back to the old column list ONCE and remember — a missing column
    // must degrade the schema, never the measurements.
    const cols = ttfbCol
      ? '(node_id, model, via, ewma_tps, ewma_latency_ms, ewma_ttfb_ms, samples, ok_count, err_count, updated_at)'
      : '(node_id, model, via, ewma_tps, ewma_latency_ms, samples, ok_count, err_count, updated_at)';
    const vals = ttfbCol ? '($1, $2, $3, $4, $5, $9, $6, $7, $8, NOW())' : '($1, $2, $3, $4, $5, $6, $7, $8, NOW())';
    const upd = ttfbCol
      ? `ewma_tps = EXCLUDED.ewma_tps,
          ewma_latency_ms = EXCLUDED.ewma_latency_ms,
          ewma_ttfb_ms = EXCLUDED.ewma_ttfb_ms,
          samples = hivv_model_perf.samples + $6,`
      : `ewma_tps = EXCLUDED.ewma_tps,
          ewma_latency_ms = EXCLUDED.ewma_latency_ms,
          samples = hivv_model_perf.samples + $6,`;
    try {
      await pool.query(
        `INSERT INTO hivv_model_perf ${cols} VALUES ${vals}
         ON CONFLICT (node_id, model, via) DO UPDATE SET
           ${upd}
           ok_count = hivv_model_perf.ok_count + $7,
           err_count = hivv_model_perf.err_count + $8,
           updated_at = NOW()`,
        [node, model, via, s.tps, s.lat, dSamples, dOk, dErr, s.ttfb || 0]);
    } catch (e) {
      if (ttfbCol && /ewma_ttfb_ms/.test(e.message || '')) {
        ttfbCol = false;
        console.warn('[PERF] ewma_ttfb_ms column missing — run migration 030_perf_ttfb.sql (TTFT stays in-memory until then)');
      } else {
        console.warn(`[PERF] flush ${k} failed: ${e.message}`);
      }
    }
  }
}

// rows for one node+model: direct measurement wins; relay only tells the truth about relay
function _preferByPair(rows, nodeKey = 'node', modelKey = 'model') {
  const byPair = new Map();
  for (const r of rows) {
    const pk = `${r[nodeKey]}::${r[modelKey]}`;
    const cur = byPair.get(pk);
    if (!cur) { byPair.set(pk, r); continue; }
    if (cur.via !== 'direct' && r.via === 'direct') byPair.set(pk, r);
  }
  return [...byPair.values()];
}

function ranking(modelFragment = '') {
  const frag = modelFragment.toLowerCase();
  const rows = [...mem.entries()]
    .filter(([k, s]) => s.samples > 0 && (!frag || k.toLowerCase().includes(frag)))
    .map(([k, s]) => {
      const [node, model, via] = k.split('::');
      return { node, model, via: via || 'direct', tps: Math.round(s.tps), latency_ms: Math.round(s.lat),
               prompt_tps: Math.round(s.ptps || 0),
               // TTFT: null (not 0) when never measured — 'no data' and
               // 'measured instant' are different truths.
               ttfb_ms: s.ttfb > 0 ? Math.round(s.ttfb) : null,
               samples: s.samples, ok: s.ok, err: s.err };
    });
  return _preferByPair(rows)
    .sort((a, b) => (b.tps - a.tps) || (a.latency_ms - b.latency_ms));
}

// best known node for a model (used by routing hints); null if no data
function bestFor(model) {
  const r = ranking(model).filter(x => (x.via === 'direct') && (x.err === 0 || x.ok / (x.ok + x.err) > 0.9));
  return r[0] || null;
}

const SNAPSHOT_COLS = 'node_id, model, via, ewma_tps, ewma_latency_ms, ewma_ttfb_ms, samples, ok_count, err_count, updated_at';
const SNAPSHOT_COLS_OLD = 'node_id, model, via, ewma_tps, ewma_latency_ms, samples, ok_count, err_count, updated_at';

async function snapshot(limit = 50) {
  if (!pool) return _preferByPair(ranking()).slice(0, limit);
  const run = async (cols) => {
    const r = await pool.query(
      `SELECT ${cols} FROM hivv_model_perf ORDER BY (via = 'direct') DESC, ewma_tps DESC`);
    const preferred = _preferByPair(r.rows, 'node_id', 'model');
    preferred.sort((a, b) => ((b.via === 'direct') - (a.via === 'direct')) || (b.ewma_tps - a.ewma_tps));
    return preferred.slice(0, limit);
  };
  try {
    return await run(SNAPSHOT_COLS);
  } catch (e) {
    // migration 030 not applied yet → serve the old columns rather than
    // dropping the whole public perf view on the floor.
    if (/ewma_ttfb_ms/.test(e?.message || '')) {
      ttfbCol = false;
      try { return await run(SNAPSHOT_COLS_OLD); } catch { /* fall through */ }
    }
    return _preferByPair(ranking()).slice(0, limit);
  }
}

// Rehydrate from the DB on boot. Without this every gateway restart resets the
// whole hive to "unknown bee" — the router would score on priors until the
// first self-reports trickled in, which is exactly the window where routing
// decisions matter most. f* counters are seeded to the stored totals so the
// next flush still ships DELTAS only (no double counting).
async function seed(pgPool = pool, limit = 2000) {
  if (!pgPool) return 0;
  const run = async (cols) => pgPool.query(
    `SELECT ${cols} FROM hivv_model_perf
      WHERE updated_at > NOW() - INTERVAL '14 days'
      ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 2000)}`);
  let rows;
  try {
    rows = (await run(SNAPSHOT_COLS)).rows;
  } catch (e) {
    if (/ewma_ttfb_ms/.test(e?.message || '')) {
      ttfbCol = false;
      try { rows = (await run(SNAPSHOT_COLS_OLD)).rows; } catch { return 0; }
    } else return 0;
  }
  let n = 0;
  for (const r of rows) {
    const k = _key(r.node_id, r.model, r.via);
    if (mem.has(k)) continue; // live measurements beat the disk
    const s = {
      tps: Number(r.ewma_tps) || 0,
      lat: Number(r.ewma_latency_ms) || 0,
      ptps: 0,
      ttfb: Number(r.ttfb_ms ?? r.ewma_ttfb_ms) || 0,
      samples: Number(r.samples) || 0,
      ok: Number(r.ok_count) || 0,
      err: Number(r.err_count) || 0,
      dirty: 0,
      fSamples: Number(r.samples) || 0,
      fOk: Number(r.ok_count) || 0,
      fErr: Number(r.err_count) || 0,
    };
    mem.set(k, s);
    n++;
  }
  if (n) console.log(`[PERF] seeded ${n} node/model row(s) from the database`);
  return n;
}

function start(pgPool, flushMs = 30000) {
  pool = pgPool;
  timer = setInterval(() => flush().catch(() => {}), flushMs);
  // Fire-and-forget: a slow/failing DB must never hold the gateway boot.
  seed(pgPool).catch(() => {});
  console.log(`[PERF] model-performance tracker started (flush ${Math.round(flushMs / 1000)}s)`);
}

function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, record, ranking, bestFor, snapshot, seed };
