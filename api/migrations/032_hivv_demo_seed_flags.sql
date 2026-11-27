-- 032_hivv_demo_seed_flags.sql — the seeded rows are SAMPLE DATA, and the
-- public dashboard was publishing them as a live fleet.
--
-- WHAT HAPPENED
--   Migration 003 ended with "SEED DATA: Sample Agents for Testing" and
--   inserted 5 agents into hivv_agents. A later development batch added 9
--   more (TechCorp, Code Assistant, Carol, Web Scraper, ...). All of them
--   were seeded into the PRODUCTION database, and the public Control Center
--   rendered them under the heading "AGENT FLEET" beside a "REALTIME LIVE"
--   badge — so a visitor saw "10 ACTIVE AGENTS", ten hand-picked trust
--   scores, and a relationship graph, none of it ever having been alive.
--
-- THE FIX
--   Flag the rows instead of deleting them: the seed data is what lets a
--   newcomer see how the governance machinery works, and the sign-up flow
--   (POST /api/agents/register) is easier to trust when you can see the
--   shape of what you would be joining.
--
--   But a SAMPLE must never be counted as a REGISTRATION, so it is marked
--   once, permanently, and every surface that counts "agents" can then tell
--   the two apart.
--
--   Real registrations are NOT affected: is_demo defaults to false, and the
--   marker below only matches the known seed names inside the seed window.

ALTER TABLE hivv_agents ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hivv_events ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hivv_intentions ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- The seed rows: migration 003's five, plus the later development batch.
-- Matched by name AND creation window, so an agent a real person later
-- names "Carol" is never swept up by this.
UPDATE hivv_agents SET is_demo = true
 WHERE public_name IN (
         'Alice', 'Personal Assistant', 'Research Agent', 'Finance Agent', 'HIVV Labs',
         'Web Scraper', 'Data Analyzer', 'Email Agent', 'Trading Bot', 'Customer Support',
         'Unknown Agent', 'Bob', 'Code Assistant', 'Carol', 'TechCorp'
       )
   AND created_at < TIMESTAMP '2026-09-08';

-- Their events and intentions inherit the flag: a tool call made by a
-- sample agent is sample data, whoever made it.
UPDATE hivv_events e
   SET is_demo = true
 WHERE e.agent_id IN (SELECT id FROM hivv_agents WHERE is_demo);

UPDATE hivv_intentions i
   SET is_demo = true
 WHERE i.agent_id IN (SELECT id FROM hivv_agents WHERE is_demo);

-- Index the flag: every public count filters on it.
CREATE INDEX IF NOT EXISTS idx_hivv_agents_is_demo ON hivv_agents(is_demo);
CREATE INDEX IF NOT EXISTS idx_hivv_events_is_demo ON hivv_events(is_demo);
CREATE INDEX IF NOT EXISTS idx_hivv_intentions_is_demo ON hivv_intentions(is_demo);

-- Record what was flagged, so the number is auditable and never a surprise.
DO $$
DECLARE
    v_agents INTEGER;
    v_events INTEGER;
    v_intentions INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_agents FROM hivv_agents WHERE is_demo;
    SELECT COUNT(*) INTO v_events FROM hivv_events WHERE is_demo;
    SELECT COUNT(*) INTO v_intentions FROM hivv_intentions WHERE is_demo;
    RAISE NOTICE 'HIVV: flagged % sample agents, % sample events, % sample intentions', v_agents, v_events, v_intentions;
END $$;
