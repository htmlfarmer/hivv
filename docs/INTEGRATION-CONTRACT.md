# HIVV ↔ BLNQ Integration Contract

> **Version 1.0** · This document is the agreement between two independent
> projects. Neither may change a shared behaviour without the other agreeing.

## Why this exists

HIVV and BLNQ both grew a distributed AI network, and they grew **overlapping
infrastructure**: both have a node registry, both sign attestations, both
expose an OpenAI-compatible endpoint, both relay jobs to peers behind NAT.

That overlap is not a bug to be removed — it is a **specialisation** to be
organised. The two projects are good at different things:

- **HIVV** is the *reasoning and orchestration* network: routing, policy,
  capabilities, human permissions.
- **BLNQ** is the *execution and verification* network: running code safely,
  analysing it, proving what happened, accounting for the work.

Neither should build the other's half. This contract says who owns what and
exactly how they meet.

---

## The ownership table

| Capability | Owner | Integration |
|---|---|---|
| **AI reasoning** | HIVV | Requests BLNQ services |
| **Code analysis** | BLNQ | Returns signed analysis |
| **Code execution** | BLNQ | Receives authorized jobs |
| **AI orchestration** | HIVV | Selects appropriate agents |
| **Validator coordination** | BLNQ | Provides independent verdicts |
| **Human permissions** | HIVV | Authorizes consequential actions |
| **Execution verification** | BLNQ | Returns signed attestations |
| **Contribution accounting** | BLNQ / LYRZ | Records verified work |
| **Global impact reporting** | HIVV | Visualizes outcomes |

Read it as a loop:

```
        ┌──────────────────────────────────────────────┐
        │                                              │
   HIVV │  policy gate ──► authorized job ──► BLNQ    │
        │  orchestrator      (signed, scoped)  executor │
        │  impact dashboard ◄── verified work ──► ledger│
        │                          ▲                    │
        │                          │                    │
        └──────────────────────────┴────────────────────┘
                   signed attestations, same schema
```

---

## The four shared contracts

There are exactly **four** things the two projects share. Everything else is
owned by one side.

### 1. The attestation envelope

**Owner:** BLNQ (the schema) · **Both** (implement it)

The canonical definition lives in `api/lib/attestation-contract.json` on
BOTH sides, duplicated on purpose — neither project may depend on the other's
files, because one deployment must never be able to take the other down.

| Field | Value |
|---|---|
| Contract | `blnq.attestation.v2` |
| Envelope version | `2` |
| Principal prefix | `hivv_` + 32 hex key fingerprint |
| Legacy prefix | `pri_` — read/verify only, never issued anew |
| Signature | Ed25519, 64 bytes, base64 |
| Canonical JSON | UTF-8 byte key order, no whitespace, **safe integers only** |
| Kinds | `source.review`, `run.request`, `io.record`, `run.record` |

**Changing this requires both sides.** See the change checklist in
[§ Changing the contract](#changing-the-contract).

### 2. The bee identity

**Owner:** both (one protocol, two transports)

One canonical identity — `bee_id` — with one enrolment credential. The id may
travel in the URL (HIVV style) or in the body (BLNQ style); both are accepted,
and the body wins on conflict because the body is what a bee signs over.

```
HIVV:  POST /api/nodes/{bee_id}/heartbeat
BLNQ:  POST /api/agents/{id}/inbox   { bee_id | worker_id | node_id }
```

Enrolment proof: the per-bee secret (`X-Node-Secret`) **or** the machine id
(`hw_id`) the bee enrolled with.

**Anti-squatting:** claiming an id the hub already knows requires proving it
is that bee. Before this rule, anyone could `POST` a registration for an
existing bee's id and inherit its inbox, its relay jobs, and its honey streak.

### 3. The policy receipt

**Owner:** HIVV · **Both** (header + body)

HIVV is the authority on *whether an action may happen*. BLNQ is the
authority on *whether the action was safe*. They meet at the receipt.

```http
X-Hivv-Policy: ALLOW default:compute
```

The body equivalent is `body.policy_verdict` plus `body.policy_receipt`.

| Verdict | Meaning | Who may proceed |
|---|---|---|
| `allow` | A policy rule permitted it | The executor |
| `ask` | A human must approve | **Nobody**, until a grant exists |
| `deny` | A policy rule refused it | Nobody, ever |

A `MAYBE`/`ask` verdict is not a soft no — it is a hard stop until
`hivv approve <grant_id>`.

### 4. The execution receipt

**Owner:** BLNQ · **HIVV** (consumes it)

BLNQ runs the code and returns a signed `run.record`. HIVV consumes it for
ledger, impact reporting, and policy accounting.

```json
{
  "kind": "run.record",
  "subject": "<sha256 of run_id>",
  "body": {
    "run_id": "…",
    "status": "completed",
    "exit_code": 0,
    "duration_ms": 8421,
    "cpu_ms": 8421,
    "bytes_in": 2048,
    "bytes_out": 512,
    "source_sha256": "<the exact code that ran>"
  }
}
```

The `source_sha256` is what makes the record meaningful: it binds the result
to the exact bytes that produced it.

---

## The integration flow, step by step

### 1. A request arrives at HIVV

HIVV's policy gate decides whether the action is permitted at all. It emits a
receipt. **HIVV does not decide whether the code is safe** — that is BLNQ's
job.

### 2. HIVV needs code analysed or executed

HIVV asks BLNQ for a signed `source.review`:

```http
POST https://blnq.org/api/attest/principal     (one time)
POST https://blnq.org/api/attest
{
  "envelope": { "kind": "source.review", "subject": "<sha256>", … },
  "signature": "<base64>",
  "script_id": "scr_…"
}
```

BLNQ verifies the envelope against the validator's registered key and stores
it. The signed review is then independently verifiable by anyone.

### 3. HIVV dispatches an authorised job

HIVV does not run untrusted code. It hands BLNQ a **scoped, policy-checked**
job:

```http
POST https://blnq.org/api/jobs
{
  "script_id": "scr_…",
  "args": ["--json"],
  "stdin": "…",
  "policy": { "verdict": "allow", "receipt": "ALLOW default:compute" }
}
```

BLNQ executes it in its sandbox (no network, read-only filesystem, CPU and
memory caps) and returns a signed `run.record`.

### 4. HIVV accounts for the work

The signed `run.record` feeds:

- the **ledger** (BLNQ / LYRZ): verified work → payout
- the **hive accounting** (HIVV): honey, streaks, rank
- the **impact dashboard** (HIVV): what the network actually accomplished

---

## The rules of engagement

1. **Never trust the other side's word.** Every cross-project claim that
   matters is signed and independently verifiable. HIVV must not believe
   BLNQ's "the code was safe"; it must verify the signature.
2. **Never let one project impersonate the other.** A principal in one
   registry is not automatically a principal in the other. Registration is
   explicit and reversible.
3. **Never create a dependency loop.** BLNQ must not call HIVV to answer a
   chat. HIVV must not call BLNQ to answer a chat. They meet only at the
   four contracts above.
4. **One schema, two copies, one test suite.** The duplication is deliberate;
   the parity suite is what makes it safe.
5. **A change to a shared contract is a coordinated release.** Both projects
   deploy the same day, or the change is additive and backward-compatible.

---

## Who owns what — the practical version

| If you want to… | Go to |
|---|---|
| Route a chat to the best model | **HIVV** |
| Decide whether an action is permitted | **HIVV** |
| Ask a human to approve something | **HIVV** |
| Run untrusted code safely | **BLNQ** |
| Analyse code and sign a verdict | **BLNQ** |
| Coordinate independent validators | **BLNQ** |
| Prove what a run did | **BLNQ** |
| Pay for verified work | **BLNQ / LYRZ** |
| Show the world what the network did | **HIVV** |

---

## Changing the contract

1. Update `api/lib/attestation-contract.json` on **both** sides.
2. Update the runtime loader and all format-specific validation.
3. Update the Python CLI mirror.
4. Update browser verification in `trust.html`.
5. Run the cross-site parity suite:

```bash
cd /var/www/vhosts/blnq.org/public_html
node tests/test_attestation_contract.js
node tests/test_attest_parity.js
python3 tests/test_trust_cross.py
```

6. Run a live HIVV → BLNQ verification.
7. Restart both services only after all checks pass.

**Never change one side alone.** A version, canonicalization, principal-prefix,
or signature-format mismatch breaks every new signature.

---

## The integration test

The end-to-end proof lives at:

```bash
/var/www/vhosts/blnq.org/public_html/tests/test_attestation_contract.js
/var/www/vhosts/blnq.org/public_html/tests/test_attest_parity.js
/var/www/vhosts/blnq.org/public_html/tests/test_trust_cross.py
```

and the live check is one request:

```bash
curl -s https://blnq.org/api/attest/verify \
  -H 'content-type: application/json' \
  -d '{"envelope": …, "signature": …, "public_key": …}'
```

A valid answer is `{"data":{"valid":true,"problems":[]}}`.
