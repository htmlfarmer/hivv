// api/lib/lyrz.js — HIVV → LYRz settlement bridge.
//
// HIVV accrues "honey" for nodes: 1 per minute online, 10 per job completed,
// 1 per 100 tokens served. Honey is HIVV's internal reward for keeping the
// gateway humming.
//
// This module gives that work a second, portable form: a LYRz balance that
// follows the node wherever it goes in the ecosystem (lyrz.org, blnq.org,
// hivv.org, xyzo.org).
//
// Design notes
// ------------
// * Idempotent. Each accrual is keyed by (node_id, kind, counter) so a
//   replayed heartbeat can never pay twice.
// * Queued, not dropped. If LYRz is unreachable the batch is parked and
//   retried. Work is never silently lost.
// * Nothing is paid without a real LYRz identity. A node must have a linked
//   global_user_id before any settlement happens for it.
// * Honey is HIVV's own unit. It is NOT 1:1 with LYRz — the conversion
//   factor is configurable so the economics stay deliberate.

// The pool is injected by the server at boot, matching the pattern used by
// the other HIVV modules (see lib/honey.js).
let pool = null;

function inject(dbPool) {
  pool = dbPool;
}

function getPool() {
  if (!pool) {
    throw new Error('lyrz bridge not initialised: pool has not been injected');
  }
  return pool;
}

const LYRZ_API = (process.env.LYRZ_API_URL || 'https://lyrz.org/api/v1').replace(/\/+$/, '');
const LYRZ_SITE_ID = process.env.LYRZ_SITE_ID || 'hivv.org';
const LYRZ_API_KEY = String(process.env.LYRZ_API_KEY || '').trim();  // trim: a key file's trailing newline must never become %0A on the wire

// How much LYRz one honey point is worth. Deliberately small: honey is a
// fine-grained internal signal, and LYRz is the portable unit.
const LYRZ_PER_HONEY = parseFloat(process.env.HIVV_LYRZ_PER_HONEY || '0.1');

const BATCH_SIZE = parseInt(process.env.LYRZ_SETTLE_BATCH || '50', 10);
const INTERVAL_MS = parseInt(process.env.LYRZ_SETTLE_INTERVAL_MS || String(5 * 60 * 1000), 10);

let timer = null;
let running = false;

async function ensureQueueTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS lyrz_settlement_queue (
      queue_id        BIGSERIAL PRIMARY KEY,
      idempotency_key VARCHAR(191) NOT NULL UNIQUE,
      node_id         VARCHAR(191) NOT NULL,
      global_user_id  VARCHAR(64),
      honey_delta     NUMERIC(18,6) NOT NULL DEFAULT 0,
      lyrz_delta      NUMERIC(18,6) NOT NULL DEFAULT 0,
      kind            VARCHAR(32) NOT NULL DEFAULT 'honey',
      status          VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS idx_lyrz_queue_status ON lyrz_settlement_queue(status, updated_at)`
  );
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS idx_lyrz_queue_node ON lyrz_settlement_queue(node_id)`
  );
  // Link a node to a LYRz identity.
  await getPool().query(
    `ALTER TABLE hivv_node_stats ADD COLUMN IF NOT EXISTS lyrz_global_user_id VARCHAR(64)`
  );
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS idx_node_stats_lyrz ON hivv_node_stats(lyrz_global_user_id)
       WHERE lyrz_global_user_id IS NOT NULL`
  );
}

async function lyrzFetch(path, options = {}) {
  if (!LYRZ_API_KEY) throw new Error('LYRZ_API_KEY is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${LYRZ_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${encodeURIComponent(LYRZ_API_KEY)}`,  // ASCII-safe wire form: the key may be a UTF-8 riddle
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    return body?.data || body;
  } finally {
    clearTimeout(timeout);
  }
}

/** Look up the LYRz identity linked to a node. */
async function resolveGlobalUserId(nodeId) {
  const { rows } = await getPool().query(
    `SELECT global_user_id FROM lyrz_settlement_queue
      WHERE node_id = $1 AND global_user_id IS NOT NULL LIMIT 1`,
    [nodeId]
  );
  if (rows[0]?.global_user_id) return rows[0].global_user_id;

  const { rows: nodeRows } = await getPool().query(
    `SELECT lyrz_global_user_id FROM hivv_node_stats
      WHERE node_id = $1 AND lyrz_global_user_id IS NOT NULL LIMIT 1`,
    [nodeId]
  );
  return nodeRows[0]?.lyrz_global_user_id || null;
}

/**
 * Queue a settlement for honey earned by a node.
 * `counter` should be a monotonically increasing value for the accrual
 * (e.g. the cumulative job count) so the same accrual is never queued twice.
 */
async function enqueueSettlement({ nodeId, globalUserId, honeyDelta, kind = 'honey', counter = null }) {
  // Self-heal: if the table is not there yet (first run, or a race with
  // startup), create it rather than dropping the accrual on the floor.
  try {
    await getPool().query('SELECT 1 FROM lyrz_settlement_queue LIMIT 1');
  } catch {
    await ensureQueueTable();
  }

  const idempotencyKey = `lyrz:${nodeId}:${kind}:${counter ?? Date.now()}`;
  await getPool().query(
    `INSERT INTO lyrz_settlement_queue
       (idempotency_key, node_id, global_user_id, honey_delta, lyrz_delta, kind, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      idempotencyKey,
      nodeId,
      globalUserId || null,
      honeyDelta,
      Number((honeyDelta * LYRZ_PER_HONEY).toFixed(6)),
      kind,
    ]
  );
}

/**
 * Settle one batch of queued honey.
 * Never throws — a settlement failure must not take the gateway down.
 */
async function settleBatch(limit = BATCH_SIZE) {
  if (running) return { skipped: true, reason: 'already running' };
  running = true;

  const summary = { settled: 0, skipped: 0, failed: 0, errors: [] };

  try {
    await ensureQueueTable();

    const { rows: pending } = await getPool().query(
      `SELECT * FROM lyrz_settlement_queue
        WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    if (!pending.length) return summary;

    // Group by node so one LYRz call can carry a node's whole batch.
    const byNode = new Map();
    for (const row of pending) {
      if (!row.global_user_id) { summary.skipped++; continue; }
      if (!byNode.has(row.node_id)) {
        byNode.set(row.node_id, {
          nodeId: row.node_id,
          globalUserId: row.global_user_id,
          delta: 0,
          rows: [],
        });
      }
      const group = byNode.get(row.node_id);
      group.delta += Number(row.lyrz_delta || 0);
      group.rows.push(row);
    }

    for (const group of byNode.values()) {
      if (group.delta <= 0) {
        await getPool().query(
          `UPDATE lyrz_settlement_queue SET status = 'settled', updated_at = NOW()
            WHERE queue_id = ANY($1::bigint[])`,
          [group.rows.map(r => r.queue_id)]
        );
        summary.skipped += group.rows.length;
        continue;
      }

      try {
        await lyrzFetch('/karma/sync', {
          method: 'POST',
          body: JSON.stringify({
            site_id: LYRZ_SITE_ID,
            karma_delta: group.delta,
            user_id: group.globalUserId,
            action: 'honey_settlement',
          }),
        });

        await getPool().query(
          `UPDATE lyrz_settlement_queue SET status = 'settled', updated_at = NOW()
            WHERE queue_id = ANY($1::bigint[])`,
          [group.rows.map(r => r.queue_id)]
        );
        summary.settled += group.rows.length;
      } catch (err) {
        const message = String(err?.message || err);
        summary.failed += group.rows.length;
        summary.errors.push(message);
        await getPool().query(
          `UPDATE lyrz_settlement_queue
              SET status = 'pending', attempts = attempts + 1,
                  last_error = $2, updated_at = NOW()
            WHERE queue_id = ANY($1::bigint[])`,
          [group.rows.map(r => r.queue_id), message.slice(0, 500)]
        );
      }
    }
  } catch (err) {
    summary.errors.push(String(err?.message || err));
  } finally {
    running = false;
  }

  return summary;
}

function startSettlementLoop() {
  if (timer) return;
  if (!LYRZ_API_KEY) {
    console.warn('[lyrz] settlement disabled: LYRZ_API_KEY is not configured');
    return;
  }
  const tick = () => {
    settleBatch()
      .then(s => {
        if (s.settled || s.failed) {
          console.log(
            `[lyrz] settlement: settled=${s.settled} failed=${s.failed} skipped=${s.skipped}` +
            (s.errors.length ? ` errors=${s.errors.slice(0, 2).join(' | ')}` : '')
          );
        }
      })
      .catch(e => console.error('[lyrz] settlement loop error:', e.message));
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  tick();
  console.log(`[lyrz] settlement loop started (every ${INTERVAL_MS}ms) → ${LYRZ_API}`);
}

function stopSettlementLoop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  inject,
  ensureQueueTable,
  enqueueSettlement,
  resolveGlobalUserId,
  settleBatch,
  startSettlementLoop,
  stopSettlementLoop,
  lyrzFetch,
  config: { LYRZ_API, LYRZ_SITE_ID, LYRZ_PER_HONEY, enabled: !!LYRZ_API_KEY },
};
