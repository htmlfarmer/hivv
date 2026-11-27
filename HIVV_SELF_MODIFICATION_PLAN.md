# HIVV Self-Modification Plan

How the hive studies, authorizes, tests and approves changes to its own
source — and how a bee proposes one.

This is the document [`CONTRIBUTING.md`](CONTRIBUTING.md) links to. It
describes two halves that meet at one boundary:

| half | file | owns |
|---|---|---|
| **the funnel** (intake) | `api/lib/proposal-funnel.js` | what a bee SAID, and whether it may be filed |
| **the machine** (gates) | `api/lib/proposal.js` | what happens to a filed change, up to a merge |
| **the relay** (I/O) | `api/lib/github-relay.js` | the only write path to GitHub |

---

## The one design law

> **Nodes never hold a GitHub credential. The hub holds exactly one, behind
> a policy gate.**

Every proposal is signed, rate-limited, deduplicated, screened and
reversible. That is the only design where one secret leaks instead of N,
spam is bounded, it works behind NAT, and it reuses the trust machinery the
hive already built.

`hivv propose --push` exists only to refuse: the node may not push a branch.

---

## Stage 1 — the node: `hivv propose`

```bash
hivv propose "tools server never refreshes a stale helper" \
     --evidence "pid 42335 ran hivv-tools.py from Sep 16" \
     --patch changes.diff
```

The node does exactly **two** things: it signs, and it reports.

The envelope is the same Ed25519 identity block that registers the bee —
`kind: proposal.create` — so verification, the CRL, replay protection and
principal binding all come from `identity.verifyIncoming` with no new crypto.

```jsonc
{ "algorithm": "ed25519", "public_key": "…",
  "statement": { "v": 1, "kind": "proposal.create", "node_id": "…",
                 "ts": 1795753519, "nonce": "…",
                 "type": "suggestion|bug|patch",
                 "title": "…", "body": "…", "evidence": "…", "patch": "…" },
  "signature": "…" }
```

> **Why not `attest.js`?** Its `KINDS` whitelist is a byte-identical copy of
> blnq.org's, pinned by a parity test — adding a kind there is a cross-site
> contract change. `identity.verifyIncoming` takes the kind from the caller
> and already does everything a proposal needs.

---

## Stage 2 — the hub: the funnel

`POST /api/proposals` runs six stages **in order**, and the order is law.
**A stage may only make the outcome worse — nothing at intake approves
anything.**

| # | stage | what it does |
|---|---|---|
| 1 | **verify** | `identity.verifyIncoming` — who said it, CRL, replay |
| 2 | **limit** | `RateLimiter` per node per day — bounded spam |
| 3 | **dedupe** | `sha256(normalize(title+body))` — five bees, **one** issue, +5 votes |
| 4 | **screen** | `fastScan()` — free, deterministic; secrets/hard patterns reject |
| 5 | **review** | model board → `SAFE · REVIEW · RISKY`, recorded in `review-registry` |
| 6 | **policy** | `github.write` → **auto-file** / **needs-human** / **never-file** |

### Three laws the funnel keeps

- **A · A stage may only weaken.** The screen and the board can send a
  proposal DOWN to a human; nothing sends one UP to approval.
- **B · No data is not data.** A board that gets no answer reports `REVIEW`,
  never `SAFE`. "Nobody looked" and "everybody agreed" are different truths.
- **C · Fail closed.** A stage that throws is a stage that could not decide,
  and a proposal that could not be decided goes to a human.

### Dedupe is the hive's actual advantage

Five nodes with the same idea become **one** issue carrying five identities.
A vote is `{node_id, principal, at}` — a *list*, not a counter: a number can
be inflated by a loop, a list of principals can be audited. The same bee
voting twice counts once.

### The model board

Real models from real bees (`orchestrator.nodes → local_models`), one per
**family**, so three votes are three brains and not the same brain asked
three times. An unrecognised model name is its own family — collapsing to
"unknown" would fake diversity.

---

## Stage 3 — `api/lib/github-relay.js`, the only secret-holder

`createIssue · ensurePR · comment · close`, all idempotent via the marker

```html
<!-- hive-proposal:<id> -->
```

so a retry can never double-post. The branch name is deterministic
(`hive/proposal-<id>`) so a re-approval reuses it rather than littering the
repo.

**It must be stubbable.** With no `HIVV_GITHUB_TOKEN` it writes JSON files
to `$HIVV_DATA_DIR/github-stub/`. That one property is what makes the
pipeline fast, easy and fun: the entire loop runs offline with zero secrets,
CI tests it end-to-end, and nobody waits on a credential to start.

---

## Stage 4 — the feedback loop

```bash
hivv proposals                 # what I sent, and where each got to
hivv proposals --contributors  # who is changing the hive
```

`GET /api/proposals/mine` answers with this bee's rows. A merged one prints

```
✓ merged — lands in your next hivv update
```

Every new vote is commented back onto the issue with the bee, its verdict
and the running count — **public provenance**. A merged proposal earns honey
(`honey.award`, `kind: proposal_merged`) and shows up in
`GET /api/proposals/contributors`.

---

## Stage 5 — the closed loop

```
approved  → relay.ensurePR   → branch + PR (the hub is the only writer)
merged    → scripts/deploy.sh → test gate + rollback (the EXISTING rails)
          → scripts/sync-mirrors.sh
          → every bee on its next `hivv update`
```

`HIVV_PROPOSAL_AUTODEPLOY=1` runs `deploy.sh` on merge. **Default OFF** —
`deploy.sh` restarts the gateway, so an accidental merge would take the
request down mid-flight. Either way the route returns `next_step` with the
exact commands, so the loop is never a mystery.

---

## The gates (the back half)

A gate may be marked `passed` **only when every earlier gate is `passed`**.
There is no skip, no force, no override — the machine refuses
(`gate_out_of_order`), not a reviewer remembering to check.

```
study → authorize → test → approve → merge
```

| gate | evidence |
|---|---|
| **study** | deterministic findings empty, no `RISKY` vote |
| **authorize** | `policy.gate(source.modify)` — the machine asks, never the caller |
| **test** | the **baseline** suite digest recorded at intake, and 0 failures |
| **approve** | quorum 2 · two families · no bee over half · never the author |
| **merge** | signed, bound to the patch bytes, with a rollback artifact |

### The guardrail (non-negotiable)

Files that **gate nodes** always require a human, **no matter the vote
count**:

```
api/lib/policy.js        api/lib/attest.js       api/lib/node-auth.js
api/lib/fast-scan.js     .keys/                  api/migrations/
```

One compromised bee must never rewrite the thing that decides whether bees
are trusted. Fail closed, per [`CONTRIBUTING.md`](CONTRIBUTING.md) rule #2.

---

## Running it

```bash
# send one
hivv propose "what I noticed" --evidence "what I saw"

# watch them
hivv proposals

# the hub's view
curl -s localhost:3011/api/proposals
curl -s localhost:3011/api/proposals/stats
curl -s localhost:3011/api/proposals/contributors
```

Local-first: with no Postgres the store is memory plus the file-backed
identity/relay stubs, and the policy gate answers `local:offline`. The whole
loop runs with no database, no internet and no secrets.

Tests: `api/tests/proposal-funnel.test.js` (31) and
`tests/test_propose_cli.py` (14).
