# HIVV.org — The Route Brain: evaluate-then-answer routing + HRP (Hive Route Protocol)

> **Redefinition:** hivv.org is not "a gateway that tries endpoints in order" — it is a
> **routing brain**. Every request asks: *which AI is wisest for THIS question?* A fast
> evaluator (the **Scout**) may spend one tiny AI call to decide; if it's confident, exactly
> one more call answers. Hard or novel questions fan out to several bees and a judge merges.
> A custom protocol (**HRP**) lets the hive evaluate its own members.
> Written 2026-11-13. Status legend: ☐ not started · ◐ in progress · ☑ done
>
> **Design law #3 — route on wisdom, not just speed.** Today's router ranks by tps ×
> reliability × model-name weights + jitter (`router.js _scoreTargets`). That predicts *fast*,
> never *correct*. `p_wise` — the probability the chosen AI will be wise for this task — becomes
> the first-class ranking signal. Speed stays as a tiebreaker/cost term.
>
> **Design law #4 — the evaluator is itself routed, and may be skipped.** The Scout is the
> cheapest, fastest thing available (hub-local tiny model). When Tier-0 confidence is high it
> is bypassed entirely: normal requests cost **1 AI call**, uncertain ones **2**, hard ones
> **K+1**. Never let evaluation cost more than the answer it saves.

---

## 0. What already exists (build on it, don't fork it)

| Existing piece | Where | Becomes |
|---|---|---|
| `_scoreTargets` / `_orderByMode` (6 modes, jitter, quality_weights) | `api/lib/router.js:146,201` | **Tier 0** — the zero-AI-call prior, now feeding p_wise instead of being the final word |
| perf.js EWMA per (node, model, via): tps, latency, ok-rate | `api/lib/perf.js` | reliability/speed inputs + the plumbing pattern for `hivv_route_wisdom` |
| `deriveNodeCaps(node)` + capability registry | `api/lib/capabilities.js` | hard pre-filter: only candidates whose caps satisfy the request |
| Relay inbox long-poll + ack + HMAC (`inference_job` type) | `api/lib/relay.js`, `api/routes/inbox-routes.js` | HRP transport — new message types ride the same channel |
| `hivv hive-mind` fan-out + bee-judge | `public_html/hivv-cli.py:5549` (client-side) | moves hub-side as **Tier 2** (`api/lib/judge.js`) |
| Route dry-run `GET /api/capabilities/route/dry-run` | `router.js routePreview` | gains `brain:` block — scout verdict + per-candidate p_wise |
| `X-Hivv-Answered-By` receipt | `router.js:719` etc. | sibling header `X-Hivv-Route:` (tier, p_wise, why) |
| `usage_logs.feature` column | migration 012 | scout/eval calls logged as `feature='scout'` / `'judge'` |
| `gateway_config.routing` JSONB | migration 008:127 | gains `scout`, `thresholds`, `wisdom` config |
| Spare-time monitor (10s micro-pings, GPU protection) | `router.js:298` | Scout calls respect it — never queue eval behind a busy owner GPU |

**The 2-call hazard (known):** headers + first SSE byte commit the response (`router.js:718–728`).
The Scout verdict **must** land before that point — it fits in the gap between policy gate and
first candidate fetch. Budget it; if it misses budget, fall through to Tier 0 order (never block
the stream on an evaluator).

---

## 1. Three tiers — the call ladder

```
request → policy gate (unchanged, §3 capability plan)
  │
  ├─ Tier 0: statistical prior (0 AI calls)
  │    capability filter → mode scoring (existing) → p_wise prior from hivv_route_wisdom
  │    ├─ top p_wise ≥ scout_skip_threshold (default 0.90) & warm stats ──► ANSWER   [1 call total]
  │    └─ else ▼
  │
  ├─ Tier 1: the Scout (1 tiny hub-local AI call, ≤400ms, ~60 output tokens)
  │    input: request (truncated) + top-K candidates (node, model, caps, p_wise prior)
  │    output: {bucket, difficulty, pick_index, reason}  → hub computes p_wise
  │    ├─ p_wise ≥ answer_threshold (default 0.80) ──────────────────────► ANSWER   [2 calls total]
  │    └─ else ▼
  │
  └─ Tier 2: fan-out + judge (K+1 calls, K=2..4 diverse bees, via relay or direct)
       judge merges/agrees → best answer; verdict + agreement feed calibration
```

- **Tier 0 skip is the "1 AI call" case.** Cold stats, novel buckets, or low confidence pull
  the Scout in. `mode` still matters: `private`/`localhost` are hard filters *before* any of
  this (unchanged), `cost` adds a price ceiling, `fast` may set `scout_skip_threshold: 0.95`
  (accept more risk for less latency).
- **Scout failure = silent degradation.** Timeout/unparseable → log, use Tier-0 order. The
  router must behave exactly as today if the Scout is down (feature-flag `routing.scout.enabled`).
- **Tier 2 triggers** on: `p_wise < escalate_threshold` (default 0.55) AND `difficulty ∈ {hard, novel}`
  AND ≥2 online candidates. Otherwise the lowest-p_wise candidate just gets the normal failover
  treatment (existing waterfall = safety net, not strategy).

## 2. p_wise — the math

**Honest constraint:** a tiny local model cannot emit a calibrated probability. It emits an
*ordinal judgment*; the hub maps that to a probability with measured history.

```
p_wise(candidate c, request q) =
    Bayes(node, model, bucket(q))        ← Laplace-smoothed: (α+1)/(α+β+2) from hivv_route_wisdom
  × scout_factor(bucket, difficulty, rank) ← lookup from config, nudged by scout verdict
  × capability_match(c, q)                ← 0/1 hard, from capabilities.js
  × quality_tier(model)                   ← existing _qualityOf(), normalized 0.6..1.0
  × reliability(c)                        ← existing ok-rate term
```

- **bucket(q)** = scout's classification when Tier 1 runs; a **zero-call keyword classifier**
  otherwise (code/math/translate/write/chat/vision — ~40 regexes, ships in Tier 0 so the skip
  path still knows the bucket).
- **Passive outcome signals** (calibration, no user burden — chosen per discussion):
  1. client aborted / retried the same question within 60s → previous answer scored **fail**
  2. failover fired after a candidate already errored → **fail** for that (node, model, bucket)
  3. Tier 2 judge agreement: judge-picked answer ≠ chosen answer → **fail** for the pick;
     agreement → **pass** for judge and pick
  4. Scout `pick_index` ≠ actual best (measured by 3) → scout_factor updated
  5. explicit 👎 hooks exist but weight = 0 until UI ships (later, cheap to turn up)
- **Decay:** α,β multiplied by 0.99 per flush tick (30s) so old wisdom forgets; samples column
  keeps confidence honest — `samples < 20` ⇒ clamp p_wise toward 0.5 (cold start = humility).

## 3. HRP — Hive Route Protocol v1

Rides the existing inbox long-poll (`GET /api/agents/:nodeId/inbox`) + REST result posts.
Versioned envelope, additive message types — nothing existing breaks.

### Message types

| Type | Direction | Payload | Purpose |
|---|---|---|---|
| `route_probe` | hub → node | `{probe_id, secret, battery: [{bucket, prompt, expected:"short"}], budget_ms}` | ask a bee to self-evaluate: run N tiny prompts locally, report quality/latency per bucket |
| (result) | node → hub | `POST /api/route/probe-result {probe_id, secret, scores:{bucket: {p_self, latency_ms}}, model}` | hub stores as *hint* — never overrides measured stats (hub-truth rule) |
| `route_hints` | node → hub (heartbeat ext.) | `{route_hints:[{model, strengths:["code","math"], self_score:7}]}` | cheap advertisement between probes; advisory only |
| `route_verdict` | hub-internal | `{tier, target:{node_id, model, transport}, p_wise, bucket, difficulty, reason, candidates:[{node,model,p_wise}], scouted:bool}` | the brain's output — logged, exposed, receipted |
| `route_feedback` | hub-internal | `{verdict_id, outcome:"pass"\|"fail", signal:"abort\|judge_agree\|retry\|..."}` | the calibration write that updates α/β |

### Schemas (v1)

```jsonc
// verdict — also the body of GET /api/route/last (per request, via X-Hivv-Route id)
{ "v": 1, "tier": 1, "p_wise": 0.87, "bucket": "code", "difficulty": "medium",
  "target": {"node_id": "gpu-01", "model": "gemma-4-e2b", "transport": "relay"},
  "reason": "python task, node has measured 0.94 pass rate on code, scout agreed",
  "candidates": [{"node_id":"gpu-01","model":"…","p_wise":0.87}, …],
  "eval_cost_ms": 210 }

// probe result
{ "v": 1, "model": "gemma-4-e2b",
  "scores": { "code": {"p_self": 0.72, "latency_ms": 410},
              "math": {"p_self": 0.40, "latency_ms": 520} } }
```

### Receipts & endpoints

- `X-Hivv-Route: tier=1 p_wise=0.87 bucket=code` — alongside existing `X-Hivv-Answered-By`
  (both streaming and non-streaming paths; set before first byte, same discipline as today).
- `GET /api/route/dry-run?…` → existing routePreview gains `brain:{verdict, skipped_scout:bool}`
- `GET /api/route/wisdom` → per (node, model, bucket) α/β/p/samples — public like the leaderboard
- `POST /api/route/probe-result` — HMAC-authed like relay results
- CLI: `hivv route` prints the brain block; `hivv route --scout` forces a live Tier-1 eval
  (debug/explain); `hivv nodes` gains a **WISDOM** column (avg p_wise per node)

## 4. The Scout itself

- **Endpoint:** hub-local only (decision made 2026-11-13) — `localhost:8080/11434/1234`,
  discovered by existing `discoverLocalEndpoints()`; config `routing.scout.{enabled,endpoint,model,budget_ms}`.
  If no local model responds → Tier 0 only (flag stays on, degrades).
- **Prompt:** system = "You are a routing scout. Reply ONLY with JSON." User = candidate list
  + truncated question (≤1.5k chars). Output schema `{bucket, difficulty:"easy|medium|hard|novel",
  pick_index, reason:"<15 words>"}`. Parse defensively: first `{…}` block, validate enum, else degrade.
- **Cost accounting:** counted, not free — `usage_logs` with `feature='scout'`, tokens from the
  local completion. Excluded from user cost totals; shown on dashboard as "hive overhead".
- **Concurrency:** max 4 in-flight scouts; a burst joins a shared verdict (same bucket+similar
  prompt hash) — evaluation should amortize across users asking similar things.
- **Streaming interplay:** scout runs *concurrently* with building the Tier-0 candidate list;
  the stream commits when both are done or `budget_ms` elapses (whichever first).

## 5. DB — migration 016 `hivv_route_wisdom`

```sql
CREATE TABLE hivv_route_wisdom (
  node_id   TEXT NOT NULL,
  model     TEXT NOT NULL,
  bucket    TEXT NOT NULL,            -- code|math|write|chat|translate|vision|novel
  alpha     DOUBLE PRECISION NOT NULL DEFAULT 1,   -- passes
  beta      DOUBLE PRECISION NOT NULL DEFAULT 1,   -- fails
  samples   INTEGER NOT NULL DEFAULT 0,
  last_at   TIMESTAMPTZ,
  PRIMARY KEY (node_id, model, bucket)
);
CREATE TABLE hivv_route_verdicts (      -- append-only, pruned at 30d (F5-style)
  id BIGSERIAL PRIMARY KEY, v INT DEFAULT 1,
  tier INT, p_wise DOUBLE PRECISION, bucket TEXT, difficulty TEXT,
  target_node TEXT, target_model TEXT, transport TEXT,
  reason TEXT, eval_cost_ms INT, scouted BOOLEAN,
  outcome TEXT,                          -- pass|fail|null (backfilled by route_feedback)
  created_at TIMESTAMPTZ DEFAULT now()
);
```
`gateway_config.routing` gains: `scout:{enabled,budget_ms:400,threshold:0.80,skip_threshold:0.90,
escalate:0.55,max_inflight:4}`, `wisdom:{decay:0.99,min_samples:20,cold_p:0.5}`.

## 6. Steps

### P1 ☐ Tier 0 + Scout behind a flag (the 1-vs-2 call ladder) — core
1. Migration 016 + `api/lib/wisdom.js` (load/decay/flush + `p(node,model,bucket)` + `record(outcome)`).
2. `api/lib/scout.js`: local-endpoint discovery reuse, prompt build, JSON-parse, budget, inflight cap, degradation.
3. Keyword bucket classifier (zero-call) so Tier 0 knows `bucket` without the Scout.
4. `router.js routeWithFailover`: insert brain step after policy gate — compute Tier-0 list + p_wise prior; skip Scout if `p ≥ skip_threshold`; else await Scout within budget; pick target by p_wise (mode weights still apply as multipliers). Verdict → `options.routeVerdict`.
5. Receipts: `X-Hivv-Route` on streaming + both non-streaming paths; first SSE frame gains `hivv_route` object.
6. `routePreview` + `hivv route` show the brain block; config flag off ⇒ byte-identical behavior to today.
**Done when:** with flag on, a warm confident request shows `tier=0` (1 call) and a novel request shows `tier=1` (2 calls) in receipts; with flag off, nothing changes. **Effort:** M (1–1.5 days)

### P2 ☐ Passive calibration loop
1. Hook signals 1–4 (abort/retry detection in server.js request lifecycle, failover-fail recording, Tier-2 judge agreement) → `route_feedback` → α/β update + `hivv_route_verdicts.outcome`.
2. Decay in the existing 30s perf flush tick; `GET /api/route/wisdom`; `hivv nodes` WISDOM column.
3. p_wise cold-start clamping (`min_samples`).
**Done when:** deliberately routing everything to a weak model for 20 requests measurably drops its p_wise and the brain stops picking it. **Effort:** M (1 day)

### P3 ☐ HRP probes + route_hints
1. Heartbeat extension `route_hints` (agent: compute from model metadata; hub: store, advisory).
2. `route_probe` inbox message + `POST /api/route/probe-result` (HMAC like relay) + `hivv-cli.py` battery runner (N=6 prompts, 100 tokens each, local ports).
3. Hub schedules probes: every 6h per online volunteer with models (jittered), results feed `scout_factor` priors; probes are policy-gated (`read` tier, consent = existing volunteer flag).
4. Command Center: per-node strength radar from wisdom + hints.
**Done when:** a fresh node that runs `hivv probe` (or auto) shows per-bucket self-scores in `hivv nodes`, and those scores nudge p_wise before any real traffic. **Effort:** M–L (1.5 days)

### P4 ☐ Tier 2 — hub-side fan-out + judge
1. `api/lib/judge.js`: port hive-mind logic — family-diverse pick of K candidates (reuse `_model_family` logic hub-side), fan out via relay inbox (works for NAT) or direct, judge on the best-scoring candidate, merge.
2. Wire as escalation after Scout when `p_wise < escalate && difficulty ∈ {hard,novel}`; K + judge logged as `feature='judge'`; agreement → calibration (signal 3).
3. `route_verdict.tier=2` in receipts; dashboard shows fan-out in the timeline.
**Done when:** a hard math question triggers K+1 calls, receipt says `tier=2`, and judge agreement feeds α/β. **Effort:** L (2 days)

### P5 ☐ Surfaces & polish
1. Chat UI: show `X-Hivv-Route` chip ("🧠 route: gemma via scout · 87% wise"); optional 👍/👎 → `route_feedback` (weight 0.15).
2. `hivv route --scout` explain command; dashboard "hive overhead" stat (scout+judge tokens vs answer tokens).
3. `mode` presets map to brain config (`fast` → skip_threshold 0.95, `quality` → escalate 0.70…).
**Done when:** a user can see *why* each answer came from the AI it did, in CLI and UI. **Effort:** S–M (0.5–1 day)

---

## Non-goals (v1)
- No ML model for routing (the Scout *is* the model; p_wise is Bayes + lookup, not learned weights).
- No self-reported trust: `route_hints`/`p_self` are priors only — measured honey/perf stats always win (hub-truth rule).
- No cloud Scout (privacy decision, 2026-11-13); no protocol changes to OpenAI-shaped endpoints.
- Relay remains buffered (no token streaming) — Tier 2 answers arrive whole; acceptable for hard questions.

## Risks
| Risk | Mitigation |
|---|---|
| Scout adds TTFB to every request | skip path (Tier 0) for warm/confident; 400ms hard budget; run concurrently with candidate-list build |
| Tiny model gives garbage JSON | defensive parse → degrade to Tier 0; count degradations, alert if >20%/10min |
| p_wise overfits tiny samples | `min_samples` clamp toward 0.5; 0.99 decay; verdicts pruned 30d |
| Two calls double cost | only when uncertain; scout is ~60 tokens local (free); dashboard tracks overhead |
| Gaming (node inflates hints) | hints are advisory; outcomes only from hub-observed signals |

## Effort total
**P1–P2: ~2.5 days** (usable brain: 1-vs-2 calls + calibration) · **P3–P4: ~3.5 days** (protocol + fan-out) · **P5: ~1 day**. Ship P1 behind `routing.scout.enabled=false` default, flip on hivv.org first, then default-on for all.
