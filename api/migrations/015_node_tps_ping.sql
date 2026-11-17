-- 014_node_tps_ping.sql — add tps/ping columns for `hivv nodes` display.
-- TPS is computed by the honey sweep from heartbeat token deltas (EWMA).
-- Ping is measured by the CLI and POSTed to /api/nodes/ping (cached 30s).

ALTER TABLE hivv_node_stats
  ADD COLUMN IF NOT EXISTS tokens_per_sec REAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_ping_ms REAL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_hivv_node_stats_tps ON hivv_node_stats (tokens_per_sec DESC);
