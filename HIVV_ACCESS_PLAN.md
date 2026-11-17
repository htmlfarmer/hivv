# HIVV Access Plan — free hive tier · private keys · sellable access · free-area controls

Status: draft v1 — 2026-11-14 (after the yalla keyed-LLM incident)
Builds on: capability/policy layer (migration 008) · honey economy · `hivv dial` shim ·
relay busy-signals · `ai_keys` AES vault · usage_logs metering · Command Center

---

## 1. The vision (requirements, as stated)

- **R1 — two classes on every node:** a **FREE** key any hive member can use, and
  **PRIVATE** keys owners issue for controlled, per-person access.
- **R2 — busy semantics:** when a node is busy, FREE requests are refused (best-effort
  tier); private keys get customized/priority access.
- **R3 — sell access:** owners can sell their private-key access to others.
- **R4 — free-area controls + visualization:** each owner regulates how much *free* LLM
  time / GPU / CPU others may consume — visible live (bars, per-bee).
- **R5 — eventually all nodes run both tiers.**

## 2. Case study — yalla 2026-11-14: why the model server must not be the policy point

yalla's llama-server got ONE key (`--api-key-file`) → the hive got 401 → no routing, no
local review brains, invisible detection. The lesson:

> **Access policy belongs to a layer hivv owns (the local shim), never to llama itself.**
> Every node = owner key **upstream** (behind the shim, LAN-safe) + hivv credentials
> **downstream** (free hive cred + owner-minted private keys). yalla's setup stays exactly
> as it is — the shim simply becomes the thing that *presents* the key.

## 3. Architecture — the node access gateway (extend `hivv dial`)

The dial shim already exists (`DialHandler`/`DialServer`, `/healthz`, `/v1/*`,
EOF-framed JSON, sticky-bee, hub report-on-dial). Add two layers in front of upstream:

```
client ──► SHIM (localhost/LAN)
             ├─ auth:   hive-free cred | owner private key | (anonymous → hub only)
             ├─ admit:  free budget? busy?  ──► 429 BUSY/QUOTA (free tier)
             │          private: priority/quota per key policy
             └─ forward upstream WITH owner key (--api-key-file stays owner-only)
                    │
                    ▼
             llama-server --host 0.0.0.0 --api-key-file …   (unchanged)
```

- **FREE credential:** hub-signed rotating token pushed to agents via inbox (same HMAC
  pattern as repair plans: ttl + one-shot + revocable). Every bee holds it → R1/R5.
- **Admission knobs (the "free area"):** per-node config
  `free.tokens_per_day · free.gpu_minutes · free.max_concurrent · busy_high_watermark`
  (fed from `metrics.available_capacity` / `active_jobs` / GPU util — the heartbeat already
  carries these). Out-of-budget or over watermark → free gets `429` (R2/R4); router is
  told and routes elsewhere (relay already has `node busy` → extend the direct path).
- **Private keys:** owner mints `{key, who, quota, priority, price}` — stored in the
  `ai_keys` vault (AES-256-GCM, `hivv add` precedent), shim enforces quota/priority (R2).
- **Metering & receipts:** shim POSTs usage → `usage_logs` (route/report pattern);
  `X-Hivv-Answered-By` already attributes the serving bee. Free serving **earns honey**
  (1/100 tokens exists today) → closes the economy loop (R3 via honey, P4).
- **Sell access (P4):** owner lists a key (price/credits) → buyer pays **honey** first
  (honey v2 ledger) → hub issues a scoped key → quota enforced at the shim → earnings
  show on the owner's dashboard. Fiat later, off-platform (no payment processing in v1).

## 4. Reuse map — what's already built

| Need | Exists today | New work |
|---|---|---|
| Hive member credential | node `secret` + HMAC signed headers; inbox push; policy principals (`user:`, visitor id) | `free` cred type + rotation + `free:`/`key:` principals |
| Busy signal | relay `node busy` (relay.js:73), heartbeat `available_capacity`/`active_jobs`, circuit breaker, perf EWMA | shim admission + direct-path busy skip in router |
| Key vault | `ai_keys` AES-256-GCM, `hivv add <provider> <key>` | per-person rows: quota/priority/price columns |
| Budgets/config | `gateway_config` (relay key precedent), `hivv volunteer` | `serve` config per node + `hivv serve` CLI |
| Metering | usage_logs + `cost_*_per_mtok` + `feature` column + receipts | shim usage reports; honey credit/debit ledger |
| Currency | honey (earn: min/job/tokens) + `hivv_hive_events` multipliers + ranks | honey v2 **spend** ledger |
| Visualization | Command Center (GPU wall, charts, ticker), `hivv node`, `hivv stats`, `hivv upgrades` | "free area" panel (per-bee budget bar + busy state), `hivv serve` knobs |
| Enforcement testbed | tonight's suites: `tests/test_upgrade_review.py` + `api/tests/*` (`node --test`) | per-phase tests in both suites |

## 5. Phases

| Phase | Ships | Size |
|---|---|---|
| **P0** — yalla bridge | agent key-file auth (detect + local brains), hub `ai_keys` attach in `getAllEndpoints` — the "B path" from the yalla discussion | ~2–3h |
| **P1** — free tier + busy | hive-free cred (inbox-pushed, HMAC, ttl) · shim admission: budget + busy → 429 · router busy-skip · admission config | 1–2 days |
| **P2** — free-area controls + viz | `hivv serve [--free-tokens N] [--free-gpu P] [--busy-at P]` · Command Center **free-area panel** (per-bee bars) · `hivv node` quota line | 1 day |
| **P3** — private keys | `hivv key issue <who> --quota --priority [--price]` · shim enforcement · policy hash-chain audit on issuance/grants | 1–2 days |
| **P4** — sell access | marketplace listing (hub) · honey spend/earn ledger (honey v2) · owner earnings dashboard · receipts in usage_logs | 2–3 days |

Every phase ships tests in the existing suites (pytest + `node --test`), migrations from
**018** on, and AGENTS.md entries — the 2026-11-14 pattern.

## 6. Decisions needed (owner)

- **D1 currency:** honey-only for v1? *(recommend yes — no payment processing)*
- **D2 free default:** what's a node's default free budget before the owner tunes it?
  *(suggest: 30 free GPU-min/day or 50% of daily token capacity — pick one)*
- **D3 private-under-load:** priority = always-on, or owner-set floor?
  *(recommend: owner floor, default private wins over free)*
- **D4 anonymous public:** keep hub-relayed-only (strict rate limits) — never through
  shims? *(recommend yes)*
- **D5 coordination:** the dial shim is being actively extended in another session
  (AGENTS §E·dial) — the access gate lands **in that codepath**, not a fork.

## 7. Security notes

- Free cred: rotate + revoke via inbox; signed like repair plans (canonical JSON, sort_keys
  — cross-language HMAC contract pinned by tests).
- The shim forwards the owner key **upstream only**; it never appears downstream.
- Key issuance/revocation flows through the policy engine (hash-chain audit, `hivv approve`
  for high-risk caps like `financial.transaction` when sales go live).
- Budget/bypass attempts → `config_error` incidents (the locked-LLM pattern).
