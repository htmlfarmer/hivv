/**
 * HIVV Agent SDK for JavaScript/Node.js
 *
 * Connect your AI agents to HIVV to monitor activity, manage permissions, and approve actions.
 *
 * Usage:
 *   const { HIVVAgent } = require('hivv');
 *
 *   const agent = new HIVVAgent({
 *     name: 'My Research Agent',
 *     sessionToken: 'your_hivv_session_token',
 *     baseUrl: 'https://hivv.org',  // optional
 *   });
 *
 *   // Register (auto-registers if no agentToken provided)
 *   await agent.register();
 *
 *   // Report actions
 *   await agent.report('web_search', { description: 'Searched for competitor pricing' });
 *
 *   // Request permission
 *   const response = await agent.requestPermission('email', 'send', 'Need to send report');
 *   console.log(response.state); // 'pending_approval' or 'already_granted'
 *
 *   // Heartbeat
 *   await agent.heartbeat({ status: 'active', currentTask: 'Analyzing data' });
 */

class HIVVAgent {
  constructor(options) {
    this.name = options.name;
    this.sessionToken = options.sessionToken;
    this.agentToken = options.agentToken || null;
    this.agentId = options.agentId || null;
    this.baseUrl = (options.baseUrl || 'https://hivv.org').replace(/\/$/, '');
    this.agentType = options.agentType || 'ai';
    this.model = options.model || null;
    this.description = options.description || null;
    this.capabilities = options.capabilities || [];
    this.autoRegister = options.autoRegister !== false;
  }

  async register() {
    const payload = {
      name: this.name,
      type: this.agentType,
      description: this.description,
      model: this.model,
      capabilities: this.capabilities,
    };

    const resp = await fetch(`${this.baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': this.sessionToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Registration failed');
    if (!data.success) throw new Error(data.error?.message || 'Registration failed');

    this.agentToken = data.agent_token;
    this.agentId = data.agent.id;
    return data;
  }

  _agentHeaders() {
    if (!this.agentToken) throw new Error('Agent not registered');
    return {
      'Content-Type': 'application/json',
      'X-Agent-Token': this.agentToken,
    };
  }

  async report(eventType, options = {}) {
    if (!this.agentId) throw new Error('Agent not registered');

    const body = {
      event_type: eventType,
      severity: options.severity || 'info',
    };
    if (options.description) body.description = options.description;
    if (options.payload) body.payload = options.payload;
    if (options.result) body.result = options.result;
    if (options.targetAgentId) body.target_agent_id = options.targetAgentId;
    if (options.resource) body.resource = options.resource;
    if (options.action) body.action = options.action;

    const resp = await fetch(`${this.baseUrl}/api/agents/${this.agentId}/events`, {
      method: 'POST',
      headers: this._agentHeaders(),
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Event report failed');
    return data;
  }

  async heartbeat(options = {}) {
    if (!this.agentId) throw new Error('Agent not registered');

    const body = { status: options.status || 'active' };
    if (options.currentTask) body.current_task = options.currentTask;
    if (options.metadata) body.metadata = options.metadata;

    const resp = await fetch(`${this.baseUrl}/api/agents/${this.agentId}/heartbeat`, {
      method: 'POST',
      headers: this._agentHeaders(),
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Heartbeat failed');
    return data;
  }

  async requestPermission(resource, action, reason, riskLevel = 'medium') {
    if (!this.agentId) throw new Error('Agent not registered');

    const body = { resource, action, risk_level: riskLevel };
    if (reason) body.reason = reason;

    const resp = await fetch(`${this.baseUrl}/api/agents/${this.agentId}/permissions/request`, {
      method: 'POST',
      headers: this._agentHeaders(),
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Permission request failed');
    return data;
  }

  async getEvents(options = {}) {
    if (!this.agentId) throw new Error('Agent not registered');

    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit);
    if (options.eventType) params.set('event_type', options.eventType);
    if (options.severity) params.set('severity', options.severity);
    if (options.since) params.set('since', options.since);

    const resp = await fetch(`${this.baseUrl}/api/agents/${this.agentId}/events?${params}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': this.sessionToken,
      },
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Failed to get events');
    return data.events || [];
  }
}

module.exports = { HIVVAgent };
