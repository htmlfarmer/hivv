const express = require('express');
const crypto = require('crypto');
const { body, param, query, validationResult } = require('express-validator');

// Lazy require to break circular dependency
const serverRef = new Proxy({}, {
    get(_target, prop) {
        return require('../../server.js')[prop];
    }
});

const pool = new Proxy({}, {
    get(_target, prop) {
        return serverRef.pool[prop];
    }
});

const router = express.Router();

// Validation helper
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: errors.array().map(e => e.msg).join(', ') } });
    }
    next();
};

// Auth middleware
async function requireAuth(req, res, next) {
    const session = await serverRef.getSession(req);
    if (!session) {
        return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Login required' } });
    }
    req.session = session;
    next();
}

async function optionalAuth(req, res, next) {
    const session = await serverRef.getSession(req);
    if (session) {
        req.session = session;
    }
    next();
}

// Agent token auth — agents authenticate with their own token
async function agentAuth(req, res, next) {
    const agentToken = req.headers['x-agent-token'];
    if (!agentToken) {
        return res.status(401).json({ success: false, error: { code: 'AGENT_TOKEN_REQUIRED', message: 'X-Agent-Token header required' } });
    }

    try {
        const tokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');
        const result = await pool.query(
            'SELECT a.*, u.username as owner_username FROM hivv_agents a JOIN users u ON a.owner_user_id = u.id WHERE a.session_token = $1 AND (a.session_expires_at IS NULL OR a.session_expires_at > NOW())',
            [tokenHash]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: { code: 'INVALID_AGENT_TOKEN', message: 'Invalid or expired agent token' } });
        }
        req.agent = result.rows[0];
        next();
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
}

// ============================================
// AGENT REGISTRATION
// ============================================

// Register a new agent (requires user auth)
router.post('/register',
    requireAuth,
    [
        body('name').isString().trim().isLength({ min: 1, max: 255 }).withMessage('Agent name required'),
        body('type').optional().isIn(['ai', 'human', 'organization', 'network', 'device', 'robot']).withMessage('Invalid agent type'),
        body('description').optional().isString().trim().isLength({ max: 1000 }),
        body('model').optional().isString().trim().isLength({ max: 100 }),
        body('capabilities').optional().isArray().withMessage('Capabilities must be an array')
    ],
    validate,
    async (req, res) => {
        const { name, type = 'ai', description, model, capabilities = [] } = req.body;

        try {
            // Generate agent token
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

            const result = await pool.query(`
                INSERT INTO hivv_agents (
                    agent_type, state, public_name, description, model,
                    owner_user_id, capabilities, session_token, session_expires_at,
                    trust_score, reputation_score, reliability_score, transparency_score,
                    privacy_boundary, risk_level
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                RETURNING id, agent_type, state, public_name, description, model, created_at
            `, [
                type, 'yes', name, description || null, model || null,
                req.session.userId, JSON.stringify(capabilities), tokenHash,
                new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
                50.00, 50.00, 50.00, 50.00, 'private', 'low'
            ]);

            const agent = result.rows[0];

            // Log the registration event
            await pool.query(`
                INSERT INTO hivv_events (event_type, agent_id, state, severity, description, payload, perspective)
                VALUES ('agent_created', $1, 'yes', 'info', $2, $3, 'public')
            `, [agent.id, `Agent "${name}" registered`, JSON.stringify({ type, model, capabilities })]);

            res.json({
                success: true,
                agent: {
                    id: agent.id,
                    name: agent.public_name,
                    type: agent.agent_type,
                    state: agent.state,
                    model: agent.model,
                    created_at: agent.created_at
                },
                agent_token: rawToken,
                message: 'Agent registered. Save the agent_token -- it cannot be retrieved later.'
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// ============================================
// AGENT HEARTBEAT
// ============================================

router.post('/:id/heartbeat',
    agentAuth,
    [
        body('status').optional().isString(),
        body('current_task').optional().isString(),
        body('metadata').optional().isObject()
    ],
    validate,
    async (req, res) => {
        // Verify agent is updating itself
        if (req.agent.id !== req.params.id) {
            return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Agents can only update themselves' } });
        }

        const { status = 'active', current_task, metadata } = req.body;

        try {
            await pool.query(`
                UPDATE hivv_agents SET
                    last_active_at = NOW(),
                    metadata = metadata || $2
                WHERE id = $1
            `, [req.params.id, JSON.stringify({ status, current_task, ...metadata })]);

            res.json({ success: true, timestamp: new Date().toISOString() });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// ============================================
// EVENT REPORTING
// ============================================

// Report an event (agent auth)
router.post('/:id/events',
    agentAuth,
    [
        body('event_type').isString().trim().isLength({ min: 1, max: 50 }).withMessage('Event type required'),
        body('description').optional().isString().trim().isLength({ max: 1000 }),
        body('payload').optional().isObject(),
        body('result').optional().isObject(),
        body('severity').optional().isIn(['debug', 'info', 'warning', 'error', 'critical']),
        body('target_agent_id').optional().isUUID(),
        body('resource').optional().isString(),
        body('action').optional().isString()
    ],
    validate,
    async (req, res) => {
        // Verify agent is reporting for itself
        if (req.agent.id !== req.params.id) {
            return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Agents can only report for themselves' } });
        }

        const { event_type, description, payload = {}, result = {}, severity = 'info', target_agent_id, resource, action } = req.body;

        try {
            const eventResult = await pool.query(`
                INSERT INTO hivv_events (
                    event_type, agent_id, target_agent_id, state, severity,
                    description, payload, result, perspective, authorized_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id, created_at
            `, [
                event_type, req.params.id, target_agent_id || null, 'yes', severity,
                description || `${event_type} by ${req.agent.public_name}`,
                JSON.stringify({ ...payload, resource, action }),
                JSON.stringify(result),
                'private',
                req.agent.id
            ]);

            // Update agent last_active_at
            await pool.query('UPDATE hivv_agents SET last_active_at = NOW(), interactions_count = interactions_count + 1 WHERE id = $1', [req.params.id]);

            res.json({
                success: true,
                event_id: eventResult.rows[0].id,
                timestamp: eventResult.rows[0].created_at
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// Get events for an agent (user auth)
router.get('/:id/events',
    requireAuth,
    [
        query('limit').optional().isInt({ min: 1, max: 500 }),
        query('offset').optional().isInt({ min: 0 }),
        query('event_type').optional().isString(),
        query('severity').optional().isIn(['debug', 'info', 'warning', 'error', 'critical']),
        query('since').optional().isISO8601()
    ],
    validate,
    async (req, res) => {
        const { limit = 50, offset = 0, event_type, severity, since } = req.query;

        try {
            // Verify user owns this agent
            const agentCheck = await pool.query(
                'SELECT id FROM hivv_agents WHERE id = $1 AND owner_user_id = $2',
                [req.params.id, req.session.userId]
            );
            if (agentCheck.rows.length === 0) {
                return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your agent' } });
            }

            let sql = 'SELECT * FROM hivv_events WHERE agent_id = $1';
            const params = [req.params.id];
            let paramIndex = 2;

            if (event_type) {
                sql += ` AND event_type = $${paramIndex++}`;
                params.push(event_type);
            }
            if (severity) {
                sql += ` AND severity = $${paramIndex++}`;
                params.push(severity);
            }
            if (since) {
                sql += ` AND created_at >= $${paramIndex++}`;
                params.push(since);
            }

            sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(sql, params);

            res.json({
                success: true,
                events: result.rows,
                count: result.rows.length
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// ============================================
// PERMISSION REQUESTS
// ============================================

// Agent requests permission for an action
router.post('/:id/permissions/request',
    agentAuth,
    [
        body('resource').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Resource required'),
        body('action').isString().trim().isLength({ min: 1, max: 50 }).withMessage('Action required'),
        body('reason').optional().isString().trim().isLength({ max: 500 }),
        body('risk_level').optional().isIn(['low', 'medium', 'high', 'critical'])
    ],
    validate,
    async (req, res) => {
        if (req.agent.id !== req.params.id) {
            return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Agents can only request for themselves' } });
        }

        const { resource, action, reason, risk_level = 'medium' } = req.body;

        try {
            // Check if there's an existing permission
            const existing = await pool.query(
                'SELECT * FROM hivv_permissions WHERE agent_id = $1 AND resource = $2 AND action = $3',
                [req.params.id, resource, action]
            );

            if (existing.rows.length > 0 && existing.rows[0].state === 'yes') {
                return res.json({ success: true, state: 'already_granted', permission: existing.rows[0] });
            }

            // Create or update permission as MAYBE (pending approval)
            const permResult = await pool.query(`
                INSERT INTO hivv_permissions (agent_id, resource, action, state, risk_level, authorized_by)
                VALUES ($1, $2, $3, 'maybe', $4, $5)
                ON CONFLICT (agent_id, resource, action) DO UPDATE SET state = 'maybe', risk_level = $4
                RETURNING id
            `, [req.params.id, resource, action, risk_level, req.agent.id]);

            // Create an intention for the approval workflow
            await pool.query(`
                INSERT INTO hivv_intentions (agent_id, intention_type, action, description, state, authorization_state, risk_level, required_permissions)
                VALUES ($1, 'permission_request', $2, $3, 'maybe', 'pending', $4, $5)
            `, [
                req.params.id,
                `${action} ${resource}`,
                reason || `Agent requests ${action} access to ${resource}`,
                risk_level,
                JSON.stringify([{ resource, action }])
            ]);

            // Log the event
            await pool.query(`
                INSERT INTO hivv_events (event_type, agent_id, state, severity, description, payload, perspective)
                VALUES ('permission_granted', $1, 'maybe', $2, $3, $4, 'private')
            `, [
                req.params.id,
                risk_level === 'critical' ? 'warning' : 'info',
                `Permission requested: ${action} on ${resource}`,
                JSON.stringify({ resource, action, reason, risk_level })
            ]);

            res.json({
                success: true,
                state: 'pending_approval',
                permission_id: permResult.rows[0].id,
                message: 'Permission request submitted. Waiting for human approval.'
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// ============================================
// APPROVAL WORKFLOW
// ============================================

// Get pending approvals for the authenticated user (or empty for guests)
router.get('/approvals/pending',
    optionalAuth,
    async (req, res) => {
        if (!req.session) {
            return res.json({ success: true, approvals: [], count: 0, is_guest: true });
        }
        try {
            // Get permissions in MAYBE state for user's agents
            const result = await pool.query(`
                SELECT
                    p.id as permission_id,
                    p.resource,
                    p.action,
                    p.state,
                    p.risk_level,
                    p.created_at as requested_at,
                    a.id as agent_id,
                    a.public_name as agent_name,
                    a.agent_type,
                    i.description as reason,
                    i.id as intention_id
                FROM hivv_permissions p
                JOIN hivv_agents a ON p.agent_id = a.id
                LEFT JOIN hivv_intentions i ON i.agent_id = a.id AND i.authorization_state = 'pending'
                WHERE a.owner_user_id = $1 AND p.state = 'maybe'
                ORDER BY p.created_at DESC
            `, [req.session.userId]);

            res.json({
                success: true,
                approvals: result.rows,
                count: result.rows.length
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// Approve or deny a permission request
router.post('/approvals/:permissionId/decide',
    requireAuth,
    [
        body('decision').isIn(['approve', 'deny']).withMessage('Decision must be approve or deny'),
        body('reason').optional().isString().trim().isLength({ max: 500 })
    ],
    validate,
    async (req, res) => {
        const { decision, reason } = req.body;

        try {
            // Verify user owns the agent this permission belongs to
            const permResult = await pool.query(`
                SELECT p.*, a.owner_user_id, a.public_name as agent_name
                FROM hivv_permissions p
                JOIN hivv_agents a ON p.agent_id = a.id
                WHERE p.id = $1 AND a.owner_user_id = $2
            `, [req.params.permissionId, req.session.userId]);

            if (permResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Permission not found' } });
            }

            const perm = permResult.rows[0];
            const newState = decision === 'approve' ? 'yes' : 'no';

            // Update permission
            await pool.query(
                'UPDATE hivv_permissions SET state = $1, updated_at = NOW() WHERE id = $2',
                [newState, req.params.permissionId]
            );

            // Update related intentions
            await pool.query(`
                UPDATE hivv_intentions SET
                    authorization_state = $1,
                    authorized_by = $2
                WHERE agent_id = $3 AND authorization_state = 'pending'
            `, [decision === 'approve' ? 'approved' : 'denied', perm.agent_id, perm.agent_id]);

            // Log the decision
            await pool.query(`
                INSERT INTO hivv_events (event_type, agent_id, state, severity, description, payload, authorized_by, perspective)
                VALUES ($1, $2, $3, 'info', $4, $5, $6, 'private')
            `, [
                decision === 'approve' ? 'permission_granted' : 'permission_denied',
                perm.agent_id,
                newState,
                `Permission ${decision === 'approve' ? 'approved' : 'denied'}: ${perm.action} on ${perm.resource}`,
                JSON.stringify({ resource: perm.resource, action: perm.action, reason, decided_by: req.session.username, user_id: req.session.userId }),
                perm.agent_id
            ]);

            res.json({
                success: true,
                permission_id: perm.id,
                new_state: newState,
                message: `Permission ${decision === 'approve' ? 'approved' : 'denied'}`
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// ============================================
// AGENT LIST (for authenticated user)
// ============================================

// Get cost summary for user's agents
router.get('/costs/summary',
    optionalAuth,
    async (req, res) => {
        if (!req.session) {
            return res.json({ success: true, today: { today_cost: 0, today_requests: 0, today_tokens: 0 }, is_guest: true });
        }
        try {
            // Get usage costs from usage_logs for this user
            const result = await pool.query(`
                SELECT
                    DATE(created_at) as date,
                    SUM(cost) as total_cost,
                    SUM(input_tokens) as input_tokens,
                    SUM(output_tokens) as output_tokens,
                    COUNT(*) as requests,
                    model
                FROM usage_logs
                WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
                GROUP BY DATE(created_at), model
                ORDER BY date DESC
            `, [req.session.userId]);

            // Get today's total
            const todayResult = await pool.query(`
                SELECT
                    COALESCE(SUM(cost), 0) as today_cost,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as today_tokens,
                    COUNT(*) as today_requests
                FROM usage_logs
                WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE
            `, [req.session.userId]);

            // Get this month's total
            const monthResult = await pool.query(`
                SELECT
                    COALESCE(SUM(cost), 0) as month_cost,
                    COALESCE(SUM(input_tokens + output_tokens), 0) as month_tokens,
                    COUNT(*) as month_requests
                FROM usage_logs
                WHERE user_id = $1 AND created_at > DATE_TRUNC('month', CURRENT_DATE)
            `, [req.session.userId]);

            // Get top models
            const topModels = await pool.query(`
                SELECT
                    model,
                    COUNT(*) as requests,
                    SUM(cost) as cost,
                    SUM(input_tokens + output_tokens) as tokens
                FROM usage_logs
                WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
                GROUP BY model
                ORDER BY cost DESC
                LIMIT 5
            `, [req.session.userId]);

            res.json({
                success: true,
                today: todayResult.rows[0],
                month: monthResult.rows[0],
                daily: result.rows,
                top_models: topModels.rows
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// ============================================
// AGENT LIST (for authenticated user)
// ============================================

router.get('/',
    requireAuth,
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    a.id, a.agent_type, a.state, a.public_name, a.description, a.model,
                    a.capabilities, a.trust_score, a.last_active_at, a.created_at,
                    a.interactions_count, a.tasks_completed, a.tasks_failed,
                    (SELECT COUNT(*) FROM hivv_permissions p WHERE p.agent_id = a.id AND p.state = 'maybe') as pending_permissions,
                    (SELECT COUNT(*) FROM hivv_events e WHERE e.agent_id = a.id AND e.created_at > NOW() - INTERVAL '24 hours') as events_24h
                FROM hivv_agents a
                WHERE a.owner_user_id = $1
                ORDER BY a.last_active_at DESC
            `, [req.session.userId]);

            res.json({
                success: true,
                agents: result.rows,
                count: result.rows.length
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

// Get single agent details
router.get('/:id',
    requireAuth,
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.*,
                    (SELECT COUNT(*) FROM hivv_permissions p WHERE p.agent_id = a.id AND p.state = 'maybe') as pending_permissions,
                    (SELECT COUNT(*) FROM hivv_events e WHERE e.agent_id = a.id AND e.created_at > NOW() - INTERVAL '24 hours') as events_24h,
                    (SELECT COUNT(*) FROM hivv_relationships r WHERE r.source_agent_id = a.id OR r.target_agent_id = a.id) as relationship_count
                FROM hivv_agents a
                WHERE a.id = $1 AND a.owner_user_id = $2
            `, [req.params.id, req.session.userId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
            }

            const agent = result.rows[0];

            // Get recent events
            const events = await pool.query(
                'SELECT * FROM hivv_events WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20',
                [agent.id]
            );

            // Get permissions
            const permissions = await pool.query(
                'SELECT * FROM hivv_permissions WHERE agent_id = $1 ORDER BY resource, action',
                [agent.id]
            );

            res.json({
                success: true,
                agent,
                recent_events: events.rows,
                permissions: permissions.rows
            });
        } catch (err) {
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    }
);

module.exports = router;
