// api/lib/honey.js — bee identity: honey accrual, ranks, streaks, hive goals.
// Plan: HIVV_PLAN.md #1. Hub-side only — nodes cannot mint their own honey;
// we diff the cumulative counters that arrive via heartbeats (orchestrator.nodes)
// against a DB cursor, so restarts never double-count.
//
// Honey math (boring on purpose):
//   1 per minute online · 10 per job completed · 1 per 100 tokens served

let pool = null;
let timer = null;

const RANK_SQL = `CASE
    WHEN honey >= 500000 THEN 'queen-bee'
    WHEN honey >= 100000 THEN 'royal-jelly'
    WHEN honey >= 25000  THEN 'scout'
    WHEN honey >= 5000   THEN 'forager'
    WHEN honey >= 500    THEN 'worker'
    ELSE 'larva' END`;

const HONEY_PER = { minute: 1, job: 10, tokens_per_honey: 100 };

// C2: golden-hive days — fetch active event multiplier (stacks multiplicatively)
let _cachedMultiplier = 1.0;
let _multiplierCacheAt = 0;
const MULTIPLIER_CACHE_TTL_MS = 60000; // refresh every minute

async function _getActiveMultiplier() {
  if (Date.now() - _multiplierCacheAt < MULTIPLIER_CACHE_TTL_MS) return _cachedMultiplier;
  try {
    const r = await pool.query(
      `SELECT COALESCE(MAX(honey_multiplier), 1.0::numeric) AS mult
       FROM hivv_hive_events
       WHERE active AND CURRENT_DATE BETWEEN start_date AND end_date`);
    _cachedMultiplier = parseFloat(r.rows[0]?.mult || 1.0) || 1.0;
    _multiplierCacheAt = Date.now();
  } catch (_) { /* non-fatal: use cached or 1.0 */ }
  return _cachedMultiplier;
}

// C9: goal title rotation — each ISO week picks the next title
const GOAL_TITLES = [
  "answer as many questions as we can",
  "push the frontier of curious minds",
  "power the world's open AI",
  "connect every learner to smart AI",
  "run more inference than ever before",
  "spread knowledge across the network",
  "prove distributed AI works at scale",
  "help every bee find their voice",
  "be useful to 1000 people today",
  "set a new hive record",
  "build the hive's memory together",
  "learn from every conversation",
];

function rankFor(honey) {
  if (honey >= 500000) return 'queen-bee';
  if (honey >= 100000) return 'royal-jelly';
  if (honey >= 25000) return 'scout';
  if (honey >= 5000) return 'forager';
  if (honey >= 500) return 'worker';
  return 'larva';
}

// C9: independent weekly goal reset — runs every flush even if no jobs happen,
// so the goal doesn't stay stuck from the prior week.
async function _resetGoalIfNeeded() {
  try {
    const g = await pool.query('SELECT week_start, title_index FROM hivv_hive_goal WHERE id = 1');
    if (!g.rows[0]) return;
    const row = g.rows[0];
    const thisWeek = new Date(Date.now() - new Date().getDay() * 86400000).toISOString().slice(0, 10);
    if (row.week_start && row.week_start.toISOString().slice(0, 10) < thisWeek) {
      const now = new Date();
      const weekNum = Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 86400000 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7);
      const titleIdx = weekNum % GOAL_TITLES.length;
      await pool.query(`
        UPDATE hivv_hive_goal
           SET progress = 0,
               week_start = DATE_TRUNC('week', NOW())::date,
               title = $1,
               title_index = $2,
               updated_at = NOW()
         WHERE id = 1`, [GOAL_TITLES[titleIdx], titleIdx]);
      console.log(`[HONEY] goal reset for week ${thisWeek}: "${GOAL_TITLES[titleIdx]}"`);
    }
  } catch (e) { console.warn(`[HONEY] goal reset check failed: ${e.message}`); }
}

async function _flushOnce(orchestrator) {
  // C9: check weekly goal reset at start of every flush cycle
  await _resetGoalIfNeeded();

  const nodes = Array.from(orchestrator.nodes.values());
  for (const node of nodes) {
    const id = node.node_id;
    try {
      const cur = await pool.query(
        'SELECT seen_jobs, seen_tokens, honey, streak_days, last_online_date FROM hivv_node_stats WHERE node_id = $1',
        [id]);
      const row = cur.rows[0] || {};
      const cumJobs = node.cum?.tasks_completed ?? (node.stats?.tasks_completed || node.tasks_completed || 0);
      const cumTokens = node.cum?.tokens_processed ?? (node.stats?.total_tokens_processed || node.total_tokens_processed || 0);
      const online = node.status !== 'offline';

      const jobDelta = Math.max(0, cumJobs - (row.seen_jobs ?? 0));
      const tokDelta = Math.max(0, cumTokens - (row.seen_tokens ?? 0));
      const minuteDelta = online ? 1 : 0;

      // TPS: tokens processed since last heartbeat / 60s, smoothed with EWMA (α=0.3)
      // If the node has no recent token activity, tps decays toward 0.
      let tps = row.tokens_per_sec || 0;
      if (online && minuteDelta > 0) {
        const instantTps = tokDelta > 0 ? tokDelta / 60 : 0;
        tps = tps === 0 ? instantTps : Math.round(((tps * 0.7) + (instantTps * 0.3)) * 10) / 10;
      } else if (!online) {
        tps = 0;
      }
      // C2: apply golden-hive multiplier to job + token honey (not online-minute loyalty)
      const mult = await _getActiveMultiplier();
      const rawHoney = minuteDelta * HONEY_PER.minute +
        jobDelta * HONEY_PER.job +
        Math.floor(tokDelta / HONEY_PER.tokens_per_honey);
      const honeyDelta = mult > 1 ? Math.round(rawHoney * mult) : rawHoney;

      if (!online && !jobDelta && !tokDelta && row.honey != null) continue; // nothing to say

      const up = await pool.query(`
        INSERT INTO hivv_node_stats
          (node_id, honey, minutes_online, jobs_completed, tokens_served,
           streak_days, best_streak_days, last_online_date, seen_jobs, seen_tokens, bee_rank)
        VALUES
          ($1, $2::bigint, $3::bigint, $4::bigint, $5::bigint,
           CASE WHEN $3::int > 0 THEN
             CASE WHEN $6::date IS NULL THEN 1
                  WHEN $6::date = CURRENT_DATE THEN GREATEST($7::int, 1)
                  WHEN $6::date = CURRENT_DATE - 1 THEN $7::int + 1
                  ELSE 1 END
           ELSE CASE WHEN $6::date IS NOT NULL AND CURRENT_DATE - $6::date > 2 THEN 0 ELSE $7::int END
           END,
           GREATEST($8::int, CASE WHEN $3::int > 0 THEN 1 ELSE 0 END),
           CASE WHEN $3::int > 0 THEN CURRENT_DATE ELSE $6::date END,
           GREATEST($9::bigint, $4::bigint), GREATEST($10::bigint, $5::bigint), 'larva')
        ON CONFLICT (node_id) DO UPDATE SET
          honey          = hivv_node_stats.honey + EXCLUDED.honey,
          minutes_online = hivv_node_stats.minutes_online + EXCLUDED.minutes_online,
          jobs_completed = hivv_node_stats.jobs_completed + EXCLUDED.jobs_completed,
          tokens_served  = hivv_node_stats.tokens_served + EXCLUDED.tokens_served,
          streak_days    = EXCLUDED.streak_days,
          best_streak_days = GREATEST(hivv_node_stats.best_streak_days, EXCLUDED.streak_days),
          last_online_date = EXCLUDED.last_online_date,
          seen_jobs      = GREATEST(hivv_node_stats.seen_jobs, EXCLUDED.seen_jobs),
          seen_tokens    = GREATEST(hivv_node_stats.seen_tokens, EXCLUDED.seen_tokens),
          tokens_per_sec = $11,
          updated_at     = NOW()
        RETURNING honey, streak_days`,
        [id, honeyDelta, minuteDelta, jobDelta, tokDelta,
         row.last_online_date || null, row.streak_days ?? 0,
         row.streak_days ?? 0, cumJobs, cumTokens, tps]);

      const honeyTotal = up.rows[0]?.honey ?? 0;
      await pool.query(
        `UPDATE hivv_node_stats SET bee_rank = ${RANK_SQL} WHERE node_id = $1`, [id]);

      if (honeyDelta > 0) {
        if (jobDelta > 0) {
          await pool.query(
            'INSERT INTO hivv_honey_events (node_id, kind, amount) VALUES ($1, $2, $3)',
            [id, 'job', jobDelta * HONEY_PER.job]);
        }
        if (tokDelta >= HONEY_PER.tokens_per_honey) {
          await pool.query(
            'INSERT INTO hivv_honey_events (node_id, kind, amount) VALUES ($1, $2, $3)',
            [id, 'tokens_served', Math.floor(tokDelta / HONEY_PER.tokens_per_honey)]);
        }
        if (minuteDelta > 0) {
          await pool.query(
            'INSERT INTO hivv_honey_events (node_id, kind, amount) VALUES ($1, $2, $3)',
            [id, 'online_minute', HONEY_PER.minute]);
        }
        // weekly hive goal tracks jobs done by the whole hive
        if (jobDelta > 0) {
          try {
            // C9: title rotates each week using ISO week number
            const now = new Date();
            const weekNum = Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 86400000 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7);
            const titleIdx = weekNum % GOAL_TITLES.length;
            const newTitle = GOAL_TITLES[titleIdx];
            await pool.query(`
              UPDATE hivv_hive_goal
                 SET progress = CASE WHEN week_start < DATE_TRUNC('week', NOW())::date
                                      THEN $1::bigint
                                      ELSE progress + $1::bigint END,
                     week_start = DATE_TRUNC('week', NOW())::date,
                     title = $2,
                     title_index = $3,
                     updated_at = NOW()
               WHERE id = 1`, [jobDelta, newTitle, titleIdx]);
          } catch (ge) {
            console.warn(`[HONEY] goal update failed: ${ge.message}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[HONEY] flush ${id} failed: ${e.message}`);
    }
  }
}

// ---- read APIs ---------------------------------------------------------

async function profile(nodeId) {
  const base = await pool.query('SELECT * FROM hivv_node_stats WHERE node_id = $1', [nodeId]);
  if (!base.rows[0]) return null;
  const s = base.rows[0];
  const [week, month, position] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::bigint AS h FROM hivv_honey_events
        WHERE node_id = $1 AND created_at > NOW() - interval '7 days'`, [nodeId]),
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::bigint AS h FROM hivv_honey_events
        WHERE node_id = $1 AND created_at > NOW() - interval '30 days'`, [nodeId]),
    pool.query(
      `SELECT COUNT(*)::int AS ahead FROM hivv_node_stats WHERE honey > $1`, [s.honey]),
  ]);
  return {
    node_id: s.node_id,
    honey: Number(s.honey),
    rank: s.bee_rank,
    streak_days: s.streak_days,
    best_streak_days: s.best_streak_days,
    minutes_online: Number(s.minutes_online),
    jobs_completed: Number(s.jobs_completed),
    tokens_served: Number(s.tokens_served),
    week_honey: Number(week.rows[0].h),
    month_honey: Number(month.rows[0].h),
    position: position.rows[0].ahead + 1,
    first_seen_at: s.first_seen_at,
  };
}

async function leaderboard({ window = 'all', limit = 20 } = {}) {
  if (window === 'week' || window === 'month') {
    const interval = window === 'week' ? '7 days' : '30 days';
    const r = await pool.query(
      `SELECT e.node_id, SUM(e.amount)::bigint AS honey, s.bee_rank, s.streak_days
         FROM hivv_honey_events e
         LEFT JOIN hivv_node_stats s ON s.node_id = e.node_id
        WHERE e.created_at > NOW() - $1::interval
        GROUP BY e.node_id, s.bee_rank, s.streak_days
        ORDER BY honey DESC LIMIT $2`, [interval, limit]);
    return r.rows.map(x => ({ ...x, honey: Number(x.honey) }));
  }
  const r = await pool.query(
    `SELECT node_id, honey::bigint, bee_rank, streak_days, best_streak_days,
            jobs_completed::bigint, minutes_online::bigint
       FROM hivv_node_stats ORDER BY honey DESC LIMIT $1`, [limit]);
  return r.rows.map(x => ({ ...x, honey: Number(x.honey), jobs_completed: Number(x.jobs_completed), minutes_online: Number(x.minutes_online) }));
}

async function hiveGoal() {
  const g = await pool.query('SELECT * FROM hivv_hive_goal WHERE id = 1');
  const s = await pool.query(
    `SELECT COUNT(*)::int AS bees, COALESCE(SUM(jobs_completed),0)::bigint AS jobs
       FROM hivv_node_stats`);
  return { goal: g.rows[0] || null, bees: s.rows[0]?.bees ?? 0, total_jobs: Number(s.rows[0]?.jobs ?? 0) };
}

function start(orchestratorRef, pgPool, intervalMs = 60000) {
  // LOCAL/OFFLINE MODE: honey accrual is persisted in Postgres. Without it
  // there is nothing to sweep — and a null pool must never throw.
  if (!pgPool) {
    console.warn('[HONEY] no database — honey accrual disabled (local/offline mode)');
    return;
  }
  pool = pgPool;
  const tick = () => _flushOnce(orchestratorRef).catch(e => console.warn('[HONEY] sweep failed:', e.message));
  timer = setInterval(tick, intervalMs);
  tick();
  console.log(`[HONEY] bee-identity sweep started (every ${Math.round(intervalMs / 1000)}s)`);
}

function stop() { if (timer) clearInterval(timer); }

module.exports = { start, stop, profile, leaderboard, hiveGoal, rankFor };
