# Contributing to HIVV

> HIVV is pronounced **HIVE** (like a beehive).

HIVV is a **distributed AI network** — at home and around the world. This
repository holds the gateway, the node/CLI, the trust layer, and the docs.

## Quick start (local-first)

```bash
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
./scripts/setup-local.sh
```

That boots a local gateway on `http://127.0.0.1:3011` with:

- **no PostgreSQL**
- **no internet**
- **no secrets to configure**

Local models on ports `8080`, `8081`, `8082`, `8090`, `11434`, `1234`, `5000`,
or `8000` are discovered automatically.

Windows (PowerShell):

```powershell
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
.\scripts\setup-local.ps1
```

To also join the global hive:

```bash
./scripts/setup-local.sh --join-hive
```

## Tests

```bash
# Fast deterministic unit tests (Node)
cd api && node --test

# Python regression suite
python3 -m pytest tests/ -q

# The important one: prove a clone can actually run
python3 tests/local_install/test_local_install.py
```

The clone-and-run test starts a real gateway with **no database and no
network**, then exercises the partner surface, the OpenAI-compatible surface,
the deterministic fast-scan, and the signed-attestation verification. It runs
identically on Linux, macOS, and Windows.

CI runs it on `ubuntu-latest`, `macos-latest`, and `windows-latest`.

## Layout

| Path | What |
|---|---|
| `api/` | The gateway (Node.js + Express). `server.js` is the entry point. |
| `api/lib/` | Routing, policy, provenance, attestation, local-mode. |
| `api/routes/` | HTTP surfaces, including the public `/api/partner/*`. |
| `api/migrations/` | SQL schema files. |
| `public_html/` | Static site + the `hivv` CLI (`hivv-cli.py`). |
| `scripts/` | Setup and maintenance scripts. |
| `tests/` | Python regression tests + the clone-and-run harness. |
| `sdk/` | Agent SDK. |

## The public integration surface

Anything another website needs is under one stable prefix:

```
GET  /api/partner/manifest        machine-readable capability manifest
GET  /api/partner/health          liveness + local/hive status
GET  /api/partner/models           models this instance can serve
GET  /api/partner/capabilities    capability registry
GET  /api/partner/network         the live hive roster
POST /api/partner/fast-scan       deterministic, AI-free source screen
POST /api/partner/review          signed source review (uses a model)
POST /api/partner/verify          verify a signed attestation
GET  /api/partner/attestation/key this instance's verification public key
```

Plus the OpenAI-compatible surface at `/v1` and an MCP server at `/mcp`.

`/api/partner/fast-scan` is **free and deterministic** — it never approves
code, it can only make a verdict worse. Use it to screen uploads before you
spend an LLM call.

## Changing the attestation contract

The HIVV ↔ BLNQ wire contract is versioned and duplicated on purpose (neither
site may depend on the other's files). The canonical values live in:

- `api/lib/attestation-contract.json`
- `api/lib/attestation-contract.js`

When you change it, update **both** sites and run the cross-site parity
suite. See `docs/ATTESTATION-CONTRACT.md` on the BLNQ side for the checklist.

## Rules of the road

1. **Never commit secrets.** `.keys/`, `.control-token`, `.session-secret`,
   `.env` are gitignored. The scanner will fail CI if they appear.
2. **Fail closed on safety.** A scanner that cannot decide must not approve.
3. **Deterministic where possible.** If two nodes must agree, do not ask an
   LLM.
4. **Local-first.** A clone must run without a database, without the internet,
   and without asking the user to configure anything.
5. **Test what you claim.** If the README says it works on three platforms, CI
   proves it on three platforms.

## License

MIT — see `LICENSE`.
