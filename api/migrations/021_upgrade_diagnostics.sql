-- Migration 021: upgrade failure forensics + signature dedup (2026-11-22)
--
-- wahi's nine identical "Permission denied …/hivv-cli.py.bak" rows proved the
-- old report was too thin: prose `reason` only, no step/errno/ownership, and
-- dedup keyed on sha meant every new hub release re-reported the SAME failure.
-- Now a failed report carries a structured `diagnostics` object (which step
-- died, who owns the file, can we write, the fix) plus a `signature` the hub
-- collapses on: same node + same signature within 24h bumps `attempts`
-- instead of inserting a new row.
ALTER TABLE hivv_upgrade_reviews
    ADD COLUMN IF NOT EXISTS diagnostics JSONB,
    ADD COLUMN IF NOT EXISTS signature   TEXT,
    ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS last_seen   TIMESTAMPTZ;

-- The dedup lookup: same node + signature, recent window.
CREATE INDEX IF NOT EXISTS idx_upgrade_reviews_signature
    ON hivv_upgrade_reviews (node_id, signature, created_at DESC)
    WHERE signature IS NOT NULL;

-- Existing rows have no signature; last_seen starts NULL and reads fall back
-- to created_at (COALESCE in the GET route).
