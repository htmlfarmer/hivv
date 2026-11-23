-- 022_toolkit.sql — the twelve tools (HIVV_TOOLKIT_PLAN.md).
--
-- Three things land here:
--   1. two new capabilities for the tools that had no home (file read/search,
--      memory)
--   2. the memory table the `memory` tool stores into
--   3. two posture corrections:
--        · web.search   allow → ask   (web search is BUILT and TESTED, but
--                                      nobody is granted it by default —
--                                      HIVV_ENABLE_WEB_SEARCH=1 advertises it)
--        · coding.execute tier compute → side-effect (the tier was never
--                                      changed when the verdict moved to ask,
--                                      which meant the risk score for running
--                                      code was 1 — the same as plain chat —
--                                      and the hub's chat tool loop skipped the
--                                      gate for it entirely)
--
-- Idempotent: safe to re-run.

-- ── 1. new capabilities ─────────────────────────────────────────────────────
INSERT INTO hivv_capabilities (key, label, tier, description, default_verdict, requires_consent) VALUES
    ('data.file.read', 'read & search files',   'data',        'read a document (PDF/DOCX/TXT/CSV/JSON) and search across uploaded documents', 'ask',  true),
    ('data.memory',    'remember between chats','data',        'store and recall notes scoped to the requester',                                          'allow', false)
ON CONFLICT (key) DO NOTHING;

-- ── 2. the memory store ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hivv_memory (
    id          BIGSERIAL PRIMARY KEY,
    principal   TEXT NOT NULL,                 -- 'user:<id>' | visitor id | 'anon'
    key         TEXT NOT NULL,                 -- the label the model chose
    value       JSONB NOT NULL DEFAULT 'null'::jsonb,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ
);
-- one memory per principal per key — remembering the same key twice updates it
CREATE UNIQUE INDEX IF NOT EXISTS idx_hivv_memory_principal_key ON hivv_memory (principal, key);
CREATE INDEX IF NOT EXISTS idx_hivv_memory_principal ON hivv_memory (principal, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_memory_expiry ON hivv_memory (expires_at) WHERE expires_at IS NOT NULL;

-- ── 3. posture ──────────────────────────────────────────────────────────────

-- Web search: implemented and covered by tests, but NOT granted to anybody
-- by default. The first call mints a pending grant that a human approves
-- (`hivv approve G_xxx`); a standing grant then makes it frictionless.
-- HIVV_ENABLE_WEB_SEARCH=1 additionally advertises the schema to models and
-- lets an operator (loopback / control token) run it un-gated.
UPDATE hivv_capabilities
   SET default_verdict = 'ask',
       requires_consent = true,
       description = 'queries the open internet — built and tested, but not granted by default (human-approved per grant)',
       updated_at = NOW()
 WHERE key = 'web.search';

-- coding.execute: the verdict moved to 'ask' in migration 011 but the TIER
-- stayed 'compute', so the risk score was 1 (same as plain chat) and the
-- hub's chat tool loop — which only gates tiers above 'compute' — skipped
-- the policy check for `exec`/`shell`/`run` entirely.
UPDATE hivv_capabilities
   SET tier = 'side-effect',
       description = 'runs in an ephemeral docker/bwrap sandbox (no net, quotas, read-only); human-approved per grant',
       updated_at = NOW()
 WHERE key = 'coding.execute';
