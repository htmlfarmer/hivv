-- Migration: hivv incidents — node health monitoring + incident tracking
-- Tracks node crashes, restart loops, staleness, and network issues

CREATE TABLE IF NOT EXISTS hivv_incidents (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_type   VARCHAR(50)     NOT NULL,
    severity        VARCHAR(20)     NOT NULL DEFAULT 'medium',
    state           VARCHAR(20)     NOT NULL DEFAULT 'active',
    node_id         VARCHAR(255)    NOT NULL,
    title           TEXT            NOT NULL,
    description     TEXT,
    evidence        JSONB           NOT NULL DEFAULT '[]',
    detected_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     VARCHAR(255),
    resolution_notes TEXT,

    CONSTRAINT chk_incident_type CHECK (incident_type IN (
        'node_offline', 'node_stale', 'node_restart_loop', 'node_crash',
        'port_unreachable', 'model_unavailable', 'network_partition',
        'hub_unreachable', 'auth_failure', 'config_error'
    )),
    CONSTRAINT chk_severity CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT chk_state CHECK (state IN ('active', 'investigating', 'resolved', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_incidents_node ON hivv_incidents(node_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_state ON hivv_incidents(state, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON hivv_incidents(severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_type ON hivv_incidents(incident_type, detected_at DESC);

-- Auto-resolve old active incidents for a node when it comes back online
CREATE OR REPLACE FUNCTION resolve_node_incidents()
RETURNS TRIGGER AS $$
BEGIN
    -- When a node sends a heartbeat, resolve any active 'node_offline' or 'node_stale' incidents
    UPDATE hivv_incidents
    SET state = 'resolved',
        resolved_at = NOW(),
        resolution_notes = 'Node came back online — automatic resolution'
    WHERE node_id = NEW.node_id
      AND state = 'active'
      AND incident_type IN ('node_offline', 'node_stale', 'node_restart_loop');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-resolve incidents when node comes back
-- Note: We'd need to call this from the heartbeat handler in Node.js
-- The DB function is ready but the trigger is application-managed for flexibility
