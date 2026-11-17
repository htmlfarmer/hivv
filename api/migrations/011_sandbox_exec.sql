-- 011_sandbox_exec.sql — coding.execute gets a real isolated backend.
-- hivv OS §1 "Isolated Tool Sandboxing" (backlog F3). Now that api/lib/sandbox.js
-- runs code in an ephemeral docker/bwrap jail (no network, RAM/CPU/pids quotas,
-- read-only, dropped caps, restricted syscalls, hard timeout), the capability
-- moves from a flat DENY to MAYBE: every execution is human-approved + sandboxed
-- + audited. Idempotent.

UPDATE hivv_capabilities
   SET default_verdict = 'ask',
       requires_consent = true,
       description = 'runs in an ephemeral docker/bwrap sandbox (no net, quotas, read-only); human-approved per grant',
       updated_at = NOW()
 WHERE key = 'coding.execute';
