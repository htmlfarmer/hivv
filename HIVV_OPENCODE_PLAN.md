# HIVV.org × OpenCode — Integration Plan

> **The idea:** OpenCode is the coding-agent harness; hivv.org is the routing brain.
> Wire them together in four layers: **A** OpenCode uses hivv as its model provider (the hive
> routes every coding session) · **B** hivv ships an MCP server (agents get hive tools) ·
> **C** hivv ships a skill (agents learn the `hivv` CLI) · **D** hivv dispatches jobs *to*
> OpenCode running on nodes (coder bees). A→B→C make OpenCode a first-class hivv client;
> D makes OpenCode part of the hive itself.
> Written 2026-11-14, after reading the OpenCode V2 docs (opencode.ai/docs) and the hivv
> gateway code. Status legend: ☐ not started · ◐ in progress · ☑ done
>
> **2026-11-14 — A, B, C SHIPPED & VERIFIED.** Live proof: a real OpenCode session with the
> `hivv` provider completed a full **tool-calling loop** (model emitted `shell` tool_calls →
> streamed through the hub → executed → answered), in BOTH plain and hivv-framed modes.
> MCP live at `https://hivv.org/mcp` (`opencode mcp list` → `✓ hivv connected`; six tools
> `chat, route, nodes, search, news, honey` — verified through Caddy + exercised from inside
> an OpenCode session). Skills live: `/.well-known/skills/hivv/SKILL.md` (200) + repo-local
> `.opencode/skills/hivv/SKILL.md`. Gateway conformance fixes A1–A5 all in (`tools`/`tool_choice`
> passthrough everywhere incl. relay, Bearer→principal, tool-capable candidate filter with
> unfiltered fallback, relay `tool_calls` preservation, `auto/smart/fast/cheap/private` model
> aliases that double as route modes for ANY OpenAI client).
>
> **Two latent SSE bugs found & fixed during e2e (they broke EVERY strict OpenAI client):**
> 1. **No event separators** — the hub forwarded backend SSE lines with single `\n`, but SSE
>    events end at a BLANK line. Lenient clients (our CLI/chat UI parse `data:` lines by hand)
>    never noticed; spec decoders (OpenCode, OpenAI SDKs) saw ONE giant event of concatenated
>    JSON. Fixed: every frame now written `\n\n` (`router.js` emitLine).
> 2. **No line buffering** — lines split across TCP reads were re-emitted with an injected
>    `\n`, corrupting JSON mid-frame (the `finish_reason` chunk is the usual victim →
>    "stream ended without finish_reason"). Fixed: partial-line buffer across reads.
> Plus: direct path now terminates with `data: [DONE]` (never sent one!), the `hivv_stats`
> frame moved to top-level (`finish_reason:"stats"` is not a legal OpenAI enum — strict parsers
> rejected it; consumers in chat/app.js + index.html accept both shapes), and an opt-in
> `X-Hivv-Plain: 1` request header suppresses hivv's custom frames entirely.
>
> **Design law #5 — the harness is a first-class client.** OpenAI-shaped `/v1/*` is the
> contract; every gap that makes a real OpenAI client degrade silently (dropped `tools`,
> ignored auth, malformed SSE) is a bug for *all* clients, not just OpenCode. Fix them at the
> gateway.
>
> **Design law #6 — no routing loops.** A coder bee whose OpenCode points back at hivv must
> not have its requests re-dispatched to another coder bee. Node-side OpenCode defaults to
> `private` mode (local model first); hub-side dispatch tags jobs `capability: coding` so the
> policy gate can refuse re-entry. See §4.
>
> Depends on [`HIVV_ROUTING_PLAN.md`](HIVV_ROUTING_PLAN.md) (the route brain) — A is its
> first high-volume traffic source; D is its `coding` bucket's deepest capability.

---

## 0. Integration map

| # | Direction | What it gives hivv | Size |
|---|---|---|---|
| **A** | OpenCode → hivv provider (`opencode.jsonc` snippet) | coding traffic through the route brain; receipts visible in sessions; real OpenAI-client conformance fixes | M |
| **B** | hivv → MCP server (`opencode mcp add hivv --url …`) | any MCP client (OpenCode, Claude Code, etc.) gets hive tools: chat, route explain, nodes, search | M |
| **C** | hivv → skill (`https://hivv.org/.well-known/skills/`) | agents self-serve the `hivv` CLI; near-zero cost | S |
| **D** | hivv → dispatch `coding_job` to nodes' OpenCode | hive becomes a network of *working agents*, not just inference | L |

### What OpenCode needs from an OpenAI-compatible endpoint (from V2 docs)
- `POST /v1/chat/completions` with **`tools` + `tool_choice` in, `tool_calls` out**, `stream: true` SSE.
- `Authorization: Bearer <key>` (from provider `env`), `settings.baseURL` incl. `/v1`.
- Model IDs declared in config (`models` map; `modelID` sent on the wire; per-model `body` merges JSON — **mode aliases for free**).
- Generous timeouts (5 min headers / 15 min between chunks — hivv's relay buffer fits).
- `/v1/models` exists (`server.js:2345`) but lists provider names, not useful aliases.

---

## 1. ☑ A — hivv as an OpenCode provider (shipped 2026-11-14)

### Gap fixes (gateway side — these are conformance bugs regardless of OpenCode)

| # | Gap | Where | Fix |
|---|---|---|---|
| A1 | 🔴 `/v1/chat/completions` drops `tools`/`tool_choice` (destructure omits them; only `/api/chat` handles tools) | `server.js:1805` | add `tools, tool_choice` to destructure, forward into `gen`/options exactly like `/api/chat` (line 1968→2221); non-streaming path already returns `tool_calls` via `chatCompletion` (router.js:1253) |
| A2 | 🔴 No Bearer auth — `Authorization: Bearer` ignored, IP rate-limit only | `server.js:1803` | optional middleware: resolve `ai_keys`/`users.api_key` → `principal: user:<id>` (feeds quota + usage_logs); invalid key ⇒ 401 only if header *present*; absent ⇒ visitor as today (back-compat) |
| A3 | 🟡 Requests carrying `tools` route to candidates that can't call tools | `router.js _scoreTargets` / `getAllEndpoints` | hard filter: `options.tools` present ⇒ candidate must advertise tool support (new derived cap `tool_use` from model metadata / provider catalog); never silently drop `tools` when falling back |
| A4 | 🟡 Relay path loses `tool_calls` (agent returns `{content, model}` only) | `relay.js` result schema + `hivv-cli.py _run_relay_job` | include `tool_calls` + `finish_reason` in result payload; router already wraps them as frames (router.js:805) |
| A5 | 🟢 `/v1/models` lists provider names | `server.js:2345` | append alias entries `auto, smart, cheap, fast, private` (`owned_by: "hivv"`) so any OpenAI client sees them |
| A6 | 🟢 Verify streaming `tool_calls` deltas pass through untouched (frames are passed unless `reasoning_content` strip) | `router.js:735–812` | test with a real OpenCode session; fix only if a sanitizer eats them |

### Client side — ship a ready snippet (`public_html/opencode-hivv.jsonc` + docs)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "hivv": {
      "name": "HIVV",
      "env": ["HIVV_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://hivv.org/v1" },
      "models": {
        "auto":    { "name": "HIVV Auto",    "capabilities": { "tools": true } },
        "smart":   { "modelID": "auto", "name": "HIVV Smart",
                     "body": { "route": { "mode": "quality" } },  "capabilities": { "tools": true } },
        "fast":    { "modelID": "auto", "name": "HIVV Fast",
                     "body": { "route": { "mode": "fast" } },     "capabilities": { "tools": true } },
        "cheap":   { "modelID": "auto", "name": "HIVV Cheap",
                     "body": { "route": { "mode": "cost" } },     "capabilities": { "tools": true } },
        "private": { "modelID": "auto", "name": "HIVV Private",
                     "body": { "route": { "mode": "private" } },  "capabilities": { "tools": true } }
      }
    }
  },
  "model": "hivv/auto"
}
```

Notes:
- Per-model `body` merge ⇒ **routing modes become model aliases** — zero protocol change.
- `capabilities.tools: true` declares tool support so OpenCode enables its tool loop; A3 makes
  the hub honor it by only routing to tool-capable candidates.
- Receipts: `X-Hivv-Answered-By` / (route brain) `X-Hivv-Route` headers on every response —
  visible in OpenCode logs: *"this refactor was written by gpu-01/gemma (relay), p_wise 0.91"*.
- **Loop guard:** when hivv is reached *from* a node (A2 principal = `node:<id>`), force
  `route.mode` ≥ `private` (local/hive only) unless explicitly overridden — see design law #6.

**Steps:** A1 → A2 → A3 → A4 (small PRs, each testable with `curl` + `hivv chat`) → A5/A6 →
paste snippet into `public_html/` + `api.html` docs → run a real OpenCode session against
`hivv/auto` doing a multi-tool task.
**Done when:** an OpenCode session configured with the snippet completes a tool-using task
(Read/Edit/shell loop) with answers coming from ≥2 different hive nodes across turns, and
`X-Hivv-Answered-By` proves it. **Effort:** M (1–1.5 days)

---

## 2. ☑ B — hivv MCP server (shipped 2026-11-14)

Remote **Streamable HTTP** endpoint at `https://hivv.org/mcp` (Caddy route → Express), using
`@modelcontextprotocol/sdk` (stateless transport per request — no session store needed).

**Tools (v1, short names — OpenCode normalizes to `tools.hivv_*`):**

| Tool | Args | Backed by |
|---|---|---|
| `chat` | `messages[]`, `mode?` | `router.chatCompletion` — same policy gate, returns content + `answered_by` + `route` receipts |
| `route` | `query`, `mode?` | `router.routePreview` dry-run — *"who would answer & why"* |
| `nodes` | — | `GET /api/control/nodes` (public subset: name, rank, models, online) |
| `search` / `news` | `q`, `location?` | hivv-tools via existing `/api/tools/:tool/invoke` |
| `honey` | `node?` | `/api/hive/leaderboard` |

**Auth:** `oauth:false` + `Authorization: Bearer {env:HIVV_API_KEY}` (docs pattern); keyless
calls allowed at visitor tier (existing 60 req/min IP limit applies). Policy gate on `chat`
identical to HTTP path — MCP is a transport, not a bypass (design law #1 from the capability plan).
**Steps:** MCP route + SDK dep → tools wrapping existing router/lib calls → Caddy handle →
`opencode mcp add hivv --url https://hivv.org/mcp` end-to-end test → docs.
**Done when:** `opencode mcp list` shows `hivv connected` and an agent answers "which node
would solve this and why?" via `hivv_route` without any code changes to the agent.
**Effort:** M (1–1.5 days)

---

## 3. ☑ C — hivv skill for OpenCode (shipped 2026-11-14)

Serve `https://hivv.org/.well-known/skills/hivv/SKILL.md` (static, from `public_html/`), opted
into via `skills: ["https://hivv.org/.well-known/skills/"]` in `opencode.jsonc`.

**SKILL.md outline (~150 lines):**
- **When to use:** user has `hivv` CLI / wants to ask AI cheaply / wants hive status.
- **Core loop:** `hivv chat "…" --mode=smart|fast|cheap|private` · `hivv route "…"` (explain
  before you ask) · `hivv nodes` / `hivv reach <name>` · `hivv test` (doctor).
- **Receipts:** explain `X-Hivv-Answered-By` / `X-Hivv-Route` — how to tell which bee answered.
- **Install:** `curl -fsSL https://hivv.org/install-hivv.sh | sh` if missing.
- **Hive context:** honey/ranks (`hivv honey --board`), relay/volunteer, capability/policy
  (`hivv cap`, `hivv policy`) so agents don't trip MAYBE flows.

Also ship `.opencode/skills/hivv/SKILL.md` **in this repo** (auto-discovered) so agents working
on hivv itself know the toolchain — dogfood.
**Done when:** a fresh OpenCode + `skills` config answers "run a health check on my hive node"
by discovering and running the right `hivv` subcommand. **Effort:** S (0.5 day)

---

## 4. ☑ D — coder bees: dispatch `coding_job` to nodes running OpenCode (shipped 2026-11-14)

## 5. ☑ E — dial shim: direct-to-bee data plane (shipped 2026-11-14)

> "Most connections focus on connecting to a specific model, not hivv — hivv only for
> quick checks: speed, quality, distribution." — that IS this section.

- `hivv dial [--port 3911] [--pin NODE|URL]` — localhost OpenAI-compatible shim (stdlib).
  First request sync-dials `POST /api/route/dial` (scored candidates + stick keys + tickets +
  always-last `transport: hub` fallback); every request then forwards **straight to the bee**
  with EOF-framed pass-through; each completion fires async `POST /api/route/report`
  (perf + warm-sticky) — the control plane never sits in the hot path.
- **Sticky-until-broken**: cache is stale-while-revalidate — connections stick to their
  specific bee; re-dials run in the background (verified: 0.16s serve + same-second hub dial).
  Total failure → background heal re-dial; `--pin` locks one bee (no rotation/fallback).
- Dial-side: hostname match decides whether hub-local `localhost` endpoints may be included;
  tools filter mirrors the chat path; shim id = `sha1(user@host)[:12]`.
- Hub-side fixes shipped with it: discovery stores the REAL model id (placeholder `local`
  failed the tool allowlist → hub-local was invisible to OpenCode), `/v1/models` probe URLs
  normalized to chat endpoints at registration, this-box node duplicates deduped
  (`ashy:8090` ≡ `localhost:8090`), perf guard for tps-less reports.

**Effort:** ~1 day total (hub routes + shim + 5 bug fixes found by testing).

The flip: hivv queues work *into* nodes (same inbox/HRP machinery as relay), and the node's
OpenCode executes it headless.

### Protocol (extends HRP from the routing plan)

| Type | Direction | Payload |
|---|---|---|
| `coding_job` | hub → inbox | `{job_id, secret, task, repo:{clone_url, ref, subdir?}, constraints:{timeout_s, max_patch_bytes, allowed_paths[]}, model_hint?}` |
| (result) | node → `POST /api/relay/jobs/:id/result` (reuse!) | `{secret, result:{status, summary, patch, files_changed[], tests_run, tests_passed, opencode_session_id}}` |
| `coding_progress` | node → hub (heartbeat ext. or `POST …/progress`) | `{job_id, step, files_touched}` — feeds Command Center ticker |

### Mechanics
1. **Entry:** `POST /api/coding/jobs` (policy gate `coding` capability, tier `side-effect`+)
   or model-routed automatically when the route brain's verdict says a *task* (repo diff,
   failing tests) beats a *chat* — v1: explicit endpoint only.
2. **Dispatch:** like `relay.createJob` — pick volunteers with `coding` cap (node advertises
   `opencode` in heartbeat `tools`), enqueue `coding_job`, 2 active/job cap, TTL, HMAC secret.
3. **Node side (`hivv-cli.py`):** new `_run_coding_job` — clone/fetch repo into a job-scoped
   worktree, write task to `AGENTS.md`-style prompt, run `opencode run --format json "<task>"`
   (headless CLI; SDK alternative), capture summary + `git diff` → post result. Refuse if repo
   not on allowlist or disk/time budget exceeded.
4. **Security (non-negotiable):** repo allowlist per node (`hivv volunteer coding --repo <url>`),
   job worktrees never the user's checkout, network egress left to OpenCode's own permissions,
   hub-side policy gate + audit hash-chain entries like any capability, patch size caps,
   `opencode` runs with the node's *own* model config — default `private` mode (design law #6).
5. **Economy:** usage_logs `feature='coding_job'`, honey mints from hub-observed tokens +
   completed jobs, receipt `X-Hivv-Answered-By: node/opencode (relay-coding)`.
6. **Routing brain tie-in:** verdicts for `bucket: code-task` gain an outcome signal — did the
   patch pass its tests? (`tests_passed/tests_total` from the result = objective ground truth
   for `p_wise`, better than any passive signal in the routing plan.)

**Steps:** job schema + dispatch (hub) → agent runner (node, `opencode run`) → result/progress
path → policy + audit + allowlist → honey/usage → Command Center view → route-brain hookup
(bucket `code-task`).
**Done when:** `hivv code "fix the failing test in foo.py" --repo <url>` returns a passing
patch produced by some other machine's OpenCode, audited and honeyed.
**Effort:** L (3–4 days) — deliberately last; depends on A (dogfooding) and HRP (routing plan P3).

---

## 5. Phasing

| Order | Work | Effort | Unlocks |
|---|---|---|---|
| 1 | **A1–A4** conformance fixes (tools, auth, tool-routing, relay tool_calls) | 1–1.5d | any serious OpenAI client, not just OpenCode |
| 2 | **A5–A6** aliases + streaming verification + ship snippet/docs | 0.5d | `hivv/auto` usable from OpenCode in 5 minutes |
| 3 | **C** skill (repo `.opencode/skills` + well-known URL) | 0.5d | agents know the CLI |
| 4 | **B** MCP server | 1–1.5d | hive tools in every MCP client |
| 5 | **D** coder bees | 3–4d | distributed *agents*, objective p_wise signal |

**Total A–C: ~2.5–3 days · D: +3–4 days.** A–C are independent of the route-brain plan but
make it richer (A = traffic, D = best-ever calibration signal).

## Risks
| Risk | Mitigation |
|---|---|
| Tool-calling models are a minority of the hive → `tools` requests concentrate on cloud | A3 hard filter + honest capability display; route brain already prefers quality for `code` bucket |
| Relay buffered answers stall OpenCode's stream patience | OpenCode chunk timeout is 15 min; still, prefer direct candidates for `tools` requests (add `tools`-aware bias in scoring) |
| MCP endpoint abuse (free chat via MCP) | same policy gate + rate limits as `/api/chat`; visitor tier only |
| D: node runs arbitrary repo code via OpenCode | allowlist + worktree isolation + policy audit + patch caps; never auto-merge — human reviews the diff |
| Routing loop (bee → hivv → bee) | design law #6: node-originated traffic forced `private` mode |
