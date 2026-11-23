-- 023_bridges.sql — hive-to-hive bridges (open-hives/0.1).
--
-- Model: ANY node may propose a bridge to ANY remote hive ("try and connect
-- no matter what they suggest"). The hub always attempts verification, records
-- every outcome, and failures become PUBLIC learning material (/api/bridge/
-- problems → hivv.org/bugs) instead of silent errors. A reporter's note can be
-- relayed back to the remote hive as a suggestion.
--
-- scope: 'hive'  = verified result is suggested to the whole hive (listed on
--                   /api/bridge/peers, /live/)
--        'local' = requester's own network only — never advertised to the
--                   broader hive (their choice, honoured here).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS hivv_bridges (
    id                BIGSERIAL PRIMARY KEY,
    remote_hive       TEXT NOT NULL,                 -- brand or domain, lowercase ('kwaai.ai')
    remote_url        TEXT NOT NULL,                 -- normalised https origin
    scope             TEXT NOT NULL DEFAULT 'hive',  -- 'hive' | 'local'
    requested_by      TEXT,                          -- node id or 'anonymous'
    note              TEXT,                          -- reporter's suggestion/notes
    manifest_url      TEXT,                          -- explicit manifest source (git-hosted hives)
    status            TEXT NOT NULL DEFAULT 'pending',      -- pending | verified | failed
    status_reason     TEXT,                          -- why it failed (public)
    protocol          TEXT,                          -- e.g. open-hives/0.1
    latency_ms        INTEGER,
    allowance_percent INTEGER,
    endpoints         JSONB,                         -- their published endpoint map
    last_check_at     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (remote_url)
);
CREATE INDEX IF NOT EXISTS idx_hivv_bridges_status ON hivv_bridges (status, scope);

-- Every attempt, kept so "study them together" has a timeline to study.
CREATE TABLE IF NOT EXISTS hivv_bridge_attempts (
    id          BIGSERIAL PRIMARY KEY,
    bridge_id   BIGINT NOT NULL REFERENCES hivv_bridges(id) ON DELETE CASCADE,
    ok          BOOLEAN NOT NULL,
    reason      TEXT,
    latency_ms  INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hivv_bridge_attempts_bridge ON hivv_bridge_attempts (bridge_id, created_at DESC);
