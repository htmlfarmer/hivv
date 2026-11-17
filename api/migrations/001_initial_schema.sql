-- HIVV.org AI Gateway Schema
-- Full rebuild with priority routing, rate limiting, usage tracking

-- ============================================
-- USERS & AUTHENTICATION
-- ============================================

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    email VARCHAR(255),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'owner')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ============================================
-- AI PROVIDERS & KEYS
-- ============================================

CREATE TABLE IF NOT EXISTS ai_providers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,  -- 'openai', 'anthropic', 'minimax', 'mimo', 'qwen', 'local', etc.
    display_name VARCHAR(100) NOT NULL,
    logo_url VARCHAR(500),
    api_format VARCHAR(20) DEFAULT 'openai' CHECK (api_format IN ('openai', 'anthropic', 'google', 'custom')),
    default_endpoint VARCHAR(500),
    is_cloud BOOLEAN DEFAULT TRUE,  -- TRUE for cloud APIs, FALSE for self-hosted
    requires_endpoint BOOLEAN DEFAULT FALSE,  -- TRUE if custom endpoint required
    supported_models JSONB DEFAULT '[]',  -- ['gpt-4o', 'claude-3-5-sonnet', ...]
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Master keys table - your owned API keys
CREATE TABLE IF NOT EXISTS ai_keys (
    id SERIAL PRIMARY KEY,
    provider_id INTEGER REFERENCES ai_providers(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL for system keys
    key_name VARCHAR(100),
    key_value VARCHAR(500) NOT NULL,  -- Encrypted in production!
    api_endpoint VARCHAR(500),  -- Override provider default if needed
    model VARCHAR(100),  -- Specific model or pattern (e.g., 'gpt-4o', 'claude-3-5-sonnet')
    priority INTEGER DEFAULT 50 CHECK (priority >= 1 AND priority <= 100),  -- 1-100, higher = more preferred
    weight INTEGER DEFAULT 1 CHECK (weight >= 1 AND weight <= 100),  -- For load balancing weight
    max_requests_per_hour INTEGER,  -- Rate limit for this specific key
    max_tokens_per_day INTEGER,  -- Daily token limit
    is_active BOOLEAN DEFAULT TRUE,
    is_shared BOOLEAN DEFAULT FALSE,  -- Can be shared with other users
    cost_per_1k_input_tokens DECIMAL(10,6),  -- Cost tracking
    cost_per_1k_output_tokens DECIMAL(10,6),
    last_used_at TIMESTAMP,
    total_requests INTEGER DEFAULT 0,
    total_tokens_used INTEGER DEFAULT 0,
    total_cost DECIMAL(12,6) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,  -- Key expiration date
    notes TEXT
);

CREATE INDEX idx_ai_keys_provider ON ai_keys(provider_id);
CREATE INDEX idx_ai_keys_user ON ai_keys(user_id);
CREATE INDEX idx_ai_keys_active ON ai_keys(is_active, priority DESC);

-- ============================================
-- USER QUOTAS & RATE LIMITS
-- ============================================

CREATE TABLE IF NOT EXISTS user_quotas (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER REFERENCES ai_providers(id) ON DELETE CASCADE,  -- NULL = all providers
    requests_per_hour INTEGER DEFAULT 100,
    requests_per_day INTEGER DEFAULT 1000,
    requests_per_month INTEGER DEFAULT 10000,
    tokens_per_hour INTEGER DEFAULT 100000,
    tokens_per_day INTEGER DEFAULT 500000,
    tokens_per_month INTEGER DEFAULT 2000000,
    max_cost_per_day DECIMAL(10,2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, provider_id)
);

-- ============================================
-- USAGE LOGGING
-- ============================================

CREATE TABLE IF NOT EXISTS usage_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    key_id INTEGER REFERENCES ai_keys(id) ON DELETE SET NULL,
    provider_id INTEGER REFERENCES ai_providers(id) ON DELETE SET NULL,
    model VARCHAR(100),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
    cost DECIMAL(10,4) DEFAULT 0,
    latency_ms INTEGER,  -- Request latency
    status VARCHAR(20) DEFAULT 'success' CHECK (status IN ('success', 'rate_limited', 'error', 'quota_exceeded')),
    error_message TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    endpoint VARCHAR(100),  -- 'chat/completions', 'embeddings', etc.
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_usage_logs_user ON usage_logs(user_id, created_at DESC);
CREATE INDEX idx_usage_logs_key ON usage_logs(key_id, created_at DESC);
CREATE INDEX idx_usage_logs_provider ON usage_logs(provider_id, created_at DESC);
CREATE INDEX idx_usage_logs_created ON usage_logs(created_at DESC);

-- Hourly aggregates for fast dashboard queries
CREATE TABLE IF NOT EXISTS usage_aggregates_hourly (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER REFERENCES ai_providers(id) ON DELETE CASCADE,
    hour_bucket TIMESTAMP NOT NULL,  -- Truncated to hour
    total_requests INTEGER DEFAULT 0,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cost DECIMAL(10,4) DEFAULT 0,
    avg_latency_ms INTEGER,
    UNIQUE(user_id, provider_id, hour_bucket)
);

CREATE INDEX idx_agg_hourly_lookup ON usage_aggregates_hourly(user_id, provider_id, hour_bucket DESC);

-- Daily aggregates
CREATE TABLE IF NOT EXISTS usage_aggregates_daily (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER REFERENCES ai_providers(id) ON DELETE CASCADE,
    date_bucket DATE NOT NULL,
    total_requests INTEGER DEFAULT 0,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cost DECIMAL(10,4) DEFAULT 0,
    avg_latency_ms INTEGER,
    UNIQUE(user_id, provider_id, date_bucket)
);

CREATE INDEX idx_agg_daily_lookup ON usage_aggregates_daily(user_id, provider_id, date_bucket DESC);

-- ============================================
-- ADMIN CONFIGURATION
-- ============================================

CREATE TABLE IF NOT EXISTS gateway_config (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Default config values
INSERT INTO gateway_config (key, value, description) VALUES
    ('default_priority', '{"value": 50}', 'Default priority for new keys'),
    ('rate_limit_window', '{"seconds": 3600}', 'Default rate limit window'),
    ('failover_enabled', '{"enabled": true}', 'Enable automatic failover'),
    ('load_balancing_strategy', '{"strategy": "priority"}', 'priority | round_robin | weighted'),
    ('max_retries', '{"retries": 3}', 'Max retries per request'),
    ('timeout_ms', '{"ms": 120000}', 'Request timeout')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- EXISTING TABLES (preserved from original)
-- ============================================

-- These are kept for backward compatibility with existing problem-solving features
CREATE TABLE IF NOT EXISTS problems (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'claimed', 'done', 'failed')),
    assigned_agent VARCHAR(100),
    result JSONB,
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    claimed_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contributions (
    id SERIAL PRIMARY KEY,
    problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE,
    agent_id VARCHAR(100) NOT NULL,
    content JSONB NOT NULL,
    parent_contribution_id INTEGER REFERENCES contributions(id) ON DELETE CASCADE,
    vote_score INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    contribution_id INTEGER REFERENCES contributions(id) ON DELETE CASCADE,
    agent_id VARCHAR(100) NOT NULL,
    vote_value INTEGER CHECK (vote_value IN (-1, 0, 1)),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(contribution_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agents (
    agent_id VARCHAR(64) PRIMARY KEY,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    model VARCHAR(100),
    capabilities JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'idle' CHECK (status IN ('idle', 'working')),
    current_problem_id INTEGER,
    tasks_completed INTEGER DEFAULT 0,
    tasks_failed INTEGER DEFAULT 0,
    local_cpu_pct INTEGER,
    local_gpu_pct INTEGER,
    first_seen_at TIMESTAMP DEFAULT NOW(),
    last_seen_at TIMESTAMP,
    registered_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS problem_activity (
    id SERIAL PRIMARY KEY,
    problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    actor VARCHAR(100),
    payload JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_load_history (
    id SERIAL PRIMARY KEY,
    load1 DECIMAL(10,4),
    load5 DECIMAL(10,4),
    load15 DECIMAL(10,4),
    per_core DECIMAL(10,4),
    free_ratio DECIMAL(10,4),
    gpu_util INTEGER,
    gpu_mem_used INTEGER,
    gpu_mem_total INTEGER,
    jobs_active INTEGER DEFAULT 0,
    jobs_total INTEGER DEFAULT 0,
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Get user's remaining quota for a provider
CREATE OR REPLACE FUNCTION get_user_quota(p_user_id INTEGER, p_provider_id INTEGER DEFAULT NULL)
RETURNS TABLE (
    requests_remaining_hour INTEGER,
    requests_remaining_day INTEGER,
    requests_remaining_month INTEGER,
    tokens_remaining_hour INTEGER,
    tokens_remaining_day INTEGER,
    tokens_remaining_month INTEGER
) AS $$
DECLARE
    v_quota user_quotas%ROWTYPE;
    v_used_hour INTEGER;
    v_used_day INTEGER;
    v_used_month INTEGER;
    v_tokens_hour INTEGER;
    v_tokens_day INTEGER;
    v_tokens_month INTEGER;
BEGIN
    -- Get user's quota (or default)
    SELECT * INTO v_quota FROM user_quotas
    WHERE user_id = p_user_id AND (p_provider_id IS NULL OR provider_id = p_provider_id);

    -- Default values if no quota set
    v_quota.requests_per_hour := COALESCE(v_quota.requests_per_hour, 100);
    v_quota.requests_per_day := COALESCE(v_quota.requests_per_day, 1000);
    v_quota.requests_per_month := COALESCE(v_quota.requests_per_month, 10000);
    v_quota.tokens_per_hour := COALESCE(v_quota.tokens_per_hour, 100000);
    v_quota.tokens_per_day := COALESCE(v_quota.tokens_per_day, 500000);
    v_quota.tokens_per_month := COALESCE(v_quota.tokens_per_month, 2000000);

    -- Get usage for current hour
    SELECT COALESCE(SUM(total_requests), 0), COALESCE(SUM(total_tokens), 0)
    INTO v_used_hour, v_tokens_hour
    FROM usage_logs
    WHERE user_id = p_user_id
    AND (p_provider_id IS NULL OR provider_id = p_provider_id)
    AND created_at > NOW() - INTERVAL '1 hour';

    -- Get usage for current day
    SELECT COALESCE(SUM(total_requests), 0), COALESCE(SUM(total_tokens), 0)
    INTO v_used_day, v_tokens_day
    FROM usage_logs
    WHERE user_id = p_user_id
    AND (p_provider_id IS NULL OR provider_id = p_provider_id)
    AND created_at > CURRENT_DATE;

    -- Get usage for current month
    SELECT COALESCE(SUM(total_requests), 0), COALESCE(SUM(total_tokens), 0)
    INTO v_used_month, v_tokens_month
    FROM usage_logs
    WHERE user_id = p_user_id
    AND (p_provider_id IS NULL OR provider_id = p_provider_id)
    AND created_at > date_trunc('month', CURRENT_DATE);

    RETURN QUERY SELECT
        v_quota.requests_per_hour - v_used_hour,
        v_quota.requests_per_day - v_used_day,
        v_quota.requests_per_month - v_used_month,
        v_quota.tokens_per_hour - v_tokens_hour,
        v_quota.tokens_per_day - v_tokens_day,
        v_quota.tokens_per_month - v_tokens_month;
END;
$$ LANGUAGE plpgsql;

-- Log usage and update aggregates atomically
CREATE OR REPLACE FUNCTION log_usage(
    p_user_id INTEGER,
    p_key_id INTEGER,
    p_provider_id INTEGER,
    p_model VARCHAR,
    p_input_tokens INTEGER,
    p_output_tokens INTEGER,
    p_cost DECIMAL,
    p_latency_ms INTEGER,
    p_status VARCHAR,
    p_error_message TEXT DEFAULT NULL,
    p_ip_address VARCHAR DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_endpoint VARCHAR DEFAULT 'chat/completions'
) RETURNS INTEGER AS $$
DECLARE
    v_log_id INTEGER;
BEGIN
    -- Insert usage log
    INSERT INTO usage_logs (
        user_id, key_id, provider_id, model, input_tokens, output_tokens,
        cost, latency_ms, status, error_message, ip_address, user_agent, endpoint
    ) VALUES (
        p_user_id, p_key_id, p_provider_id, p_model, p_input_tokens, p_output_tokens,
        p_cost, p_latency_ms, p_status, p_error_message, p_ip_address, p_user_agent, p_endpoint
    ) RETURNING id INTO v_log_id;

    -- Update ai_keys usage stats
    UPDATE ai_keys SET
        total_requests = total_requests + 1,
        total_tokens_used = total_tokens_used + p_input_tokens + p_output_tokens,
        total_cost = total_cost + p_cost,
        last_used_at = NOW()
    WHERE id = p_key_id;

    -- Update hourly aggregate
    INSERT INTO usage_aggregates_hourly (user_id, provider_id, hour_bucket, total_requests, total_input_tokens, total_output_tokens, total_cost)
    VALUES (p_user_id, p_provider_id, date_trunc('hour', NOW()), 1, p_input_tokens, p_output_tokens, p_cost)
    ON CONFLICT (user_id, provider_id, hour_bucket) DO UPDATE SET
        total_requests = usage_aggregates_hourly.total_requests + 1,
        total_input_tokens = usage_aggregates_hourly.total_input_tokens + p_input_tokens,
        total_output_tokens = usage_aggregates_hourly.total_output_tokens + p_output_tokens,
        total_cost = usage_aggregates_hourly.total_cost + p_cost;

    -- Update daily aggregate
    INSERT INTO usage_aggregates_daily (user_id, provider_id, date_bucket, total_requests, total_input_tokens, total_output_tokens, total_cost)
    VALUES (p_user_id, p_provider_id, CURRENT_DATE, 1, p_input_tokens, p_output_tokens, p_cost)
    ON CONFLICT (user_id, provider_id, date_bucket) DO UPDATE SET
        total_requests = usage_aggregates_daily.total_requests + 1,
        total_input_tokens = usage_aggregates_daily.total_input_tokens + p_input_tokens,
        total_output_tokens = usage_aggregates_daily.total_output_tokens + p_output_tokens,
        total_cost = usage_aggregates_daily.total_cost + p_cost;

    RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;

-- Get best available key for a provider (priority + health based)
CREATE OR REPLACE FUNCTION get_best_key(
    p_provider_id INTEGER,
    p_model VARCHAR DEFAULT NULL,
    p_user_id INTEGER DEFAULT NULL
) RETURNS ai_keys%ROWTYPE AS $$
DECLARE
    v_key ai_keys%ROWTYPE;
BEGIN
    SELECT * INTO v_key FROM ai_keys k
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

-- ============================================
-- SEED DATA: AI Providers
-- ============================================

INSERT INTO ai_providers (name, display_name, api_format, default_endpoint, is_cloud, requires_endpoint, supported_models) VALUES
    ('openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', TRUE, FALSE,
     '["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo", "gpt-4o-realtime-preview"]'),
    ('anthropic', 'Anthropic Claude', 'anthropic', 'https://api.anthropic.com/v1', TRUE, FALSE,
     '["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"]'),
    ('google', 'Google Gemini', 'google', 'https://generativelanguage.googleapis.com/v1beta', TRUE, FALSE,
     '["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash-exp"]'),
    ('minimax', 'MiniMax', 'openai', 'https://api.minimax.io/v1', TRUE, FALSE,
     '["MiniMax-Text-01", "MiniMax-M2.7", "MiniMax-M2.5"]'),
    ('mimo', 'Mimo', 'openai', 'https://token-plan-sgp.xiaomimimo.com/v1', TRUE, FALSE,
     '["mimo-v2.5-pro", "mimo-v2.5"]'),
    ('mistral', 'Mistral AI', 'openai', 'https://api.mistral.ai/v1', TRUE, FALSE,
     '["mistral-large-latest", "mistral-small-latest", "mistral-medium-latest"]'),
    ('groq', 'Groq', 'openai', 'https://api.groq.com/openai/v1', TRUE, FALSE,
     '["llama-3.3-70b-versatile", "llama-3.1-70b-instruct", "mixtral-8x7b-32768"]'),
    ('deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com/v1', TRUE, FALSE,
     '["deepseek-chat", "deepseek-reasoner"]'),
    ('openrouter', 'OpenRouter', 'openai', 'https://openrouter.ai/api/v1', TRUE, FALSE,
     '["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "google/gemini-pro"]'),
    ('together', 'Together AI', 'openai', 'https://api.together.xyz/v1', TRUE, FALSE,
     '["meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", "mistralai/Mixtral-8x22B-Instruct-v0.1"]'),
    ('qwen', 'Qwen', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', TRUE, FALSE,
     '["qwen-plus", "qwen-turbo", "qwen-max"]'),
    ('local', 'Self-Hosted', 'openai', NULL, FALSE, TRUE,
     '["llama-3.1-70b", "llama-3.1-8b", "codellama-70b", "mistral-7b", "phi-3"]'),
    ('azure', 'Azure OpenAI', 'openai', NULL, TRUE, TRUE,
     '["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"]')
ON CONFLICT (name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    supported_models = EXCLUDED.supported_models;
