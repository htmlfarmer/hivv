-- 018_request_provenance.sql — durable, privacy-aware request provenance.
--
-- Every HIVV request (chat, scan, tool call, relay, MCP) should be able to
-- answer: who asked, which model answered, which node answered, how long it
-- took, what it cost, and where the worker was — WITHOUT storing raw prompts
-- or raw model output.
--
-- Design notes:
--   * Hashes instead of raw secrets for contact fields: contact details stay
--     matchable for abuse/duplicate detection without being readable at rest.
--   * `privacy_class` gates every projection; the public API never returns
--     this table directly.
--   * Coordinates are rounded to 2dp (~1.1 km) so a row is a map dot, not a
--     house address.
--   * `trace_route` holds network topology and is operator/private only.
--
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS hivv_request_provenance (
    id                    BIGSERIAL PRIMARY KEY,
    request_id            TEXT NOT NULL,
    endpoint              VARCHAR(120) NOT NULL,
    method                VARCHAR(10) NOT NULL DEFAULT 'POST',
    feature               VARCHAR(64),
    status                VARCHAR(24) NOT NULL DEFAULT 'success',

    -- WHO asked
    user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
    anonymous_visitor_id  VARCHAR(64),
    principal             VARCHAR(120),
    api_key_id            INTEGER REFERENCES ai_keys(id) ON DELETE SET NULL,
    session_id            VARCHAR(64),
    ip_address            VARCHAR(45),
    ip_address_hash       VARCHAR(64),
    user_agent            TEXT,

    -- WHAT was asked (hashes only — never raw prompts)
    request_sha256        VARCHAR(64),
    input_bytes           BIGINT NOT NULL DEFAULT 0,
    output_bytes          BIGINT NOT NULL DEFAULT 0,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    total_tokens          INTEGER NOT NULL DEFAULT 0,
    tool_call_count       INTEGER NOT NULL DEFAULT 0,
    tool_names            JSONB NOT NULL DEFAULT '[]',

    -- WHO answered
    provider              VARCHAR(64),
    provider_id           INTEGER REFERENCES ai_providers(id) ON DELETE SET NULL,
    model                 VARCHAR(160),
    model_family          VARCHAR(64),
    answered_by           VARCHAR(160),      -- node/model receipt
    answered_by_node      VARCHAR(120),
    transport             VARCHAR(24),        -- direct | relay | cloud | local
    route_mode            VARCHAR(24),
    capability            VARCHAR(64),
    privacy_filter        VARCHAR(32),
    policy_receipt        VARCHAR(160),
    policy_verdict        VARCHAR(16),

    -- WHERE it happened
    worker_node_id        VARCHAR(120),
    worker_hostname       VARCHAR(120),
    worker_public_ip      VARCHAR(45),
    worker_public_ip_hash VARCHAR(64),
    worker_lan_ip         VARCHAR(45),
    latitude              DOUBLE PRECISION,
    longitude             DOUBLE PRECISION,
    region                VARCHAR(64),
    country_code          VARCHAR(8),
    asn                   VARCHAR(48),
    isp                   VARCHAR(64),
    network_class         VARCHAR(24) NOT NULL DEFAULT 'unknown',
    trace_route           JSONB,
    hop_count             INTEGER,
    rtt_ms                INTEGER,

    -- WHEN and HOW LONG
    started_at_ms         BIGINT,
    completed_at_ms       BIGINT,
    duration_ms           BIGINT,
    ttfb_ms               BIGINT,
    queue_ms              INTEGER,

    -- WHAT IT COST
    cost_usd              NUMERIC(20,10) NOT NULL DEFAULT 0,
    resource_cost_usd     NUMERIC(20,10) NOT NULL DEFAULT 0,
    margin_usd            NUMERIC(20,10),
    currency              VARCHAR(8) NOT NULL DEFAULT 'USD',
    cost_estimated        BOOLEAN NOT NULL DEFAULT TRUE,
    cpu_ms                BIGINT NOT NULL DEFAULT 0,
    gpu_ms                BIGINT NOT NULL DEFAULT 0,
    peak_rss_kb           BIGINT NOT NULL DEFAULT 0,

    -- QUALITY / TRUST
    success               BOOLEAN,
    error_code            VARCHAR(64),
    error_message         TEXT,
    tokens_per_sec        DECIMAL(10,2),
    quality_score         DECIMAL(6,3),
    reliability_score     DECIMAL(6,3),

    -- PRIVACY
    privacy_class         VARCHAR(24) NOT NULL DEFAULT 'private',
    share_contact         BOOLEAN NOT NULL DEFAULT FALSE,
    share_exact_location  BOOLEAN NOT NULL DEFAULT FALSE,
    share_public_ip       BOOLEAN NOT NULL DEFAULT FALSE,
    share_trace_route     BOOLEAN NOT NULL DEFAULT FALSE,
    share_hostname        BOOLEAN NOT NULL DEFAULT FALSE,
    share_internal_margin BOOLEAN NOT NULL DEFAULT FALSE,

    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (request_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_user
    ON hivv_request_provenance (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_visitor
    ON hivv_request_provenance (anonymous_visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_endpoint
    ON hivv_request_provenance (endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_node
    ON hivv_request_provenance (answered_by_node, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_worker
    ON hivv_request_provenance (worker_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_model
    ON hivv_request_provenance (model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_created
    ON hivv_request_provenance (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_privacy
    ON hivv_request_provenance (privacy_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_reqprov_ip_hash
    ON hivv_request_provenance (ip_address_hash)
    WHERE ip_address_hash IS NOT NULL;

-- ── per-node aggregate cost/latency rollup (fast dashboards) ─────────────
CREATE TABLE IF NOT EXISTS hivv_node_provenance_stats (
    node_id             TEXT PRIMARY KEY,
    requests            BIGINT NOT NULL DEFAULT 0,
    successes           BIGINT NOT NULL DEFAULT 0,
    failures            BIGINT NOT NULL DEFAULT 0,
    input_tokens        BIGINT NOT NULL DEFAULT 0,
    output_tokens       BIGINT NOT NULL DEFAULT 0,
    total_duration_ms   BIGINT NOT NULL DEFAULT 0,
    avg_duration_ms     BIGINT NOT NULL DEFAULT 0,
    total_cost_usd      NUMERIC(20,10) NOT NULL DEFAULT 0,
    total_resource_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
    avg_ttfb_ms         INTEGER NOT NULL DEFAULT 0,
    ewma_tps            REAL NOT NULL DEFAULT 0,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hivv_node_prov_stats_seen
    ON hivv_node_provenance_stats (last_seen_at DESC);

-- ── daily rollup for cost/reporting ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS hivv_provenance_daily (
    day                 DATE NOT NULL,
    endpoint            VARCHAR(120) NOT NULL,
    provider            VARCHAR(64),
    model               VARCHAR(160),
    privacy_class       VARCHAR(24) NOT NULL DEFAULT 'private',
    requests            BIGINT NOT NULL DEFAULT 0,
    successes           BIGINT NOT NULL DEFAULT 0,
    failures            BIGINT NOT NULL DEFAULT 0,
    input_tokens        BIGINT NOT NULL DEFAULT 0,
    output_tokens       BIGINT NOT NULL DEFAULT 0,
    total_cost_usd      NUMERIC(20,10) NOT NULL DEFAULT 0,
    avg_duration_ms     BIGINT NOT NULL DEFAULT 0,
    p95_duration_ms     BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, endpoint, privacy_class)
);

CREATE INDEX IF NOT EXISTS idx_hivv_prov_daily_day
    ON hivv_provenance_daily (day DESC);
