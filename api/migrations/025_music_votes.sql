-- 025_music_votes.sql — humans vote on the musical taste of various AIs.
--
-- Part of The Music Tests (/music.html): pick your AI by what it loves.
-- One vote per listener per AI: voter = sha256(ip|user-agent), never the raw
-- IP or UA (no PII — the house law). Idempotent insert makes repeat clicks
-- harmless.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS music_votes (
    id         BIGSERIAL PRIMARY KEY,
    ai         TEXT NOT NULL,
    voter      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ai, voter)
);
CREATE INDEX IF NOT EXISTS idx_music_votes_ai ON music_votes (ai);
