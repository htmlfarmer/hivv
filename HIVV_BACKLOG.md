# HIVV.org — Backlog (what's left after the 6-week build)

> Status snapshot: 2026-09-28. All of `HIVV_PLAN.md` is shipped **except** #3 (binaries/packages),
> which needs GitHub + signing accounts. This file is the authoritative to-do list.
> Legend: 🔴 urgent · 🟠 soon · 🟡 nice · ⚪ backlog

---

## A. Release / binaries (HIVV_PLAN #3 — the only unfinished plan item)

| # | Task | Where | Pri | Needs | Est |
|---|------|-------|-----|-------|-----|
| A1 | `git init`, create GitHub repo, push (working dir is NOT a git repo yet) | `/var/www/vhosts/hivv.org` | 🔴 | you | 10m |
| A2 | Tag `v0.3.0`, run `build-cli-binaries.yml`, verify all 5 binaries | `.github/workflows/` | 🔴 | A1 | 20m |
| A3 | Windows code signing — Azure Trusted Signing (free for OSS), workflow has TODO slot | workflow | 🟠 | you: account | 1h |
| A4 | macOS notarization (else Gatekeeper warnings) | workflow | 🟡 | you | 1–2h |
| A5 | Fill SHA256s/version, submit winget PR to `Microsoft/winget-pkgs` | `packaging/winget/` | 🟠 | A2 | 30m |
| A6 | Create `hivv/homebrew-tap` repo → `Formula/hivv.rb` with real SHAs | `packaging/homebrew/` | 🟠 | A2 | 20m |
| A7 | Test `install-hivv.ps1` + Task Scheduler autostart on a REAL Windows VM (never executed anywhere) | any Windows box | 🔴 | hardware | 1h |
| A8 | ✅ DONE 2026-09-28: CLI frozen-binary self-update. `_is_frozen()`/`_agent_argv()`/`_agent_execstart()` helpers + `_apply_update_frozen()` (sha256 verify → write candidate → run `<bin> --healthcheck` → atomic swap; POSIX `os.replace` over the running binary, Windows renames running exe to `.old` first; rollback + `.bad`/`.bak` kept on failure). Launch/relaunch/systemd-ExecStart sites all frozen-aware. Source (.py) path byte-identical (3 live nodes unaffected). Simulation-tested (importlib + `sys.frozen`): good swap, sha-mismatch refuse, healthcheck-fail rollback all pass. Blocked on A1/A2 (no published binaries yet) for a real end-to-end run | `hivv-cli.py` | 🟡 | code | ✅ |
| A9 | Update installers' banners once binaries exist: "winget install hivv / brew install hivv" | `install-hivv.sh` + `.ps1` | 🟡 | A5/A6 | 15m |

## B. Security / consent follow-ups (relay v1 gaps)

| # | Task | Where | Pri | Notes | Est |
|---|------|-------|-----|-------|-----|
| B1 | ✅ DONE 2026-09-25: per-requester sliding-window limiter — 10 creates/min + 120 polls/min, `Retry-After`, other visitors unaffected (tested: 10×404 then 429) | `api/routes/relay-routes.js` | 🔴 | | |
| B2 | ✅ DONE 2026-09-25: `relay.getJobOwner()` + HTTP GET binds result to `x-visitor-id` (403 to thieves via HTTPS; localhost bypasses because the router reads in-process — tested) | `relay-routes.js` | 🟠 | | |
| B3 | ✅ DONE 2026-09-28: relay concurrency cap + max_tokens wired via `gateway_config` (`relay` key); `router.loadConfig` calls `relay.setConfig()` on the `relay` key; `gateway_config` row added with defaults (2/2000/500/90s). Code no longer has hardcoded relay limits. | `router.js` loadConfig, `relay.js` setConfig, `gateway_config` row | 🟡 | | ✅ |
| B4 | ✅ CLOSED 2026-09-25: unit was already gone from disk (verified `systemctl cat` → no such file). Also verified: ashy's `hivv-agent.service` (user unit) enabled + `Linger=yes` → node auto-starts on reboot; systemd Main PID matches the pid file | — | 🟠 | | 0m |
| B5 | Decide relay job persistence: currently in-memory (jobs lost on gateway restart). OK for now; revisit if relay traffic matters | `relay.js` | ⚪ | | — |

## C. v2 feature follow-ups (each explicitly deferred from a plan section)

| # | Feature | Plan ref | What's missing | Est |
|---|---------|---------|----------------|-----|
| C1 | ✅ DONE 2026-09-25: rank-up celebration | #1.4 | live in `hivv up` via `_celebrate_rank_up()` (tested worker→scout banner) | ✅ |
| C2 | ✅ DONE 2026-09-28: honey multipliers via `hivv_hive_events` table (5 seeded events: golden-weekend ×1.5, new-moon ×2, hivv-anniversary ×3, first-of-month ×2, full-moon ×1.5); `GET /api/hive/events` returns active + upcoming events + current multiplier; honey sweep applies multiplier to job+token honey (not online-minute loyalty); multiplier cached 60s; `hivv events` CLI shows active + upcoming events with multiplier. Per-node opt-out table `hivv_event_participation` ready. **TODO:** `hivv events` CLI command (nice-to-have, not yet built) | #1.6 | | ✅ |
| C3 | ✅ DONE 2026-09-28: `hive-mind --json` (full JSON output: question, brains, answers+verdict), `--quiet` (verdict-only, skips per-brain output), `POST /api/hive/log-feature` endpoint, migration 012 adds `feature` column to `usage_logs`, UsageTracker accepts `feature` param, CLI fires fire-and-forget log on completion | `hivv-cli.py` cmd_hive_mind, `honey-routes.js`, `usage-tracker.js`, migration 012 | #2.5 | | ✅ |
| C4 | ✅ DONE 2026-09-28: `hivv_tips` table (13 seeded tips with `shown_count/click_count`); `GET /api/tips` returns all tips with CTR%; `POST /api/tips/log` increments shown/clicked; CLI `_print_tips()` fires fire-and-forget shown-log per tip; `hivv tips` command shows bar chart + CTR%; subparser + dispatch in CLI. `GET /api/tips` confirmed 13 tips, totals all 0 (fresh DB) | `routes/tips-routes.js`, `server.js`, `hivv-cli.py` | #4.4 | | ✅ |
| C5 | Bee-card: PNG rendering (`sharp`/`resvg`), `/wall` page, per-node card opt-in flag | #6.1/#6.4 | cards currently public SVG for ANY node id — add consent | 3h |
| C6 | ✅ DONE 2026-09-27: `gateway_config.routing` loaded by `router.loadConfig` (jitter, unknown_tps, quality_weights) — shipped with hivv OS §2 | #7.2 | | — |
| C7 | ✅ DONE 2026-09-28 (charts): p50/p95 latency CHARTS shipped (overview `chart-latency`, from `/api/hive/timeline`); health-history + tokens-per-model charts also live. **Remaining:** benchmark-vs-history ("ashy is 12% faster than last week") | #7.4–5 | charts done; delta-vs-last-week not | 1h |
| C8 | ✅ DONE 2026-09-28: `models/index.json` written on `llm pull-gguf` success (both huggingface-cli and wget paths); `_llm_detect` reads it and shows indexed GGUF models with size + serve command; index stored in `~/.local/share/hivv/models/index.json` | `hivv-cli.py` cmd_llm_pull_gguf, _llm_detect, _read_models_index, _write_models_index | P0.1.5 | | ✅ |
| C9 | ✅ DONE 2026-09-28: `GOAL_TITLES[]` array (12 rotating weekly titles); sweep UPDATE now also sets `title` + `title_index` (ISO week % length) on weekly reset; migration 013 adds `title_index` column; **Also:** `_resetGoalIfNeeded()` independent weekly check (fires even with zero jobs — no longer lazy). Verified: goal reset to "run more inference than ever before" for week 2026-09-28 | `lib/honey.js` GOAL_TITLES + sweep UPDATE + `_resetGoalIfNeeded`, migration 013 | #6.3 | | ✅ |
| C10 | ✅ DONE 2026-09-28: `hivv nodes` now shows **TPS** (tokens/sec, EWMA from heartbeat deltas) + **Ping** (RTT, CLI-measured, hub-cached 30s). TPS computed in honey.js sweep (zero extra calls); ping endpoint `GET/POST /api/control/ping` (one HTTP call per display, cached for all clients); nodes endpoint cached 10s (1000 concurrent =1 DB query per 10s); rate limiter 60 req/min per IP; `hivv ping` posts results to hub cache. Migration 015 adds `tokens_per_sec`/`avg_ping_ms` columns | `honey.js`, `routes/control-routes.js`, `hivv-cli.py` cmd_nodes + cmd_ping, migration 015 | #7.4 | | ✅ |
| C11 | ✅ DONE 2026-11-14: **LLM-reviewed upgrades** — every CLI update (manual `hivv upgrade`, 5-min auto-loop, inbox push) runs pre-apply review: `_upgrade_static_scan` (danger patterns on added diff lines: pipe-to-shell, rm -rf system paths, reverse shells, secret exfil, new-host allowlist) → local LLM vote (`_local_brain_urls`: HIVV_LOCAL_ENDPOINTS → _detect_local_ai → 2s probe of :8090/:1234, thinking-off + reasoning_content fallback) → hive fan-out vote (`_review_hive_brains`, distinct families, excludes self) → thin-suspicion confirmation round (clean static scan + single flag → adversarial re-ask; retract → OK). Verdict: critical/high static OR majority-suspicious → **block + hub incident** (`upgrade_suspicious`), healthcheck/rollback failure → `upgrade_failed`. Hub: `POST/GET /api/hive/upgrade-reports`, `hivv_upgrade_reviews` table (migration 017), report-once dedup per (node,sha,action)/24h + known-node-only incidents. CLI: `--show-review`, `--skip-review`, `--force`, `hivv upgrades [--flagged]`, per-sha 24h verdict cache. Stale output-capturing launchers self-heal (`_refresh_wrapper_if_stale`) + `/dev/tty` block-message fallback (old wrapper's `set -e` swallowed non-zero-exit output). Verified live: static-only block (evil.py), brain block + confirm retract, force-apply, skip-review, brainless auto path, dedup, 63/63 node tests | `hivv-cli.py` review engine, `honey-routes.js`, migration 017 | new | | ✅ |
| C12 | ✅ DONE 2026-11-14: **CPU/GPU display** — `_short_cpu` (`Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz` → `i7-10700 @2.9G`), `_short_gpu` (`NVIDIA GeForce RTX 3050` → `RTX 3050 3/6GB 0%`, +N multi-GPU), `_cpu_model` ARM/macOS/Windows fallbacks (`Model`/`Processor`/`Hardware` keys, sysctl, PROCESSOR_IDENTIFIER, uname.machine), `cpu_freq_mhz` now actually collected (sysfs scaling_cur_freq → /proc/cpuinfo cpu MHz) + forwarded by hub (`orchestrator.registerNode`, `control-routes system.cpu_freq_mhz`), humanized heartbeat ages (s/m/h/d instead of `3904253s ago`), empty cpu_model → `?` instead of blank | `hivv-cli.py`, `control-routes.js`, `orchestrator.js` | user report | | ✅ |
| C13 | ✅ DONE 2026-11-14: **masjid 3h-outage post-mortem + fixes** — six chained bugs: (1) `Linger=no` → user manager (and agent) died when the last session closed; (2) daemonizing `hivv start` ExecStart under `Type=simple` → systemd killed the cgroup ~1s in → 10s crash-loop since Sep (restart counter 73+); (3) `cmd_agent` start wrote a FRESH state dict → wiped `node_secret` on every restart/execv → hub (by design) never re-issues to `secret_seen` bees → **inbox 403 forever** (repair/policy/update-push silently dead); (4) startup-register path DISCARDED the hub's `node_secret` response; (5) `GET /api/control/nodes/:id` (public) spread the raw node incl. `secret`+`hw_id`+`token` — defeating node-auth entirely; (6) repair HMAC: hub signed `JSON.stringify(ops)` (insertion order) vs bee `sort_keys=True` → every multi-key (`cli_update`) plan failed. Fixes: agent state merge+atomic write (`read_state`→`{}` + fresh dict was the wipe), linger+unit validation in self-repair (rewrites broken units, enables linger), hw_id-proven secret **re-issue on register** (recovery for already-bricked bees) + startup adoption, credential strip on the public node endpoint, `sortedJson` canonical signer. Plus review calibration: vote-only suspicion (clean static scan) now ALWAYS gets the adversarial confirmation round — two 0.5B brains vetoing on vibes must cite concrete evidence (masjid/yalla false-blocks resolved). Verified: 3/3 bees online+latest, all inboxes HTTP 200, stale plans deliver→reject-stale→report→ack, 63/63 api tests | `hivv-cli.py` (cmd_agent/read_state/cmd_stop/cmd_start/_review_update), `server.js` register, `control-routes.js` nodes/:id, `inbox-routes` (concurrent), `node-auth.js` (concurrent) | | | ✅ |

## D. Known tech debt (AGENTS.md — increasingly load-bearing)

| # | Issue | Why it matters now | Est |
|---|-------|--------------------|-----|
| D1 | ✅ DONE 2026-09-28: honest token counts. `usage-tracker.estimateFromCompletion()`/`static fromUsage()` now prefer the provider's REAL `usage.prompt_tokens`/`completion_tokens`; streaming paths count actual SSE content-chunks (`router.js` local/custom/relay already did; added counting to `providers.js` cloud-stream + `router.js` local-provider-key pipe). Fallback heuristic upgraded from `chars*0.25` to a BPE-ish word/punctuation counter (~2× denser for code/JSON). **Also:** `/api/chat` (the main CLI endpoint) previously logged NOTHING to `usage_logs` — now logs both stream + non-stream (fire-and-forget, no TTFB impact). Verified live: non-stream usage=18/6 exact, stream out=16 measured chunks | honey's "1 per 100 tokens" & all cost reports inherit this | ✅ |
| D7 | ✅ DONE 2026-09-28: `perf.js` flush shipped CUMULATIVE samples/ok/err as deltas → DB counters inflated every 30s (ashy showed 31k phantom errors, 59k samples). Now tracks `fSamples/fOk/fErr` and ships true deltas; migration 010 reset the inflated counters. EWMA tps/latency were already correct (absolute) | routing/dashboard ok-err ratios were garbage | ✅ |
| D8 | ✅ DONE 2026-09-28: migration `010_usage_audit_indexes.sql` — added `idx_usage_logs_visitor` (guest quota COUNT + login-merge UPDATE), `idx_hivv_grants_principal_status` (`hivv approve --list`), `idx_hivv_audit_grant` (grant correlation) + ANALYZE | high-frequency queries were seq-scanning | ✅ |
| D2 | ✅ DONE 2026-09-28: Redis connectivity test only. `npm install redis` in api/; `lib/redis-test.js` with `testConnection()` (PING localhost:6379 or REDIS_URL); `GET /api/health/redis` returns `{status:'not_configured'}` when REDIS_URL absent (correct — sessions remain in-memory). **Sessions migration NOT attempted** per user directive. Future: set REDIS_URL + migrate sessions | `lib/redis-test.js`, `server.js` | sessions still in-memory; connectivity verified | ✅ |
| D3 | ✅ DONE 2026-09-28: `tests/integration.test.js` — 19 smoke tests covering health, policy eight-tuple, capabilities, audit verify, sandbox status, hive goal/timeline/perf/leaderboard, relay stats/volunteers/log-feature/jobs, chat completions, control nodes/metrics, models. All 19 pass against live gateway | `api/tests/integration.test.js` | CI workflow exists for binaries but no test gate | ✅ |
| D4 | Single Node process, no clustering | fine at current load; revisit with growth | 4h |
| D5 | ~~Caddy compression vs SSE~~ ✅ **VERIFIED 2026-09-25:** 54 SSE frames streamed live through `https://hivv.org/api/chat` | fine as-is | — |
| D6 | Orchestrator state in `api/data/nodes.json` + inbox/relay in-memory | gateway restart marks nodes stale; pending relay jobs dropped | — |

## E. Verified-done today (no action — context for next session)

- ✅ LICENSE file added (was missing; README links it)
- ✅ Backlog written + linked from HIVV_PLAN.md / AGENTS.md

- ✅ All syntax checks: 9 JS files, CLI py_compile, both shell installers, dashboard `<script>` block
- ✅ Migration 007 applied to live DB; tables `hivv_node_stats/honey_events/model_perf/relay_jobs/hive_goal` live
- ✅ Honey accruing for all 3 bees (ashy/yalla/masjid), ranks/streak/leaderboard work
- ✅ `X-Hivv-Answered-By` receipts on stream + non-stream; perf EWMA recording real traffic
- ✅ Relay round-trip proven: hub→inbox→agent local Gemma→result posted ("RELAY-OK")
- ✅ Volunteer consent gate FIXED mid-session (capability no longer implies opt-in; only ashy volunteers)
- ✅ `hivv` wrapper execs (live streaming); hive-mind fans out + judges; share cards serve SVG
- ✅ `pm2 save` done; `pm2-asher.service` enabled → survives reboot; hub serves updated files (sha parity checked)
- ✅ All 3 nodes auto-updated to CLI `0.2.d89df64e` via inbox push
- ✅ **Status page accuracy (2026-09-28):** `servedModel` tracked in router returns + all logRequest calls — activity stream shows the actual model served (e.g. `gemma-4-E2B-it-Q4_K_M`), not the stale client-requested name (`gemma-3-27b`). `latency_5m` computed server-side in a true 5-minute window (was: avg of last 6 rows of any age mislabeled "5m"). Nav styled properly (was unstyled raw links). Tokens label honest ("via hub"). `GET /api/public/models` now shows real models from hive bees, not empty provider catalogs.
- ✅ **Database browser (2026-09-28):** `api/routes/database-routes.js` — strict server-side whitelist of 11 public tables. Sensitive tables (users/sessions/keys/audit/usage) → 403. `database.html` renders with no 404s. SQL injection safe (identifiers from whitelist constants only). Limit clamped 1..100.
- ✅ **Honey goal C9:** `_resetGoalIfNeeded()` independent weekly check (no longer lazy — fires even with zero jobs). Title rotation with 12-week cycle. Verified: goal reset to "run more inference than ever before" for week 2026-09-28.
- ✅ **Ops cleanup (2026-09-28):** ghost `llama-server.service` NRestarts cleared (1131→0). 8 orphaned `_agent` processes killed (kept 1 systemd-supervised). `_llama_start_guard` hardened to skip `not-found` units. `pm2 save`d.

## F. hivv OS follow-ups (shipped v1 2026-09-27 — plan in HIVV_CAPABILITY_POLICY_PLAN.md)

| # | Task | Where | Pri | Notes | Est |
|---|------|-------|-----|-------|-----|
| F1 | ✅ DONE 2026-09-28: `_resolveDelegationChain(principal)` resolves agent→parent chains up to HIVV_DELEGATION_MAX_DEPTH (default 3); `gate()` now resolves delegation at start, evaluates policy against `effectivePrincipal`; `delegation_chain` included in audit action; grants keyed to effective principal; audit records immediate actor. `listDelegations()`, `createDelegation()`, `revokeDelegation()` + routes: `GET /api/policy/delegations[?agent=]`, `POST /api/policy/delegations`, `DELETE /api/policy/delegations/:id`. Delegation CRUD verified (create/list/revoke all work) | `api/lib/policy.js`, `routes/policy-routes.js` | 🟡 | | ✅ |
| F2 | ✅ DONE 2026-09-28: MAYBE → PUSH. `policy.setNotifier()` fires on `requestGrant`; server.js broadcasts an `approval_request` into every online node's inbox; CLI `_dispatch_inbox_message` stashes it (`~/.local/share/hivv/approvals.json`) and `hivv up` nudges ("N action(s) await a human"). Verified live: hub log "broadcast to 3 node inbox(es)", agent.log `inbox[approval_request]`, `hivv up` nudge. High-risk caps (coding.execute/financial/physical) now require an ADMIN to approve — self-approve returns 403. **Owner-targeting (2026-09-28):** CLI now sends `x-hivv-node`; the gate threads it to `requestGrant`→notifier, which PUSHes to the OWNER's node inbox first (`pushed to owner inbox ashy`) and only broadcasts to all online nodes when the origin is unknown (web visitors) — verified both paths + once-grant consumption + audit `ok:true` | `api/lib/policy.js`, `api/server.js`, `api/routes/policy-routes.js`, `hivv-cli.py` | — | | ✅ |
| F3 | ✅ DONE 2026-09-28: `coding.execute` sandbox backend. New `api/lib/sandbox.js` (docker preferred → bwrap fallback → refuse): `--network=none` (zero egress), `--memory/--memory-swap` 256m, `--cpus` 0.5, `--pids-limit` 64, `--read-only`+tmpfs, `--cap-drop=ALL`, `no-new-privileges`, default seccomp, `--rm` (ephemeral), hard watchdog timeout (SIGKILL). Gated route `POST /api/sandbox/exec` (+ `GET /api/sandbox/status`), CLI `hivv exec '<code>' [--lang python|bash|node]`. Registry `coding.execute` deny→**ask** (migration 011) so every run is MAYBE→admin-approve→sandboxed→audited. Verified: `print(6*7)`→42, egress blocked (OSError), root read-only, /tmp writable, timeout→exit 137 | `api/lib/sandbox.js`, `api/server.js`, `api/migrations/011_sandbox_exec.sql`, `hivv-cli.py` | — | | ✅ |
| F4 | ✅ DONE 2026-09-28: relay job creation now gated through `policy.gate({capability:'reasoning',principal:visitorId,transport:'relay'})` before creating job; DENY → 403, ASK (no grant) → 202, ALLOW → proceeds. Rate-limit + volunteer-check still apply. Policy check fires before node existence check. | `routes/relay-routes.js`, `lib/policy.js` | 🟡 | | ✅ |
| F5 | ✅ DONE 2026-09-28: `hivv_audit_snapshots` table (year, month, row_count, first_id, last_id, head_hash, signature, created_at); `_getSigningKey()` from HIVV_AUDIT_SIGNING_KEY env (ephemeral fallback); `_signSnapshot()` HMAC-SHA256; `_takeMonthlySnapshot()` snapshots previous month, skips if exists; `_pruneAuditChain()` removes rows older than oldest snapshot (keeps ≥3 months); `startAuditSweep(24h)` wired into `init()`; `GET /api/policy/audit/snapshots` returns snapshots + re-verifies signatures. Gateway logs confirm sweep started. Snapshots endpoint returns empty (fresh chain — correct) | `api/lib/policy.js`, `api/routes/policy-routes.js`, migration 014 | 🟡 | | ✅ |
| F6 | WHEN/WHERE/DATA-redaction rules: stored in schema, evaluator still ignores (by design, v1) | `policy.js` `_ruleMatches` | ⚪ | don't build until asked | — |
| F7 | ✅ DONE 2026-09-28: tools-share survives restarts. Agent re-announces `tools`+`tools_port` in EVERY register + heartbeat (`_shared_tools()` probes the local server); hub `registerNode` preserves prior tools when a re-register omits them and `updateHeartbeat` applies them (empty array = un-share). Verified: all 3 bees (ashy/yalla/masjid) now advertise time/calculate/fetch/search/sysinfo; `web.fetch` routes to a node and returns data (was 404). Also hardened `toolToCap`: unknown tools no longer default to allow-tier `local.computation` — they map to `tool.<name>` → resolve null → MAYBE; explicit coding.execute/exec/shell/run→coding.execute | `hivv-cli.py`, `api/lib/orchestrator.js`, `api/lib/capabilities.js` | — | | ✅ |
| F8 | ✅ DONE 2026-09-27: perf split by transport (`hivv_model_perf.via`, migration 009) — relay tps (which includes queue+poll wait) no longer poisons direct routing; bees self-report direct throughput (`POST /api/hive/perf-report`, ≥8-token samples only); CLI lottery = sqrt-weighted Efraimidis-Spirakis over direct rows, relay-only & recently-failed bees deprioritized, self-node → 127.0.0.1. Fixed ashy 5.5→46 t/s mislabel; fixed legacy empty-answer swallow in direct non-stream path | `perf.js`/`router.js`/`honey-routes.js`/CLI | — | — | ✅ |
| F9 | OPS: yalla's ollama refuses LAN (11434 closed to hub) — set `OLLAMA_HOST=0.0.0.0` + `hivv firewall --apply --mode lan` on yalla; until then hive treats it relay-only (correct behavior) | yalla box | 🟠 | user action | 5m |
| F10 | ✅ DONE 2026-09-28: routing-honesty fixes. (a) `_scoreTargets` skips error-only perf rows (`ok===0`) and `latency<=0` — a dead bee's 0ms/0tps row no longer wins `mode=fast` (was scoring yalla 403 on a failed direct probe). (b) `perf.record` seeds EWMA on first SUCCESS, not first sample, so a leading error can't drag tps/lat toward 0. (c) direct-local latency clock starts BEFORE `await fetch` — non-streaming completions were recording `latency_ms=0` (fetch resolves post-generation), so genuinely-fast localhost looked "unknown" to fast-mode; now records real ~225ms. (d) `X-Hivv-Policy` receipt header added to BOTH non-streaming chat paths (`/v1/chat/completions`, `/api/chat`) — was stream-only. Verified: fast-mode dry-run now ranks measured localhost (score 89) above unmeasured/error bees | `api/lib/router.js`, `api/lib/perf.js`, `api/server.js` | — | — | ✅ |

## Suggested next session order

1. A1→A2 (GitHub + first tagged release) → unblocks A5/A6, then A8 frozen self-update can be tested for real
2. A7 Windows VM test
3. C5 bee-card PNG + consent
4. D2 Redis sessions (set REDIS_URL + migrate sessions)
5. D4 clustering (when load demands it)
6. D6 orchestrator state persistence (nodes.json + relay in-memory → DB)

*(B1, B2, B4, C1, D5, LICENSE — closed 2026-09-25. B3, C3, C8, C9, C2, C4, D1, D2, D3, D7, D8, F1, F2, F3, F4, F5, F7, F8, F10 — closed 2026-09-28.)*

## G. Ops cleanup done 2026-09-28 (this session)

- **Phase-1 streaming audit (no change needed):** wrapper `exec`s (no buffering), CLI flushes per token on both direct + hub SSE paths, Express `compression` skips SSE/chat, Caddy `flush_interval -1` on all `/api`,`/v1`,`/stream` proxies (no `encode`). Measured live: TTFB 40–55ms through `https://hivv.org`, tokens stream frame-by-frame.
- **Duplicate agent processes:** found **9** `hivv-cli.py _agent` procs on ashy — 1 legit (systemd user `hivv-agent.service` Main PID) + **8 orphans (ppid=1)** from a ~20h-old restart storm, causing the repeated `[ORCH] Node re-registered: ashy` + duplicate inbox polls. Killed the 8 (graceful SIGTERM), restarted the unit → single clean agent, `agent.pid` == systemd MainPID, NRestarts=0.
- **Ghost `llama-server.service`:** system-scope duplicate was `not-found/inactive/dead` but systemd still held `NRestarts=1131` from a past port-war crash-loop (the exact AGENTS.md "never duplicate system-scope" failure). Cleared via `reset-failed`+`daemon-reload` (→0). Canonical user-scope `llama.service` healthy on 127.0.0.1:8080 (/health 200). Hardened CLI `_llama_start_guard` to skip `not-found` units so doctor stops falsely reporting "✓ started" for ghosts.
- **Smoke check:** `pm2 save`d (12 online); ports 3011/8080(localhost)/5432/443 correct; `GET /api/policy/audit/verify` → `{"ok":true}` (64 rows) via localhost AND public HTTPS after all gated sandbox/approval tests.

## H. Live Command Center upgrade (2026-09-28, this session)

Backend: new `GET /api/hive/timeline?hours=N` (`honey-routes.js`) — aggregated time-series from
`usage_logs` (requests, tokens, p50/p95, avg tps, success% per bucket + model/endpoint mix + totals),
cached 20s, public, no PII. Bucket size auto (minute/hour/day, ≤~120 points).

Frontend (`command-center.html`, reuses Chart.js/D3/Leaflet + existing design tokens):
- Overview: **live pulse strip** (5 animated count-up KPIs), **live request ticker** (deduped slide-in
  from `/api/public/activity`, 5s), real **throughput** (req bars + tokens line), **latency p50/p95**,
  **model-mix donut**.
- Hive: **goal radial ring** + animated bar, **bee speed-race** (measured t/s), **honey-bar leaderboard**.
- Policy: **verdict-mix donut**, **hash-chain visualizer** (linked audit blocks, head pulses, "✓ N linked").
- Nodes: **GPU wall** (radial util gauges + VRAM bars + temp), live-refresh while visible.
- Health/Costs: fixed the two canvases that were never initialized (health history + tokens/model bars).
- Fixed pre-existing null-ref (`m-tokens` cards removed but still referenced); p95 KPI = latest bucket tail.

Verified headless (Chromium/Playwright): **0 page errors**, all 6 charts render, ticker/race/gauges/chain
populate with real data across overview/nodes/hive/policy/health/costs.

## I. Access tiers & free-area economy (2026-11-14 — plan in HIVV_ACCESS_PLAN.md)

> Vision: every node serves a FREE hive tier + OWNER private keys; busy → free refused,
> private prioritized; owners can SELL private access; owners visualize + cap the free
> area (LLM time / GPU / CPU). yalla's keyed-LLM incident (same day) proved the rule:
> access policy belongs in the shim, never in llama itself.

| # | Task | Phase | Pri | Notes | Est |
|---|------|-------|-----|-------|-----|
| I0 | yalla bridge: agent key-file auth (detect + local brains) + hub `ai_keys` attach in `getAllEndpoints` | P0 | 🟠 | the "B path" from the yalla discussion; unblocks yalla's GPUs/votes without removing asher's key | 2–3h |
| I1 | hive-free credential: hub-signed rotating token pushed via inbox (HMAC/ttl/revocable, repair-plan pattern); `free:` principal class in policy | P1 | 🟡 | every bee holds it → R1/R5 | 1d |
| I2 | shim admission: free budget + busy watermark → `429` for free tier; router busy-skip (extend relay `node busy` to direct path) | P1 | 🟡 | R2; heartbeat already carries available_capacity/active_jobs | 1d |
| I3 | `hivv serve` CLI knobs + Command Center **free-area panel** (per-bee budget bar, busy state) + `hivv node` quota line | P2 | 🟡 | R4; reuses dashboard tokens/charts | 1d |
| I4 | private keys: `hivv key issue <who> --quota --priority [--price]` · ai_keys rows · shim enforcement · policy audit-chain on issuance | P3 | ⚪ | R2/R3 | 1–2d |
| I5 | sell access: hub marketplace listing + honey spend/earn ledger (honey v2) + owner earnings dashboard | P4 | ⚪ | R3; honey-only for v1 (no payment processing) | 2–3d |

Decisions blocking I1/I2 defaults: D1 honey-only currency? · D2 free default budget ·
D3 private-under-load floor · D4 anonymous stays hub-relayed-only · D5 land the access
gate in the active `hivv dial` codepath (other session), don't fork — see plan §6.
