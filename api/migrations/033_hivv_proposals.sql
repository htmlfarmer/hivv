-- 034_hivv_proposals.sql — THE PROPOSAL TABLE + the source.modify capability.
--
-- A proposal is one proposed change to the source, travelling from a diff to
-- a merge with the evidence attached to every step. The gates live in
-- api/lib/proposal.js; this table is only the durable mirror of them.
--
-- The capability key 'source.modify' is what the policy gate evaluates when a
-- change asks to be authorized. Its default verdict is ASK: a change to the
-- hive's own source is never a silent, machine-decided thing.
--
-- ON CONFLICT DO NOTHING on the capability: an operator who has already
-- changed a capability's tier or verdict keeps their choice — a migration
-- must not silently re-open or re-close a gate that a human tuned.

CREATE TABLE IF NOT EXISTS hivv_proposals (
    id                TEXT PRIMARY KEY,
    state             TEXT NOT NULL DEFAULT 'draft',
    principal         TEXT,
    repo              TEXT,
    base_sha          TEXT,
    branch            TEXT,
    title             TEXT,
    patch_sha256      TEXT,
    protected_hit     BOOLEAN DEFAULT FALSE,
    high_risk         BOOLEAN DEFAULT FALSE,
    gates             JSONB NOT NULL DEFAULT '{}'::jsonb,
    receipts          JSONB NOT NULL DEFAULT '[]'::jsonb,
    chain_hash        TEXT,
    created_at        BIGINT,
    updated_at        BIGINT,
    expires_at        BIGINT,
    merged_at         BIGINT,
    deployed_at       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_hivv_proposals_state   ON hivv_proposals (state);
CREATE INDEX IF NOT EXISTS idx_hivv_proposals_created ON hivv_proposals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_proposals_patch   ON hivv_proposals (patch_sha256);

INSERT INTO hivv_capabilities (key, label, tier, description, default_verdict, requires_consent)
VALUES (
    'source.modify', 'modify the source', 'side-effect',
    'Change the hive''s own code — gated by the proposal pipeline (study, authorize, test, approve, merge)',
    'ask', true
)
ON CONFLICT (key) DO NOTHING;
