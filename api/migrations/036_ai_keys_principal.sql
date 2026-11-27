-- 036_ai_keys_principal.sql — K2: personal key binding (HIVV_PERSONAL_MODELS_PLAN.md §6)
--
-- A PERSONAL key answers only to the verified identity scope that created it:
--   user:<id>     signed session / Bearer users.api_key
--   visitor:<id>  the SIGNED hivv_visitor cookie
--   node:<id>     proven x-node-secret (the CLI)
-- router.selectKey() enforces it; the raw x-visitor-id header is spoofable
-- and is deliberately never a scope.
--
-- NULL = no owner binding = HIVE-WIDE (donated keys). This preserves the
-- semantics of every pre-existing row: user_id NULL + principal NULL was
-- already "everyone may spend it", and stays exactly that.

ALTER TABLE ai_keys ADD COLUMN IF NOT EXISTS principal VARCHAR(120);

-- Selection joins on it for every cloud-key request; the partial index keeps
-- donated rows (the majority) out of it.
CREATE INDEX IF NOT EXISTS idx_ai_keys_principal
    ON ai_keys(principal) WHERE principal IS NOT NULL;
