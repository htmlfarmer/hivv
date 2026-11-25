# HIVV — DEEPER TELEMETRY & DISTRIBUTED TASK EXECUTION

Plan for: (1) real telemetry, (2) a distributed task foundation, (3) MCP and
A2A interoperability, (4) the hive-to-hive door that was painted on a wall.

Status: **phase 1 shipped** (the foundations below are live at
`hivv.org`; the follow-ons are listed at the end).

---

## 0. WHAT WAS ALREADY THERE, AND WHY IT WAS NOT ENOUGH

The hive knew a great deal already:

| surface | what it knew |
|---|---|
| `GET /api/health` | is the DB answering (with a 3s deadline, after the 2026-11-22 outage) |
| `GET /api/public/status` | a cached public pulse |
| `hivv_request_provenance` | **one durable row per request** — who, which node, how long, what it cost |
| `hivv_model_perf` | an EWMA of tokens/sec + latency per node+model+transport |
| `hivv_node_stats` | lifetime counters per bee (honey, jobs, tokens, streaks) |
| `orchestrator.nodes` | a LIVE in-memory view of every bee (CPU, memory, load) |
| `hivv_provenance_daily` | daily request rollups (avg + p95 duration, cost) |
| `GET /api/control/metrics/*` | throughput, error rate, model latency — from memory |

Six questions it could **not** answer:

1. *What was the **p99** of the chat path in the last hour?* → only **AVG**
   existed, and only in a daily rollup.
2. *Which endpoint is failing right now, and with **WHAT** error?* → errors
   were a boolean. There was no vocabulary.
3. *Did that request cross **one hop or three**?* → nothing joined the hops
   together. A relay hop and a peer-hive hop were invisible.
4. *Is the **tool** loop slower than last week?* → tools recorded **nothing**.
5. *How deep is the relay queue, and **for how long**?* → depth was a number
   in memory; it had **no history**.
6. *Are we **burning the error budget**?* → there was no SLO, so there was
   nothing to burn.

And two protocols it could speak but not *answer*:

- **MCP** — HIVV was an MCP **server** (`POST /mcp`). It could not **call**
  another MCP server. Every other AI network on the planet publishes one.
- **A2A** — HIVV did not speak it at all. No agent card, no task endpoint.

And one door painted on a wall: the hive-to-hive manifest has advertised
`submit` and `receipts` since the first release, but `POST
/api/bridge/requests` **did not exist**. A peer that read our manifest and
tried to hand us work got a 404.

---

## 1. THE DEEPER TELEMETRY CORE — `api/lib/telemetry.js`

Four primitives, one core, always available.

```
counter    requests_total{endpoint="/v1/chat"}         monotonic total
histogram  request_duration_ms{transport="direct"}    distribution
gauge      queue_depth{queue="relay"}                 last value
span       hub.request → relay → bee                  one unit of work
```

### 1.1 A span carries a trace

`trace_id` is minted once at the edge (or inherited from a W3C `traceparent`
header) and every downstream hop inherits it. A request that crossed a relay
AND a peer hive reads as **one story**, not three unrelated rows.

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              └─ trace_id ───────────────────────────┘ └─ parent ──┘
```

`parseTraceparent` refuses malformed input rather than guessing. An inbound
trace is **inherited** (same trace_id, new span_id) so the story continues
across hops.

### 1.2 The label allow-list IS the privacy boundary

A span or counter carries **labels**, never payloads. `LABEL_ALLOW` is an
explicit set (`endpoint`, `transport`, `node`, `tool`, `error_class`, …) and
anything outside it is **dropped and counted**. A caller cannot accidentally
start recording prompt text in a label — the boundary is code, not a
convention. Label values are length-capped; a runaway label (a raw request
id, a URL) cannot eat the heap.

### 1.3 Percentiles: exact while we can be, estimated when we must

Buckets alone would put a 100 ms request in the 50–100 bucket and report a
p50 of **78** — an honest estimate, but a useless one for a young hive whose
whole history fits in memory. So each histogram also keeps a bounded
**reservoir** of raw observations:

- while the reservoir holds every sample → percentiles are **EXACT**
- once the series outgrows it → bucket-interpolated, and the result says
  `exact: false` so nobody mistakes an estimate for a measurement.

### 1.4 The error taxonomy

One stable vocabulary, so "what is broken" is answerable by **counting**
rather than by reading logs:

```
timeout · rate_limited · policy_denied · policy_pending · sandbox_denied
not_found · unavailable · upstream_5xx · upstream_4xx · connection · dns
tls · decode · empty_completion · cancelled · validation · auth · unknown
```

Every error lands somewhere (`ERROR_CLASSES` is closed); the classification
rules are ordered, first match wins.

### 1.5 SLOs and the burn rate

| id | target | measured from |
|---|---|---|
| `chat.availability` | 99% | the request counter vs recorded failures |
| `chat.latency` | p95 < 10 s | the duration histogram |
| `tool.availability` | 99% | the tool counter |
| `relay.availability` | 99% | the relay counter |

```
burn_rate = (1 − actual) / (1 − target)
```

`burn_rate > 1` means the budget is burning faster than time passes.

**HONESTY RULE:** a metric with no samples reports `null`, never `0`. "No
data" and "measured zero" are different truths and this module never
conflates them. An SLO with no samples is `unknown`, never `breach`.

### 1.6 The live series ring

A 15-second-sample ring, 240 points (one hour) per metric, in memory. It is
what makes a live chart possible without a database round-trip.

### 1.7 The endpoints — `api/routes/telemetry-routes.js`

| endpoint | what it answers |
|---|---|
| `GET /api/telemetry/overview` | the pulse — public-safe aggregates |
| `GET /api/telemetry/counters` | counter totals |
| `GET /api/telemetry/gauges` | latest gauge values |
| `GET /api/telemetry/histograms` | distributions + percentiles |
| `GET /api/telemetry/series?metric=…` | the live time-series |
| `GET /api/telemetry/errors` | the error taxonomy breakdown |
| `GET /api/telemetry/slo` | SLO status + burn rate |
| `GET /api/telemetry/spans` · `/traces` | recent spans / trace summaries |
| `GET /api/telemetry/traces/:traceId` | one trace as a waterfall |
| `GET /api/telemetry/nodes` | per-node live telemetry |
| `GET /api/telemetry/metrics` | **Prometheus text exposition** |
| `POST /api/telemetry/observe` | let a bee push its OWN measurements |

The audience model is borrowed from `routes/provenance-routes.js`:
`view=public` (aggregates, anyone) · `view=partner` · `view=operator`
(everything — labels, series, spans; control-token or admin session). The
**default is `operator`**, so a guessed URL never hands out the detail.

---

## 2. THE TASK FOUNDATION — `api/lib/task-queue.js`

The hive grew four separate job systems — `lib/relay.js` (inference jobs to
NAT'd bees), `routes/coding-routes.js` (coder bees), the hive-to-hive
bridge (no jobs yet) and blnq.org's own jobs table. They share **nine**
needs and solved each separately:

1. a state machine a client can **poll**
2. **idempotency** on an external id
3. **priority** + `not_before` scheduling
4. a **TTL** that expires forgotten work
5. **leases**, so a worker that dies loses nothing
6. **retries** with a cap
7. a **budget** (tokens / cost / time)
8. **cancellation**
9. a **receipt** of what happened

One implementation, four skins.

### 2.1 The states

```
queued ──claim──▶ running ──complete──▶ done
   │                  │
   │                  ├──fail (retryable) ──▶ queued again
   │                  └──fail (terminal)  ──▶ failed
   ├──cancel──▶ canceled
   ├──ttl─────▶ expired
   └──reject──▶ rejected      (policy / allowance / loop — NEVER retried)
```

The distinction that matters: **`failed` can be retried, `rejected` cannot.**
A peer hive that is at 0% allowance REJECTS work; it does not fail it.

### 2.2 Leases, not locks

A bee behind NAT can die mid-job. A lock would strand the work forever. A
lease **expires**: the worker must heartbeat to keep it. When a lease lapses
the task returns to `queued` with `attempts+1`; a task that burns its
attempts becomes `failed` — never silently dropped.

### 2.3 Interruption is NOT failure

The policy gate's **MAYBE** verdict means "a human must decide". The queue
models that as an **interruption**, not an error:

```js
taskQueue.interrupt(id, { kind: 'auth', reason: 'a human must approve this' })
```

The task stays **alive** (`running`, lease released) and carries
`interrupted = {kind, reason}`. `resume()` continues it. A2A renders this as
`TASK_STATE_AUTH_REQUIRED` — the client is told exactly what to do
(`hivv approve <grant>`), not that it failed.

### 2.4 Local-first, always

In-memory by default; a Postgres mirror (`hivv_tasks`, migration 029) when a
database is attached. **No database is a valid, fully-useful configuration** —
the local install answers every question from memory.

---

## 3. DISTRIBUTED EXECUTION — `api/lib/hive-clients.js`

"Run this task somewhere else" means different things to different peers.
One interface, five adapters:

| adapter | protocol | what it does |
|---|---|---|
| `blnq` | `blnq-jobs/1` | claim / heartbeat / output / complete on blnq.org's worker pool (**worker-HMAC signed**) |
| `mcp` | `mcp/streamable-http` | `tools/list` + `tools/call` on any MCP server |
| `a2a` | `a2a/1.0` | the agent card, `SendMessage`, `GetTask`, `CancelTask` |
| `bridge` | `open-hives/0.1` | `POST /api/bridge/requests` on a peer hive |
| `local` | — | our own hive (the router). The default. |

Every adapter answers the same four questions — `probe`, `submit`, `status`,
`cancel` — and maps the remote's vocabulary onto **our** task states
**explicitly**, never by guessing.

### 3.1 The blnq.org integration

blnq.org runs a worker pool with a jobs table, a worker inbox and HMAC-signed
worker calls. We implement the **worker** direction: claim their jobs, run
them, report output, complete. That direction needs only the worker token —
no account, no session cookie.

The signing format is a **contract** between two sites
(`blnq.org/public_html/api/lib/workerAuth.js` ↔ `api/lib/hive-clients.js`):

```
message   = `${ts}\n${nonce}\n${METHOD}\n${path}\n${sha256(rawBody)}`
signature = HMAC-SHA256(auth_token, message)
headers   = Authorization: Bearer <token>
            X-Auth-Timestamp, X-Auth-Nonce, X-Auth-Signature
```

`path` is the client-facing path **including the query string**. The window
is ±300 s. The signature is **pinned by a test with a fixed expected value**,
and a second test reads blnq's own source when it is on this box and asserts
the message shape has not drifted. When the contract changes, it changes on
**both** sides — never one.

### 3.2 The MCP client — `api/lib/mcp-client.js`

The OUTBOUND half of MCP. Streamable HTTP, stateless, exactly how our own
server behaves:

```
initialize → notifications/initialized → tools/list | tools/call
```

The **server's** protocol version wins — that is what a negotiation is for.
A server that answers with a single SSE frame instead of JSON is tolerated
(being liberal in what we accept is how interop works).

Every outbound URL goes through the SSRF guard, every call has a hard
deadline, and the response is size-capped: a hostile peer cannot stream us
out of memory or reach `127.0.0.1` through our own server.

### 3.3 The A2A client — `api/lib/a2a-client.js`

Both bindings: **JSON-RPC 2.0** (canonical — tried first) and **REST/JSON**
(`POST /message:send`, `GET /tasks/{id}`, `POST /tasks/{id}:cancel`). The
agent card is fetched from `/.well-known/agent-card.json` (v1.0) with the
v0.2 `/.well-known/agent.json` still accepted.

---

## 4. A2A AS A SERVER — `api/routes/a2a-routes.js`

MCP says *"here are my tools"*. A2A says *"here is my agent — give it a
task"*. They are complements:

```
inbound   POST /mcp        (MCP server  — already shipped)
inbound   POST /api/a2a    (A2A server  — this file)
outbound  lib/mcp-client.js    (MCP client — call other MCP servers)
outbound  lib/a2a-client.js    (A2A client — give other agents tasks)
outbound  lib/hive-clients.js  (the adapter layer that unifies them)
```

### 4.1 The agent card

Published at `/.well-known/agent-card.json` (and the v0.2 path). **Static**
on disk so Caddy serves it with no gateway involvement (a peer can discover
us even when the gateway is busy) and **live** at `/api/a2a/agent-card`. The
static copy is **generated** from the route by `scripts/gen-agent-card.js`
so the two cannot drift.

Four skills, because those are the four things this hive actually does:
`hive-chat`, `hive-tools`, `hive-code`, `hive-network`.

### 4.2 A2A tasks ARE task-queue tasks

| A2A state | our state |
|---|---|
| `TASK_STATE_SUBMITTED` | queued |
| `TASK_STATE_WORKING` | running |
| `TASK_STATE_INPUT_REQUIRED` | running + interrupted {input} |
| `TASK_STATE_AUTH_REQUIRED` | running + interrupted {auth} |
| `TASK_STATE_COMPLETED` | done |
| `TASK_STATE_FAILED` | failed |
| `TASK_STATE_CANCELED` | canceled |
| `TASK_STATE_REJECTED` | rejected |

### 4.3 The policy gate is NOT bypassed

A2A is a transport, not an amnesty. Every message goes through the **same**
gate as `/api/chat`:

- denied → `TASK_STATE_REJECTED` with the reason
- MAYBE → `TASK_STATE_AUTH_REQUIRED` with the exact command a human should run

The gate lives in **one** place (`lib/policy.js`); this file asks it, it
does not re-implement it.

---

## 5. THE HIVE-TO-HIVE DOOR — `routes/bridge-routes.js`

`POST /api/bridge/requests` (open-hives/0.1 §3) and the receipt endpoints
(§6) now exist. The manifest advertised them since day one.

### 5.1 The loop shield (§4) — the only strict part

```
X-Hive-Origin:     kwaai            who started it
X-Hive-Path:       hivv.org,kwaai   every hive already visited, in order
X-Hive-Hops:       1                crossings so far
X-Hive-Request-Id: req_01J...       the dedupe key
```

- our own name in the path → **409** `loop_detected`
- our own name as the origin → **409** `loop_detected`
- hops > 3 → **409** `loop_detected`
- a seen request id → the **same state**, never a second execution

### 5.2 The allowance is a HOLD, not a failure (§3.1)

At 0% allowance the queue **holds** the work — it does not reject it and it
does not fail it. The peer sees `queued` with `held: true` and comes back
later. Only when the TTL expires does it become `expired`. A hive that is
busy is still a hive you can visit; it is just asking you to be patient.

### 5.3 The reader loop (§3.1)

One regular loop, riding the same timer as the heartbeat — no new daemon to
supervise. It reads due submissions, checks the allowance, and hands each
one to the hive. **"The reader is deliberately dumb; intelligence lives in
routing, not in queues."**

### 5.4 The receipts (§6)

Every crossing leaves a receipt: which hive, which node, which model, how
many tokens, how long, what it cost. They batch and they are verifiable —
which is what makes the website counters **provable** rather than merely
asserted. We accept receipts from peers (`POST /api/bridge/receipts`) and
publish our own rollup (`GET /api/bridge/receipts`).

A receipt **confirms** what the peer measured; our own counters remain the
ones we trust for our own traffic.

---

## 6. FILES

| file | what |
|---|---|
| `api/lib/telemetry.js` | the telemetry core (counters, histograms, gauges, spans, traces, taxonomy, SLO) |
| `api/lib/task-queue.js` | the task foundation (states, leases, budgets, idempotency, interruption) |
| `api/lib/mcp-client.js` | the OUTBOUND MCP client |
| `api/lib/a2a-client.js` | the OUTBOUND A2A client |
| `api/lib/hive-clients.js` | the adapter layer (blnq · mcp · a2a · bridge) |
| `api/routes/telemetry-routes.js` | the telemetry API |
| `api/routes/a2a-routes.js` | the A2A server + agent card |
| `api/migrations/028_deeper_telemetry.sql` | the telemetry mirror + bridge receipts |
| `api/migrations/029_task_queue.sql` | the task table |
| `api/tests/telemetry.test.js` | 26 tests |
| `api/tests/task-queue.test.js` | 23 tests |
| `api/tests/interop.test.js` | 24 tests |
| `tests/test_telemetry_tasks_a2a.py` | 32 tests (repo-level, static) |
| `scripts/gen-agent-card.js` | regenerate the static agent card |

---

## 7. THE LAWS THIS WORK KEEPS

- **Local-first** — every new module works with **no database and no
  network**. The local install answers every question.
- **Privacy** — telemetry carries **labels**, never payloads. The
  allow-list is code.
- **Honesty** — no data reports `null`, not `0`. A failure says which class
  it was. A task that was never claimed has no duration.
- **No silent loss** — every terminal transition records WHY.
- **The gate is in one place** — A2A, MCP and the bridge all *ask*
  `lib/policy.js`; none of them re-implements it.
- **The naming law** — a hive is named by its own domain. The blnq adapter
  reports `blnq.org`, never "the other network".

---

## 8. WHAT COMES NEXT (not shipped)

1. **Wire the telemetry into the request path** — `router.js` records a span
   per request (with the `traceparent` propagated to the bee), so the
   waterfall becomes real rather than an empty ring.
2. **Per-node metric time-series** — the orchestrator holds a live snapshot
   of every bee but keeps no HISTORY of it. "Was ashy's GPU saturated last
   Tuesday?" is still unanswerable.
3. **`hivv connect`** (open-hives/0.1 §8) — the one-command peering CLI.
   The peer side exists; the CLI does not.
4. **blnq as a SUBMITTER** — the blnq adapter currently works in the worker
   direction (claim/complete). The submit direction needs a session; the
   shape is written, the credentials are not.
5. **A2A streaming** — `SendStreamingMessage` over SSE is declared in the
   card's capabilities but the server does not stream yet.
6. **Bridge receipts, signed** — the receipt batch is accepted and rolled up
   but not yet Ed25519-signed (the contract exists on both sides).
7. **SLO multi-window burn rates** — the Google SRE shape (fast + slow
   window) rather than one window.
