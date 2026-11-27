const express = require('express');
const router = express.Router();
const { query, param, body, validationResult } = require('express-validator');
// Lazy require via Proxy — server.js loads us at line 1988 while it's still
// mid-evaluation, so an eager `require('../server').pool` returns undefined
// (module.exports is assigned at line 1993, too late). The Proxy defers the
// real require until first property access, by which time server.js is done.
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

// ── the SAMPLE flag ──────────────────────────────────────────
//
// Migration 033 adds hivv_agents.is_demo so the seeded sample rows can be
// told apart from real registrations. The gateway ENSURES the columns on its
// first request (idempotent, instant) so it also works on a box where the
// migration has not been applied yet — a fresh clone boots the gateway
// before anything else.
let _demoColReady = null;
async function ensureDemoCols() {
    if (_demoColReady) return _demoColReady;
    try {
        await pool.query('ALTER TABLE hivv_agents ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false');
        await pool.query('ALTER TABLE hivv_events ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false');
        await pool.query('ALTER TABLE hivv_intentions ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false');
        _demoColReady = true;
    } catch (_e) {
        // No database (local-first mode) or no permission. The queries that
        // name is_demo will fail loudly — which is honest.
        _demoColReady = false;
    }
    return _demoColReady;
}

// The filter clause for a demo mode.
function demoClause(alias, mode) {
    if (mode === 'only') return ` AND ${alias}.is_demo = true`;
    if (mode === 'exclude') return ` AND ${alias}.is_demo = false`;
    return '';
}

// Validation helper
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
    }
    next();
};

// Auth middleware — allow public reads with public perspective; require auth for writes
async function dashboardAuth(req, res, next) {
    const session = await serverRef.getSession(req);
    if (session) {
        req.session = session;
    }
    // Write operations require authenticated session
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        if (!req.session) {
            return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Login required for write actions' } });
        }
    } else {
        // Read operations without session are restricted to public perspective
        if (!req.session) {
            req.query.perspective = 'public';
        }
    }
    next();
}

router.use(dashboardAuth);

// The sample flag must exist before any query below names it.
router.use(async (_req, _res, next) => {
    try { await ensureDemoCols(); } catch (_e) { /* local-first: no database */ }
    next();
});

// ============================================
// AGENTS
// ============================================

// List all agents with filtering
router.get('/agents',
    [
        query('state').optional().isIn(['yes', 'maybe', 'no', 'unknown']),
        query('type').optional().isIn(['human', 'ai', 'organization', 'network', 'device', 'robot']),
        query('perspective').optional().isIn(['public', 'private', 'auditor']),
        // demo=exclude (the default: only REAL registrations), demo=only
        // (the sample rows), demo=all (both). A sample is never counted as
        // a registration by accident.
        query('demo').optional().isIn(['exclude', 'only', 'all']),
        query('limit').optional().isInt({ min: 1, max: 1000 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    validate,
    async (req, res) => {
        try {
            const { state, type, perspective = 'public', demo = 'exclude', limit = 100, offset = 0 } = req.query;

            let sql = `
        SELECT
          a.id,
          a.agent_type,
          a.state,
          a.public_name,
          a.description,
          a.model,
          a.capabilities,
          a.trust_score,
          a.reputation_score,
          a.last_active_at,
          a.created_at,
          a.is_demo
      `;

            // Include private fields only for private perspective
            if (perspective === 'private' || perspective === 'owner') {
                sql += `,
          a.private_name,
          a.private_metadata,
          a.session_permissions,
          a.session_expires_at
        `;
            }

            sql += `
        FROM hivv_agents a
        WHERE 1=1
      `;

            const params = [];
            let paramIndex = 1;

            if (state) {
                sql += ` AND a.state = $${paramIndex++}`;
                params.push(state);
            }

            if (type) {
                sql += ` AND a.agent_type = $${paramIndex++}`;
                params.push(type);
            }

            // For public perspective, hide private agents
            if (perspective === 'public') {
                sql += ' AND a.privacy_boundary = \'public\'';
            }

            // The sample rows are excluded by default: they are schema seed
            // data, not registrations, and a fleet count that includes them
            // is a fleet count that lies.
            sql += demoClause('a', demo);

            sql += ` ORDER BY a.last_active_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(sql, params);

            // Get total count
            let countSql = 'SELECT COUNT(*) FROM hivv_agents a WHERE 1=1';
            const countParams = [];
            let countIndex = 1;

            if (state) {
                countSql += ` AND a.state = $${countIndex++}`;
                countParams.push(state);
            }
            if (type) {
                countSql += ` AND a.agent_type = $${countIndex++}`;
                countParams.push(type);
            }
            if (perspective === 'public') {
                countSql += ' AND a.privacy_boundary = \'public\'';
            }
            countSql += demoClause('a', demo);

            const countResult = await pool.query(countSql, countParams);

            // The sample count travels WITH the payload: a visitor can see
            // exactly how much of what they are looking at is seed data.
            let demoCount = 0;
            try {
                const d = await pool.query(
                    "SELECT COUNT(*)::int AS n FROM hivv_agents WHERE is_demo = true AND COALESCE(privacy_boundary, 'public') = 'public'");
                demoCount = d.rows[0]?.n ?? 0;
            } catch (_e) { /* the column may not exist yet */ }

            res.json({
                success: true,
                agents: result.rows,
                total: parseInt(countResult.rows[0].count),
                demo_total: demoCount,
                limit: parseInt(limit),
                offset: parseInt(offset)
            });
        } catch (err) {
            console.error('Error listing agents:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Get single agent with full details
router.get('/agents/:id',
    [
        param('id').isUUID(),
        query('perspective').optional().isIn(['public', 'private', 'auditor', 'owner'])
    ],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { perspective = 'public' } = req.query;

            const sql = `
        SELECT
          a.*,
          get_agent_state_counts() as state_distribution
        FROM hivv_agents a
        WHERE a.id = $1
      `;

            const result = await pool.query(sql, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Agent not found' });
            }

            const agent = result.rows[0];

            // Get relationships
            const relResult = await pool.query(`
        SELECT r.*,
          CASE WHEN r.source_agent_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction,
          CASE
            WHEN r.source_agent_id = $1 THEN (SELECT public_name FROM hivv_agents WHERE id = r.target_agent_id)
            ELSE (SELECT public_name FROM hivv_agents WHERE id = r.source_agent_id)
          END as other_agent_name
        FROM hivv_relationships r
        WHERE r.source_agent_id = $1 OR r.target_agent_id = $1
        ORDER BY r.last_interaction_at DESC
        LIMIT 50
      `, [id]);

            // Get permissions
            const permResult = await pool.query(`
        SELECT * FROM hivv_permissions
        WHERE agent_id = $1
        ORDER BY resource, action
      `, [id]);

            // Get intentions
            const intentResult = await pool.query(`
        SELECT * FROM hivv_intentions
        WHERE agent_id = $1
        AND state IN ('yes', 'maybe')
        AND executed_at IS NULL
        AND cancelled_at IS NULL
        ORDER BY scheduled_at ASC NULLS LAST
        LIMIT 20
      `, [id]);

            // Get recent events
            const eventResult = await pool.query(`
        SELECT * FROM hivv_events
        WHERE agent_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [id]);

            res.json({
                success: true,
                agent: {
                    ...agent,
                    // Only include private data if authorized
                    ...(perspective === 'private' || perspective === 'owner' ? {
                        private_name: agent.private_name,
                        private_metadata: agent.private_metadata,
                        session_permissions: agent.session_permissions
                    } : {})
                },
                relationships: relResult.rows,
                permissions: permResult.rows,
                intentions: intentResult.rows,
                recent_events: eventResult.rows
            });
        } catch (err) {
            console.error('Error getting agent:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Update agent state
router.post('/agents/:id/state',
    [
        param('id').isUUID(),
        body('state').isIn(['yes', 'maybe', 'no', 'unknown']),
        body('reason').optional().isString()
    ],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { state, reason } = req.body;
            const sessionToken = req.headers['x-session-token'];

            // Verify authorization
            if (!req.session) {
                return res.status(401).json({ success: false, error: 'Authentication required' });
            }

            // A seeded sample row is a fixture, not a live agent. Pausing or
            // activating it would dress it up as a registration.
            const demoCheck = await pool.query(
                'SELECT is_demo FROM hivv_agents WHERE id = $1', [id]);
            if (demoCheck.rows[0]?.is_demo) {
                return res.status(409).json({
                    success: false,
                    error: 'SAMPLE_ROW',
                    message: 'This is a seeded sample row, not a registered agent.',
                });
            }

            const agentResult = await pool.query(`
        UPDATE hivv_agents
        SET state = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [state, id]);

            if (agentResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Agent not found' });
            }

            // Log the state change
            await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, description, payload)
        VALUES ($1, $2, $3, $4, $5)
      `, [
                'agent_state_changed',
                state,
                id,
                reason || `State changed to ${state}`,
                JSON.stringify({ previous_state: req.body.previous_state })
            ]);

            res.json({ success: true, agent: agentResult.rows[0] });
        } catch (err) {
            console.error('Error updating agent state:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// RELATIONSHIPS
// ============================================

// Get relationship graph
router.get('/relationships',
    [
        query('agent_id').optional().isUUID(),
        query('type').optional().isString(),
        query('state').optional().isIn(['yes', 'maybe', 'no', 'all']),
        query('limit').optional().isInt({ min: 1, max: 1000 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, type, state, limit = 500 } = req.query;

            let sql = `
        SELECT r.*,
          src.public_name as source_name,
          src.agent_type as source_type,
          tgt.public_name as target_name,
          tgt.agent_type as target_type,
          (src.is_demo OR tgt.is_demo) AS is_demo
        FROM hivv_relationships r
        JOIN hivv_agents src ON src.id = r.source_agent_id
        JOIN hivv_agents tgt ON tgt.id = r.target_agent_id
        WHERE 1=1
      `;

            // A relationship whose ends are sample rows is sample data.
            // The graph is a picture of the live system; a fixture is
            // not part of it.
            sql += ' AND r.source_agent_id IN (SELECT id FROM hivv_agents WHERE is_demo = false)'
                 + ' AND r.target_agent_id IN (SELECT id FROM hivv_agents WHERE is_demo = false)';

            const params = [];
            let idx = 1;

            if (agent_id) {
                sql += ` AND (r.source_agent_id = $${idx++} OR r.target_agent_id = $${idx++})`;
                params.push(agent_id, agent_id);
            }

            if (type) {
                sql += ` AND r.relationship_type = $${idx++}`;
                params.push(type);
            }

            if (state) {
                sql += ` AND r.state = $${idx++}`;
                params.push(state);
            }

            sql += ` ORDER BY r.weight DESC, r.last_interaction_at DESC LIMIT $${idx++}`;
            params.push(parseInt(limit));

            const result = await pool.query(sql, params);

            res.json({ success: true, relationships: result.rows });
        } catch (err) {
            console.error('Error getting relationships:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Create relationship
router.post('/relationships',
    [
        body('source_agent_id').isUUID(),
        body('target_agent_id').isUUID(),
        body('relationship_type').isIn([
            'owns', 'created_by', 'derived_from', 'delegated_by', 'operates_for',
            'communicates_with', 'delegates_to', 'receives_from',
            'trusts', 'trusted_by', 'verified_by',
            'partners_with', 'competes_with',
            'parent_of', 'child_of',
            'member_of', 'hosts',
            'uses_tool', 'provides_tool'
        ]),
        body('state').optional().isIn(['yes', 'maybe', 'no'])
    ],
    validate,
    async (req, res) => {
        try {
            const { source_agent_id, target_agent_id, relationship_type, state = 'yes', metadata = {} } = req.body;

            const result = await pool.query(`
        INSERT INTO hivv_relationships (source_agent_id, target_agent_id, relationship_type, state, metadata)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (source_agent_id, target_agent_id, relationship_type)
        DO UPDATE SET state = EXCLUDED.state, metadata = EXCLUDED.metadata, last_interaction_at = NOW()
        RETURNING *
      `, [source_agent_id, target_agent_id, relationship_type, state, JSON.stringify(metadata)]);

            // Log event
            await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, target_agent_id, description, payload)
        VALUES ('relationship_formed', $1, $2, $3, $4, $5)
      `, [state, source_agent_id, target_agent_id, `Relationship ${relationship_type} formed`, JSON.stringify(metadata)]);

            res.json({ success: true, relationship: result.rows[0] });
        } catch (err) {
            console.error('Error creating relationship:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// PERMISSIONS
// ============================================

// Get permission matrix
router.get('/permissions/matrix',
    [
        query('agent_id').optional().isUUID()
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id } = req.query;

            let sql = `
        SELECT p.*, a.public_name as agent_name
        FROM hivv_permissions p
        JOIN hivv_agents a ON a.id = p.agent_id
        WHERE 1=1
      `;

            const params = [];
            if (agent_id) {
                sql += ' AND p.agent_id = $1';
                params.push(agent_id);
            }

            sql += ' ORDER BY a.public_name, p.resource, p.action';

            const result = await pool.query(sql, params);

            // Group by agent
            const matrix = {};
            for (const row of result.rows) {
                if (!matrix[row.agent_id]) {
                    matrix[row.agent_id] = {
                        agent_id: row.agent_id,
                        agent_name: row.agent_name,
                        permissions: {}
                    };
                }
                if (!matrix[row.agent_id].permissions[row.resource]) {
                    matrix[row.agent_id].permissions[row.resource] = {};
                }
                matrix[row.agent_id].permissions[row.resource][row.action] = {
                    state: row.state,
                    confidence: row.confidence,
                    risk_level: row.risk_level
                };
            }

            res.json({ success: true, matrix: Object.values(matrix) });
        } catch (err) {
            console.error('Error getting permission matrix:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Update permission
router.post('/permissions/:id',
    [
        param('id').isUUID(),
        body('state').isIn(['yes', 'maybe', 'no']),
        body('authorized_by').optional().isUUID(),
        body('reason').optional().isString()
    ],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { state, authorized_by, reason } = req.body;

            const result = await pool.query(`
        UPDATE hivv_permissions
        SET state = $1, authorized_by = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [state, authorized_by || null, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Permission not found' });
            }

            // Log event
            await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, permission_id, description, authorized_by)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
                state === 'yes' ? 'permission_granted' : state === 'no' ? 'permission_revoked' : 'permission_denied',
                state,
                result.rows[0].agent_id,
                id,
                reason || `Permission ${state === 'yes' ? 'granted' : state === 'no' ? 'revoked' : 'denied'}`,
                authorized_by
            ]);

            res.json({ success: true, permission: result.rows[0] });
        } catch (err) {
            console.error('Error updating permission:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// EVENTS & ACTIVITY
// ============================================

// Get activity stream
router.get('/activity',
    [
        query('agent_id').optional().isUUID(),
        query('type').optional().isString(),
        query('state').optional().isIn(['yes', 'maybe', 'no', 'all']),
        query('severity').optional().isIn(['debug', 'info', 'warning', 'error', 'critical']),
        query('time_range').optional().isIn(['1h', '6h', '24h', '7d', '30d', 'all']),
        query('demo').optional().isIn(['exclude', 'only', 'all']),
        query('limit').optional().isInt({ min: 1, max: 500 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, type, state, severity, time_range = '24h', demo = 'exclude', limit = 100, offset = 0 } = req.query;

            let sql = `
        SELECT e.*,
          a.public_name as agent_name,
          t.public_name as target_name,
          e.is_demo
        FROM hivv_events e
        LEFT JOIN hivv_agents a ON a.id = e.agent_id
        LEFT JOIN hivv_agents t ON t.id = e.target_agent_id
        WHERE 1=1
      `;

            const params = [];
            // A sample agent's tool call is not activity. It never happened.
            sql += demoClause('e', demo);
            let idx = 1;

            if (agent_id) {
                sql += ` AND e.agent_id = $${idx++}`;
                params.push(agent_id);
            }

            if (type) {
                sql += ` AND e.event_type = $${idx++}`;
                params.push(type);
            }

            if (state) {
                sql += ` AND e.state = $${idx++}`;
                params.push(state);
            }

            if (severity) {
                sql += ` AND e.severity = $${idx++}`;
                params.push(severity);
            }

            // Time range filter
            const timeRanges = {
                '1h': '1 hour',
                '6h': '6 hours',
                '24h': '24 hours',
                '7d': '7 days',
                '30d': '30 days',
                'all': null
            };

            if (timeRanges[time_range]) {
                sql += ` AND e.created_at > NOW() - INTERVAL '${timeRanges[time_range]}'`;
            }

            sql += ` ORDER BY e.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(sql, params);

            res.json({ success: true, events: result.rows });
        } catch (err) {
            console.error('Error getting activity:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Log new event
router.post('/events',
    [
        body('event_type').isString(),
        body('agent_id').isUUID(),
        body('state').optional().isIn(['yes', 'maybe', 'no']),
        body('description').optional().isString(),
        body('payload').optional().isObject()
    ],
    validate,
    async (req, res) => {
        try {
            const { event_type, agent_id, state = 'yes', description, payload = {} } = req.body;

            const result = await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, description, payload)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [event_type, state, agent_id, description, JSON.stringify(payload)]);

            res.json({ success: true, event: result.rows[0] });
        } catch (err) {
            console.error('Error logging event:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// INTENTIONS & FUTURE ACTIONS
// ============================================

// Get intention map
router.get('/intentions',
    [
        query('agent_id').optional().isUUID(),
        query('state').optional().isIn(['yes', 'maybe', 'no', 'all']),
        query('scheduled').optional().isBoolean(),
        query('demo').optional().isIn(['exclude', 'only', 'all']),
        query('limit').optional().isInt({ min: 1, max: 500 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, state, scheduled, demo = 'exclude', limit = 100 } = req.query;

            let sql = `
        SELECT i.*, a.public_name as agent_name, i.is_demo
        FROM hivv_intentions i
        JOIN hivv_agents a ON a.id = i.agent_id
        WHERE i.executed_at IS NULL AND i.cancelled_at IS NULL
      `;

            const params = [];
            // A sample agent's intention (a fake sell order) never existed.
            // It is not a pending action; it is a fixture.
            sql += demoClause('i', demo);
            let idx = 1;

            if (agent_id) {
                sql += ` AND i.agent_id = $${idx++}`;
                params.push(agent_id);
            }

            if (state) {
                sql += ` AND i.state = $${idx++}`;
                params.push(state);
            }

            if (scheduled !== undefined) {
                if (scheduled === true || scheduled === 'true') {
                    sql += ' AND i.scheduled_at IS NOT NULL AND i.scheduled_at > NOW()';
                } else {
                    sql += ' AND (i.scheduled_at IS NULL OR i.scheduled_at <= NOW())';
                }
            }

            sql += ` ORDER BY i.scheduled_at ASC NULLS LAST, i.confidence DESC LIMIT $${idx++}`;
            params.push(parseInt(limit));

            const result = await pool.query(sql, params);

            res.json({ success: true, intentions: result.rows });
        } catch (err) {
            console.error('Error getting intentions:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Declare new intention
router.post('/intentions',
    [
        body('agent_id').isUUID(),
        body('action').isString(),
        body('intention_type').optional().isString(),
        body('state').optional().isIn(['yes', 'maybe', 'no']),
        body('scheduled_at').optional().isISO8601()
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, action, intention_type = 'general', state = 'maybe', scheduled_at, confidence, risk_level, payload = {} } = req.body;

            const result = await pool.query(`
        INSERT INTO hivv_intentions (agent_id, intention_type, action, state, scheduled_at, confidence, risk_level, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [agent_id, intention_type, action, state, scheduled_at, confidence, risk_level || 'low', JSON.stringify(payload)]);

            // Log event
            await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, description, payload)
        VALUES ('intention_declared', $1, $2, $3, $4)
      `, [state, agent_id, `Intention: ${action}`, JSON.stringify(payload)]);

            res.json({ success: true, intention: result.rows[0] });
        } catch (err) {
            console.error('Error creating intention:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// TASKS
// ============================================

// Get tasks
router.get('/tasks',
    [
        query('agent_id').optional().isUUID(),
        query('owner_id').optional().isUUID(),
        query('state').optional().isIn(['yes', 'maybe', 'no', 'completed', 'failed', 'cancelled']),
        query('limit').optional().isInt({ min: 1, max: 500 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, owner_id, state, limit = 100 } = req.query;

            let sql = `
        SELECT t.*,
          a.public_name as assigned_name,
          o.public_name as owner_name
        FROM hivv_tasks t
        LEFT JOIN hivv_agents a ON a.id = t.assigned_agent_id
        LEFT JOIN hivv_agents o ON o.id = t.owner_agent_id
        WHERE 1=1
      `;

            const params = [];
            let idx = 1;

            if (agent_id) {
                sql += ` AND (t.assigned_agent_id = $${idx++} OR t.owner_agent_id = $${idx++})`;
                params.push(agent_id, agent_id);
            }

            if (owner_id) {
                sql += ` AND t.owner_agent_id = $${idx++}`;
                params.push(owner_id);
            }

            if (state) {
                sql += ` AND t.state = $${idx++}`;
                params.push(state);
            }

            sql += ` ORDER BY t.created_at DESC LIMIT $${idx++}`;
            params.push(parseInt(limit));

            const result = await pool.query(sql, params);

            res.json({ success: true, tasks: result.rows });
        } catch (err) {
            console.error('Error getting tasks:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// TRUST & REPUTATION
// ============================================

// Get trust profile
router.get('/trust/:agent_id',
    [
        param('agent_id').isUUID()
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id } = req.params;

            // Get agent's trust scores
            const scoreResult = await pool.query(`
        SELECT * FROM hivv_trust_scores
        WHERE agent_id = $1
      `, [agent_id]);

            // Get agent's overall scores
            const agentResult = await pool.query(`
        SELECT trust_score, reputation_score, reliability_score, transparency_score
        FROM hivv_agents
        WHERE id = $1
      `, [agent_id]);

            // Get trust relationships
            const trustResult = await pool.query(`
        SELECT r.*,
          a.public_name,
          CASE WHEN r.source_agent_id = $1 THEN 'trusted_by' ELSE 'trusts' END as direction
        FROM hivv_relationships r
        JOIN hivv_agents a ON a.id = CASE WHEN r.source_agent_id = $1 THEN r.target_agent_id ELSE r.source_agent_id END
        WHERE (r.source_agent_id = $1 OR r.target_agent_id = $1)
        AND r.relationship_type IN ('trusts', 'trusted_by')
        ORDER BY r.weight DESC
        LIMIT 50
      `, [agent_id]);

            res.json({
                success: true,
                trust_scores: scoreResult.rows,
                overall: agentResult.rows[0] || {},
                relationships: trustResult.rows
            });
        } catch (err) {
            console.error('Error getting trust profile:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// DECISIONS & WHY?
// ============================================

// Get decision chain
router.get('/decisions/:id/why',
    [
        param('id').isUUID()
    ],
    validate,
    async (req, res) => {
        try {
            const { id } = req.params;

            // Get main decision
            const decisionResult = await pool.query(`
        SELECT d.*, a.public_name as agent_name
        FROM hivv_decisions d
        JOIN hivv_agents a ON a.id = d.agent_id
        WHERE d.id = $1
      `, [id]);

            if (decisionResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Decision not found' });
            }

            const decision = decisionResult.rows[0];

            // Get related events
            const eventsResult = await pool.query(`
        SELECT * FROM hivv_events
        WHERE agent_id = $1
        AND created_at BETWEEN $2 - INTERVAL '1 hour' AND $2 + INTERVAL '1 hour'
        ORDER BY created_at ASC
      `, [decision.agent_id, decision.created_at]);

            // Get authorization chain
            const authResult = await pool.query(`
        SELECT * FROM hivv_events
        WHERE agent_id = $1
        AND event_type IN ('human_authorized', 'human_denied', 'permission_granted', 'permission_revoked')
        AND created_at BETWEEN $2 - INTERVAL '1 hour' AND $2 + INTERVAL '1 hour'
        ORDER BY created_at ASC
      `, [decision.agent_id, decision.created_at]);

            // Get related decisions
            const context = decision.context || {};
            let relatedDecisions = [];

            if (context.related_decisions && context.related_decisions.length > 0) {
                const relatedResult = await pool.query(`
          SELECT id, decision_type, context, reasoning, created_at
          FROM hivv_decisions
          WHERE id = ANY($1)
          ORDER BY created_at ASC
        `, [context.related_decisions]);
                relatedDecisions = relatedResult.rows;
            }

            res.json({
                success: true,
                decision: decision,
                chain: {
                    main_decision: decision,
                    reasoning_chain: relatedDecisions,
                    events: eventsResult.rows,
                    authorizations: authResult.rows
                }
            });
        } catch (err) {
            console.error('Error getting decision chain:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Record decision
router.post('/decisions',
    [
        body('agent_id').isUUID(),
        body('decision_type').isString(),
        body('reasoning').optional().isString(),
        body('chosen_option').optional().isObject(),
        body('confidence').optional().isDecimal()
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, decision_type, context = {}, options = [], chosen_option, reasoning, confidence, authorized_by, task_id, outcome } = req.body;

            const result = await pool.query(`
        INSERT INTO hivv_decisions (agent_id, decision_type, context, options, chosen_option, reasoning, confidence, authorized_by, task_id, outcome)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [agent_id, decision_type, JSON.stringify(context), JSON.stringify(options), JSON.stringify(chosen_option), reasoning, confidence, authorized_by, task_id, outcome]);

            // Log event
            await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, task_id, description, payload)
        VALUES ('decision_made', 'yes', $1, $2, $3, $4)
      `, [agent_id, task_id, `Decision: ${decision_type}`, JSON.stringify({ decision_id: result.rows[0].id, chosen_option })]);

            res.json({ success: true, decision: result.rows[0] });
        } catch (err) {
            console.error('Error recording decision:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// ANOMALIES
// ============================================

// Get anomaly radar data
router.get('/anomalies/radar',
    [
        query('agent_id').optional().isUUID(),
        query('severity').optional().isIn(['low', 'medium', 'high', 'critical']),
        query('state').optional().isIn(['detected', 'investigating', 'resolved', 'dismissed']),
        query('limit').optional().isInt({ min: 1, max: 100 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, severity, state = 'detected', limit = 50 } = req.query;

            let sql = `
        SELECT an.*, a.public_name as agent_name
        FROM hivv_anomalies an
        LEFT JOIN hivv_agents a ON a.id = an.agent_id
        WHERE 1=1
      `;

            const params = [];
            let idx = 1;

            if (agent_id) {
                sql += ` AND an.agent_id = $${idx++}`;
                params.push(agent_id);
            }

            if (severity) {
                sql += ` AND an.severity = $${idx++}`;
                params.push(severity);
            }

            if (state) {
                sql += ` AND an.state = $${idx++}`;
                params.push(state);
            }

            sql += ` ORDER BY
        CASE an.severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        an.detected_at DESC
        LIMIT $${idx++}
      `;
            params.push(parseInt(limit));

            const result = await pool.query(sql, params);

            // Group by severity for radar visualization
            const bySeverity = {
                critical: result.rows.filter(r => r.severity === 'critical'),
                high: result.rows.filter(r => r.severity === 'high'),
                medium: result.rows.filter(r => r.severity === 'medium'),
                low: result.rows.filter(r => r.severity === 'low')
            };

            res.json({ success: true, anomalies: result.rows, bySeverity });
        } catch (err) {
            console.error('Error getting anomalies:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// MAYBE MACHINE
// ============================================

// Get all pending MAYBE items
router.get('/maybe-machine',
    [
        query('agent_id').optional().isUUID(),
        query('limit').optional().isInt({ min: 1, max: 500 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, limit = 100 } = req.query;

            // Get agents in MAYBE state
            // Sample rows are fixtures, not decisions waiting for a human.
            let agentSql = 'SELECT * FROM hivv_agents WHERE state = \'maybe\' AND is_demo = false';
            const agentParams = [];
            if (agent_id) {
                agentSql += ' AND id = $1';
                agentParams.push(agent_id);
            }
            agentSql += ` ORDER BY last_active_at DESC LIMIT $${agentParams.length + 1}`;
            agentParams.push(parseInt(limit));

            const agentsResult = await pool.query(agentSql, agentParams);

            // Get pending intentions
            let intentSql = `SELECT i.*, a.public_name as agent_name
        FROM hivv_intentions i
        JOIN hivv_agents a ON a.id = i.agent_id
        WHERE i.state = 'maybe' AND i. authorization_state = 'pending' AND i.is_demo = false`;
            const intentParams = [];
            if (agent_id) {
                intentSql += ' AND i.agent_id = $1';
                intentParams.push(agent_id);
            }
            intentSql += ` ORDER BY i.confidence DESC, i.risk_level DESC LIMIT $${intentParams.length + 1}`;
            intentParams.push(parseInt(limit));

            const intentsResult = await pool.query(intentSql, intentParams);

            // Get pending approvals
            let approvalSql = `SELECT p.*, a.public_name as agent_name
        FROM hivv_permissions p
        JOIN hivv_agents a ON a.id = p.agent_id
        WHERE p.state = 'maybe' AND a.is_demo = false`;
            const approvalParams = [];
            if (agent_id) {
                approvalSql += ' AND p.agent_id = $1';
                approvalParams.push(agent_id);
            }
            approvalSql += ` ORDER BY p.risk_level DESC, p.confidence ASC LIMIT $${approvalParams.length + 1}`;
            approvalParams.push(parseInt(limit));

            const approvalsResult = await pool.query(approvalSql, approvalParams);

            // Get unresolved anomalies
            let anomalySql = `SELECT an.*, a.public_name as agent_name
        FROM hivv_anomalies an
        LEFT JOIN hivv_agents a ON a.id = an.agent_id
        WHERE an.state IN ('detected', 'investigating')`;
            const anomalyParams = [];
            if (agent_id) {
                anomalySql += ' AND an.agent_id = $1';
                anomalyParams.push(agent_id);
            }
            anomalySql += ` ORDER BY
        CASE an.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
        LIMIT $${anomalyParams.length + 1}`;
            anomalyParams.push(parseInt(limit));

            const anomaliesResult = await pool.query(anomalySql, anomalyParams);

            res.json({
                success: true,
                summary: {
                    agents_in_maybe: agentsResult.rows.length,
                    pending_intentions: intentsResult.rows.length,
                    pending_approvals: approvalsResult.rows.length,
                    active_anomalies: anomaliesResult.rows.length,
                    total_items: agentsResult.rows.length + intentsResult.rows.length + approvalsResult.rows.length + anomaliesResult.rows.length
                },
                agents: agentsResult.rows,
                intentions: intentsResult.rows,
                approvals: approvalsResult.rows,
                anomalies: anomaliesResult.rows
            });
        } catch (err) {
            console.error('Error getting MAYBE machine:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// UNIVERSE MAP & VISUALIZATIONS
// ============================================

// Get universe map data (nodes and edges)
router.get('/universe-map',
    [
        query('zoom_level').optional().isIn(['earth', 'network', 'organization', 'person', 'agent', 'task', 'action']),
        query('demo').optional().isIn(['exclude', 'only', 'all']),
        query('state').optional().isIn(['yes', 'maybe', 'no', 'all']),
        query('cluster_id').optional().isString(),
        query('limit').optional().isInt({ min: 1, max: 5000 })
    ],
    validate,
    async (req, res) => {
        try {
            const { zoom_level = 'earth', state, cluster_id, demo = 'exclude', limit = 1000 } = req.query;

            // Get nodes (agents)
            // Sample rows are excluded from the live mesh by default: the
            // graph is titled "SYSTEM RELATIONSHIP GRAPH" and a seed row is
            // not a system. ?demo=only shows them; ?demo=all shows both.
            const demoFilter = demo === 'only' ? ' AND is_demo = true'
                : (demo === 'all' ? '' : ' AND is_demo = false');
            let nodeSql = 'SELECT id, agent_type as type, state, public_name as name, model, trust_score, last_active_at, is_demo FROM hivv_agents WHERE COALESCE(privacy_boundary, \'public\') = \'public\'' + demoFilter;
            const nodeParams = [];
            let nodeIdx = 1;

            if (state && state !== 'all') {
                nodeSql += ` AND state = $${nodeIdx++}`;
                nodeParams.push(state);
            }

            nodeSql += ` ORDER BY trust_score DESC LIMIT $${nodeIdx}`;
            nodeParams.push(parseInt(limit));

            const nodesResult = await pool.query(nodeSql, nodeParams);

            // Get edges (relationships)
            let edgeSql = 'SELECT id, source_agent_id, target_agent_id, relationship_type as type, state, weight, last_interaction_at FROM hivv_relationships WHERE 1=1';
            // The edges follow the nodes: a relationship whose ends are
            // sample rows is sample data too.
            if (demo === 'exclude') edgeSql += ' AND source_agent_id IN (SELECT id FROM hivv_agents WHERE is_demo = false) AND target_agent_id IN (SELECT id FROM hivv_agents WHERE is_demo = false)';
            else if (demo === 'only') edgeSql += ' AND (source_agent_id IN (SELECT id FROM hivv_agents WHERE is_demo = true) OR target_agent_id IN (SELECT id FROM hivv_agents WHERE is_demo = true))';
            const edgeParams = [];
            let edgeIdx = 1;

            if (state && state !== 'all') {
                edgeSql += ` AND state = $${edgeIdx++}`;
                edgeParams.push(state);
            }

            edgeSql += ` ORDER BY weight DESC LIMIT $${edgeIdx}`;
            edgeParams.push(parseInt(limit));

            const edgesResult = await pool.query(edgeSql, edgeParams);

            // Get state distribution
            const stateResult = await pool.query('SELECT state, COUNT(*) as count FROM hivv_agents WHERE is_demo = false GROUP BY state');

            res.json({
                success: true,
                nodes: nodesResult.rows,
                edges: edgesResult.rows,
                stateDistribution: stateResult.rows.reduce((acc, row) => {
                    acc[row.state] = parseInt(row.count);
                    return acc;
                }, {}),
                totalAgents: nodesResult.rows.length,
                totalRelationships: edgesResult.rows.length
            });
        } catch (err) {
            console.error('Error getting universe map:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Get timeline data
router.get('/timeline',
    [
        query('time_range').optional().isIn(['1h', '6h', '24h', '7d', '30d', 'all']),
        query('granularity').optional().isIn(['minute', 'hour', 'day']),
        query('limit').optional().isInt({ min: 1, max: 1000 })
    ],
    validate,
    async (req, res) => {
        try {
            const { time_range = '24h', granularity = 'hour', limit = 100 } = req.query;

            const timeRanges = {
                '1h': '1 hour',
                '6h': '6 hours',
                '24h': '24 hours',
                '7d': '7 days',
                '30d': '30 days',
                'all': null
            };

            const bucketInterval = granularity === 'minute' ? '1 minute' :
                granularity === 'hour' ? '1 hour' : '1 day';

            const sql = `
        SELECT
          date_trunc($1, created_at) as bucket,
          event_type,
          state,
          COUNT(*) as count
        FROM hivv_events
        WHERE created_at > NOW() - ($2::interval)
        GROUP BY bucket, event_type, state
        ORDER BY bucket DESC
        LIMIT $3
      `;

            const result = await pool.query(sql, [granularity, timeRanges[time_range] || '24 hours', parseInt(limit)]);

            // Get events by state
            const stateResult = await pool.query(`
        SELECT state, COUNT(*) as count
        FROM hivv_events
        WHERE created_at > NOW() - ($1::interval)
        GROUP BY state
      `, [timeRanges[time_range] || '24 hours']);

            res.json({
                success: true,
                timeline: result.rows,
                stateDistribution: stateResult.rows.reduce((acc, row) => {
                    acc[row.state] = parseInt(row.count);
                    return acc;
                }, {})
            });
        } catch (err) {
            console.error('Error getting timeline:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// MESSAGES (Agent Protocol)
// ============================================

// Send message between agents
router.post('/messages',
    [
        body('message_type').isIn(['REQUEST', 'OFFER', 'ACCEPT', 'DENY', 'DELEGATE', 'ASK', 'REPORT', 'ESCALATE', 'REVOKE', 'AUDIT']),
        body('from_agent_id').isUUID(),
        body('to_agent_id').optional().isUUID(),
        body('to_human').optional().isBoolean(),
        body('payload').optional().isObject()
    ],
    validate,
    async (req, res) => {
        try {
            const { message_type, from_agent_id, to_agent_id, to_human = false, payload = {}, authorization_state = 'yes' } = req.body;

            const result = await pool.query(`
        INSERT INTO hivv_messages (message_type, from_agent_id, to_agent_id, to_human, payload, authorization_state, state)
        VALUES ($1, $2, $3, $4, $5, $6, 'sent')
        RETURNING *
      `, [message_type, from_agent_id, to_agent_id, to_human, JSON.stringify(payload), authorization_state]);

            // Log event
            await pool.query(`
        INSERT INTO hivv_events (event_type, state, agent_id, target_agent_id, description, payload)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
                to_human ? 'communication_sent' : 'delegation_sent',
                authorization_state,
                from_agent_id,
                to_agent_id,
                `${message_type}: ${JSON.stringify(payload).substring(0, 100)}`,
                JSON.stringify(payload)
            ]);

            res.json({ success: true, message: result.rows[0] });
        } catch (err) {
            console.error('Error sending message:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// Get messages for agent
router.get('/messages',
    [
        query('agent_id').isUUID(),
        query('direction').optional().isIn(['sent', 'received', 'all']),
        query('message_type').optional().isString(),
        query('state').optional().isString(),
        query('limit').optional().isInt({ min: 1, max: 500 })
    ],
    validate,
    async (req, res) => {
        try {
            const { agent_id, direction = 'all', message_type, state, limit = 100 } = req.query;

            let sql = `
        SELECT m.*,
          from.public_name as from_name,
          to.public_name as to_name
        FROM hivv_messages m
        LEFT JOIN hivv_agents from ON from.id = m.from_agent_id
        LEFT JOIN hivv_agents to ON to.id = m.to_agent_id
        WHERE 1=1
      `;

            const params = [];
            let idx = 1;

            if (direction === 'sent') {
                sql += ` AND m.from_agent_id = $${idx++}`;
                params.push(agent_id);
            } else if (direction === 'received') {
                sql += ` AND (m.to_agent_id = $${idx++} OR m.to_human = TRUE)`;
                params.push(agent_id);
            } else {
                sql += ` AND (m.from_agent_id = $${idx++} OR m.to_agent_id = $${idx++})`;
                params.push(agent_id, agent_id);
            }

            if (message_type) {
                sql += ` AND m.message_type = $${idx++}`;
                params.push(message_type);
            }

            if (state) {
                sql += ` AND m.state = $${idx++}`;
                params.push(state);
            }

            sql += ` ORDER BY m.sent_at DESC LIMIT $${idx}`;
            params.push(parseInt(limit));

            const result = await pool.query(sql, params);

            res.json({ success: true, messages: result.rows });
        } catch (err) {
            console.error('Error getting messages:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// STATE LENS
// ============================================

// Get current state lens counts
router.get('/state-lens', async (req, res) => {
    try {
        const result = await pool.query(`
      SELECT
        state,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM hivv_agents), 0), 2) as percentage
      FROM hivv_agents
      GROUP BY state
    `);

        const totals = await pool.query(`
      SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE state = 'yes') as yes_count,
        COUNT(*) FILTER (WHERE state = 'maybe') as maybe_count,
        COUNT(*) FILTER (WHERE state = 'no') as no_count
      FROM hivv_agents
    `);

        res.json({
            success: true,
            distribution: result.rows.reduce((acc, row) => {
                acc[row.state] = { count: parseInt(row.count), percentage: parseFloat(row.percentage) };
                return acc;
            }, {}),
            totals: {
                total: parseInt(totals.rows[0].total),
                yes: parseInt(totals.rows[0].yes_count),
                maybe: parseInt(totals.rows[0].maybe_count),
                no: parseInt(totals.rows[0].no_count)
            }
        });
    } catch (err) {
        console.error('Error getting state lens:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ============================================
// SECURITY AUDIT LOG
// ============================================

router.get('/security/audit',
    [
        query('limit').optional().isInt({ min: 1, max: 500 }),
        query('event_type').optional().isString()
    ],
    validate,
    async (req, res) => {
        try {
            const { limit = 100, event_type } = req.query;

            let sql = `
        SELECT * FROM hivv_security_log
        WHERE 1=1
      `;
            const params = [];
            let idx = 1;

            if (event_type) {
                sql += ` AND event_type = $${idx++}`;
                params.push(event_type);
            }

            sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
            params.push(parseInt(limit));

            const result = await pool.query(sql, params);

            const statsResult = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE success = TRUE) as successful_logins,
          COUNT(*) FILTER (WHERE success = FALSE) as failed_logins,
          COUNT(*) FILTER (WHERE event_type = 'dashboard_view') as dashboard_views
        FROM hivv_security_log
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `);

            res.json({
                success: true,
                events: result.rows,
                stats: statsResult.rows[0]
            });
        } catch (err) {
            console.error('Error getting security audit:', err);
            res.status(500).json({ success: false, error: 'Database error' });
        }
    }
);

// ============================================
// LIVE STATS
// ============================================

router.get('/live-stats', async (req, res) => {
    try {
        const agentCounts = await pool.query(`
      SELECT state, COUNT(*) as count FROM hivv_agents GROUP BY state
    `);

        const eventCounts = await pool.query(`
      SELECT COUNT(*) as total FROM hivv_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

        const distribution = {};
        agentCounts.rows.forEach(row => {
            distribution[row.state] = parseInt(row.count);
        });

        res.json({
            success: true,
            agents: {
                total: agentCounts.rows.reduce((sum, r) => sum + parseInt(r.count), 0),
                distribution
            },
            events: {
                last24h: parseInt(eventCounts.rows[0].total)
            }
        });
    } catch (err) {
        console.error('Error getting live stats:', err);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// SSE endpoint for dashboard real-time updates
router.get('/sse', (req, res) => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    res.write(`retry: 3000\ndata: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    const interval = setInterval(() => {
        try {
            res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch (e) {
            clearInterval(interval);
        }
    }, 10000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

module.exports = router;
