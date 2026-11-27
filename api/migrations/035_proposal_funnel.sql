-- 035_proposal_funnel.sql — THE INTAKE FUNNEL's columns.
--
-- 034 gave hivv_proposals the GATE columns (a change travelling to a merge).
-- This gives it the INTAKE columns: what a bee SAID, who else said it, what
-- the screens found, and where it landed on GitHub.
--
-- THE DEDUPE LAW
-- ──────────────
-- dedupe_key = sha256(normalize(title + body)). Five nodes with the same
-- idea become ONE issue carrying +5 votes. That is the hive's actual
-- advantage over one human filing issues, so the key is UNIQUE: the second
-- identical proposal must UPDATE the first, never create a twin.
--
-- votes is a JSONB array of {node_id, principal, at} — a vote is an
-- IDENTITY, not a counter. A number can be inflated; a list of signed
-- principals can be audited.
--
-- ON CONFLICT DO NOTHING on the index: 034 may already be applied on a box
-- that ran the earlier build, and a migration must be safe to re-run.

-- The PATCH itself. 034 only kept patch_sha256, so a gateway restart
-- restored every proposal with an EMPTY patch — and an approved change
-- could then never open its PR (Stage 5 silently dead after any restart).
-- Suggestions and bugs carry no diff, so this column stays NULL for them.
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS patch          TEXT;
-- A LABEL for hostile-testing traffic. It marks a row and keeps it off the
-- public list; it never weakens a check. A client may set it; a client may
-- never gain anything by setting it.
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS red_team       BOOLEAN DEFAULT FALSE;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS type         TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS body         TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS evidence     TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS node_id      TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS dedupe_key   TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS votes        JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS verdict      TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS screen       JSONB;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS reviews      JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS issue_number INTEGER;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS issue_url    TEXT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS filed_at     BIGINT;
ALTER TABLE hivv_proposals ADD COLUMN IF NOT EXISTS filed_via    TEXT;

-- The capability the funnel's stage-6 gate evaluates. It MUST be in the
-- registry table, not just in code: with a database present the registry is
-- read from here, so an unregistered key resolves to `default:unknown` —
-- invisible to `hivv cap list` and untunable by an operator.
--
-- Default ASK: the hub's single GitHub credential is never spent silently.
INSERT INTO hivv_capabilities (key, label, tier, description, default_verdict, requires_consent)
VALUES (
    'github.write', 'Write to GitHub', 'side-effect',
    'File an issue, open a PR, comment or close — the hub is the ONLY credential holder, and every write passes this gate',
    'ask', true
)
ON CONFLICT (key) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hivv_proposals_dedupe
    ON hivv_proposals (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hivv_proposals_node
    ON hivv_proposals (node_id) WHERE node_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hivv_proposals_verdict
    ON hivv_proposals (verdict) WHERE verdict IS NOT NULL;
