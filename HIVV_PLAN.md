# HIVV.org — Plan: Fun · Easy · Helpful

> Roadmap to make hivv delightful to join, trivial to run on any OS, and genuinely useful.
> Written 2026-09-25, alongside the all-OS installer fixes (install-hivv.sh / .ps1 / hivv-cli.py cross-platform).
> Status legend: ☐ not started · ◐ in progress · ☑ done
>
> **2026-09-25 — the whole plan was executed in one pass.** Shipped & live on hivv.org:
> P0.1 (verified GGUF repos in `llm suggest --json` + installers), P0.2 (`hivv` wrapper execs — streaming fixed),
> #4 tips (data-driven `_HIVV_TIPS` in `die()`/`warn()`), #1 honey/ranks/streaks (migration 007, `api/lib/honey.js`
> 60s hub-side sweep, `/api/hive/*`, `hivv honey [--board]`), #7 measured routing (`api/lib/perf.js` EWMA, epsilon-greedy
> endpoint ordering, `X-Hivv-Answered-By` receipts + dim CLI line, dashboard speed table), #2 `hivv hive-mind`
> (family-diverse fan-out + bee-judge synthesis), #6 share cards (`/api/hive/share-card/:node.svg`, `hivv share --card`,
> weekly hive goal), #5 NAT relay (job queue → volunteer inboxes → agent-executed local completion → posted results;
> router auto-falls-back; proven end-to-end). Still open: #3 needs one release run + code signing + winget/brew PRs
> (workflow + manifests + stdlib-contract check are in `.github/workflows/build-cli-binaries.yml` / `packaging/`);
> later-stage extras: golden-hive days, `/wall`, tip analytics, PNG card rendering.
>
> **➡ Everything still to do lives in [`HIVV_BACKLOG.md`](HIVV_BACKLOG.md)** (release/signing steps,
> relay rate-limiting, v2 extras, tech debt, and what was verified-done on 2026-09-25).

Each plan below has: **Goal → Steps → Touches (files) → Done when → Effort**.

---

## P0 — Finish what the installer audit uncovered

### P0.1 ☑ Real GGUF repo for `--with-llm` (currently 404s)

**Goal:** `hivv llm suggest` / installer model download points at real, hardware-appropriate HuggingFace GGUF repos instead of the fictional `gemma4:e2b`.

**Steps:**
1. In `hivv-cli.py`, extend `_llm_suggest()` tiers with `(hf_repo, hf_file)` pairs validated against HF, e.g. `bartowski/google_gemma-3-4b-it-GGUF` (Q4_K_M file), `QuantFactory/...` for smaller boxes.
2. `llm suggest --json` gains fields: `primary`, `gguf_repo`, `gguf_file`, `ollama_tag`.
3. Installer (`install-hivv.sh` `--with-llm`, and the same block in `.ps1`) builds the URL as `https://huggingface.co/{repo}/resolve/main/{file}` and saves as `{file}`.
4. Add a `HEAD` request before the big download; on 404 fall back to the next tier and say so.
5. Record download + path in `~/.local/share/hivv/models/index.json` so `hivv llm detect` finds local GGUFs.

**Touches:** `public_html/hivv-cli.py` (suggest + llm subcommands), `public_html/install-hivv.sh`, `public_html/install-hivv.ps1`
**Done when:** fresh Ubuntu + macOS + Windows VM installs with `--with-llm` end with a loadable model and `hivv chat "hi" --local` answers.
**Effort:** S–M (0.5–1 day)

### P0.2 ☑ Stop the bash wrapper from buffering chat streams

**Goal:** `hivv chat` (via the `hivv` wrapper) streams tokens live; today it captures `$(python3 ...)` and prints at the end.

**Steps:**
1. Replace the capture-then-print + grep-for-traceback self-heal in `public_html/hivv` with: exec the CLI directly for everything; do self-heal checks *before* exec (HTML check + `--help` smoke) rather than after failure.
2. Keep a narrow retry: if exec exits 0 but the run produced no output AND `agent.log` shows a traceback, re-download once and `exec` again — never for interactive/stream commands.
3. Honor `HIVV_NO_STREAM=1` to force the old buffered path (test-friendly).

**Touches:** `public_html/hivv` (wrapper), `public_html/hivv-cli.py` (`_do_chat` exit-code hygiene)
**Done when:** `hivv chat "count to 100"` shows tokens as they arrive in Terminal, Windows Terminal, and tmux.
**Effort:** S (~2h)

---

## 1. ☑ Bee Identity (v1 shipped) — honey points, ranks, streaks

**Goal:** contributors can *see* their impact; the hive gets a team-sport feel.

**Mechanics to define first (keep boringly simple):**
- `honey = minutes_online * cpu_share_used + jobs_completed * 10 + models_served_hours * 5`
- Ranks: Larva → Worker → Forager → Scout → Royal Jelly → Queen Bee (6 tiers, per honey thresholds)
- Streak = consecutive days the agent heartbeated ≥ 22h/day; resets on full-day absence (grace: weekends free for Larva/Worker)

**Steps:**
1. **Schema** (`api/migrations/`): `node_stats (node_id, honey bigint, jobs_completed, minutes_online, streak_days, best_streak, rank, updated_at)`; `honey_events (id, node_id, kind, amount, created_at)` for auditability.
2. **Accrual:** hub-side cron in `api/lib/orchestrator.js` (`setInterval` job): on each heartbeat delta, mint honey events; recompute rank; never trust the node's own numbers.
3. **API:** `GET /api/nodes/:id/profile` (rank, honey, streak, top models served, join date); `GET /api/control/leaderboard?window=week|all&limit=20`.
4. **CLI:** `hivv honey` → rank card with ASCII honeycomb, progress bar to next rank, this-week delta; shown after `hivv up` when rank changes ("⬆ You leveled up to Forager!").
5. **Dashboard:** leaderboard panel + rank badge next to node name in map/graph tooltips (`public_html/command-center.html`).
6. **Fun layer (later):** rare "golden hive" bonus days (2× honey), seasonal hives (monthly challenges).

**Touches:** `api/migrations/*`, `api/lib/orchestrator.js`, `api/routes/control-routes.js`, `public_html/hivv-cli.py`, `public_html/command-center.html`
**Done when:** a node's dashboard + `hivv honey` agree on honey/rank/streak; leaderboard visible weekly.
**Effort:** M (2–3 days) · deps: none

## 2. ☑ `hivv hive-mind "question"` — fan-out + consensus demo

**Goal:** signature moment that sells the network: one prompt, N different brains answer live.

**Steps:**
1. **CLI command** `cmd_hive_mind` in `hivv-cli.py`: pick up to K=3–5 *distinct* models across online nodes (diversity rule: prefer different families — llama vs gemma vs qwen vs a donated cloud key). Reuse `hivv nodes` discovery + `router`-style scoring; `--nodes a,b,c` to force.
2. Fan out via existing OpenAI-compatible `/v1/chat/completions` on each node's endpoint, concurrent threads, 30s budget each; render streaming columns (3-pane TUI; falls back to sequential blocks on narrow/dumb terminals).
3. **Consensus pass:** send the collected answers + question to the fastest node ("Bee Judge") with: `agree/disagree/merged answer in ≤2 lines`. Mark clearly it's a synthesis, not a vote.
4. Per-answer footer: model, node, latency, tokens — teaches users the network is real.
5. `--quiet` / `--json` for scripts; results feed `usage_logs` with `feature='hive-mind'` for popularity tracking.

**Touches:** `public_html/hivv-cli.py` (new cmd + argparse wiring), optional hub helper `GET /api/models/suggest-diverse`
**Done when:** on a 3-node cluster the command renders 3 streamed answers + a 2-line synthesis in <45s, and degrades cleanly with 1 or 2 nodes.
**Effort:** M (2–3 days) · deps: none (P0.2 improves it but isn't required)

## 3. ◐ One verb on every OS — no-Python binaries + package managers

**Goal:** `winget install hivv` · `brew install hivv` · `.deb` / `.rpm` · PowerShell one-liner unchanged. Remove "install Python first" from Windows (biggest support burden we found).

**Steps:**
1. **Freeze the contract:** `hivv-cli.py` is a single file, stdlib-only (verify with `python3 -c "import ast; ..."` import audit script; no third-party deps).
2. **Build pipeline** (`ci/`): PyInstaller matrix — `windows-latest`, `macos-14` (arm64+x86_64), `ubuntu-22.04`; artifacts `hivv-{os}-{arch}` + `hivv.zip`. Sign Windows binary (Azure Trusted Signing free for OSS; revisit macOS notarization).
3. **Self-update redesign:** binaries keep the same `update_available` inbox message but swap `{CLI,wrapper}` files under `~/.local/share/hivv/` and relaunch the *same* binary (embedded python runtime swaps are out of scope; the binary loads the updated script file).
4. **Winget manifest** → PR to `microsoft/winget-pkgs` (`Ollama.Ollama` is the template to follow); **Homebrew formula/tap** → `hivv/homebrew-tap/hivv.rb`.
5. **Deb/rpm:** fpm one-liner in release job; publish to GitHub Releases, add `install.sh` fallback that hits Releases when apt isn't configured.
6. Update installer banners: Windows path becomes "either `winget install hivv` or the one-liner".
7. Keep `.py` path fully alive (source installs, `hivv update` dev flow) — binaries are a *frontend*, not a fork.

**Touches:** `ci/`, release infra, `public_html/install-hivv.ps1` (detect binary vs python), `hivv-cli.py` (`_apply_update` branch for frozen mode via `sys.frozen`)
**Done when:** clean Windows 11 VM runs `hivv chat` with zero manual prerequisites; `brew outdated` sees new hivv releases.
**Effort:** L (1–2 weeks, mostly CI + signing) · deps: P0.1/P0.2 stable

## 4. ☑ Auto-heal nudges — help at the moment of pain

**Goal:** every failure the user can hit ends with a *specific next command*, not a dead end.

**Steps:**
1. Centralize in `hivv-cli.py`: wrap `die()`/`warn()` with `die_with_tip(error_code, context)` → looks up a rules table:
   - chat timeout → "try a smaller model: `hivv llm suggest` · or `hivv node-chat <fast-node>`"
   - hub unreachable → `hivv debug network` + offline mode note
   - node unreachable / connection refused → "`hivv firewall --apply --mode lan` (LAN peers) or `tailscale` mode"
   - port 11434/8080 conflict → the exact offending service + start command
   - 401 on control routes → `hivv auth login` (and never re-prompt in the same session)
   - agent crash-loop (existing `_crash_log`) → last 3 log lines + `hivv doctor --fix`
2. Tips table as **data**, not code — so `hivv update` can ship new tips without new logic.
3. After 2+ same-error repeats in a session, auto-offer `hivv support` (which already attaches doctor + logs).
4. Log tip_shown / tip_clicked counts to `usage_logs` so we prune useless tips.

**Touches:** `public_html/hivv-cli.py`
**Done when:** the 6 common support complaints each end with a one-line copy-pasteable fix.
**Effort:** S–M (1 day) · deps: none

## 5. ☑ Relay mode (v1 shipped) — nodes behind NAT still contribute

**Goal:** if peer→peer inference is blocked (CGNAT, corporate wifi, Windows on home broadband), work still flows: hub brokers, node long-polls. The `/api/agents/:id/inbox` long-poll + ack plumbing already exists — this promotes it from control channel to data channel.

**Steps:**
1. **Route:** `POST /api/jobs` (queue: node_id, openai-shaped body, ttl_s=60, max_latency_ms) → hub pushes into the target node's inbox (existing mechanism); node runs it against its local LLM and `POST /api/jobs/:id/result`.
2. **Node side (`_agent`):** new inbox kind `inference_job`; run with the existing VRAM/time caps; reply with result or error. Honor `volunteer` flag + per-minute quota from `gateway_config`.
3. **Router side (`api/lib/router.js` + `orchestrator.js`):** on direct-POST timeout/refused, retry via relay; mark response `via: "relay"` (CLI shows a small "≈" so users learn the difference).
4. **Security:** jobs are size-limited, rate-limited per requester, never auto-run tools; results visible only to requester + target.
5. **Discovery:** nodes advertise `relay_capable: true` in heartbeat so CLI can say "ashy (reachable via relay)".
6. Bench: relay adds ~0.5–2s; cap concurrency per node at 1–2 jobs.

**Touches:** `api/routes/inbox-routes.js` (or new `job-routes.js`), `api/lib/orchestrator.js`, `api/lib/router.js`, `public_html/hivv-cli.py` (`_agent` handler)
**Done when:** two laptops on separate home ISPs (no Tailscale) complete a `hivv node-chat` round-trip through the hub.
**Effort:** L (3–5 days) · deps: none, but pairs with 7 (relay results feed speed stats)

## 6. ☑ Shareable moments — bee cards that recruit bees

**Goal:** "I powered 1,243 answers this week" → one-tap post. Word-of-mouth is our only growth engine (no marketing budget by design).

**Steps:**
1. **Generator:** `GET /api/share-card/:node_id?week=..` → server-rendered SVG (rank, honey, streak, map of who-you-helped, live-model chips) → PNG via `sharp`/`resvg` on the hub.
2. **CLI:** `hivv share --card` writes `hivv-bee-card.png` + a prewritten line ("🐝 I gave my idle GPU to hivv.org — the people's AI network. 5 min setup: curl -sSL hivv.org/install-hivv.sh | bash"); `hivv share "msg"` (existing feed post) gets an optional `--with-card`.
3. **Hive goals:** hub-level weekly goal row (`hive_goals` table) — "help reach N answers"; card shows the hive's progress bar + your slice. Add to dashboard footer.
4. **Site:** `/wall` page showing recent cards (opt-in flag on nodes, off by default).

**Touches:** `api/` (new route + tiny table), `public_html/hivv-cli.py`, `public_html/index.html`
**Done when:** a user can generate a card in <5s without leaving the terminal.
**Effort:** M (2 days) · deps: 1 (ranks/honey give the cards content)

## 7. ☑ Measured routing — speed per node+model, "answered by" receipts

**Goal:** route on *observed* tokens/sec, and tell the user who answered. (Already shipped — see [docs/SHIPPED.md](docs/SHIPPED.md); this is the design pass.)

**Steps:**
1. **Telemetry at the edges:** hub times every proxied/routed completion → `model_perf (node_id, model, window, ttfb_ms, tokens_per_sec, n)`; rolling 10-min + 24h EWMA. Relay jobs (5) and direct hops both report.
2. **Scoring:** router preference = `quality_weight(model) × perf(ewma) × recency(heartbeat) × health(circuit-breaker)`; expose weights in `gateway_config` for tuning without deploys.
3. **Receipts:** response header `X-Hivv-Answered-By: ashy/gemma-3-4b (41 tok/s, relay)`; CLI prints one dim line after each answer ("— answered by yalla · Gemma3 4B · 38 t/s · 2.1s"). Toggle with `HIVV_RECEIPTS=off`.
4. **Dashboard:** model distribution + p50/p95 latency charts per model family; nodes list sortable by measured speed.
5. `hivv benchmark` (exists) upgrades to report against recorded history: "ashy is 12% faster than last week".

**Touches:** `api/migrations`, `api/lib/router.js`, `api/lib/orchestrator.js`, `public_html/command-center.html`, `hivv-cli.py`
**Done when:** killing the fastest node visibly reroutes traffic to the next-best within one heartbeat window, receipts on every chat.
**Effort:** M (3–4 days) · deps: 5 recommended (relay closes the measurement gap for NAT nodes)

---

## Sequencing

| Phase | Ship list | Why this order |
|-------|--------|----------------|
| **Week 1** | P0.1, P0.2, #4 | Finish install correctness + cheapest trust win; zero infra risk |
| **Week 2** | #1 honey/ranks, #7 receipts | Stats tables land first (everything reads them); receipts alone feel magical |
| **Week 3** | #2 hive-mind, #6 share cards | The demo + the megaphone, both built on 1 + 7 |
| **Weeks 4–6** | #5 relay mode, #3 binaries/packages | The two L's; relay makes Windows installs *useful*, binaries make them *easy* |

**North-star metrics:** install→`hivv start` success rate (all OS), median first-chat latency, weekly streak-retention %, share-card generates, relay-completed job %.

**Risks:** honey gaming (mint only from hub-side truth, cap per-day); fan-out cost (hive-mind caps at 5 nodes, cloud keys excluded unless donated); PyInstaller AV false-positives (sign early, not after); relay abuse (size/rate limits + volunteer opt-in only); receipt privacy (node names only, never IPs).
