-- 027_dog_sightings.sql — the canine node: crowd-sensed dog sightings.
--
-- The high-tech hivv's first living sensor: anyone (neighbors, the Migels,
-- future scanners) can report "I saw the dog here at this time" and it lands
-- on /map/ as a paw. No PII beyond what the reporter chooses to type.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS dog_sightings (
    id          BIGSERIAL PRIMARY KEY,
    dog         TEXT NOT NULL DEFAULT 'yalla',
    where_text  TEXT NOT NULL,
    note        TEXT,
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dog_sightings_dog ON dog_sightings (dog, created_at DESC);
