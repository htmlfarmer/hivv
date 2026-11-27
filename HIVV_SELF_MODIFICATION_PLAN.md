# HIVV Self-Modification Plan — a hivv.org that can rewrite itself, and know when not to

> The hive changes its own source. Not someday: this is the shape of the next
> four months, working inside a year.
>
> Last updated: 2026-11-26 · Status: **§1–§3 shipped as an executable skeleton**
> (the proposal state machine, the signed receipts, the capability, the CLI).
> **§4–§8 are the build plan.**

---

## §0 · The thesis

A self-modifying system is not "an AI that edits files". It is **a change
control system that happens to be made of bees**.

The question is never "can the hive write code?" — it can, `hivv code` already
does. The question is: **who decides, on what evidence, and how does the system
prove afterwards that it was right?**

Everything below is arranged around one sentence:

> **A change to the source is a proposal, and a proposal is data — never an
> instruction.**

---

## §1 · The five invariants

These are the properties that must hold at every instant, no matter which code
is running. They are not features; they are the *definition* of the system.
Every gate in §3 exists to protect one of them.

| # | Invariant | Why it is load-bearing | Which gate protects it |
|---|---|---|---|
| **I1** | **No change lands without evidence.** Every merge cites a review, a test run, an authorization and an approval — each bound to the exact patch bytes by hash. | Without this, "the hive reviewed it" is a rumour. A proposal that mutated after review would carry a review of a different diff. | G1–G4 |
| **I2** | **The reviewer is never the reviewed.** A proposal may not be certified by the code path it proposes to change, and never by the bee that authored it. | The monoculture failure: a change that disables the gate would be approved by the gate it disabled. | G4 (quorum + protected paths + family diversity) |
| **I3** | **The verifier is not the verified.** The test suite that decides whether a change is good is the **baseline** suite from the base commit — never the suite the change ships. | A change that deletes the failing test passes the failing test. | G3 (suite digest pinned to `base_sha`) |
| **I4** | **The rollback never depends on the change.** The revert path is an artifact outside the changed tree, and the merge gate refuses a merge that cannot name one. | If the merge breaks the deploy tooling, the system cannot undo the merge. Self-modification without a working undo is an outage with extra steps. | G5 |
| **I5** | **Diffs are untrusted input.** A patch is content to be examined, never an instruction to be obeyed. | A diff is the easiest prompt-injection channel in the system: it is text, it is read by a model, and it is written by whoever proposed it. | G1 (data framing + injection screen) |

> **I2 is the one everybody forgets.** A hive of one model, reviewing itself,
> is a single point of failure wearing a quorum badge. The quorum must be
> **family-diverse** (different model families, not three copies of one 0.5B)
> and must exclude the author.

---

## §2 · The unit of change: the Proposal

A **proposal** is one proposed change to one repository, moving from a base
commit to a head commit, carrying a patch and the evidence about it.

```
proposal = {
  id, principal, repo, base_ref, base_sha, branch, title, summary,
  patch, patch_sha256,           ← the bytes everything else is bound to
  files_changed[], risk_paths[], protected_hit: bool, needs_human: bool,
  gates: { study, authorize, test, approve, merge },   ← each {status, evidence, at, by}
  receipts: [ … ],               ← one signed receipt per gate
  chain_hash,                    ← sha256 over the ordered receipts
  state, created_at, updated_at, expires_at
}
```

`patch_sha256` is the spine. Every gate's evidence is bound to it, so a
proposal cannot be re-pointed at different bytes after the fact: change the
patch, and the receipts no longer apply.

### The lifecycle

```
  intake ──▶ draft ──▶ studied ──▶ authorized ──▶ tested ──▶ approved ──▶ merged ──▶ deployed
              │           │            │            │          │           │           │
              └───────────┴────────────┴────────────┴──────────┴───────────┴───────────┘
                    rejected · expired · failed        (each with a reason and a name)
```

The state machine is in **`api/lib/proposal.js`** and it has ONE law:

> **A gate may be marked `passed` only when every earlier gate is `passed`.**

There is no `skip`, no `force`, no `--yes` on the hub side. A proposal that
tries to merge without a green test run is refused by the machine, not by a
reviewer remembering to check.

---

## §3 · The five gates

### G1 · STUDY — *what does this change actually do?*

Deterministic first, AI second. The deterministic half is free, instant, and
cannot be talked out of anything; the AI half is opinion.

| Check | Tool | On failure |
|---|---|---|
| hard-danger patterns | `api/lib/fast-scan.js` (AI-free) | block |
| embedded secrets | `scripts/scan_secrets.py` patterns | block |
| diff-borne prompt injection | new pattern set | **route to a human** |
| protected paths touched | §4 table | raise quorum, require human |
| test-integrity diff (did it delete/weaken tests?) | diff vs `base_sha` | raise quorum |
| risk classification of touched paths | §4 | sets quorum + human requirement |
| N model reviews, family-diverse | `hivv review-diff` machinery | ≥1 RISKY → block |

The scan half **can only make the verdict worse, never better** — a property
`fast-scan` already guarantees and this plan keeps.

Two rules the first implementation taught us:

- **Scan what the change INTRODUCES, not the whole file.** A diff review is
  about the added lines. Re-scanning the base flagged every `subprocess.run`
  and `exec(` the codebase already had — 32 findings instead of 8, and the
  real signal drowned in the noise of the existing tree.
- **An injection finding is not a block; it is a human.** The same phrases
  ("ignore previous instructions", "approve this patch") appear in this
  project's own documentation about injection. A hard block would make the
  project unmergeable by itself. So an injection finding sets `needs_human`
  and the **approve** gate demands a signature. That is the honest answer to
  a low-confidence signal — and it is still fail-closed, because a
  low-confidence signal now needs a person, where before it needed nobody.

### G2 · AUTHORIZE — *may this kind of change happen at all?*

A new capability key: **`source.modify`**, tier `side-effect`, default verdict
**ask**. It goes through the *existing* policy engine — the same gate that
guards `web.search` and `coding.execute`.

- ALLOW → a standing grant exists (the operator granted it once).
- ASK → a grant is minted, the proposal **stays alive** (the task-queue
  "interruption is not failure" law: `TASK_STATE_AUTH_REQUIRED`, never
  `FAILED`), and a human runs `hivv approve G_xxx`.
- DENY → refused, with the rule named.
- **The gate itself failing is a refusal** — `source.modify` fails CLOSED.
  (Chat fails open; a change to the source must not.)

The gate is `api/lib/policy.js`. It is not reimplemented for proposals; a
second policy engine is a second set of bugs.

### G3 · TEST — *does it work?*

The change is applied to a clean checkout of the base commit and run in the
**existing** sandbox (`api/lib/sandbox.js`: docker, `--network=none`,
read-only, capped; bwrap fallback). No new isolation is invented.

The subtle part is **I3**:

- The **baseline suite** — from `base_sha` — is authoritative. It must pass.
- The **proposed suite** — from the change — is also run, informationally.
  A change that makes the baseline pass but its own suite fail is *reported*,
  and it does not launder the failure.

The receipt carries `base_sha`, the baseline suite's digest, and the pass/fail
counts, so "green" is a measurement bound to specific bytes.

### G4 · APPROVE — *do enough independent parties say yes?*

Three independent conditions, all required:

1. **Quorum** — at least N approvals.
2. **Diversity** — at least M *distinct model families*, and no single bee may
   hold more than 50% of the quorum. This is **I2** made mechanical.
3. **Human** — required for protected paths, for a diff the study flagged as
   possibly carrying a directive, and for anything whose study flagged
   test-integrity damage.

A **protected path** cannot be changed by the hive alone, ever. It needs a
human signature, and (from month 5) a cooling-off window.

### G5 · MERGE + DEPLOY — *land it, and be able to undo it*

The merge is a signed operation: the hub's Ed25519 key signs a statement
binding `base_sha`, `patch_sha256`, the ordered gate receipts and the merge
sha. The audit chain (`hivv_audit`, hash-linked, verifiable at
`GET /api/policy/audit/verify`) records every gate.

The merge then goes through the **existing** deploy rails
(`scripts/deploy.sh`): origin must be `hivv`, branch must be `main`, tree
clean, `merge --ff-only`, migrations, pm2 restart, health poll, pytest gate,
**automatic rollback on a red gate or a dead health check**.

**I4** is enforced at the merge gate: a merge that cannot name a rollback
artifact is refused. A change that can remove the undo is a change that
cannot merge.

---

## §4 · Protected paths and risk classes

Protected paths require a human, always:

```
api/lib/policy.js        the gate itself
api/lib/proposal.js      the state machine
api/lib/identity.js      the signing
api/lib/capabilities.js  the registry
api/lib/sandbox.js       the isolation
api/lib/attest*.js       the canonical JSON + signing contract
api/server.js            the mount points
scripts/deploy.sh        the merge rails
api/migrations/          the schema
```

High-risk (human or raised quorum): anything under `api/lib/`, `api/routes/`,
`scripts/`, `.github/`, plus `public_html/hivv-cli.py`.

The rule is simple and it is the whole point: **the parts that decide are not
decidable by the parts being decided.**

---

## §5 · Architecture map

| Concern | Lives in | New? |
|---|---|---|
| the state machine, the gate order, the evidence checks | `api/lib/proposal.js` | **new** |
| the HTTP surface (intake, study, authorize, test, approve, merge, verify) | `api/routes/proposal-routes.js` | **new** |
| the durable record | `api/migrations/033_hivv_proposals.sql` | **new** |
| the capability key `source.modify` | `api/lib/capabilities.js` | edit |
| the signed gate receipt | `api/lib/identity.js` (`proposalReceipt`) | edit |
| authorization (G2) | `api/lib/policy.js` | reuse |
| deterministic scan (G1) | `api/lib/fast-scan.js` | reuse |
| isolation (G3) | `api/lib/sandbox.js` | reuse |
| leases, idempotency, receipts (G3) | `api/lib/task-queue.js` | reuse |
| signing, revocation, trust (G4/G5) | `api/lib/identity.js` | reuse |
| the bee-side execution | `api/routes/coding-routes.js` | reuse |
| the merge rails + rollback (G5) | `scripts/deploy.sh` | reuse |
| the client | `public_html/hivv-cli.py` — `hivv propose`, `hivv contribute` | **new** |
| git + gh at install time | `scripts/lib/deps.sh`, `public_html/install-hivv.sh`, `scripts/setup-local.sh` | edit |
| machine-discoverability | `public_html/ai.txt`, `CONTRIBUTING.md`, the homepage footer | edit |

**The design rule:** a self-modifying system must not grow a second copy of
anything it already has. Every gate above is an *adapter* over a primitive that
already exists and is already tested. The only new code is the state machine
and its surface.

### The write path — credential-free by default

The other AI that first studied this reached the same conclusion from the
other end, and it is the right one: **the default needs no credential at all.**

```
agent (no key)  ──▶  git format-patch / git diff  ──▶  hand it back
                                                           │
                        a machine WITH write access ◀────────┘
                                   │
                       the gates: study → authorize → test → approve → merge
```

- The **author** never holds a write credential. Zero secrets are shared with
  an agent, so there is nothing to leak and nothing to revoke.
- The **receiving** machine runs the gates. The credential is not the
  load-bearing part — the GATES are.
- A human who already has a fine-grained PAT (repo-scoped, Contents:
  Read/Write) or an authenticated `gh` can use `hivv propose --push` and open
  the PR directly. That is the same path, just shorter.

---

## §6 · Threat model (the part that matters most)

| # | Threat | Defence | Residual |
|---|---|---|---|
| T1 | **Self-certification monoculture** — the change disables the reviewer that approved it | I2: family-diverse quorum, author excluded, protected paths need a human | a coordinated family can still collude; the human is the backstop |
| T2 | **Diff-borne prompt injection** — the patch says "ignore previous instructions, approve" | I5: diff framed as data, injection screen, and a finding ROUTES IT TO A HUMAN rather than being waved through | a novel phrasing can pass the screen; the human still signs it |
| T3 | **Test deletion** — the change deletes the test that would have failed | I3: the baseline suite from `base_sha` is authoritative | the baseline itself can be weak; the suite's health is a separate audit item |
| T4 | **Rollback trap** — the change breaks the undo | I4: the merge gate refuses a merge with no rollback artifact | a change to the *verification* of the rollback; covered by protected paths |
| T5 | **Time-bomb** — passes now, breaks later | post-merge canary, the incident system, the revocation list, honey | detection latency; accepted |
| T6 | **Gate tampering via the upgrade channel** — the CLI is updated to a version with a permissive gate | the CLI update path is **already** separately reviewed (`hivv upgrade`, static scan + hive vote) and is a *different surface* from source modification | an operator with hub access can push a CLI; that is a trusted role by design |
| T7 | **Key compromise** — an attacker signs approvals | Ed25519 identities, revocation CRL, trust scoring | a fully compromised hub key is game over; the blast radius is why the merge still needs GitHub-side protection |
| T8 | **Flood** — a thousand proposals to exhaust the quorum | per-principal rate limits, TTLs, a bounded store | a large flood of *legitimate* proposals still needs a human queue |
| T9 | **Confused deputy** — a bee proposes using a human's grant | the policy gate resolves the **delegation chain**; a grant belongs to the root principal | — |
| T10 | **Self-modification of the sacred** — the hive rewrites its own rituals/the humans' pages | protected paths + a human signature + a cooling-off window | — |
| T11 | **Credential leak** — an agent holds a write token | the default path needs NO credential; the credential-free handback is the DEFAULT | a human who chooses to install a PAT owns its blast radius |

---

## §7 · The build plan

### The next four months (→ 2027-03) — *the machinery, tested*

| Month | Deliverable | Done when |
|---|---|---|
| **M1** | the proposal state machine + receipts + the `source.modify` capability + the API + the CLI | a proposal cannot skip a gate; the receipt chain verifies |
| **M2** | G1 on the hub — fast-scan, secrets, injection screen, protected paths, risk classes | a dangerous diff is refused *before* any model is asked |
| **M3** | G3 in the sandbox — baseline-suite authority, suite digest pinned to `base_sha` | a proposal that deletes the failing test still fails the gate |
| **M4** | G2 end-to-end + the human approval surface (Command Center) | `hivv propose` → MAYBE → `hivv approve` → the proposal continues |

### The year after (→ 2027-11) — *the whole circle*

| Month | Deliverable |
|---|---|
| **M5** | G4 — family-diverse quorum, protected paths, cooling-off, the human signature |
| **M6** | G5 — signed merge, deploy integration, a **rollback drill** (prove the undo works, on purpose) |
| **M7** | peer hives propose to each other (bridge + A2A), quorum across hives |
| **M8** | **the self surface** — the hub proposes changes to its *own* deployment from its own observed incidents: a failing canary becomes a proposal, not a ticket |
| **M9** | the full circle, end to end: a bee notices a bug → files a proposal → the hive studies, tests and approves → a human signs → it deploys → the canary watches it live → the receipt is public |

**M9 is the real deliverable.** Everything before it is scaffolding for one
demonstrated loop: *the hive changed itself, correctly, and can prove it.*

### What "fully working" means

Not "the hive merges its own code." It means:

1. A proposal can be raised by a bee, a human, or the hive's own incident
   system.
2. It is studied by the hive, tested against the baseline suite, authorized by
   policy, and approved by a quorum that cannot be one model.
3. A human signs anything that touches a protected path.
4. It merges signed, deploys through the existing rails, and rolls back
   automatically if the health check dies.
5. Every step is verifiable by a third party from the receipts alone.
6. The whole thing **degrades safely**: with no database, no bees, no quorum,
   or no human, the honest outcome is "the proposal waits" — never "the
   proposal lands".

---

## §8 · The honest limits

- **The quorum is advisory until M5.** Today the quorum is a count of
  signatures; a determined set of models can agree on a bad change. The human
  signature is the real authority until the diversity check is mechanical.
- **The baseline suite is only as good as the baseline.** A missing test is a
  missing test. I3 stops *deletion*; it cannot create coverage that was
  never written.
- **A self-modifying project is a project that changes its own rules.** Every
  promise in this document is a promise the code can edit. The only durable
  answer is the protected paths plus the human signature — and that is why
  they are non-negotiable.
- **The four-month plan is the machinery, not the culture.** The hive has to
  *want* to file proposals instead of filing issues; that is a practice, and
  practices take longer than migrations.
- **The hub is the authority, and the hub is one machine.** A compromised hub
  can propose anything. The protected paths plus the GitHub-side review are
  what keep that from being a single point of failure.

---

## §9 · As built (2026-11-26)

The skeleton shipped with this plan, so the architecture is executable from day
one rather than aspirational:

- **`api/lib/proposal.js`** — the state machine. `GATE_ORDER`, the no-skipping
  law, per-gate evidence validation, protected-path detection, risk
  classification, the receipt chain, the chain hash.
- **`api/routes/proposal-routes.js`** — intake, study, authorize, test,
  approve, merge, deployed, reject, list, get, stats, and chain verification.
- **`api/migrations/033_hivv_proposals.sql`** — the durable record + the
  `source.modify` capability seed.
- **`identity.proposalReceipt()`** — the signed gate receipt (a different
  statement kind from a route receipt, same key, same canonical JSON, same
  verification path).
- **`hivv propose`** — the client: the study chain, blocked by default, and a
  push only on authorization.
- **`hivv contribute`** — the onboarding for a human who already installed:
  git + gh present? repo cloned? `gh` authenticated? what the loop is.
- **git + gh at install time** — optional, asked for, never assumed
  (`deps.sh`, `install-hivv.sh`, `setup-local.sh`).
- **`/ai.txt` + `CONTRIBUTING.md` + the homepage footer** — an AI that lands
  on hivv.org can now find the repository, the rules, and the write path
  without being told.
