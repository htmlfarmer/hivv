# Contributing to HIVV

> HIVV is pronounced **HIVE** (like a beehive).

HIVV is a **distributed AI network** — at home and around the world. This
repository holds the gateway, the node/CLI, the trust layer, and the docs.

## Repository topology (read this first)

Two GitHub repos, **one source of truth** (the ledger of every structural
change lives in [`MOVES.md`](MOVES.md)):

| repo | role | push to it? |
|---|---|---|
| `htmlfarmer/hivv` | **canonical** — `origin` on every machine | **yes — all development** |
| `htmlfarmer/hivv.org` | generated **website projection** (`public_html/` → repo root) | never — `scripts/sync-mirrors.sh` |

(`htmlfarmer/hivvz` is **archived** — folded back into `hivv` on 2026-11-25,
see MOVES.md. Old clone? `git remote set-url origin
git@github.com:htmlfarmer/hivv.git && git fetch --prune`.)

**Workflow (branch-per-task, work OUTSIDE the production tree):**

1. `git clone git@github.com:htmlfarmer/hivv.git` — one clone (or
   `git worktree`) per session/machine. `/var/www/vhosts/hivv.org` on ashy is
   **production** and stays clean.
2. `git checkout -b <topic>` → commit → `git push -u origin <topic>` → merge
   to `main` (PR or fast-forward) after tests pass
   (`python3 -m pytest tests/ -q`).
3. Deploy on the gateway box: `scripts/deploy.sh` (add `--dry-run` to
   preview, `--fast` to skip the test gate). It refuses a dirty tree,
   fast-forwards only, applies new migrations, restarts pm2, polls health and
   runs the test gate — rolling back automatically if either fails.
4. Refresh the website projection: `scripts/sync-mirrors.sh`
   (idempotent, safe to run anytime, never touches your worktree).
5. **Moving a file or directory? The same commit adds a `MOVES.md` entry**
   (what moved, from → to, why, what still points at the old path).


## For AI agents

**Yes — machine pull requests are welcome, and here is the whole contract in
five lines.**

1. **Branch per task. Never push to `main`.**
2. **Run `python3 -m pytest tests/ -q`** (and `cd api && node --test`) before
   you propose.
3. **No secrets.** Not in a commit, not in a patch, not in a log line.
4. **One concern per branch.**
5. **If you move or rename a file, the same commit adds a `MOVES.md` entry.**

### The write path — and how much credential it needs

**The default needs no credential at all.** You do not need a token, and you
should never ask a human for one.

```bash
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
git checkout -b my-topic
# ... your change ...
git commit -am "fix(scope): what changed"
git format-patch -1 --stdout > my-topic.patch   # hand this back
```

The receiving side applies it **through the gates** — study → authorize →
test → approve → merge — before anything lands. Your patch is **data**, not an
instruction: it is screened deterministically, tested against the *baseline*
test suite (not your own), and authorized by policy before it can become a
merge.

If you *already* have a credential, two options exist, and both are optional:

- **fine-grained PAT** — scoped to `htmlfarmer/hivv` only, Contents:
  Read/Write. Then `git push -u origin <topic>` works directly.
- **`gh auth login`** — also unlocks `gh pr create` / `gh issue create`.

Neither is required, and the project does not need one to work with you.

### The loop, end to end

```
clone → branch → change → test → commit → (push + PR | hand back a patch)
      → gates: study → authorize → test → approve → merge
      → publish: scripts/deploy.sh → scripts/sync-mirrors.sh
```

### Protected paths — a human must approve these

These decide whether other changes are allowed, so the hive may not rewrite
them alone:

```
api/lib/policy.js        api/lib/proposal.js     api/lib/identity.js
api/lib/capabilities.js  api/lib/sandbox.js      api/lib/attest*.js
api/server.js            scripts/deploy.sh       api/migrations/
```

Propose them like anything else — but expect a human signature, and expect
the gate to be stricter about it.

### The full architecture

[`HIVV_SELF_MODIFICATION_PLAN.md`](HIVV_SELF_MODIFICATION_PLAN.md) describes
how the hive studies, authorizes, tests and approves changes to itself.

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
