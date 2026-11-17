-- 014_audit_snapshots.sql
-- F5: signed monthly snapshots for audit chain pruning.
-- Keeps a tamper-evident seal per month (head hash signed with HMAC-SHA256).
-- Rows older than the oldest kept snapshot are pruned; the snapshot row
-- remains as an anchor so verification can jump across gaps.

CREATE TABLE IF NOT EXISTS hivv_audit_snapshots (
  id            SERIAL PRIMARY KEY,
  year          SMALLINT NOT NULL,
  month         SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  row_count     BIGINT  NOT NULL,
  first_id      BIGINT  NOT NULL,
  last_id       BIGINT  NOT NULL,
  head_hash     TEXT    NOT NULL,          -- hash of the last row in that month
  signature     TEXT    NOT NULL,          -- HMAC-SHA256(year:month:row_count:head_hash, key)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (year, month)
);

CREATE INDEX idx_hivv_audit_snapshots_ym ON hivv_audit_snapshots(year, month);
