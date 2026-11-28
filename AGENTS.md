# AGENTS.md — AI Guide for HIVV

This file helps AI agents quickly understand the HIVV codebase.
Last updated: 2026-11-17

> **Pronunciation:** HIVV is pronounced **HIVE** (like a beehive — /haɪv/), not like the HIV virus.

> **Brand:** HIVV is *a distributed AI network — at home and around the world*.

> **Active to-do list: see [`HIVV_BACKLOG.md`](HIVV_BACKLOG.md)** — release/signing steps for CLI
> binaries, relay rate-limiting, honey v2 extras, tech debt. Plan context: [`HIVV_PLAN.md`](HIVV_PLAN.md).

## What Is This?

HIVV is a **distributed AI network**. A network of computers (bees) shares LLM
capacity; the hub (hivv.org) is a registry and relay broker, not a bottleneck.
Inference traffic goes node → node directly.

**The same gateway runs locally.** A `git clone` of this repo boots a complete
gateway with **no PostgreSQL, no internet, and no secrets** — see
[Local-first mode](#local-first-mode) below. If hivv.org disappears, a local
install keeps working with its own models.

```
┌──────────┐   register/heartbeat   ┌──────────┐
│  Node A   │ ◄───────────────────► │  hivv.org │  ← just a phone book
│  .3:8080  │                       │  :3011    │
└─────┬─────┘                       └──────────┘
      │ LLM requests (direct)          │
      ▼                                │
┌──────────┐                      ┌────┴───────┐
│  Node B   │ ◄──────────────────►│  .33:8080  │
│  :8080    │   peer-to-peer      │  .135:8080 │
└──────────┘                      └────────────┘
```

## Architecture

| Component | Port | What |
|-----------|------|------|
| Gateway (API) | 3011 | Node.js Express server, main API |
| PostgreSQL | 5432 | **Optional** — users, keys, usage, sessions |
| Caddy | 443/80 | Reverse proxy, TLS, static files |
| LLM servers | 8080-8082 | llama.cpp, ollama (on each node) |
| hivv-tools | — | Python helper (search, news, math) |

## Directory Structure

```
/var/www/vhosts/hivv.org/
├── api/                    # Gateway server
│   ├── server.js           # Entry point (PM2 runs this)
│   ├── lib/
│   │   ├── router.js       # AI routing — local endpoints, provider failover
│   │   ├── omni-engine.js  # VRAM-protected universal AI engine
│   │   ├── orchestrator.js # Node registry, job distribution
│   │   ├── context-manager.js  # VRAM monitoring
│   │   ├── providers.js    # Cloud provider clients (OpenAI, Anthropic, etc.)
│   │   ├── circuit-breaker.js  # Fault tolerance
│   │   ├── honey.js        # bee identity: honey accrual, ranks, streaks, goals
│   │   ├── perf.js         # measured tokens/sec EWMA per node+model
│   │   └── relay.js        # NAT relay job queue (volunteer inboxes)
│   │   ├── telemetry.js    # DEEPER TELEMETRY: counters/histograms/gauges/spans/traces/SLOs
│   │   ├── task-queue.js   # THE task foundation: states, leases, budgets, idempotency
│   │   ├── mcp-client.js   # the OUTBOUND MCP client (we can call other MCP servers now)
│   │   ├── a2a-client.js   # the OUTBOUND A2A client (both bindings)
│   │   ├── hive-clients.js # the adapter layer: blnq · mcp · a2a · bridge · local
│   ├── routes/
│   │   ├── control-routes.js   # /api/nodes/*, /api/models, /api/control/*
│   │   ├── inbox-routes.js     # /api/agents/:id/inbox long-poll + ack
│   │   ├── honey-routes.js     # /api/hive/* (leaderboard, perf, share cards, timeline)
│   │   ├── capability-routes.js# /api/capabilities (+ /route/dry-run)
│   │   ├── policy-routes.js    # /api/policy (defaults, grants, audit, stats)
│   │   ├── relay-routes.js     # /api/relay/* (jobs, volunteers, stats)
│   │   ├── files-routes.js     # /api/files/* (upload/serve/delete for chat attachments)
│   ├── migrations/         # SQL schema files (007 = honey/perf/relay · 008 = capabilities/policy/grants/audit)
│   ├── ecosystem.config.js # PM2 config
│   └── package.json
├── public_html/            # Static files (served by Caddy)
│   ├── index.html          # Main website
│   ├── command-center.html # Live dashboard (pulse KPIs, ticker, charts, GPU wall, chain viz)
│   ├── hivv-cli.py         # CLI client (downloaded by nodes)
│   ├── hivv                # Bash wrapper (launcher)
│   ├── install-hivv.sh     # One-line install script
│   ├── api.html            # API documentation
│   ├── docs.html           # Swagger UI
│   ├── openapi.yaml        # OpenAPI spec
│   ├── hivv-page.html      # Website landing page
│   └── chat/                # Advanced chat UI (split into 3 files)
│       ├── index.html        # Shell: CDN libs (marked, highlight.js, DOMPurify), layout, drawer
│       ├── styles.css        # Theme, code blocks, panels, upload UI, drawer, voice
│       └── app.js            # Markdown rendering, streaming, controls, file upload, voice, conversations
├── scripts/
│   ├── update-ip.sh        # Public IP updater
│   ├── update-ip.py        # Python variant
│   ├── emergency-update.py # network-wide signed force CLI update (no per-box login)
│   ├── lib/deps.sh         # shared cross-platform dependency installer (node/python/pg/pm2)
│   ├── setup-local.sh      # clone-and-run setup (Linux/macOS/WSL/Git Bash)
│   └── setup-local.ps1     # clone-and-run setup (Windows PowerShell)
├── tests/                  # Regression tests — python3 -m pytest tests/ -q
│   ├── test_upgrade_review.py  # upgrade-gate FP/FN canaries + display helpers
│   ├── test_setup_scripts.py   # setup scripts MUST auto-install deps, never dead-end
│   ├── test_cli_install.py     # the `hivv` COMMAND on PATH + update never touches source
│   └── local_install/      # clone-and-run harness (no DB, no internet)
├── docs/
│   └── PARTNER-API.md     # the public /api/partner surface
├── sdk/                    # Agent SDK
├── setup.sh                # Server setup script
├── restart.sh              # Quick restart
├── status.sh               # Status check
└── AGENTS.md               # This file
```

## Key Patterns

### Node Registration
Nodes (machines running `hivv start`) register with the hub via:
- `POST /api/nodes/register` — initial registration
- `POST /api/nodes/{node_id}/heartbeat` — periodic heartbeat with metrics + local_models

The agent (`hivv-cli.py`) handles this automatically. Node names come from `socket.gethostname()`.

### AI Routing (`router.js`)
1. Check local endpoints (from `HIVV_LOCAL_ENDPOINTS` env var + auto-discovered localhost)
2. Check local provider keys (from database)
3. **Relay fallback** (`relay.js`): queue an `inference_job` into a volunteer node's inbox — works even behind NAT
4. Check cloud providers (OpenAI, Anthropic, etc. from database)
5. Circuit breaker prevents cascading failures

Endpoint order is biased by measured speed (`perf.js` EWMA, epsilon-greedy).
Responses carry `X-Hivv-Answered-By: node/model (direct|relay)` receipts.

**The decision is a factor vector, not a formula** (`api/lib/route-factors.js`, plan
[`HIVV_ROUTING_PLAN.md`](HIVV_ROUTING_PLAN.md) §7): every candidate is reduced to the SAME
eleven factors in [0,1] — **latency (TTFT) · speed · capacity (free VRAM × free slots) · queue ·
reliability · quality · cost · privacy · geography · capability · trust** — and a route mode is
nothing but a weight table over them: `score = 100·Σ(wᵢfᵢ)/Σ(wᵢ)`.
- **Weights are data** — `gateway_config.routing.weights.<mode>.<factor>` overlays the defaults
  (unknown names/negatives ignored, unknown mode → `balanced`).
- **Gates stay gates**: privacy and capability are hard filters; their *factors* only rank
  candidates that already passed. A weight can never buy back a gate.
- **Unknown ≠ measured.** Capacity/queue/geography/capability are NEUTRAL with no data; speed
  falls back to the low 8 t/s prior and latency to a pessimistic 5000 ms; reliability falls back
  to 1.0 so a new bee is not locked out.
- **TTFT is measured** (stream loop → `perf.record({ttfbMs})` → `hivv_model_perf.ewma_ttfb_ms`,
  migration 030; `latency_ms` is the whole reply and overstates the wait). `perf.seed()`
  rehydrates the EWMA map from the DB on boot, so a restart no longer resets the hive to
  "unknown bee".
- **Explainable**: `GET /api/capabilities/route/dry-run` returns a `routing` block (formula,
  weights, total, hub geo) and every candidate row carries its `factors`; `hivv route` prints
  both. `routing.hub_location` sets the hub's coordinates for the geography factor (`'off'` disables it).
- **Measurements are keyed `node::model`, not `node`** — a bee serving two models must not
  hand both candidates the same tps/latency. Error-only rows (`ok=0`) are KEPT in that map:
  skipping them deleted the exact pair and the candidate fell back to the host, so a model that
  had failed 6/6 borrowed a healthy sibling's tps/TTFT and looked exactly as fast (found live).
  They keep zero counters → the unknown/pessimistic priors, and `okRate=0` → the reliability
  **floor of 0.25** — reachable, never outranking a healthy bee.
- **Non-streaming replies count too.** `/api/chat` defaults to `stream:false` (it is what
  `hivv eval` uses) and a non-streaming upstream sends ONE JSON body with `message.content` —
  no deltas. The loop used to look only for `delta.content`, so those replies recorded **zero
  tokens** (no speed signal at all) and never set a TTFT.
- Tests: `api/tests/route-factors.test.js` (39) — monotone normalizers + the **mode intent
  contracts** (fast → lowest TTFT, quality → best model at equal speed, cost → donated beats
  priced, trusted → honey rank, private → LAN > public > cloud, balanced → faster/healthier/
  less-loaded) + the sibling-borrowing regressions + a real fake-upstream test for the
  non-streaming TTFT path + a canary against the old `switch(mode)` formulas.

### The Toolkit — twelve tools for every bee, every AI

Shipped 2026-11-22 — plan: [`HIVV_TOOLKIT_PLAN.md`](HIVV_TOOLKIT_PLAN.md).

**One catalog, one implementation, many surfaces.** `api/lib/toolkit.js` is the
source of truth: every tool declares its canonical name, aliases, the capability
key the policy gate evaluates, a JSON schema, where it can run, and its handler.
MCP, the chat tool loop, `POST /api/tools/:tool/invoke`, the CLI and the bee-side
server all read from it — they cannot drift apart.

| # | tool | capability | verdict | runs on |
|---|---|---|---|---|
| 1 | `web_search` | `web.search` | **ask** | hub + bee |
| 2 | `current_time` | `local.computation` | allow | hub + bee |
| 3 | `calculator` | `local.computation` | allow | hub + bee |
| 4 | `web_fetch` | `web.fetch` | ask | hub + bee |
| 5 | `http_request` | `web.fetch` | ask | hub + bee |
| 6 | `code_interpreter` | `coding.execute` | ask | hub only |
| 7 | `file_read` | `data.file.read` | ask | hub + bee |
| 8 | `file_search` | `data.file.read` | ask | hub + bee |
| 9 | `memory` | `data.memory` | allow | hub only |
| 10 | `text_parser` | `local.computation` | allow | hub + bee |
| 11 | `timezone_convert` | `local.computation` | allow | hub + bee |
| 12 | `translate` | `translation` | allow | hub only |

(plus `sysinfo`, kept alive for the bees that already advertised it.)

- **AUTO-ATTACHED.** The hub attaches the toolkit schemas to every chat request
  when the client sends none — the tool loop only ever ran when a client passed
  `tools` in the body, and nobody does, so no model on the network ever used a
  tool. Opt out with `"tools": false`, `"tools": []`, or `X-Hivv-Tools: off`;
  narrow it with `X-Hivv-Tools: calculator,current_time`. Cost ≈1850 prompt
  tokens per request — **or ask for a PROFILE**:
- **PROFILES — the speed/context-window lever.** Default context is 8192
  (gemma/qwen) and 4096 for llama-class models, so the full payload is **25% of
  an 8k window and 50% of a 4k one** before the user speaks. Two orthogonal
  levers, which compose:

  | spec | schemas | briefing | total |
  |---|---|---|---|
  | *(default, = all)* | ~1845 tok | ~271 tok | ~2116 |
  | `X-Hivv-Tools: fast` | ~430 | ~123 | ~553 |
  | `X-Hivv-Tools: fast,lean` | ~274 | ~123 | ~397 |
  | `X-Hivv-Tools: all,lean` | ~1051 | ~271 | ~1322 |

  `fast` = `calculator, current_time, timezone_convert, translate` — and it is
  **allow-tier ONLY on purpose**: web.search / web.fetch / coding.execute /
  data.file.read are `ask`, so a "fast" request carrying one could stall waiting
  for a human to approve a grant. Add one explicitly when you want it:
  `X-Hivv-Tools: fast,web_search`. Body-level `tool_profile: "fast"` does the
  same for SDKs that cannot set custom headers (header wins when both are set).
  `lean` drops per-property prose and cuts descriptions to one sentence —
  property NAMES/types/enums survive, only the prose goes; it is opt-in because
  that prose does carry signal for tricky tools.

  **The briefing is filtered to the tools actually attached**, so a `fast`
  request is never told to use web_search it was not given (and never claims
  "you have the tools" for news it cannot fetch). With all tools attached the
  briefing is **byte-identical** to the pre-profile text — pinned by
  `api/tests/tool-profiles.test.js`. `/api/chat/continue` now resolves tools
  explicitly instead of injecting a briefing while sending `tools: null`.
- **The streaming path has a REAL tool loop** (`lib/tool-stream.js`): the router
  writes provider frames straight to the socket, so a tool_call used to reach the
  client before the hub could run it — and a client that receives an unexpected
  tool_call executes it itself. `ToolStreamInterceptor` holds the tool frames
  back, forwards content frames live, and lets the hub run the tool and ask the
  model again. The client sees ONE clean answer.
- **The hub is authoritative.** Every bee reaches the hub, so every bee gets
  every tool with nothing to install. `public_html/hivv-tools.py` serves the
  deterministic half locally (clock, calculator, timezones, parser, sysinfo) and
  PROXIES the rest to the hub; `POST /tool/<name>` calls any tool in the catalog.
- **Web search is BUILT and TESTED but NOT granted** (`HIVV_ENABLE_WEB_SEARCH=0`,
  the default): `web.search` is `ask`, so the first call mints a pending grant a
  human approves, and the schema is not advertised to models. Set the flag to 1
  to advertise it and let an operator on loopback run it un-gated.
- **New capabilities** (migration 022): `data.file.read` (ask), `data.memory`
  (allow), plus the `hivv_memory` table. Migration 022 also fixes two bugs:
  `web.search` allow→ask, and `coding.execute` tier `compute`→`side-effect`
  (the verdict had moved to ask in 011 but the TIER had not, so the risk score
  for running code was 1 — the same as plain chat — and the chat tool loop
  skipped the gate for `exec`/`shell`/`run` entirely).
- **No `eval` anywhere.** `api/lib/math.js` and the bee's calculator are
  hand-written recursive-descent parsers. The old hub calculator stripped
  `sqrt(2)` to `(2)`; the old bee calculator used `eval()` on a regex-cleaned
  string — a code-execution primitive wearing a calculator's clothes.
- **Identity, not source IP.** The tool route identifies the caller by the
  signed `hivv_visitor` cookie (or `x-visitor-id`), the same identity the chat
  path uses. It used to fall back to `ip:<req.ip>` — behind a CDN that is the
  edge node's address and it changes between requests, so a standing grant was
  never reusable and every call asked a human again.
- **Surfaces**: `GET /api/tools/catalog` (schema + capability + your verdict) ·
  `GET|POST /api/tools/:tool/invoke` (hub; `{"via":"node"}` proxies to a bee) ·
  `/mcp` (18 tools) · `GET /v1/capabilities` (publishes the catalog) ·
  CLI `hivv tools list` / `hivv call <tool> --json '{...}'` · `hivv exec`.
- Tests: `tests/test_toolkit.py` (57) — catalog integrity, the math evaluator
  against hostile input, the parsers, the timezone converter (offsets, DST,
  differences), the SSRF guard, the memory store, the SSE interceptor, and a
  live round trip that proves an approved grant is reusable.

### hivv OS (capabilities · route modes · policy gate)

Shipped 2026-09-27 — plan: [`HIVV_CAPABILITY_POLICY_PLAN.md`](HIVV_CAPABILITY_POLICY_PLAN.md).

- **§1 Capabilities** (`lib/capabilities.js`): registry table `hivv_capabilities` (key, tier,
  default_verdict); `deriveNodeCaps(node)` computes what each bee can do from hub-observed truth
  (local_models → reasoning/vision, shared tools → web.search/fetch/local.computation).
  `GET /api/capabilities`, `/api/capabilities/node/:id`, `/api/capabilities/route/dry-run`.
- **§2 Route modes** (`router.js` `_scoreTargets/_orderByMode`): modes
  `balanced|quality|fast|cost|private|trusted` score the SAME candidates differently; transports
  (local→direct→relay→cloud) are interchangeable — `privacy` is a hard filter (localhost/hive/any),
  `max_cost` filters priced cloud providers (`ai_providers.cost_*_per_mtok`). Weights tunable in
  `gateway_config.routing`. CLI: `hivv chat --mode=cheap|fast|private|smart`, `hivv route` (dry-run).
- **§3 Policy gate** (`lib/policy.js`): every action → `gate()` → ALLOW / ASK (mints pending
  grant in `hivv_grants`, human answers `hivv approve|deny`) / DENY. Chat = risk-1 fast-path,
  no DB writes. Standings grants (default 30d) lift ASK. Wire-points: `routeWithFailover`
  (ALL chat + capability envelopes), hub `execToolCall`, `GET /api/tools/:tool/invoke`,
  `POST /api/sandbox/exec`. Decisions → `hivv_audit` hash-chain (`prev_hash`→`hash` via
  canonical-JSON sha256; verify with `GET /api/policy/audit/verify` — survives UPDATE tampering,
  proven with a live UPDATE→verify-flips-red→restore test). Fail-open if registry/DB dies
  (chat), fail-CLOSED for `coding.execute`.
- **MAYBE = push, not just poll** (2026-09-28): `policy.setNotifier()` broadcasts an
  `approval_request` into every online node's long-poll inbox the instant a grant is minted;
  the agent stashes it (`~/.local/share/hivv/approvals.json`) and `hivv up` nudges. High-risk
  caps (`coding.execute`/`financial.transaction`/`physical.world`) require an ADMIN to approve —
  the requesting principal cannot self-approve (403).
- **§1 Isolated sandbox** (`lib/sandbox.js`, 2026-09-28): `coding.execute` runs ONLY in an
  ephemeral jail — docker preferred (`--network=none` · `--memory`/`--memory-swap` 256m ·
  `--cpus` 0.5 · `--pids-limit` 64 · `--read-only`+tmpfs · `--cap-drop=ALL` ·
  `no-new-privileges` · default seccomp · `--rm`), bwrap fallback (`--unshare-all`), refuse if
  neither. Hard watchdog timeout (SIGKILL), output/size caps, code passed via ro temp file
  (never a shell). Registry verdict deny→**ask** (migration 011). `GET /api/sandbox/status`.
- **Receipts**: `X-Hivv-Policy: ALLOW <rule>` header alongside `X-Hivv-Answered-By` — on
  streaming AND both non-streaming chat paths; sandbox adds `X-Hivv-Sandbox: <runtime>`.
- **API/CLI**: `GET/PUT /api/policy*` (principals: visitor id / user:<id>; admin = localhost,
  HIVV_CONTROL_TOKEN, or admin session) · `hivv cap|policy|approve|deny|route|exec`
  · Command Center 🧬 Capabilities + ⚖️ Policy & Audit views (approve/deny buttons).
- ⚠ `hivv call` was in COMMANDS but never dispatched (smart-default ate it as chat) — fixed 2026-09-27.
- **Tools-share persistence** (2026-09-28, F7): the agent re-announces `tools`+`tools_port` in
  EVERY register + heartbeat, and the hub preserves/applies them — so `web.fetch`/`web.search`
  survive agent restarts (were lost on re-register). `toolToCap` no longer defaults unknown
  tools to allow-tier `local.computation` (→ `tool.<name>` → MAYBE).

### The proposal pipeline — the source changes itself (2026-11-26)

Plan: `HIVV_SELF_MODIFICATION_PLAN.md` — the invariants, the threat model, and
the 4-month / 1-year build plan.

HIVV can already write code (`hivv code`) and already gates every action
(`lib/policy.js`). What it did NOT have is the thing that makes a
self-modifying project safe: **a change travelling from "a diff someone made"
to "a merge that landed", with the evidence attached to every step.**

**One unit of work — the PROPOSAL — and one law:**

> A gate may be marked `passed` only when every earlier gate is `passed`.

There is no `skip`, no `force`. A proposal that tries to merge without a
green test run is refused BY THE MACHINE (`api/lib/proposal.js`), not by a
reviewer remembering to check.

| Gate | Question | Enforced by |
|---|---|---|
| **G1 study** | what does this change DO? | deterministic (fast-scan · secrets · injection) + model votes |
| **G2 authorize** | may it happen at all? | the EXISTING policy gate, capability `source.modify` (side-effect, default **ask**) |
| **G3 test** | does it work? | the **BASELINE** suite from `base_sha` — never the suite the change ships |
| **G4 approve** | do enough independent parties say yes? | quorum + distinct model families + no self-approval + a human for protected paths |
| **G5 merge** | land it, signed, undoable? | Ed25519 receipt + a rollback artifact outside the changed tree |

**The five invariants** (§1 of the plan) are what all of that protects:
**I1** no change lands without evidence · **I2** the reviewer is never the
reviewed · **I3** the verifier is not the verified · **I4** the rollback never
depends on the change · **I5** a diff is DATA, never an instruction.

**The two rules the first implementation taught us** — both pinned by tests:

1. **Scan what the change INTRODUCES, not the whole file.** A diff review is
   about the added lines. Re-scanning the base flagged every `subprocess.run`
   the codebase already had: 32 findings instead of 8, and the real signal
   drowned in the noise of the existing tree.
2. **A low-confidence signal routes to a HUMAN; it does not block.** An
   injection finding (the phrases appear in this project's own docs about
   injection) and a RISKY model vote (a 0.5B called a two-line function
   "undocumented and unused") both set `needs_human`, which the approve gate
   demands a signature for. Only the deterministic findings — `hard_danger` and
   `secrets` — block. Blocking on a model's opinion would make the project
   unmergeable by its own reviewers.

**Files:** `api/lib/proposal.js` (the state machine) ·
`api/routes/proposal-routes.js` (`POST /api/proposals` +
`/:id/{study,authorize,test,approve,merge,reject}` + `/:id/verify`) ·
`api/migrations/034_hivv_proposals.sql` · `identity.proposalReceipt()` ·
capability `source.modify`.

**THE WRITE PATH IS CREDENTIAL-FREE BY DEFAULT.** An agent hands back
`git format-patch`; a machine with write access runs the gates. Zero secrets
are shared with an agent, so there is nothing to leak and nothing to revoke.
A human who already has a repo-scoped PAT can use `hivv propose --push` and
open the PR directly — the same path, just shorter.

**CLI**: `hivv propose [--staged|--file F|--patch FILE|--stdin] [--votes N]
[--no-review] [--dry-run] [--patch-out FILE] [--push] [--no-tests]` (the
study chain, blocked by default, and a push only on authorization) ·
`hivv contribute [--install] [--clone DIR]` (git/gh/clone/gh-auth report +
the whole loop, for someone who already installed).

**Machine-discoverability** (an AI that lands on hivv.org must be able to start
helping without being told): `/ai.txt` carries a `contribute` block (repo,
clone URL, raw doc URLs, the branch-per-task rule, the test commands, the
publish chain, and the write-path policy) · `CONTRIBUTING.md` says yes to
machine PRs in writing and names the protected paths · the homepage footer
links the repo.

**Bugs found and fixed on the way:**
- **`rm -rf` was invisible to the scanner** — in BOTH implementations
  (`fast-scan.js` and the CLI), `-[rf]` matched ONE character and the
  trailing `\b` then failed on the second letter. The most destructive command
  in the shell slipped through. Fixed as `rm\s+-[a-z]*[rf][a-z]*`, parity-pinned
  by `tests/test_fast_scan_parity.py`.
- **The stale-tools-server bug the hive reported was already fixed** in
  `0321868` (the watchdog session) — `hivv tools on` now checks the
  catalog's SHAPE plus a real tool call and replaces a stale server. The report
  came from a pre-fix copy.

**Tests**: `api/tests/proposal.test.js` (31 — the no-skipping law, the five
invariants, the receipt chain + tamper detection) · `tests/test_propose_cli.py`
(13) · `tests/test_dev_tools.py` (24 — the git/gh provisioning) ·
`tests/test_fast_scan_parity.py` (+3 `rm -rf` cases).

#### Stage 2 — the intake funnel and the ONE credential holder (2026-11-27)

A second session built this end while Stage 1 was landing; both halves are in
main now, **reconciled rather than merged blindly** (commit `6f9950e`).

**Theirs** — `api/lib/proposal-funnel.js`: six stages, in order, and the
**order is the law** — `verify → limit → dedupe → screen → review → policy`.
The rule the file keeps: **a stage may only WEAKEN the outcome, never
strengthen it.** Dedupe is the point of the whole thing: five bees with one
idea become **one** proposal with five votes, not five issues. A vote is an
*identity* (`{node_id, principal, at}`), not a counter — a number can be
inflated by a loop, a list of principals can be audited, and the same bee
twice counts once.

**`api/lib/github-relay.js` — the ONLY secret-holder.** Nodes never hold a
GitHub credential; the hub holds exactly one, behind a policy gate. With no
token it is a **stub** that writes real artifacts locally, so local-first
still works with zero secrets. Idempotent by marker — a retry returns the
SAME issue, never a second one.

**Their `router.js` fix (K1) is unrelated to proposals and is a real bug**: the
empty-candidate fallback dropped the ownership filter, so a private key
(`userId` set, `is_shared` false) became the catch-all for every OTHER user
and for anonymous visitors whenever their own filtered set came up empty.

**The reconciled contract** — what survived from each side:

| Rule | From |
|---|---|
| A RISKY vote does **not** block; it sets `needs_human` | **mine** — theirs still blocked, which would let a 0.5B model's opinion make the project unmergeable by its own reviewers |
| `deterministic_only` (unreviewed) is accepted but demands a human | **mine** |
| `create()` allows a **patchless** proposal when there is a `body` | **theirs** — a bug report has no diff; refusing it throws away what the funnel exists to collect |
| `repo` defaults to this hive's source | **theirs** |
| `needs_human` seeded from `protected_hit` at creation | **theirs** |
| `PROTECTED_PATHS` += `node-auth.js` · `fast-scan.js` · `github-relay.js` · `proposal-funnel.js`; `PROTECTED_PREFIXES` += `.keys/` | **theirs** |

**Migration numbering — both sessions reached for 033.** Theirs keeps it
(`033_hivv_permissions_demo_flag` — a real fix: `is_demo` on
`hivv_permissions`, which 032 missed); the proposals table is `034`, the
funnel `035`. After the renumber their staged `034_hivv_proposals.sql` was
**byte-identical** to this one, so their intended numbering held and neither
side had to redo anything.

**Tests:** `api/tests/proposal-funnel.test.js` (31) +
`api/tests/key-isolation.test.js` (10).

### Bee Identity (`honey.js`)
- Hub-side sweep every 60s mints honey from heartbeat-truth only (never node self-reported):
  1/minute online · 10/job · 1 per 100 tokens served
- Ranks: larva → worker → forager → scout → royal-jelly → queen-bee (see `HIVV_PLAN.md` #1)
- Streaks reset after >1 day offline; weekly hive goal in `hivv_hive_goal`
- Public read API: `/api/hive/{leaderboard,honey/:node,goal,perf,share-card/:node.svg}` · relay API: `/api/relay/*`
- CLI: `hivv honey [--board]`, `hivv hive-mind "q"` (family-diverse fan-out + judge), `hivv share --card`

### Local LLM Discovery
The gateway probes these ports on startup:
- `localhost:8080` — llama.cpp (primary)
- `localhost:11434` — ollama
- `localhost:1234` — lmstudio
- Remote endpoints via `HIVV_LOCAL_ENDPOINTS` env var (comma-separated URLs)

### Local-first mode (`lib/local-mode.js`)

A `git clone` of this repo must run with **no PostgreSQL, no internet, and no
secrets**. That is a hard promise, enforced by `tests/local_install/`.

| Env var | Meaning |
|---|---|
| `HIVV_MODE` | `local` (never contact the hub) · `hive` · `auto` (default) |
| `HIVV_DB_REQUIRED` | `0` makes Postgres optional (default `1`) |
| `HIVV_DATA_DIR` | State dir — defaults to `~/.local/share/hivv` (macOS: `~/Library/Application Support/hivv`, Windows: `%LOCALAPPDATA%\hivv`) |
| `HIVV_PORT` / `PORT` | Listen port (default 3011) |
| `HIVV_HIVE_JOIN` | `1` opts in to registering with hivv.org |
| `HIVV_HIVE_URL` | The hub to join (default `https://hivv.org`) |
| `HIVV_INSTANCE_ID` | Stable id for this installation (auto-generated) |

When there is no database:
- `pool` is `null` — every DB-backed path short-circuits (`honey.js`,
  `policy.js`, `capabilities.js`, the health monitor).
- The policy gate returns `allow` with rule `local:offline` (a local gateway
  is single-user by definition).
- Provider keys load from `$HIVV_DATA_DIR/keys/*.json` instead of Postgres.
- The session secret is generated once into `$HIVV_DATA_DIR/.session-secret` (0600).
- `/api/health` reports `healthy` with `database: "disabled"`.
- The public hive is NEVER contacted unless `HIVV_HIVE_JOIN=1`.

Setup: `setup.sh` (Linux/macOS/WSL/Git Bash) or `scripts/setup-local.ps1`
(Windows PowerShell).

**Setup scripts INSTALL dependencies — they never dead-end.** The shared
library `scripts/lib/deps.sh` handles Node.js 18+, npm, Python 3.8+,
PostgreSQL and PM2 across `apt · dnf · yum · pacman · apk · zypper · brew ·
winget · scoop · choco`, with a no-sudo user-local fallback for Node
(package manager → NodeSource → fnm/nvm → official tarball into
`$HOME/.local/node`). If auto-install genuinely cannot proceed, the script
prints the exact copy-paste command for that OS instead of `exit 1`.

Rules the setup scripts must keep (pinned by `tests/test_setup_scripts.py` +
`tests/test_setup_prompts.py`):
- never print a bare "X is not installed" and exit — auto-install or print
  the exact command
- never prompt for a `sudo` password (`sudo -n` only — a prompt hangs CI)
- PostgreSQL stays OPTIONAL — local-first mode needs no database
- Node 18+ is the only hard requirement
- **ASK, don't decide**: install scope (user-local vs system-wide/root),
  local LLM install, and hive membership are all user decisions
- a prompt with no TTY takes its default silently (never hangs CI)
- `d_ask_choice` prints its MENU to **stderr** and only the INDEX to
  stdout — otherwise `choice="$(d_ask_choice ...)"` captures the menu and
  the caller's `case` silently matches nothing
- prompts read **stdin**, not `/dev/tty` (absent under cron/containers/CI)

**The setup scripts must also install the `hivv` COMMAND (not just the
clone's copy).** A clone holds a working CLI but nothing put it on PATH, so
`hivv chat` said "command not found" right after a successful setup while the
script's own next-step text said "hivv chat" (pinned by
`tests/test_cli_install.py`). The layout is a CONTRACT — do not invent
another one:

```
<prefix>/bin/hivv              ← the wrapper (bash)
<prefix>/lib/hivv/hivv-cli.py   ← the client (python)
```

The wrapper resolves the client relative to ITSELF, and `hivv-cli.py` derives
`INSTALL_DIR`/`BIN_DIR` from its own location the same way. So in this layout
`hivv update` updates the **installed** copy. `deps.sh` does it via
`d_install_cli <prefix> <use_sudo> <public_dir>` (user → `~/.local`,
system → `/usr/local`); `d_ensure_path` keeps the bin dir on PATH in future
shells.

> ⚠ **`hivv update` must never write into a git checkout.** Run from a clone
> with no install prefix, the old code fell back to "the file I am executing"
> and silently replaced the repo's own CLI with the hub's copy. The CLI now
> refuses (`_in_git_worktree` + `_update_target`), `--force` overrides, and an
> identical file still updates cleanly — so `hivv update` keeps working on the
> hub host, where the served file *is* the source of truth.


- the gateway is NOT a hive node: `HIVV_HIVE_JOIN` only lets the gateway
  QUERY the hub. Registration happens in the CLI agent (`hivv start`,
  `POST /api/nodes/register`), so setup must start the agent when the user
  says yes to joining.

### Partner surface (`routes/partner-routes.js`)

The public, versioned integration API for other websites — everything under
`/api/partner`. See `docs/PARTNER-API.md`.

| Endpoint | Purpose |
|---|---|
| `GET /api/partner/manifest` | Machine-readable description of this instance |
| `GET /api/partner/health` | Liveness + local models + hive status (no DB needed) |
| `GET /api/partner/models` | Models this instance can serve right now |
| `GET /api/partner/capabilities` | Capability registry |
| `GET /api/partner/network` | The live hive roster |
| `POST /api/partner/fast-scan` | **Free, deterministic, AI-free** source screen |
| `POST /api/partner/review` | Signed source review (uses a model) |
| `POST /api/partner/verify` | Verify a signed attestation |
| `GET /api/partner/attestation/key` | This instance's verification public key |

### The live numbers — one endpoint, one binding, no lies (2026-11-26)

The website used to bake its numbers into the HTML: `"3 bees"`, `"64 TOK/S"`,
`"~27 KB"`, `"23 providers"`, `"85% allowance"`, a throughput chart
drawn with `Math.random()`, and **nine invented map markers** in San Francisco /
New York / London / Paris. The API was worse: it answered `+12845 agents`,
`+894520 actions`, `+340 nodes online` — so a page that fetched the truth
still rendered a lie.

**The law now:**

1. Every number that claims to describe NOW is **MEASURED**.
2. **One endpoint is the source of truth**: `GET /api/hivv/stats`
   (the legacy door `/api/hive/stats` serves the identical payload).
3. Pages **declare** their numbers instead of typing them:
   `<span data-hivv-stat="bees.online">`.
4. `null` means **no data**, never `0`.

**`/api/hivv/stats`** — grouped, cached 10 s, never throws (a stats endpoint
that 500s takes the page down with it):

| Block | What it carries |
|---|---|
| `bees` | `registered` `online` `offline` `stressed` `volunteers` `countries` `cities` + the lists |
| `models` | `total` `distinct` `providers_active` + the model names |
| `capacity` | `total_cpus` `total_memory_gb` `free_memory_gb` `total_workers` `available_capacity` |
| `performance` | `requests_today` `tokens_today` `top_tps` `avg_ttfb_ms` `total_jobs` `success_rate` `cost_today` |
| `honey` | `total` `leader` `leader_honey` `leader_rank` `bees` |
| `bridge` | `peers` `allowance_percent` `allowance_mode` |
| `gateway` | `version` `uptime_seconds` `providers_active` `database` `hub` (the hub's REAL lat/lon) |

**`public_html/js/hivv-live.js`** — the ONE binding. Drop
`<script src="/js/hivv-live.js"></script>` + `HIVVLive.start()` into a page
and every `[data-hivv-stat]` element fills itself. Attributes:
`data-hivv-stat` (dotted path), `data-hivv-format`
(`int|dec1|compact|pct|tps|ms|bytes|duration|plain`), `data-hivv-default`,
`data-hivv-prefix`, `data-hivv-append`, `data-hivv-title`.
The nav bee pill uses `data-hivv-pill` + `data-hivv-pill-count` +
`data-hivv-pill-dot` (the dot recolours: green all up, amber partial, red none,
grey unknown). A failed fetch shows an em dash — it never leaves a stale
number frozen on screen pretending to be current.

**`orchestrator.isLive(node)`** — the one truth for "is this bee alive".
The `status` LABEL is not enough: a gateway restart rehydrates the roster from
disk and labels a week-old bee `stale`, so counting `status !== 'offline'`
counted three dead boxes as LIVE and the site published "6 online" when three
could answer. A bee is alive when it has **heartbeated within the stale
threshold** (3 min). Every counting site asks the heartbeat now
(`control-routes` `honey-routes` `mcp-routes` `partner-routes`
`tool-routes` `telemetry-routes` `capabilities` `honey.js`).

**The CDN libs were dead too.** The CSP is `script-src 'self' 'unsafe-inline'`
— no CDN script may load, so d3, Chart.js, marked, DOMPurify, highlight.js
and Swagger UI were all blocked and the charts rendered nothing. They now live
on our own box under `public_html/lib/` (the same call the Leaflet/tile work
already made).

**Tests**: `api/tests/live-numbers.test.js` (15) — the endpoint, the brand
doors, `isLive` in every counter, no fabricated offsets, the nav pill, the
charts, the map, the script tags.

### ONE navigation, and it lists EVERY page (2026-11-26)

Every page used to carry its **own** hand-written nav, and every one of them
listed a **different subset** of the site. `nodes.html` linked to `/hivv.html`
— a page that does not exist. `status.html` linked to `/api.html` while
every other page linked to `/docs`. The map had no Home link. A dozen pages had
no nav at all. *“Some pages are missing” was not a feeling: it was forty
different navs.

**`public_html/js/hivv-nav.js`** is now the ONLY nav. One component, one
inventory, every page:

- **the primary row** — Map · Chat · Governance · Status · Live · Nodes ·
  Install CLI · API Docs, then the **live bee pill** (real numbers from
  `/api/hivv/stats`, never a typed one) and the **“All pages”** button.
- **the “All pages” panel** — **every page the site serves** (40 of
  them), grouped by what it is FOR: *The Hive* · *Talk & Build* ·
  *Governance* · *The Project*, each entry with one line saying what it is
  for. It is **filterable** (type ‘privacy’, ‘yalla’, ‘api…) and it says
  *“N of 40 pages”* as you type.
- **it marks the page you are on** — the old navs mostly guessed, and one of
  them was hard-coded to *Chat* on every page but one.
- **the redirect stubs are not listed**: `watch.html` → `/live/`,
  `account.html` → `/bee`, `hivv-page.html` → `/hivv-dashboard.html`. The
  menu links to the TARGET, never to a page that immediately bounces.
- **mobile**: the primary row scrolls sideways, but the pill and the menu
  button are **pinned** — on a phone they used to scroll out of reach.

**Every page now loads it** (`<script src="/js/hivv-nav.js"></script>`) and
**every hand-written nav was deleted**, so there is exactly one inventory to
maintain and nothing can be missing from it. The homepage keeps its own header
shell (the brand logo + the live tok/s badge) and mounts the link row into it.

**Tests**: `api/tests/nav.test.js` (8) — the component holds the only
inventory; the inventory lists **every** page the site serves; every href
**resolves** (no dead links); no page carries a hand-written nav; no page
links to `/hivv.html`; the pill is never a typed count.

### The AGENT FLEET was a fiction (2026-11-26)

Migration 003 ended with `SEED DATA: Sample Agents for Testing` and left **15
rows** in `hivv_agents` — Alice, Bob, Carol, TechCorp, Code Assistant, Web
Scraper, Data Analyzer, Email Agent, Customer Support, a Trading Bot, a
Finance Agent — each with a hand-picked trust score and a creation timestamp
frozen at `2026-09-07`. A later development batch added 9 more. All of them
sat in the **production** database.

The public Control Center rendered them under **“AGENT FLEET”** beside a
**“REALTIME LIVE”** badge: ten ACTIVE AGENTS, ten trust scores nobody
everned, a SYSTEM RELATIONSHIP GRAPH of thirteen invented edges, a
pending intention to *“Execute sell order for 1000 shares”*, and an
activity feed of tool calls that never happened. The page said “real-time
telemetry” over data that had not moved in two and a half months.

**THE LAW (same as the live numbers):**

1. A seeded sample row is **SAMPLE DATA**. It is never counted as an agent,
   never counted as an authorization, never a node in the graph, never an
   event in the feed, never a pending decision.
2. It is shown **only when someone asks for it**, and it is **labelled**.
3. The flag is **permanent** — migration 033 marks the rows once.

**`api/migrations/033_hivv_demo_seed_flags.sql`** adds
`hivv_agents.is_demo` / `hivv_events.is_demo` / `hivv_intentions.is_demo`
and marks the seed rows by name **AND** creation window (so a real agent
later named “Carol” is never swept up). The gateway **ensures** the columns
on its first request (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), so a box
where the migration never ran still works.

**The API** (`api/lib/routes/dashboard-routes.js`): every agent/event/
intention/relationship query takes `demo=exclude` (the default) |
`demo=only` | `demo=all`. `/api/dashboard/agents` also returns **`demo_total`**
— how many samples it is hiding — so the page can say so out loud.
`/api/hivv/agents` no longer sweeps the ownerless sample rows into every
signed-in user's list. A sample row cannot be paused into looking real
(`409 SAMPLE_ROW`).

**The page** (`public_html/hivv-dashboard.html`): the fleet asks for
`demo=exclude`, a **“Show sample data (10)”** toggle reveals the fixtures on
request, every sample card carries a **SAMPLE** badge and is dimmed, and the
counters (`ACTIVE AGENTS`, `YES AUTHORIZED`, the tri-state badges) **never
count a sample** — not even while the samples are on screen.

**Bonus bug found on the way:** the whole dashboard script is one IIFE, so
inline `onclick="fn()"` handlers could only see functions that were
explicitly put on `window`. The **“Refresh Graph”** button was dead that way
(it called `loadNetworkGraph`, which was never exported). Fixed.

**Tests**: `api/tests/agent-fleet-truth.test.js` (9) — the migration, the
ensure, the default fleet, the labelled samples, the graph, the feed, the
intentions, the mutation guard, and the page.

### Deterministic fast scan (`lib/fast-scan.js`)

Free, reproducible, **no AI**. Reports size, entropy, imports, command/API
counts, most-used command, riskiest operations, file paths + modes, network
targets, hard-danger findings, and embedded secrets (fingerprints only, never
the value).

**It can only make a verdict WORSE — never better.** `safe` means "no
hard-danger signal found", not "this code is safe". The signed review is the
thing that carries an approval.

Also exposed at `POST /api/scan/fast` and `POST /api/scan/fast/summary`.

### Request provenance (`lib/request-provenance.js`)

Every request is recorded with who asked, which model/node answered, exactly
when, how long, what it cost, and where the worker was. Raw prompts and raw
model output are NEVER stored — only SHA-256 digests and byte/token counts.

- `hivv_request_provenance` — the per-request ledger
- `hivv_node_provenance_stats` — per-node rollup
- `hivv_provenance_daily` — daily rollup
- Operator API: `/api/provenance/*` (control-token/admin gated)
- **Never** added to the public database-browser whitelist.

### Signed review provenance (`lib/review-provenance.js`, `lib/review-registry.js`)

The signed envelope carries reviewer identity, model, worker, exact timestamps
(seconds + ms), review duration, cost, resources, and complexity. The
**private** half (email, phone, exact IPs, precise coordinates, traceroute,
internal margins) lives in `hivv_review_registry` and is never published.

### Attestation contract (HIVV ↔ BLNQ)

The wire contract is versioned and duplicated on purpose — neither site may
depend on the other's files. Canonical values live in
`api/lib/attestation-contract.json` + `.js` on BOTH sides.

| Field | Value |
|---|---|
| Contract | `blnq.attestation.v2` |
| Envelope version | `2` |
| Principal prefix | `hivv_` (+ 32 hex key fingerprint) |
| Legacy prefix | `pri_` — read/verify only, never issued anew |
| Signature | Ed25519, base64 |
| Canonical JSON | UTF-8 byte key order, no whitespace, **safe integers only** |

> ⚠ Floats inside a signed body break canonicalization and silently kill every
> signature. Round all measured values to integers before they enter an envelope.

Changing the contract requires updating **both** sites and running the
cross-site parity suite. See BLNQ's `docs/ATTESTATION-CONTRACT.md`.

### VRAM Protection (`omni-engine.js`)
- Caps thinking tokens to 50 before answering
- Context window limit: 16k tokens
- Request timeout: 60s
- Auto-retry on GPU crash

### OpenCode integration (plan: `HIVV_OPENCODE_PLAN.md`, routing brain: `HIVV_ROUTING_PLAN.md`)
Four layers, all shipped 2026-11-14 and verified end-to-end (OpenCode tool-loop runs through
the hub in both plain and hivv-framed modes, local + via `https://hivv.org/v1`):
- **A · provider** — OpenCode (or any OpenAI client) points at `https://hivv.org/v1`; model
  aliases `auto/smart/fast/cheap/private` double as route modes (`smart`→`route.mode=quality`).
  Canonical snippet: `public_html/opencode-hivv.jsonc`. Gateway conformance: `tools`/`tool_choice`
  passthrough on ALL paths (stream + non-stream + cloud + relay), `Authorization: Bearer` →
  `users.api_key` principal (absent = anonymous), tool-capable candidate filter
  (`router.js TOOL_CAPABLE_RE`, falls back to unfiltered when empty).
- **B · MCP** — `https://hivv.org/mcp` (Caddy → `app.use('/mcp')`, `api/routes/mcp-routes.js`,
  stateless SDK transport). Tools: `chat, route, nodes, search, news, honey`. Optional Bearer;
  same policy gate as `/api/chat`. This repo's `opencode.jsonc` connects it (`oauth:false`).
- **C · skills** — `https://hivv.org/.well-known/skills/hivv/SKILL.md` (public) + repo-local
  `.opencode/skills/hivv/SKILL.md` (auto-discovered here). Both embed the provider snippet
  byte-identical to `opencode-hivv.jsonc`.
- **D · coder bees** — `hivv code "task" --repo <git-url> [--wait]` → `POST /api/coding/jobs`
  (`api/routes/coding-routes.js`, policy-gated `coding`) → `coding_job` into the inbox of a node
  advertising `opencode` in tools → node clones to a temp worktree, runs `opencode run
  --standalone --format json --auto`, posts patch + summary back. Agent announces `opencode`
  automatically when the binary is findable (`_find_opencode`, PATH-independent).
- **E · dial shim — direct-to-bee data plane** — `hivv dial [run|on|off|status] [--port 3911]
  [--pin NODE|URL]` (`api/routes/dial-routes.js`: `POST /api/route/dial` + `/api/route/report`).
  OpenCode's `baseURL` → `http://127.0.0.1:3911/v1`; the shim dials once, then forwards every
  request **straight to the bee** (hivv only on rare dials + async reports = selection, speed/quality
  telemetry, distribution, failover). Cache is stale-while-revalidate: the connection STICKS
  to its specific bee; re-dials happen in the background (proven: 0.16s serve + same-second
  hub dial). `--pin` locks one bee (no rotation, no hub fallback). Dial candidates end with a
  `transport: hub` fallback so NAT/dead bees degrade to the normal hub path, never dead.
  **P2P by default (2026-11-24)**: `hivv setup` / `hivv opencode --wire` now WRITE the shim
  URL — starting the shim first (systemd user unit `hivv-dial.service` with the agent's
  crash-loop bounds · LaunchAgent on macOS · detached spawn as last resort) and falling back
  to `https://hivv.org/v1` **with the reason recorded** whenever it cannot run (a config is
  never written against a dead localhost URL; a foreign app on the port is detected).
  Re-setup MIGRATES any HIVV-owned baseURL (hub ↔ shim, both directions, backup first,
  `migrated_base_url` in JSON); a user's own proxy URL is never touched. Lifecycle:
  `hivv dial on|off|status` — `off` leaves `STATE_DIR/dial.off` which setup respects;
  opt-outs `--no-shim` / `HIVV_DIAL_OFF=1`. `_fwd_payload` rewrites `model` to the real
  model name for DIRECT candidates (ollama 404s on `auto`, llama.cpp ignores the field) and
  keeps the alias for hub candidates — the hub routes on it.

**SSE law (learned the hard way, 2026-11-14):** every frame MUST be separated by a blank line
(`\n\n`) — spec-compliant decoders (OpenCode, OpenAI SDKs) treat a single-`\n` stream as ONE
giant event. Never re-emit partial TCP-read lines without buffering (corrupts `finish_reason`),
always terminate streams with `data: [DONE]`, and keep custom frames choice-less
(`{"hivv_provider":…}`, top-level `{"hivv_stats":…}` — `finish_reason:"stats"` is not a legal
enum). `X-Hivv-Plain: 1` on a request suppresses hivv's custom frames entirely.
**opencode-run law:** spawned `opencode run` must get `PWD=<worktree>` in its env — opencode
resolves the project root from inherited `$PWD`, not the real cwd (else files land in whatever
directory started the agent).

### Deeper telemetry, the task foundation, and MCP/A2A interoperability

Plan: [`HIVV_TELEMETRY_TASKS_PLAN.md`](HIVV_TELEMETRY_TASKS_PLAN.md) — shipped 2026-11-25.

**`api/lib/telemetry.js` — the telemetry core.** Four primitives, always available
(local-first: NO database is a valid configuration):
- **counter** (monotonic), **histogram** (distribution), **gauge** (last value), **span** (one unit of work).
- A **span carries a trace**: `trace_id` is minted at the edge or INHERITED from a W3C
  `traceparent` header, so a request that crossed a relay AND a peer hive reads as ONE story.
  `parseTraceparent` refuses malformed input rather than guessing.
- **The label allow-list IS the privacy boundary.** `LABEL_ALLOW` is an explicit set; anything
  outside it is DROPPED and counted. A caller cannot accidentally record a prompt as a label —
  the boundary is code, not a convention.
- **Percentiles are EXACT while the reservoir holds every sample** (a bounded reservoir of raw
  observations), bucket-interpolated after that, and the result says `exact: true|false`.
  Buckets alone would report a p50 of 78 for a series of 100 ms requests.
- **Error taxonomy** (closed vocabulary, ordered rules): `timeout · rate_limited · policy_denied ·
  policy_pending · sandbox_denied · not_found · unavailable · upstream_5xx · upstream_4xx ·
  connection · dns · tls · decode · empty_completion · cancelled · validation · auth · unknown`.
- **SLOs + burn rate**: `burn_rate = (1 − actual) / (1 − target)`. A metric with no samples reports
  `null`, NEVER `0` — "no data" and "measured zero" are different truths.

**`api/routes/telemetry-routes.js`** — `GET /api/telemetry/{overview,counters,gauges,histograms,
series,errors,slo,spans,traces,traces/:id,nodes,metrics}` + `POST /api/telemetry/observe` (a bee
pushes its OWN measurements). `/metrics` is **Prometheus text exposition**. The audience model
mirrors `provenance-routes.js`: `view=public|partner|operator`, **default `operator`** (control
token or admin session) — a guessed URL never hands out the detail.

**`api/lib/task-queue.js` — THE task foundation.** One implementation of the nine things four
job systems had each solved separately: pollable state machine · idempotency on an external id ·
priority + `not_before` · TTL · **leases** (a lock would strand work when a bee dies behind NAT) ·
retries with a cap · budget · cancellation · receipt.
States: `queued → running → done | failed | expired | rejected | canceled`.
**`failed` can be retried; `rejected` cannot** (a peer at 0% allowance REJECTS work, it does not
fail it). **Interruption is NOT failure**: `interrupt(id,{kind:'auth'})` keeps the task ALIVE while
a human decides — A2A renders it `TASK_STATE_AUTH_REQUIRED`, never `FAILED`. In-memory by default;
Postgres mirror = `hivv_task_queue` (migration 029 — deliberately NOT `hivv_tasks`, which the dashboard schema already owned).

**`api/lib/hive-clients.js` — the adapter layer.** One interface (`probe`/`submit`/`status`/`cancel`)
over five adapters: `blnq` (blnq.org's worker pool, **worker-HMAC signed**), `mcp`, `a2a`, `bridge`
(open-hives/0.1), `local`. Every adapter maps the remote's vocabulary onto OUR task states
explicitly — never by guessing.
> **blnq contract:** `message = ts\nnonce\nMETHOD\npath\nsha256(rawBody)`,
> `signature = HMAC-SHA256(auth_token, message)`, headers `Authorization: Bearer` +
> `X-Auth-Timestamp` / `X-Auth-Nonce` / `X-Auth-Signature`, ±300 s window. `path` INCLUDES the query
> string. Pinned by a fixed expected signature in `api/tests/interop.test.js`; a second test reads
> blnq's own `workerAuth.js` when it is on this box. **The contract changes on BOTH sides, never one.**

**`api/lib/mcp-client.js` — the OUTBOUND MCP client.** HIVV was an MCP *server*; now it can also
*call* one. Streamable HTTP, stateless: `initialize → notifications/initialized → tools/list |
tools/call`. The SERVER's protocol version wins. SSE-framed answers are tolerated. SSRF-guarded,
deadline-bounded, size-capped.

**`api/lib/a2a-client.js` — the OUTBOUND A2A client.** Both bindings: JSON-RPC 2.0 (canonical, tried
first) and REST (`POST /message:send`, `GET /tasks/{id}`, `POST /tasks/{id}:cancel`). Agent card from
`/.well-known/agent-card.json` (v1.0), v0.2 path still accepted.

**`api/routes/a2a-routes.js` — HIVV as an A2A SERVER (v1.0).** `POST /api/a2a` (JSON-RPC:
`SendMessage · GetTask · ListTasks · CancelTask · GetAgentCard`) + the REST binding
(`/api/a2a/message:send`, `/api/a2a/tasks/:id`, …) + the agent card at
`/.well-known/agent-card.json` (STATIC on disk so Caddy serves it with no gateway involvement;
**generated** from the route by `scripts/gen-agent-card.js` so the two cannot drift; LIVE at
`/api/a2a/agent-card`). **The policy gate is NOT bypassed**: denied → `TASK_STATE_REJECTED`,
MAYBE → `TASK_STATE_AUTH_REQUIRED` with the exact `hivv approve <grant>` command.

**The hive-to-hive door now exists.** `POST /api/bridge/requests` (open-hives/0.1 §3) and the
receipt endpoints (§6) are LIVE — the manifest advertised them since day one while the routes did
not exist (a door painted on a wall). The **loop shield** (§4) is the strict part: our name in
`X-Hive-Path` or `X-Hive-Origin` → 409 `loop_detected`; `X-Hive-Hops > 3` → 409; a seen
`X-Hive-Request-Id` returns the SAME state and never executes twice. At 0% allowance the queue
**HOLDS** the work (`held: true`), it does not fail it. One reader loop rides the heartbeat timer.

### Repository topology — ONE code repo (2026-11-25)

Ledger of every structural change: [`MOVES.md`](MOVES.md) — **a move without a
MOVES.md entry in the same commit is incomplete.**

| repo | role | push? |
|---|---|---|
| `htmlfarmer/hivv` | **CANONICAL** — `origin` on every machine; all code | **yes — all development** |
| `htmlfarmer/hivv.org` | generated WEBSITE projection (`public_html/` → repo root) | never — `scripts/sync-mirrors.sh` |
| `htmlfarmer/hivvz` | ARCHIVED — folded back into `hivv` (MOVES.md, same day) | no — read-only |

**Rules:**
1. Clone/branch/push against **hivv**. On any new machine:
   `git clone git@github.com:htmlfarmer/hivv.git`. On an old clone (hivvz
   origin): `git remote set-url origin git@github.com:htmlfarmer/hivv.git && git fetch --prune`
   (archived hivvz still fetches; pushes are refused — loud, not silent).
2. **Branch per task** (`<topic>` or `ai-<topic>`) → push → merge to `main`
   after `python3 -m pytest tests/ -q` is green. Never commit straight to
   `main` from a session; never share one working tree between sessions —
   use `git worktree add ../hivv-<topic> -b <topic>` (or a separate clone).
3. **`/var/www/vhosts/hivv.org` on ashy is production.** It stays clean on
   `main`; the only way it changes is `scripts/deploy.sh` (rails: origin must
   be hivv · must be on main · tree must be clean · nothing unpushed →
   `merge --ff-only` → new migrations → pm2 restart → health poll → pytest
   gate → automatic rollback on a red gate or dead health). Preview with
   `scripts/deploy.sh --dry-run`.
4. **Never push to `hivv.org`** — it is generated.
   `scripts/sync-mirrors.sh` regenerates it from committed refs (isolated
   `GIT_INDEX_FILE` — safe to run while others work; `--dry-run` supported).
5. Moving/renaming anything? Same commit adds the `MOVES.md` entry (what,
   from → to, why, what still points at the old path). Leave a stub at the old
   path until everyone has pulled.

## Running / Restarting

```bash
# Check status
pm2 list
curl -s http://localhost:3011/api/health

# Restart gateway
pm2 restart hivv-ai-gateway

# View logs
pm2 logs hivv-ai-gateway --lines 50

# Full restart (with env reload)
cd /var/www/vhosts/hivv.org/api
pm2 delete hivv-ai-gateway && pm2 start ecosystem.config.js --env production
```

**Supervision rule (all vhosts, not just hivv):** every site app runs under pm2
(`<site>/ecosystem.config.js` → `pm2 save`) or a running+enabled systemd unit — never
ad-hoc/nohup, never `&`-wrapper scripts. Local LLM (gemma) = user-scope `llama.service`
on 127.0.0.1:8080; never duplicate it system-scope (port war → crash loop).
See README "Operations notes" for details.

## Database

```bash
# Connect
psql -h localhost -U hivv -d hivv

# Key tables:
#   users          — user accounts
#   ai_providers   — provider configs (openai, anthropic, etc.)
#   ai_keys        — API keys (encrypted)
#   usage_logs     — request logging
#   anonymous_sessions — guest sessions
#   gateway_config — runtime config
```

## Common Tasks

### Add a new cloud provider
1. Insert into `ai_providers` table
2. Add API key via `POST /api/keys/donate` or directly
3. Router auto-discovers it on next `loadProviders()`

### Run the regression tests (upgrade gate, scanner, displays)
```bash
python3 -m pytest tests/ -q        # no network, no $HOME writes
cd api && node --test              # live-gateway suite (gateway must run)
python3 tests/local_install/test_local_install.py   # clone-and-run (no DB, no net)
```

### Which tests do I run for THIS edit? (`hivv tests-for`)
Before running everything (~90s), ask the map:

```bash
hivv tests-for public_html/hivv-cli.py     # → the 15 test files that exercise it
hivv tests-for scripts/lib/deps.sh         # → 4 test files + the exact pytest line
hivv tests-for --diff                      # everything YOU changed vs HEAD
hivv tests-for --diff origin/main          # everything changed vs GitHub
hivv tests-for --refresh <file>            # rebuild the map first
```

The map is `tests/TESTMAP.json` (+ `TESTMAP.md` for humans), built by
STATIC analysis in `tests/gen_testmap.py` — no test is run to produce it.
**Freshness is enforced**: `tests/test_testmap.py` regenerates and compares
byte-for-byte, so a new test file or reference turns the suite red with
"run `python3 tests/gen_testmap.py`" — the map rots loudly or not at all.

Honest limits, both by design:
- the map UNDER-claims (a test reaching a file through a runtime-computed
  path is invisible to static analysis) → an unmapped file always falls
  back to "run the full suite", never a false "you're covered";
- tests that reference a DIRECTORY (`REPO / "public_html"`) cover the
  files inside it — reported as `tests/x.py (via public_html/)`.
`tests/test_upgrade_review.py` pins the 2026-11-14 failure modes (the new file's
own docstrings/print-hints re-tripping the critical-pattern scan, `line_no`
off-by-one, bytes-literal blanking) AND the true positives that must stay
critical. Its shipped-file canaries fail if anyone re-introduces a literal
download-into-shell example in prose — the wording rule is in
`_refine_finding_severity`'s docstring. Keep the test regex in sync with
`_UPGRADE_RISK_PATTERNS` when patterns change. Also pins: confirmation-round
wiring (tie-breaker both ways, critical-skips-confirm), `_short_cpu`/`_short_gpu`,
state durability (cmd_agent merge — the node_secret wipe canary, atomic
`write_state`), reaper keeper priority (systemd MainPID first), stale-launcher
self-heal fail-safety, repair HMAC canonical parity (sort_keys vs insertion
order — cross-language contract with the hub signer), and chat flag recovery
from `nargs=REMAINDER`.

`tests/local_install/test_local_install.py` is the LOCAL-FIRST gate: it starts a
real gateway with **no database and no network** and proves the partner surface,
the OpenAI-compatible surface, the fast-scan, and attestation verification all
work. It runs identically on Linux, macOS, and Windows (CI matrix:
`.github/workflows/local-install.yml`).
`api/tests/node-auth.test.js` (live gateway) pins: node detail credential strip
(public endpoint leaked `secret`/`hw_id`/`token`), inbox x-node-secret 403/200
matrix, hw_id-proven secret re-issue (state-wipe recovery), repair plan signed
over SORTED-compact ops, upgrade-reports row record/dedup + incident-on-block
for known bees (ghosts record without incident) — it self-cleans (inbox ack,
node delete, incident resolve).

### Emergency network-wide CLI update (no per-box login)
```bash
scripts/emergency-update.py "reason"          # every online bee
scripts/emergency-update.py --node yalla      # just one
scripts/emergency-update.py --dry-run
```
Pushes a hub-SIGNED `cli_update --force` repair plan into each online bee's
inbox (HMAC + ttl + one-shot id + op allowlist). sha256 + healthcheck still
enforce on the bee — only the LLM review gate is bypassed, and the forced
apply stays visible in `hivv_upgrade_reviews`. Single bee (from the hub host,
or with `HIVV_CONTROL_TOKEN` exported — bees get `control auth required`):
`hivv repair <bee> --op cli_update --force`.

### Add new local LLM port
- Set `HIVV_LOCAL_ENDPOINTS` env var in `ecosystem.config.js`
- Or add to `discoveryEndpoints` array in `router.js`

### Fix "hivv" wrapper serving HTML
- Check if `hivv.html` exists in `public_html/` — rename it to `hivv-page.html`
- Caddy's `try_files {path}.html {path}` shadows the wrapper
- The wrapper self-heals: detects HTML and re-downloads

### Debug node registration
```bash
# Check if nodes are registered
curl -s http://localhost:3011/api/control/nodes | python3 -m json.tool

# Check gateway logs for discovery
pm2 logs hivv-ai-gateway --lines 20 | grep -i "discover\|register"
```

## Security Rules

- Never commit API keys, passwords, or tokens
- API keys in database are encrypted with AES-256-GCM
- LLM ports should be LAN-only or Tailscale VPN (use `hivv firewall`)
- CSRF protection on all state-changing endpoints
- Rate limiting: 60 req/min per IP

## CLI Commands (hivv-cli.py)

### Node Management
- `hivv start` — start the node agent (registers with hub, heartbeats every 60s)
- `hivv stop` — stop the local agent
- `hivv restart` — stop + start
- `hivv status` — PID, uptime, last heartbeat, hub connection
- `hivv info` — hub URL, version, install paths
- `hivv free` — host memory + swap + disk + per-process RSS
- `hivv pct [--watch=N]` — live CPU%/MEM% (refreshes every N seconds)
- `hivv update` / `hivv upgrade` — pull latest CLI from hub, **LLM-reviewed before applying** (static scan + local/hive LLM vote; suspicious → blocked + hub incident). Flags: `--show-review` (last verdict + findings), `--skip-review`, `--force` (override block)
- `hivv uninstall` — clean uninstall (keeps logs)

### Network & Cluster
- `hivv nodes` — table view of all registered nodes (VERSION column flags bees behind the hub CLI; ends with a models-by-bee section)
- `hivv models [--bees]` — model catalog (FC/CTX/speed) + which bee runs which local model; `--bees` = only the by-bee view
- `hivv node <name>` — details about a specific node
- `hivv ask <name> <msg>` — chat with ONE bee (direct → hub relay fallback); aliases `talk`, `node-chat`
- `hivv chat <msg>` — ask the HIVE (any bee answers)
- `hivv reach <name>` — test connectivity to another node
- `hivv stats` — per-node stats + cluster totals
- `hivv top` — real-time cluster activity
- `hivv benchmark` — test all nodes, find fastest
- `hivv debug` — full debug info: hub, agent, local AI, network nodes

### Security
- `hivv firewall` — check firewall + binding + tailscale status
- `hivv firewall --apply --mode lan` — allow LAN only
- `hivv firewall --apply --mode tailscale` — allow VPN only
- `hivv doctor --fix` — auto-fix LLM bindings + create system services

### Incidents & Monitoring
- `hivv incidents` — list active incidents (default: active, also: --state=resolved)
- `hivv incidents list [--json] [--state=active|resolved|investigating]` — list incidents
- `hivv incidents summary` — full health dashboard: incident count, breakdown by type/severity, per-node heartbeat age
- `hivv incidents resolve <id> [--notes TEXT]` — resolve/dismiss an incident
- `hivv incidents create --node-id NODE --title TEXT [--type TYPE] [--severity LEVEL]` — create incident (for testing)
- `hivv health` — GET /api/health
- `hivv metrics` — GET /api/control/metrics/global
- `hivv up` — quick 3-line status check
- `hivv upgrades [--flagged] [--node N]` — recent upgrade review outcomes across the hive (applied/blocked/failed + brain votes)

### Chat & AI
- `hivv chat "msg"` — single message chat (auto-routes to best node); `--mode=cheap|fast|private|smart` picks the strategy
- `hivv cap [list|can X|node N]` — capability layer (what the hive can do; your rights)
- `hivv policy [show|explain X|history|verify|grants]` — YES/MAYBE/NO defaults + audit chain
- `hivv approve [--list|--all|G_xxx]` / `hivv deny G_xxx` — answer a MAYBE (standing grants by default)
- `hivv route [q] --mode=X [--json]` — dry-run routing planner (who answers & why, never executes)
- `hivv exec '<code>' [--lang python|bash|node] [--file F] [--timeout ms]` — run code in the isolated hub sandbox (MAYBE→admin-approve→docker/bwrap jail: no net, quotas, ephemeral)
- `hivv tools [list|status|on|off|share]` — the whole toolkit catalog (what the hive can do, what it costs, who shares what) + the local tool server
- `hivv call <tool> [--json '{...}'] [--local|--via=node]` — invoke ANY tool in the catalog (web_search, current_time, calculator, web_fetch, http_request, code_interpreter, file_read, file_search, memory, text_parser, timezone_convert, translate). Old names still work
- `hivv watch [status|on|off|run|reset]` — the watchdog: restart a stuck local service (tools · llama · agent) without ever looping. 2 failed probes → restart, growing backoff (120s→900s), 4 restarts → QUARANTINE (a human looks, `hivv watch reset`). The agent ticks it every heartbeat; `hivv watch on` adds a dedicated unit at 30s
- `hivv fallback [--json]` — the escape hatch: where to get the CLI if hivv.org is down (install · rescue · update · help, all from the GitHub repo). Prints with NO network. The automatic update path never contacts GitHub — the flood law
- `hivv ask <name> "msg"` — chat with ONE bee (pins it; direct → hub relay). Aliases: `talk`, `node-chat`
- `hivv completions "msg"` — OpenAI-compatible completions endpoint
- `hivv add <provider> <key>` — add any AI to the network
- `hivv volunteer [on|off|status]` — opt in/out of contributing compute
- `hivv setup [--write [PATH]] [--global] [--json]` — detect local LLM + opencode/VS Code, print (or merge-write with backup) the OpenCode provider config, VS Code extension steps, and hive verify commands
- `hivv code "<task>" --repo <git-url> [--ref BR] [--timeout S] [--wait] [--json]` — dispatch a coding job to a coder bee (node runs OpenCode headless in a temp worktree, returns patch + summary)
- `hivv propose [--staged|--file F|--patch FILE|--stdin] [--votes N] [--no-review] [--dry-run] [--patch-out FILE] [--push] [--no-tests]` — raise a change to the SOURCE with the evidence: scan (deterministic) → review (the hive) → authorize (policy) → test (the BASELINE suite). Blocked by default; nothing is pushed without authorization. The default path needs NO credential — the patch is handed back
- `hivv contribute [--install] [--clone DIR] [--json]` — the on-ramp for someone who already installed: reports git / gh / clone / gh auth, installs what is missing when asked, and prints the loop. Nothing here needs a credential

### One-Shot Hub Queries
- `hivv health` — GET /api/health
- `hivv metrics` — GET /api/control/metrics/global
- `hivv whoami` — GET /api/control/health (cheap liveness check)

### Local LLM Helper
- `hivv llm` — show subcommands
- `hivv llm setup [--model K] [--port N] [--yes] [--fg]` — **ONE-SHOT**: build llama.cpp (if missing) → download GGUF (if missing) → serve in background → **ask "start on boot?"** → print the next commands (alias: `hivv install llm`)
- `hivv llm boot [on|off|status]` — auto-start the LLM at login (systemd user unit `llama.service`; `off` never stops the running server)
- `hivv llm detect` — find ollama, llama.cpp, lm-studio, vllm on this box
- `hivv llm suggest` — recommend a model for this hardware (CPU/RAM/GPU)
- `hivv llm bench` — quick CPU/RAM/disk benchmark
- `hivv llm status` — detect + bench + suggest in one shot
- `hivv llm install [--docker]` — print install commands for detected OS
- `hivv llm pull <model>` — ollama pull <model>
- `hivv llm serve [model] [--port]` — serve a model in the foreground

### Fun / Social
- `hivv iq [--show|--board|--no-judge]` — intelligence + personality index for this brain: calibrated exam battery (deterministic math/logic + philosophy judged by OTHER bees), personality probes recorded locally, IQ-style index (v1 mapping, recalibrates against the hive), history tracked in state → heartbeat `exam_summary` → **public brain board at `GET /api/hive/iq`** (IQ · score · AI avg · human votes)
- `hivv rate <bee> <1-10> [--note]` — HUMAN ranking on the brain board (governance charter: human votes weigh more; last 20 ratings/bee, `POST /api/hive/iq/rate`)
- `hivv welcome` — guided first-run tour
- `hivv hi` — friendly greeter with quick chat round-trip + examples
- `hivv thanks` — say thanks to the AI (one-line chat reply)
- `hivv support` — get help — auto-attaches doctor + last 10 log lines
- `hivv share` — share your contribution stats
- `hivv feed` / `hivv whatsup` — see what's happening on the network
- `hivv panic` / `hivv help-bang` — emergency help — diagnostics + how to report
- `hivv speed` — latency benchmark (DNS, TLS, hub ping x3, chat TTFB, CPU/RAM/disk)
- `hivv speeds [--days N] [--limit N] [--json]` — request speed log from the provenance ledger: full-reply duration (avg/p50/p95), time-to-first-token, tok/s — per user & per answering bee (operator: localhost or `HIVV_CONTROL_TOKEN`, which `http()` now auto-attaches)
- `hivv test` — doctor + speed + full network test end-to-end smoke test

### Smart Default
Anything not a recognized subcommand becomes a chat message:
```bash
hivv whats the meaning of life    # sends to the LLM
hivv explain kubernetes           # also sends to the LLM
```

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | 3011 | Gateway listen port |
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_NAME` | hivv | Database name |
| `HIVV_DB_PASSWORD` | — | Database password |
| `HIVV_SESSION_SECRET` | — | Cookie signing (64-char hex) |
| `HIVV_ENCRYPTION_KEY` | — | Key encryption (64-char hex) |
| `HIVV_CONTROL_TOKEN` | — | Admin access token for /api/control/* |
| `HIVV_LOCAL_ENDPOINTS` | — | Comma-separated LLM URLs for remote nodes |
| `HIVV_HUB` | https://hivv.org | Hub URL (used by CLI agent) |

## Known Issues / Tech Debt

1. ~~**Token estimation** — `usage-tracker.js` uses `chars * 0.25` which undercounts by 4x~~ ✅ Fixed 2026-09-28 (D1: real provider usage + SSE chunk counting + BPE heuristic; `/api/chat` now logs)
2. **No clustering** — single Node.js process, no multi-core
3. **In-memory sessions** — lost on restart (D2)
4. **<5% test coverage** — no integration tests for API endpoints
5. ~~**Caddy streaming** — compression middleware may interfere with SSE through Caddy~~ ✅ Verified 2026-09-25: 54 SSE frames live; `flush_interval -1` on all proxy routes; compression skips SSE

## What's Next

- [x] The submission surface — an AI can file a bug from OpenCode, and find how — 2026-11-27: the ask was "can we do some testing that we can submit a request with 'hivv proposal' or 'hivv bugs' or various other ways? and that all works from within opencode? and is easy for AI's to find and easy for hivv.org to help with and quickly reply to? and even solve?" — FIVE properties, and only the first two held. **(1) SUBMIT, several ways ✓** — `submit` · `request` · `flag` · `propose`/`proposal` · `help submit` all dispatch correctly (pinned: each resolves to a REAL function, not a `_cmd_stub`, because a command the dispatch does not recognise falls through to the smart-default CHAT — the model replies helpfully and files NOTHING, the worst failure because it looks like success). **(2) WORKS FROM OPENCODE ✗ → built** — the MCP surface offered `chat route nodes search news honey` + the toolkit: an AI connected to `/mcp` could do everything EXCEPT report a problem. **NEW `feedback` tool** (`api/routes/mcp-routes.js`) — `action=submit` files it, `action=list` reads it back, same `hivv_feedback` table and same visitor identity as the CLI, so a report filed from OpenCode and one filed from a terminal are the same report; the MCP type enum is pinned against the database's CHECK constraint so they cannot drift (a type the DB rejects would fail at INSERT, i.e. AFTER the AI told the user it was filed). **(3) EASY FOR AIS TO FIND ✗ → fixed** — NEITHER `SKILL.md` ever mentioned filing anything; an AI reads the skill, and silence means the command does not exist for it. Both now carry the doors, the MCP tool and the offline fallback. **THE BUG THE TESTS CAUGHT**: `cmd_help`'s docstring claimed bare `hivv help` lists your submissions — `main()` intercepts bare help and prints the ROOT help, so every document built from that docstring pointed at a command printing the wrong thing. The list door is `hivv help list`, which nobody guesses → **`hivv feedback`** alias, matching the MCP tool name, so a human and an AI reach for the same word. **(4) REPLY — BUILT**: both halves now. READ — `GET /api/feedback` SELECTs `review_notes` + `updated_at` (it never did, so a submitter could watch the status move and never read a word back) and BOTH CLI listings print `↳ reply:`. WRITE — `PATCH /api/feedback/:id` sets the status and/or a note, admin-gated by the control-route rule (admin session · control token · loopback), validating against the schema's OWN lifecycle so a bogus status is refused at the door instead of exploding at INSERT. Plus `GET /api/feedback/:id` (one report for its owner, not a 50-row list) and `DELETE /api/feedback/:id` (admin only — a submitter quietly erasing their own history would make the ledger untrustworthy). **(5) SOLVE — BUILT**: the status lifecycle (`open → reviewed → in_progress → resolved → dismissed`) is now driven by R1's PATCH, and the submitter sees it move. **Tests**: `tests/test_submission.py` (43 — the dispatch matrix · the MCP schema vs the DB constraint · discoverability in both skills · the docstring bug · the read path · the write path · **the full round trip** (file → read → answer → read → clean up, self-cleaning so the ledger stays clean) · **the visibility rule through the PUBLIC door** (a stranger gets 404, cannot answer, cannot delete — and cannot become an operator by spoofing `X-Forwarded-For: 127.0.0.1`, which matters because the app sets `trust proxy`) · and a LIVE check that a running gateway advertises the tool to OpenCode). The old xfail that documented the missing reply is **deleted** — R1 landed, so the assertion is real now. Live proof: submit through MCP → `id 2, status open` → `action=list` reads it back; then file → answer → read back with the reply attached.
- [x] The suggestions redo — ONE engine, three channels, and the stats pivot — 2026-11-26: the ask was "humans REALLY love suggestions... how do we think more carefully about providing random suggestions AND suggestions that are very much related to what they are doing... we can use LOCAL node tools or even design tools whatever we need? and also stats.. for example someone is typing something but maybe then wanted to also see stats for something else.. however we dont want to break tools where AI requires consistent reply". **THE SURVEY FIRST**: two chat UIs, each with FOUR hard-coded chips (`/chat/` and `/chat.html` — the same four prompts, twice) — never related to what the visitor was doing, never related to the hive, and no stats anywhere. The homepage had the CSS for a starters row and **no row at all** (the markup was gone; `applyStarter` pointed at a dead array). **THE ARCHITECTURE, REDONE**: **`api/lib/suggestions.js` — ONE engine, three channels.** *(1) CONTEXT* — the subject is extracted from the visitor's DRAFT plus the last turns (people type "gemma", not "unsloth/gemma-4-E2B-it-GGUF": the engine matches the model FAMILY and the exact stem against the REAL names on the roster), and the pivots are built from that subject and the live hive. **THE STATS PIVOT lives here**: typing about a model is handed "show me the stats for gemma-4-E2B" — the question they were about to ask anyway — plus "how fast is it right now?", "compare it with the other model", "which bee is running it?", "how busy is that bee?". *(2) RANDOM* — the serendipity channel: a curated pool that is about THIS hive (25 prompts: the routing, the gate, the receipts, the bridge, the honey, the tools — not generic filler), rotated by a seed so two visitors do not see the same four and the ↻ button gives NEW ones, with one prompt derived from the LIVE state in every batch (the busiest bee, the fastest model, today's real request count). *(3) MODEL* — the hive suggests for itself: a local bee writes two suggestions in strict JSON, pinned to the FASTEST measured model (a suggestion is a small forgiving task and the visitor is waiting), under a hard deadline, with the other channels as the fallback. **THE TWO LAWS**: *every suggestion names something REAL* (the models it mentions are the models this hive serves, the bees are on the roster, the numbers were measured — never an invented model) and *every suggestion is a question the visitor could ask right now*. **THE TOOL CONTRACT (the hard constraint)**: the engine lives in its own module and its own door (`GET /api/suggestions`), it NEVER emits an SSE frame, NEVER returns tool_calls, NEVER mutates a conversation (the client sends a READ-ONLY view of the thread; the hub stores nothing), and the client renders chips that **FILL the input — they never post a message**, so the assistant's turn is never interrupted. **`public_html/js/hivv-suggest.js` — ONE component, every surface** (`/chat/`, `/chat.html`, the Command Center's chat view): a fallback pool renders FIRST (something is always there, even offline), the live chips replace it, the row re-asks when the draft changes (debounced 900ms — that is the "someone is typing but wants stats" moment), the bees' own suggestions arrive in the BACKGROUND (never blocking), and a failed fetch keeps the fallback chips with a quiet console (the site's law). The tooltip carries the WHY ("measured: 21 tok/s"). Tests: `api/tests/suggestions.test.js` (23: the family match · the bee match · one model under two names is ONE model · a pivot never compares a model with itself · **the stats pivot** · a pivot never names a model the hive does not serve · the pool is about this hive · the random channel rotates and never flickers · no duplicate in one answer · **the chat path never imports the engine** · the engine never touches the tool loop · **LIVE: a chat answer carries no suggestion frame** · the door's answer carries no tool_calls · the door's shape · the draft is honoured · a broken conversation does not break the door · the client fills the input and never posts · the offline fallback · every chat surface loads the component · no surface keeps a hard-coded list).

- [x] The site must work WITH the adblocker on — a blocked request may DEGRADE the page, never BREAK it — 2026-11-26: the report was the homepage console: `static.cloudflareinsights.com/beacon.min.js → ERR_BLOCKED_BY_CLIENT`, then `dashboard-stats:1 → 502`, `activity:1 → 502`, `status:1 → 502`, and `Status refresh error: SyntaxError: Failed to execute 'json' on 'Response': Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. **THREE things were tangled together, and only ONE of them was our fault.** **(1) THE BEACON IS NOT OURS** — Cloudflare injects its Web-Analytics beacon into the HTML it serves through its proxy; every adblocker kills it, and nothing of ours may DEPEND on it (that is the only part an adblocker can break, and it breaks nothing). **(2) THE 502s were the gateway restarting** (transient — the site was fine a second later) **but the ERROR PAGE WAS HTML**, and every page reads these endpoints with `await res.json()` — so an HTML body threw a raw SyntaxError, the live panels froze on STALE data, and the console filled with errors that LOOKED like the site's fault. **(3) The API's own 404 was HTML too** (Express's default handler answers "Cannot GET /api/whatever" as a web page) — so a renamed or removed endpoint broke every reader, permanently. **THE LAW, in three parts** (each pinned by a test): **A. THE API ANSWERS JSON, EVEN WHEN IT FAILS** — a JSON 404 for an unknown endpoint (`api/server.js`, a catch-all after every route: `{"error":"no such endpoint","path":…,"hint":…}`) and a JSON 503 from the proxy (Caddy's `handle_errors` now tells API paths from page paths — API → `application/json`, pages keep the friendly HTML 404). **THE 502 TRAP, MEASURED:** the first version answered **502** with the JSON body — and Caddy sent it, but **Cloudflare REPLACES the body of a 502 that comes from the origin with its own plain-text page** ("error code: 502"), so the JSON never reached the browser. A **500 and a 503 pass through untouched** (probed with a temporary route on the live site); the rule therefore answers **503**, which is also the honest status for "the upstream is not answering". Live drill, gateway stopped, through Cloudflare: `HTTP/2 503 · content-type: application/json · {"error":"the gateway is not answering right now - try again in a moment","status":503}` — and the homepage still serves 200 (the site degrades, it does not break). **B. THE CLIENT NEVER THROWS ON A BROKEN BODY** — `HIVV.json()` (in `public_html/js/shared.js`) checks the status AND the content-type and returns `null` for anything that is not a JSON body; `HIVV.request()` parses defensively; the homepage's live panels read through it, and the `Promise.all` that made ONE failed endpoint take the other down is gone (two independent calls). **C. NO PAGE DEPENDS ON A THIRD-PARTY SCRIPT** — every page's scripts are same-origin (the libs we host ourselves: leaflet, d3) and no page references the Cloudflare beacon; a static-JSON read must check `res.ok` (a missing static file falls through to the HTML 404 page — the one hole the server-side rule does not cover). **Tests**: `api/tests/blocked-friendly.test.js` (14) — the JSON 404 LIVE + the surfaces it covers · the LIVE Caddy config carries the rule · **a real proxy drill** (a throwaway Caddy on a spare port proxying to a dead port answers JSON — no production traffic touched) · the helper's five behaviours (502-HTML · 404 · request never lands · JSON behind an HTML content-type · a real JSON body) · the static-JSON scan (it found all three: bridge.html · music.html · style/index.html) · the homepage's live panels · no third-party script · no beacon reference · we host our own libs.

- [x] The escape hatch — hivv.org is a single point of failure, and GitHub must NEVER become a flood — 2026-11-26: the ask was "do we have a fallback 'help' we can use from our github repo if hivv.org goes down? it might be worth thinking about since thats kinda 'free help' and a way to save us for security problems hivv.org" — followed by the hard constraint: **"WE DONT want to flood github EVER. that would be a VERY serious problem."** **THE SURVEY**: hivv.org served EVERY entry point — the CLI (the auto-update polls `$HUB/hivv-cli.py` every 5 min on every bee), the wrapper (`$HUB/hivv-cli.py`), the installer (`$HUB/hivv-cli.py` + `$HUB/hivv`), the rescue (`$HUB/install-hivv.sh`), and the online help. **ZERO** GitHub references existed anywhere in the CLI, the installer, the wrapper or the rescue: one hostname, one point of failure, and it is the very thing you need to fix when it breaks. **THE FLOOD LAW** (the constraint made structural, not aspirational): *GitHub is a DESTINATION A HUMAN CHOOSES, never a fallback an automatic poll reaches.* The agent auto-updates every 5 minutes on every bee — if that path fell back to raw.githubusercontent, a hive of N bees would make N requests every 5 minutes against a third party's CDN: a flood, and a rate limit or IP ban that takes every bee behind that address down with it. So: **(a) THE AUTOMATIC PATH NEVER TOUCHES GITHUB** — `cmd_agent`'s source is scanned by an AST test that fails if the words `github.com`/`raw.githubusercontent.com` ever appear in it, and if `cmd_update` (where the GitHub option lives) is ever called from it; exactly ONE function in the whole CLI may contain the literal (`_fallback_url`), so a future edit cannot smuggle a fetch into a loop. **(b) THE HUMAN PATH TOUCHES IT ONCE, DELIBERATELY** — `hivv update --from-github [--ref SHA]`, and every deliberate fetch passes a FLOOD GUARD: one fetch per cool-down window per machine (the slot is reserved BEFORE the fetch, so a failed fetch still spends it — a broken network cannot turn a retry loop into a flood). **(c) THE SHELL ENTRY POINTS GET A FALLBACK CHAIN** — the wrapper, the installer and the rescue try the hub first and the GitHub copy second (ONE extra request, only when the hub does not answer, only because a human ran them): the rescue now pulls the installer from BOTH and says so. **THE FREE HELP**: `hivv fallback` prints the whole escape hatch **with no network at all** (the URLs, the exact commands, the verification recipe) — and `docs/HELP.md` in the repository is the document that survives the site's death, linked from the README. **THE SECURITY ANSWER** (the part that matters if hivv.org is COMPROMISED, not merely down): *do not use your installed `hivv` binary to fix it* — it may be the thing that is compromised. Fetch a known-good copy by hand at a **commit SHA** (immutable — GitHub serves those bytes forever), and **verify it without trusting hivv.org for a checksum**: the CLI's version IS the sha256 of its own bytes (`0.2.<sha256[:8]>`), so `python3 hivv-cli.py --version` against the downloaded file is the check. **Verified live**: ONE request to raw.githubusercontent returned the real CLI (1,088,571 bytes) and its self-hash matched. Tests: `tests/test_fallback.py` (26: the flood law — the agent never names GitHub, never calls `cmd_update`, never touches the fallback helpers, and exactly one function may contain the literal · the flood guard — first allowed, second refused, `--force` overrides, the window expires, a failed fetch still spends the slot · `hivv fallback` prints every entry point WITH NO NETWORK and `--json` is machine-readable · the URL shape + the SHA-is-immutable rule · the three shell entry points are valid shell and each has a fallback it can be pointed elsewhere · the opt-in live check is `HIVV_TEST_GITHUB=1` — **the suite touches GitHub zero times by default**).
- [x] The watchdog — restart a stuck service, and NEVER loop — 2026-11-26: the ask was "can we automate a restart of the tools server if or any of the others if they get stuck? and not also do infinite loops?" The report that came with it was a box that had been running the PRE-refactor `hivv-tools.py` for a **MONTH**: alive, but serving 5 tools with no `do_POST`, so every POST answered 501 — because `hivv tools on` short-circuited on "the pid is alive" and never replaced it. **TWO faults, one feature.** **(1) ALIVE IS NOT WORKING** — health is now the catalog's SHAPE (a current server serves ≥12 tools and carries `local_tools`/`hub_tools`) **plus a real tool call** (the old server answered `GET /tools` perfectly and 501'd every POST — the catalog alone was NOT enough). `hivv tools on` now REPLACES a stale server, `hivv tools status` prints the health instead of just the pid, and the helper download moved INTO the `on` branch (a STATUS command must answer even when the hub is unreachable — it used to die). **(2) NO SUPERVISOR AT ALL** — the tool server was a detached `setsid` spawn: when it died it stayed dead. It now has a real owner, and **ONE OWNER PER PORT**: `hivv tools on` ADOPTS an unsupervised server under `hivv-tools.service` (systemd user unit · `Restart=on-failure` · `StartLimitBurst=3`), refuses to install a second owner beside a live pm2 app, and removes a leftover unit that would have fought for 18789. **THE LOOP-BREAKER** is four gates: (1) **DESIRED STATE** — only what you turned ON is supervised (an intent flag + the unit's enabled state); (2) **THRESHOLD** — 2 consecutive failed probes, never one; (3) **BACKOFF** — 120s → 240 → 480 → 900s cap; (4) **BUDGET** — 4 restarts, then **QUARANTINE**: the watchdog stops, says so out loud, and waits for a human (`hivv watch reset`) or a self-recovery. The state is a FILE, so the bound survives a watchdog restart — the breaker cannot be reset by the thing it exists to stop. **Quarantine means STOP** (a pm2 app left running keeps restarting; a stopped one does not). **The agent ticks it** every heartbeat (free supervision on every bee) and `hivv watch on` installs a dedicated `hivv-watch.service` for a tighter 30s. **BONUS — the unbounded supervisor found in the act**: the hub box's pm2 app ran `autorestart: true` with `max_restarts: null`, i.e. an app that cannot start is restarted **FOREVER**, with no backoff — the exact loop the question asked about, already running. `hivv tools on` now BOUNDS it (max 3 restarts / 60s, 10s backoff) through a generated ecosystem file, because pm2's CLI has no `--min-uptime` and without it a server that crashes after 2s of life is never counted as unstable. **Live drill on ashy**: killed the server → pm2 brought it back in 10s; then made the port unbindable → attempts 1–4 (the last two FAILED and still spent the budget — an attempt is an attempt) → **QUARANTINE**, the pm2 app stopped, the loop over, the log saying why; `hivv watch reset tools` brought it back (and `pm2 restart` falls back to `pm2 start`, because "restart" fails on an app that is not running). Tests: `tests/test_watchdog.py` (45: the decision matrix — threshold, growing backoff, budget→quarantine, quarantine stickiness, self-recovery, the bound surviving a watchdog restart; the tick end-to-end incl. "a skipped restart spends nothing" and "a failed restart still spends"; the stale-server probes against a real HTTP server incl. a real 501; the intent flag; the unit text; the owner precedence; the pm2 bounding; the CLI).
- [x] The REQS column that was always 0 — `hivv stats` now counts the traffic a bee really served — 2026-11-26: the report was "the hivv stats isnt showing any reqs and just isn't working with xyzo.org" (xyzo.org's AI client points its primary at this hub, so its traffic is the hive's traffic). **A number that never moved is not a measurement.** TWO independent causes, both real: **(1) The bee never reported anything** — the agent's heartbeat sends `stats.total_requests`, computed from a state key (`local_requests`) that the CLI NEVER wrote: a structural zero, not a reading. **(2) The hub never counted either** — nearly every answer is routed DIRECTLY (hub → bee's llama-server), and the bee's own agent is not in that path, so the bee cannot see the request; only RELAY work (bee behind NAT) was ever counted. That is why the table showed "31 TASKS / 528 TOKENS / 0 REQS" while the hive had actually served 169 requests and 104k tokens that day — and why xyzo.org's traffic (every call lands here) was invisible. **THE FIX, two halves:** the CLI counts the jobs its agent serves (`local_requests` — relay + coding), so the bee-reported counter is real; and the HUB counts what it ROUTES (`orchestrator.creditNodeAnswer` → `node.stats.routed_requests` / `routed_tokens` / `routed_by_transport`), because the hub is the only place where BOTH transports are visible. Credited at the two answer sites (`tryLocalAI` direct + `_tryRelay`), never in the answer's way (a throw is swallowed). **Three traps owned on the way**: (a) `registerNode` REBUILDS the node object — `stats` was NOT carried over, so every agent restart wiped the whole history and the column fell back to 0 for a bee that had been serving all along (same trap as `secret`/`tools`); (b) a LOCALHOST target on the hub box is still a BEE (the hub machine is usually a registered bee — ashy here) — the route label says "localhost", the credit must say "ashy"; (c) `GET /api/control/stats` hardcoded its OWN 3-minute alive window while the website counted with `orchestrator.isLive` — the same hive published "3 online" here and "2 online" on the homepage; one truth now (`isLive`). **The table says what it measures** (a number without a meaning is a rumour): "REQS = requests the hive routed to that bee (direct + relay) · TOKENS = tokens it generated · TASKS = jobs its own agent ran", and `--json` carries the transport split + the bee's own tally (`bee_reported_requests`) so the two sides can be cross-checked instead of silently summed. Tests: `api/tests/traffic-count.test.js` (9: counter + transport split · unknown bee is a no-op · **re-registration keeps the counters** · nodes.json round-trip survives a restart · target→bee mapping incl. the this-box case · accounting never breaks an answer · LIVE payload shape) + `tests/test_traffic_count.py` (8: the CLI writes `local_requests` on relay + coding jobs · the heartbeat still derives `total_requests` from it · the monotonic guard covers it · the table keeps its REQS column and its legend · **LIVE**: an answer through the hub moves the answering bee's counter). The independent ledger agrees: `hivv_request_provenance` shows the same bees (`masjid/… (direct)`) with the same counts.

- [x] The keyless map — the tiles that demanded an API key, the `<script>` that ate the page, and the blocker-proof Leaflet — 2026-11-26: the report was "wuld be nice to get the map workin on https://hivv.org/map/" plus two console lines. **THREE separate faults, one page.** **(1) The unclosed `<script>`** — `public_html/map/index.html` opened a `<script>` at line 64 and never closed it: the browser swallowed the next `<script>` (the tab handler) as JS source, hit the literal `<` at line 140, and threw `Uncaught SyntaxError: Unexpected token '<'` — which kills the WHOLE block, so `L.map()` never ran and every card sat on "…". One line of HTML, one dead map. The tab handler now lives in its own block, and every map page is pinned by a test that counts `<script>` against `</script>`. **(2) "API KEY REQUIRED"** — CARTO's basemap CDN now burns `API KEY REQUIRED — carto.com/basemaps/apikey` into EVERY tile it serves (found by rendering the tiles in a browser and reading them), so the map was a wall of watermarks. A map that demands a key is a map this hive does not want → **new `api/routes/tile-routes.js`**: `GET /api/tile/:z/:x/:y` serves **OpenStreetMap** (ODbL — free, no key, no signup) with Esri's keyless dark Canvas as the server-side fallback; memory cache (900) + disk cache (512 MB, oldest-first prune) under `$HIVV_DATA_DIR/tiles` so a restart never re-fetches; a User-Agent that names the app (OSM's policy asks for it) and `X-Hivv-Tile-Source` (`memory|disk|upstream:*`) so the origin of every byte is auditable; out-of-range z/x/y → 404, never proxied. Mounted BEFORE the general API limiter with its own 1200/min budget — tiles are cheap, cached and public; the general budget belongs to the endpoints that cost money. The three map pages now point at the proxy, keep direct OSM + Esri Canvas as in-browser fallbacks, and invert the TILE pane in CSS so OSM's light tiles read as a dark map (only the tile pane — markers, arcs and rings live in the overlay pane and keep their own colours). **(3) Leaflet from a CDN** — a CDN is one blocker away from gone, and this hive's readers run blockers (the reported `ERR_BLOCKED_BY_CLIENT` was Cloudflare's own beacon): Leaflet 1.9.4 now lives at `public_html/lib/leaflet/` (js + css + images — `vendor/` is gitignored, `lib/` ships), with unpkg kept as a fallback. **Bonus**: the embedded xyzo.org world map now gets `allow="geolocation"` — without it the Permissions Policy refused the location and the console filled with violations (xyzo falls back to geoip, but the console is clean now). Tests: `api/tests/tile.test.js` (10: route validation · PNG magic + cache headers · the `.png` suffix · **no CARTO and no keyed provider in any map page** · **every `<script>` closed** · Leaflet vendored · the proxy is the tile source · the iframe grants geolocation · LIVE tile). **371 node --test green.**

- [x] The open-model preference + /team/ + the pre-pentest URL fix — 2026-11-25: **(1) Totally-open-model preference** — "do we have anything that suggests we prefer people who use copyleft GPL v3 or MIT for totally open models so they can be modified and studied?": `api/lib/licenses.js` (family map: Qwen/Mistral/Phi/DeepSeek → open · Gemma/Llama → honestly *NOT OSI-open* · unknown → `null` — **never guessed, never blocked**) + the `PREFERENCE` statement in the manifest's `open_models` field AND the openapi philosophy ("fork the weights like you fork the code… the preference suggests, it never gates") + `license_hint`/`open` served on `GET /api/partner/models`. Tests: `api/tests/licenses.test.js` (4). **(2) /team/** — "if you hack the site you're automatically on the team (sorta)": the red-team roster page at `public_html/team/` (renamed from /redteam/ by request) — Upal's IN PROGRESS entry (Bangladesh · CA/NYC/Miami · Espresso + six figures + a wish), the recruit slot, the join path incl. **fork → PR** (direct push reserved behind the gates), the honest defense list, the rewards, and "we ban bad actors, not birthplaces". **(3) Pre-pentest hardening**: `safeUrl()` in party-routes — `javascript:`/`data:` URLs are DROPPED at the API (the wish/recommend link fields were the injection hole; verified live: the probe stores `''`). Gates: **1251 pytest green** + node suites green.

- [x] The brand door: /api/hivv is canonical, /api/hive never breaks — 2026-11-25: "odd we dont want hive in our api? we want hivv right?" — **hivv is the brand; hive is the collective** (the same way a flock has a name and a species). Answer: BOTH, with one as canon. **One mount line** in server.js: `app.use('/api/hivv', HoneyRoutes)` mounted BEFORE the legacy `/api/hive` — same router, two doors, nothing can drift between them. **/api/hive stays mounted FOREVER**: `hivv share` hands users `/api/hive/share-card/<id>.svg` URLs to embed in their social bios, and breaking an embedded image in someone's profile is never acceptable (the consumer map: CLI ×20 · command-center ×8 · homepage ×2 · tests ×6 — all keep working untouched). New code uses the canon: the `hivv salah` client now calls `/api/hivv/salah`; existing refs migrate lazily. Test: `api/tests/salah.test.js` "brand" — both doors 200 AND serve IDENTICAL `prayers` (raw bodies differ only in time-relative fields — the assertion compares the absolute instants). Also captured in `HIVV_RITUAL_PLAN.md`: the **Hindu layer invited** (aarti dusk check-in · prasad = what honey is called · temple-bell alert tone · rangoli share-card borders — "i'm cool with adding in some hindu ideas soon!") and the **Bengali layer invited** ("maybe even bangali if upal has some suggestions!" — Kirtan call-and-response · dawn alaap · Vishwakarma Puja, the patron of BUILDERS, which is frankly our genre) — both under the standing rule: opt-in style, never a gate. Gateway restarted to mount the door (healthy, both paths 200, prayers byte-identical). No commits made.

- [x] The horizon layer — signed physical-horizon warnings + the ping floor — 2026-11-25: "in a crash only allow nodes3-5 miles away… the edge/horizon problem… warn people ANYTIME the connection is beyond the physical horizon… AM radio: dozens–couple hundred miles by day, hundreds–~1,000 at night… mostly a HOME hivv.org." **`api/lib/horizon.js`**: classify → **within · beyond · unverifiable** (localhost ✓ · located peer ≤ `HIVV_HORIZON_MILES` (default5) of the core via `setHubLoc` · private/RFC1918/CGNAT path → unverifiable · no location → unverifiable · cloud → beyond) + haversine + **the ping floor**: ~1 ft/ns → `implied_miles = rtt_ns × ft / 2 / 5280` → `proveHorizon` = **impossible** (20µs vs a3-mile claim needs31,680ns — faster than physics) / **proven-within** (40µs on a home LAN proves ≤3.78mi <5mi horizon — physics-verified neighbor, no trust required) / **inconclusive** (10ms proves nothing). **Emission**: `X-Hivv-Horizon` header at ALL four answer sites (router stream-direct + relay, server /v1 + /api/chat) with the verdict **SIGNED into X-Hivv-Receipt** (`horizon` + `horizon_reason` — unstrippable; ASCII-folds in the header, full Unicode in the signed JSON). **Bugs owned en route**: (1) HTTP headers are Latin-1 — em-dashes threw "Invalid character in header content"; (2) /api/chat has THREE success exits — a warning covering one door isn't a warning (`_sendSigned` before each); (3) the helper first landed INSIDE the validation if-block (block-scoped → "_sendSigned is not defined"); (4) a concurrent-session write race mid-restart (transient SyntaxError — the settled file passes `node --check`). Tests: `api/tests/horizon.test.js` (8: classification matrix · haversine NYC→LA ~2450mi · setHubLoc reference stickiness · ping floor exact5mi↔52,800ns · impossible/proven-within/inconclusive · forAnsweredBy · isPrivateIp incl. CGNAT · **LIVE**: header present + signed field matches header byte-for-byte + hub signature verifies). **357 node --test green.**

- [x] Salah surface: `hivv salah` · the attendance engine · GET /api/hive/salah — 2026-11-25: the ritual engines shipped but served NOTHING (no route, no CLI — "bees report5× a day at THEIR region's prayer time" had no way to happen). Now: **(1) `api/lib/attendance.js`** (new) — the reporting layer ON TOP of salah.js: `solarDayKey` keys days by the SUN (`UTC + lon/15h`), not UTC — a bee in UTC+13 has fajr at 16:00 UTC the PREVIOUS day, and UTC keying would split one local day across two keys so a 5/5 streak could never complete · `mark(node, now)` = a heartbeat inside a regional prayer window IS the report (idempotent, one mark per prayer per day, history pruned to 45 days so state can't grow forever) · `attendanceOf` = today's marks + what today EXPECTS (polar nulls are never expected — they can't be marked) + streak of consecutive complete days (today may be in progress without breaking it). **(2) Heartbeat hook** (`server.js`, after the quarantine gate — quarantined bees are inert): `att.mark(updated)` → persists via the next `_saveNodes`, logs `[SALAH] bee: dhuhr (2026-11-25) 3/5`, wrapped so ritual math can NEVER break a heartbeat. **(3) `GET /api/hive/salah`** (`honey-routes.js`) — `?node=<id|name>` (that bee's registered region + its attendance) or `?lat=&lon=` (ad-hoc, no attendance) · 404 unknown bee · 409 no location yet · 400 missing params — never a 500 for bad input. Returns prayers (UTC instants), `next`, open `window` (30-min), moon phase + next full moon, attendance. Shares the SAME attendance math as the handler — one source of truth. **(4) `hivv salah`** (alias **`sala`**/`salat` — routed like upgrade/capability so it can never fall into the chat smart-default): times rendered in THIS machine's local clock (that is the point — the prayer time of THEIR region), ✓ marks on attended prayers, `← next in 3h 54m`, `● window open — until 12:04`, `attendance: 4/5 today · streak 12 days`, and the moon (🌕 FULL MOON — the hive celebrates) · `--node`/`--lat`/`--lon`/`--json` · no node id → dies with the `hivv start` hint, never chats. Tests: new `api/tests/salah.test.js` (10: solar-day keying across UTC+14/−10 · key→set round-trip + chronological order · polar June midnight-sun → null NEVER noon · mark once/outside/no-location · 45-day prune · streak with today-in-progress/gap/partial · window+neighbour days · live route ×3 incl. 4xx-not-500 · the wiring pin that server.js actually calls mark) + new `tests/test_salah_cli.py` (8: registration+alias · sala help · help-search finds it · no-node dies with the right hint and NEVER chats · live: ad-hoc JSON+render, node attendance shape, alias parity — hub-gated skip). **348 node --test + 1250 pytest green (0 failed, incl. test_verify_drift which runs the whole suite inside)** · TESTMAP regenerated (70 test files; new files `git add`ed first per the map's ls-files rule) · live tests pin the subprocess to localhost:3011 and RETRY through other sessions' gateway restarts (they restart it 20+× to mount routes — a mid-run blip skips/fails honestly instead of flaking) · live: `hivv salah --node wahi` shows real Moscow-ID times + attendance · gateway restarted to mount the route (healthy, db connected). First real mark lands at dhuhr — the bees heartbeat every 60s, the window is 30 min. No commits made.

- [x] The offline party — /party/, live BEFORE it's needed — 2026-11-25: "if someone crashes/hacks hivv.org can we have an offline party… we need a signup" — the hive's contingency is a GATHERING: `public_html/party/` (big red pulsing **OFFLINE PARTY!!!** + a drifting emoji swarm 🐝🔌🚨🪩🛰️) + `api/routes/party-routes.js` (`POST /api/party/rsvp` with name+city dedupe, `GET /api/party/board` — names + cities ONLY, contact never public; file-backed local-first, cap 500). Content: valid triggers (crash · confirmed hack · **maybe hacked** · solar flare · a special full moon · Tuesday) · rules (the only DDoS we accept is a dance floor) · the opener chosen (Echosmith – Cool Kids) · **Cape Town chapter in charge: Reza Rassool (Kwaai, HIVV's peer hive)** — with the trust-network joke that even our friends get measured trust ("prove you're from Cape Town: one penguin selfie at Boulders Beach") · and the **Geographic Standings (officially unofficial, 100% vibes)**: Brazil-except-Rio · Australia on probation · Greenland no · Norway maybe · Denmark maybe-if-wind · Finland only if NOT running Linux (don't crash Linux — it lives there) · Russia/China maybe-on-Linux-only · a new human-designed OS is PROTECTED · spiritual whitelist (Hainan · Sri Lanka · Taiwan) · the Taiwan-fab hardware reality ("we didn't build the wall; the fabs did") · the three black-dot polar islands banned forever · penguins already have their party (Cape Town). **The ban that IS policy** (on /security/): **OUTRIGHT BAN — bad actors. Not birthplaces** (revoked keys · quarantine · rate limits · the CRL; "Africa is invited — it's where the wiser hive comes from"). Tests: `api/tests/ritual.test.js` →9 (rsvp count · dedupe · **board never leaks contact** · 400 without a name; the fixed-name guest self-dedupes so the board stays tidy across runs). **337 node --test + 1242 pytest green.**

- [x] The CLI answers back: fuzzy `hivv help` · `hivv remove` · ollama families · 2-step install — 2026-11-25: four asks, one batch. **(1) Fuzzy help**: `hivv help ollama` / `hivv ollama help` / `hivv help --model` / `hivv --typo-flag` → `_help_search()` scores every command from the INTROSPECTED parser index (`_argparse_command_index`) — exact > prefix > name-substring > haystack > difflib — plus a NESTED walk (llm install, eval run …) because their flags live on the nested parser (without it `--model` never found `llm install`). Zero hits → "did you mean" via difflib + pointers; unknown flags search FIRST, then die. Bare `hivv help` still prints root help; `help list|submit` now fall through to the feedback command (the old root-help short-circuit swallowed them whole — dead code made visible). **(2) `hivv remove`** — the "clean hivv" ask: bare lists the parts WITH SIZES (llm · models · agent · config · logs · state · everything), every delete shows exactly what dies and asks (TTY y/N; non-TTY requires `--yes` or it dies with NOTHING removed), four safety rails: argparse CHOICE names only (no user string reaches the filesystem) · `_rm_tree` resolves first and refuses `/` and `$HOME` (symlink bombs included) · service stops ONLY when agent.pid says this install is live (a test can never stop the box's real llama) · logs ≠ state (identity keys survive `remove logs`). **(3) ollama families** — `--model qwen` (also gemma/llama/mistral/phi/embed) resolves against a HARDWARE BUDGET (`_ollama_budget`: GPU → 0.9×VRAM · CPU<8 → min(ram/2, 4 GB) · CPU≥8 → min(ram/2, 8 GB)) to the largest SMALL+FAST tag — wahi(4c/22GB)→qwen3:4b · ashy(6GB GPU)→qwen3:8b · tiny(2c/4GB)→qwen3:1.7b; an oversized EXPLICIT tag is honored but warned with a smaller alternative offered as a CHOICE (interactive [Y/n], non-interactive honors the ask loudly). Sizes: published table + 0.65 GB/B-param estimate fallback. Wired into BOTH `llm install --model` and `llm pull`. **(4) The 2-step install**: `hivv install ollama` = step 1 (install only, verify with ollama --version), `hivv install ollama qwen` = step 2 (install-if-needed + pull; positional becomes --model). The chooser lists both paths. Found while fixing: the dispatch had been CLOBBERED by a concurrent session's file rewrite (tests survived, code didn't — 4 red) and `--help` after the rewrite must stay at argv index 2 (else argparse's SystemExit(0) falls through to the self-heal footer: "its own command parser failed" on a healthy CLI). Tests: `TestOllamaFamilyResolution` +6 (budget shapes · family fits · oversized warn w/ alternative · silent pass-through · table+estimate · install-without-auto resolves and returns WITHOUT running curl) + new `tests/test_cli_discovery.py` 15 (search: ollama both spellings · flag query · no-match · bare-help regression · submit-unsadowed · unknown-flag · remove: list/refusal/invalid-part/logs-keeps-state/config-keeps-state/everything-cleans+reinstall-line/refusal · `_rm_tree` refuses / and $HOME) — all subprocess against the REAL CLI with every path env-overridden into tmp + PATH stripped of ollama (a test can never touch real state or run `ollama rm --all`). Full suite **1242 passed, 0 failed**. No commits made.

- [x] The human layer: /security/ + /origin/ pages, the philosophy, reserved ritual words, salah + moon engines — 2026-11-25: the ask was "spiritual words are humanity's original protocol — we need to update our API and public persona… people like to know WHO is behind a project… there has to be something HUMAN on the page, it gives HIVV.org personality and truth." **Philosophy, in three places**: the manifest's `philosophy` block (superintelligence = logical AND spiritual · the prayer/wifi test question · no anarchy — spiritual discipline governs logical anarchy · interfaith roots · style opt-in/fork), a matching openapi description section, and a homepage card — plus the **priority policy born of grandfather's story**: PRIORITY ACCESS outside the USA (the further from hivv.org, the wiser we assume you are, and the faster we will try to connect) — also in the manifest. **/security/** (`public_html/security/index.html`, directory-form because express.static doesn't guess extensions — /security → 301 → /security/): the full trust story (Ed25519 bees · X-Hivv-Receipt with client-verifiable answer digests · measured trust null≠0 · the ritual layer · human randomness seals — faith NEVER verified · animal vouches as living lease) + philosophy + the never/always lists. **/origin/**: the human truth — Ash, the Indonesia→Pakistan→Iran family joke, dad the atmospheric physicist (air pollution: India, China, Mexico City), brother the neuroscientist who studies the brain stem too, mom by her own request, grandfather's Alzheimer's story as the source of the priority policy, sailing-instructor faith ("learned everything about God and religion from teaching sailing"), Yalla's resting place near Hell's Bell at Spohr Gardens, the "Hells Bell" film, the Woods Hole/Alvin visit guide, and the Space Hook riddle — while the anchor-collection claim stays PRIVATE and the doc link is published view-only (/preview, not /edit). **The intruder's reward**: `GET /veil/space-hook` — the message the founder asked to be told only to people who got in (Jesus/anchor/Space Hook), inside the existing veil. **Reserved ritual vocabulary** (`bee-identity.js isReservedId`): fajr·dhuhr·asr·maghrib·isha·salah·wudu·adhan·sujud·dua·hajj·jihad·ramadan·eid·zakat·moon·tongue — no bee may claim them (register → 400 `BEE_ID_RESERVED`). **Engines**: `api/lib/salah.js` (pure solar math: NOAA sun position, EoT, hour angles, asr shadow-factor; absolute UTC instants; polar absences → null NEVER noon — the `fromNoon(-null)===noon` bug was caught by its own polar test; Greenwich equinox anchor ≈12:07 UTC, Mecca within minutes of published tables) and `api/lib/moon.js` (synodic phase, full-moon detection, exact `nextFullMoon` — the first bisection converged to a non-full instant and its own test failed it; linear math needs no bisection). Tests: `api/tests/ritual.test.js` (8: reserved matrix + live BEE_ID_RESERVED with self-clean · Mecca ordering · Greenwich anchor · polar nulls · window behavior · moon wrap/naming · full-moon exactness). **337 node --test green** · pages verified live (301→200 on /security and /origin) · veil egg verified.

- [x] `hivv install ollama` — the dead-end your question found (dispatch + a self-heal false alarm) — 2026-11-25: "dont we have a hivv install llm or hivv install ollama type of thing???" — we had `hivv install llm` (→ `llm setup` one-shot) and the ollama installer (`llm install`), but **`hivv install ollama` fell into a chooser that listed ONLY `install llm`** — the natural spelling of the ollama path printed no ollama line. **Fix** (`public_html/hivv-cli.py` dispatch): `ollama` now rewrites to `["llm", "install", "--auto"]` — same shape as the `llm`→`llm setup` alias, because "install" means DO it; extra flags pass through (`--docker`, `--model X` → install + pull in one command). The chooser lists both paths. **Second bug found while fixing the first**: the prepended `--auto` shifted `--help` off index 2 → the per-cmd help check missed it → argparse's `SystemExit(0)` fell through to `_self_heal_from_parse_error` → **"hivv could not start — its own command parser failed" printed on a perfectly healthy CLI** (the self-heal path only whitelists exit code 2 as a usage error). Fixed: help requested → don't prepend, so `--help` stays at index 2. Tests: `TestInstallOllamaDispatch` +4 behavioral (subprocess against the real CLI: chooser mentions BOTH paths · `install ollama --help` RC=0 with no "parser failed" · rewrite proven by a `--model` usage error from the *llm install* parser — parse-time failure means NOTHING was installed · original `install llm` alias survives the new elif). Full suite **1209 passed, 0 failed**. The map, for the record: `hivv install llm` = llama.cpp one-shot · `hivv llm install [--auto]` = ollama (prints unless `--auto`) · **`hivv install ollama [--model X]`** = ollama, one command. No commits made.

- [x] Cryptographic identity Phase 6: signed route receipts (X-Hivv-Receipt) · enforcement flag · `hivv identity verify` · trust in `hivv node` — 2026-11-25: closing the loop on "signed execution receipts" across the actual product surface. **Route receipts** (`identity.js routeReceipt`): the HUB signs what it observed — `{v, kind: route.receipt, ts, nonce, answered_by, transport, [answer_sha256], [duration_ms]}` — emitted as a base64 `X-Hivv-Receipt` header at all FOUR answer sites (router stream-direct + relay, server.js both non-stream paths), wrapped in try/catch at every site so a receipt can never break a response. Non-streaming answers INCLUDE the digest: a client hashes the body it received and matches it against the signature (proven live: `answer_sha256 matches received body: True`); streaming signs attribution only — the body does not exist when headers go out. Hub key at `api/.keys/identity-key` (0600, `HIVV_IDENTITY_HUB_KEY` override), published at `GET /api/identity/hub-key`; verify = POST the decoded receipt to `/api/identity/verify` and compare principals. **Bug owned on the way**: the first derivation built the public key as `SPKI-prefix + seed` — an Ed25519 SPKI structure holds the public POINT, not the private seed, so sign/verify disagreed (`raws equal: false`); derive via `createPublicKey(privateKey)` (scan-routes already did this). **Enforcement** (`HIVV_IDENTITY_ENFORCE=1`): register AND heartbeat then require an identity block (403 `IDENTITY_REQUIRED` with the upgrade hint); the default stays advisory — the flag an operator flips once the fleet has keys (all four current bees do). **`hivv identity verify <file|-> | '<base64>'`**: third-party verification of any signed statement — including a pasted `X-Hivv-Receipt` header value; VALID → exit 0, INVALID → exit 1 (scriptable); a `{ok:false, problems}` body is a VERDICT, not a transport error (the first cut buried it under the support footer — fixed). **`hivv node <bee>`** now prints `identity` (principal + status + revoked flag), `manifest` (seq + signed tool/model counts), `endorsed`, and `trust` (`5.16/6 (overall 86)  id 95 · rel 80 · hist 83 · receipts —` — a null dimension prints as an em dash, never 0) — both blocks folded into `--json`, best-effort so an older/dead hub can never break the command. Tests: `api/tests/identity.test.js` →31 (route-receipt roundtrip + digest tamper + header encoding + LIVE chat receipt: signature verifies against the published hub-key, digest matches the exact body received, answered_by agrees with X-Hivv-Answered-By; enforcement flag matrix + config-aware live contract) + `tests/test_identity_cli.py` →38 (verify command VALID/INVALID/garbage, node-detail identity+trust display, missing-endpoint survival). **316 node --test + 1205 pytest green** · openapi 47 paths (hub-key + receipt contract + enforcement documented).

- [x] Build-tool gate covers the WHOLE toolchain: C++ compiler + make (all 3 surfaces) — 2026-11-25: wahi's `hivv install llm` got PAST git/cmake (yesterday's gate worked) and died one wall later: `[2/3] configuring… → CMake Error: No CMAKE_CXX_COMPILER could be found` — the preflight checked `git`/`cmake` only, never a compiler (nor `make`, which `cmake --build` needs immediately after configure). Same class of bug as the sudo ladder: the gate must cover every binary the build actually invokes, decided BEFORE the step that needs them. **Fix (all 3 surfaces)**: `hivv-cli.py` gains a VIRTUAL tool key `cxx` — present when ANY of `g++`/`c++`/`clang++` exists (probe binaries, not spellings: a clang-only box compiles fine), package name per manager (`g++`/`gcc-c++`/`gcc`) via new `_build_tool_present()` + `_build_tool_label()` ("c++ compiler" in human messages, the manager's own spelling in commands); `_BUILD_TOOL_PKGS`/`_BUILD_TOOL_HINTS` carry `cxx`+`make`; both llama-build preflights now pass `["git","cmake","cxx","make"]`. `install-hivv.sh`: `need()` learns `cxx`, new `_pkg_of()`/`_tool_label()` translate for the install cmd AND the hint (labels in the ✗ message, packages in the copy-paste line). `deps.sh`: `d_have_build_tools()` requires make + any compiler, hint/install lists updated. Tests: `TestFullToolchainGate` +7 (tables cover the whole toolchain · cxx package spelling per manager · any-of compiler probe incl. negative · human label · BOTH call sites require it with the old git+cmake-only form asserted GONE · hints list compiler+make · installer + deps wiring). Full suite **1203 passed, 0 failed** · `bash -n` + `ast.parse` clean · TESTMAP fresh (no new test files). **Live on wahi**: hub↔wahi content-hash match `0.2.0e6484f1` (auto-update carried the fix) and the signed remote `hivv selftest wahi` answered `llm-listening ✗ nothing answers on LLM ports` (agent ✓, 203 GB free) — so wahi's ollama test needs ollama installed there first; no commits made.

- [x] Install LLM on a password-sudo desktop: the escalation ladder (all 3 surfaces) — 2026-11-24: the ask: `hivv install llm` printed "→ installing build tools…" and then "✗ missing build tool(s)" — the claim and the attempt disagreed. **Root cause (all three spots)**: the privileged runner was gated behind `sudo -n`; on a normal desktop sudo needs a password, so -n failed and the package install was SKIPPED silently — same pattern in `public_html/hivv-cli.py` (`_build_tool_run_privileged`), `public_html/install-hivv.sh` (`_can_sudo` gate in `ensure_build_tools`), `scripts/lib/deps.sh` (`d_run_privileged`; `d_can_prompt_sudo` existed but was never called). **The ladder** — decided BEFORE printing "installing…" so claim and attempt can never disagree: root/brew → plain · passwordless sudo → `sudo -n` · a human at a TTY → plain `sudo` (it asks THEM) · nobody watching → never prompt, print the exact command. **Empirically verified** (two pty experiments): sudo's password prompt AND its "Sorry, try again." retry both go to `/dev/tty`, not stdout/stderr — so redirection cannot hide them, and with no TTY sudo fails fast instead of hanging (that is what justifies prompting inside redirected shell calls). **Unattended = never prompt**: Python gate `_can_prompt_sudo()` (stdin TTY + `CI` + `HIVV_NO_SUDO_PROMPT` + `PYTEST_CURRENT_TEST`), shell gate `d_can_prompt_sudo()` (stdin TTY + same env guards — wired into `d_run_privileged` at last), installer gate on stdout (`-t 1`, because stdin is the `curl | bash` pipe); `brew` un-gated from sudo; prompt mode prints " — sudo will ask for your password". `PYTEST_CURRENT_TEST` matters: the suite drives this code, so `pytest -s` cannot hang it. Tests: `tests/test_llm_build_tools.py` +7 (`TestSudoEscalationLadder` — mode matrix, runner honours the mode, "no claim without an attempt", prompt-mode note, env guards, installer + deps wiring) · `tests/test_setup_scripts.py` +1 (bare sudo only behind the gate) · `tests/test_setup_prompts.py` (pty harness forces `HIVV_NO_SUDO_PROMPT=1` — the pty makes stdin a TTY, which would otherwise unlock the prompt branch with nobody to type). Full suite **1153 passed, 0 failed** · TESTMAP fresh (no new test files) · no commits made.

- [x] Cryptographic identity Phases 2-5: signed capability manifests · rotation statements · execution receipts · revocation CRL + operator endorsements · measured trust → routing — 2026-11-25: the rest of the identity checklist, all building on Phase 1's binding. **Phase 2 · capability manifests** (`identity.js verifyManifest`): `tools`/`local_models`/`capabilities` were SELF-REPORTED with zero verification — now the bee signs its advertisement with its BOUND key, a monotonic `seq` (state `cap_seq`, persisted so restarts stay monotonic; gaps fine, only `> last` accepted) makes replay/reorder fatal, and the SIGNED values overwrite the unsigned body fields (signed wins). Advisory at heartbeat like everything: a failing manifest echoes `{status:'failed', reason}` but never grounds to reject the bee. **Phase 2 · rotation** (`verifyRotation` + `POST /api/identity/rotate`): the CURRENT key signs a statement naming its successor — rotation with NO legacy proof (holding the current key IS the proof); staleness is FATAL (a replayed old rotation must never roll a key back); history records `rotated_via: rotation_statement`. CLI `hivv identity rotate` (keygen = alias): signs with the OLD key, writes the NEW key FIRST (a failed hub call still converges via mismatch → legacy rebind), then POSTs — live output: "hub: rotated ✓ — bound with NO legacy proof". **Phase 3 · execution receipts** (`verifyReceipt` + `POST|GET /api/identity/receipts`): the bee's signed testimony `{op, result, output_sha256, job_id}` over a repair outcome, verified against the bound key, kept in a bounded ring (32/node · receipt_id dedup · nonce cache); `output_sha256` binds the receipt to the EXACT report (edit after signing → signature mismatch); wired into the heartbeat's `repair_report` → `receipt_verified` on `node.last_repair`; CLI `hivv identity receipts [--limit]`. **Phase 4 · revocation** (migration 032 = the `identity_revoked` incident CHECK): two doors — SELF-revocation signed by the bound key (fresh, reason required) and operator revocation via localhost/control-token (target must be KNOWN so anon callers can't scribble the CRL); public CRL at `GET /api/identity/revocations`; a revoked principal authenticates NOTHING (register → 403 + deduped `identity_revoked` incident; heartbeat records `status:'revoked'` → the agent MINTS A FRESH KEY on the spot and rebinds with legacy proof — recovery by construction; the CRL keeps the old principal forever). **Phase 4 · operator endorsements**: separate operator keypair (`operator.key`, 0600 — never a bee key) signs `{operator_principal, node_id, node_principal, role}`; hub checks self-consistency (principal derives from the signer) + node-binding cross-check; same operator/node/role UPDATES rather than stacks; `POST /api/identity/endorse` · `GET /api/identity/endorsements` · surfaced on `GET /api/identity/:nodeId`; CLI `hivv identity endorse <node> [--role] · operator`. **Phase 5 · measured trust** (`api/lib/trust.js`): the router's `trust` factor was honey-rank alone (unranked = 0 — an honest new bee indistinguishable from a bad one); now a blend of EVIDENCE — identity (bound · fresh verify · signed manifest · recent failures; revoked → measured 0), reliability (quarantine → 0 · flaps · heartbeat recency), receipts ratio, honey history — with the house rule enforced: **null = no data, NEVER 0**; `routerTrustScore()` falls back to the legacy honey score when nothing is measurable (strictly additive for keyless bees); `GET /api/identity/trust/:nodeId` returns score(0..6)/dimensions/evidence and read-upserts `hivv_trust_scores` (finally lighting up migration 003's never-written table; DB optional). Live: masjid's route row carries `trust: 5.25 · factors.trust 0.875` vs unknown localhost `0`; ashy's breakdown identity 95 · reliability 80 · history 83 (royal-jelly) → overall 86. **Fleet signal**: after auto-update, ashy · masjid · wahi · yalla all bound their keys with no human involvement. Tests: `api/tests/identity.test.js` → 27 (manifest seq/foreign/tamper · rotation no-legacy-proof + forged + stale · receipts ring/dedup/tamper · CRL enforcement + recovery + operator revoke · endorsement forge/mismatch/dedupe — live endpoints throughout) + `api/tests/trust.test.js` (12: the null-vs-zero matrix, revoked/quarantined as measured zeros, rank mapping, receipts ratio, fallback blend, fake-pool persist, live endpoint + router factor rows) + `tests/test_identity_cli.py` → 34 (every Phase 2-4 statement round-trips through the hub's REAL `identity.js` in a subprocess, canonical parity, operator key 0600, command guards). **312 node --test + 1177 pytest green** · TESTMAP regenerated (64 files) · openapi.yaml carries all 11 identity paths · migration 032 applied live · test debris pruned from the public store (roster = the 4 real bees). One outage owned and fixed on the way: `IdentityRoutes.inject` was defined but never attached to the exported router (TypeError at boot) — the coding-routes `router.inject = …` pattern, now pinned by the boot itself.

- [x] Cryptographic identity Phase 1: Ed25519 bee identities — signed registration, self-certifying principals, live rebind — 2026-11-24: the ask was the identity checklist (Ed25519 key identities · signed node registration · signed capability advertisements · rotatable credentials · verifiable operator identities · measured reputation · identity revocation · signed execution receipts) — shipped the FOUNDATION the other seven build on. **Hub** (`api/lib/identity.js`): file-backed node_id → public key binding (local-first, no DB — like nodes.json); the principal is SELF-CERTIFYING (`hivv_` + sha256(raw_pub)[:32] via `attest.principalIdFromRaw` — the SAME namespace as attestation issuers); statements are canonical-JSON signed (attest.canonicalize rules) with ±300s freshness + an in-memory nonce cache (replay → fatal). **DUAL-MODE (advisory first)**: no identity block → legacy CLIs untouched; a PRESENT block must verify — crypto failures (bad sig, wrong node_id/kind, replayed nonce, key_mismatch without proof) → 403 IDENTITY_INVALID at /register but only RECORDED at /heartbeat (a broken signer never knocks its own bee offline); stale clock → advisory everywhere (recorded with the skew, never fatal); the signed statement must cover the hw_id the request presents (mixed-replay guard). First verified sighting BINDS (register OR heartbeat — the fleet resumes without re-registering, so the first identity-bearing heartbeat is the binding moment). Rotation/recovery: a different key replaces the bound one ONLY with legacy proof (node secret + hw_id — the same anchor authorizeClaim uses); the old key goes to history as `superseded` (attestation-contract compatibility policy). Read surface: `GET /api/identity` · `GET /api/identity/:nodeId` (public key + rotation history, never secrets/hw_id) · `POST /api/identity/verify` (pure crypto, no side effects) — all in openapi.yaml. **CLI**: keypair at `STATE_DIR/identity/` (0600, private key never leaves the box), backend `cryptography` (installed fleet-wide) → openssl fallback (`genpkey` + `pkeyutl -rawin`, cross-verified), `_canonical_json` mirrors attest.canonicalize byte-for-byte; identity blocks attach FRESH per attempt to register + heartbeat (additive — no key material → envelope None → agent unchanged); `hivv identity [status] [--json] · keygen` (local self-test + hub binding state, in root help + `hivv commands`). **The rebind loop proved itself LIVE**: the production agent auto-updated to the new CLI, bound its key, a tmp-state test run swapped it, and 60s later the log shows `identity MISMATCH — rebinding with legacy proof` → register → `replaced` → its own key restored — bind→mismatch→rebind→verified on a real bee, no human involvement. Tests: `api/tests/identity.test.js` (17: unit binding/replay/rotation/advisory/0600 store + live dual-mode/forged-403/mismatch-rebind/advisory-heartbeat/read surface) + `tests/test_identity_cli.py` (20: canonical byte-parity Python↔Node on nasty fixtures, Python-signed envelope verified by the hub's real identity.js, openssl-fallback round trip, unwritable-state → None never a crash, dispatch pins). 285 node --test + 1146 pytest green · TESTMAP regenerated (58 files) · scanner CLEAN. NOT yet (phases 2-5): signed capability manifests, rotation UX beyond legacy-proof, operator endorsements, reputation → `trusted` routing, revocation CRL, signed execution receipts.

- [x] Web search ON, responsibly — robots.txt + a per-host floor + a measured A/B — 2026-11-24: the ask: "follow terms of service as well as robots.txt … really not allow MASS REQUESTS … verify we are doing the correct thing first". **Responsible-fetch layer** (`api/lib/polite.js`, new): robots.txt obeyed BEFORE every page read — RFC 9309 parsing (agent groups, prefix matching so "hivv" matches our token, longest-match with Allow winning ties, wildcards + trailing $, Crawl-delay), a Disallow refuses with an honest reason ("the site asked crawlers not to read it"), 404/410/unreadable → allowed (absence of rules means no rules), decisions cached per origin 10 min (positive AND negative), `/robots.txt` itself always fetchable; **no-mass-requests floor**: one request per host per interval (default 2 s, `HIVV_FETCH_MIN_INTERVAL_MS`) that RESERVES the slot before sleeping — one host serializes, different hosts never wait on each other — plus the site's own Crawl-delay honored up to a 10 s cap; escape hatches are OPERATOR-only (`HIVV_FETCH_ROBOTS=0`, the interval env) — the model can switch nothing off. Wired in: `web_fetch` (robots check + floor; success carries `robots:` + `polite_wait_ms:` receipts so the behavior is verifiable), `http_request` (floor only — an API client is not a page crawl), `web_search` (floor on both backends — they were already official APIs only: Wikipedia API + Google News RSS, never a scraped engine; the honest UA `hivv-toolkit/1.0 (+https://hivv.org)` was already in safeFetch). **Flag flipped**: `ecosystem.config.js` default `'0'`→`'1'` (capability stays `ask` — loopback operator un-gated, everyone else grants), gateway restarted healthy; `hivv tools test`'s "NOT advertised" check became the invariant "advertisement matches its flag" (true in either configuration) and `test_toolkit::test_web_search_is_maybe_gated` became configuration-aware the same way. **Measured A/B through the bench** (`eval-suites/websearch.json` — an off-ramp prompt so absence is deterministic; new `hivv eval --model PIN` studies ONE brain via the router's preferredModel pin, unpinned runs carry no pin): flag OFF ×3 pinned gemma = **3/9 (33%)** (6× NO-SEARCH, wiki control passes from memory) → flag ON ×3 = **7/9 (77%)** (real BTC prices + real headlines; one off-ramp flake + one transient 503) — **+44 points**. Study findings: masjid's Qwen2.5-0.5B NEVER calls web_search even when advertised and system-prompted (advertisement ≠ adoption — a signal the route brain should learn), and the loopback-admin bypass works live through Caddy (gemma answered "130000.0" via chat with no policy entry). Tests: `api/tests/polite.test.js` (18, all offline via injected fetch/checkUrl: parser, agent-prefix matching, longest-match/tie/wildcard, cache, 404, robots-txt-always, broken-fetch-never-bricks, operator env off-switch, floor timing + host isolation, three toolkit wiring pins incl. "official APIs only") + `test_eval_harness.py` → 28 (the --model pin wire test). TESTMAP regenerated (56 tracked test files).

- [x] P2P by default: `hivv setup` writes the dial shim and migrates old configs — 2026-11-24: the ask was "naturally migrate people over to P2P — even if they are using hivv.org/v1 directly; hivv setup should do the dial shim mode by default, almost never direct requests; easy for users, easy for AI to test". **Endpoint decision** (`_p2p_endpoint`): an OpenCode config now gets `http://127.0.0.1:3911/v1` by default — `--write`/`--wire` START the shim first (systemd user unit `hivv-dial.service` with the agent's crash-loop bounds · LaunchAgent on macOS · detached spawn last resort; `Restart=always`, logs at `~/.local/share/hivv/dial.log`) and fall back to `https://hivv.org/v1` **with the reason in the `dial` JSON block** whenever it cannot run — a config is NEVER written against a dead localhost URL (a foreign app on the port is detected and named). Priority stays local-first: local model → local gateway (3011) → shim → hub; gateway/local URLs are never overridden. **Migration**: `_setup_write_config` moves any HIVV-OWNED baseURL (hub ↔ shim, BOTH directions so `dial off` can repoint cleanly) to whatever this run decided — backup first, `migrated_base_url` surfaced in JSON + human output; a user's own proxy URL is never touched (pinned by test). **Lifecycle**: `hivv dial [run|on|off|status]` — status probes with exit 0/1, `on` installs auto-start + clears the opt-out, `off` stops + disables + leaves `STATE_DIR/dial.off` (which setup respects) + prints the repoint command; healthz now returns `pid`; the bind error distinguishes "already running (pid)" from a foreign squatter. **Opt-outs**: `--no-shim` (setup + opencode), `HIVV_DIAL_OFF=1`, `dial off`. **Discovery**: `hivv update` prints a one-line nudge when a config still points at a hub endpoint — TTY-only (the 5-min auto-loop captures output and stays silent) and exception-guarded (a nudge must never break an update). **Correctness found on the way**: `_fwd_payload` rewrites `model` to the candidate's real name for DIRECT candidates (ollama 404s on `auto`, llama.cpp ignores the field — verified live both ways) while hub candidates keep the alias (the hub routes on it); `--dry-run` actually doesn't write anymore (it wrote); the `opencode` endpoint display read `base_url` where the key is `baseURL`. Config surfaces: `opencode-hivv.jsonc` + both SKILL.md carry one P2P note (byte-identical); root help lists the new verbs. **Live E2E**: `dial on` → unit paths correct → `P2P-OK` through `127.0.0.1:3911` in 264ms with `masjid … (direct) 256ms ok`. New `tests/test_dial_setup.py` (52: endpoint decision matrix, migration both directions + custom-URL immunity, probe ours/foreign/free, ensure/stop with the service installer monkeypatched away so tests NEVER touch systemd, service text pinned as pure strings, `_fwd_payload` purity, CLI exit codes + `setup --json` dial block + write/migrate/dry-run with HOME pointed at tmp dirs). TESTMAP regenerated. 845 mapped pytest green at the time (the one red was the concurrent toolkit session's live-gateway web-search gate — since fixed by them, config-aware); final gate `hivv verify` green (1146+ inner, incl. this file's 52). The full-suite order matters for env-leaking test modules: `test_cli_install`'s teardown unsets `HIVV_HUB` before this module's tests run, so `test_dial_setup` re-asserts its own env at module start (a concurrent session diagnosed and pinned exactly that).

- [x] Deeper telemetry + the task foundation + MCP/A2A interoperability — 2026-11-25: the ask was "performance monitoring, health/status/activity endpoints, we need deeper telemetry" + "foundational code for deeper DISTRIBUTED TASK EXECUTION including working with blnq.org" + "MCP interoperability and A2A interoperability in our API". Shipped FOUR foundations. **§telemetry** (`api/lib/telemetry.js`) — counters / histograms / gauges / **spans**; a span CARRIES A TRACE (a W3C `traceparent` is inherited at the edge, so a request that crossed a relay AND a peer hive reads as ONE story); the **label allow-list IS the privacy boundary** (unknown labels are dropped and counted, so a caller cannot start recording prompts as labels); percentiles are EXACT while a bounded reservoir holds every sample and bucket-estimated after (`exact: true|false` — buckets alone report a p50 of 78 for a series of 100 ms requests); a CLOSED error taxonomy (17 classes) so "which error is growing" is answerable by COUNTING, not by reading logs; SLOs + burn rate; **no data reports `null`, NEVER `0`**; Prometheus exposition at `/api/telemetry/metrics`; the router is instrumented (`hive.chat` → `bee.completion` with node / model / transport / tokens-per-sec). Live-verified: a caller's `traceparent` produced a two-hop waterfall. **§task-queue** (`api/lib/task-queue.js`) — ONE implementation of the nine things four job systems had each solved separately (pollable state machine · idempotency · priority + `not_before` · TTL · **leases**, so a bee that dies behind NAT loses nothing · retries with a cap · budget · cancellation · receipt). `failed` can be retried; `rejected` cannot (a peer at 0% allowance REJECTS work, it does not fail it). **Interruption is NOT failure**: the MAYBE verdict keeps the task ALIVE while a human decides → A2A renders `TASK_STATE_AUTH_REQUIRED`, never `FAILED`, with the exact `hivv approve` command. **§hive-clients** (`api/lib/hive-clients.js`) — one interface (probe / submit / status / cancel) over FIVE adapters: **blnq** (blnq.org's worker pool, worker-HMAC signed — the signing contract PINNED by a fixed test vector and by a test that reads blnq's own `workerAuth.js` when it is on this box, because the contract changes on BOTH sides or neither), **mcp**, **a2a**, **bridge** (open-hives/0.1), **local**; every adapter maps the remote's vocabulary onto OUR task states EXPLICITLY, never by guessing. **§outbound MCP** (`api/lib/mcp-client.js`) — HIVV was an MCP server and could not CALL one; now `initialize → notifications/initialized → tools/list | tools/call`, the server's protocol version wins, an SSE-framed answer is tolerated, SSRF-guarded / deadline-bounded / size-capped. **§outbound A2A** (`api/lib/a2a-client.js`) — both bindings (JSON-RPC first, REST second), the agent card from `/.well-known/agent-card.json` with the v0.2 path still accepted. **§A2A server** (`api/routes/a2a-routes.js`) — `POST /api/a2a` + the REST binding + the agent card at `/.well-known/agent-card.json` (STATIC on disk so Caddy serves it with no gateway involvement; **GENERATED** from the route by `scripts/gen-agent-card.js` so the two cannot drift); the policy gate is NOT bypassed (denied → `TASK_STATE_REJECTED`, MAYBE → `TASK_STATE_AUTH_REQUIRED`). **§the hive-to-hive door now exists** — `POST /api/bridge/requests` + the receipt endpoints; the manifest advertised them since day one while the routes DID NOT EXIST (a door painted on a wall). The **loop shield** is the strict part: our name in `X-Hive-Path` or `X-Hive-Origin` → 409 `loop_detected`; `X-Hive-Hops > 3` → 409; a seen `X-Hive-Request-Id` returns the SAME state and never executes twice. At 0% allowance the queue **HOLDS** the work (`held: true`) — it does not fail it. One reader loop rides the heartbeat timer; no new daemon. Migrations 028/029. Tests: `api/tests/telemetry.test.js` (26) + `task-queue.test.js` (23) + `interop.test.js` (24) + `tests/test_telemetry_tasks_a2a.py` (32). Verified live: an A2A `SendMessage` answered in 4.4 s, a peer submission answered with a receipt, the loop shield returned 409, a stale request id returned the SAME state without re-executing. Plan: `HIVV_TELEMETRY_TASKS_PLAN.md`. 213 node --test green

- [x] `hivv eval` — the study bench: golden questions × route modes, scored — 2026-11-24: the ask was "various tests that are helpful that we can study with the AI" — the hive had a dozen ways to be INVOKED but no repeatable way to be STUDIED. Shipped: `hivv eval run [--modes smart,fast,cheap,…] [--suite FILE] [--repeat N] [--timeout S] [--json] [--no-save] [--strict]` — runs a fixed suite across route modes (aliases expanded + deduped) via `POST /api/chat` (stream:false), scores each answer DETERMINISTICALLY (contains/not_contains/exact/regex/numeric-with-tolerance/json — deliberately NO model-as-judge in v1: a bench whose scores drift with the judge is not a bench), records the `X-Hivv-Answered-By` receipt + the answer (truncated) per case, prints per-case rows + a per-mode summary (pass rate, avg ms), and saves every run to `STATE_DIR/evals/<ts>-<suite>.json` so runs compare over time. `hivv eval cases` prints the suite; bare `hivv eval` is a chooser (the dispatch intercepts it — never the smart-default chat trap; unknown actions die LOUD). Builtin suite (6 forever-green cases): instruction canary, 17×23, 15% of 240, the bat-and-ball logic trap, JSON shape, tool-date (current_time). Suite files: JSON {name, cases:[{id, prompt, expect}]} with a clean die() on every malformation. `http()` gained an additive `with_headers=True` — response headers (the receipts) were unreachable before. First LIVE run already produced study signal: masjid/Qwen2.5-0.5B scored 3/6 (passed instruction/JSON/tool-use; failed percent — answered 0.36 — and the logic trap — answered 0.1). New `tests/test_eval_harness.py` (27: parser/dispatch, every scorer type pass+fail, suite-loader malformations, full-run with a faked transport incl. mode-alias expansion, JSON mode, HTTP-error rows, strict exit — it caught a real UnboundLocalError on the HTTP-error path). Wired into root help + per-command help; TESTMAP regenerated (50 test files — the map only counts git-TRACKED tests, so `git add` a new test file before regenerating). Full suite: 1064 passed — the only 2 reds belong to the concurrent telemetry session's `api/tests/telemetry.test.js:60` (a credential-shaped fixture tripped the pre-push scanner) + its verify cascade.

- [x] LLM install: flaky-clone resilience + root-vs-user targeting — 2026-11-24: `hivv install llm` on wahi printed the ENTIRE manual 6-step walkthrough it was supposedly running automatically, then died `git clone failed (rc=128)` ("RPC failed; curl 56 … early EOF") — a FULL clone of llama.cpp (169k objects, ~400 MB) with no retry, and the debris poisoned the next run ("already exists — skipping clone" → baffling cmake failure). **CLI** (`hivv-cli.py`): clone is now `git -c http.version=HTTP/1.1 clone --depth 1` (~60 MB — install-hivv.sh always did this, the CLI didn't) ×3 attempts with partial-tree cleanup between them, then a tarball fallback (curl/wget → codeload tar.gz → `shutil.move`), and the final `die` prints the manual command as the way forward; `_llama_tree_state()` classifies the path (missing/partial/source/built/occupied) — a foreign `~/llama.cpp` is NEVER deleted (move-aside instruction instead), an unwritable root-owned tree gets the exact `sudo chown -R $USER …` fix, and the manual walkthrough prints only WITHOUT `--auto`. **root vs user**: `_llm_target_home()` (SUDO_USER's home when euid==0; a real root login keeps /root) now derives `_LLAMA_CPP_DIR` + `_llm_which`; after a sudo build `_llm_hand_back()` chowns tree+models to the invoking user, `llm setup` says "via sudo — installing for <user>", the background llama-server spawns with `user=/group=` (a root-owned server is one the user can't stop), PATH advice names the TARGET user's rc (`_llm_rc_path`/`_llm_path_advice`, zsh/fish-aware, idempotent) instead of root's `~/.bashrc`, and `_llm_boot_enable` refuses under sudo with "run as <user>: hivv llm boot on" (root has no --user session). **installer** (`install-hivv.sh`): same SUDO_USER targeting (`LLAMA_HOME`/`LLAMA_USER` — `curl | sudo bash` used to build /root/llama.cpp invisible to the logged-in user), clone retry ×3 + partial cleanup, CMakeLists-as-truth source check (tarball trees count, not just `.git`), never-delete-foreign guard, `chown -R` hand-back (tree/model/rc), server started via `sudo -u $LLAMA_USER -H` with logs in the user's home. `tests/test_llm_build_tools.py` → 66 green (18 new: behavioral clone retry/cleanup with faked subprocess, occupied-dir protection, sudo-home resolution, rc advice, boot refusal, installer pins). TESTMAP regenerated (was stale from the bridge/dog/earth/music routes). 1012 pytest green

- [x] Full suite red: import-time env leakers + stale relay test — 2026-11-24: three full-suite runs died on the same 4–5 failures while the LLM work above was being verified. Root cause: `tests/test_cli_install.py` and `tests/test_upgrade_review.py` set `HIVV_HUB=http://127.0.0.1:1` (dead-port fast-fail) + `HIVV_STATE_DIR=<mkdtemp>` at IMPORT time and never restored them, so every later subprocess inherited them — `test_tools_test_cmd`'s `hivv tools test` saw an empty state dir → "tools server not installed" → downloaded from the dead port → "Connection refused" → 2 failures → `hivv verify` → `test_verify_drift` cascade. Fixed at BOTH ends: each leaker (`test_cli_install`, `test_upgrade_review`, `test_failure_diagnostics`, `test_nodes_offline`) captures the originals before assigning and restores them in a module-scoped autouse fixture (its own tests keep the poison — nothing changes during the module), and `test_tools_test_cmd` additionally pops `HIVV_STATE_DIR`/`HIVV_HUB` from the child env (belt). Also fixed the documented pre-existing `test_bee_chat` legacy-backstop failure: the committed alive-filter in `_relay_endpoints` (the 90s-TTL fix) made "all five legacy ports present on a LIVE box" impossible — the test now stubs the probes and pins BOTH branches (nothing alive → all five as backstop; 8090 alive → only survivors, dead legacy dropped). Full suite: **1012 passed, 0 failed**

- [x] One emergency command (rescue) + no-sudo-first advice + installer hands off properly — 2026-11-23: wahi proved the gap — a root-owned install + a user with NO sudo was stuck (update died on .bak Permission denied ×7; tools downloads too) and every hint LED WITH SUDO; after a SUCCESSFUL user-local reinstall the box was STILL stuck because (a) the shell kept resolving `hivv` to the old /usr/local copy (PATH order + bash hash) and (b) the installer's no-sudo auto-switch set `WITH_SERVICE=0`, deferring the agent handoff to a manual doctor --fix, so the old agent kept running the old code for 23h. Shipped: **`public_html/rescue`** — `curl -sSL hivv.org/rescue | bash`, one memorable line: detects the wall (install dir not writable by THIS user), repairs via installer `--mode=user` (sudo NEVER assumed), fixes THIS shell's PATH + `hash -r` (the stale-cache trap), `doctor --fix` repairs the agent unit, `systemctl --user restart` replaces the live old process (enable --now alone never restarts a running service), then VERIFIES and says "user-local — self-healing". Pipe-safe (no unguarded read), offline-testable (`HIVV_HUB` override in BOTH scripts), idempotent. **Tips/doctor now lead with it**: `USER_INSTALL_CMD` = the rescue line, the permission-denied tip says "you do NOT need sudo" first (sudo only after, labelled one-time — ordering pinned by test), and `hivv doctor` prints it PROACTIVELY when the client dir isn't writable (before the wall, not in a tip after). **Installer**: auto-switch now installs the service (WITH_SERVICE=1, matching its own user-mode rethink), restarts a RUNNING agent after rewriting the unit (was_active → restart, so the new code actually executes), and warns with the exact `export PATH=… && hash -r` fix when an older copy shadows the new one. New `tests/test_rescue.py` (10, incl. a fully-offline E2E: real rescue piped via curl file:// against a fixture hub, real 0555 wall, fake systemctl — proves wall→repair→PATH→restart→verify) + `tests/test_user_install_cmd.py` updated. TESTMAP regenerated. 951 pytest green

- [x] Upgrade failure forensics + signature dedup (anti-spam) — 2026-11-22: wahi's nine identical "Permission denied …/hivv-cli.py.bak" rows proved the report was too thin and too spammy. **CLI** now records structured diagnostics on every failed apply — `step` (sha256/backup/write/healthcheck/swap/guard, tracked through `_apply_update` via `_UPDATE_STEP`), `errno` + `error_class`, `target` + `install` (system/user/git/frozen), dir/file `owner:mode`, `euid`, `dir_writable`, `version_to`, OS/arch/Python, free disk, and the **fix tip** from `_HIVV_TIPS` (the incident now says how to fix itself) — plus a 16-hex `signature` that normalizes away paths/digits so the same wall hashes the same everywhere. Attached to `failed` reports only, via `_fail_update` (NOT `_fail` — the file already has three `_fail` pretty-printers, and the module-level `def _fail(s)` at ~11542 wins at call time; the test suite caught that `TypeError`). Auto/inbox failure reports now carry the review's votes/findings too (they were hardcoded `[]`, making every incident read as an unreviewed push). **Hub** (`honey-routes` + migration 021): `diagnostics` JSONB is whitelisted key-by-key (`DIAG_KEYS`, client JSON never lands raw), and `failed` reports collapse on `(node_id, signature)` within 24h — `attempts++` on ONE row, never a new one, with `last_seen` so the row floats to the top of `hivv upgrades`; the active incident gets its description bumped `(attempt N)` instead of stacking. Old CLIs that send no signature get one derived server-side (`failureSignature(reason)`) — verified live: wahi's 5-min auto-retry loop now collapses in production. Anti-spam bounds: per-IP `reportLimiter` (60/min, keyed on `req.ip` — the global limiter keys on a client-rotatable `x-visitor-id`), plus a daily insert cap (50 known / 10 unknown node-ids → 429), plus node-secret: WRONG `x-node-secret` → 403, MISSING → accepted on purpose (`sudo hivv update` runs with a different HOME and no state; rejecting absence would lose exactly the reports we want). `hivv upgrades` renders `×N` attempt badges + a failure-details block (step/errno/owner/writability/fix). New `tests/test_failure_diagnostics.py` (31, incl. a live gateway round-trip that collapses+cleans up); TESTMAP regenerated. 834 pytest + 131 node --test green

- [x] Never-again outage: fail-fast DB pool + health watchdog + offline `hivv nodes` — 2026-11-22: the hub's pg pool wedged at 00:00:38 (0 sockets to Postgres, waiters queued forever — no `connectionTimeoutMillis`, so EVERY DB-backed route hung *including `/api/health` itself*) and the site stayed down 10h because pm2 saw the process alive and nothing could tell "running" from "answering". Three layers now: **(1) gateway fail-fast** — pool gets `connectionTimeoutMillis` 10s + server-side `statement_timeout` 15s (env `DB_CONNECT_TIMEOUT`/`DB_STATEMENT_TIMEOUT`), and `/api/health` races its `SELECT 1` against a hard 3s deadline (unref'd timer) → a wedged pool is a fast 503, not an invisible hang; **(2) `scripts/health-watchdog.sh`** (cron `* * * * *`, state in `logs/`) probes health every minute, restarts `hivv-ai-gateway` via pm2 after 2 consecutive HTTP-000s, 10-min cooldown so a dead *Postgres* doesn't cause restart-thrash, one blip never restarts — careful: curl prints `000` from `-w` even on failure, so the fallback must be `|| code=000` (an `|| echo 000` makes `code="000\n000"` and a DEAD gateway reads as healthy — pinned by test); **(3) offline `hivv nodes`** — roster ladder hub → local gateway `127.0.0.1:3011` → on-disk snapshot (`$STATE_DIR/nodes-cache.json`, written on every successful fetch), snapshot statuses re-derived by a LIVE LAN probe via shared `_probe_targets()` (a cached "online" from yesterday is a lie; only UNPROBEABLE bees keep their cached status so firewalled/different-LAN peers don't all flip red), yellow banner says which columns are live vs snapshot, `--json` carries `_fallback`, no-snapshot failure tells you how to seed. Skips the local leg when `HIVV_HUB` is already localhost. New `tests/test_nodes_offline.py` (42); TESTMAP regenerated. 791 pytest green

- [x] Pocket panel + fleet update + private personas — 2026-11-19: **mobile**: new `POST /api/control/update-all` (shared `_updateEnvelope` hardening with push-update — hub-relative URL only, sha256 from the bytes THIS hub serves; `dry_run` plans without pushing; skips bees `getNodeStatus` calls offline — the first draft trusted the cached `node.status` and claimed to push to a bee that had been dead for a day) + `public_html/panel.html`, a mobile-first page (viewport, touch targets, safe-area insets) with: admin SESSION login (`requireControlAuth` already accepts an admin/owner cookie — a phone just logs in), hive pill, bee cards with update/restart/selftest (existing signed repair ops), pending policy approvals allow/deny, and **Update all** that requires a TAP-TO-CONFIRM preview which self-disarms after 8s (a stale confirm button in a pocket is a hazard). **personas**: named personalities in the chat settings — stored in `localStorage` ONLY (list never in any request body; only the ACTIVE prompt travels as the system message), because the hub stores no raw prompts at all (provenance = SHA-256 digests, usage_logs has no prompt column) — private from the admin and everyone else BY CONSTRUCTION. Seeded built-in `Noor (God-conscious)` persona (reverence for God/Allah, Islam's taqwa + Hinduism's dharma/bhakti, without rivalry) starts INACTIVE — public visitors keep the neutral default until they choose; one tap activates it per-browser. Active persona wins over the System Prompt box (one source of truth); editing the box while a persona is active edits that persona. New `tests/test_personas.py` (12) + `tests/test_panel_update.py` (10, live-gateway with skip-if-down) + `tests/test_ask_flags.py` (15); TESTMAP regenerated. 691 pytest green

- [x] All nodes working: binds, boot units, honest test semantics — 2026-11-19: `hivv test` on yalla reported `yalla: 0/1 ports` + `yalla: ✗ chat failed` **while run ON yalla**, seconds after llm-core proved 8080 answers — the network/chat sections probed SELF via the LAN IP, so a localhost-bound LLM looked broken (it wasn't; it just wasn't SHARED). Fixed: self-probes use loopback and print `via localhost`; self gets a separate `up on localhost — NOT shared (binds 127.0.0.1)` line pointing at `doctor --fix`; peer refusals say the likely cause; the chat test falls back to the **relay** (hub → bee's inbox → its own agent → 127.0.0.1 — the `hivv ask` path), so a localhost-bound bee reports `✓ chat works (via relay — not directly borrowable)` instead of a false ✗. Also found: **`doctor --fix` never fixed binds** — it printed suggestions (computed `fixed` cmdline, never used it) while its own advice line said "run hivv doctor --fix"; new `_fix_llm_bind()` patches `--host 127.0.0.1` → `0.0.0.0` in user llama units (daemon-reload, restart only if active — `_harden_unit_file` contract) and `hivv doctor --fix` on ashy fixed the box live. `_llm_boot_probe` now recognizes the per-model `llama-*.service` scheme (yalla had llama-gemma + llama-qwen BOTH enabled and was told "no boot unit" — detection bug). Real crash found by using it: `_llm_boot_enable` called `_systemctl("--user", "daemon-reload")` against the 3-arg signature → TypeError **after** writing the unit: it started but was never ENABLED (silent LLM loss on reboot); `unit` is now optional. Ops: ashy bind fixed via our own `doctor --fix`; yalla migrated (manual localhost squatter killed, keyed llama-gemma/qwen disabled — the hive can't use `--api-key-file` servers, canonical `llama.service` enabled on 0.0.0.0 keyless → hub shows yalla unlocked). Result: **all three live nodes green in `hivv test`** — masjid/yalla/ashy reachable + chat everywhere. 664 pytest green

- [x] `hivv ask`/`talk` = one word to ONE bee · honest relay fallback — 2026-11-19: `node-chat` was the only hyphenated chat verb, and `hivv node chat <bee> <msg>` died with `node 'chat yalla whas up' not found` because `node`'s `nargs='+'` swallowed the WHOLE tail as the node name. Fixed: new one-word verbs `hivv ask <bee> <msg>` + `hivv talk <bee> <msg>` (`node-chat` kept as alias; `hivv chat <msg>` still = the HIVE, bare smart-default still hive-routes); `cmd_node` now detects a chat verb in its own args and delegates to `cmd_node_chat` instead of matching it as a name; `_find_node()` shared by the chat path (exact id/name → substring, empty string never matches everything). **The fallback lied**: it POSTed `/api/chat {provider: <bee-name>}`, but the router matches `provider` against endpoint names like `ashy:8090`, never `ashy` — no match → routed to whichever bee was free and printed that answer as the named bee, and the `if code == 200` branch had NO else, so a hub 503 printed NOTHING. Now it falls back to the **hub relay pinned to that node_id** (`/api/relay/jobs`) — the only path that reaches a model bound to `127.0.0.1` (ashy's llama on :8090 refuses every LAN connection, so direct can never work; the bee's own agent answers on localhost) — then exits 1 with `hivv reach`/`hivv llm status`/`hivv chat` hints instead of silence. `_RELAY_LOCAL_ENDPOINTS` was hardcoded `[8080,11434,1234,8081]` — **8090 missing**, so every relay job to ashy died with "no local model answered"; new `_relay_endpoints()` puts DETECTED/alive ports first (`_llm_alive_port` skips the web app squatting ashy's :8080), legacy list as backstop, deduped by canonicalised host:port so `127.0.0.1:8090` and `localhost:8090` aren't tried twice. Also: direct path TCP-preflights ports first (no more `chatting with X (:8090)` banner over a refused port), asking your OWN bee swaps to `127.0.0.1`, and `die()`'s support footer now uses the first line only (multi-line usage used to spill its own newlines into it). Docs updated (AGENTS.md, both SKILL.md, index.html, root help, `_print_sub_help`); new `tests/test_bee_chat.py` (26 tests); 618 pytest green
- [x] LLM flow = install → run → ASK about boot; serve never double-binds; doctor survives its own report — 2026-11-19: `hivv llm setup`'s final hint ("foreground: hivv llm serve-llama") sent people into llama-server's raw `couldn't bind ... port: 8080` (the background server it had JUST started held the port) and "start on boot: hivv doctor --fix" was a lie — doctor only fixes the AGENT's unit. Fixed: `serve-llama` pre-flights the port (already-serving → friendly exit 0 · llama mid-load named by pid · foreign squatter → "already in use", never spawn); `llm setup` ASKS "start <model> on boot? [Y/n]" after going live (default yes, `--yes` answers, non-TTY skips with the exact command) and installs a systemd USER unit `llama.service` (enable WITHOUT `--now` — one owner of the port; `Restart=always` + `StartLimit 3/300s`; refuses to touch a system-scope unit); new standalone `hivv llm boot [on|off|status]` (mirrors `hivv boot`; `off` never kills the running server); `hivv doctor` reports `llm boot:` status and `--fix` now creates the LLM's unit too. Sequel crash fixed: `hivv doctor` died with `UnboundLocalError: 'platform'` — cmd_doctor re-imported `platform` LATER in the function (firewall section) making it function-local for the whole body, so the earlier `platform.system()` use crashed; module-level import stands, guarded by a new whole-file AST test (use-before-local-binding of module names) in `tests/test_cli_install.py` + `TestLlmBootFlow` (7 tests); 618 pytest green
- [x] `hivv` command on PATH + update-never-touches-source — 2026-11-18: after `./setup.sh` the CLI existed in the clone but NOT on PATH, so `hivv chat` said "command not found" while the script's own next-step text said "hivv chat"; `hivv update` from a clone silently replaced the repo's own `public_html/hivv-cli.py` with the hub's copy (dirty `git status`). Fixed: `d_install_cli`/`d_ensure_path` install the contract layout `<prefix>/bin/hivv` + `<prefix>/lib/hivv/hivv-cli.py` from all three setup scripts (bash ×2 + PowerShell); `_in_git_worktree`/`_update_target` make an update REFUSE a source file (`--force` overrides, an identical file still updates); 3 latent UnboundLocalErrors fixed (`cmd_doctor` tempfile — `hivv doctor --fix` always crashed without ollama; `_do_chat` urllib — the hub-fallback path crashed; `cmd_call` urllib — the hive-routing path crashed) + a scope-aware AST audit that pins the whole bug class; new `tests/test_cli_install.py` (18 tests); 381 pytest green
- [x] Crash-loop bounds + VRAM gate + unit-aware LLM start — 2026-11-18: `StartLimit 3/300s` on every agent/llama unit template (installer heredocs ×2 + CLI templates ×3); `_self_repair` → `_harden_unit_file` patches OLD units fleet-wide (remote correction — additive lines + daemon-reload only, `sudo -n` never prompts); `reset-failed` before start/restart so a tripped limit is recoverable; `_llm_vram_gate` refuses doomed llama spawns (card full · stray server owns a tight card → `HIVV_LLM_FORCE_START=1` override) and warns on thin headroom; `_llm_start_component` now revives systemd units instead of orphan-spawning beside them; `_service_state` probes `LoadState` (is-active exits 3 for both inactive and not-found — a phantom unit used to shadow the real one)
- [x] Speed ledger + macOS parity + chat fail-fast + LLM one-shot — 2026-11-18: request provenance wired into `/api/chat` (both branches) + `/v1` streaming with a real SSE **TTFB hook** (first content-bearing frame) + `hivv speeds` command; Darwin metric collectors (`sysctl`/`vm_stat`/`kern.boottime`/`system_profiler`) + loadavg-derived `cpu_percent` (was 0 for EVERY bee); `hivv nodes` auto-measures missing pings (TCP preflight to tools/model ports, seeds the hub cache); name/CPU column widths (16/22); 160 pytest green
- [x] Chat >60s fix — 2026-11-18: direct-node loop now TCP-preflights each candidate (≤0.8s vs 3s+15s socket timeouts on dead bees) and skips recently-failed nodes for 120s (falls to the fast hub path instead of burning the shuffle); plus `hivv llm setup` one-shot (build→download→serve) + `hivv install llm` alias (was: smart-default chat trap!) + every llm step prints its NEXT command + `pull-gguf` uses wget→**curl fallback** with resume + GGUF-magic check (macOS has no wget — FileNotFoundError crash)
- [x] Upgrade-review regression suite + self-trip defuse + emergency network update — 2026-11-14 (`tests/test_upgrade_review.py` 97 tests incl. shipped-file canaries; `scripts/emergency-update.py` signed force-push; defused docstring/print-hint wording, `line_no` off-by-one fix, bytes-literal blanking, `socket.socket…connect` pattern fix, `opencode.ai` allowlist)
- [x] `hivv models --bees` + models-by-bee section in `hivv nodes` — 2026-11-14 (`_bee_model_summary`)
- [x] Remote LLM visibility fixes — 2026-11-14: `_detect_local_ai` probes 8090/1234 (same ports as brain discovery — ashy's llama on 8090 was invisible), reports keyed llama.cpp servers as `locked (api-key required)` instead of hiding them (yalla's `--api-key` made both servers show 0), router skips `m.locked` endpoints (peers can't auth either), by-bee section prints explicit `(no local models reported)` for online bees with empty heartbeats
- [x] Auto-incident for keyed LLMs — 2026-11-14: the 60s health sweep files ONE `config_error` incident per bee reporting `local_models[].locked` (`api/lib/locked-llm.js` + `api/tests/locked-llm.test.js`, 11 tests) with the exact on-box commands to confirm/remove `--api-key`, and auto-resolves when the key is gone

- [x] Capability layer + routing modes + YES/MAYBE/NO policy engine — shipped 2026-09-27 (`api/lib/capabilities.js`, `api/lib/policy.js`, migration 008, CLI cap/policy/approve/deny/route, dashboard 🧬/⚖️)
- [x] Live animated Command Center — shipped 2026-09-28 (`command-center.html` + `GET /api/hive/timeline`)
- [x] Advanced Chat UI — shipped 2026-09-28 (`chat/index.html` + `chat/styles.css` + `chat/app.js`)
- [x] Inbox PUSH for approvals + owner-targeting — shipped 2026-09-28 (`x-hivv-node` header, `policy.setNotifier()`, targeted vs broadcast push)
- [x] coding.execute sandbox — shipped 2026-09-28 (`api/lib/sandbox.js`, docker/bwrap, `hivv exec`)
- [x] Status page accuracy — servedModel tracking, server-side 5m latency, real models, nav styling
- [x] Database browser — whitelist-based public table viewer (`api/routes/database-routes.js`)
- [x] Honey goal C9 — independent weekly reset, title rotation
- [x] LLM-reviewed upgrades (hive votes on every CLI update) — shipped 2026-11-14: `_review_update`/`_upgrade_review_gate` in `hivv-cli.py` (static danger-pattern scan of added diff lines → local LLM vote → hive fan-out vote → thin-suspicion confirmation round), blocked/suspicious/failed → `POST /api/hive/upgrade-reports` → `hivv_upgrade_reviews` table (migration 017) + `upgrade_suspicious`/`upgrade_failed` incidents; wired into `hivv upgrade` (manual), the 5-min auto-update loop, and inbox `update_available` pushes; per-sha verdict cache (24h) + report-once dedup (hub-side); `hivv upgrades` command; stale output-capturing launchers self-heal (`_refresh_wrapper_if_stale`) so block messages aren't swallowed
- [x] CPU/GPU display in `hivv nodes` — shipped 2026-11-14: `_short_cpu` (`i7-10700 @2.9G` instead of truncated vendor string; ARM/macOS/Windows `_cpu_model` fallbacks; `cpu_freq_mhz` actually collected in heartbeat + forwarded by hub), `_short_gpu` (`RTX 3050 3/6GB 0%` instead of `NVIDIA GeForce`), humanized stale heartbeat ages (`68m ago`/`45d ago`)
- [x] OpenCode integration A–D — shipped 2026-11-14 (`HIVV_OPENCODE_PLAN.md`): provider config + gateway conformance fixes (tools/tool_choice everywhere, Bearer auth, tool-capable routing, model aliases), MCP server at `/mcp` (6 tools), skills at `.well-known/skills/`, coder bees (`hivv code` → inbox → `opencode run --standalone` → patch back, proven end-to-end with a real patch); plus 3 latent SSE bugs fixed (event separators, line buffering, missing `[DONE]`) that affected every strict OpenAI client. Still open per plan: route-brain `p_wise` calibration (HIVV_ROUTING_PLAN.md), `X-Hivv-Route` receipts
- [ ] Audit table pruning with signed monthly snapshots (F5)
- [ ] Delegation chain enforcement (F1)
- [ ] Add Redis for session/scalability
- [ ] Add integration tests
- [ ] Add password reset flow
- [ ] Add WebSocket for real-time dashboard updates
- [ ] Ship `hivv` binaries via `.github/workflows/build-cli-binaries.yml` (needs first tag + code signing)
- [ ] Merge winget + homebrew manifests in `packaging/` (fill sha256s after first release)


## Hive-to-Hive Bridge (open-hives/0.1)

Shipped 2026-11-23 — first peer hive: **kwaai** (KwaaiNet). Spec: `/HIVE-TO-HIVE`,
simple explanation: `/bridge.html` (+ `/bridge.txt` for agents).

**Files:** `api/routes/bridge-routes.js` (load · allowance · peers · problems ·
bridges), `api/migrations/023_bridges.sql`, discovery files
`public_html/.bridge/hivv.json` = `.well-known/hivv.json` (+ legacy `hive.json`),
pages `{bridge.html, bridge.txt, connect.html, watch.html, map/, live/, logs/, bugs/}`,
ops `scripts/{bridge-canary.py, bridge-bench.sh, secretz-hivv.sh}`,
tests `tests/test_bridge.py`.

**Rules the bridge keeps:**
- any node may propose a bridge — `POST /api/bridge/bridges` **always attempts**,
  records every outcome, and failures go public (`/api/bridge/problems` → `/bugs/`)
- `scope: local` stays private to the requester; only `scope: hive` is listed
- discovery: `/.bridge/hivv.json` first, then `/.well-known/*`, then an optional
  git-hosted `manifest_url` (for hives whose web host can't serve well-known files —
  kwaai.ai is Google Sites)
- fetches are SSRF-guarded (`lib/ssrf.safeFetch`), 5s deadlines, never hang
- dynamic allowance 0–85% tiered on the 5-minute latency window; 0% when busy

**Ops:** hourly canary (cron `:07`, read-only) → `logs/bridge-canary.jsonl` +
`public_html/bridge-status.json`; gateway re-verifies all bridges every 10 min;
benchmark: `scripts/bridge-bench.sh N` (N ≤ 20, serial, 10s apart).

**Tests:** `python3 -m pytest tests/test_bridge.py -q` (12) · TESTMAP regenerated ·
audit: no `/api/bridge/*` route remains in the HIVV-API-002 missing list.
Pre-existing failures (proven at pristine HEAD, unrelated): `test_bee_chat`
(8080/8090 backstop), `test_verify_drift` cascade.

### Git identity for cross-hive work

Commits this hive makes in OTHER repositories (KwaaiNet, blnq, …) are
authored as **`hivv.org <bridge@hivv.org>`** and carry the trailer
**`Hive: hivv.org`** in the message — the naming law ("a hive is named by
its own domain") applied to git, so cross-hive contributions are auditable
by construction: `git log --grep "Hive: hivv.org"`. History is never
rewritten to retrofit this; the standard starts with the commit that
records it.

