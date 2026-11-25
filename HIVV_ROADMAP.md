# HIVV.org — Roadmap v0.3 (verified against the tree)

> **Supersedes** *"HIVV API Review & Roadmap — INTERNAL DRAFT · v0.2 · November 2026"*.
>
> v0.2 was written from **intent**. v0.3 was written by **auditing the code**: all 31 of its
> claims were checked against the repository and, where a number was quoted, read live off the
> running gateway. Audit date **2026-11-25**.
>
> **Method:** every claim is either `file:line` evidence or an explicit `not found`. "Not found"
> means grepped repo-wide and absent — not "we didn't look hard".
>
> **Legend:** ✅ shipped (the v0.2 claim is obsolete) · ◐ partial · ✗ genuine gap
>
> ⚠ Line numbers are as of the audit commit and drift; re-verify before acting on one.

---

## 0. What changed since v0.2

**31 claims → 1 obsolete · 20 partial · 10 genuine gaps.**

Roughly a third of v0.2 is already wrong, and it is wrong in a *predictable* direction: the
sections that moved fastest this month — **Easy for AI** and **Fun** — are the most stale. That
is not a coincidence; it is where the work went.

What shipped since the draft:

| Area | Shipped | v0.2 said |
|---|---|---|
| Identity | Ed25519 binding · signed manifests · rotation statements · execution receipts · revocation CRL · operator endorsements · measured trust → routing | "no sybil resistance" |
| Telemetry | counters/histograms/gauges/**spans+traces** · error taxonomy · **SLOs + burn rate** · Prometheus `/api/telemetry/metrics` | "no SLO published" |
| Tasks | `task-queue.js` — leases · TTL · budget · retries · receipts · Postgres mirror | "no async jobs" |
| Toolkit | 12 tools, auto-attached, real tool loop (stream + non-stream), policy-gated | "no tool-calling gateway" |
| MCP | inbound `/mcp` **and** outbound `mcp-client.js` | "no MCP server" |
| Routing | 11-factor scoring vector · TTFT measurement · capacity/queue/geo/cost/privacy/capability/trust | "EWMA-only routing" |
| Honey | **LYRz transfer + redemption live in prod** (`HIVV_LYRZ_PER_HONEY=0.1`) | "leaderboard-only" |
| Memory | principal-scoped store, dual-mode, public tool surface | "memory is a stub" |
| Accounts | register · login · password reset · export · visitor linking | "no account, no sync" |

**7 defects were found in passing** — see §4. Several are API-contract lies, which is worse
than a missing feature.

---

## 1. Scorecards

### 2.1 Fast

| # | v0.2 claim | | Evidence |
|---|---|---|---|
| 1 | Single hub; all routing through hivv.org | ◐ | Same gateway is true (`server.js:4659`, one Caddy block). But **"all routing" is false by design**: the dial shim is P2P-by-default (`dial-routes.js:1-10`, `hivv-cli.py:19029`) — hub does *selection*, data plane is point-to-point. Local-first gateways never contact it. **No edge/POP/region code exists.** |
| 2 | Four nodes, ~64 tok/s combined | ◐ | Live: **6 registered / 4 online / only 3 carry models** (`wahi` is online with `models: []`). Measured EWMA ≈ 83.7 + 32.7 + 20 ≈ **136 t/s**. "~64" matches no reproducible figure. |
| 3 | 60 req/min per IP | ◐ **stale** | `/api` = **300/min remote** (visitor-keyed, client-rotatable, `server.js:624-649`) · **5000/min loopback** (`server.js:653-664`). 60/min/IP survives only on `/v1/chat/completions` (`server.js:2242`) and `/mcp` (`mcp-routes.js:53`). **Target (600/6000 + token bucket) not started.** |
| 4 | EWMA-only; no prompt caching / hedging / KV sharing | ◐ **stale** | Factor-vector routing (`route-factors.js:40-52`) + **3-min warm sticky affinity** (`router.js:419-447`, `score += 45` at `:694`) + `prompt_tps` scoring for prompts >1200 tokens (`router.js:687-693`). **Still true:** no provider `cached_tokens`, no `X-Hivv-Cache`, **no hedging** (failover is strictly sequential, `router.js:1885-2032`), **no KV sharing**. |
| 5 | 50s long-poll → target WebSocket | ◐ | 50s confirmed (`inbox-routes.js:23,123`). **WebSocket: not found** — no `ws`/`socket.io` dep, no `upgrade` handler, no Caddy ws config. SSE push exists instead (`/api/hivv/sse`, `/api/dashboard/sse`). AGENTS.md's WebSocket TODO is still unchecked. |
| 6 | 60s server timeout, 15s local → target 120s + `route.timeout` | ◐ | **15s local is exact** (`router.js:1944`). **The 60s server timeout does not exist** — real values are **15 / 45 / 120s** (local / relay-capped / cloud+`/v1`). 120s is *already* the default on `/v1` (`server.js:2307,2447`) and cloud (`providers.js:410`). **`route.timeout` field: not found** (`routeSpec` has only `mode`, `privacy`, `max_cost`). |

### 2.2 Reliable

| # | v0.2 claim | | Evidence |
|---|---|---|---|
| 1 | Receipt in every response, `GET /api/receipts/:id` | ◐ | **Machinery shipped, not wired to chat.** Signed execution receipts: `identity.js:505-573`, `POST\|GET /api/identity/receipts` (`identity-routes.js:93,111`), verified on heartbeat (`server.js:4213-4218`). **`GET /api/receipts/:id` not found.** Chat returns only `X-Hivv-Answered-By` / `X-Hivv-Policy`. **`X-Hivv-Route` is not implemented** — yet `SKILL.md:55` documents it as live. |
| 2 | TPM/PoW attestation + stake-and-slash | ◐ | **Shipped:** Ed25519 binding + self-certifying principal (`identity.js:7,172`), anti-squatting claim auth (`bee-identity.js:85`, `server.js:3921`), revocation CRL + endorsements. **Not found:** TPM · PoW · stake · slashing. Legacy unsigned registration still accepted (`server.js:3962`) — by design. |
| 3 | 2-of-3 replication + consensus on divergence | ✗ | **Nothing.** No replication/consensus/quorum code. Nearest analogue is CLI-side `hivv hive-mind` fan-out + judge, which is not server-side consensus. |
| 4 | Public status page: p50/p99, success rate, per-capability uptime | ◐ | **SLO engine + burn rate built** (`telemetry.js:588-630`, `GET /api/telemetry/slo`). `/status` exists but renders **avg** latency + success% only (`server.js:1093-1099`). p50/p95 public via `/api/hive/timeline` (`honey-routes.js:553`). **p99 not public. Per-capability uptime: not found.** No public page renders the SLO endpoint. |
| 5 | 90-day rotation, KMS, "burn my key" + receipt | ◐ | **AES-256-GCM** at rest (`crypto-utils.js:3`). Delete/deactivate endpoints exist (`server.js:1963,2058,3484`) **but return no cryptographic receipt**. **No rotation policy, no KMS.** Node-identity key rotation + signed CRL revocation *do* exist (`identity.js:434,645`) — a different key class; don't conflate them. |
| 6 | Honey slashing + reputation decay + N-slash quarantine | ◐ | Honey **never decreases** (`honey.js:141-180` only inserts positives). Auto-quarantine exists but triggers on **flapping** ≥5 re-registrations/10min (`orchestrator.js:341-353`), not bad output. Trust *does* drop on failed receipts/flaps (`trust.js:58,66-68,79-98`). **No decay writer; `hivv_agents.reputation_score` is written once at registration and never updated.** |

### 2.3 Fun

| # | v0.2 claim | | Evidence |
|---|---|---|---|
| 7 | Honey is leaderboard-only — no utility, transfer, redemption | ✅ **obsolete** | **Wrong on all three counts.** *Utility:* honey rank is a weighted route factor (`route-factors.js:51`, weight **4** in `trusted` mode). *Transfer/redemption:* **LYRz is live in production** — `api/lib/lyrz.js:1-20,43`, settlement enqueued from `honey.js:182-208`, boot loop `server.js:3625-3639`, `POST /api/lyrz/link` + `GET /api/lyrz/status` (`lyrz-routes.js:20,116`), real key at `api/.lyrz-api-key`. Not found: honey-based quotas/pricing. |
| 8 | No social layer: follow · mention · share prompts · fork swarms | ✗ | **Nothing** of the four. Primitives that exist but aren't the target: agent relationships (`dashboard-routes.js:357-397`), human bee ratings (`honey-routes.js:170`), share cards (`:256`). |
| 9 | No swarm visualization → force-directed hive map | ◐ | **Force-directed d3 maps already live** (`command-center.html:700-723`, `:1464-1483`) plus pulse KPI strip, live request ticker with token counts, GPU gauge wall, audit hash-chain viz, Leaflet geo map. **Missing: animated token flow on edges** (links are static lines). |
| 10 | Bee metaphor stops at CLI; no agent-as-bee autonomy | ◐ | **Real autonomy now ships:** coder bees (`coding-routes.js:170,303`), task-queue, A2A runner claiming tasks (`a2a-routes.js:398-415`), relay volunteers. `hivv drone` is only a **volunteer-status alias** (`hivv-cli.py:15306`). **Not found:** an agent volunteering *on behalf of a user* (per-user delegation identity). ⚠ `hive-clients.js` is built and tested but **unwired** — only `api/tests/interop.test.js:22` imports it. |
| 11 | No model marketplace → registry + signed manifests + per-model tags | ◐ | **Signed capability manifests shipped** (`identity.js:342-424`, applied `server.js:4023-4038,4173-4193`) and node-level capability tags (`capabilities.js:137-144`). **`GET /api/models` is a hardcoded `MODEL_CATALOG`** (`server.js:3030-3057`), not served/verified models. **Per-model tags: not found.** |

### 2.4 Easy for AI

| # | v0.2 claim | | Evidence |
|---|---|---|---|
| 1 | No MCP server → `/v1/mcp` + CLI stdio bridge | ◐ **stale** | **Server exists at `/mcp`** (`server.js:3732`, `mcp-routes.js:1-710`) serving the **full toolkit** behind the policy gate, **plus an outbound client** (`mcp-client.js`) — beyond the target. `/v1/mcp`: not found. **CLI stdio bridge: not found.** |
| 2 | No tool-calling gateway → ReAct synthesis + every call audited | ◐ | **Shipped:** auto-attach + passthrough (`server.js:92-99`, `router.js:1356,1702,1811`), **real tool loop** stream + non-stream (`tool-stream.js:1-108`, `server.js:2658-2679`), tool-capable candidate filter with unfiltered fallback (`router.js:713-720`). **Not found: ReAct synthesis** for tool-less providers — the router *routes around* them instead. ⚠ **Audit is tier-gated, not universal:** `policy.js:327` writes only `deny` or `risk >= 2`, so risk-1 tools (`calculator`, `current_time`, `text_parser`) never hit `hivv_audit`. |
| 3 | No `/v1/embeddings`, RAG impossible | ✗ | **No endpoint** (`/v1` = chat/models/index/audio/capabilities only). No vector store, no pgvector. Memory recall is SQL `LIKE` (`memory.js:175-178`). |
| 4 | No `/v1/responses` | ✗ | Not found anywhere. `openapi.yaml` documents only `/v1/chat/completions`. |
| 5 | No async jobs → `/v1/jobs` + webhooks | ◐ **stale** | **Substantial infra shipped:** `task-queue.js` (leases · TTL · budget · retries · receipts, migration 029), `POST /api/coding/jobs → 202 + poll` (`coding-routes.js:7-8,226`), relay jobs, A2A tasks. **Missing:** `/v1/jobs` (all job APIs live under `/api/*`) and **webhooks** (one comment mentions them, `orchestrator.js:102`). |
| 6 | Memory is a stub → `POST /api/memory`, encrypted, scoped | ◐ **stale** | **Real store:** `memory.js` — principal-scoped (`:19-24`, every SQL carries `principal = $1`), DB **or** file mode (0600). Public surface: the `memory` toolkit tool (`toolkit.js:979-1003`) via `/api/tools/:tool/invoke`, MCP, and the chat loop. **Missing:** a dedicated `POST /api/memory` route, and **encryption at rest** (plain JSONB while keys are AES-GCM). |
| 7 | No `response_format: json_schema` | ✗ | Only hit is Whisper's `response_format` (`transcriptions-routes.js:110,127`). Not advertised in `openapi.yaml`. |
| 8 | No batch API → `POST /v1/batch` | ✗ | Not found. |

### 2.5 Easy for Human

| # | v0.2 claim | | Evidence |
|---|---|---|---|
| 9 | curl\|bash only → signed .deb/.rpm/.pkg/.msi + Homebrew tap | ◐ | **Manifest skeletons exist and are unfilled:** `packaging/homebrew/hivv.rb:14,18,25,29` and `packaging/winget/hivv.installer.yaml:14` all say `REPLACE_WITH_SHA256`. **No `.deb`/`.rpm`/`.spec`/`.msi` anywhere.** CI pipeline exists (`.github/workflows/build-cli-binaries.yml`). |
| 10 | No mobile app → React Native | ✗ | No RN/capacitor/PWA manifest/service worker anywhere. **Caveat:** `public_html/panel.html` is a capable **mobile-first admin panel** (viewport, safe-area, bee cards, policy approvals). |
| 11 | No browser extension | ✗ | Not found. |
| 12 | No account, no sync → passkey identity | ◐ **stale** | **Accounts exist:** `auth-routes.js:19,72,116,130,174,197,333` (register · login · logout · change/reset password · delete · export) + `public_html/account.html`. Grants and memory are principal-keyed, so signed-in state reaches any device. **Passkeys/WebAuthn: not found.** |
| 13 | No donor wizard → 3 screens + shareable receipt | ✗ | No wizard anywhere. Existing: one-page `donate.html:49-91`. Daily quota exists only server-side as a default (`key-donation.js:45`). **Donation receipt: not found** (the honey share-card is unrelated). |
| 14 | Governance UI depth unclear → first-class policy console | ◐ | **Console shipped:** `command-center.html:206,451-481,1226-1342` — pending grants with approve/deny (standing scope), graphical hash-chain viz + verify, per-capability defaults with tier/risk; mobile approvals in `panel.html:246-270`. Full API incl. delegations (`policy-routes.js:89-217`). **Missing: delegation-chain UI** (API-only) and **per-capability audit drill-down** (flat last-25 feed). |

---

## 2. The real backlog — 10 gaps, sequenced by dependency

v0.2 listed 31 things to build. Ten are actually unbuilt. Ordered so each wave unlocks the next,
and so the cheap correctness work lands before anything shiny.

### Wave 1 — correctness (7 defects, small and self-contained) — see §4
Do these first: they are API-contract lies and dead code, not features. No design work.

### Wave 2 — OpenAI-surface completeness
The cluster that matters most for "Easy for AI", because every agent framework probes for these:

1. **`response_format: {type:"json_schema"}`** — gateway-side schema validation. Smallest of the
   five; unblocks structured agent output immediately.
2. **`/v1/embeddings`** — route to local `nomic-embed`/`bge-small` nodes first, cloud second.
   Unblocks RAG over `data.memory` (which today is SQL `LIKE`).
3. **`/v1/jobs` + webhooks** — the task-queue already exists; this is a `/v1` façade over it plus
   a callback path. Foundation is done, so this is presentation + delivery.
4. **`/v1/responses`** — largest; stateful item-based API.
5. **`/v1/batch`** — 24h async at a honey discount; depends on (3).

> Dependency note: (3) before (5); (2) before any real RAG story. (1) is independent.

### Wave 3 — distribution
6. **Packages** — fill the winget/homebrew `REPLACE_WITH_SHA256` stubs after a first release,
   and add `.deb`/`.rpm`. Blocked on a signed release artifact, not on code.
7. **Donor wizard** (3 screens + receipt) — `donate.html` already posts to `/api/keys/donate`;
   this is UX over an existing endpoint.
8. **Mobile / browser extension** — `panel.html` is the mobile proof; a PWA manifest + service
   worker is the cheap step before any React Native work.

### Wave 4 — trust depth
9. **Replication / consensus** (2-of-3 for high-risk capabilities) — genuinely greenfield; nothing
   to build on except `task-queue` for orchestration.
10. **Sybil resistance beyond Ed25519** — TPM or PoW, stake-and-slash. Identity Phase 1-5 gives
    the *attestation* half; the *economic* half is untouched.
11. **Key rotation + KMS + burn receipt** for donated provider keys — delete/deactivate already
    exist; they need a receipt and a rotation policy.

### Wave 5 — social & registry
12. **Social layer** — follow/mention/share-prompt/fork-swarm. Relationships + ratings exist as
    primitives.
13. **Model registry** — replace the hardcoded `MODEL_CATALOG` with served/verified models and
    publish per-model capability tags. Signed manifests already exist to hang tags on.

---

## 3. Targets from v0.2 that are still valid

Not everything was stale. These targets stand unchanged:

- **Regional edge POPs** (US-East / EU-West / AP-South) — no code exists; still the right goal.
- **Token-bucket rate limiting** at 600/6000 with trusted principals — current limiter is
  fixed-window and visitor-keyed (rotatable).
- **WebSocket upgrade path** for nodes that can hold a connection, long-poll as fallback.
- **Per-route timeout override** with a `timeout` field in the route object.
- **Hedged requests for `fast` mode** and **KV-cache sharing** for shared system prompts.
- **2-of-3 replication**, **TPM/PoW + stake-and-slash**, **formal slashing** with honey deduction.
- **p99 + per-capability uptime on a public status page.**
- **90-day forced rotation, KMS, burn-my-key receipt.**
- **Follow/mention/share-prompt/fork-swarm.**
- **Model registry with signed manifests and per-model tags.**
- **`/v1/embeddings`, `/v1/responses`, `json_schema`, `/v1/batch`, `/v1/jobs` + webhooks.**
- **Signed packages, mobile app, browser extension, donor wizard, passkeys.**

---

## 4. Defects found while auditing

Independent of the roadmap — these are wrong *today*.

| # | Defect | Evidence | Fix |
|---|---|---|---|
| D1 | **`GET /api/quota` advertises `requests_per_minute: 60`** — the real `/api` limit is 300 remote / 5000 loopback. The API lies to its own clients. | `server.js:2080` vs `server.js:624-664` | Report the actual limiter value |
| D2 | **`SKILL.md:55` documents `X-Hivv-Route` as if live** — never implemented (AGENTS.md correctly lists it as open, so the skill drifted) | `public_html/.well-known/skills/hivv/SKILL.md:55` | Remove or implement |
| D3 | **AGENTS.md TODO "Audit table pruning (F5)" is already shipped and running** | `policy.js:41,375-476` | Strike the TODO |
| D4 | **`hivv_agents.reputation_score` is a dead column** — written once as `50.00` at registration, never updated | `migrations/003:63`, `agent-routes.js:97,105` | Wire it to `trust.js` or drop it |
| D5 | **Audit chain skips risk-1 tool calls** — `calculator`/`current_time`/`text_parser` never reach `hivv_audit`, so v0.2's "every tool call logged in the audit chain" is not met. **This is deliberate**, not an oversight: the code comments *"audit anything above compute tier (chat stays silent & instant)"* — so the fix is to reconcile the claim with the design, not to blindly widen the writes. | `policy.js:327` (`verdict === 'deny' \|\| risk >= 2`) + `TIER_RISK` `:27` | Either audit all tool invocations, or state the tier policy in the docs |
| D6 | **Memory values stored plain JSONB while keys are AES-256-GCM** — inconsistent at-rest posture | `memory.js:137-146` vs `crypto-utils.js:3` | Encrypt values with the existing helper |
| D7 | **Same model, two ceilings** — local path hard-caps at 15s, `/v1` allows 120s; `/api/chat` streaming passes no timeout at all | `router.js:1944` vs `server.js:2307,2447,2892` | One default, per-route override (see Wave 2 / §3) |

Two further inconsistencies worth naming:

- **`hive-clients.js` is unwired** — five adapters built and tested, imported only by its own
  test. No production route submits through it.
- **`/api/models` returns a hardcoded catalog**, not what the hive actually serves
  (`/api/public/models` does, from heartbeats).

---

## 5. Reading this document

- **v0.2 was a wish list. v0.3 is a measurement.** When the two disagree, the code is right.
- **"Partial" spans 10%–90%.** MCP is one path constant and a stdio bridge from done; slashing
  has no mechanism at all. Read the evidence column, not the symbol.
- **Do not re-audit from scratch.** The `not found` results are negative evidence — they cost a
  full-repo grep each and they expire when someone ships the thing.

## Cross-references

| Doc | What it owns |
|---|---|
| [`MOVES.md`](MOVES.md) | repo topology ledger — structural moves, same-commit rule |
| [`AGENTS.md`](AGENTS.md) | how the codebase works, for AI sessions |
| [`HIVV_BACKLOG.md`](HIVV_BACKLOG.md) | the 2026-09-28 build's leftovers (sections A–I) — older, still valid where it overlaps |
| [`HIVV_ROUTING_PLAN.md`](HIVV_ROUTING_PLAN.md) | the route brain: p_wise tiers + §7 factor vector |
| [`HIVV_TELEMETRY_TASKS_PLAN.md`](HIVV_TELEMETRY_TASKS_PLAN.md) | telemetry + task-queue foundations |
| [`HIVV_TOOLKIT_PLAN.md`](HIVV_TOOLKIT_PLAN.md) | the twelve tools |
