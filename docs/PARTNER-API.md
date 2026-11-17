# HIVV Partner API

Everything another website, agent, or tool needs lives under one stable
prefix: **`/api/partner`**.

It works on the hosted hive (`https://hivv.org`) **and** on a local clone
(`http://127.0.0.1:3011`) with no database and no internet.

---

## Quick start

```bash
# What can this instance do?
curl -s https://hivv.org/api/partner/manifest | jq .data

# Is it alive? (works with no database)
curl -s https://hivv.org/api/partner/health | jq .data

# Screen a file — free, deterministic, NO AI
curl -s https://hivv.org/api/partner/fast-scan \
  -H 'content-type: application/json' \
  -d '{"language":"python","code":"import os\nos.system(\"echo hi\")\n"}' | jq .data
```

From the CLI:

```bash
hivv partner                    # the manifest
hivv partner health             # liveness + local models
hivv fast-scan myscript.py      # free deterministic screen
hivv local status               # is a local gateway running?
```

---

## Endpoints

### `GET /api/partner/manifest`

The machine-readable description of this instance. Start here — it tells a
partner what exists, what is stable, and where everything else lives.

```json
{
  "data": {
    "service": "hivv",
    "name": "HIVV",
    "tagline": "A distributed AI network — at home and around the world",
    "version": "2.0.0",
    "mode": "auto",
    "local_first": true,
    "offline_capable": true,
    "database": "connected",
    "hub": "https://hivv.org",
    "hive_joined": false,
    "local_models": [{ "provider": "llamacpp", "model": "gemma-4", "port": 8090 }],
    "openai_compatible": {
      "base_url": "/v1",
      "chat": "/v1/chat/completions",
      "models": "/v1/models",
      "streaming": true,
      "tools": true,
      "auth": "optional Bearer token (OpenAI-compatible)"
    },
    "endpoints": { "manifest": "/api/partner/manifest", "...": "..." },
    "features": [{ "key": "openai_compatible", "stable": true }],
    "limits": { "max_code_bytes": 262144 }
  },
  "meta": { "version": "v1", "hivv_version": "2.0.0", "generated_at": "..." }
}
```

### `GET /api/partner/health`

Liveness plus what is actually available. Never contacts the public hive
unless the operator explicitly enabled the hive join.

```json
{
  "data": {
    "status": "healthy",
    "mode": "local",
    "database": "unavailable",
    "local_models": ["gemma-4-E2B"],
    "hive": { "reachable": null, "status": "not-contacted" },
    "offline_capable": true
  }
}
```

### `GET /api/partner/models`

The models this instance can serve right now — probed from the local model
servers plus whatever providers are configured.

### `GET /api/partner/capabilities`

The capability registry: `reasoning`, `coding`, `web.search`, `web.fetch`,
`coding.execute`, speech, vision — with risk tiers and default verdicts.

### `GET /api/partner/network`

The live hive roster: every bee, its status, its models, and its coarse
location. No private IPs.

### `POST /api/partner/fast-scan`

**Free. Deterministic. No AI. No signature.**

```json
{
  "language": "python",
  "code": "import os\nos.system('echo hi')\n",
  "filename": "example.py"
}
```

Response highlights:

| Field | Meaning |
|---|---|
| `size` | bytes, chars, lines, non-empty lines, max/avg line length |
| `entropy` | Shannon entropy of the file and of long literals |
| `imports` | Modules/packages the source pulls in |
| `commands` | Command/API indicators with occurrence counts |
| `most_used` | The single most-used command/API |
| `riskiest_operations` | The riskiest operations, ranked |
| `files` | Detected paths, read/write/delete counts |
| `network` | Domains, URLs, ports, indicator count |
| `hard_findings` | Hard-danger patterns with position and sample |
| `secret_findings` | Embedded secrets — **fingerprint only** |
| `risks.score` | Integer 0–100 |
| `risks.level` | `safe` / `low` / `medium` / `high` / `critical` |
| `verdict` | `safe` / `unsafe` / `review` |
| `needs_ai_review` | Whether an LLM review is warranted |

> **The fast-scan can only make a verdict WORSE.** It never approves code.
> A `safe` result means "no hard-danger signal found", not "this is safe".

### `POST /api/partner/review`

The signed review. Same artifact BLNQ consumes.

```json
{
  "language": "python",
  "code": "print('hello')"
}
```

Returns `verdict`, `statement` (plain-English explanation), `risk_score`,
`risk_level`, `commands`, `files`, `network`, `risks`, the exact timestamps,
the review duration, the cost, and the **Ed25519 signature** over the whole
envelope.

```json
{
  "signed": true,
  "signature": "base64...",
  "public_key": "base64...",
  "principal_id": "hivv_452451f3d93abfb16e55beb78e14cb26",
  "envelope": { "v": 2, "kind": "source.review", "...": "..." }
}
```

If no model is available the endpoint **fails closed** with `503` — it never
approves without a real review.

### `POST /api/partner/verify`

Verify a signed attestation.

```json
{
  "envelope": { "...": "..." },
  "signature": "base64...",
  "public_key": "base64..."   // optional: defaults to this instance's key
}
```

```json
{ "data": { "valid": true, "problems": [], "fresh": true, "kind": "source.review" } }
```

Verification is **offline-capable**: the canonical JSON + Ed25519 check does
not need the hub, the database, or the network. The Python CLI does the same
thing (`blnq verify`).

### `GET /api/partner/attestation/key`

This instance's verification public key.

```json
{
  "data": {
    "principal_id": "hivv_452451f3d93abfb16e55beb78e14cb26",
    "public_key": "io8Wh2CfsIolRDEhQ3TpuDkoaA2yt/L/HzIDArKiaeg=",
    "algorithm": "ed25519",
    "envelope_version": 2,
    "schema": "blnq.attestation.v2"
  }
}
```

---

## The OpenAI-compatible surface

Everything under `/v1` works exactly like OpenAI:

```bash
curl -s https://hivv.org/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_KEY' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

- `model` aliases double as route modes: `auto`, `smart` (quality), `fast`,
  `cheap` (cost), `private`.
- Streaming works; send `X-Hivv-Plain: 1` to suppress HIVV's custom SSE frames.
- Responses may carry `X-Hivv-Answered-By` (which bee answered) and
  `X-Hivv-Policy` (which rule allowed it).
- `Authorization: Bearer` is optional. Without it you are anonymous.

## MCP

`https://hivv.org/mcp` exposes the same capabilities as MCP tools: `chat`,
`route`, `nodes`, `search`, `news`, `honey`.

---

## Self-hosting

```bash
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
./scripts/setup-local.sh          # Linux / macOS / WSL / Git Bash
# or
.\scripts\setup-local.ps1         # Windows PowerShell
```

The local gateway serves the same `/v1` and `/api/partner/*` surfaces. Add
`--join-hive` to also register with the public hive.

## Stability

`/api/partner/*` is versioned via `meta.version`. Additive changes (new
fields, new endpoints) do not change the version. A breaking change gets a new
prefix. Pin what you depend on and watch `meta.hivv_version`.
