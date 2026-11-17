"""
HIVV Agent SDK for Python

Connect your AI agents to HIVV to monitor activity, manage permissions, and approve actions.

Usage:
    pip install requests  # HIVV SDK only needs requests

    from hivv import HIVVAgent

    agent = HIVVAgent(
        name="My Research Agent",
        session_token="your_hivv_session_token",
        base_url="https://hivv.org"  # optional
    )

    # Report actions
    agent.report("web_search", description="Searched for competitor pricing", result={"count": 42})
    agent.report("tool_call", description="Called data analysis tool", severity="info")

    # Request permission
    response = agent.request_permission("email", "send", reason="Need to send report to client")
    print(response["state"])  # "pending_approval" or "already_granted"

    # Heartbeat
    agent.heartbeat(status="active", current_task="Analyzing data")
"""

import requests
import time
from typing import Optional, Dict, Any, List


class HIVVAgent:
    """Client for connecting AI agents to HIVV."""

    def __init__(
        self,
        name: str,
        session_token: str,
        agent_token: Optional[str] = None,
        agent_id: Optional[str] = None,
        base_url: str = "https://hivv.org",
        agent_type: str = "ai",
        model: Optional[str] = None,
        description: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
        auto_register: bool = True,
    ):
        self.name = name
        self.session_token = session_token
        self.agent_token = agent_token
        self.agent_id = agent_id
        self.base_url = base_url.rstrip("/")
        self.agent_type = agent_type
        self.model = model
        self.description = description
        self.capabilities = capabilities or []
        self._headers = {"Content-Type": "application/json"}

        if auto_register and not agent_token:
            self.register()

    def register(self) -> Dict[str, Any]:
        """Register this agent with HIVV and get an agent token."""
        payload = {
            "name": self.name,
            "type": self.agent_type,
            "description": self.description,
            "model": self.model,
            "capabilities": self.capabilities,
        }
        resp = requests.post(
            f"{self.base_url}/api/agents/register",
            json=payload,
            headers={**self._headers, "X-Session-Token": self.session_token},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get("success"):
            self.agent_token = data["agent_token"]
            self.agent_id = data["agent"]["id"]
            return data
        raise Exception(f"Registration failed: {data}")

    def _agent_headers(self) -> Dict[str, str]:
        """Get headers for agent-authenticated requests."""
        if not self.agent_token:
            raise Exception("Agent not registered. Call register() first or provide agent_token.")
        return {**self._headers, "X-Agent-Token": self.agent_token}

    def report(
        self,
        event_type: str,
        description: Optional[str] = None,
        payload: Optional[Dict[str, Any]] = None,
        result: Optional[Dict[str, Any]] = None,
        severity: str = "info",
        target_agent_id: Optional[str] = None,
        resource: Optional[str] = None,
        action: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Report an event to HIVV."""
        if not self.agent_id:
            raise Exception("Agent not registered.")

        body = {
            "event_type": event_type,
            "severity": severity,
        }
        if description:
            body["description"] = description
        if payload:
            body["payload"] = payload
        if result:
            body["result"] = result
        if target_agent_id:
            body["target_agent_id"] = target_agent_id
        if resource:
            body["resource"] = resource
        if action:
            body["action"] = action

        resp = requests.post(
            f"{self.base_url}/api/agents/{self.agent_id}/events",
            json=body,
            headers=self._agent_headers(),
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()

    def heartbeat(
        self,
        status: str = "active",
        current_task: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Send a heartbeat to HIVV."""
        if not self.agent_id:
            raise Exception("Agent not registered.")

        body = {"status": status}
        if current_task:
            body["current_task"] = current_task
        if metadata:
            body["metadata"] = metadata

        resp = requests.post(
            f"{self.base_url}/api/agents/{self.agent_id}/heartbeat",
            json=body,
            headers=self._agent_headers(),
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()

    def request_permission(
        self,
        resource: str,
        action: str,
        reason: Optional[str] = None,
        risk_level: str = "medium",
    ) -> Dict[str, Any]:
        """Request permission for an action."""
        if not self.agent_id:
            raise Exception("Agent not registered.")

        body = {
            "resource": resource,
            "action": action,
            "risk_level": risk_level,
        }
        if reason:
            body["reason"] = reason

        resp = requests.post(
            f"{self.base_url}/api/agents/{self.agent_id}/permissions/request",
            json=body,
            headers=self._agent_headers(),
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()

    def get_events(
        self,
        limit: int = 50,
        event_type: Optional[str] = None,
        severity: Optional[str] = None,
        since: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get events for this agent (requires session_token auth)."""
        if not self.agent_id:
            raise Exception("Agent not registered.")

        params = {"limit": limit}
        if event_type:
            params["event_type"] = event_type
        if severity:
            params["severity"] = severity
        if since:
            params["since"] = since

        resp = requests.get(
            f"{self.base_url}/api/agents/{self.agent_id}/events",
            params=params,
            headers={**self._headers, "X-Session-Token": self.session_token},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("events", [])
