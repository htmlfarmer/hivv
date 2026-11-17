-- HIVV Dashboard Schema
-- Agent identity, relationships, permissions, events, intentions, trust, privacy

-- ============================================
-- AGENTS TABLE (expanded from existing)
-- ============================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type VARCHAR(20) DEFAULT 'ai' CHECK (agent_type IN ('human', 'ai', 'organization', 'network'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS state VARCHAR(20) DEFAULT 'yes' CHECK (state IN ('yes', 'maybe', 'no'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS public_name VARCHAR(255);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_name VARCHAR(255);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_agent_id VARCHAR(64);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id VARCHAR(64);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS organization_id INTEGER;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMP;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS public_metadata JSONB DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS private_metadata JSONB DEFAULT '{}';

-- ============================================
-- HIVV AGENTS (new comprehensive table)
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_type VARCHAR(20) NOT NULL CHECK (agent_type IN ('human', 'ai', 'organization', 'network', 'device', 'robot')),
    state VARCHAR(20) NOT NULL DEFAULT 'yes' CHECK (state IN ('yes', 'maybe', 'no', 'unknown', 'delegated', 'simulating', 'escalated')),

    -- Identification
    public_name VARCHAR(255),
    private_name VARCHAR(255),
    description TEXT,
    avatar_url VARCHAR(500),

    -- Ownership & Hierarchy
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    owner_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    parent_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    organization_id INTEGER,

    -- Agent Details
    model VARCHAR(100),
    capabilities JSONB DEFAULT '[]',
    skills JSONB DEFAULT '[]',
    policies JSONB DEFAULT '[]',

    -- Session (for delegated identity)
    session_token VARCHAR(255),
    session_expires_at TIMESTAMP,
    session_permissions JSONB DEFAULT '[]',
    session_constraints JSONB DEFAULT '[]',

    -- Public/Private Identity
    public_identity JSONB DEFAULT '{}',
    private_identity JSONB DEFAULT '{}',
    public_metadata JSONB DEFAULT '{}',
    private_metadata JSONB DEFAULT '{}',

    -- Trust & Reputation
    trust_score DECIMAL(5,2) DEFAULT 50.00,
    reputation_score DECIMAL(5,2) DEFAULT 50.00,
    reliability_score DECIMAL(5,2) DEFAULT 50.00,
    transparency_score DECIMAL(5,2) DEFAULT 50.00,

    -- State Details
    confidence DECIMAL(5,2),
    risk_level VARCHAR(20) DEFAULT 'low',
    last_active_at TIMESTAMP DEFAULT NOW(),

    -- Privacy
    privacy_boundary VARCHAR(20) DEFAULT 'private' CHECK (privacy_boundary IN ('public', 'private', 'liminal')),

    -- Stats
    tasks_completed INTEGER DEFAULT 0,
    tasks_failed INTEGER DEFAULT 0,
    interactions_count INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_hivv_agents_owner ON hivv_agents(owner_user_id);
CREATE INDEX idx_hivv_agents_parent ON hivv_agents(parent_agent_id);
CREATE INDEX idx_hivv_agents_state ON hivv_agents(state);
CREATE INDEX idx_hivv_agents_type ON hivv_agents(agent_type);
CREATE INDEX idx_hivv_agents_last_active ON hivv_agents(last_active_at DESC);

-- ============================================
-- AGENT RELATIONSHIPS
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    target_agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL CHECK (relationship_type IN (
        'owns', 'created_by', 'derived_from', 'delegated_by', 'operates_for',
        'communicates_with', 'delegates_to', 'receives_from',
        'trusts', 'trusted_by', 'verified_by',
        'partners_with', 'competes_with',
        'parent_of', 'child_of',
        'member_of', 'hosts',
        'uses_tool', 'provides_tool'
    )),
    state VARCHAR(20) NOT NULL DEFAULT 'yes' CHECK (state IN ('yes', 'maybe', 'no')),
    weight INTEGER DEFAULT 1,
    metadata JSONB DEFAULT '{}',
    authorized_at TIMESTAMP,
    authorized_by UUID REFERENCES hivv_agents(id),
    expires_at TIMESTAMP,
    last_interaction_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(source_agent_id, target_agent_id, relationship_type)
);

CREATE INDEX idx_hivv_rel_source ON hivv_relationships(source_agent_id);
CREATE INDEX idx_hivv_rel_target ON hivv_relationships(target_agent_id);
CREATE INDEX idx_hivv_rel_type ON hivv_relationships(relationship_type);
CREATE INDEX idx_hivv_rel_state ON hivv_relationships(state);

-- ============================================
-- PERMISSIONS
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    resource VARCHAR(100) NOT NULL,
    action VARCHAR(50) NOT NULL CHECK (action IN ('read', 'write', 'execute', 'delete', 'share', 'delegate', 'admin')),
    state VARCHAR(20) NOT NULL DEFAULT 'maybe' CHECK (state IN ('yes', 'maybe', 'no')),
    authorized_by UUID REFERENCES hivv_agents(id),
    confidence DECIMAL(5,2) DEFAULT 50.00,
    risk_level VARCHAR(20) DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    conditions JSONB DEFAULT '{}',
    limits JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(agent_id, resource, action)
);

CREATE INDEX idx_hivv_perm_agent ON hivv_permissions(agent_id);
CREATE INDEX idx_hivv_perm_state ON hivv_permissions(state);
CREATE INDEX idx_hivv_perm_resource ON hivv_permissions(resource);

-- ============================================
-- EVENTS (Activity Log)
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'agent_created', 'agent_state_changed', 'agent_blocked', 'agent_unblocked',
        'permission_granted', 'permission_revoked', 'permission_denied',
        'task_started', 'task_completed', 'task_failed', 'task_cancelled',
        'delegation_sent', 'delegation_received', 'delegation_accepted', 'delegation_rejected',
        'communication_sent', 'communication_received',
        'human_authorized', 'human_denied', 'human_escalated',
        'tool_called', 'tool_result', 'tool_failed',
        'data_accessed', 'data_shared', 'data_blocked',
        'anomaly_detected', 'anomaly_resolved',
        'relationship_formed', 'relationship_ended',
        'intention_declared', 'intention_cancelled', 'intention_executed',
        'decision_made', 'decision_reversed',
        'session_started', 'session_ended', 'session_extended'
    )),
    state VARCHAR(20) NOT NULL DEFAULT 'yes' CHECK (state IN ('yes', 'maybe', 'no')),
    severity VARCHAR(20) DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),

    -- Who & What
    agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    target_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    task_id UUID,
    permission_id UUID,

    -- Details
    description TEXT,
    payload JSONB DEFAULT '{}',
    result JSONB DEFAULT '{}',

    -- Authorization
    authorized_by UUID REFERENCES hivv_agents(id),
    authorization_state VARCHAR(20),
    authorization_reason TEXT,

    -- Context
    perspective VARCHAR(20) DEFAULT 'private' CHECK (perspective IN ('public', 'private', 'auditor')),
    ip_address VARCHAR(45),
    user_agent TEXT,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_hivv_events_agent ON hivv_events(agent_id, created_at DESC);
CREATE INDEX idx_hivv_events_type ON hivv_events(event_type, created_at DESC);
CREATE INDEX idx_hivv_events_state ON hivv_events(state, created_at DESC);
CREATE INDEX idx_hivv_events_time ON hivv_events(created_at DESC);
CREATE INDEX idx_hivv_events_target ON hivv_events(target_agent_id);

-- ============================================
-- TASKS
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    state VARCHAR(20) NOT NULL DEFAULT 'maybe' CHECK (state IN ('yes', 'maybe', 'no', 'completed', 'failed', 'cancelled')),

    -- Assignment
    owner_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    assigned_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    parent_task_id UUID REFERENCES hivv_tasks(id) ON DELETE SET NULL,

    -- Task Details
    priority INTEGER DEFAULT 50 CHECK (priority >= 1 AND priority <= 100),
    confidence DECIMAL(5,2),
    risk_level VARCHAR(20) DEFAULT 'low',
    estimated_duration INTEGER,

    -- Input/Output
    input_data JSONB DEFAULT '{}',
    output_data JSONB DEFAULT '{}',
    result_summary TEXT,

    -- Decisions
    decision_tree JSONB,
    decision_path JSONB,
    reasoning TEXT,

    -- Authorization
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by UUID REFERENCES hivv_agents(id),
    approval_reason TEXT,

    -- Timing
    deadline TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_hivv_tasks_owner ON hivv_tasks(owner_agent_id, created_at DESC);
CREATE INDEX idx_hivv_tasks_assigned ON hivv_tasks(assigned_agent_id, created_at DESC);
CREATE INDEX idx_hivv_tasks_state ON hivv_tasks(state, created_at DESC);
CREATE INDEX idx_hivv_tasks_parent ON hivv_tasks(parent_task_id);

-- ============================================
-- INTENTIONS (Future Actions)
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_intentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    intention_type VARCHAR(50) NOT NULL,
    action VARCHAR(255) NOT NULL,
    description TEXT,

    state VARCHAR(20) NOT NULL DEFAULT 'maybe' CHECK (state IN ('yes', 'maybe', 'no')),
    confidence DECIMAL(5,2) DEFAULT 50.00,
    risk_level VARCHAR(20) DEFAULT 'low',

    authorization_state VARCHAR(20) DEFAULT 'pending' CHECK (authorization_state IN ('pending', 'approved', 'denied', 'expired')),
    authorized_by UUID REFERENCES hivv_agents(id),

    -- When
    scheduled_at TIMESTAMP,
    estimated_duration INTEGER,
    expires_at TIMESTAMP,

    -- What resources
    target_resources JSONB DEFAULT '[]',
    required_permissions JSONB DEFAULT '[]',

    -- Context
    parent_intention_id UUID REFERENCES hivv_intentions(id) ON DELETE SET NULL,
    related_task_id UUID REFERENCES hivv_tasks(id) ON DELETE SET NULL,
    payload JSONB DEFAULT '{}',

    created_at TIMESTAMP DEFAULT NOW(),
    executed_at TIMESTAMP,
    cancelled_at TIMESTAMP
);

CREATE INDEX idx_hivv_intentions_agent ON hivv_intentions(agent_id, created_at DESC);
CREATE INDEX idx_hivv_intentions_state ON hivv_intentions(state, created_at DESC);
CREATE INDEX idx_hivv_intentions_scheduled ON hivv_intentions(scheduled_at) WHERE scheduled_at IS NOT NULL;

-- ============================================
-- TRUST SCORES
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_trust_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    dimension VARCHAR(50) NOT NULL CHECK (dimension IN (
        'identity', 'reliability', 'transparency', 'history',
        'authorization', 'security', 'competence', 'communication'
    )),
    score DECIMAL(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    evidence JSONB DEFAULT '[]',
    weighted_factors JSONB DEFAULT '{}',
    calculated_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(agent_id, dimension)
);

CREATE INDEX idx_hivv_trust_agent ON hivv_trust_scores(agent_id);
CREATE INDEX idx_hivv_trust_dimension ON hivv_trust_scores(dimension);

-- ============================================
-- PRIVACY BOUNDARIES
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_privacy_boundaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    boundary_type VARCHAR(20) NOT NULL CHECK (boundary_type IN ('public', 'private', 'liminal')),
    resource VARCHAR(100) NOT NULL,
    access_level VARCHAR(20) DEFAULT 'none' CHECK (access_level IN ('none', 'read', 'write', 'admin')),
    is_crossable BOOLEAN DEFAULT TRUE,
    crossing_requires_approval BOOLEAN DEFAULT TRUE,
    approved_crossings JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',

    UNIQUE(agent_id, boundary_type, resource)
);

CREATE INDEX idx_hivv_privacy_agent ON hivv_privacy_boundaries(agent_id);
CREATE INDEX idx_hivv_privacy_type ON hivv_privacy_boundaries(boundary_type);

-- ============================================
-- DECISIONS (for WHY? button)
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,
    decision_type VARCHAR(50) NOT NULL,
    context JSONB DEFAULT '{}',
    options JSONB DEFAULT '[]',
    chosen_option JSONB,
    reasoning TEXT,
    confidence DECIMAL(5,2),
    authorized_by UUID REFERENCES hivv_agents(id),
    task_id UUID REFERENCES hivv_tasks(id) ON DELETE SET NULL,

    outcome VARCHAR(50),
    outcome_reason TEXT,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_hivv_decisions_agent ON hivv_decisions(agent_id, created_at DESC);
CREATE INDEX idx_hivv_decisions_type ON hivv_decisions(decision_type);

-- ============================================
-- PROVENANCE CHAINS
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_provenance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    result_id UUID NOT NULL,
    result_type VARCHAR(50) NOT NULL,

    agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    model VARCHAR(100),
    prompt_version VARCHAR(50),
    temperature DECIMAL(3,2),
    tools_used JSONB DEFAULT '[]',

    input_sources JSONB DEFAULT '[]',
    documents_used JSONB DEFAULT '[]',
    other_agents JSONB DEFAULT '[]',

    human_authorizations JSONB DEFAULT '[]',

    confidence DECIMAL(5,2),
    trace_data JSONB DEFAULT '{}',

    created_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(result_id, result_type)
);

CREATE INDEX idx_hivv_provenance_result ON hivv_provenance(result_id, result_type);

-- ============================================
-- ANOMALIES
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_anomalies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    anomaly_type VARCHAR(50) NOT NULL CHECK (anomaly_type IN (
        'unusual_tool_usage', 'unexpected_destination', 'abnormal_spending',
        'unusual_communication', 'excessive_api_calls', 'permission_escalation',
        'repeated_failures', 'strange_relationships', 'data_access_anomaly',
        'authorization_anomaly', 'timing_anomaly', 'pattern_anomaly'
    )),
    severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    state VARCHAR(20) NOT NULL DEFAULT 'detected' CHECK (state IN ('detected', 'investigating', 'resolved', 'dismissed')),

    agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    related_event_id UUID REFERENCES hivv_events(id) ON DELETE SET NULL,

    description TEXT,
    evidence JSONB DEFAULT '[]',
    baseline JSONB DEFAULT '{}',
    deviation JSONB DEFAULT '{}',

    detected_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,
    resolved_by UUID REFERENCES hivv_agents(id),
    resolution_notes TEXT
);

CREATE INDEX idx_hivv_anomalies_agent ON hivv_anomalies(agent_id, detected_at DESC);
CREATE INDEX idx_hivv_anomalies_state ON hivv_anomalies(state, detected_at DESC);
CREATE INDEX idx_hivv_anomalies_severity ON hivv_anomalies(severity, detected_at DESC);

-- ============================================
-- MESSAGES (Agent Communication Protocol)
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_type VARCHAR(20) NOT NULL CHECK (message_type IN (
        'REQUEST', 'OFFER', 'ACCEPT', 'DENY', 'DELEGATE',
        'ASK', 'REPORT', 'ESCALATE', 'REVOKE', 'AUDIT'
    )),
    state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'delivered', 'read', 'replied', 'expired', 'cancelled')),

    from_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    to_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    to_human BOOLEAN DEFAULT FALSE,

    payload JSONB DEFAULT '{}',
    authorization_state VARCHAR(20) DEFAULT 'yes',
    authorization_confidence DECIMAL(5,2),
    authorized_by UUID REFERENCES hivv_agents(id),

    references_message_id UUID REFERENCES hivv_messages(id) ON DELETE SET NULL,
    related_task_id UUID REFERENCES hivv_tasks(id) ON DELETE SET NULL,

    sent_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    expires_at TIMESTAMP
);

CREATE INDEX idx_hivv_messages_from ON hivv_messages(from_agent_id, sent_at DESC);
CREATE INDEX idx_hivv_messages_to ON hivv_messages(to_agent_id, sent_at DESC);
CREATE INDEX idx_hivv_messages_type ON hivv_messages(message_type, sent_at DESC);
CREATE INDEX idx_hivv_messages_state ON hivv_messages(state, sent_at DESC);

-- ============================================
-- ECONOMY / TRANSACTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
        'api_spend', 'tool_cost', 'compute_cost', 'data_cost',
        'agent_payment', 'agent_charge', 'refund', 'transfer'
    )),
    state VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (state IN ('pending', 'completed', 'failed', 'refunded')),

    from_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,
    to_agent_id UUID REFERENCES hivv_agents(id) ON DELETE SET NULL,

    amount DECIMAL(12,4) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD',

    description TEXT,
    metadata JSONB DEFAULT '{}',

    related_task_id UUID REFERENCES hivv_tasks(id) ON DELETE SET NULL,
    related_usage_log_id INTEGER REFERENCES usage_logs(id) ON DELETE SET NULL,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_hivv_transactions_from ON hivv_transactions(from_agent_id, created_at DESC);
CREATE INDEX idx_hivv_transactions_to ON hivv_transactions(to_agent_id, created_at DESC);
CREATE INDEX idx_hivv_transactions_type ON hivv_transactions(transaction_type, created_at DESC);

-- ============================================
-- GEOGRAPHIC / LOCATION
-- ============================================

CREATE TABLE IF NOT EXISTS hivv_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES hivv_agents(id) ON DELETE CASCADE,

    location_type VARCHAR(30) CHECK (location_type IN ('physical', 'cloud', 'edge', 'on_premise', 'mobile')),
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    country VARCHAR(100),
    region VARCHAR(100),
    city VARCHAR(100),
    building VARCHAR(255),
    floor INTEGER,
    room VARCHAR(255),

    ip_address VARCHAR(45),
    isp VARCHAR(255),
    timezone VARCHAR(50),

    metadata JSONB DEFAULT '{}',

    last_updated TIMESTAMP DEFAULT NOW(),

    UNIQUE(agent_id)
);

CREATE INDEX idx_hivv_locations_country ON hivv_locations(country);
CREATE INDEX idx_hivv_locations_coords ON hivv_locations(latitude, longitude);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Get agent's full identity (public + private if authorized)
CREATE OR REPLACE FUNCTION get_agent_identity(
    p_agent_id UUID,
    p_perspective VARCHAR(20) DEFAULT 'private'
)
RETURNS JSONB AS $$
DECLARE
    v_agent hivv_agents%ROWTYPE;
    v_result JSONB;
BEGIN
    SELECT * INTO v_agent FROM hivv_agents WHERE id = p_agent_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_result := jsonb_build_object(
        'id', v_agent.id,
        'type', v_agent.agent_type,
        'state', v_agent.state,
        'created_at', v_agent.created_at
    );

    -- Public identity always included
    v_result := v_result || jsonb_build_object(
        'public_name', v_agent.public_name,
        'description', v_agent.description,
        'model', v_agent.model,
        'capabilities', v_agent.capabilities,
        'trust_score', v_agent.trust_score
    );

    -- Private identity only for private/owner perspective
    IF p_perspective IN ('private', 'owner') THEN
        v_result := v_result || jsonb_build_object(
            'private_name', v_agent.private_name,
            'private_metadata', v_agent.private_metadata,
            'session_permissions', v_agent.session_permissions
        );
    END IF;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Get agent's active intentions
CREATE OR REPLACE FUNCTION get_agent_intentions(p_agent_id UUID)
RETURNS TABLE (
    id UUID,
    action VARCHAR(255),
    state VARCHAR(20),
    scheduled_at TIMESTAMP,
    confidence DECIMAL(5,2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT i.id, i.action, i.state, i.scheduled_at, i.confidence
    FROM hivv_intentions i
    WHERE i.agent_id = p_agent_id
    AND i.state IN ('yes', 'maybe')
    AND (i.executed_at IS NULL AND i.cancelled_at IS NULL)
    AND (i.scheduled_at IS NULL OR i.scheduled_at > NOW())
    ORDER BY i.scheduled_at ASC NULLS LAST, i.confidence DESC;
END;
$$ LANGUAGE plpgsql;

-- Count agents by state
CREATE OR REPLACE FUNCTION get_agent_state_counts()
RETURNS TABLE (state VARCHAR(20), count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT a.state, COUNT(*)
    FROM hivv_agents a
    GROUP BY a.state;
END;
$$ LANGUAGE plpgsql;

-- Get decision chain for WHY? button
CREATE OR REPLACE FUNCTION get_decision_chain(p_decision_id UUID)
RETURNS TABLE (
    step_number INTEGER,
    decision_type VARCHAR(50),
    context JSONB,
    reasoning TEXT,
    chosen BOOLEAN,
    created_at TIMESTAMP
) AS $$
DECLARE
    v_decision hivv_decisions%ROWTYPE;
    v_steps JSONB;
    v_step JSONB;
    v_i INTEGER := 0;
BEGIN
    SELECT * INTO v_decision FROM hivv_decisions WHERE id = p_decision_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Main decision
    RETURN QUERY
    SELECT
        0,
        v_decision.decision_type,
        v_decision.context,
        v_decision.reasoning,
        TRUE,
        v_decision.created_at;

    -- Related decisions (parent context)
    RETURN QUERY
    SELECT
        1,
        d.decision_type,
        d.context,
        d.reasoning,
        FALSE,
        d.created_at
    FROM hivv_decisions d
    WHERE d.id IN (SELECT * FROM jsonb_array_to_text(v_decision.context->'related_decisions'))
    ORDER BY d.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Update agent last active timestamp
CREATE OR REPLACE FUNCTION update_agent_last_active(p_agent_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE hivv_agents SET last_active_at = NOW() WHERE id = p_agent_id;
END;
$$ LANGUAGE plpgsql;

-- Log event with automatic perspective filtering
CREATE OR REPLACE FUNCTION log_hivv_event(
    p_event_type VARCHAR(50),
    p_agent_id UUID,
    p_state VARCHAR(20) DEFAULT 'yes',
    p_perspective VARCHAR(20) DEFAULT 'private',
    p_description TEXT DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
    v_event_id UUID;
    v_filtered_payload JSONB := p_payload;
BEGIN
    -- Filter payload based on perspective
    IF p_perspective = 'public' THEN
        -- Remove sensitive fields for public events
        v_filtered_payload := v_filtered_payload - ARRAY['private_data', 'internal_reasoning', 'raw_output', 'memory'];
    END IF;

    INSERT INTO hivv_events (
        event_type, state, agent_id, description,
        payload, perspective
    ) VALUES (
        p_event_type, p_state, p_agent_id, p_description,
        v_filtered_payload, p_perspective
    ) RETURNING id INTO v_event_id;

    -- Update agent last active
    PERFORM update_agent_last_active(p_agent_id);

    RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SEED DATA: Sample Agents for Testing
-- ============================================

INSERT INTO hivv_agents (
    agent_type, state, public_name, private_name, description,
    model, capabilities, policies,
    trust_score, reputation_score, privacy_boundary
) VALUES
    ('human', 'yes', 'Alice', 'Alice Johnson', 'HIVV platform owner', NULL, '[]', '[]', 100, 100, 'private'),
    ('ai', 'yes', 'Personal Assistant', 'Alice Assistant', 'Personal AI assistant for Alice', 'claude-sonnet-4-20250514',
     '["web_search", "email_read", "calendar_read", "code_write", "file_manage"]',
     '["always_cite_sources", "respect_user_privacy", "no_external_sharing_without_approval"]',
     94, 92, 'private'),
    ('ai', 'yes', 'Research Agent', 'Alice Research', 'Research and analysis agent', 'claude-sonnet-4-20250514',
     '["web_search", "data_analysis", "report_generation", "fact_checking"]',
     '["cite_all_sources", "flag_uncertainty", "verify_facts"]',
     89, 87, 'public'),
    ('ai', 'maybe', 'Finance Agent', 'Alice Finance', 'Financial tracking and analysis', 'claude-sonnet-4-20250514',
     '["budget_analysis", "expense_tracking", "financial_reports"]',
     '["require_approval_for_spending", "never_share_account_numbers"]',
     76, 74, 'private'),
    ('organization', 'yes', 'HIVV Labs', NULL, 'HIVV research and development organization', NULL,
     '["agent_platform", "api_services", "research"]',
     '["open_research", "user_privacy_first"]',
     88, 85, 'public')
ON CONFLICT DO NOTHING;
