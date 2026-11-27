# HIVV — Personal Models & Scoped Access: YOUR gemma, YOUR muse, free, and only when YOU talk

> Researched 2026-11-26/27. The ask: *"connect my personal gemma / chatgpt muse to hivv.org —
> I'm not using a paid plan so it needs to just work, and it must only take effect when I'm
> talking with hivv.org, not others."*
>
> **This doc is the ledger of what's POSSIBLE, what's PRIVATE, what LEAKS, and the fixes.**
> Task tracking: `HIVV_BACKLOG.md` §J. Companion context: `HIVV_ACCESS_PLAN.md` (free-tier
> economy for BEES), `HIVV_ROUTING_PLAN.md` (the factor vector).

## 1. The three constraints

1. **FREE** — no paid plan, no card, nothing that expires in 30 days.
2. **JUST WORKS** — no fragile browser hacks, no ToS violations, no break-on-deploy.
3. **SCOPED TO ME** — my model/key/persona is used when *I* talk to hivv.org; nobody else's
   traffic spends it, and my non-hivv usage is untouched.

## 2. What's possible — the free landscape (2026-11 snapshot)

### ChatGPT free plan → ❌ NO DOOR EXISTS

- **The free plan has zero API access.** ChatGPT plans and the OpenAI API are separate products
  with separate billing (OpenAI help center): no plan — free *or* paid — includes API usage.
- **No standing free API tier.** The $5 trial credit was phased out for most new accounts in
  mid-2025; new API accounts start at $0 balance and must prepay. (The only official credits are
  the API-credits benefit for *paid* Pro/Business subscribers.)
- The only "free ChatGPT API" routes are **browser-automation bridges** (Playwright driving
  chatgpt.com) — against OpenAI's ToS and broken by every UI change. **Rejected: fails JUST WORKS.**

### Gemma → ✅ TWO WORKING DOORS

| Door | What | Cost | Privacy |
|---|---|---|---|
| **Local** | `hivv llm setup` → llama.cpp, default `gemma-4:e2b` on `:8080` | Free forever, unlimited | Fully yours — prompts never leave the box |
| **Google AI Studio free tier** | Gemma models are **free-only, no card** (e.g. `gemma-4-31b-it`, `gemma-4-26b-a4b-it`), OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai/` | $0, rate-limited per project (limits shown in AI Studio) | ⚠️ free tier may be used to train Google's products (except EEA/UK/CH) |

### Free cloud backups (all card-free, OpenAI-compatible)

| Provider | Free allowance | Notes |
|---|---|---|
| Groq | ~30 rpm / 1,000 req/day | fastest open-weights inference; no training |
| OpenRouter `:free` models | 20 rpm / 50 req/day | one key, many models; **no** training on prompts |
| Cerebras | ~30 rpm / ~1M tok/day equiv. | throughput |
| GitHub Models | per-model limits | broad mix incl. OpenAI models |
| Mistral Experiment | generous | phone verification required |

*(Limits are 2026-11 figures and move — treat as "exists and is free", not as a contract.)*

## 3. The three doors a personal model has INTO hivv.org

| Door | How | Scoped to me? |
|---|---|---|
| **Registered node** (`hivv start`) | heartbeat advertises `local_models` → `getAllEndpoints()` (router.js:1248–1274) makes them candidates **for every user's request** | ❌ **Donation-by-default** — `volunteer off` gates relay/coding ONLY, not direct routing. Partial mitigation: llama bound to `127.0.0.1` + `volunteer off` → remote direct refused + relay refused, while asking *your own bee* swaps to `127.0.0.1` |
| **`HIVV_LOCAL_ENDPOINTS`** | read from the **gateway's** env (router.js:280) | ❌ Operator-only — a remote user cannot set it for hivv.org |
| **Client-side** | `hivv chat --local` · `hivv dial --pin <node>` · OpenCode provider → `http://127.0.0.1:8080/v1` · own local gateway (`HIVV_MODE=local`) | ✅ Fully yours — and `hivv setup` never rewrites a non-HIVV baseURL, so your other tools are untouched |

## 4. Already private — no work needed

- **Your muse persona** ✅ — `public_html/chat/app.js:311–365, 459–469`: the persona LIST lives
  in `localStorage` only; per message only the active persona's prompt travels as the system
  message; the hub stores SHA-256 digests/byte counts, never raw prompts.
- **Per-user policy defaults** ✅ — `PUT /api/policy` writes only your own principal
  (policy-routes.js:215–242); grants are per-principal (policy.js:148–190).
- **Per-user quota + attribution** ✅ — visitor/session identity (server.js:2350–2362, 2878–2896).

## 5. The leaks (measured — file:line)

| # | Leak | Severity | Status |
|---|------|----------|--------|
| **P1** | **`selectKey` fallback dropped ownership** — `candidates = keys.filter(k => k.key.isAvailable())` (router.js:1175) discarded the `userId`/`isShared` AND model filters, so a private key (`user_id` set, `is_shared=false`) became the catch-all for **other users and anonymous visitors** whenever their filtered set was empty | 🔴 | ✅ **FIXED 2026-11-27** (K1) |
| **P2** | **`hivv add` donates to the hive** — `/api/keys/donate` writes `user_id = NULL` and printed *"available to the network"*; hive-shared **by design**, but never warned | 🟠 | ✅ **FIXED 2026-11-27** (K2): the response and the CLI now say **SHARED — every bee can spend it** + the caps + the `--personal` way out |
| **P3** | **Donating an `endpoint` rewrote the shared `ai_providers.default_endpoint`** — one donor redirected *every* key of that provider for *all* users | 🟠 | ✅ **FIXED 2026-11-27** (K2): endpoint stored per-key on `ai_keys.api_endpoint`; the shared-row UPDATE is gone |
| **P4** | **`api/lib/key-donation.js` guard-rails were dead code** — SSRF check, spend caps (120 req/h, 200k tok/day), donor limit (5/day) exported but never called | 🟠 | ✅ **FIXED 2026-11-27** (K2): all wired into `POST /api/keys/donate`, and the caps are now **enforced at key selection** (`keyOverBudget()` windows) |
| **P7** | **The gateway had an EMPTY `HIVV_ENCRYPTION_KEY`** (no `api/.encryption-key`, pm2 dump `''`) — `encryptKey()` threw, so **every key-write path was broken** (found while testing K2) | 🔴 | ✅ **FIXED 2026-11-27**: key file generated (0600, gitignored), restarted via `ecosystem.config.js --env production`, `pm2 save` + dump chmod 600. ⚠ one pre-existing `ai_keys` row was encrypted under the lost key and stays undecryptable — its owner must re-add it |
| **P5** | **Registered-node models are hive-wide regardless of `volunteer`** (router.js:1248–1274), and `GET /api/control/nodes` is public with `ip`/`lan_ip`/models (control-routes.js:156); `visibility: private` is display-only | 🟡 | J5 (policy decision) |
| **P6** | **`--mode=private` ≠ only-mine** — maps to `privacy:'hive'` = *any registered bee*; the CLI direct step ignores mode until hub fallback; no per-user route default existed | 🟡→🟢 | ✅ **HUB SIDE FIXED 2026-11-27** (K3+K4): stored per-principal defaults + `privacy: 'self'` enforcement. **Remaining**: the CLI's OWN direct step (it contacts bees from your machine before consulting the hub) still ignores prefs — a client-side follow-up if you want `hivv chat` itself to skip the direct step under `self` |

## 6. The four key ideas (the roadmap — tracked in backlog §J)

| # | Idea | Status |
|---|------|--------|
| **K1** | **Fix `selectKey` fallback** — relax the MODEL pin only, never ownership | ✅ DONE 2026-11-27 — `api/lib/router.js` + `api/tests/key-isolation.test.js` (10) |
| **K2** | **Honest + guarded donation** — wire `key-donation.js` (SSRF/caps), make `hivv add` say *"everyone can spend this"*, add `--personal` (binds a verified identity), stop mutating the shared `default_endpoint` | ✅ DONE 2026-11-27 — see backlog J2 for the full ledger; migration `036_ai_keys_principal.sql` adds the `principal` binding column |
| **K3** | **Per-principal route defaults** — stored per verified identity, applied per-field (explicit always wins) | ✅ DONE 2026-11-27 — `gateway_config.routing.principal_defaults` · `GET/PUT /api/prefs` · `hivv prefs` (backlog J3) |
| **K4** | **`privacy: 'self'`** — candidates filtered to hub-local + the caller's own bees: the literal *"only when I talk"* switch | ✅ DONE 2026-11-27 — enforced in `tryLocalAI` · `_tryRelay` · cloud gate; ownership = proven node scope ∪ `prefs {self_nodes}` claims (backlog J4) |

## 7. The safe recipe TODAY (before K2–K4 land)

1. **Your Gemma stays local.** Either don't register the box, or register with llama bound to
   `127.0.0.1` + `hivv volunteer off` (remote direct refused, relay refused, you still get answered).
2. **Talk to it your way:** `hivv chat --local` (offline, this box only) · `hivv dial --pin` ·
   your own OpenCode provider entry → `http://127.0.0.1:8080/v1`.
3. **Attach a free cloud key with `hivv add <provider> <key> --personal`** (K2 shipped) — it binds
   to your verified identity (login · signed cookie · your bee's node secret) and ONLY your requests
   can spend it. Without `--personal` it's still a **donation** — now one that says so, with caps.
   (Client-side-only still works too: point a local gateway / OpenCode at the key directly.)
4. **THE ONE SWITCH — `hivv prefs privacy self`** (K3+K4 shipped): every chat you make from that
   identity defaults to `self` — only your own bees + the hub's local model may answer; every other
   bee and ALL cloud providers are hard-filtered out. Add `hivv prefs self <bee>` to claim bees you
   run on other machines, and `hivv prefs set fast` for a default speed bias. An explicit `--mode`
   on any single chat still wins — a pref is a default, never a handcuff. `hivv prefs clear` undoes
   everything.
4. **Your muse stays a chat-UI persona** — already browser-local, already private.
5. **After K1 (shipped):** keys attached through the *authenticated* path (`POST /api/keys`,
   session-bound `user_id`) are genuinely yours — other users and anonymous visitors can no
   longer spend them via the fallback.

## 8. Evidence

- `api/tests/key-isolation.test.js` — 10 tests: stranger/anonymous → null · owner → own key ·
  model-pin fallback works for the owner and does NOT leak · donated + `is_shared` stay hive-wide ·
  mixed pool never hands out a stranger's private key · unavailable keys skipped · foreign-only
  pool → null. **All green** post-fix; neighbouring suites `route-factors` + `traffic-count` (48)
  green.
- `tests/TESTMAP.json` regenerated (86 test files) · `tests/test_testmap.py` → 15 passed.

**K2 evidence (2026-11-27):** `api/tests/key-donation.test.js` (15 — validation matrix with the
SSRF check mocked, donor-limit, personal-vs-donation caps, spend windows, **5 LIVE zero-write
rejection probes against the running gateway**) · `tests/test_add_personal.py` (5 — flag on both
spellings, the SHARED warning, the personal confirmation, the 401 hint, the interactive menu) ·
`key-isolation.test.js` → 16 (10 K1 + scope bindings, multi-scope login-after-bind, spoof-proofing, budget) ·
full `cd api && node --test` → **520/520** · live happy paths: donation returns caps + honest
message, `hivv add --personal` from this box binds `node:ashy`, DB row shapes verified
(`principal='node:ashy'` / donated row `principal NULL` + caps), test rows deleted, live chat still
streams with `X-Hivv-Answered-By` + `X-Hivv-Policy` receipts.

**K3+K4 evidence (2026-11-27):** `api/tests/route-prefs.test.js` (12 — default lookup strongest-first
+ garbage-ignored, routeWithFailover application with explicit-wins/per-field, selfAllowedNodes,
filterSelfTargets, preview self-vs-any contrast, **4 LIVE**: NO_IDENTITY, signed-cookie round-trip
set→read→clear, 400-without-body, `?privacy=self` dry-run) · `tests/test_prefs_cli.py` (10 — dispatch
never chats, offline help, exact bodies for every action, NO_IDENTITY hint, unknown action dies
with usage) · **LIVE enforcement**: a cookie-scoped `privacy=self` pref turned an ordinary chat into
`localhost/gemma-4-E2B-it-Q4_K_M (direct)` — the usual masjid/yalla answer was unreachable — then
the pref was cleared · **LIVE CLI**: `hivv prefs` show/set/clear through https://hivv.org as
`node:ashy` · full `node --test` **538/540** (the 2 non-passing belong to the concurrent session's
live e2e + a gateway-restart-window flake, both green in isolation: tile 11/11) · TESTMAP fresh
(91 test files) · scanner CLEAN.
