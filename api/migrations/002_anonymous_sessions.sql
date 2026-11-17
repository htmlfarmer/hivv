-- HIVV.org v2.0 - Fix migration syntax and add anonymous sessions
-- Run this AFTER the main migration

BEGIN;

-- Fix the get_best_key function (change %ROWTYPE to RECORD)
CREATE OR REPLACE FUNCTION get_best_key(
    p_provider_id INTEGER,
    p_model VARCHAR DEFAULT NULL,
    p_user_id INTEGER DEFAULT NULL
) RETURNS RECORD AS $$
DECLARE
    v_key RECORD;
BEGIN
    SELECT k.id, k.provider_id, k.user_id, k.key_name, k.key_value, k.api_endpoint,
           k.model, k.priority, k.weight, k.is_active, k.is_shared, k.last_used_at
    INTO v_key
    FROM ai_keys k
    WHERE k.provider_id = p_provider_id
    AND k.is_active = TRUE
    AND (k.expires_at IS NULL OR k.expires_at > NOW())
    AND (p_model IS NULL OR k.model = p_model OR k.model = '*')
    AND (k.user_id IS NULL OR k.user_id = p_user_id OR k.is_shared = TRUE)
    ORDER BY
        k.priority DESC,
        k.last_used_at ASC NULLS FIRST,
        RANDOM()
    LIMIT 1;
    RETURN v_key;
END;
$$ LANGUAGE plpgsql;

-- Add anonymous_sessions table for tracking unregistered users
CREATE TABLE IF NOT EXISTS anonymous_sessions (
    id SERIAL PRIMARY KEY,
    visitor_id VARCHAR(64) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen_at TIMESTAMP DEFAULT NOW(),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- Linked if user registers
    ip_address VARCHAR(45),
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_anonymous_sessions_visitor ON anonymous_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_anonymous_sessions_user ON anonymous_sessions(user_id);

-- Add link_to_user field to usage_logs to track anonymous -> user conversion
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS anonymous_visitor_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_usage_logs_visitor ON anonymous_sessions(visitor_id);

-- Add fingerprint column to users table for identity verification
ALTER TABLE users ADD COLUMN IF NOT EXISTS visitor_id VARCHAR(64) UNIQUE;

-- Add default quotas for new users if not exists
INSERT INTO user_quotas (user_id, provider_id, requests_per_hour, requests_per_day, requests_per_month, tokens_per_hour, tokens_per_day, tokens_per_month)
SELECT u.id, NULL, 100, 1000, 10000, 100000, 500000, 2000000
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM user_quotas uq WHERE uq.user_id = u.id AND uq.provider_id IS NULL
);

COMMIT;
