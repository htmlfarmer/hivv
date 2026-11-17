-- 005_hivv_feedback.sql
-- User feedback: suggestions, complaints, help requests

CREATE TABLE IF NOT EXISTS hivv_feedback (
    id            BIGSERIAL PRIMARY KEY,
    visitor_id    TEXT,
    user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    node_id       TEXT,
    type          TEXT NOT NULL CHECK (type IN ('suggestion', 'complaint', 'help_request', 'bug', 'praise', 'other')),
    subject       TEXT,
    message       TEXT NOT NULL,
    metadata      JSONB DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'in_progress', 'resolved', 'dismissed')),
    reviewed_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    review_notes  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_type       ON hivv_feedback(type);
CREATE INDEX IF NOT EXISTS idx_feedback_status     ON hivv_feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_visitor_id ON hivv_feedback(visitor_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON hivv_feedback(created_at DESC);
