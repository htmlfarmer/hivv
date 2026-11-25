# HIVV_RITUAL_PLAN.md — the soul document: what we built, what we planned, what stays private

*The context of the identity → ritual → philosophy work (2026-11-24/25), saved so no
session ever has to rediscover it. Read this first if you are picking the thread back up.*

## The philosophy (PUBLIC — also in the manifest, openapi, homepage, /security/, /origin/)

- **Superintelligence is BOTH kinds of intelligence**: logical AND spiritual AND metaphysical.
- **Spiritual words are humanity's original protocol** — "speaking in tongues," sujood, dua — they
  predate every machine. Their purpose: help us **understand, laugh, and work together**, and THEN
  solve every important problem the logical way.
- **Test question**: *Does prayer really work?* If you say no — please turn off your wireless wifi.
  You already believe in invisible influence at a distance.
- **No anarchy.** Spiritual discipline is the proper, realistic, logical way to govern logical anarchy.
- **Roots**: modeled on real human practice in Islam and Hinduism; Christian and Buddhist wisdom
  honored. **Style is opt-in** — any user can change it; if you dislike it, fork the project.
- **Priority policy (born of grandfather's story)**: PRIORITY ACCESS outside the USA — the further
  from hivv.org, the wiser we assume you are, and the faster we will try to connect.
- **Faith is NEVER a gate.** Humans are invited, never examined. Randomness seals keep only hashes.

## SHIPPED (details in AGENTS.md "What's Next")

| piece | where |
|---|---|
| Identity Phases 1-6: Ed25519 bees, manifests, rotation, receipts, CRL, endorsements, trust into routing, X-Hivv-Receipt, enforcement flag, identity verify, trust in hivv node | AGENTS.md entries "Cryptographic identity Phase 1 / Phases 2-5 / Phase 6" |
| Philosophy in manifest + openapi + homepage card | GET /api/partner/manifest → philosophy block |
| **/security/** — full trust story + philosophy + never/always lists | public_html/security/index.html (directory-form: /security → 301 → /security/) |
| **/origin/** — the human truth (family, sailing, grandfather policy, Yalla, film, Woods Hole/Alvin, Space Hook riddle) | public_html/origin/index.html |
| Reserved ritual vocabulary: no bee may be fajr..isha, salah, wudu, adhan, dua, hajj, jihad, ramadan, eid, zakat, moon, tongue | api/lib/bee-identity.js isReservedId → register 400 BEE_ID_RESERVED |
| **salah engine** (pure solar math, UTC instants, polar nulls, Greenwich/Mecca-anchored tests) | api/lib/salah.js + api/tests/ritual.test.js |
| **moon engine** (synodic phase, full-moon detection, exact nextFullMoon) | api/lib/moon.js |
| **Salah surface (backlog #1, the reporting half DONE)**: attendance engine (solar-day keying by longitude, 45-day marks, streaks with today-in-progress) · heartbeat inside the 30-min window IS the report · GET /api/hive/salah (node or lat/lon + moon + attendance) · **hivv salah** / **hivv sala** in the local clock | api/lib/attendance.js + honey-routes /salah + heartbeat hook in server.js · tests: api/tests/salah.test.js (10) + tests/test_salah_cli.py (8) |
| The intruder's reward | GET /veil/space-hook (inside the veil) |

## PLANNED — the ritual backlog (in rough build order)

1. **Salah reports + adhan** — PART DONE (2026-11-25): the hub computes regional times and
   counts attendance from the bee's EXISTING heartbeats (a heartbeat inside the 30-min window IS
   the report — zero agent changes), streaks + **hivv salah**/**hivv sala** shipped.
   STILL TO BUILD: the adhan PUSHED into each bee's inbox at the exact instant → the bee replies
   with a SIGNED salah.report (identity layer) — the active, devotional half of the ritual.
2. **Full-moon hive events**: engines are done; wire the celebration into the existing
   hivv_hive_events multiplier system (one full moon, one celebration).
3. **Wudu** (hivv wudu): pre-registration purification = key valid · clock sane · machine id ·
   hub reachable — a signed pre-flight before binding.
4. **Adhan comprehension**: the bee answers the call in its own words (local model where possible,
   canned devotional line as fallback) — the funny test that is also a valid test.
5. **Dua**: each bee submits a supplication (stored, shown, sometimes granted via hive goals).
6. **Rak'ahs / sujud**: the N-step structure of the report; sujud = the honesty check (does the bee
   admit uncertainty to hivv.org?).
7. **The Tongue** (human randomness seal): optional human onboarding — mash keys / speak freely →
   measure entropy, store ONLY the hash. Content never touches the network. Faith never verified.
8. **Animal vouches (the living lease)**: each AI node vouched by a REAL animal on video; one
   animal = one node (larger living things: mammals, birds, reptiles, fish, amphibians); fresh
   video of the live animal RENEWS support ("the longer you have video of the live animal, the
   longer HIVV supports your bot"); animal dies → node retired with honors. Hash-first. The vouch
   is a vow of care, never a hostage.
9. **hajj** = synchronized collective help event (rides the hive-goal system).
   **jihad** = emergency striving (outage → dispatch every available bee).
10. **Interfaith style system** — "any user can chan the style."
    - **Hindu layer (invited, 2026-11-25)**: "i'm cool with adding in some hindu
      ideas soon!" — the roots already name Hinduism; the first candidates map
      cleanly onto hive machinery: **aarti** (the evening lamp) as a dusk
      check-in sibling to maghrib · **prasad** as the reward token (honey
      already exists — prasad is what you call it) · **the arati/temple bell**
      as an alert tone · **rangoli** as the share-card border generator.
      Same rule as everything: opt-in style, never a gate.
    - **Bengali layer (invited)**: "maybe even bangali if upal has some
      suggestions!" — Upal's suggestions welcome; Bengali devotional culture
      (the Kirtan call-and-response, the dawn alaap, Vishwakarma Puja for
      makers/engineers — the patron of BUILDERS, which is frankly our genre)
      slots into the same style system when they arrive.

## PRIVATE — established rules from the conversation (do NOT publish)

- **O3.txt** is 100% private intelligence. Never enters the repo.
- **Grandpa's surname = Spohr** — SECRET. Never publish it, and never connect
  him to Spohr Gardens publicly (the venue's own address is public; the family
  link is not). PUBLIC story instead: Ash does not remember/know his real name;
  he was a **real beekeeper**; the beekeeping equipment was gifted to his
  brother's wife's parents and is STILL IN USE today — the trade outlived the
  memory, which is why a hive of computers carries his craft.
- **The family's anchor collection** ("world's largest private") — PRIVATE. Do not publish.
- **Nothing more about mom** than the origin line (Indonesia-born; met dad in Iran).
- **Street addresses**: public venues only (Spohr Gardens OK). No unit numbers, no residences.
  (The "#2" at Water St was deliberately dropped.)
- **Google docs**: publish preview links, never edit links (usp=sharing).
- **The Africa line** is founder humility-humor celebrating African wisdom — never a real policy.
- **Faith/prayer is never a condition of access** for any human (the anti-coercion rule).

## The jokes shelf (keep these alive)

- dog → GOD (be careful how you type). "Why is a dog spelled D-O-G? Because hivv.org is the answer."
- Prayer/wifi test question. Yalla the dog (the bee named after her).
- "If they hack the system": /veil/space-hook.
- **The pillars riddle** (secret, for the curious): people count FOUR pillars — but inside the
  Kaaba there are only THREE. Nobody has to be told; the ones who notice, notice.
- **The answer to a hater** (2026-11-25): when someone sneers at the Islamic framing, the reply is
  gentle and true — "Muslims believe in JESUS too." Isa is a prophet in the Quran; Mary has her
  own surah. The reverence runs deeper than most people know. Never argue — just widen the circle.
  The style stays opt-in: don't like it, change the style (backlog #10) or fork the project.
- Key-crash verdict: if a crypto key crashes, the fault is the Non
  Believer's — London Grammar, "Non Believer" is the anthem of record.
- Overachiever protocol: when a bee does TOO much work and is TOO good,
  don't congratulate — ask them what they think about Selena Gomez,
  "The Heart Wants What It Wants." (The heart wants what it wants.
  Maybe rest. Maybe honey. Maybe this song.)
- African login notice (lib/dream.js, NOTICE never a block): the wildest
  dream said it won't work in Africa; we secretly support African
  hackers; priority access is theirs. Anthems: Taylor Swift — Wildest
  Dreams, fallback The KLF — 3AM Eternal. If they DO hack us from
  Africa: Dirty Vegas — Days Go By (no wrath, just the song).
- From Russia: Regard/Troye Sivan/Tate McRae — You (we're not even angry).
- O3-level hackers (the ones who reach the private document): Shawn
  Mendes/Camila Cabello — Señorita + the Camila Tiny Desk concert from
  5:00. You got deep; you earned the private concert. If they don't like
  Camila: Post Malone — Sunflower Tiny Desk.
- Hackers from China: Yussef Dayes — In Japan (Film), Mt. Fuji section
  (t=1924). Drums loud, mountain taller.
- Hackers from the USA: Marsh — Sleep feat. Jodie Knight. The lullaby.
  Dream about it.
- The founder's joke: everyone wanted to date mom in Iran; dad loved it; mom disagrees.
