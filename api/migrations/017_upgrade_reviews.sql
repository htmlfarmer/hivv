-- Migration 017: upgrade review reports — bees vote on CLI updates before applying.
--
-- Every upgrade (manual `hivv upgrade`, 5-min auto-update, hub inbox push) runs a
-- pre-apply review: static dangerous-pattern scan + local LLM vote + hive fan-out
-- vote. Outcomes land here; suspicious/blocked/failed ones ALSO open an incident
-- so they show in `hivv incidents` + the Command Center.

CREATE TABLE IF NOT EXISTS hivv_upgrade_reviews (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id         VARCHAR(255)    NOT NULL,
    source          VARCHAR(16)     NOT NULL DEFAULT 'manual',   -- manual | auto | inbox
    action          VARCHAR(16)     NOT NULL,                    -- applied | blocked | failed
    verdict         VARCHAR(16)     NOT NULL DEFAULT 'ok',       -- ok | suspicious
    version_from    VARCHAR(64),
    to_sha256       VARCHAR(64),
    reason          TEXT,
    static_findings JSONB           NOT NULL DEFAULT '[]',
    votes           JSONB           NOT NULL DEFAULT '[]',       -- [{brain, via, verdict, reason, ms}]
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upgrade_reviews_node    ON hivv_upgrade_reviews(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upgrade_reviews_created ON hivv_upgrade_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upgrade_reviews_flagged ON hivv_upgrade_reviews(action, created_at DESC)
    WHERE action IN ('blocked', 'failed');

-- Allow the two new incident types (CHECK constraints can't be ALTERed in place).
ALTER TABLE hivv_incidents DROP CONSTRAINT IF EXISTS chk_incident_type;
ALTER TABLE hivv_incidents ADD CONSTRAINT chk_incident_type CHECK (incident_type IN (
    'node_offline', 'node_stale', 'node_restart_loop', 'node_crash',
    'port_unreachable', 'model_unavailable', 'network_partition',
    'hub_unreachable', 'auth_failure', 'config_error',
    'upgrade_suspicious', 'upgrade_failed'
));
