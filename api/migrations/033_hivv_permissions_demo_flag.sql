-- 033_hivv_permissions_demo_flag.sql — FINISH the sample flag.
--
-- WHY THIS EXISTS
-- Migration 032 taught the site to tell a seeded SAMPLE row from a real
-- registration: is_demo on hivv_agents, hivv_events and hivv_intentions.
-- It missed hivv_permissions — and every row in that table on this box
-- belongs to a sample agent (Web Scraper, Finance Agent, Email Agent).
--
-- So a permission granted to a fixture was still counted as a permission
-- granted to an agent: the agent's pending count
--   (SELECT COUNT(*) FROM hivv_permissions WHERE agent_id = a.id ...)
-- counted them, and any future "how many permissions has this hive granted"
-- would have counted them too. The fleet was honest and its permissions
-- were not.
--
-- THE RULE, same as 032: a sample row is SAMPLE DATA. It is never counted
-- as an agent, never counted as an authorization.
--
-- The flag is DERIVED from the agent, not hand-listed: a permission belongs
-- to an agent, and if that agent is a sample, so is the permission. That
-- way a future seed row is covered without a second migration.
--
-- Idempotent (IF NOT EXISTS + a derived UPDATE): safe to re-run on a box
-- where it has already been applied.

ALTER TABLE hivv_permissions ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

UPDATE hivv_permissions p
   SET is_demo = true
 WHERE EXISTS (
         SELECT 1 FROM hivv_agents a
          WHERE a.id = p.agent_id AND a.is_demo = true);

CREATE INDEX IF NOT EXISTS idx_hivv_permissions_is_demo ON hivv_permissions(is_demo);

DO $$
DECLARE
    v_total INTEGER;
    v_demo  INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total FROM hivv_permissions;
    SELECT COUNT(*) INTO v_demo  FROM hivv_permissions WHERE is_demo;
    RAISE NOTICE 'HIVV: hivv_permissions has % rows, % of them sample data', v_total, v_demo;
END $$;
