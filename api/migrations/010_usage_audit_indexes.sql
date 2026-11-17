-- 010 — Phase-1 performance pass (2026-09-28)
-- Indexes for high-frequency query patterns not covered by 001/007/008,
-- plus a one-time honesty reset for the perf counters.

-- usage_logs: guest quota checks (COUNT by visitor) and login merges
-- (UPDATE ... SET user_id WHERE anonymous_visitor_id = $ AND user_id IS NULL)
CREATE INDEX IF NOT EXISTS idx_usage_logs_visitor
    ON usage_logs (anonymous_visitor_id)
    WHERE anonymous_visitor_id IS NOT NULL;

-- hivv_grants: `hivv approve --list` / listGrants(principal, status) newest-first
CREATE INDEX IF NOT EXISTS idx_hivv_grants_principal_status
    ON hivv_grants (principal, status, created_at DESC);

-- hivv_audit: correlate a decision with its grant (approval history lookups)
CREATE INDEX IF NOT EXISTS idx_hivv_audit_grant
    ON hivv_audit (grant_id)
    WHERE grant_id IS NOT NULL;

-- One-time reset: perf.flush() used to ship CUMULATIVE samples/ok/err as
-- deltas, inflating these counters every 30s (e.g. ashy showed 31k errors).
-- The code now ships true deltas; EWMA tps/latency are absolute and stay.
UPDATE hivv_model_perf SET samples = 0, ok_count = 0, err_count = 0;

ANALYZE usage_logs;
ANALYZE hivv_grants;
ANALYZE hivv_audit;
ANALYZE hivv_model_perf;
