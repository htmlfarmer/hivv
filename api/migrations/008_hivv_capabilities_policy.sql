-- 008_hivv_capabilities_policy.sql — capability layer (§1) + policy engine (§3) + routing modes (§2)
-- Plan: HIVV_CAPABILITY_POLICY_PLAN.md. Safe to re-run (idempotent).

-- ── §1 capability registry: the nouns of the hivv OS ───────────────────
CREATE TABLE IF NOT EXISTS hivv_capabilities (
    key              TEXT PRIMARY KEY,
    label            TEXT NOT NULL,
    tier             TEXT NOT NULL,           -- read | compute | side-effect | data | money | physical | control
    description      TEXT DEFAULT '',
    default_verdict  TEXT NOT NULL DEFAULT 'allow',  -- allow | ask | deny
    requires_consent BOOLEAN NOT NULL DEFAULT false,
    active           BOOLEAN NOT NULL DEFAULT true,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO hivv_capabilities (key, label, tier, description, default_verdict, requires_consent) VALUES
    ('reasoning',              'reasoning / chat / analysis',      'compute',     'plain text generation — the free default, friction stays zero',  'allow', false),
    ('vision',                 'image → text',                     'compute',     'multimodal understanding, needs a vision-capable model',         'allow', false),
    ('speech.text-to-voice',   'text → speech',                    'compute',     'kokoro TTS (hub service)',                                       'allow', false),
    ('speech.voice-to-text',   'speech → text',                    'compute',     'whisper STT (hub service)',                                      'allow', false),
    ('translation',            'translation',                      'compute',     'reasoning tagged for language routing',                          'allow', false),
    ('coding',                 'code generation',                  'compute',     'writing code is safe; RUNNING code is a different capability',   'allow', false),
    ('coding.execute',         'execute arbitrary code',           'compute',     'v1: refused until a sandboxed runtime exists',                   'deny',  true),
    ('local.computation',      'local computation',                'compute',     'time / calculate / sysinfo on a volunteer machine',              'allow', false),
    ('image.generate',         'image generation',                 'compute',     'diffusion endpoints advertised by nodes (future)',               'allow', false),
    ('web.search',             'web search',                       'side-effect', 'queries the open internet from a node',                          'allow', false),
    ('web.fetch',              'fetch arbitrary URL',              'side-effect', 'arbitrary egress — first use asks, then a standing grant',       'ask',   true),
    ('database.query',         'database query',                   'data',        'read-only queries against stored state',                         'ask',   true),
    ('human.approval',         'ask a human',                      'control',     'the MAYBE path itself — callable, audited',                      'allow', false),
    ('financial.transaction',  'spend money',                      'money',       'no backend yet; policy default is NO',                           'deny',  true),
    ('physical.world',         'act on the physical world',        'physical',    'printers / IoT / robots — reserved, refused until paired',       'deny',  true)
ON CONFLICT (key) DO NOTHING;

-- ── §3 policies: decision rules as data (WHO/WHAT/DATA/WHERE/WHEN/COST/RISK/AUDIT) ──
CREATE TABLE IF NOT EXISTS hivv_policies (
    id          BIGSERIAL PRIMARY KEY,
    principal   TEXT NOT NULL DEFAULT 'global',   -- 'global' | visitor id | 'user:<id>' | 'node:<id>'
    scope       TEXT NOT NULL DEFAULT 'policy',
    doc         JSONB NOT NULL,                    -- { rules: [ { when: {capability|tier|transport|prefix}, verdict, memo } ], limits: {...} }
    priority    INTEGER NOT NULL DEFAULT 100,      -- lower = evaluated first
    active      BOOLEAN NOT NULL DEFAULT true,
    created_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hivv_policies_principal ON hivv_policies (principal, scope) WHERE active = TRUE;

-- the out-of-the-box global policy (everything else inherits from hivv_capabilities defaults)
INSERT INTO hivv_policies (principal, scope, doc, priority, created_by)
VALUES ('global', 'policy',
  '{"memo":"hivv default policy — chat/compute flows free; side-effects are audited; fetch/query ask; money/physical/execute refuse","rules":[],"limits":{"max_cost_per_day_usd":0,"ask_risk_threshold":3,"delegation_max_depth":2}}'::jsonb,
  100, 'system')
ON CONFLICT DO NOTHING;

-- ── MAYBE survivors: grants (pending approval requests + approved allowances) ──
CREATE TABLE IF NOT EXISTS hivv_grants (
    id             TEXT PRIMARY KEY,               -- G_xxx
    principal      TEXT NOT NULL,                  -- who asked (visitor id / user:<id>)
    capability     TEXT NOT NULL,
    args_summary   JSONB NOT NULL DEFAULT '{}',
    reason         TEXT,                           -- why the action was proposed (shown to approver)
    requested_via  TEXT,                           -- node_id or 'hub'
    status         TEXT NOT NULL DEFAULT 'pending',-- pending | approved | denied | used | expired
    scope          TEXT NOT NULL DEFAULT 'once',   -- once | standing (survives until expires_at)
    decided_by     TEXT,
    memo           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at     TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hivv_grants_pending ON hivv_grants (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_grants_principal ON hivv_grants (principal, capability, status);

-- ── trusted agents + delegation history ────────────────────────────────
CREATE TABLE IF NOT EXISTS hivv_delegations (
    id          BIGSERIAL PRIMARY KEY,
    parent      TEXT NOT NULL,        -- who delegated
    agent       TEXT NOT NULL,        -- to which principal/agent id
    capability  TEXT NOT NULL,        -- prefix grant ('*' = everything parent holds)
    limits      JSONB NOT NULL DEFAULT '{}',
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hivv_delegations_parent ON hivv_delegations (parent, revoked_at);

-- ── AUDIT: append-only, hash-chained ledger ────────────────────────────
CREATE TABLE IF NOT EXISTS hivv_audit (
    id        BIGSERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor     TEXT NOT NULL,
    action    JSONB NOT NULL,          -- {capability, tier, transport, provider, mode, args}
    verdict   TEXT NOT NULL,           -- allow | ask | deny | grant
    rule     TEXT NOT NULL,           -- which rule said so
    risk      INTEGER NOT NULL DEFAULT 0,
    receipt   TEXT,                    -- X-Hivv-Answered-By style string
    grant_id  TEXT,
    prev_hash TEXT NOT NULL,
    hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hivv_audit_time ON hivv_audit (id DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_audit_actor ON hivv_audit (actor, id DESC);
CREATE INDEX IF NOT EXISTS idx_hivv_audit_verdict ON hivv_audit (verdict, id DESC);

-- ── §2 cost signal: provider prices ($/M tokens; 0 = free/donated) ─────
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS cost_in_per_mtok  REAL NOT NULL DEFAULT 0;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS cost_out_per_mtok REAL NOT NULL DEFAULT 0;

UPDATE ai_providers SET cost_in_per_mtok = p.i, cost_out_per_mtok = p.o
FROM (VALUES
    ('openai',     2.50::real, 10.00::real),
    ('anthropic',  3.00::real, 15.00::real),
    ('google',     1.25::real,  5.00::real),
    ('mistral',    0.40::real,  2.00::real),
    ('groq',       0.05::real,  0.08::real),
    ('deepseek',   0.27::real,  1.10::real),
    ('openrouter', 0.50::real,  2.00::real),
    ('together',   0.40::real,  2.00::real),
    ('minimax',    0.50::real,  2.00::real),
    ('mimo',       0.50::real,  2.00::real),
    ('qwen',       0.50::real,  2.00::real),
    ('azure',      2.50::real, 10.00::real)
) AS p(name, i, o)
WHERE ai_providers.name = p.name;

-- gateway_config: tunable routing weights (C6 companion — defaults also live in code)
INSERT INTO gateway_config (key, value)
VALUES ('routing', '{"modes":["balanced","quality","fast","cost","private","trusted"],"jitter":8,"unknown_tps":8,"quality_weights":{"gpt-4":10,"gpt-4o":10,"o1":10,"o3":10,"claude":10,"gemini":9,"llama":8,"qwen":8,"gemma":7,"mistral":7,"phi":5,"small":4},"weights":{"tps":0.6,"latency":0.4}}'::jsonb)
ON CONFLICT (key) DO NOTHING;
