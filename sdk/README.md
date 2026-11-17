# HIVV Agent SDK

Connect your AI agents to HIVV to monitor activity, manage permissions, and approve actions.

## Python

```python
from hivv import HIVVAgent

# Register an agent
agent = HIVVAgent(
    name="My Research Agent",
    session_token="your_hivv_session_token",
    model="gpt-4o",
    capabilities=["web_search", "data_analysis"]
)

# Report an action
agent.report("web_search", description="Searched for competitor pricing")

# Request permission
response = agent.request_permission("email", "send", reason="Need to send report")
print(response["state"])  # "pending_approval"

# Heartbeat
agent.heartbeat(status="active", current_task="Analyzing data")
```

## JavaScript / Node.js

```javascript
const { HIVVAgent } = require('hivv');

const agent = new HIVVAgent({
  name: 'My Research Agent',
  sessionToken: 'your_hivv_session_token',
  model: 'gpt-4o',
  capabilities: ['web_search', 'data_analysis'],
});

// Register (auto-registers on first use)
await agent.register();

// Report an action
await agent.report('web_search', { description: 'Searched for competitor pricing' });

// Request permission
const response = await agent.requestPermission('email', 'send', 'Need to send report');
console.log(response.state); // 'pending_approval'

// Heartbeat
await agent.heartbeat({ status: 'active', currentTask: 'Analyzing data' });
```

## API Reference

### Authentication

All SDK methods require a `session_token` (for registration and user-level operations) and an `agent_token` (for agent-level operations like reporting events).

Get your session token by logging in:
```bash
curl -X POST https://hivv.org/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"yourname","password":"yourpass"}'
```

### Methods

| Method | Description | Auth |
|--------|-------------|------|
| `register()` | Register a new agent, get agent_token | session_token |
| `report(eventType, options)` | Report an action/event | agent_token |
| `heartbeat(options)` | Send agent heartbeat | agent_token |
| `requestPermission(resource, action, reason)` | Request permission for an action | agent_token |
| `getEvents(options)` | Get agent events | session_token |

### Event Types

- `web_search` - Agent performed a web search
- `tool_call` - Agent called an external tool
- `data_access` - Agent accessed data
- `communication` - Agent communicated with another agent
- `decision` - Agent made a decision
- `error` - Agent encountered an error
- `task_start` - Agent started a task
- `task_complete` - Agent completed a task

### Permission Resources

- `email` - Email access
- `calendar` - Calendar access
- `files` - File system access
- `web` - Web access
- `api` - External API access
- `financial` - Financial data access

### Permission Actions

- `read` - Read access
- `write` - Write access
- `send` - Send communications
- `delete` - Delete access
- `execute` - Execute code/commands
