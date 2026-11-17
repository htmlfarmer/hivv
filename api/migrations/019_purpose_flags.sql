-- 019_purpose_flags.sql — the "does this help life on Earth?" flag inbox.
--
-- The benchmark lives at /purpose.html and GET /api/purpose. Anyone can file a
-- flag against it: POST /api/purpose/flag. Before this table, that endpoint
-- returned a receipt with `stored: false` — it validated and answered, but the
-- flag went nowhere. This gives the flags a home.
--
-- Design notes:
--   * `flag_id` is generated CLIENT-side by the route (crypto.randomBytes),
--     so the response can hand back an id even when the insert fails.
--   * `check_key` is constrained to the eight benchmark keys in app code; the
--     CHECK constraint here is defence in depth in case another writer appears.
--   * `contact` is optional and may hold an email or phone number. It is only
--     ever returned to operators, never in a public listing — same rule as
--     hivv_review_registry's private half.
--   * No IP address is stored. Rate limiting already happens upstream; a flag
--     inbox does not need to become a tracking table.
--   * `status` answers the promise made on the page: every flag gets one of
--     fixed / flagged / deliberate — never "we'll get to it".
--
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS hivv_purpose_flags (
    flag_id      TEXT PRIMARY KEY,
    check_key    TEXT,
    what         TEXT,
    why          TEXT,
    contact      TEXT,

    -- new | fixed | flagged | deliberate
    status       TEXT NOT NULL DEFAULT 'new',
    resolution   TEXT,
    resolved_at  TIMESTAMPTZ,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT hivv_purpose_flags_check_key_ck CHECK (
        check_key IS NULL OR check_key IN (
            'health', 'water', 'food', 'knowledge',
            'wisdom', 'offline', 'fun', 'spirit'
        )
    ),
    CONSTRAINT hivv_purpose_flags_status_ck CHECK (
        status IN ('new', 'fixed', 'flagged', 'deliberate')
    ),
    -- A flag with neither a subject nor a reason tells us nothing.
    CONSTRAINT hivv_purpose_flags_content_ck CHECK (
        what IS NOT NULL OR why IS NOT NULL
    )
);

-- The inbox view is always "newest first, unresolved first".
CREATE INDEX IF NOT EXISTS hivv_purpose_flags_created_idx
    ON hivv_purpose_flags (created_at DESC);

CREATE INDEX IF NOT EXISTS hivv_purpose_flags_status_idx
    ON hivv_purpose_flags (status, created_at DESC);

-- Group by benchmark check to see which of the eight is drawing fire.
CREATE INDEX IF NOT EXISTS hivv_purpose_flags_check_idx
    ON hivv_purpose_flags (check_key)
    WHERE check_key IS NOT NULL;
