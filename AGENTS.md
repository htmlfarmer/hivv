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
  tokens per request.
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
- `hivv ask <name> "msg"` — chat with ONE bee (pins it; direct → hub relay). Aliases: `talk`, `node-chat`
- `hivv completions "msg"` — OpenAI-compatible completions endpoint
- `hivv add <provider> <key>` — add any AI to the network
- `hivv volunteer [on|off|status]` — opt in/out of contributing compute
- `hivv setup [--write [PATH]] [--global] [--json]` — detect local LLM + opencode/VS Code, print (or merge-write with backup) the OpenCode provider config, VS Code extension steps, and hive verify commands
- `hivv code "<task>" --repo <git-url> [--ref BR] [--timeout S] [--wait] [--json]` — dispatch a coding job to a coder bee (node runs OpenCode headless in a temp worktree, returns patch + summary)

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

- [x] Install LLM on a password-sudo desktop: the escalation ladder (all 3 surfaces) — 2026-11-24: the ask: `hivv install llm` printed "→ installing build tools…" and then "✗ missing build tool(s)" — the claim and the attempt disagreed. **Root cause (all three spots)**: the privileged runner was gated behind `sudo -n`; on a normal desktop sudo needs a password, so -n failed and the package install was SKIPPED silently — same pattern in `public_html/hivv-cli.py` (`_build_tool_run_privileged`), `public_html/install-hivv.sh` (`_can_sudo` gate in `ensure_build_tools`), `scripts/lib/deps.sh` (`d_run_privileged`; `d_can_prompt_sudo` existed but was never called). **The ladder** — decided BEFORE printing "installing…" so claim and attempt can never disagree: root/brew → plain · passwordless sudo → `sudo -n` · a human at a TTY → plain `sudo` (it asks THEM) · nobody watching → never prompt, print the exact command. **Empirically verified** (two pty experiments): sudo's password prompt AND its "Sorry, try again." retry both go to `/dev/tty`, not stdout/stderr — so redirection cannot hide them, and with no TTY sudo fails fast instead of hanging (that is what justifies prompting inside redirected shell calls). **Unattended = never prompt**: Python gate `_can_prompt_sudo()` (stdin TTY + `CI` + `HIVV_NO_SUDO_PROMPT` + `PYTEST_CURRENT_TEST`), shell gate `d_can_prompt_sudo()` (stdin TTY + same env guards — wired into `d_run_privileged` at last), installer gate on stdout (`-t 1`, because stdin is the `curl | bash` pipe); `brew` un-gated from sudo; prompt mode prints " — sudo will ask for your password". `PYTEST_CURRENT_TEST` matters: the suite drives this code, so `pytest -s` cannot hang it. Tests: `tests/test_llm_build_tools.py` +7 (`TestSudoEscalationLadder` — mode matrix, runner honours the mode, "no claim without an attempt", prompt-mode note, env guards, installer + deps wiring) · `tests/test_setup_scripts.py` +1 (bare sudo only behind the gate) · `tests/test_setup_prompts.py` (pty harness forces `HIVV_NO_SUDO_PROMPT=1` — the pty makes stdin a TTY, which would otherwise unlock the prompt branch with nobody to type). Full suite **1153 passed, 0 failed** · TESTMAP fresh (no new test files) · no commits made.

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

