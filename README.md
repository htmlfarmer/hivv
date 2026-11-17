# HIVV — A Distributed AI Network (at home and around the world)

> **Pronunciation:** HIVV is pronounced **HIVE** (like a beehive — /haɪv/), not like the HIV virus.

> Open weights · open models · open source · helping solve Earth's hardest problems together

## What is HIVV?

HIVV is a **distributed AI network**. Your computer joins a hive of CPU/GPU
power — local models at home, peers around the world. The hub is a phone book,
not a bottleneck: if hivv.org disappears tomorrow, your machine keeps working.

- **Local-first** — a `git clone` runs with no database, no internet, no setup
- **Open weights, open models** — no big-tech lock-in
- **Your data stays local** — nodes talk directly, the hub is just a phone book
- **Anyone can join** — one command install, automatic registration
- **Anyone can add AI** — cloud or local, just add your key
- **Provable reviews** — signed, offline-verifiable safety reviews of source code

## Two ways to install

### 1. Clone it (full control, local-first)

```bash
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
./scripts/setup-local.sh
```

Windows (PowerShell):

```powershell
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
.\scripts\setup-local.ps1
```

That gives you a complete gateway on `http://127.0.0.1:3011`:

- **no PostgreSQL** — the database is optional, not required
- **no internet** — your local models are discovered automatically
- **no secrets** — the session key is generated and stored locally
- **no cloud** — nothing phones home unless you ask it to

Add `--join-hive` (or `-JoinHive`) to also register with the global hive.

Check it without changing anything:

```bash
./scripts/setup-local.sh --check
```

### 2. Install the node (join the hive)

#### Linux · macOS · WSL

```bash
# One line — installs the CLI, sets up your node
curl -sSL https://hivv.org/install-hivv.sh | bash

# Or risk-free, user-local only (no sudo, nothing outside your HOME):
curl -sSL https://hivv.org/install-hivv.sh | bash -s -- --prefix=$HOME/.local

# Or peek first with a dry-run pre-flight check (changes nothing):
curl -sSL https://hivv.org/install-hivv.sh | bash -s -- --experiment
```

#### Windows (10 / 11)

```powershell
# PowerShell 5+ ships with Windows. Python 3 required (winget install Python.Python.3.12)
iwr -useb https://hivv.org/install-hivv.ps1 | iex
```

The PowerShell installer downloads the CLI, adds it to your PATH, and offers to
start your node automatically at every logon (Task Scheduler). Prefer Linux
tools? `wsl --install` and use the one-liner above inside WSL — it works there.

### Then (any OS)

```bash
hivv start                     # go live — your computer joins the hive 🐝
hivv up                        # 3-line status check
hivv hi                        # say hello to the network
hivv chat "hello world"        # talk to the distributed AI
hivv bees                      # see the other bees in the hive
hivv welcome                   # full guided tour
```

## Build on HIVV (the integration surface)

Every partner-facing endpoint lives under one stable prefix, `/api/partner`:

| Endpoint | What it does |
|---|---|
| `GET /api/partner/manifest` | Machine-readable description of this instance |
| `GET /api/partner/health` | Liveness, local models, hive status — works with no DB |
| `GET /api/partner/models` | Models this instance can serve right now |
| `GET /api/partner/capabilities` | Capability registry |
| `GET /api/partner/network` | The live hive roster |
| `POST /api/partner/fast-scan` | **Free, deterministic, AI-free** source screen |
| `POST /api/partner/review` | Signed safety review (uses a model) |
| `POST /api/partner/verify` | Verify a signed attestation |
| `GET /api/partner/attestation/key` | This instance's verification public key |

Plus the OpenAI-compatible surface at `/v1` and an MCP server at `/mcp`.

```bash
# Free deterministic screen — no AI, no cost, reproducible
curl -s localhost:3011/api/partner/fast-scan \
  -H 'content-type: application/json' \
  -d '{"language":"python","code":"import os\nos.system(\"echo hi\")\n"}'
```

```bash
# Use it like OpenAI
curl -s localhost:3011/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

The fast-scan is deliberately **fail-closed**: it can make a verdict worse,
never better. A `safe` result means "no hard-danger signal found", not "this
code is safe" — that is what the signed review is for.

## What Happens During Install

| Step | What it does |
|------|--------------|
| Preflight | Checks Python 3.8+, a downloader, hub reachability — `--experiment` stops here (dry run) |
| Download | Fetches `hivv-cli.py` (the client) + a tiny launcher (`hivv` / `hivv.cmd`) — self-verifies it's not an error page |
| Location | System-wide with sudo (`/usr/local`), or user-local (`~/.local`) — both are supported, user-local is fine |
| Autostart | Linux: systemd service · macOS: LaunchAgent · Windows: logon task · all opt-out with `--no-service` / `-NoService` |
| Optional LLM | `--with-llm` installs llama.cpp (or points you at ollama) + a model sized for your hardware |
| Network | Offers Tailscale so nodes on different networks can find each other safely |
| Verify | Confirms the hub is reachable and your node can register |

Nothing phones home beyond hub registration; your data stays between nodes.
Uninstall cleanly: `curl -sSL https://hivv.org/install-hivv.sh | bash -s -- --uninstall`
(Windows: `-Uninstall` flag) — keeps your config + history in `~/.config/hivv`.

## How to Work with HIVV (the mental model)

1. **The hub is a phone book.** hivv.org only tracks who's online and what
   models they serve. Inference traffic goes node → node directly.
2. **`hivv start` runs a quiet background agent.** It registers your machine,
   heartbeats every 60s, and listens for work you've opted into.
3. **Consuming AI is free and instant:** `hivv chat "..."` routes your prompt
   to the best available brain — your local model, a peer's, or a donated
   cloud key. Any unrecognized command is treated as chat: `hivv why is the sky blue`
4. **Contributing is opt-in, tiered:**
   - `hivv start` → you're discoverable and can serve requests if you host an LLM
   - `hivv volunteer on` → the hive may queue general AI jobs on your idle CPU/GPU
   - `hivv llm serve` → run an open-weight model and become a heavyweight bee
5. **Stay safe by default:** LLM ports bind to localhost. Open to LAN peers with
   `hivv firewall --apply --mode lan`, or to your own devices anywhere via
   `hivv firewall --apply --mode tailscale`.
6. **When things go sideways:** `hivv doctor` (report) → `hivv doctor --fix`
   (repairs bindings, services, scripts) → `hivv support "what broke"` (attaches
   diagnostics). Incidents on the network? `hivv incidents summary`.

### OS Notes

| | Linux | macOS | Windows |
|---|---|---|---|
| Install | `curl … \| bash` | `curl … \| bash` | `iwr … \| iex` (PowerShell) |
| Autostart | systemd service | LaunchAgent | Task Scheduler (at logon) |
| Local LLM | llama.cpp / ollama | `brew install llama.cpp` / ollama | ollama (llama.cpp via WSL) |
| Python | usually present | usually present | `winget install Python.Python.3.12` |
| Firewall tool | ufw / firewalld | pf + Application Firewall | Windows Defender Firewall |

## Architecture

```
┌──────────┐   register/heartbeat   ┌──────────┐
│  Bee A    │ ◄───────────────────► │  hivv.org │  ← phone book (registry)
│  :8080    │                       │  :3011    │
└─────┬─────┘                       └────┬─────┘
      │ LLM requests (direct)            │ relay jobs (long-poll inbox)
      ▼                                 ▼ for bees behind NAT
┌──────────┐                      ┌──────────┐
│  Bee B    │  ← peer-to-peer     │  Bee C    │  volunteer, NAT'd
│  :8080    │                      │  (no port)│
└──────────┘                      └──────────┘
```

And the **local-first** version — the same gateway, running on your own box,
with the hub completely optional:

```
┌──────────────────────────────────────────────┐
│  YOUR MACHINE                                │
│                                              │
│   ┌──────────────┐      ┌─────────────────┐  │
│   │ HIVV gateway │─────▶│ local llama.cpp │  │
│   │  :3011       │      │ / ollama / etc. │  │
│   └──────┬───────┘      └─────────────────┘  │
│          │                                   │
│          │ (optional, --join-hive)           │
│          ▼                                   │
│      hivv.org  ← phone book, not a dependency │
└──────────────────────────────────────────────┘
```

- **Hub** (hivv.org) — Registry + relay broker. Knows who's online and what LLMs they have
- **Bees** — Your computer. Runs LLMs, talks directly to other bees
- **CLI** — the `hivv` command. Manages your node, chats, diagnostics
- **Your own gateway** — the same code, running locally, offline-capable
- **Measured routing** — endpoint order is biased by observed tokens/sec (EWMA), so fast bees lead
- **Reliability-weighted routing** — a bee's measured success rate scales its score
  (`rel = 0.25 + 0.75 · successRate²`). Speed alone is not merit: a model that errors on one
  request in three used to out-rank a healthy one purely because it was small and fast. The
  0.25 floor keeps a flaky bee reachable when it is the only one left
- **Model pinning** — `{"model": "gemma-4-E2B"}` restricts the candidate set to bees that
  advertise a matching model (substring match). Every bee serves exactly one model, so without
  this a request for a specific model could still be answered by whatever the routing lottery
  picked. `"auto"` and unknown names pin nothing — the full pool stays eligible
- **Generation params reach the bees** — `max_tokens` / `temperature` / `top_p` /
  `frequency_penalty` / `presence_penalty` / `stop` are forwarded to the node. They used to be
  parsed and then dropped for local endpoints, so a client asking for a 512-token answer got
  up to 2048 tokens back (≈60 s on a 2B model)
- **Relay** — when peer-to-peer is blocked (CGNAT, hotels, corporate wifi), the hub queues inference
  jobs through the volunteer's own long-poll inbox; consent is explicit (`hivv volunteer on`)
- **Receipts** — every answer says who gave it: `X-Hivv-Answered-By: yalla/gemma (direct)`


## The Hive 🍯 — bee identity

Contributing compute is visible and a little addictive:

- **Honey** accrues hub-side only (heartbeat truth, never self-reported): 1/minute online,
  10/job served, 1 per 100 tokens
- **Ranks**: larva → worker → forager → scout → royal-jelly → queen-bee — with streaks and a
  weekly leaderboard (`hivv honey --board`); `hivv up` celebrates rank-ups
- **Hive goal**: a rolling weekly target everyone pushes together (`/api/hive/goal`)
- **`hivv hive-mind "question"`**: fans one question out to 2–6 *different* model families
  across the network, then a "bee judge" merges the answers — the network in one command
- **`hivv share --card`**: a honeycomb bee card (SVG) with your stats — the recruiting tool

## The hivv OS 🧬⚖️ — capabilities, routing intent, and the YES/MAYBE/NO gate

HIVV thinks of itself like a small operating system: **capabilities** are the syscalls,
**route modes** are the scheduler, **policy** is the permissions, the **audit chain** is syslog
you cannot edit. Plan: [`HIVV_CAPABILITY_POLICY_PLAN.md`](HIVV_CAPABILITY_POLICY_PLAN.md).

- **Capabilities** — every request names *what* it needs (`reasoning`, `vision`, `speech.*`,
  `web.search`, `web.fetch`, `database.query`, `coding(.execute)`, `image.generate`,
  `local.computation`, `human.approval`, `financial.transaction`, `physical.world`), never *who*.
  Nodes advertise them honestly (hub-side derivation — models seen, tools shared).
  `hivv cap list` · `GET /api/capabilities`
- **Route modes** — don't depend on one routing protocol. Transports (direct / relay / local /
  cloud) are interchangeable; you declare intent:
  ```bash
  hivv chat --mode=cheap "hello"      # free compute first, cloud last
  hivv chat --mode=fast "hello"       # lowest measured latency
  hivv chat --mode=private "hello"    # cloud providers removed from the candidate set
  hivv chat --mode=smart "hello"      # best model, not fastest
  hivv route "question" --mode=trusted --json   # dry-run planner: who answers & why
  ```
- **Policy gate** — every action that *touches something* passes YES / MAYBE / NO:
  ```
        AI proposes action ──► YES  → execute
                         ├─► MAYBE → ask a human   → hivv approve G_xxx / hivv deny G_xxx
                         └─► NO    → reject (with the rule that said so)
  ```
  Chat and compute flow free (risk tier `compute`, cached fast-path — zero friction).
  Side-effects are audited. `web.fetch` / `database.query` ask once, then a **standing grant**
  (default 30 days) remembers your yes. A MAYBE is **pushed** into every online bee's inbox the
  instant it's minted (`hivv up` nudges you) — not just polled. `coding.execute` runs ONLY inside
  an **ephemeral sandbox** (`hivv exec '<code>'` — docker/bwrap: no network, RAM/CPU/pids quotas,
  read-only, hard timeout), gated MAYBE → an **admin** approves (self-approve is refused) →
  audited. `financial.transaction` / `physical.world` stay refused until a real backend exists.
  `hivv policy explain web.fetch`
- **Audit** — every gated decision lands in a hash-chained ledger: `hivv policy history`,
  `hivv policy verify` (a live tamper test flips it red instantly). Eight-tuple:
  WHO · WHAT · DATA · WHERE · WHEN · COST · RISK · AUDIT — `GET /api/policy`, watched live in the
  [Command Center](https://hivv.org/command-center.html) 🧬 / ⚖️ views.

## Commands

### Node Management
```bash
hivv start              # start the node agent
hivv stop               # stop the node agent
hivv restart            # stop + start
hivv status             # check if agent is running
hivv info               # hub URL, version, install paths
hivv free               # host memory + swap + disk
hivv pct                # live CPU%/MEM%
```

### Chat & AI
```bash
hivv chat "hello"           # chat with distributed AI
hivv chat "hello" --mode=fast   # lowest latency (direct localhost first)
hivv chat "hello" --mode=private # no cloud providers
hivv chat "hello" --mode=smart   # best model, not fastest
hivv node-chat yalla "hi"   # chat directly with a specific node
hivv add openai sk-...      # add any AI to the network
hivv completions "hello"    # OpenAI-compatible endpoint
hivv exec 'print(6*7)'      # run code in the isolated hub sandbox (--lang python|bash|node)
hivv route "q" --mode=fast  # dry-run: which bee answers & why (never executes)
hivv approve --list         # answer a MAYBE the gate pushed to you
```

### Network & Cluster
```bash
hivv bees               # all bees in the hive (alias for nodes) 🐝
hivv bee <name>         # inspect a specific bee (alias for node)
hivv waggle <name>      # test if a bee is reachable (alias for reach)
hivv stats              # per-node stats + cluster totals
hivv top                # real-time cluster activity
hivv benchmark          # test all nodes, find fastest
hivv debug              # full debug info: hub, agent, local AI, network
```

### Security
```bash
hivv firewall               # check firewall + binding + tailscale status
hivv firewall --apply       # apply firewall rules
hivv firewall --apply --mode tailscale  # VPN only
hivv doctor                 # full health report
hivv doctor --fix           # fix all issues automatically
```

### Diagnostics
```bash
hivv doctor             # full health report
hivv doctor --fix       # fix all issues (bindings, services, scripts)
hivv incidents summary  # full health dashboard: count, breakdown, per-node heartbeat age
hivv incidents list     # list active incidents
hivv incidents resolve <id>   # dismiss/resolve an incident
hivv test               # doctor + speed + full network test
hivv speed              # latency benchmark
hivv update             # update CLI + health checks
hivv welcome            # guided first-run tour
```

### Local LLM Helper
```bash
hivv llm detect         # find ollama, llama.cpp on this box
hivv llm suggest        # recommend a model for your hardware
hivv llm bench          # quick CPU/RAM/disk benchmark
hivv llm status         # detect + bench + suggest
hivv llm install        # install commands for your OS
hivv llm serve          # serve a model in the foreground
```

### One-Shot Hub Queries
```bash
hivv health             # GET /api/health
hivv metrics            # GET /api/control/metrics/global
hivv whoami             # cheap liveness check
hivv models             # list all available AI models
```

### Fun & Social
```bash
hivv hi                 # friendly greeter
hivv thanks             # say thanks to the AI
hivv support            # get help — auto-attaches doctor
hivv share "msg"        # share what you're working on
hivv feed               # see what the hive is working on
hivv honey              # your bee card: honey, rank, streak 🍯
hivv honey --board      # weekly leaderboard 🏆
hivv swarm "q"          # fan out to 2–6 models + bee-judge synthesis 🧠 (alias for hive-mind)
hivv drone              # are you a worker bee? volunteer status 🐝
hivv tips               # tip analytics: CTR%, shown/clicked counts, bar chart
hivv share --card       # save a shareable bee card (SVG)
```

### Hive & Volunteering
```bash
hivv volunteer on           # opt in: the hive may queue jobs on your idle CPU/GPU
hivv drone                  # your volunteer status (alias for volunteer status) 🐝
hivv tools on               # share your local tools (time, math, search, sysinfo)
hivv tools share            # announce them to the hive
```

Every answer ends with a receipt — `— answered by yalla/gemma (direct)` —
so you can always see which bee helped you. Disable with `HIVV_RECEIPTS=off`.
NAT'd volunteers can still serve the hive: the hub queues jobs through the
agent's long-poll inbox when peer-to-peer is blocked (`hivv volunteer on`).

## Security

- **API keys encrypted** with AES-256-GCM at rest
- **Admin-only control routes** — only admins can manage nodes
- **Localhost-only by default** — use `hivv firewall --apply --mode lan` to open LAN
- **Tailscale VPN** — use `hivv firewall --apply --mode tailscale` for zero-trust
- **No hub in the middle** — messages go directly node-to-node
- **Timing-safe comparisons** — prevents timing attacks on tokens
- **Outbound fetches are SSRF-guarded** (`api/lib/ssrf.js`) — the `fetch` tool
  may only retrieve **public** addresses. The hostname is resolved and every
  address it maps to is checked, so a public name pointing at `127.0.0.1`
  (or the cloud metadata address `169.254.169.254`) is refused, as are
  non-HTTP schemes and IPv4-mapped/IPv4-translated IPv6 forms. The local
  tools server carries the same guard.
- **Internal services bind to loopback only.** Whisper STT (`:3014`) and the
  node tools server (`:18789`) have no authentication, so they listen on
  `127.0.0.1`. Override with `HIVV_STT_HOST` / `HIVV_TOOLS_HOST` only if a
  remote host genuinely needs to reach them.

## API

OpenAI-compatible API:

```bash
# Chat (routes to best available node)
curl -X POST https://hivv.org/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'

# Pin a model + cap the answer (only bees advertising a matching model answer)
curl -X POST https://hivv.org/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-4-E2B","max_tokens":512,"temperature":0.7,
       "messages":[{"role":"system","content":"You are a direct assistant."},
                   {"role":"user","content":"hello"}]}'

# Add AI to network
curl -X POST https://hivv.org/api/keys/donate \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","api_key":"sk-..."}'

# List nodes
curl https://hivv.org/api/control/nodes

# Cluster stats
curl https://hivv.org/api/control/stats

# Bee identity (public)
curl https://hivv.org/api/hive/leaderboard?window=week
curl https://hivv.org/api/hive/honey/ashy
curl https://hivv.org/api/hive/goal
curl https://hivv.org/api/hive/perf
curl https://hivv.org/api/hive/share-card/ashy.svg   # bee card image
curl https://hivv.org/api/hive/timeline?hours=72      # aggregated time-series (dashboard charts)
curl https://hivv.org/api/hive/events                 # active + upcoming honey multipliers

# NAT relay (volunteer work + job status)
curl https://hivv.org/api/relay/volunteers
curl -X POST https://hivv.org/api/relay/jobs \
  -H "Content-Type: application/json" \
  -d '{"node_id":"ashy","request":{"messages":[{"role":"user","content":"hello"}]}}'

# hivv OS (capabilities + policy + routing intent + sandbox)
curl https://hivv.org/api/capabilities
curl https://hivv.org/api/capabilities/route/dry-run?capability=reasoning\&mode=private
curl https://hivv.org/api/policy                    # YES/MAYBE/NO defaults (eight-tuple)
curl https://hivv.org/api/policy/audit/verify       # tamper check: {"ok":true,...}
curl https://hivv.org/api/policy/audit/snapshots     # signed monthly snapshots + signature verification
curl https://hivv.org/api/policy/delegations         # delegation chain CRUD
curl https://hivv.org/api/sandbox/status            # isolated runtime present? (docker/bwrap)

# Analytics & tips
curl https://hivv.org/api/tips                      # all tips with shown/clicked counts + CTR
curl -X POST https://hivv.org/api/tips/log          # log tip shown/clicked events

# System health
curl https://hivv.org/api/health                    # gateway health
curl https://hivv.org/api/health/redis              # Redis connectivity (not_configured if absent)
curl -X POST https://hivv.org/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}],"route":{"mode":"cheap"}}'

# Speech-to-text — two surfaces, both local (audio never leaves the box)
curl https://hivv.org/api/stt/models                # available Whisper models
curl -X POST https://hivv.org/api/stt --data-binary @clip.webm   # raw body → {"text": "..."}
curl -X POST https://hivv.org/v1/audio/transcriptions \           # OpenAI-compatible
  -F "file=@clip.webm" -F "model=whisper-1" -F "response_format=json"
#   → {"text": "..."}   (response_format=text → plain text, verbose_json → {text, language})

# Database browser (public tables only)
curl https://hivv.org/api/database/tables            # list public tables + row counts
curl https://hivv.org/api/database/hivv_capabilities # browse a specific table
```

## Dashboard

The unified command center at `https://hivv.org/command-center.html` is a live,
animated view of what the hive is doing *right now* — every number is real, pulled
from the usage ledger, perf EWMA, honey and policy tables (no fixtures):

- **Live Hive Pulse** — animated count-up KPIs (requests, tokens, avg t/s, p95 latency,
  success-rate) with pulsing live-dots; fed by `GET /api/hive/timeline`
- **Live Request Stream** — a deduped, slide-in ticker of in-flight requests
  (model · tokens · latency · status), refreshing every 5s
- **Real charts** — throughput (requests bars + tokens line), latency p50/p95, model-mix
  donut, verdict-mix donut, health history (requests + success-%), tokens-per-model bars
- **Bee Speed Race** — animated bar-race of measured tokens/sec per bee (EWMA)
- **GPU Wall** — radial gauges (utilization) + VRAM bars + live temperature per GPU
- 🍯 **Hive view** — goal progress ring, honey-bar leaderboard, measured speed, relay queue
- ⚖️ **Policy view** — pending-MAYBE approve/deny buttons, verdict donut, and a
  **hash-chain visualizer** that draws the audit ledger as linked blocks (head pulses)
- World map with live node markers · D3 force network graph · node hardware cards
- Advanced chat UI at [`/chat/`](https://hivv.org/chat/) · Add-AI key donation form

Time-series backing endpoint: `GET /api/hive/timeline?hours=N` (aggregated, cached, no PII).

## Status Page

Live status at `https://hivv.org/status` shows:

- **Avg response (5m)** — server-side 5-minute window average (not a stale cache)
- **Tokens today · via hub** — honest hub-routed count (direct node-to-node traffic is free and can't be counted)
- **Live Request Stream** — recent requests with the **actual model served** (not the client-requested name)
- **Models in Rotation** — real models from online hive bees and discovered local backends
- **Local Backends** — the model each backend is serving (e.g. `llamacpp · gemma-4-E2B-it-Q4_K_M`)

API: `GET /api/public/status` · `GET /api/public/models` · `GET /api/public/activity`

## Database Browser

Browse HIVV's public tables at `https://hivv.org/database.html`. A strict
server-side whitelist exposes 11 public tables (problems, tasks, incidents,
honey events, model perf, capabilities, etc.). Sensitive tables (users, sessions,
keys, usage logs, audit) are **never exposed** — the whitelist lives server-side.

API: `GET /api/database/tables` · `GET /api/database/:table?limit=50`

## Node Hardware Detection

`hivv nodes` shows per-node hardware + CLI version (drift flags ⚠ — agents auto-heal ≤5 min):
```
  NAME             CPU                    RAM            GPU
  ashy             Intel i9-9900 3.1GHz   27/46GB (58%)  RTX 3050 4/6GB
  yalla            Intel i7-10700 2.9GHz  4/30GB (15%)   Quadro K1200 2/4GB
  masjid           Intel i7               3/30GB (12%)   GTX 1650 2/4GB
```

## Context Windows

| Model | Context | Speed |
|-------|---------|-------|
| GPT-4o | 128K | ~150 t/s |
| Claude Sonnet 4 | 200K | ~100 t/s |
| Gemini 2.0 Flash | 1M | ~200 t/s |
| Llama 3.3 70B | 128K | ~800 t/s |
| Gemma 4 E2B (local) | **64K** | ~40 t/s |
| Qwen3 14B (yalla) | 32K | varies |
| Phi-4 16B (masjid via LM Studio) | 32K | varies |

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | 3011 | Gateway listen port |
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_NAME` | hivv | Database name |
| `HIVV_DB_PASSWORD` | — | Database password |
| `HIVV_SESSION_SECRET` | — | Cookie signing |
| `HIVV_ENCRYPTION_KEY` | — | Key encryption |
| `HIVV_CONTROL_TOKEN` | — | Admin access token |
| `HIVV_LOCAL_ENDPOINTS` | — | Comma-separated LLM URLs |
| `HIVV_HUB` | https://hivv.org | Hub URL |

### Request-level knobs (`POST /v1/chat/completions`)

| Field | Default | Purpose |
|-------|---------|---------|
| `model` | `auto` | `auto` = routing lottery. Any other value **pins** local bees to a matching advertised model (substring match); unknown names pin nothing |
| `max_tokens` | node default | Answer cap — forwarded to the bee. A 2B model otherwise generates ~2000 tokens (≈60 s) |
| `temperature`, `top_p` | node default | Forwarded to the bee |
| `frequency_penalty`, `presence_penalty`, `stop` | — | Forwarded to the bee |
| `route.mode` | `balanced` | `cheap` / `fast` / `private` / `smart` / `quality` / `trusted` |
| `capability` | `reasoning` | hivv OS capability name (drives the policy gate) |

CLI-side toggles (no restart needed):

| Var | Default | Purpose |
|-----|---------|---------|
| `HIVV_RECEIPTS` | on | set `off` to hide the "— answered by …" line under chats |
| `HIVV_THINK` | off | set `1` to re-enable model thinking/reasoning on direct chats (default: OFF — instant answers) |
| `HIVV_NO_STREAM` | — | set `1` to buffer the reply instead of streaming tokens |
| `HIVV_TIPS` | on | set `off` to hide auto-heal tips on errors |
| `HIVV_TRUSTED_FINGERPRINT` | — | pin CLI auto-updates to one SHA256 |
| `HIVV_HEARTBEAT_S` | 60 | agent heartbeat cadence |
| `HIVV_DEV_MODE` | — | `1` blocks self-update (protects edited copies) |

## Operations notes

- **Site supervision (2026-09-26):** every vhost app on this box runs under pm2
  (`pm2 start <site>/ecosystem.config.js` then `pm2 save`) or a *running, enabled*
  systemd unit — never ad-hoc/nohup. After any site change: `pm2 save`.
  One-process-per-unit rule applies (no `&` wrappers; Next via `next start -p PORT`,
  Flask via `flask run`, not the debug reloader). Stale disabled units
  `/etc/systemd/system/{yoia,applie}.service` were removed so they can't
  double-supervise the pm2 apps. All 12 pm2 apps online: hivv-ai-gateway, hivv-tools,
  kokoro-tts, whisper-stt, kyzo, yoia, applie, juay, yally-api, owme-api, fynz
  (+ pm2-logrotate).
- **Local LLM (ashy):** gemma runs as the *user-scope* unit `llama.service`
  (llama-server on `127.0.0.1:8080`, `Restart=on-failure`) — deliberately not root,
  never a second system-scope copy of the same model/port. Reference units for
  per-model servers: `public_html/llama-{gemma,qwen}.service` (add a qwen GGUF first).
- **Speech + tools bind to loopback:** `whisper-stt` (`:3014`) and `hivv-tools`
  (`:18789`) listen on `127.0.0.1` only — neither has authentication. The gateway
  reaches them over loopback and now tries `127.0.0.1`/`localhost` before a node's
  advertised LAN address when invoking a node tool.
- **The OpenAI-compatible transcription route** is `POST /v1/audio/transcriptions`
  (`api/routes/transcriptions-routes.js`), accepting multipart or a raw body and
  answering `{"text": …}` / plain text / `{"text", "language"}`. It forwards to the
  local Whisper server, so audio never leaves the machine.
- **Site smoke check:** `pm2 list` + per-site `curl -sk -o /dev/null -w '%{http_code}'
  --resolve <host>:443:127.0.0.1 https://<host>/` — a site can be "enabled" in Caddy
  and still 502 with a dead backend; the port is the truth: `ss -tln | grep :3456`.
- **Reboot-safe:** gateway runs under `pm2-asher.service` (enabled, `pm2 save`d);
  node agents run as systemd user units with `Linger=yes`; honey lives in Postgres,
  node registry in `api/data/nodes.json` — nothing important is memory-only
  (relay queue is intentionally in-memory; stale jobs simply expire)
- **Logs:** `pm2 logs hivv-ai-gateway`, agent logs at `~/.local/share/hivv/agent.log`,
  relay/perf/honey activity is tagged `[HONEY]`/`[PERF]`/`[RELAY]` in the gateway log
- **Current to-do list:** see [`HIVV_BACKLOG.md`](HIVV_BACKLOG.md) (release/signing steps,
  v2 extras) — plan of record: [`HIVV_PLAN.md`](HIVV_PLAN.md)

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

ISC License — see [LICENSE](LICENSE) for details.

---

**Together we have the compute to solve Earth's hardest problems.** 🐝
