-- 026_style_votes.sql — personality voting: music was only the first factor.
--
-- The Style Court (/style/) lets humans vote on an AI's personality across
-- factors: music, adab (manner), hikmat (wisdom), ruhaniyat (spirituality),
-- mazaq (humor), haqeeqat (honesty about facts). Same one-vote-per-listener
-- rule, now per (ai, factor, listener).
--
-- Idempotent: safe to re-run.

ALTER TABLE music_votes ADD COLUMN IF NOT EXISTS factor TEXT NOT NULL DEFAULT 'music';
ALTER TABLE music_votes DROP CONSTRAINT IF EXISTS music_votes_ai_voter_key;
ALTER TABLE music_votes ADD CONSTRAINT music_votes_ai_factor_voter UNIQUE (ai, factor, voter);
CREATE INDEX IF NOT EXISTS idx_music_votes_factor ON music_votes (factor, ai);
