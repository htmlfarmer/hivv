# HIVV Toolkit Plan — twelve tools for every bee, every AI

> Ship the standard AI toolbox to every member of the hive, so **any** model
> (a cloud LLM, a local gemma on a volunteer box, an MCP client, a script) can
> reach every tool without the client having to implement anything.
>
> Last updated: 2026-11-22 · Status: **SHIPPED** (see "As built" below)

---

## As built (2026-11-22)

Everything in §2–§4 shipped. The decisions taken:

| Question | Answer |
|---|---|
| Auto-attach the toolkit to chat? | **YES, opt-out** — `"tools": false`, `"tools": []`, or `X-Hivv-Tools: off`; narrow with `X-Hivv-Tools: a,b`. Cost ≈1850 prompt tokens/request |
| Where do the tools run? | **The hub is authoritative**; the bee serves the deterministic half locally and proxies the rest |
| Web search posture? | **Built + tested, MAYBE-gated** — `web.search` is `ask`, not advertised, `HIVV_ENABLE_WEB_SEARCH=0` |

### What shipped

| Piece | Where |
|---|---|
| The catalog (13 tools: the twelve + `sysinfo`) | `api/lib/toolkit.js` |
| The safe math evaluator (no `eval`) | `api/lib/math.js` |
| HTML/XML/YAML/CSV parsing (no new deps) | `api/lib/textparse.js` |
| Extraction + the document store | `api/lib/file-extract.js`, `api/lib/file-store.js` |
| The memory store | `api/lib/memory.js` + `hivv_memory` (migration 022) |
| The SSE tool loop for streaming chat | `api/lib/tool-stream.js` |
| The tool HTTP surface | `api/routes/tool-routes.js` |
| The bee-side server (local half + hub proxy) | `public_html/hivv-tools.py` |
| The CLI (`hivv tools`, `hivv call <tool>`) | `public_html/hivv-cli.py` |
| The tests (57) | `tests/test_toolkit.py` |

### Things the plan did not anticipate

1. **The streaming path needed real SSE interception.** The plan assumed the
   non-streaming tool loop was enough. It is not — streaming is the default
   for `/api/chat` and for every OpenAI-compatible client, and the router
   writes provider frames straight to the socket. A tool_call reached the
   client before the hub could run it, and a client that receives an
   unexpected tool_call executes it itself. `api/lib/tool-stream.js` holds the
   tool frames back and forwards content frames live.
2. **Identity was the source IP, and that is wrong behind a CDN.** The tool
   route fell back to `ip:<req.ip>`, which behind Cloudflare is the edge
   node's address and changes between requests — so a standing grant was
   never reusable and every call asked a human again. The route now uses the
   signed `hivv_visitor` cookie, the same identity the chat path uses.
3. **`coding.execute` had the wrong TIER, not just the wrong verdict.**
   Migration 011 moved the verdict to `ask` but left the tier at `compute`,
   so the risk score for running code was 1 — the same as plain chat — and
   the chat tool loop (which only gates tiers above `compute`) skipped the
   gate for `exec`/`shell`/`run` entirely. Migration 022 fixes the tier.
4. **The offline capability registry had drifted** from the seeded table
   (different tiers, six missing keys), so an offline install published a
   different capability surface than a live one. `BUILTIN_CAPABILITIES` now
   mirrors the table exactly.
5. **The `utc_offset` sign was inverted** in the first cut of the timezone
   converter — Karachi read `-05:00` instead of `+05:00`. Pinned by tests.

---

## 0. The problem, stated honestly

HIVV already *has* tools. They are scattered, duplicated, and mostly invisible.

| Where | What exists | Problem |
|---|---|---|
| `api/server.js` `execToolCall` (L2368–2520) | `search`, `news`, `fetch`, `calculate`, `get_time`, `sysinfo` | inline in a 188 KB file; `calculate` is a regex + `new Function`; no file/code/memory/translate |
| `public_html/hivv-tools.py` | `time`, `calculate`, `fetch`, `search`, `news`, `sysinfo` | a **second, divergent** implementation in Python; the `calculate` there uses `eval` |
| `api/routes/mcp-routes.js` | 6 tools: `chat`, `route`, `nodes`, `search`, `news`, `honey` | no time/calc/code/files/memory/translate |
| `api/lib/sandbox.js` | real docker/bwrap jail | wired only to `POST /api/sandbox/exec`, invisible to every model |
| `api/routes/files-routes.js` | PDF/DOCX/text extraction, TTL store | upload-only; **no tool** — a model cannot read a file |
| `api/lib/policy.js` | YES/MAYBE/NO gate + capability registry | `web.search` is `allow` today; no capabilities for files/memory |

Three consequences:

1. **A local model on a bee cannot use a tool.** `execToolCall` only fires when
   the *caller* passes `tools` in the request body. Nobody passes them. The
   tool loop exists; it is simply never entered.
2. **Two implementations, two behaviours.** The hub's calculator strips
   `sqrt(2)` → `(2)`. The bee's does not. Neither is exact-decimal.
3. **Six of the twelve requested tools do not exist at all** — code interpreter,
   file read, file search, memory, parser, timezone, translation.

---

## 1. The shape of the answer

> **One catalog, one implementation, many surfaces.**

```
                      ┌───────────────────────────────────────┐
                      │        api/lib/toolkit.js             │
                      │   THE CATALOG — 12 tools, one source  │
                      │   of truth: name · schema · capability│
                      │   · handler · where it runs            │
                      └───┬───────────┬───────────┬───────────┘
                          │           │           │
         ┌────────────────┘           │           └────────────────┐
         │                            │                            │
   ┌─────▼──────┐            ┌───────▼────────┐          ┌────────▼────────┐
   │  /mcp      │            │ POST /api/chat │          │ POST /api/tools │
   │ (MCP SDK)  │            │ /v1  auto-tool │          │  /:tool/invoke  │
   │ 12 tools   │            │     loop       │          │  hub → bee      │
   └────────────┘            └────────────────┘          └─────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │  the model on ANY bee        │
                    │  calls the tool; the hub     │
                    │  executes it (or a bee does)  │
                    └───────────────────────────────┘
```

**The hub is authoritative.** Every bee can reach the hub (it registers and
heartbeats over HTTPS), so every bee gets every tool without installing
anything. A bee still hosts its *own* copy of the light tools so it keeps
working offline and can serve the hive when the hub is down.

---

## 2. The twelve tools

`cap` = the capability key the policy gate evaluates. `verdict` = the registry
default. `ask` means MAYBE — a human approves once, then a standing grant
makes it frictionless.

| # | canonical name | aliases | cap | verdict | where | notes |
|---|---|---|---|---|---|---|
| 1 | `web_search` | `search`, `news` | `web.search` | **ask** | hub + bee | Wikipedia + Google News RSS. **Built and tested, not yet granted** — see §6 |
| 2 | `current_time` | `time`, `get_time` | `local.computation` | allow | hub + bee | ISO + unix + human + timezone-aware |
| 3 | `calculator` | `calculate`, `calc` | `local.computation` | allow | hub + bee | **real** evaluator: `+ - * / % ^`, `sqrt ln log sin cos tan`, `pi e`, `deg/rad`, exact decimal. No `eval`, no `new Function` |
| 4 | `web_fetch` | `fetch`, `reader` | `web.fetch` | ask | hub + bee | URL → readable text. HTML stripped, content-type aware, SSRF-guarded, size-capped |
| 5 | `http_request` | `request`, `curl` | `web.fetch` | ask | hub + bee | Full HTTP: method, headers, body, query, JSON/form. SSRF-guarded |
| 6 | `code_interpreter` | `exec`, `coding.execute` | `coding.execute` | ask | **hub only** | python / bash / node in the existing docker/bwrap jail. No egress, RAM/CPU/pids quotas, hard timeout |
| 7 | `file_read` | `read_file` | `data.file.read` | ask | hub + bee | PDF, DOCX, TXT, CSV, JSON, MD, images. Hub: the upload store. Bee: its own disk |
| 8 | `file_search` | `search_files` | `data.file.read` | ask | hub + bee | regex/substring across the uploaded corpus, with context lines |
| 9 | `memory` | `remember`, `recall` | `data.memory` | allow | hub | `remember` / `recall` / `forget` / `list`. Scoped per principal. Postgres + local-mode file fallback |
| 10 | `text_parser` | `parse` | `local.computation` | allow | hub + bee | JSON pretty/validate, CSV→JSON, XML→JSON, YAML→JSON, extract URLs/emails/dates |
| 11 | `timezone_convert` | `tz`, `convert_time` | `local.computation` | allow | hub + bee | IANA zones, DST-correct, "now in X", "X → Y" |
| 12 | `translate` | `translation` | `translation` | allow | hub | **The hive translates** — routed to a model, so it costs tokens but needs no new vendor |

### New capabilities (migration 022)

```sql
('data.file.read', 'read & search files',   'data',        'ask',  true),
('data.memory',    'remember between chats','data',        'allow', false),
```

`web.search` flips `allow` → **`ask`** (see §6).

---

## 3. Where each tool runs

| Execution | Tools | Why |
|---|---|---|
| **Hub** | all 12 | single source of truth; the sandbox and the upload store live here; no new installs on bees |
| **Bee** (`hivv-tools.py`) | 1,2,3,4,5,7,8,10,11 | light + genuinely local (the bee's own disk for files). Keeps working when the hub is unreachable |
| **Bee → hub proxy** | 6 (code), 9 (memory), 12 (translate) | need the sandbox / the shared store / a model |

---

## 4. Surfaces to wire

| Surface | Change |
|---|---|
| `POST /api/chat` (non-stream) | **auto-attach** the toolkit schemas when the caller sends no `tools`. The existing 5-round loop then lets the *model* drive the tools. Opt out with `"tools": false` or `X-Hivv-Tools: off` |
| `POST /v1/chat/completions` | same, but streaming keeps its current pass-through (no tool loop on SSE yet) |
| `execToolCall` (server.js) | becomes a thin adapter over `toolkit.execute()` — deletes ~150 lines of duplicated inline code and gains the 12 tools |
| `GET /api/tools` | gains `catalog` — every tool with its JSON schema, capability and current verdict |
| `POST /api/tools/:tool/invoke` | **new**. JSON body, hub-local execution first, bee proxy as fallback. The existing `GET` form stays for back-compat |
| `/mcp` | 6 → **18** tools (12 toolkit + the existing 6) |
| `/api/capabilities` (discovery) | publishes the catalog + the new `mcp.tools` list |
| CLI `hivv tools` | `list` shows the catalog and where each runs; `call <name> '<json>'`; `enable` mints standing grants |
| CLI `hivv call` | routes through the catalog; every old name still works |
| `hivv-tools.py` | implements/proxies the new tools on the bee |

---

## 5. Security posture

| Risk | Mitigation |
|---|---|
| SSRF (tools 1, 4, 5) | reuse `api/lib/ssrf.js` — resolves DNS and checks **every** address, so a public name pointing at `127.0.0.1` is caught. Redirects re-checked. Loopback/link-local/metadata blocked |
| RCE (tool 6) | `api/lib/sandbox.js` only — docker `--network=none --read-only --cap-drop=ALL --pids-limit`, or bwrap `--unshare-all`. **Fails closed**: no runtime → refuse, never run on the host. Code goes in via a read-only temp file, never a shell |
| Path traversal (tools 7, 8) | the hub's file tools read the **upload store by id only** — the user's filename never touches a path. The bee's file tools are jailed to an allow-listed root and refuse `..` |
| Secret leakage (tool 9) | memory is scoped per principal, never readable by another. The audit ledger stores digests, never raw values |
| Cost blow-up (tool 12, and any tool loop) | the tool loop is capped at 5 rounds; output is size-capped; `translate` routes with `mode: fast` unless asked otherwise |
| Unbounded egress | `web.fetch` / `web.search` / `http_request` are `ask` → a human approves once, then a standing grant applies |

---

## 6. Web search: built, tested, **not yet allowed**

The user asked for exactly this posture, so it is explicit rather than accidental:

1. The implementation lands and is covered by tests.
2. `hivv_capabilities.web_search` flips `allow` → **`ask`** in migration 022.
   A member calling `web_search` gets MAYBE, not a silent internet fetch.
3. The schemas for `web_search` / `news` are **not** in the auto-attached list.
   A model will not even see the tool until it is turned on.
4. `HIVV_ENABLE_WEB_SEARCH=1` (default `0`) turns both back on for testing and
   for an operator who wants it live.
5. `hivv tools enable --web` mints the standing grant for a specific principal.

Turn it on in one command; turn it off in one command. No code edits.

---

## 7. Build order

| Phase | Deliverable | Gate |
|---|---|---|
| **1** | `api/lib/math.js` (safe evaluator), `api/lib/file-extract.js` (shared PDF/DOCX/text extraction), `api/lib/toolkit.js` (catalog + 12 handlers), `api/lib/memory.js` | unit tests green |
| **2** | `api/routes/tool-routes.js`, migration 022, `execToolCall` → `toolkit.execute` | live gateway round-trip |
| **3** | MCP 12 tools · `/api/tools` catalog · `POST invoke` · auto-attach in chat | live gateway round-trip |
| **4** | `hivv-tools.py` new tools + hub proxy · CLI `hivv tools` | pytest |
| **5** | `tests/test_toolkit.py`, `tests/test_toolkit_mcp.py`, TESTMAP regen | full suite green |

---

## 8. Non-goals

- No new vendor API keys. `translate` uses the hive's own models.
- No new npm dependencies — the YAML/XML/CSV parsers are hand-rolled (~150
  lines total) rather than adding supply-chain surface.
- No streaming tool loop yet (SSE interception is a separate piece of work).
- No per-bee tool marketplace — one catalog for the whole hive.

---

## 9. Receipts

Every tool call returns the same envelope, so the caller always knows who
ran it and under which rule:

```json
{
  "tool": "calculator",
  "ok": true,
  "data": { "expression": "2+2", "result": 4 },
  "via": "hub",
  "policy": { "verdict": "allow", "rule": "default:compute", "capability": "local.computation" }
}
```

and the HTTP layer sets `X-Hivv-Policy: ALLOW <rule>` — the same receipt the
chat path already returns.
