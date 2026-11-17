-- 007_hivv_honey_perf.sql — bee identity (#1) + measured routing (#7) + NAT relay (#5)
-- Safe to re-run (idempotent).

-- ── per-node lifetime stats: honey, rank, streak ──────────────────────
CREATE TABLE IF NOT EXISTS hivv_node_stats (
    node_id             TEXT PRIMARY KEY,
    honey               BIGINT NOT NULL DEFAULT 0,
    minutes_online      BIGINT NOT NULL DEFAULT 0,
    jobs_completed      BIGINT NOT NULL DEFAULT 0,
    tokens_served       BIGINT NOT NULL DEFAULT 0,
    streak_days         INTEGER NOT NULL DEFAULT 0,
    best_streak_days    INTEGER NOT NULL DEFAULT 0,
    last_online_date    DATE,
    -- cursor: cumulative counters seen in the hub registry at last flush
    -- (so restarts never double-mint honey)
    seen_jobs           BIGINT NOT NULL DEFAULT 0,
    seen_tokens         BIGINT NOT NULL DEFAULT 0,
    bee_rank            TEXT NOT NULL DEFAULT 'larva',
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hivv_node_stats_honey ON hivv_node_stats (honey DESC);

-- ── auditable honey ledger (one row per minted event) ─────────────────
CREATE TABLE IF NOT EXISTS hivv_honey_events (
    id          BIGSERIAL PRIMARY KEY,
    node_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,      -- online_minute | job | relay_job | streak
    amount      INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hivv_honey_events_node_time ON hivv_honey_events (node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_honey_events_time ON hivv_honey_events (created_at DESC);

-- ── measured speed per node+model (EWMA, fed by the router) ───────────
CREATE TABLE IF NOT EXISTS hivv_model_perf (
    node_id         TEXT NOT NULL,
    model           TEXT NOT NULL,
    ewma_tps        REAL NOT NULL DEFAULT 0,
    ewma_latency_ms REAL NOT NULL DEFAULT 0,
    samples         INTEGER NOT NULL DEFAULT 0,
    ok_count        INTEGER NOT NULL DEFAULT 0,
    err_count       INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (node_id, model)
);

CREATE INDEX IF NOT EXISTS idx_hivv_model_perf_model ON hivv_model_perf (model, ewma_tps DESC);

-- ── relay jobs for nodes unreachable peer-to-peer (#5) ────────────────
CREATE TABLE IF NOT EXISTS hivv_relay_jobs (
    id            TEXT PRIMARY KEY,
    node_id       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | error | expired
    request       JSONB NOT NULL,
    result        JSONB,
    error         TEXT,
    requester     TEXT,                              -- visitor id / user for receipts
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hivv_relay_jobs_queue ON hivv_relay_jobs (node_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_hivv_relay_jobs_recent ON hivv_relay_jobs (created_at DESC);

-- ── weekly hive goals (#6 companion) — one row, singleton id=1 ────────
CREATE TABLE IF NOT EXISTS hivv_hive_goal (
    id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    title         TEXT NOT NULL DEFAULT 'answer as many questions as we can',
    target        BIGINT NOT NULL DEFAULT 10000,
    progress      BIGINT NOT NULL DEFAULT 0,
    week_start    DATE NOT NULL DEFAULT DATE_TRUNC('week', NOW())::DATE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO hivv_hive_goal (id, title, target, week_start)
VALUES (1, 'answer as many questions as we can', 10000, DATE_TRUNC('week', NOW())::DATE)
ON CONFLICT (id) DO NOTHING;
