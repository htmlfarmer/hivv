# Human Usability Audit — HIVV.org & BLNQ.org

**Chief Human Usability Officer · 2026-11-17**
**Status: VERIFIED unless marked ASSUMPTION. No production code changed except as noted in §10.**

---

## 0. What was actually measured

Nothing in this report is opinion until it says ASSUMPTION.

| Method | Count | Output |
|---|---|---|
| Pages captured (desktop + 390px mobile) | 45 pages × 2 = **90 captures** | `capture.json`, `shots/` |
| User journeys walked unaided | **7** (J1–J7) | `journeys.json`, `journeys/` |
| Interactive/failure-path tests | **5** (I1–I5) | `interactive.json` |
| Link contrast measured **from rendered pixels** | **128 unique links** | `contrast.json` |
| Page scores, 10 dimensions each | **45 pages** | `scores.json` |
| External tools (prior run) | Lighthouse, axe, ZAP, Semgrep, Schemathesis, Gitleaks, Trivy | `ONE-EARTH-AUDIT/` |

**Measurement note (important).** The first contrast pass computed backgrounds from
`getComputedStyle().backgroundColor`, which cannot see `background: linear-gradient(...)`.
That produced a false "1.03:1 invisible link" reading on the homepage voice-chat button.
It was re-measured by sampling the actual rendered PNG. The gradient button is fine
(~15:1). **The false finding was discarded.** Every contrast number below is
pixel-derived.

---

## 1. The five biggest barriers for ordinary people

### Barrier 1 — Both sites show a blank screen for a missing page · VERIFIED

```
curl https://hivv.org/this-page-does-not-exist  →  HTTP 404 · 0 bytes
curl https://blnq.org/nope-xyz                  →  HTTP 404 · 0 bytes
```

- HIVV ships a good `404.html` (1563 bytes, has a heading) — **Caddy never serves it.**
  `hivv.org` has `file_server` + `try_files` but no `handle_errors` block.
- BLNQ has **no `404.html` at all**, and its deny-rules `respond @private 404` also
  return empty bodies.
- Other sites on the *same server* do it correctly (`ghosto.org` has
  `handle_errors { rewrite * /404.html; file_server }`).

**Why it matters:** a mistyped URL, a stale bookmark, or one dead link = a blank
page with no message, no home link, no way back. For a first-time visitor this reads
as "the site is broken." It is the single reason `Recovery = 0` on all 45 pages.

**Difficulty: S. Benefit: turns a dead end into a signpost.**

---

### Barrier 2 — HIVV's homepage is API documentation, not an invitation · VERIFIED

Measured on `/`:

| Signal | Value |
|---|---|
| Words on homepage | **1,536** |
| `<h1>` | **none (0)** |
| First-screen actions | code-snippet **copy buttons** (`copy`, `copy`, `🔄 refresh`) |
| Primary CTA position | "Ready to talk to HIVV?" is at the **bottom** of a very long page |
| Route modes shown as | a 6-column table: Balanced / Quality / Fast / Cost / Private / Trusted — **no explanation of any of them** |

The first thing a visitor meets is `curl -fsSL https://hivv.org/install-hivv.sh | bash`.

**Contrast — BLNQ gets this right:** h1 *"Here to help ALL life make work easy."*,
subtitle *"run code anywhere, safely."*, one plain paragraph, then three numbered
copy-paste steps. **Same team, very different first impression.**

**Why it matters:** a teacher, a farmer or a nurse does not know what `curl`, an
endpoint or a routing mode is. They cannot tell within 10 seconds what this is for,
so they leave.

**Difficulty: M. Benefit: the single highest-leverage change on the site.**

---

### Barrier 3 — YES / MAYBE / NO is never explained · VERIFIED

Searched every captured page on both sites:

- **"MAYBE" appears only as a counter** (`MAYBE ATTENTION 0`) and a panel title
  (`🟡 MAYBE APPROVAL CENTER`).
- **Zero plain-English definitions** of YES, MAYBE or NO anywhere on either site.
- Found on `/hivv-dashboard.html` only. **Not** on `/control.html`,
  **not** on `/dashboard.html` — a user has to already know which of three
  dashboard-ish pages to visit.
- A signed-out visitor gets **`Guest (Spectator)`** and **zero approve/deny buttons**
  (measured: `approve_buttons: []`).

**Why it matters:** this is your governance model — the thing that makes HIVV
different from ChatGPT. If nobody can explain it in one sentence, it does not exist
for a normal user. They see three coloured chips and no verbs.

**Difficulty: M. Benefit: converts your differentiator from invisible to obvious.**

---

### Barrier 4 — Three overlapping "control" pages · VERIFIED

| URL | `<title>` | `<h1>` |
|---|---|---|
| `/dashboard.html` | My Account — HIVV.org | Welcome, ... |
| `/control.html` | Distributed AI Control Panel | Distributed AI Control Panel |
| `/hivv-dashboard.html` | HIVV Control Center — Agent Governance & Governance Plane | HIVV SYSTEM GOVERNANCE STATE |

Nav labels them "My Account", "Control Center", "Control Center" (twice).

**Why it matters:** clicking "Control Center" twice lands you on two different pages.
Guessing which one holds your permissions is a coin flip.

**Difficulty: S (redirect + merge). Benefit: removes a whole category of wandering.**

---

### Barrier 5 — No onboarding anywhere · VERIFIED

Tested 7 pages across both sites for help affordances:

```
tour: false · tooltip_help: false · faq: false · first_run_hint: false · undo: false
      — on all 7 pages, both sites
```

**What happens when someone doesn't know what to do next? Nothing.** There is no
"first time here?", no tour, no FAQ, no undo anywhere on either site.

**Difficulty: M. Benefit: stops the silent abandonment.**

---

## 2. Answers to your ten questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Understand HIVV without knowing what an orchestration network is? | **No.** Homepage never defines it in one sentence; 1,536 words lead with a curl command. | J1 step 1, capture |
| 2 | Start a conversation easily? | **Yes — this works well.** Chat link present, input labelled "Ask HIVV anything…", **reply in 1.0s**. | J1 PASS, I1 |
| 3 | Understand the routing options? | **They're visible, not explained.** All 8 mode names appear; none has a plain-English description. | J2 |
| 4 | Control what AI agents may do? | **Not as a guest.** Spectator mode, 0 approve buttons; UI is on the least-obvious of 3 dashboards. | I4, J3 |
| 5 | Is YES/MAYBE/NO intuitive? | **No.** Never defined in words on either site — only as counters and a panel title. | full-site search |
| 6 | Understand where their information goes? | **Partly.** `/privacy.html` is real and specific (IP, agent ID, retention, deletion). But it's 11 numbered legal sections, not a picture of the journey. | J4 |
| 7 | Contribute their own computer? | **Yes.** "🐝 Install CLI" → `/cli.html` → install command present. | J5 PASS |
| 8 | Understand the benefits of joining? | **Weak.** Homepage shows stats (3 bees / 24 agents / 236 tokens) but never says what *you* get. | J5 |
| 9 | Could a community organisation use it? | **Technically yes, socially no** — no team/account story, no plain-language "for organisations" path. ASSUMPTION (no org persona tested). | — |
| 10 | Why choose HIVV over ChatGPT/Claude? | **Answered only for developers.** The real answer — *your data and your machine, verifiable, offline-capable* — is buried. BLNQ states it plainly on its homepage; HIVV does not. | homepage comparison |

---

## 3. Human Usability Score

Ten dimensions per page. **Overall = MINIMUM** (a zero is a zero — per the override
rule in `docs/AUDIT-FRAMEWORK.md`), with a second view excluding the systemic 404 bug
so pages can still be ranked against each other.

| Site | Pages | OVERALL | ex-Recovery | Mean of measured dims |
|---|---|---|---|---|
| **HIVV** | 25 | **0.0** | 0.3 | **4.9** |
| **BLNQ** | 20 | **0.0** | 0.1 | **5.3** |

**Both read 0.0 because Barrier 1 caps every page on Recovery.** That is the rule
working as intended: one systemic failure caps the system. The *mean* is the number
that discriminates between pages right now.

### Strongest (ex-Recovery)
`hivv/aup.html` 3.1 · `hivv/database.html` 2.0 · `hivv/privacy.html` 1.4 ·
`blnq/graph` 1.0 · `blnq/cli.html` 1.0

### Weakest — HIVV
| Page | Dims at 0 |
|---|---|
| `docs.html` | Simplicity, Discoverability |
| `hivv-agent-spec.html` | Discoverability, Trust, **no `lang`, no viewport meta** |
| `index.html` | Simplicity |
| `status.html` | Mobile |
| `command-center.html` | Discoverability, Trust |

### Weakest — BLNQ
`docs.html` (Simplicity) · `jobs`, `status`, `visualize`, `leaderboard` (Trust, Mobile)

### Dimension highlights (measured)
- **Accessibility:** 0 pages have a skip link (the `.skip-link` class exists in
  `styles.css` and is used by **0** pages). Almost no page has a `<main>` landmark.
  **4 pages have no `<h1>`**: `hivv/index`, `hivv/command-center`, `hivv/status`,
  `hivv/docs` (+ `blnq/docs`, `blnq/study`, `blnq/graph`).
- **Contrast:** **17 / 128 links below WCAG AA 4.5:1**; 13 below 3.0.
  Worst: default browser blue **2.13:1**, `#555` gray **2.69:1**, orange-on-light
  `cli.html` **2.80:1**. Root cause: **`styles.css` has no global `a` rule** — only
  `.site-nav .nav-links a` is styled, so every content link inherits browser blue.
- **Mobile:** no horizontal overflow on the homepage ✓. **10 of 33 tap targets
  under 24px.**
- **Speed:** HIVV homepage 1,743ms; chat **1.0s to first reply** ✓.

---

## 4. What is genuinely good (do not "fix" these)

1. **Chat works, and it's fast.** 1.0s reply, familiar layout, good placeholder.
2. **The chat Settings panel has excellent tooltips** — *"Higher = more creative,
   lower than more focused"*, *"Nucleus sampling cutoff"*. This is the standard the
   rest of the site should meet.
3. **BLNQ's homepage** — plain-English hero, three numbered steps, "What actually
   happens" section written for humans. This is the model for HIVV's rewrite.
4. **BLNQ's trust story** — *"Read the same signatures yourself at /trust.html —
   verified in your browser, not taken from our word."* That is the whole pitch,
   said once, clearly.
5. **`/privacy.html` is real** — specific about IP logging, agent IDs, retention,
   deletion. Not boilerplate.
6. **Local-first holds** — clone runs with no DB, no internet, no secrets (33/33).
7. **No horizontal overflow on mobile** for either homepage.

---

## 5. Mission alignment — "helps all life on Earth"

Benchmark shipped today (§10): **health · clean water · food · knowledge · wisdom ·
offline · fun · spirit.**

Honest scoring of what the product actually serves today:

| Check | Served by real product surface? | Evidence |
|---|---|---|
| 📖 Knowledge | **Yes** | docs, API docs, provenance, fast-scan |
| 🦉 Wisdom | **Yes — BLNQ's strongest suit** | "check the claim instead of taking our word for it", `/trust.html` |
| 📡 Offline | **Yes — genuinely** | clone-and-run, no DB/internet/secrets (33/33) |
| 😄 Fun | **Yes** | bee mascot, warm tone, `hivv hi` |
| 🧭 Spirit/agency | **Partly** | YES/MAYBE/NO, revocation, provenance exist — but see Barrier 3: nobody can find or understand them |
| 🌱 Health | **No** | no health surface on either site |
| 💧 Clean water | **No** | no water surface |
| 🍚 Food | **No** | no food surface |

**3 of 8 fully served, 1 partly, 3 not at all.** The benchmark names health, water
and food, but **nothing on either site does any of them yet.** That is not a
usability finding — it is a product-direction finding, and per your instruction it is
flagged rather than quietly worked on.

**Flag raised:** `flag — benchmark names three checks the product does not serve`.

---

## 6. Three improvements that land in 48 hours

### 48h-1 · Serve the 404 page both sites already deserve
- **Problem:** `404 · 0 bytes` on every missing URL (Barrier 1).
- **Why it matters:** every dead link looks like a crashed site.
- **Solution:** add the `handle_errors` block both Caddy site blocks already have
  a working pattern for, and create BLNQ's missing `404.html`.
- **Example:** miss a URL → *"Hmm, nothing here. ← Home · 💬 Chat · 🔍 Search"*
  instead of a black rectangle.
- **Difficulty: S** (≈6 lines of Caddy + 1 file). **Benefit: fixes Recovery on all
  45 pages at once** — the single change that lifts every score.
- **Measure:** `curl` any bad URL returns 200-sized body with an `<h1>`;
  audit `Recovery` goes 0 → 10.

### 48h-2 · One CSS rule for links
- **Problem:** `styles.css` styles only `.site-nav .nav-links a`; all other links
  inherit `#0000EE` → **2.13:1** (measured).
- **Why it matters:** content links are unreadable-ish and look unfinished;
  17/128 links fail WCAG AA.
- **Solution:** add a global `a { color: … }` with an AA-passing colour, plus
  `a:focus-visible` so keyboard users can see where they are.
- **Example:** footer/inline links render `#9ca3af` (~5.4:1) instead of blue (2.13:1).
- **Difficulty: S. Benefit:** fixes contrast site-wide, including your own new pages.
- **Measure:** re-run `contrast.py` → failures drop from 17 to <5.

### 48h-3 · Give the homepage one `<h1>` and one clear action
- **Problem:** HIVV's homepage has no `<h1>` and leads with a curl command.
- **Why it matters:** screen readers and search engines have no page identity; a
  human has no obvious first step.
- **Solution:** one `<h1>` that says what HIVV is, and three buttons at the top —
  **💬 Talk to AI · 🛡️ Control my AI · 🌐 Join the network** (your own proposal,
  and the journeys confirm it: chat ✓, join ✓, permissions ✗).
- **Example:** `h1: "Talk to a free AI that runs on people's own computers"` + 3 CTAs.
- **Difficulty: S–M. Benefit:** answers questions 1, 2 and 8 in under 10 seconds.
- **Measure:** axe `page-has-heading-one` → pass; time-to-first-click drops;
  J1/J5 still pass, J3 becomes findable.

---

## 7. Ten improvements over 90 days

Each: problem → why it matters → solution → example → difficulty → benefit → measure.

**1. Plain-English explainer for YES / MAYBE / NO** (Barrier 3)
Three sentences, on the page, above the counters: *"YES — the AI may do this without
asking. MAYBE — ask me first. NO — never."* Plus a live example of each.
**M · your governance model becomes legible · Measure:** a first-time visitor can
correctly predict what happens next in a 3-question test (see §9).

**2. Merge the three dashboards** (Barrier 4)
`/control.html` and `/dashboard.html` redirect into `/hivv-dashboard.html`.
**S · kills a whole category of wandering · Measure:** nav shows one "Control Center".

**3. Approval inbox for MAYBE**
Group pending permissions into one list with *what it wants / why / Approve once /
Approve for 30 days / Deny*. Your own design brief already specifies this.
**M · turns governance from a dashboard into an inbox · Measure:** time to first
approval < 60s; `pending approvals` cleared without help.

**4. Show the data journey per routing mode**
For each of private/trusted/fast/cheap/quality/balanced: where prompts, files and
credentials go, who can see them, what is retained — as a diagram, not a badge.
**M · answers question 6 properly · Measure:** users can name where their prompt went
after viewing (unmoderated 5-person test).

**5. First-run guide that is dismissible and remembered**
Three steps, once, stored locally: *say something → try a mode → look at what the AI
did.* **M · Barrier 5 · Measure:** `first_run_hint` present; skip rate logged.

**6. Activity feed in human sentences**
"10:42 — the AI read your file. 10:43 — it asked permission to send it. You said no."
**M · answers "can they see what the AI did on their behalf?" · Measure:** feed
renders without a single unexplained noun.

**7. Undo / revoke that is one click and visible**
Every action gets an undo for 10s; every grant shows a **Revoke** next to it.
**M · answers "can users recover from mistakes?" · Measure:** revoke reachable in ≤2
clicks from the Activity feed.

**8. Accessibility sweep: `<main>`, skip links, `<h1>` on all 45 pages**
The `.skip-link` class already exists and is unused. **S–M · Measure:** axe issues
70 → <15 (HIVV); every page exactly one `<h1>`.

**9. sitemap.xml + fix the robots.txt reference** (see §8)
**S · Measure:** `curl /sitemap.xml` → 200; both sites declare it.

**10. The Human Testing Laboratory on a schedule** (§9)
Five personas × five tasks, every release. **M ongoing · Measure:** completion rate
trends up, help-needed trends down.

---

## 8. robots.txt — correctness check (your final benchmark)

### HIVV — one real defect
```
Sitemap: https://hivv.org/sitemap.xml   →   HTTP 404 (0 bytes)
```
**robots.txt advertises a sitemap that does not exist.** Everything else is sound:
`Allow`/`Disallow` on API paths is sensible, and `/ai.txt` is declared.

### BLNQ — better than most, two gaps
- Rich **Cloudflare content signals**: `Content-Signal: search=yes, ai-train=no,
  use=reference`, plus explicit `Disallow` for `GPTBot`, `ClaudeBot`, `CCBot`,
  `Bytespider`, `Applebot-Extended`, `Google-Extended`, etc.
  **That is a genuinely thoughtful "helps all life" stance** — it opts out of training
  while allowing search.
- **No `Sitemap:` line at all**, and `/sitemap.xml` → 404.
- Has **`llms.txt` (HTTP 200)** — HIVV's is **404**.

### Both
| Check | HIVV | BLNQ |
|---|---|---|
| robots.txt reachable | ✅ 200 | ✅ 200 |
| `Sitemap:` declared | ✅ but **points at 404** ❌ | ❌ not declared |
| `/sitemap.xml` exists | ❌ 404 | ❌ 404 |
| `/llms.txt` | ❌ 404 | ✅ 200 |
| Blocks training crawlers | ❌ not declared | ✅ yes |

**Recommendation:** generate both sitemaps, fix HIVV's `Sitemap:` line, add HIVV's
`llms.txt`, and consider BLNQ's content-signal block for HIVV too — it is the
clearest machine-readable statement of "helps all life" either site currently makes.

---

## 9. The Human Testing Laboratory (permanent)

Five people, five tasks each, no assistance, every release.

| Persona | HIVV tasks |
|---|---|
| Technical person | start a conversation · change routing mode · approve a MAYBE · review AI activity · revoke a permission |
| **Nontechnical person** | same five |
| **Older adult** | same five |
| **Student / teacher** | same five |
| **Small-business owner** | same five |

| Persona | BLNQ tasks |
|---|---|
| All five | submit a job · find its results · verify the results · contribute a resource · understand their contribution |

**Measured per task:** completed? · seconds · times confused · needed help? ·
*what did they expect to happen that didn't?*

**Baseline today (from this audit's automated journeys):**

| | HIVV | BLNQ |
|---|---|---|
| Start a conversation | ✅ 1.0s | — |
| Change routing mode | ⚠️ visible, unexplained | — |
| Approve a MAYBE | ❌ guest = spectator, 0 buttons | — |
| Review AI activity | ⚠️ `No Activity Recorded` | — |
| Revoke a permission | ❌ not found | — |
| Submit a job | — | ✅ form found, **no instructions** |
| Find results | — | ⚠️ not tested |
| Verify results | — | ⚠️ `/trust.html` exists, clear copy |

**The one-line verdict: automation can prove the machine works; only people can
prove it makes sense.** Run the lab.

---

## 10. What was changed (explicitly, and only this)

Per your instruction *"explain this on the website and api"*:

| Change | File | Status |
|---|---|---|
| New page: the purpose benchmark | `public_html/purpose.html` | ✅ live (200) |
| New API: `GET /api/purpose`, `/checks`, `POST /flag` | `api/routes/purpose-routes.js` | ✅ live (200/201/400) |
| Route registration | `api/server.js` | ✅ gateway restarted, healthy |

- Page: exactly **one `<h1>`**, `<main>`, skip link, `lang`, viewport, meta
  description, no horizontal overflow, **19/20 links pass AA** (footer links were
  explicitly coloured after measurement caught them at 2.13:1).
- API: verified booting in **local/offline mode with no database**; validation
  enforced live (`400` on empty flag); returns a receipt even when not persisted.
- **Tests: 145 pytest · 113 node · 15 CLI · secret scanner CLEAN.**

### Flagged, NOT changed (needs your approval)
1. **Caddy `handle_errors` + BLNQ `404.html`** — production reverse proxy.
2. **Global `a { color }` in `styles.css`** — affects every page on HIVV.
3. **`sitemap.xml` generation + robots.txt fix** — both sites.
4. **`hivv_purpose_flags` table** — flags currently return `stored: false`; a
   migration is needed to persist them.
5. **Merging the three dashboards** — navigation change.
6. **Homepage rewrite** — content change.

---

## 11. Assumptions (explicitly not verified)

- Whether a **community organisation** could adopt it — no org persona was tested.
- Whether BLNQ's **"find results" and "verify results"** journeys complete — only
  *submit* was walked.
- **Screen-reader experience** — axe/structure were measured; no NVDA/VoiceOver run.
- Whether real users **understand the benchmark page** — needs the §9 lab.
- **BLNQ `Feedback` score (6.0) is a proxy**, not a measurement — BLNQ chat was not
  exercised end-to-end this run.

---

*Evidence: `/tmp/opencode/usability/` — `capture.json`, `journeys.json`,
`interactive.json`, `contrast.json`, `scores.json`, `shots/`, `journeys/`,
`interactive/.*
