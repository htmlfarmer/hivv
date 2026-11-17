// api/routes/purpose-routes.js — the purpose benchmark, machine-readable.
// Mounted at /api/purpose.
//
//   GET  /            the benchmark: what we measure everything against
//   GET  /checks      just the checks, flat, for quick tooling
//   POST /flag        flag something that misses the benchmark (returns a receipt)
//
// DESIGN RULES
//  · Works with NO database (local-first: pool === null still answers GETs).
//  · The benchmark is a constant, not config — it must not drift per-deploy.
//  · Flags are validated and length-capped before they touch anything.
//  · Tone: happy, funny, safe. The subject matter is serious; the voice isn't grim.
//
// WHY THIS EXISTS
// The benchmark ("does this help all life on Earth?") is the yardstick every
// feature on both sites is measured against. Keeping it in the API means a
// partner, an agent, or a suspicious human can check our claims instead of
// trusting a marketing page. If the page and the API ever disagree, the API
// wins and the page is a bug.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// ── The benchmark ────────────────────────────────────────────────────────────
// Add a check and BOTH the website and the API change together — the page
// renders from this same list via /checks. Never edit one without the other.
const BENCHMARK = {
  purpose: 'Helps all life on Earth.',
  plain: 'Before we build it, ship it, or point an AI at it, we ask one question: '
       + 'does this help all life on Earth? If it moves none of the checks below, '
       + 'we do not work on it — or we flag it in public and say why.',
  checks: [
    {
      key: 'health',
      label: 'Health',
      emoji: '🌱',
      question: "Does it help a person's body or mind, or reduce harm?",
      never: 'Medical, legal or safety advice presented as fact. AI output is a '
           + 'starting point, not a doctor.',
    },
    {
      key: 'water',
      label: 'Clean water',
      emoji: '💧',
      question: 'Does it help people get, test, save or share clean water?',
      never: 'Water data is life-and-death data. It gets sourced and dated, never guessed.',
    },
    {
      key: 'food',
      label: 'Food',
      emoji: '🍚',
      question: 'Does it help someone grow, find, afford or share food?',
      never: 'Including the unglamorous parts: yield, spoilage, transport, real prices.',
    },
    {
      key: 'knowledge',
      label: 'Knowledge',
      emoji: '📖',
      question: 'Does it help someone learn something true, with the source visible?',
      never: 'Knowledge you cannot verify is just rumour with better typography.',
    },
    {
      key: 'wisdom',
      label: 'Wisdom',
      emoji: '🦉',
      question: 'Does it help someone make a better decision, not merely a faster one?',
      never: 'Hiding trade-offs behind a green tick. Speed without wisdom is efficient regret.',
    },
    {
      key: 'offline',
      label: 'Works offline',
      emoji: '📡',
      question: 'Does it keep working when the internet does not?',
      never: 'A plain git clone must boot with no database, no internet, no secrets.',
    },
    {
      key: 'fun',
      label: 'A bit of fun',
      emoji: '😄',
      question: 'Is it enjoyable enough that people who need it will actually use it?',
      never: 'Serious mission, light feet. Both at once is the whole idea.',
    },
    {
      key: 'spirit',
      label: 'Spirit',
      emoji: '🧭',
      question: 'Does it leave a person with more agency and less fear?',
      never: 'We do not tell anyone what to believe. The machine is on their side of the table.',
    },
  ],
  // What we actually do when something misses. Three answers, all acceptable.
  verdicts: [
    { key: 'fix',    label: 'Fix it',    color: 'green',
      meaning: 'Usually the right answer, and the boring one.' },
    { key: 'flag',   label: 'Flag it',   color: 'yellow',
      meaning: 'Mark it public, dated, with a reason — so nobody has to guess.' },
    { key: 'stop',   label: 'Stop',      color: 'red',
      meaning: 'If it cannot be made to fit, it does not get built. Even if it '
             + 'would have been profitable, clever, or a really good demo.' },
  ],
  how_to_flag: {
    website: 'Ask in chat: "flag this — does it meet the purpose?"',
    api: 'POST /api/purpose/flag',
    offline: 'The benchmark is printed on /purpose.html and needs no network.',
    promise: 'Every flag gets one of: fixed, flagged (we know), or deliberate '
           + '(here is the reason). "We will get to it" is not an answer.',
  },
  honesty: 'We will sometimes get this wrong. The benchmark exists so that being '
         + 'wrong is findable — by you, without our help.',
  updated: '2026-11-17',
};

// ── GET /api/purpose ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    ok: true,
    ...BENCHMARK,
    links: {
      page: '/purpose.html',
      privacy: '/privacy.html',
      partner_api: '/api/partner/manifest',
      self: '/api/purpose',
    },
  });
});

// ── GET /api/purpose/checks ──────────────────────────────────────────────────
// Flat and cheap: designed to be called by agents before doing work.
router.get('/checks', (req, res) => {
  res.json({
    ok: true,
    purpose: BENCHMARK.purpose,
    updated: BENCHMARK.updated,
    checks: BENCHMARK.checks.map(c => ({
      key: c.key, label: c.label, emoji: c.emoji, question: c.question,
    })),
    verdicts: BENCHMARK.verdicts.map(v => v.key),
  });
});

// ── POST /api/purpose/flag ──────────────────────────────────────────────────
// Validate hard, then either persist (if a DB is attached) or return a receipt
// the caller can keep. Never throws — a flag must not be able to break the API.
const MAX_WHY = 1000;
const MAX_WHAT = 300;

function clean(s, max) {
  if (typeof s !== 'string') return '';
  // strip control chars, collapse whitespace, cap length
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max);
}

router.post('/flag', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const what = clean(body.what, MAX_WHAT);
    const why = clean(body.why, MAX_WHY);
    const check = clean(body.check, 40);
    const contact = clean(body.contact, 200);

    if (!what && !why) {
      return res.status(400).json({
        ok: false,
        error: 'Tell us what you are flagging. "what" or "why" is required.',
        example: { what: 'the homepage hero', why: 'it never says what HIVV does' },
      });
    }

    // The check key must be one of ours — no free-text taxonomy.
    const known = BENCHMARK.checks.map(c => c.key);
    if (check && !known.includes(check)) {
      return res.status(400).json({
        ok: false,
        error: `"check" must be one of: ${known.join(', ')}`,
        received: check,
      });
    }

    // A receipt is always returned, even with no database — a local gateway
    // (HIVV_DB_REQUIRED=0) must still be able to file a flag offline.
    const id = 'flag_' + crypto.randomBytes(6).toString('hex');
    const ts = new Date().toISOString();
    let stored = false;

    const pool = router._pool;
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO hivv_purpose_flags
             (flag_id, check_key, what, why, contact, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [id, check || null, what || null, why || null, contact || null]);
        stored = true;
      } catch (e) {
        // Missing table or read-only DB is not a client error — the receipt
        // still stands, we just say it is not persisted.
        stored = false;
      }
    }

    res.status(201).json({
      ok: true,
      id,
      created_at: ts,
      stored,
      received: { what, why, check: check || null, contact: contact || null },
      what_happens_next: [
        'A human reads it.',
        'It gets one of: fixed, flagged (we know), or deliberate (here is the reason).',
        '"We will get to it" is not an answer.',
      ],
      benchmark: BENCHMARK.purpose,
      ...(stored ? {} : {
        note: 'Received, but not persisted — this gateway has no database attached. '
            + 'The receipt above is yours to keep; re-file it against a gateway '
            + 'with storage if you want it tracked there.',
      }),
    });
  } catch (e) {
    // A flag must never be able to take the endpoint down.
    res.status(500).json({
      ok: false,
      error: 'Could not record that flag. Nothing was lost on your side — '
           + 'please retry or use /purpose.html to read the benchmark directly.',
      detail: String(e && e.message || e).slice(0, 200),
    });
  }
});

// Pool is injected by server.js the same way other routers do it.
router.inject = (pgPool) => { router._pool = pgPool || null; };

module.exports = router;
