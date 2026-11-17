# HIVV + BLNQ Engineering Audit Framework

> **Purpose**: answer five questions with evidence, not opinion.
>
> 1. Does everything work correctly?
> 2. Is everything secure?
> 3. Is the user experience understandable?
> 4. Is the architecture ready to scale?
> 5. Are we building the right things?
>
> **Rule**: a beautiful website with a broken backend is not a successful
> product. A technically impressive API that developers cannot understand or
> safely use needs work. **No overall score may hide a critical failure** —
> a site scoring 90/100 with a serious auth vulnerability is not ready.

## Structure

Three audits, in order:

| # | Audit | Scope |
|---|---|---|
| 1 | **HIVV site** | `/var/www/vhosts/hivv.org` — the 12 categories below |
| 2 | **BLNQ site** | `/var/www/vhosts/blnq.org` — the 12 categories below |
| 3 | **Integration** | the HIVV ↔ BLNQ contracts (`docs/INTEGRATION-CONTRACT.md`) |

## The 12 categories

Each category gets: **score 0–100 · evidence · problems · severity ·
recommended fix · estimated effort · verification test.**

| # | Category | What we examine | Importance |
|---|---|---|---|
| 1 | Website and UX | Navigation, pages, usability, workflows | High |
| 2 | Functionality | Every button, form, feature and interaction | Critical |
| 3 | API | Every endpoint, request, response and error | Critical |
| 4 | Security | Authentication, authorization, vulnerabilities | Critical |
| 5 | Privacy | Data collection, exposure, retention and deletion | Critical |
| 6 | Architecture | Backend, frontend, databases, services | Critical |
| 7 | Performance | Speed, latency, concurrency and resource usage | High |
| 8 | Reliability | Recovery, outages, retries and failure handling | Critical |
| 9 | Developer experience | Documentation, SDKs, CLI, installation | High |
| 10 | SEO and discoverability | Search engines, metadata, indexing | Medium |
| 11 | Accessibility | Keyboard navigation, contrast, screen readers | High |
| 12 | Scalability | Infrastructure, bottlenecks, costs and growth | High |

### Scoring rubric

| Score | Meaning |
|---|---|
| 90–100 | Production-ready; automated tests cover the critical paths |
| 70–89 | Works, but a known gap needs a fix before scale |
| 50–69 | Functional but fragile; a real user would hit problems |
| 30–49 | Broken in a way that matters; fix before promoting |
| 0–29 | Critical failure; block release |

### Severity levels

| Level | Meaning | Blocks release? |
|---|---|---|
| **CRITICAL** | Security hole, data loss, or total feature failure | **Yes** |
| **HIGH** | Significant broken behaviour or exposure | Yes, unless mitigated |
| **MEDIUM** | Noticeable gap; users work around it | No |
| **LOW** | Polish; fix when convenient | No |

### The override rule

A category score **cannot** be raised above its highest open CRITICAL
finding. If Security has a CRITICAL finding, Security is ≤ 29 regardless of
how many other checks pass. The overall grade is the **minimum** of the
category scores, not the average.

## Current status (living document)

Scores are produced by `scripts/audit.py` from test evidence. Run:

```bash
python3 scripts/audit.py            # full audit, both sites
python3 scripts/audit.py --site hivv
python3 scripts/audit.py --site blnq
python3 scripts/audit.py --json     # machine-readable for CI
```

### Coverage map — what already produces evidence

| Category | Existing evidence |
|---|---|
| 2 Functionality | `tests/inspector.py` (50 checks), `tests/local_install/` (33) |
| 3 API | `tests/inspector.py` anonymous-access group, `openapi.yaml` (needs regen) |
| 4 Security | `tests/inspector.py` isolation/policy groups, `scripts/scan_secrets.py` |
| 5 Privacy | `api/lib/node-privacy.js`, provenance projections, `tests/request-provenance` |
| 6 Architecture | `docs/INTEGRATION-CONTRACT.md`, `api/lib/bee-identity.js` |
| 7 Performance | `scripts/loadtest.py`, p95 latency measurements |
| 8 Reliability | `tests/test_cross_network.py` (outage recovery), inspector resilience group |
| 9 Developer experience | `docs/INSTALL.md`, `docs/PARTNER-API.md`, `docs/GUI-SETUP.md`, clone-and-run suite |
| 10 SEO | — not yet audited |
| 11 Accessibility | — not yet audited |
| 12 Scalability | — not yet audited (load test gives a baseline) |

### Items the external review flagged — tracking

| Item | Site | Category | Status |
|---|---|---|---|
| Run interface has minimal visible instructions | BLNQ | 1 UX | open |
| Public jobs interface — info exposure | BLNQ | 5 Privacy | open |
| Public trust verification — independent check | BLNQ | 3 API | **done** — `tests/test_cross_network.py` verifies signatures independently |
| LYRZ leaderboard — score manipulation | BLNQ | 4 Security | open |
| Privacy claims vs actual routing | HIVV | 5 Privacy | partially done — `docs/PARTNER-API.md` documents receipts; needs homepage copy |
| Public AI key donation — auth + isolation | HIVV | 4 Security | **done** — `api/lib/key-donation.js` (SSRF, caps, donor limits) |
| Multiple routing modes — privacy guarantees | HIVV | 5 Privacy | open — needs per-mode data-flow documentation |
| Public node information | HIVV | 5 Privacy | **done** — `api/lib/node-privacy.js` three tiers |
| One-command install integrity | Both | 9 DX | **done** — clone-and-run suite, 33 checks |

## How to add a finding

Append to the relevant site's section with:

```
### [SEVERITY] one-line summary
- **Category**: N — name
- **Evidence**: what was measured, with the command to reproduce
- **Problem**: what is wrong, concretely
- **Fix**: the recommended change
- **Effort**: S / M / L / XL
- **Test**: the check that proves it is fixed
```

## How to re-score

```bash
python3 scripts/audit.py --json > /tmp/audit.json
```

CI compares the new score against the committed baseline. A category that
drops, or a new CRITICAL finding, fails the build.
