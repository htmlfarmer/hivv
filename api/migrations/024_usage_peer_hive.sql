-- 024_usage_peer_hive.sql — real per-hive numbers for the bridge table joins.
--
-- usage_logs gains peer_hive: which HIVE made this request ('kwaai'), instead
-- of everything collapsing into anonymous visitors. This is what powers
-- "who is using HIVV" with real numbers, and lets bridge receipts join
-- against the ledger on (peer_hive, created_at).
--
-- Idempotent: safe to re-run.

ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS peer_hive TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_logs_peer_hive
    ON usage_logs (peer_hive, created_at DESC) WHERE peer_hive IS NOT NULL;
