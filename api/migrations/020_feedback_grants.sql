-- 020_feedback_grants.sql
-- hivv_feedback was created by the `postgres` role while every sibling table
-- is owned by the app role `hivv` — and NO migration ever ran a GRANT. Result:
-- every POST /api/feedback failed with `permission denied for table
-- hivv_feedback` (observed 2026-11-18 15:01), silently dropping every
-- `hivv report` / `hivv request` / `hivv suggest` / `hivv flag` submission.
GRANT ALL ON hivv_feedback TO hivv;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hivv;
-- Future tables created by ANY role default-grant to the app role (belt+suspenders)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO hivv;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO hivv;
