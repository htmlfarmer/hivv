# HIVV.org — Capability Layer + Routing Modes + Policy Engine

> The "AI operating system" draft. Three coupled primitives:
> **CAPABILITY** (what can be asked) · **ROUTE** (who may answer, chosen by strategy) · **POLICY** (YES / MAYBE / NO).
> Written 2026-09-27 after reviewing README.md, HIVV_PLAN.md, HIVV_BACKLOG.md, FUTURE_NOTES.md, and the code.
>
> **2026-09-27 — §1, §2, §3 SHIPPED & LIVE.** Migration 008 + `api/lib/capabilities.js` + `api/lib/policy.js`
> (hash-chained audit, verified with a live tamper test) + gate wired into `router.js`
> (`routeWithFailover` choke point, hub tool-exec, `/api/tools/:tool/invoke`) + route modes (balanced/quality/
> fast/cost/private/trusted with privacy as hard transport filter + provider prices) + `GET /api/capabilities`
> + `/api/policy/*` + CLI (`hivv cap|policy|approve|deny|route`, `hivv chat --mode`, `hivv call` fixed — it
> was never wired into COMMANDS!) + Command Center 🧬/⚖️ views with approve/deny buttons.
> Deviations from the draft: ~~MAYBE-delivery is hub-side polling, not inbox push yet~~ **2026-09-28: MAYBE now
> PUSHES an `approval_request` into every online node's inbox (and `hivv up` nudges) alongside polling** — see
> backlog F2; WHEN/WHERE/DATA-redaction stay stored-but-inert; grants are per-principal (visitor id / user) —
> delegation table exists, evaluator ignores it. ~~Still open: coding.execute sandbox backend~~ **2026-09-28:
> `coding.execute` now runs in an ephemeral docker/bwrap sandbox (`api/lib/sandbox.js`, no net + quotas + read-only
> + hard timeout), gated MAYBE→admin-approve→audited via `POST /api/sandbox/exec` / `hivv exec`** (backlog F3).
> Still open: delegation enforcement, relay-job gating, audit snapshot pruning, real image.generate/physical.world providers.
> Status legend: ☐ not started · ◐ in progress · ☑ done
>
> **Design law #1 — never depend on one routing protocol.** Direct (node→node), Relay (hub
> long-poll inbox), Local (localhost LLM), and Cloud (donated keys) are *transports*. The
> router picks a transport per request from the caller's declared intent — not a fixed
> waterfall. Today's waterfall (local → peers → relay → cloud) becomes just one mode: `balanced`.
>
> **Design law #2 — actions are gated, conversation is free.** Policy applies to *capabilities
> that touch something* (tools, money, other people's data, physical world). Plain chat keeps
> zero friction, or we lose the hive.

---

## 0. What already exists (build on it, don't fork it)

| Existing piece | Where | Becomes |
|---|---|---|
| `node.capabilities[]` in registration/heartbeat | `api/lib/orchestrator.js` (`getOnlineNodes({capability})`, `findNodeForTask`) | seed of the capability registry |
| `hivv tools` + hivv-tools (time, calculate, fetch, search, sysinfo) | `public_html/hivv-cli.py`, `public_html/hivv-tools.py` | first registered capabilities: `local.computation`, `web.search` |
| TTS (kokoro) / STT (whisper) pm2 apps + routes | `api/lib/kokoro-tts.js`, `api/routes/{tts,stt}-routes.js` | `speech` capabilities, currently invisible to the router |
| perf.js EWMA (measured t/s per node+model) | `api/lib/perf.js` | the **quality/speed** signal for routing modes |
| honey + streaks + ranks (hub-side truth only) | `api/lib/honey.js` | the **trust** signal — reputation earned, never self-reported |
| `trust_score` column (agents) | `api/lib/routes/agent-routes.js` | hook for trusted-agents policy |
| Relay consent gate (`hivv volunteer on`) | `api/lib/relay.js`, backlog B-notes | proof we can do per-capability consent |
| `X-Hivv-Answered-By` receipts | router.js | the audit trail's user-visible tip |
| usage_logs, encrypted ai_keys | DB | cost tracking substrate for spending limits |

Missing and needed for all of this: an **actor identity for callers** (visitor/user/agent), a
**request envelope** richer than `{model, messages}`, and an **append-only event table**.

---

## 1. CAPABILITY — the universal noun list ☑

**Goal:** one canonical vocabulary so a request says *what it needs*, not *who to call*.
A capability is a namepaced string, hierarchical, versioned by prefix only.

```
CAPABILITY (v1 taxonomy — 12 first-class, extensible by hub admin)
├── reasoning          chat/completion/analysis (default; free-policies)
├── vision             image→text (needs multimodal model on node)
├── speech.text-to-voice   ┐ already live (kokoro/whisper) — just register them
├── speech.voice-to-text   ┘
├── translation        special-case of reasoning, but tagged (routing-relevant langs)
├── web.search         hivv-tools /search — SIDE-EFFECT: fetches remote data
├── web.fetch          hivv-tools /fetch  — SIDE-EFFECT: arbitrary URL egress
├── database.query     read-only SQL/DB  — DATA: touches stored state
├── coding             code gen + execution; exec is a SEPARATE capability:
│   └── coding.execute runs arbitrary code — HIGH RISK, never implicit
├── image.generate     diffusion endpoint (future; advertised like local_models)
├── local.computation  calculate/time/sysinfo — the safe sandbox tier
├── human.approval     the MAYBE path itself (ask-a-human is a callable capability)
├── financial.transaction  spend money / move keys / buy compute — MAX risk tier
└── physical.world     printer/IoT/robot/actuator — reserved, nodes advertise if present
```

### Steps
1. **Registry, not enum.** New table `hivv_capabilities (key, tier, description, requires_consent, default_route_mode)` seeded by migration; hub admins can add keys without a deploy. Tiers: `read` / `compute` / `side-effect` / `data` / `money` / `physical` — tiers drive risk defaults.
2. **Nodes advertise capabilities honestly:** extend heartbeat — nodes report tools (`hivv tools on` ⇒ `local.computation`, `web.search`…), TTS/STT when their local services respond, plus the existing `local_models` → derive `reasoning/vision/coding` from model metadata (vision if model is multimodal). Hub-side truth rule applies: a capability is only listed if the last probe succeeded (same discipline as honey).
3. **Capability probe endpoint:** `GET /api/capabilities` (public: what the hive can do, counts per capability) and `GET /api/capabilities/node/:id`. Dashboard: capability chips per node; replaces "model soup" mental model.
4. **Request envelope:** clients may say what they need instead of who they want:
   ```json
   { "capability": "web.search", "args": {...},
     "route": { "mode": "privacy", "privacy": "local-only", "max_cost": 0 },
     "policy_context": { "actor": "u_alice|agent_id|v_xxx", "reason": "…" } }
   ```
   `/v1/chat/completions` stays OpenAI-shaped (`model:"auto"` ⇒ `capability:"reasoning"`);
   the envelope is additive so nothing breaks.
5. **CLI surfacing:** `hivv cap list` (hive totals), `hivv cap can <capability>` (my rights,
   per policy §3), `hivv call <tool>` gains `--explain-denied` (shows which policy rule said NO).

**Touches:** `api/migrations/0xx_capabilities.sql`, `api/lib/orchestrator.js` (advertise+probe),
`api/routes/control-routes.js` (new GETs), `public_html/hivv-cli.py` (tools announce + cap cmds),
dashboard.
**Done when:** every hivv feature (chat, tts, stt, tools, hive-mind) is expressible as one
capability call, and `GET /api/capabilities` matches what nodes actually serve.
**Effort:** M (2–3 days) · deps: none

---

## 2. ROUTE — pluggable strategies, one router ☑

**Goal:** the caller declares *intent*; the router picks *strategy + transport*. Never hardcode
"try X then Y." The ladder is the score function, and there are several.

```
                 REQUEST (capability + envelope)
                    │
                    ▼
        ┌───────────────────────┐
        │   ROUTE SPEC (intent)  │   mode: balanced|quality|cost|privacy|latency|
        │   default: balanced    │         location|capability|trust | or explicit
        └───────────┬───────────┘
                    ▼
        candidate set  = nodes advertising CAPABILITY  ∩  reachable by allowed TRANSPORTS
                    │      (direct · relay · local · cloud)
                    ▼
        score each candidate by mode's weights over SIGNALS:
                    │
        ├ QUALITY   quality_weight(model family) × measured perf (perf.js)
        ├ COST      $/token (0 for local/peer honey-service, priced for cloud)
        ├ PRIVACY   data-class vs node trust vs transport (relay sees payload, direct doesn't)
        ├ LATENCY   RTT estimate + p50 TTFB (measured, not geolocated guesses)
        ├ LOCATION  geo/region tags from heartbeat location{} + tailscale/LAN affinity
        ├ CAPABILITY hard filter (above) — plus "diversity" for hive-mind fan-out
        └ TRUST     honey rank + history + consent flags + circuit-breaker state
                    ▼
        winner → transport → (fallback chain = next scores in same mode)
```

### Steps
1. **Extract a `routeMode` strategy layer in `router.js`.** Today's ordering logic already biases
   by EWMA — refactor it into `modes = { balanced, quality, cost, privacy, latency, trust }`,
   each a pure function `score(candidate, signals) → number` + a transport allowlist. Weights
   live in `gateway_config` (backlog C6 does the plumbing — do C6 *as part of this*).
2. **Cost model first, because it gates the money tier:** per-candidate `price_per_1k` — local/peer = 0 honey-cost, donated cloud keys = inserted price (new column on `ai_providers`), future metered compute = real $. Without this, `max_cost` and the spending-limit policy can't be evaluated.
3. **Privacy as a hard filter, not a soft weight:** data classes `public | internal | secret | biometric`. Nodes declare `privacy_tier` in heartbeat (`any | cloud-ok | local-only`); `route.privacy:"local-only"` means *transports that expose payload to third parties are removed from the candidate set entirely* (cloud excluded, relay allowed only if volunteer is a trusted peer or your own node).
4. **`hivv chat --mode=cheap|fast|private|smart|green`:** CLI sugar for the envelope; `--green` = prefer zero-carbon/own-hardware affinity via LOCATION signal. Receipt gains the mode: `— answered by ashy/gemma (direct, mode=private)`.
5. **Multi-hop safety net:** every mode keeps a fallback ladder ending in the *existing* waterfall so a weird spec never hard-fails: "no candidates for mode=privacy → say so + ask to relax" (MAYBE, §3) rather than silently routing to a cloud key. This is the anti-dependency guarantee: **routing is a policy of strategies, transports are interchangeable.**
6. **Benchmark mode (`hivv route --dry-run "…"`):** returns the scored candidate table without executing — teaches the mental model, doubles as a test harness (answers backlog D3's "no tests" for routing logic).

**Touches:** `api/lib/router.js` (strategy extraction), `api/lib/perf.js`, `api/lib/providers.js`
(pricing), `api/migrations` (provider price, node privacy_tier), `public_html/hivv-cli.py`.
**Done when:** identical requests with different `mode` visibly land on different transports/nodes,
and `--mode=private` provably never reaches a cloud provider (test: kill switch + dry-run).
**Effort:** L (4–5 days) · deps: §1 (capability filter), C6 (config weights)

---

## 3. POLICY — YES / MAYBE / NO ☑ ← the differentiator

**Goal:** every *action* (capability call with side effects, spend, or data exposure) enters the
gate before execution. Chat answers YES by default; everything else is decided by rules.

```
                AI / user proposes action
                          │
                ┌─────────┼─────────────┐
                ▼         ▼             ▼
              YES       MAYBE           NO
           execute   ask human      reject
                     (human.approval   (audited reason
                      capability,       + rule id)
                      via inbox/app)
```

### The eight-tuple (matches the requested HIVV POLICY tree)

```
HIVV POLICY
├── WHO    principal: user | agent | node-owner; roles; trusted_agents list; delegation chain depth
├── WHAT   capability + tier (from §1); e.g. coding.execute ≠ coding (generation is safe)
├── DATA   data_class of payload + max PII exposed to the route; redaction rules before relay/cloud
├── WHERE  target node/service/device; region constraints; transport allowlist
├── WHEN   temporal windows (office hours, TTL of a grant, "expires 2026-10-01")
├── COST   max_cost per call / per day / per week (needs §2 step 2 price model)
├── RISK   computed: tier(WHAT) × novelty × destination-trust; R≥threshold ⇒ MAYBE (human)
└── AUDIT  every decision → immutable append-only ledger (hash-chained)
```

### Steps
1. **Decision engine as data, not code.** Policies are JSON docs stored in `hivv_policies`; the
   evaluator is a tiny pure function `evaluate(action, policy_set, signals) → {verdict, rule_id,
   risk}`. Order: explicit user policy → role default → tier default. Defaults out of the box:
   `read`/`compute` tiers ⇒ YES · `side-effect`/`data` ⇒ YES with audit + spending caps ·
   `money`/`physical` ⇒ MAYBE (human) · `coding.execute` on foreign node ⇒ NO until v2 sandbox.
2. **Schema (migration 0xx_policy.sql):**
   ```sql
   hivv_policies   (id, principal, scope, doc jsonb, priority, active, created_by, updated_at)
   hivv_grants     (id, principal, capability, constraints jsonb, approved_by, expires_at, memo)  -- the MAYBE survivors
   hivv_delegations(parent, agent, capability, limits jsonb, chain jsonb, revoked_at)              -- trusted agents + history
   hivv_audit      (id bigint, ts, actor, action jsonb, verdict, rule_id, risk, route_receipt,
                    prev_hash, hash GENERATED ALWAYS AS (sha256(...)) STORED)                      -- hash-chained ledger
   ```
3. **MAYBE = `human.approval` capability, already-built plumbing.** Engine returns MAYBE → create
   grant-request → push into the *owner's* inbox (`/api/agents/:id/inbox` long-poll — same
   mechanism as relay) → human answers `hivv approve <id>` / `hivv deny <id>` (CLI + dashboard
   bell) → executor proceeds with a scoped, TTL'd grant ("once" | "session" | "standing,
   ≤$5/day"). Nothing new needs inventing: consent + long-poll + ack already ship.
4. **Wire the gate at exactly one choke point:** `router.js` executes nothing that isn't first
   `policy.check(action)`. Plain chat gets a cached YES fast-path. Tools calls, relay jobs, and
   key-spending cloud calls all pass the same gate — the audit ledger then *is* the receipts
   system, extended: `X-Hivv-Policy: ALLOW rule=default-read` next to `X-Hivv-Answered-By`.
5. **Trust ties back to honey:** TRUST signal (§2) and RISK score (§3) both read
   `hivv_node_stats` (rank, streak, jobs served) — reputation is earned hub-side, so a
   queen-bee node can hold standing grants a larva never gets. Delegation: agents carry a
   chain (`alice → her-researcher-agent → sub-task`), `max_depth` in policy, revocable, every
   hop audited — that's the *delegation history* branch, queryable via `hivv policy history`.
6. **CLI/API surface:** `hivv policy show|set|explain <action>|history [--json]`,
   `hivv approve --list`, `GET/PUT /api/policy` (per-principal), `GET /api/audit` (admin/user).
   Account page gets a "Permissions" tab (AI perms, tool perms, data perms, spending limit,
   privacy rule, trusted agents) — same JSON doc,表单 view for humans.
7. **V1 scope discipline (keep it boring):** WHO=principal/role, WHAT=capability tier,
   COST=daily $ cap on cloud keys, RISK=static tier table, MAYBE=CLI approve/deny,
   AUDIT=hash chain. WHEN/WHERE/DATA-redaction start as *stored-but-inert* fields (schema ready,
   evaluator ignores) — resist the urge to build the whole OS at once.

**Touches:** `api/migrations/0xx_policy.sql`, new `api/lib/policy.js` (pure evaluator),
`api/lib/router.js` (choke point), `inbox-routes.js` (approval requests), `hivv-cli.py`
(approve/policy cmds), account.html/admin.html, `honey.js` + `perf.js` (signals).
**Done when:** (a) `hivv call fetch --url=…` as a fresh visitor returns MAYBE, a `hivv approve`
lets it run, and `hivv policy history` shows the hash-chained line; (b) a `financial.transaction`
probe from a larva-rank agent is rejected with rule id and never reaches any provider; (c) audit
rows verify (`prev_hash` chain intact).
**Effort:** L (1 week: M for engine+gate, +M for CLI/dashboard ergonomics)
· deps: §1 tiers (needed by RISK); §2 price model (needed by COST — can land in parallel)

---

## 4. How it fits together (the OS picture, one paragraph each)

- **Filesystem analogy:** capabilities are the *syscalls*, routes are the *scheduler*, policies
  are the *permissions+sudo*, the audit ledger is *syslog you can't edit*. HIVV becomes the
  machine an AI agent runs *on*, not an API an AI calls.
- **The family photo of a request:** envelope (§1) → strategy+transport (§2) → gate (§3) →
  execution → receipt+audit. Every arrow is a place you can say NO — which is what "trusting a
  distributed network with money and doors" actually requires.
- **What we deliberately don't build now:** agent-to-agent payments, a WASM/sandboxed
  `coding.execute` runtime, per-attribute DATA redaction pipelines, federation across hubs.
  Schema leaves room; evaluator doesn't implement. (Good-ideas-today, code-next-year.)

## 5. Sequencing & metrics

| Phase | Ship | Why |
|---|---|---|
| 1 | §1 registry + heartbeat advertising + `GET /api/capabilities` | pure data, zero behavior change, dashboard win |
| 2 | §3.1–3.4 engine + audit + MAYBE-via-inbox with tier defaults | safety exists before anyone notices |
| 3 | §2 strategy extraction + modes + `hivv route --dry-run` | the multi-protocol routing promise |
| 4 | §3.5–3.6 trust↔honey, delegation, CLI ergonomics + account Permissions tab | the social layer |
| 5 | reserved tiers (money/physical) get real backends when someone wires one | the frontier stays open |

**North-star metrics:** % actions passing gate on cached YES (friction — should be >95% for chat,
<100% for side-effects); MAYBE→approved ratio (calibration — too high = noisy, too low = asleep);
routes answered by non-default mode (are strategies real?); audit-verify green every day.
**Risks:** policy fatigue (batch approvals, standing grants); evaluator bugs locking users out
(always-allow emergency admin override, itself audited); routing-mode explosion (ship 4 modes,
not 7, first week); audit growth (monthly hash-chain snapshots, prune old rows keeping proofs).

---
*Shipped 2026-09-27. The OS boots: capabilities name the work, routes pick the bee, policy says YES/MAYBE/NO, the ledger remembers.*
