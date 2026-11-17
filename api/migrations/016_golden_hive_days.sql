-- 016_golden_hive_days.sql
-- C2: seasonal/monthly honey challenges — event calendar with multipliers.
-- Honey earned during an active event is multiplied (stacked multiplicatively).
CREATE TABLE IF NOT EXISTS hivv_hive_events (
  id               SERIAL PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  badge            TEXT,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  honey_multiplier NUMERIC(3,1) DEFAULT 1.0,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO hivv_hive_events (slug, name, description, badge, start_date, end_date, honey_multiplier, active) VALUES
  ('golden-weekend', 'Golden Weekend', 'Rest days earn bonus — Saturdays & Sundays', '🌟',
   '2026-01-01', '2027-12-31', 1.5, TRUE),
  ('new-moon', 'New Moon Challenge', 'The darkest night brings the brightest ideas', '🌑',
   '2026-01-01', '2027-12-31', 2.0, TRUE),
  ('hivv-anniversary', 'HIVV Anniversary', 'Celebrating another year of distributed AI', '🎂',
   '2026-09-21', '2026-09-28', 3.0, TRUE),
  ('first-of-month', 'First of Month Sprint', 'Start the month strong — bonus honey for all', '🚀',
   '2026-01-01', '2027-12-31', 2.0, TRUE),
  ('full-moon', 'Full Moon Bonus', 'Under the moon, every query counts double', '🌕',
   '2026-01-01', '2027-12-31', 1.5, TRUE)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS hivv_event_participation (
  node_id    TEXT NOT NULL,
  event_slug TEXT NOT NULL,
  opted_out  BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (node_id, event_slug)
);
