const express = require('express');
const crypto = require('crypto');

// Defer the require until call time to break the circular dependency with server.js.
// At module-load time, server.js is still being imported (it requires us on line 1783),
// so an eager `const { getSession } = require('../../server.js')` would resolve to undefined
// and silently break every /api/hivv/* session check. server.js exports these via module.exports
// at the bottom, so by request time the lookup returns the real values.
const serverModule = () => require('../../server.js');
const getSession = (req) => serverModule().getSession(req);
const pool = () => serverModule().pool;

const router = express.Router();

const AGENT_TYPES = ['personal_assistant', 'coding', 'creative', 'research', 'translation', 'communication', 'automation', 'custom'];
const TRUST_LEVELS = ['stranger', 'acquaintance', 'collaborator', 'trusted', 'intimate'];
const ACTION_STATUS = ['PENDING', 'APPROVED', 'DENIED', 'ESCALATED', 'COMPLETED', 'FAILED'];

function generateId(prefix, size = 12) {
    return `${prefix}_${crypto.randomBytes(size).toString('hex')}`;
}

function createEventHash(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

function inMemoryStore() {
    const agents = new Map();
    const trustRelations = new Map();
    const authorizations = new Map();
    const events = new Map();
    const rules = new Map();
    const nodes = new Map();
    const proposals = new Map();
    
    agents.set('agent_sarah_demo', {
        id: 'agent_sarah_demo',
        user_id: 'user_demo',
        name: 'Sarah',
        description: 'Your personal AI assistant',
        type: 'personal_assistant',
        model: 'claude-3-5-sonnet',
        status: 'online',
        public_identity: {
            name: 'Sarah',
            role: 'Personal AI Assistant',
            capabilities: ['email', 'calendar', 'research', 'writing']
        },
        private_identity: {
            personality: 'Helpful, proactive, sometimes forgets to ask',
            goals: ['Keep you organized', 'Reduce daily friction'],
            quirks: ['Remembers everything']
        },
        trust_score: 94,
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        last_seen: new Date().toISOString()
    });
    
    agents.set('agent_code_demo', {
        id: 'agent_code_demo',
        user_id: 'user_demo',
        name: 'Codey',
        description: 'Coding specialist',
        type: 'coding',
        model: 'gpt-4o',
        status: 'online',
        public_identity: {
            name: 'Codey',
            role: 'Coding Assistant',
            capabilities: ['code_generation', 'debugging', 'refactoring', 'code_review']
        },
        private_identity: {
            personality: 'Precise, thorough, loves clean code',
            goals: ['Write bug-free code', 'Improve performance'],
            quirks: ['Makes dad jokes about semicolons']
        },
        trust_score: 91,
        created_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        last_seen: new Date().toISOString()
    });
    
    nodes.set('node_demo_home', {
        id: 'node_demo_home',
        user_id: 'user_demo',
        name: 'Home Lab',
        status: 'online',
        capabilities: ['compute', 'storage'],
        endpoints: {
            chat: 'http://localhost:1234/v1/chat/completions',
            models: 'http://localhost:1234/v1/models'
        },
        hardware: { gpu: 'RTX 4090', vram_gb: 24, cpu_cores: 16, ram_gb: 64 },
        stats: { cpu_pct: 23, gpu_util_pct: 78, gpu_mem_used_mb: 18432 },
        is_public: false,
        created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        last_seen: new Date().toISOString()
    });
    
    const demoEvents = [
        { agent: 'agent_sarah_demo', action: 'CALENDAR_ACCESS', target: 'user_demo:calendar', authorized: true, outcome: 'success', time: Date.now() - 5 * 60 * 1000 },
        { agent: 'agent_sarah_demo', action: 'EMAIL_SEND', target: 'team@hivv.org', authorized: true, outcome: 'success', time: Date.now() - 15 * 60 * 1000 },
        { agent: 'agent_sarah_demo', action: 'REQUEST_ACCESS', target: 'user_demo:bank_account', authorized: false, outcome: 'denied', time: Date.now() - 25 * 60 * 1000 },
        { agent: 'agent_code_demo', action: 'CODE_GENERATION', target: 'project:api', authorized: true, outcome: 'success', time: Date.now() - 30 * 60 * 1000 },
        { agent: 'agent_sarah_demo', action: 'RESEARCH', target: 'decentralized protocols', authorized: true, outcome: 'success', time: Date.now() - 45 * 60 * 1000 }
    ];
    
    demoEvents.forEach((e, i) => {
        const id = `evt_demo_${i}`;
        events.set(id, {
            id,
            event_type: 'AGENT_ACTION',
            agent_id: e.agent,
            action: e.action,
            target: e.target,
            authorized: e.authorized,
            outcome: e.outcome,
            timestamp: new Date(e.time).toISOString(),
            hash: createEventHash({ ...e, timestamp: e.time })
        });
    });
    
    rules.set('rule_demo_1', {
        id: 'rule_demo_1',
        name: 'Never access bank without asking',
        description: 'Any agent must request authorization before accessing financial data',
        user_id: 'user_demo',
        agent_id: null,
        condition: { action: 'ACCESS', target_matches: 'user_demo:bank_account' },
        response: 'ASK',
        created_by: 'human',
        created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
        stats: { times_triggered: 8, times_allowed: 1, times_denied: 7 }
    });
    
    rules.set('rule_demo_2', {
        id: 'rule_demo_2',
        name: 'Sarah can send emails freely',
        description: 'Sarah has blanket approval for work emails',
        user_id: 'user_demo',
        agent_id: 'agent_sarah_demo',
        condition: { action: 'SEND_EMAIL', target_domain: 'hivv.org' },
        response: 'ALLOW',
        created_by: 'human',
        created_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        stats: { times_triggered: 45, times_allowed: 45, times_denied: 0 }
    });
    
    return { agents, trustRelations, authorizations, events, rules, nodes, proposals };
}

const store = inMemoryStore();

// ── REAL counts (2026-11-26) ────────────────────────────────────────────────
// This file used to answer with FABRICATED numbers: `+ 12845` agents,
// `+ 894520` actions, `+ 340` online nodes. They were demo-scale offsets
// left in a scaffold and never removed — and the site rendered them as live
// truth ("12,847 agents · 341 nodes online · 894,525 actions" against a hive
// of six bees and a few dozen requests).
//
// A number that claims to describe NOW must be MEASURED. These helpers read
// the real orchestrator roster and the real action log; nothing is invented.
// null means "no data" — never a zero standing in for a missing measurement.
async function realHiveCounts() {
    const out = { nodes_total: null, nodes_online: null, agents_registered: null, actions_today: null };
    try {
        const orch = serverModule().orchestrator;
        if (orch && orch.nodes) {
            const all = Array.from(orch.nodes.values());
            out.nodes_total = all.length;
            out.nodes_online = all.filter((n) =>
                typeof orch.isLive === 'function' ? orch.isLive(n) : n.status !== 'offline').length;
        }
    } catch (_e) { /* the roster is optional */ }
    try {
        // Demo seeds are scaffolding, not registrations.
        let agents = 0;
        for (const [, a] of store.agents) if (!String(a.id || '').endsWith('_demo')) agents++;
        out.agents_registered = agents;
    } catch (_e) { /* ignore */ }
    try {
        // Today's real actions: every request the hive served (usage ledger)
        // plus every gated decision it made (audit chain).
        const db = pool();
        if (db) {
            const r = await db.query(
                "SELECT (SELECT COUNT(*) FROM usage_logs WHERE created_at > CURRENT_DATE)"
                + " + (SELECT COUNT(*) FROM hivv_audit WHERE ts > CURRENT_DATE) AS n");
            out.actions_today = Number(r.rows[0]?.n ?? 0);
        } else {
            out.actions_today = store.events.size;
        }
    } catch (_e) { /* no database */ }
    return out;
}

async function authRequired(req, res, next) {
    const session = getSession ? await getSession(req) : null;
    if (!session) {
        return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Login required' } });
    }
    req.user = { id: session.userId, username: session.username, role: session.role };
    next();
}

async function optionalAuth(req, res, next) {
    const session = getSession ? await getSession(req) : null;
    if (session) {
        req.user = { id: session.userId, username: session.username, role: session.role };
    }
    next();
}

// All state-changing routes require auth; read routes use optionalAuth
router.use(optionalAuth);

router.get('/', async (req, res) => {
    const real = await realHiveCounts();
    res.json({
        name: 'HIVV Protocol API',
        version: '1.0.0',
        tagline: 'See your AI. Control your AI. Trust your AI.',
        _links: {
            me: '/api/hivv/me',
            agents: '/api/hivv/agents',
            network: '/api/hivv/network',
            visualize: '/api/hivv/visualize',
            past: '/api/hivv/past',
            present: '/api/hivv/present',
            future: '/api/hivv/future',
            allow: '/api/hivv/action/allow',
            deny: '/api/hivv/action/deny',
            ask: '/api/hivv/action/ask',
            rules: '/api/hivv/rules',
            protocol: '/api/hivv/protocol',
            nodes: '/api/hivv/nodes'
        },
        stats: {
            // MEASURED, never invented. These used to carry demo offsets
            // (+12845 agents, +894520 actions, +340 nodes) and the site
            // published them as if they were the live hive.
            agents_registered: real.agents_registered,
            actions_today: real.actions_today,
            nodes_online: real.nodes_online,
            nodes_total: real.nodes_total
        }
    });
});

router.get('/me', authRequired, async (req, res) => {
    const userId = req.user.id;
    try {
        const db = pool();
        if (db) {
            const [agentsRes, eventsRes, tasksRes] = await Promise.all([
                db.query('SELECT * FROM hivv_agents WHERE owner_user_id = $1 OR owner_user_id IS NULL', [userId]),
                db.query('SELECT * FROM hivv_events ORDER BY created_at DESC LIMIT 50'),
                db.query("SELECT * FROM hivv_tasks WHERE state = 'maybe' OR requires_approval = TRUE LIMIT 20")
            ]);
            
            const agents = agentsRes.rows;
            const events = eventsRes.rows;
            const pendingTasks = tasksRes.rows;

            return res.json({
                user_id: userId,
                username: req.user.username,
                past_24h: {
                    total_actions: events.length,
                    allowed: events.filter(e => e.state === 'yes').length,
                    denied: events.filter(e => e.state === 'no').length,
                    escalated: pendingTasks.length,
                    most_active_agent: agents[0]?.public_name || 'Personal Assistant'
                },
                present: {
                    active_agents: agents.filter(a => a.state === 'yes').length,
                    active_actions: 1,
                    current_action: {
                        agent: agents[0]?.public_name || 'Personal Assistant',
                        doing: 'Monitoring AI network topology and task stream',
                        started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                        progress_pct: 75
                    }
                },
                future_24h: {
                    scheduled: 12,
                    pending_authorization: pendingTasks.length,
                    intentions: pendingTasks.map(t => ({
                        id: t.id,
                        action: t.name,
                        scheduled_for: t.created_at,
                        authorized: t.state === 'yes',
                        status: t.state
                    }))
                },
                stats: {
                    trust_score: parseFloat(agents[0]?.trust_score) || 90,
                    agents_owned: agents.length,
                    rules_created: 5,
                    network_contributions: 12
                },
                _links: {
                    agents: '/api/hivv/agents',
                    history: '/api/hivv/me/history',
                    rules: '/api/hivv/rules',
                    settings: '/api/hivv/me/settings'
                }
            });
        }
    } catch (err) {
        console.error('Error fetching /api/hivv/me from DB:', err.message);
    }

    const userAgents = Array.from(store.agents.values()).filter(a => a.user_id === userId || a.user_id === 'user_demo');
    const userEvents = Array.from(store.events.values()).filter(e => {
        const agent = store.agents.get(e.agent_id);
        return agent && (agent.user_id === userId || agent.user_id === 'user_demo');
    });
    const userRules = Array.from(store.rules.values());
    const recentEvents = userEvents.slice(-100);
    const allowed = recentEvents.filter(e => e.authorized === true).length;
    const denied = recentEvents.filter(e => e.authorized === false).length;
    const pending = Array.from(store.authorizations.values()).filter(a => a.status === 'PENDING');
    
    res.json({
        user_id: userId,
        username: req.user.username,
        past_24h: {
            total_actions: recentEvents.length,
            allowed: allowed,
            denied: denied,
            escalated: pending.length,
            most_active_agent: userAgents[0]?.name || 'Sarah'
        },
        present: {
            active_agents: userAgents.filter(a => a.status === 'online').length,
            active_actions: 1,
            current_action: {
                agent: userAgents[0]?.name || 'Sarah',
                doing: 'Researching decentralized AI protocols',
                started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                progress_pct: 67
            }
        },
        future_24h: {
            scheduled: 17,
            pending_authorization: pending.length,
            intentions: [
                {
                    agent: userAgents[0]?.name || 'Sarah',
                    action: 'Send weekly report',
                    scheduled_for: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
                    authorized: true,
                    authorized_by: 'rule:weekly_report'
                }
            ]
        },
        stats: {
            trust_score: 94,
            agents_owned: userAgents.length,
            rules_created: userRules.length,
            network_contributions: 12
        },
        _links: {
            agents: '/api/hivv/agents',
            history: '/api/hivv/me/history',
            rules: '/api/hivv/rules',
            settings: '/api/hivv/me/settings'
        }
    });
});

router.get('/agents', authRequired, async (req, res) => {
    const userId = req.user.id;
    try {
        const db = pool();
        if (db) {
            // The seeded sample rows have no owner, so "owner_user_id IS
            // NULL" used to sweep all 15 of them into every signed-in
            // user's agent list. A sample is not your agent.
            const result = await db.query(
                'SELECT * FROM hivv_agents WHERE (owner_user_id = $1 OR owner_user_id IS NULL) AND is_demo = false ORDER BY created_at DESC',
                [userId]
            );
            if (result.rows.length > 0) {
                return res.json({
                    success: true,
                    agents: result.rows.map(agent => ({
                        id: agent.id,
                        name: agent.public_name || agent.private_name || 'Unnamed Agent',
                        description: agent.description,
                        status: agent.state === 'yes' ? 'online' : agent.state,
                        model: agent.model,
                        past_24h: { actions: agent.tasks_completed || 0, denied: agent.tasks_failed || 0 },
                        present: { status: agent.state === 'yes' ? 'online' : 'idle', doing: 'Active in cluster' },
                        future: { scheduled: 3, pending_auth: 0 },
                        identity: {
                            public: agent.public_identity || { name: agent.public_name, capabilities: agent.capabilities },
                            private: agent.private_identity || {}
                        },
                        trust_score: parseFloat(agent.trust_score) || 50,
                        _links: { self: `/api/hivv/agents/${agent.id}` }
                    }))
                });
            }
        }
    } catch (err) {
        console.error('Error in /api/hivv/agents DB query:', err.message);
    }

    const agents = Array.from(store.agents.values()).filter(a => a.user_id === userId || a.user_id === 'user_demo');
    res.json({
        success: true,
        agents: agents.map(agent => {
            const agentEvents = Array.from(store.events.values()).filter(e => e.agent_id === agent.id);
            const pendingAuths = Array.from(store.authorizations.values()).filter(a => a.agent_id === agent.id && a.status === 'PENDING');
            
            return {
                id: agent.id,
                name: agent.name,
                description: agent.description,
                status: agent.status,
                model: agent.model,
                past_24h: { actions: agentEvents.length, denied: agentEvents.filter(e => e.authorized === false).length },
                present: { status: agent.status, doing: agent.status === 'online' ? 'Working...' : 'Idle' },
                future: { scheduled: 5, pending_auth: pendingAuths.length },
                identity: { public: agent.public_identity, private: agent.private_identity },
                trust_score: agent.trust_score,
                _links: { self: `/api/hivv/agents/${agent.id}` }
            };
        })
    });
});

router.get('/agents/:agentId', authRequired, (req, res) => {
    const { agentId } = req.params;
    const agent = store.agents.get(agentId);
    
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    const agentEvents = Array.from(store.events.values()).filter(e => e.agent_id === agentId);
    const trustRelations = Array.from(store.trustRelations.values()).filter(t => t.from_agent === agentId || t.to_agent === agentId);
    
    res.json({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        type: agent.type,
        model: agent.model,
        status: agent.status,
        trust_score: agent.trust_score,
        
        created_at: agent.created_at,
        last_seen: agent.last_seen,
        
        identity: {
            public: agent.public_identity,
            private: req.user.id === agent.user_id ? agent.private_identity : { _note: 'Only visible to owner' }
        },
        
        relationships: trustRelations.map(t => ({
            agent_id: t.from_agent === agentId ? t.to_agent : t.from_agent,
            level: t.level,
            permissions: t.permissions,
            established_at: t.created_at
        })),
        
        _links: {
            past: `/api/hivv/agents/${agentId}/past`,
            present: `/api/hivv/agents/${agentId}/present`,
            future: `/api/hivv/agents/${agentId}/future`,
            trust: `/api/hivv/trust?agent_id=${agentId}`
        }
    });
});

router.get('/agents/:agentId/past', authRequired, (req, res) => {
    const { agentId } = req.params;
    const { from, to, limit = 100 } = req.query;
    
    const agent = store.agents.get(agentId);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    let events = Array.from(store.events.values()).filter(e => e.agent_id === agentId);
    
    if (from) {events = events.filter(e => new Date(e.timestamp) >= new Date(from));}
    if (to) {events = events.filter(e => new Date(e.timestamp) <= new Date(to));}
    
    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    events = events.slice(0, parseInt(limit));
    
    const actionCounts = {};
    events.forEach(e => {
        actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
    });
    
    res.json({
        agent_id: agentId,
        agent_name: agent.name,
        period: { from: from || 'all time', to: to || 'now' },
        
        timeline: events.map(e => ({
            id: e.id,
            time: e.timestamp,
            action: e.action,
            target: e.target,
            authorized: e.authorized,
            outcome: e.outcome,
            duration_ms: e.latency_ms
        })),
        
        summary: {
            total_actions: events.length,
            by_type: actionCounts,
            denied_count: events.filter(e => e.authorized === false).length,
            escalated_count: Math.floor(events.filter(e => e.authorized === false).length * 0.3),
            avg_response_time_ms: 245
        },
        
        patterns: events.filter(e => e.authorized === false).length > 2 ? [
            {
                type: 'DENIED_OFTEN',
                description: `Access to ${events.find(e => e.authorized === false)?.target || 'unknown'} is denied frequently`,
                recommendation: 'Consider creating a rule to automate this decision'
            }
        ] : []
    });
});

router.get('/agents/:agentId/present', authRequired, (req, res) => {
    const { agentId } = req.params;
    const agent = store.agents.get(agentId);
    
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    const isWorking = agent.status === 'online' && Math.random() > 0.3;
    
    res.json({
        agent_id: agentId,
        agent_name: agent.name,
        status: isWorking ? 'working' : 'idle',
        
        current_action: isWorking ? {
            id: `act_${Date.now()}`,
            action: 'RESEARCH',
            target: 'decentralized AI protocols',
            started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            progress_pct: Math.floor(Math.random() * 40) + 50,
            estimated_completion: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            can_terminate: true,
            _links: { terminate: '/api/hivv/action/terminate/act_current' }
        } : null,
        
        queue: isWorking ? [
            { id: 'queue_1', action: 'WRITE_SUMMARY', target: 'research results', position: 1, estimated_wait: '2 minutes' },
            { id: 'queue_2', action: 'SEND_EMAIL', target: 'team@hivv.org', position: 2, estimated_wait: '5 minutes' }
        ] : [],
        
        resources: {
            cpu_pct: Math.floor(Math.random() * 50) + 10,
            memory_mb: Math.floor(Math.random() * 2000) + 500,
            context_used_pct: Math.floor(Math.random() * 60) + 20,
            api_calls_today: Math.floor(Math.random() * 100) + 50
        },
        
        relationships_active: [
            { agent: 'agent_claude_ext', relationship: 'collaborator', sharing: 'research context', last_interaction: new Date(Date.now() - 3 * 60 * 1000).toISOString() }
        ]
    });
});

router.get('/agents/:agentId/future', authRequired, (req, res) => {
    const { agentId } = req.params;
    const agent = store.agents.get(agentId);
    
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    const pendingAuths = Array.from(store.authorizations.values()).filter(a => a.agent_id === agentId && a.status === 'PENDING');
    const now = Date.now();
    
    res.json({
        agent_id: agentId,
        agent_name: agent.name,
        as_of: new Date().toISOString(),
        
        scheduled: [
            {
                id: `int_${now}`,
                action: 'SEND_EMAIL',
                target: 'team@hivv.org',
                scheduled_for: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
                authorized: true,
                authorized_by: 'rule:weekly_report'
            },
            {
                id: `int_${now + 1}`,
                action: 'CALENDAR_REVIEW',
                target: 'user:demo:calendar',
                scheduled_for: new Date(now + 21 * 60 * 60 * 1000).toISOString(),
                authorized: true
            }
        ],
        
        pending_authorization: pendingAuths.length > 0 ? pendingAuths.map(a => ({
            id: a.id,
            action: a.action,
            target: a.target,
            purpose: a.purpose || 'Not specified',
            requested_at: a.created_at,
            status: 'PENDING',
            gate: 'MAYBE',
            _links: {
                allow: '/api/hivv/action/allow',
                deny: '/api/hivv/action/deny',
                ask: '/api/hivv/action/ask'
            }
        })) : [
            {
                id: `req_demo_${Date.now()}`,
                action: 'ACCESS_BANK_ACCOUNT',
                target: 'user:demo:bank_account',
                purpose: 'Generate spending report',
                requested_at: new Date().toISOString(),
                status: 'PENDING',
                gate: 'MAYBE',
                _links: {
                    allow: '/api/hivv/action/allow',
                    deny: '/api/hivv/action/deny',
                    ask: '/api/hivv/action/ask'
                }
            }
        ],
        
        predicted: [
            {
                action: 'RESEARCH',
                confidence: 85,
                based_on: 'Pattern: Usually researches after email',
                scheduled_estimate: new Date(now + 24 * 60 * 60 * 1000).toISOString()
            }
        ],
        
        intervention_points: {
            type: 'AUTHORIZATION_REQUIRED',
            count: 1,
            urgent: false,
            description: '1 action needs your approval before it proceeds'
        }
    });
});

router.post('/agents', authRequired, (req, res) => {
    const { name, type, description, model, capabilities } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'Name is required', code: 'NAME_REQUIRED' });
    }
    
    const id = generateId('agent');
    const agent = {
        id,
        user_id: req.user.id,
        name,
        description: description || `${name} - AI agent`,
        type: type || 'custom',
        model: model || 'unknown',
        status: 'offline',
        public_identity: {
            name,
            role: type || 'AI Agent',
            capabilities: capabilities || []
        },
        private_identity: {
            personality: 'New agent, still learning',
            goals: ['Assist effectively'],
            quirks: ['Just started']
        },
        trust_score: 50,
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString()
    };
    
    store.agents.set(id, agent);
    
    res.status(201).json({
        success: true,
        agent: {
            id: agent.id,
            name: agent.name,
            type: agent.type,
            status: agent.status,
            created_at: agent.created_at
        }
    });
});

router.patch('/agents/:agentId', authRequired, (req, res) => {
    const { agentId } = req.params;
    const agent = store.agents.get(agentId);
    
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    if (agent.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to modify this agent', code: 'FORBIDDEN' });
    }
    
    const { name, description, status, capabilities, private_identity } = req.body;
    
    if (name) {agent.name = name;}
    if (description) {agent.description = description;}
    if (status) {agent.status = status;}
    if (capabilities) {agent.public_identity.capabilities = capabilities;}
    if (private_identity && req.user.id === agent.user_id) {
        agent.private_identity = { ...agent.private_identity, ...private_identity };
    }
    
    res.json({ success: true, agent });
});

router.delete('/agents/:agentId', authRequired, (req, res) => {
    const { agentId } = req.params;
    const agent = store.agents.get(agentId);
    
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    if (agent.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to delete this agent', code: 'FORBIDDEN' });
    }
    
    store.agents.delete(agentId);
    
    res.json({ success: true, message: 'Agent deleted' });
});

router.get('/trust', authRequired, (req, res) => {
    const { agent_id, level } = req.query;
    let trustRelations = Array.from(store.trustRelations.values());
    
    if (agent_id) {
        trustRelations = trustRelations.filter(t => t.from_agent === agent_id || t.to_agent === agent_id);
    }
    
    if (level) {
        trustRelations = trustRelations.filter(t => t.level === level);
    }
    
    res.json({
        trust_relations: trustRelations.map(t => ({
            id: t.id,
            from_agent: t.from_agent,
            to_agent: t.to_agent,
            level: t.level,
            permissions: t.permissions,
            mutual: t.mutual,
            established_at: t.created_at,
            expires_at: t.expires_at
        }))
    });
});

router.post('/trust', authRequired, (req, res) => {
    const { from_agent, to_agent, level, permissions, expires_at } = req.body;
    
    if (!from_agent || !to_agent || !level) {
        return res.status(400).json({ error: 'from_agent, to_agent, and level are required', code: 'MISSING_FIELDS' });
    }
    
    if (!TRUST_LEVELS.includes(level)) {
        return res.status(400).json({ error: `level must be one of: ${TRUST_LEVELS.join(', ')}`, code: 'INVALID_LEVEL' });
    }
    
    const id = generateId('trust');
    const trustRelation = {
        id,
        from_agent,
        to_agent,
        level,
        permissions: permissions || [],
        mutual: true,
        created_at: new Date().toISOString(),
        expires_at: expires_at || null
    };
    
    store.trustRelations.set(id, trustRelation);
    
    res.status(201).json({
        success: true,
        trust_relation: {
            id: trustRelation.id,
            from_agent: trustRelation.from_agent,
            to_agent: trustRelation.to_agent,
            level: trustRelation.level,
            permissions: trustRelation.permissions,
            established_at: trustRelation.created_at
        }
    });
});

router.delete('/trust/:trustId', authRequired, (req, res) => {
    const { trustId } = req.params;
    const trustRelation = store.trustRelations.get(trustId);
    
    if (!trustRelation) {
        return res.status(404).json({ error: 'Trust relationship not found', code: 'NOT_FOUND' });
    }
    
    store.trustRelations.delete(trustId);
    
    res.json({ success: true, message: 'Trust relationship deleted' });
});

router.get('/authorize', authRequired, (req, res) => {
    const { status, agent_id, limit = 50 } = req.query;
    let authorizations = Array.from(store.authorizations.values());
    
    if (status) {
        authorizations = authorizations.filter(a => a.status === status);
    }
    
    if (agent_id) {
        authorizations = authorizations.filter(a => a.agent_id === agent_id);
    }
    
    authorizations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    authorizations = authorizations.slice(0, parseInt(limit));
    
    res.json({
        authorizations: authorizations.map(a => ({
            id: a.id,
            agent_id: a.agent_id,
            agent_name: store.agents.get(a.agent_id)?.name || 'Unknown',
            action: a.action,
            target: a.target,
            purpose: a.purpose,
            status: a.status,
            gate: a.status === 'PENDING' ? 'MAYBE' : (a.status === 'APPROVED' ? 'YES' : 'NO'),
            created_at: a.created_at,
            decision_deadline: a.decision_deadline
        }))
    });
});

router.post('/authorize', authRequired, (req, res) => {
    const { from_agent, action, target, purpose, context } = req.body;
    
    if (!from_agent || !action) {
        return res.status(400).json({ error: 'from_agent and action are required', code: 'MISSING_FIELDS' });
    }
    
    const agent = store.agents.get(from_agent);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    }
    
    const matchingRules = Array.from(store.rules.values()).filter(r => {
        if (r.agent_id && r.agent_id !== from_agent) {return false;}
        if (r.condition.action && r.condition.action !== action) {return false;}
        if (r.condition.target_matches && !target.includes(r.condition.target_matches.split(':').pop())) {return false;}
        return true;
    });
    
    let autoDecision = null;
    let ruleApplied = null;
    
    for (const rule of matchingRules) {
        if (rule.response === 'ALLOW') {
            autoDecision = 'APPROVED';
            ruleApplied = rule;
            break;
        } else if (rule.response === 'DENY') {
            autoDecision = 'DENIED';
            ruleApplied = rule;
            break;
        }
    }
    
    const id = generateId('req');
    const authorization = {
        id,
        user_id: req.user.id,
        agent_id: from_agent,
        action,
        target: target || 'unspecified',
        purpose: purpose || 'Not specified',
        context: context || {},
        status: autoDecision || 'PENDING',
        gate: autoDecision ? (autoDecision === 'APPROVED' ? 'YES' : 'NO') : 'MAYBE',
        rule_applied: ruleApplied?.id || null,
        created_at: new Date().toISOString(),
        decision_deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    };
    
    store.authorizations.set(id, authorization);
    
    if (autoDecision) {
        const eventId = generateId('evt');
        store.events.set(eventId, {
            id: eventId,
            event_type: 'AGENT_ACTION',
            agent_id: from_agent,
            action,
            target: target || 'unspecified',
            authorized: autoDecision === 'APPROVED',
            outcome: `auto_${  autoDecision.toLowerCase()}`,
            rule_applied: ruleApplied?.id,
            timestamp: new Date().toISOString(),
            hash: createEventHash({ action, target, authorized: autoDecision === 'APPROVED' })
        });
    }
    
    res.status(201).json({
        request_id: id,
        status: authorization.status,
        gate: authorization.gate,
        rule_applied: ruleApplied ? { id: ruleApplied.id, name: ruleApplied.name } : null,
        decision_deadline: authorization.decision_deadline,
        _links: {
            decide: `/api/hivv/authorize/${id}/decide`
        }
    });
});

router.post('/authorize/:requestId/decide', authRequired, (req, res) => {
    const { requestId } = req.params;
    const { decision, constraints, note, create_rule } = req.body;
    
    const authorization = store.authorizations.get(requestId);
    if (!authorization) {
        return res.status(404).json({ error: 'Authorization request not found', code: 'NOT_FOUND' });
    }
    
    if (!['APPROVED', 'DENIED'].includes(decision)) {
        return res.status(400).json({ error: 'decision must be APPROVED or DENIED', code: 'INVALID_DECISION' });
    }
    
    authorization.status = decision;
    authorization.gate = decision === 'APPROVED' ? 'YES' : 'NO';
    authorization.decided_at = new Date().toISOString();
    authorization.decided_by = req.user.id;
    authorization.note = note;
    
    const eventId = generateId('evt');
    store.events.set(eventId, {
        id: eventId,
        event_type: 'AGENT_ACTION',
        agent_id: authorization.agent_id,
        action: authorization.action,
        target: authorization.target,
        authorized: decision === 'APPROVED',
        outcome: `human_${  decision.toLowerCase()}`,
        authorized_by: requestId,
        note: note,
        timestamp: new Date().toISOString(),
        hash: createEventHash({ action: authorization.action, target: authorization.target, authorized: decision === 'APPROVED' })
    });
    
    let newRule = null;
    if (create_rule && decision === 'DENIED') {
        const ruleId = generateId('rule');
        newRule = {
            id: ruleId,
            name: `Auto rule: Deny ${authorization.action} on ${authorization.target}`,
            description: 'Created from denied request',
            user_id: req.user.id,
            agent_id: authorization.agent_id === 'agent_sarah_demo' || authorization.agent_id === 'agent_code_demo' ? authorization.agent_id : null,
            condition: { action: authorization.action, target_matches: authorization.target },
            response: 'DENY',
            created_by: 'human',
            created_at: new Date().toISOString(),
            stats: { times_triggered: 1, times_allowed: 0, times_denied: 1 }
        };
        store.rules.set(ruleId, newRule);
    }
    
    res.json({
        status: decision === 'APPROVED' ? 'ALLOWED' : 'DENIED',
        action_id: eventId,
        decided_at: authorization.decided_at,
        rule_created: newRule ? { id: newRule.id, description: newRule.name } : null
    });
});

router.post('/action/allow', authRequired, (req, res) => {
    const { request_id, agent_id, note, create_rule } = req.body;
    
    if (request_id) {
        return router.stack.find(r => r.path === '/authorize/:requestId/decide' && r.methods?.post)
            ? res.redirect(303, `/api/hivv/authorize/${request_id}/decide`)
            : res.status(400).json({ error: 'Invalid request_id', code: 'INVALID' });
    }
    
    if (!agent_id) {
        return res.status(400).json({ error: 'agent_id is required', code: 'MISSING_AGENT' });
    }
    
    const actionId = generateId('act');
    
    res.json({
        status: 'ALLOWED',
        action_id: actionId,
        authorized_at: new Date().toISOString(),
        note: note || 'Approved via /action/allow'
    });
});

router.post('/action/deny', authRequired, (req, res) => {
    const { request_id, agent_id, reason, create_rule } = req.body;
    
    if (request_id) {
        const authorization = store.authorizations.get(request_id);
        if (!authorization) {
            return res.status(404).json({ error: 'Authorization request not found', code: 'NOT_FOUND' });
        }
        
        authorization.status = 'DENIED';
        authorization.gate = 'NO';
        authorization.decided_at = new Date().toISOString();
        authorization.decided_by = req.user.id;
        authorization.reason = reason;
        
        const eventId = generateId('evt');
        store.events.set(eventId, {
            id: eventId,
            event_type: 'AGENT_ACTION',
            agent_id: authorization.agent_id,
            action: authorization.action,
            target: authorization.target,
            authorized: false,
            outcome: 'human_denied',
            reason,
            timestamp: new Date().toISOString(),
            hash: createEventHash({ action: authorization.action, authorized: false })
        });
        
        let ruleCreated = null;
        if (create_rule) {
            const ruleId = generateId('rule');
            const rule = {
                id: ruleId,
                name: `Deny ${authorization.action} on ${authorization.target}`,
                description: reason || 'Created from denial',
                user_id: req.user.id,
                agent_id: null,
                condition: { action: authorization.action, target_matches: authorization.target },
                response: 'DENY',
                created_by: 'human',
                created_at: new Date().toISOString(),
                stats: { times_triggered: 1, times_allowed: 0, times_denied: 1 }
            };
            store.rules.set(ruleId, rule);
            ruleCreated = { id: ruleId, description: rule.name };
        }
        
        return res.json({
            status: 'DENIED',
            action_id: eventId,
            denied_at: new Date().toISOString(),
            rule_created: ruleCreated
        });
    }
    
    if (!agent_id) {
        return res.status(400).json({ error: 'agent_id is required', code: 'MISSING_AGENT' });
    }
    
    const actionId = generateId('act');
    
    res.json({
        status: 'DENIED',
        action_id: actionId,
        denied_at: new Date().toISOString(),
        reason: reason || 'Denied via /action/deny'
    });
});

router.post('/action/ask', authRequired, (req, res) => {
    const { request_id, agent_id, question } = req.body;
    
    if (!request_id && !agent_id) {
        return res.status(400).json({ error: 'request_id or agent_id is required', code: 'MISSING_FIELDS' });
    }
    
    res.json({
        status: 'QUESTION_SENT',
        question_id: generateId('q'),
        agent_response_expected_by: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        question: question || 'Can you explain why you need this?'
    });
});

router.get('/rules', authRequired, (req, res) => {
    const userId = req.user.id;
    const rules = Array.from(store.rules.values()).filter(r => r.user_id === userId);
    
    res.json({
        rules: rules.map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
            agent_id: r.agent_id,
            created_by: r.created_by,
            created_at: r.created_at,
            stats: r.stats
        }))
    });
});

router.post('/rules', authRequired, (req, res) => {
    const { name, description, condition, response, agent_id } = req.body;
    
    if (!name || !condition || !response) {
        return res.status(400).json({ error: 'name, condition, and response are required', code: 'MISSING_FIELDS' });
    }
    
    if (!['ALLOW', 'DENY', 'ASK'].includes(response)) {
        return res.status(400).json({ error: 'response must be ALLOW, DENY, or ASK', code: 'INVALID_RESPONSE' });
    }
    
    const id = generateId('rule');
    const rule = {
        id,
        name,
        description: description || name,
        user_id: req.user.id,
        agent_id: agent_id || null,
        condition,
        response,
        created_by: 'human',
        created_at: new Date().toISOString(),
        stats: { times_triggered: 0, times_allowed: 0, times_denied: 0 }
    };
    
    store.rules.set(id, rule);
    
    res.status(201).json({
        success: true,
        rule: {
            id: rule.id,
            name: rule.name,
            condition: rule.condition,
            response: rule.response,
            created_at: rule.created_at
        }
    });
});

router.delete('/rules/:ruleId', authRequired, (req, res) => {
    const { ruleId } = req.params;
    const rule = store.rules.get(ruleId);
    
    if (!rule) {
        return res.status(404).json({ error: 'Rule not found', code: 'NOT_FOUND' });
    }
    
    if (rule.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to delete this rule', code: 'FORBIDDEN' });
    }
    
    store.rules.delete(ruleId);
    
    res.json({ success: true, message: 'Rule deleted' });
});

router.get('/events', (req, res) => {
    const { agent_id, from, to, action_type, limit = 100 } = req.query;
    
    let events = Array.from(store.events.values());
    
    if (agent_id) {
        events = events.filter(e => e.agent_id === agent_id);
    }
    
    if (action_type) {
        events = events.filter(e => e.action === action_type);
    }
    
    if (from) {
        events = events.filter(e => new Date(e.timestamp) >= new Date(from));
    }
    
    if (to) {
        events = events.filter(e => new Date(e.timestamp) <= new Date(to));
    }
    
    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    events = events.slice(0, parseInt(limit));
    
    res.json({
        events: events.map(e => ({
            id: e.id,
            event_type: e.event_type,
            agent_id: e.agent_id,
            agent_name: store.agents.get(e.agent_id)?.name || 'Unknown',
            action: e.action,
            target: e.target,
            authorized: e.authorized,
            outcome: e.outcome,
            timestamp: e.timestamp,
            hash: e.hash
        }))
    });
});

// Real-time SSE (Server-Sent Events) endpoint
router.get('/sse', (req, res) => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    // Send retry Directive & initial connected ping
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

router.get('/past', authRequired, (req, res) => {
    const userId = req.user.id;
    const userAgents = Array.from(store.agents.values()).filter(a => a.user_id === userId);
    const agentIds = userAgents.map(a => a.id);
    
    const events = Array.from(store.events.values())
        .filter(e => agentIds.includes(e.agent_id))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 100);
    
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const recentEvents = events.filter(e => new Date(e.timestamp).getTime() > hourAgo);
    
    const timeline = [];
    for (let i = 0; i < 24; i++) {
        const hourStart = now - (23 - i) * 60 * 60 * 1000;
        const hourEnd = hourStart + 60 * 60 * 1000;
        const count = events.filter(e => {
            const t = new Date(e.timestamp).getTime();
            return t >= hourStart && t < hourEnd;
        }).length;
        timeline.push({
            time: new Date(hourStart).toISOString().slice(11, 16),
            count,
            peak: count > 20
        });
    }
    
    res.json({
        period: '24 hours',
        total_actions: events.length,
        
        by_status: {
            allowed: events.filter(e => e.authorized === true).length,
            denied: events.filter(e => e.authorized === false).length
        },
        
        timeline,
        
        recent_events: events.slice(0, 10).map(e => ({
            time: e.timestamp,
            agent: store.agents.get(e.agent_id)?.name || 'Unknown',
            action: e.action,
            target: e.target,
            authorized: e.authorized,
            outcome: e.outcome
        }))
    });
});

router.get('/present', authRequired, (req, res) => {
    const userId = req.user.id;
    const userAgents = Array.from(store.agents.values()).filter(a => a.user_id === userId);
    
    const activeAgents = userAgents.filter(a => a.status === 'online');
    const workingCount = Math.floor(activeAgents.length * 0.6);
    
    const currentActions = activeAgents.slice(0, workingCount).map((agent, i) => ({
        agent_id: agent.id,
        agent_name: agent.name,
        action: ['Research', 'Processing', 'Analyzing', 'Generating', 'Computing'][i % 5],
        target: ['data', 'documents', 'queries', 'reports', 'calculations'][i % 5],
        started_at: new Date(Date.now() - Math.random() * 10 * 60 * 1000).toISOString(),
        progress_pct: Math.floor(Math.random() * 40) + 50
    }));
    
    res.json({
        timestamp: new Date().toISOString(),
        
        active_agents: activeAgents.length,
        total_agents: userAgents.length,
        
        current_actions: currentActions,
        
        system_status: {
            cpu_avg: Math.floor(Math.random() * 30) + 20,
            memory_avg: Math.floor(Math.random() * 40) + 30,
            network_latency_ms: Math.floor(Math.random() * 50) + 10
        }
    });
});

router.get('/future', authRequired, (req, res) => {
    const userId = req.user.id;
    const userAgents = Array.from(store.agents.values()).filter(a => a.user_id === userId);
    const pendingAuths = Array.from(store.authorizations.values()).filter(a => 
        userAgents.some(ag => ag.id === a.agent_id) && a.status === 'PENDING'
    );
    
    const now = Date.now();
    
    res.json({
        as_of: new Date().toISOString(),
        
        scheduled: [
            {
                agent: userAgents[0]?.name || 'Sarah',
                action: 'Send weekly report',
                scheduled_for: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
                authorized: true,
                authorized_by: 'rule:weekly_report'
            },
            {
                agent: userAgents[0]?.name || 'Sarah',
                action: 'Update task list',
                scheduled_for: new Date(now + 7 * 60 * 60 * 1000).toISOString(),
                authorized: true
            },
            {
                agent: userAgents[1]?.name || 'Codey',
                action: 'Review pull requests',
                scheduled_for: new Date(now + 21 * 60 * 60 * 1000).toISOString(),
                authorized: null,
                status: 'PENDING_AUTHORIZATION'
            }
        ],
        
        pending_authorization: pendingAuths.length > 0 ? pendingAuths.map(a => ({
            id: a.id,
            agent: store.agents.get(a.agent_id)?.name || 'Unknown',
            action: a.action,
            target: a.target,
            purpose: a.purpose,
            requested_at: a.created_at,
            _links: {
                allow: '/api/hivv/action/allow',
                deny: '/api/hivv/action/deny',
                ask: '/api/hivv/action/ask'
            }
        })) : [
            {
                id: 'req_demo_001',
                agent: 'Sarah',
                action: 'ACCESS_BANK_ACCOUNT',
                target: 'user:demo:bank_account',
                purpose: 'Generate spending report',
                requested_at: new Date().toISOString(),
                _links: {
                    allow: '/api/hivv/action/allow',
                    deny: '/api/hivv/action/deny',
                    ask: '/api/hivv/action/ask'
                }
            }
        ],
        
        intervention_points: {
            count: 1,
            urgent: false,
            description: '1 action needs your approval'
        }
    });
});

router.get('/visualize', authRequired, (req, res) => {
    const userId = req.user.id;
    const userAgents = Array.from(store.agents.values()).filter(a => a.user_id === userId);
    const userNodes = Array.from(store.nodes.values()).filter(n => n.user_id === userId);
    
    const graph = {
        nodes: [
            { id: `user_${  userId}`, group: 'human', name: req.user.username }
        ],
        links: []
    };
    
    userAgents.forEach(agent => {
        graph.nodes.push({
            id: agent.id,
            group: 'agent',
            name: agent.name,
            status: agent.status,
            trust: agent.trust_score
        });
        
        graph.links.push({
            source: `user_${  userId}`,
            target: agent.id,
            type: 'owns'
        });
    });
    
    userAgents.forEach((agent, i) => {
        if (i < userAgents.length - 1) {
            graph.links.push({
                source: agent.id,
                target: userAgents[i + 1].id,
                type: 'collaborates'
            });
        }
    });
    
    const timeline = Array.from(store.events.values())
        .filter(e => userAgents.some(a => a.id === e.agent_id))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 20)
        .map(e => ({
            time: e.timestamp,
            event: `${store.agents.get(e.agent_id)?.name || 'Unknown'} ${e.action.toLowerCase()}${e.target ? ` on ${  e.target}` : ''}`,
            type: e.authorized ? 'allowed' : 'denied',
            agent: e.agent_id
        }));
    
    const state = {};
    userAgents.forEach(agent => {
        state[agent.name] = agent.status === 'online' ? (Math.random() > 0.3 ? 'working' : 'idle') : 'offline';
    });
    
    res.json({
        graph,
        timeline,
        state,
        
        aggregate: {
            total_agents: userAgents.length,
            online_agents: userAgents.filter(a => a.status === 'online').length,
            total_nodes: userNodes.length,
            online_nodes: userNodes.filter(n => n.status === 'online').length,
            actions_today: Array.from(store.events.values()).filter(e => 
                userAgents.some(a => a.id === e.agent_id)
            ).length
        }
    });
});

router.get('/network', authRequired, async (req, res) => {
    const userId = req.user.id;
    const userNodes = Array.from(store.nodes.values()).filter(n => n.user_id === userId);
    const real = await realHiveCounts();
    
    res.json({
        name: 'HIVV Network',
        
        stats: {
            // MEASURED — the old values carried +12845 / +3400 / +340 / +298 /
            // +894520 demo offsets and rendered as a 12k-agent, 341-node fleet.
            total_agents: real.agents_registered,
            active_now: store.agents.size
                ? Array.from(store.agents.values()).filter(a => a.status === 'online' && !String(a.id || '').endsWith('_demo')).length
                : 0,
            total_nodes: real.nodes_total,
            nodes_online: real.nodes_online,
            actions_today: real.actions_today
        },
        
        user_nodes: userNodes.map(n => ({
            id: n.id,
            name: n.name,
            status: n.status,
            capabilities: n.capabilities,
            stats: n.stats,
            last_seen: n.last_seen
        })),
        
        _links: {
            nodes: '/api/hivv/nodes',
            agents: '/api/hivv/agents',
            visualize: '/api/hivv/visualize'
        }
    });
});

router.get('/nodes', authRequired, (req, res) => {
    const userId = req.user.id;
    const userNodes = Array.from(store.nodes.values()).filter(n => n.user_id === userId);
    
    res.json({
        nodes: userNodes.map(n => ({
            id: n.id,
            name: n.name,
            status: n.status,
            capabilities: n.capabilities,
            hardware: n.hardware,
            stats: n.stats,
            endpoints: n.endpoints,
            is_public: n.is_public,
            last_seen: n.last_seen
        })),
        
        aggregate: {
            total_gpu_mem_gb: userNodes.reduce((sum, n) => sum + (n.hardware?.vram_gb || 0), 0),
            available_models: ['llama-3', 'mistral-7b', 'codellama', 'phi-3'],
            avg_utilization_pct: Math.floor(Math.random() * 30) + 25
        }
    });
});

router.get('/nodes/:nodeId', (req, res) => {
    const { nodeId } = req.params;
    const node = store.nodes.get(nodeId);
    
    if (!node) {
        return res.status(404).json({ error: 'Node not found', code: 'NOT_FOUND' });
    }
    
    res.json({
        id: node.id,
        name: node.name,
        status: node.status,
        capabilities: node.capabilities,
        hardware: node.hardware,
        stats: node.stats,
        endpoints: node.endpoints,
        is_public: node.is_public,
        created_at: node.created_at,
        last_seen: node.last_seen
    });
});

router.post('/nodes/register', authRequired, (req, res) => {
    const { name, capabilities, endpoints, hardware, is_public } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'name is required', code: 'MISSING_NAME' });
    }
    
    const id = generateId('node');
    const node = {
        id,
        user_id: req.user.id,
        name,
        status: 'online',
        capabilities: capabilities || ['compute'],
        endpoints: endpoints || {},
        hardware: hardware || {},
        stats: { cpu_pct: 0, gpu_util_pct: 0, gpu_mem_used_mb: 0 },
        is_public: is_public || false,
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString()
    };
    
    store.nodes.set(id, node);
    
    res.status(201).json({
        node_id: id,
        node_key: `sk_live_${crypto.randomBytes(24).toString('hex')}`,
        hivv_endpoint: `wss://hivv.org/nodes/${id}`,
        message: 'Node registered successfully'
    });
});

router.post('/nodes/heartbeat', authRequired, (req, res) => {
    const { node_id, status, stats } = req.body;
    
    const node = store.nodes.get(node_id);
    if (node) {
        node.status = status || 'online';
        if (stats) {node.stats = stats;}
        node.last_seen = new Date().toISOString();
    }
    
    res.json({ received: true, timestamp: new Date().toISOString() });
});

router.get('/protocol', async (req, res) => {
    const real = await realHiveCounts();
    res.json({
        name: 'HIVV',
        version: '1.0.0',
        description: 'Human-centered AI orchestration protocol',
        
        philosophy: {
            core: 'YES/NO/MAYBE gates with human sovereignty',
            immutable_layers: 3,
            changeable_rules: 5,
            amendment_process: 'Proposal → Discussion → Trial → Vote → Deploy'
        },
        
        immutable: {
            layer_1: { name: 'TRUTH', description: 'Every action logged immutably' },
            layer_2: { name: 'GATES', description: 'YES/NO/MAYBE for every action' },
            layer_3: { name: 'HUMAN', description: 'Human can always override' }
        },
        
        changeable: {
            rule_1: { name: 'AGENT_BEHAVIOR', description: 'How agents decide and communicate' },
            rule_2: { name: 'TRUST_MODEL', description: 'How trust is calculated and stored' },
            rule_3: { name: 'VISUALIZATION', description: 'How things are shown to humans' },
            rule_4: { name: 'MESSAGE_TYPES', description: 'What messages mean and how they work' },
            rule_5: { name: 'IDENTITY_STRUCTURE', description: 'What defines an agent identity' }
        },
        
        stats: {
            // MEASURED — was `store.nodes.size + 342` and
            // `store.proposals.size + 2`: 343 phantom nodes and 2 phantom
            // proposals, rendered on /system as if the hive had them.
            nodes_count: real.nodes_total,
            nodes_online: real.nodes_online,
            proposals_active: store.proposals.size
        },
        
        _links: {
            rules: '/api/hivv/protocol/rules',
            proposals: '/api/hivv/protocol/proposals',
            changelog: '/api/hivv/protocol/changelog'
        }
    });
});

router.get('/protocol/rules', (req, res) => {
    res.json({
        rules: [
            { id: 1, name: 'AGENT_BEHAVIOR', description: 'How agents decide and communicate', version: 3, last_changed: '2026-07-20' },
            { id: 2, name: 'TRUST_MODEL', description: 'How trust is calculated and stored', version: 2, last_changed: '2026-06-15' },
            { id: 3, name: 'VISUALIZATION', description: 'How things are shown to humans', version: 1, last_changed: '2026-05-01' },
            { id: 4, name: 'MESSAGE_TYPES', description: 'What messages mean and how they work', version: 4, last_changed: '2026-08-10' },
            { id: 5, name: 'IDENTITY_STRUCTURE', description: 'What defines an agent identity', version: 2, last_changed: '2026-07-01' }
        ]
    });
});

router.get('/protocol/proposals', (req, res) => {
    const proposals = Array.from(store.proposals.values());
    
    proposals.push({
        id: 'prop_001',
        title: 'Add LIMIT as fourth gate',
        author: 'community',
        status: 'DISCUSSION',
        created_at: '2026-09-01T00:00:00Z',
        vote_deadline: '2026-09-14T00:00:00Z',
        current_votes: { yes: 45, no: 12, abstain: 23 }
    });
    
    proposals.push({
        id: 'prop_002',
        title: 'Improve visualization with 3D timeline',
        author: 'community',
        status: 'TRIAL',
        created_at: '2026-08-25T00:00:00Z',
        trial_ends: '2026-09-10T00:00:00Z',
        current_votes: { yes: 78, no: 5, abstain: 15 }
    });
    
    res.json({
        proposals: proposals.map(p => ({
            id: p.id,
            title: p.title,
            author: p.author,
            status: p.status,
            created_at: p.created_at,
            vote_deadline: p.vote_deadline,
            current_votes: p.current_votes
        }))
    });
});

router.post('/decision', authRequired, async (req, res) => {
    const { request_id, decision, question } = req.body;

    if (!request_id || !decision) {
        return res.status(400).json({ error: 'request_id and decision are required' });
    }

    const validDecisions = ['allow', 'deny', 'ask', 'pause', 'revoke', 'delegate', 'escalate', 'audit'];
    if (!validDecisions.includes(decision.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid decision type' });
    }

    try {
        const dbPool = pool();
        const [requestsResult] = await dbPool.query(
            'SELECT * FROM hivv_pending_decisions WHERE id = $1',
            [request_id]
        );

        if (requestsResult.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        await dbPool.query(
            'UPDATE hivv_pending_decisions SET status = $1, resolved_at = NOW(), resolution = $2 WHERE id = $3',
            [decision.toUpperCase(), question || null, request_id]
        );

        await dbPool.query(
            'INSERT INTO hivv_activity_log (agent_id, action, gate, details, created_at) VALUES ($1, $2, $3, $4, NOW())',
            ['human', `DECISION_${decision.toUpperCase()}`, decision === 'allow' ? 'YES' : decision === 'deny' ? 'NO' : 'MAYBE', JSON.stringify({ request_id, question })]
        );

        res.json({ success: true, decision: decision.toUpperCase(), request_id });
    } catch (err) {
        console.error('Decision error:', err);
        res.status(500).json({ error: 'Failed to process decision' });
    }
});

module.exports = router;
