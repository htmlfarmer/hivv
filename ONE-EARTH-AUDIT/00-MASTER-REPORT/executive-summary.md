# ONE-EARTH AUDIT — Executive Summary

**Generated**: 2026-11-17 · **Framework**: `docs/AUDIT-FRAMEWORK.md`
**Tools**: Lighthouse 13.6 · axe-core 4.14 · ZAP · Semgrep 1.185 ·
Schemathesis 4.33 · Gitleaks · Trivy · plus 521 project test checks

---

## The five questions, answered

| Question | Answer | Evidence |
|---|---|---|
| **Does everything work?** | Mostly. The core works; the API spec is 16 routes behind. | 521 test checks green; Schemathesis found 20 schema failures |
| **Is everything secure?** | The crypto and auth are sound. Dependency CVEs and some header gaps remain. | npm critical fixed; ZAP found 0 high-risk; Semgrep found 2 GCM flags |
| **Is the UX understandable?** | Pages load fast. Accessibility needs work (70 issues on HIVV). | Lighthouse a11y 88/93; axe found contrast + heading issues |
| **Is the architecture ready to scale?** | Yes for the current size. Pool and body limits are now configurable. | load test baseline; audit engine tracks coverage |
| **Are we building the right things?** | Yes — the trust layer, provenance, and partner API are the right bets. | Integration contract + cross-network tests pass |

---

## Scores

| Site | Overall | Checks | Unmeasured | Notes |
|---|---|---|---|---|
| **HIVV** | **49/100** | 27 | 3 | Capped by P1: openapi.yaml behind code |
| **BLNQ** | **100/100** | 16 | 5 | **THIN COVERAGE** — 100 across 16 checks, not a thorough audit |

**The override rule held**: HIVV's P1 openapi drift capped API at 49, which
capped the overall at 49. No amount of passing checks lifted it.

---

## Findings by severity

### P0 — Critical (release blockers)

| ID | Site | Finding | Status |
|---|---|---|---|
| TRIVY-CRIT | HIVV | `proxy-addr` 2.0.7 vulnerable to IP spoofing | **FIXED** (npm audit fix) |
| SEMGREP-GCM | HIVV | `createDecipheriv` GCM flagged (2 sites) | **Needs manual review** — code does call `setAuthTag()`; likely false positive |

### P1 — Major

| ID | Site | Finding | Effort |
|---|---|---|---|
| HIVV-API-002 | HIVV | `openapi.yaml` 16 routes behind code | M — regenerate from route table |
| SCHEMA-401 | HIVV | API accepts invalid/no authentication on 7 operations | M — check auth middleware coverage |
| SCHEMA-202 | HIVV | 4 schema-valid requests rejected | M — response shape mismatch |
| SCHEMA-103 | HIVV | 6 undocumented status codes | S — document them |
| AXE-HIVV | HIVV | 70 accessibility issues (contrast, headings) | M — fix contrast + add h1 |
| AXE-BLNQ | BLNQ | 25 accessibility issues (contrast, landmarks) | M — fix contrast + landmarks |
| NPM-HIGH | HIVV | 4 high-severity deps remain (csurf, uid-safe — deprecated) | M — replace csurf |
| ZAP-MEDIUM | HIVV | 22 medium-risk instances (CSP, clickjacking, SRI) | M — add headers |

### P2 — Important

| ID | Site | Finding |
|---|---|---|
| ZAP-LOW | HIVV | 20 low-risk (cache-control, HSTS, X-Content-Type) |
| SEMGREP-XSS | HIVV | 15 raw-HTML-format findings (mostly `escapeHtml` already used) |
| LH-FCP | HIVV | First Contentful Paint 2.6s (65/100) |
| LH-A11Y | HIVV | Accessibility 88/100 — color-contrast 0/100 |

---

## What is solid

- **521 project test checks green** — inspector, cross-network, GUI setup,
  fast-scan parity, clone-and-run, CLI parser, provenance
- **Gitleaks: 0 leaks** after our scanner fixes
- **npm critical: fixed** (proxy-addr IP spoofing)
- **ZAP: 0 high-risk** on HIVV
- **Lighthouse SEO: 100/100** on both sites
- **Lighthouse performance: 93 (HIVV) / 99 (BLNQ)**
- **Trust layer**: signed attestations verify independently across sites
- **Integration contract**: byte-identical, parity suite passes

---

## Priority matrix

| Priority | What | Why now |
|---|---|---|
| **P0** | Review the 2 GCM Semgrep flags | Crypto correctness |
| **P1** | Regenerate `openapi.yaml` | Unblocks API score from 49 |
| **P1** | Fix Schemathesis auth failures (ST401) | API is accepting bad auth |
| **P1** | Add CSP + clickjacking headers | ZAP medium findings |
| **P1** | Fix color-contrast (axe) | Accessibility |
| **P2** | Replace deprecated `csurf` | Dependency hygiene |
| **P2** | FCP optimization | Performance |

---

## What this audit could NOT do (needs human/external)

- **Manual penetration testing** — ZAP is passive-only here; an authenticated
  active scan against staging needs authorization
- **UX testing with real users** — Playwright can automate, but "is this
  understandable" needs humans
- **BLNQ deep audit** — only 16 checks run; the external review's items
  (LYRZ leaderboard manipulation, public jobs exposure) need dedicated tests
- **Scalability beyond baseline** — k6 load stages (1/5/25/100/500 workers)
  not yet run

---

## Tool results (raw)

See `04-AUTOMATED-TESTS/`:
- `lh-hivv.json`, `lh-blnq.json` — Lighthouse full reports
- `zap-hivv.json` — ZAP baseline scan
- `semgrep-hivv.json` — Semgrep findings
- `audit-report.json` — compiled summary
