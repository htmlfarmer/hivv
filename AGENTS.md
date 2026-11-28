# AGENTS.md — AI Guide for HIVV

This file helps AI agents quickly understand the HIVV codebase.
Last updated: 2026-11-28

> **Pronunciation:** HIVV is pronounced **HIVE** (like a beehive — /haɪv/), not like the HIV virus.

> **Brand:** HIVV is *a distributed AI network — at home and around the world*.

> **Active to-do list: see [`HIVV_BACKLOG.md`](HIVV_BACKLOG.md)** — release/signing steps for CLI
> binaries, relay rate-limiting, honey v2 extras, tech debt. Plan context: [`HIVV_PLAN.md`](HIVV_PLAN.md).

## Start here — the 60-second version

**Ship like this:** branch → push → `scripts/deploy.sh`. The pytest gate and
**the automatic rollback live inside the deploy** — they are not your job to
re-run first (rule 6 in [Repository topology](#repository-topology--one-code-repo-2026-11-25)).

```bash
hivv tests-for --diff        # which tests YOUR changed files need — ~90s instead of the full suite
python3 -m pytest tests/ -q  # the full gate (no network, no $HOME writes)
scripts/deploy.sh --dry-run  # what would land, change nothing
scripts/deploy.sh            # land it: rails → merge → restart → health → gate → rollback
```

**Never:** commit to `main` from a session · push to `hivv.org` (it is
generated) · share a working tree (`git worktree add ../hivv-<topic> -b
<topic>`) · delete another session's uncommitted work (copy it somewhere
byte-identical first) · commit a secret.

**When you are stuck:** `hivv help <thing>` is fuzzy search · `hivv doctor`
reports the box · `hivv fallback` works with NO network ·
[`docs/SHIPPED.md`](docs/SHIPPED.md) records how the last 53 features were
built — the "why" behind code that looks odd.

**Voice:** this hive talks like a hive. Bees, honey, ranks from larva to
queen-bee, waggle dances. Ship with personality — the fun commands are real
(`hivv hi`, `hivv iq`, `hivv welcome`, `hivv share`).

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
│   ├── install-tailscale.sh # 3-tier Tailscale installer (official → apt → static)
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
│   ├── PARTNER-API.md     # the public /api/partner surface
│   └── SHIPPED.md         # the log of every feature that has landed
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

### The clock and the place — timezones that do not lie (2026-11-28)

A bug report, fixed end to end:

> `$ hivv what time is it now in jinja uganda` → *"The current time in Uganda is
> 2026-11-28 07:08:13 UTC."* Uganda is UTC+03:00. **Three hours wrong, and it
> looked authoritative.**

**Three faults lined up:**

1. **`current_time` answered in UTC and said `ok: true`.**
   `current_time({timezone:"Uganda"})` returned `ok:true` with UTC and a
   `timezone_valid:false` buried in the JSON — a model reads `ok`, takes the
   human-readable time, and stamps it with the place the user named. **A tool
   that cannot do what it was asked must SAY SO:** silent degradation is a lie
   with a green receipt.
2. **Nothing could turn a place into a zone.** The model had to know
   `Jinja, Uganda → Africa/Kampala` itself. It got `karachi` right and
   `jinja` wrong, so it passed *no* timezone at all → UTC → mislabelled.
3. **The CLI's direct-to-bee path sends NO system message at all** — no
   identity message, no briefing, no clock. `hivv …` goes direct whenever a
   bee is reachable, so it never saw any of the hub's prompt.

**The fix — one resolver, three surfaces:**

- **`scripts/gen-place-tz.py` → `api/lib/place-tz-data.js`** — 247 countries
  and 418 zones, GENERATED from the system's canonical tzdata (`zone.tab` +
  `iso3166.tab`), never hand-typed: 249 countries hand-written is exactly how
  Uganda ends up in the wrong hemisphere. 31 countries span several zones (the
  US has 29), so a bare country always NAMES the zone it used. `--check` fails
  if the committed file drifts. The output is deterministic (no timestamps),
  and the file carries `/* eslint-disable */` because reformatting it only
  fights the generator.
- **`api/lib/place-tz.js`** — the resolver. Specificity order: explicit zone →
  city → country. A phrase sitting inside a longer one never wins on its own
  (`st petersburg` is Russia, not America/Indiana/Petersburg); the
  DESTINATION of "from london to paris" wins; two-letter aliases only count as
  acronyms, so "tell us the time" is not a question about America; and the
  curated city table carries **Jinja**, which has no zone of its own and is
  therefore the case that used to fall through to nothing.
- **`api/server.js` — the MEASURED CLOCK.** For time questions ONLY, the hub
  states the measured UTC *and* the resolved local time, then tells the model
  to copy the zone **verbatim** rather than construct one (showing it an
  example zone instead invited it to pattern-match one — a question about
  Uganda came back citing "Africa/Juno"). It returns `[]` for everything else
  on purpose: a system message that changes every second rewrites the prompt
  prefix and throws away the prefix cache (a warm run reports ~2,560 cached
  tokens).
- **`api/lib/toolkit.js`** — `current_time` / `timezone_convert` now ACCEPT
  place names (`Uganda`, `Jinja`) and REFUSE an unlocatable one instead of
  degrading to UTC. `datetime:"now"` is **honoured** — the intent is
  unambiguous, and that refusal is what made a model apologise, invent a
  reason, and answer from memory. Everything else still gets a repair
  instruction (`OMIT the datetime … ISO-8601 like 2026-11-28T07:00:00Z`).
  **`from_timezone` is non-fatal**: a bad optional argument must not be able
  to destroy the answer that was actually asked for — observed live, a model
  passed `from_timezone:"now"`, the whole call failed, and it then invented a
  time for London. The target zone is still delivered, with
  `from_timezone_error` reporting the bad argument.
- **`public_html/hivv-cli.py`** — the direct path now sends what the hub
  sends: the **toolkit briefing** plus the clock line from
  `POST /api/tools/time-context`, ONCE per attempt rather than per port.
  The briefing comes from the catalog the CLI ALREADY fetches, so no new
  dependency. It matters: schemas with no instruction about when to use them
  is how a time question ended up calling a tool with a zone it had made up
  — a controlled A/B against one bee gave *correct* with briefing+clock and
  *nothing usable* with the clock alone. The briefing is dropped again if the
  context pre-flight drops the tools (never instruct a model to use what it
  was not given). The message text is only sent when the question ALREADY
  looks about time — ordinary chat must not start shipping its text down a
  path meant to bypass the hub — and a locally measured UTC line covers the
  hub being unreachable.
- **`public_html/hivv-tools.py`** — the bee's own tool server resolves places
  by asking the hub (`_as_zone` → `hub_call`), never returns UTC with an
  `error` key tucked beside it, and stops shipping `ok:true` with a nested
  `error`.

`GET /api/tools/catalog` also carries the **`briefing`** now, so a client
with no hub prompt of its own can ask for one instead of improvising.

**Tests:** `api/tests/place-tz.test.js` (25) — the reported bug resolves to
Africa/Kampala, no false positives ("tell us the time", "what time does the
center open"), containment / destination / acronym rules, the clock line's
measured values, **the silent-UTC regression**, `datetime:"now"`, the server
wiring at all four message-list sites, and the generator drift check (skipped
where tzdata is absent). The full-set briefing stays **byte-identical** — the
clock is a separate message, pinned by `tool-profiles.test.js`.

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
6. **Merge early; do not pre-verify the gate.** A session that has a clean
   `git merge --check` and one green run should push and let `deploy.sh` do
   the rest — its pytest gate and automatic rollback ARE the guard, so
   pre-running the suite repeatedly just duplicates a check that runs
   anyway. Measured cost of ignoring this (2026-11-28): a conflict-free
   merge was proven at 00:50, then six more full-suite runs (~7 min each),
   two backup rebuilds and four file-stability sample rounds passed before
   anything shipped — over-verification, not caution. **The two checks worth
   keeping** are the only ones that guard against something irreversible:
   *(a)* copy another session's uncommitted work somewhere byte-identical
   before touching it, and *(b)* one green run before the merge. After that,
   recover instead of re-confirming — `git reflog`, `reset --hard`, and a
   worktree undo almost everything this repo can get wrong. Reserve a pause
   for what git cannot undo: deleting uncommitted work, or force-pushing
   over someone else's branch. **When a human is present and says go, treat
   "minimal problems, we can recover" as the licence it is** — merge, push,
   test, report. Ask once, not five times.

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
6. **`deploy.sh` WARNS on a migration failure instead of failing** — and a lib's `ensureSchema()` can create the table itself, so the migration's `CREATE TABLE IF NOT EXISTS` becomes a no-op while its `CREATE INDEX` and `INSERT` never run. Found live 2026-11-27: `034_hivv_proposals` had never been applied — `hivv_proposals` existed with 60 rows (self-created by `proposalLib.ensureSchema()`) but was missing 034's three indexes and the `source.modify` capability, while 035's indexes WERE present. The gate degraded *safely* (`caps.resolve()` returns null → tier `side-effect` → verdict `ask`, so it still asked), but the capability was invisible in `hivv cap list` and the rule read `default:unknown`. Applied by hand, idempotently: `source.modify` is now `ask (side-effect)`, all seven indexes present. **The fix belongs in `scripts/deploy.sh` — a PROTECTED path, so it is flagged here rather than changed unilaterally**: a migration that exits non-zero must abort the deploy, not warn. Until then, after any deploy that adds a migration, check `pg_indexes` and `hivv_capabilities`.

## What's Next

The **open** queue — what has not landed yet. The 53 features that
*have* shipped now live in [`docs/SHIPPED.md`](docs/SHIPPED.md); this
section was 100 KB of changelog and is now just the work ahead.

- [ ] Audit table pruning with signed monthly snapshots (F5)
- [ ] Delegation chain enforcement (F1)
- [ ] `deploy.sh` must FAIL on a migration error, not warn (see Known Issues 6)
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

