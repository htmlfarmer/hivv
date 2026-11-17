-- 009_hivv_perf_via.sql — honest perf: split measurements by transport (direct vs relay).
-- Relay tps (tokens ÷ wall-clock incl. queue+poll wait) was poisoning per-bee speed EWMA,
-- making fast-but-NAT'd bees look slow for routing. Safe to re-run (idempotent).

ALTER TABLE hivv_model_perf ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'direct';

-- re-key: (node_id, model) -> (node_id, model, via)
ALTER TABLE hivv_model_perf DROP CONSTRAINT IF EXISTS hivv_model_perf_pkey;
ALTER TABLE hivv_model_perf ADD PRIMARY KEY (node_id, model, via);

CREATE INDEX IF NOT EXISTS idx_hivv_model_perf_via ON hivv_model_perf (node_id, via, ewma_tps DESC);
