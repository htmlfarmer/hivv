# Installing HIVV

> HIVV is pronounced **HIVE** (like a beehive).

There are three ways in, depending on what you want.

| Goal | Command |
|---|---|
| **Run your own AI gateway** (offline-capable) | `git clone` → `./setup.sh` |
| **Join the hive** (share your compute) | `curl -sSL https://hivv.org/install-hivv.sh \| bash` |
| **Use the hosted hive** (no install) | `https://hivv.org/v1` |

---

## 0. It installs what it can

Both setup scripts **install missing dependencies for you** instead of
stopping at an error:

| Missing | What happens |
|---|---|
| Node.js 18+ | Installed via your package manager → NodeSource → fnm/nvm → official tarball (no sudo needed) |
| npm | Ships with Node.js — reinstalled together with it |
| Python 3.8+ | Installed via your package manager (optional — only the `hivv` CLI needs it) |
| PostgreSQL | **Optional.** Only needed for hosted mode; local-first needs no database at all |

If something genuinely cannot be installed automatically, the script prints
the **exact command to type** for your operating system — you are never left
guessing.

Supported package managers: `apt`, `dnf`, `yum`, `pacman`, `apk`, `zypper`,
`brew`, `winget`, `scoop`, `choco`.

---

## 1. Run your own gateway (local-first)

```bash
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
./setup.sh
```

Windows:

```powershell
git clone https://github.com/htmlfarmer/hivv.git
cd hivv
.\scripts\setup-local.ps1
```

What you get:

- a complete gateway on `http://127.0.0.1:3011`
- **no PostgreSQL** — the database is optional
- **no internet** — local models are discovered automatically
- **no secrets to configure** — the session key is generated locally
- **no cloud** — nothing phones home unless you ask it to

Local models are auto-detected on ports `8080`, `8081`, `8082`, `8090`,
`11434` (ollama), `1234` (LM Studio), `5000`, and `8000`.

### Options

`./setup.sh` flags:

| Flag | What it does |
|---|---|
| `--check` | Validate everything, change nothing |
| `--db` | Hosted mode — adds PostgreSQL + PM2 + an admin user |
| `--port 3011` | Use a different port |
| `--no-auto` | Don't auto-install missing dependencies (`setup-local.sh` only) |

`./scripts/setup-local.sh` flags:

| Flag | What it does |
|---|---|
| `--check` | Validate everything, change nothing |
| `--join-hive` | Also register with the public hive (opt-in) |
| `--port 3011` | Use a different port |
| `--data-dir DIR` | Put state somewhere else |
| `--no-start` | Install, don't start |
| `--no-auto` | Don't auto-install missing dependencies |

Windows (`setup-local.ps1`): `-Check`, `-JoinHive`, `-Port`, `-DataDir`,
`-NoStart`, `-NoAuto`.

### After it starts

```bash
curl -s localhost:3011/api/health
curl -s localhost:3011/api/partner/manifest | jq .data
curl -s localhost:3011/v1/models
```

### Adding a cloud provider key (optional)

Local mode needs no key. If you want cloud fallback, write a JSON file:

```bash
mkdir -p ~/.local/share/hivv/keys
cat > ~/.local/share/hivv/keys/openai.json <<'EOF'
{
  "api_key": "sk-...",
  "api_endpoint": "https://api.openai.com/v1",
  "model": "gpt-4o-mini"
}
EOF
```

The file is written and read with mode `0600`. It is **never** sent anywhere
except the provider you named.

### Stopping it

```bash
kill $(cat ~/.local/share/hivv/hivv.pid)
# or
hivv local stop
```

### Hosted mode (with PostgreSQL)

```bash
./setup.sh --db
```

Adds PostgreSQL, runs the migrations, installs PM2, starts the gateway under
`pm2`, and creates an admin user. In non-interactive runs it generates the
admin password for you and prints it.

---

## 2. Join the hive (node agent)

### Linux · macOS · WSL

```bash
curl -sSL https://hivv.org/install-hivv.sh | bash
```

### Windows (PowerShell)

```powershell
iwr -useb https://hivv.org/install-hivv.ps1 | iex
```

Peek first (changes nothing):

```bash
curl -sSL https://hivv.org/install-hivv.sh | bash -s -- --experiment
```

User-local only (no sudo, nothing outside `$HOME`):

```bash
curl -sSL https://hivv.org/install-hivv.sh | bash -s -- --prefix=$HOME/.local
```

### Then

```bash
hivv start            # go live — your computer joins the hive
hivv up               # 3-line status
hivv chat "hello"     # talk to the distributed AI
hivv bees             # see the other bees
```

Uninstall: `--uninstall` (Windows: `-Uninstall`). Config is kept.

---

## 3. Use the hosted hive

Any OpenAI client works:

```bash
curl -s https://hivv.org/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

Model aliases double as route modes:

| Alias | Meaning |
|---|---|
| `auto` | let the router decide |
| `smart` | highest quality |
| `fast` | lowest latency |
| `cheap` | lowest cost |
| `private` | local/hive only — never leaves your network |

---

## The CLI

The CLI (`hivv`) is pure-stdlib Python 3.8+. It also runs straight from a
clone — no install needed:

```bash
python3 public_html/hivv-cli.py --help
```

### Commands that need no gateway

```bash
hivv fast-scan FILE      # deterministic, AI-free source screen (offline)
hivv doctor              # diagnose this machine
hivv llm detect          # find local model servers
hivv llm suggest         # recommend a model for this hardware
```

`hivv fast-scan` works with **no gateway, no internet, and no Node.js** — it
falls back to a pure-Python scanner with the same rules as the server (a
parity test proves they agree).

```bash
$ hivv fast-scan script.py
  fast-scan  script.py
  verdict   : unsafe   risk 60/100 high
  size      : 31 bytes · 31 chars · 3 lines
  most used : os.system (1x)
  hard findings:
    [critical] shell command execution (1x)
  → needs a real review (run `hivv review script.py` for a signed verdict)
```

### Commands that talk to a gateway

```bash
hivv partner             # the public partner API manifest
hivv partner health      # liveness + local models
hivv partner network     # the live hive roster
hivv chat "..."          # chat
hivv local status        # is a local gateway running?
```

---

## For developers

```bash
cd api && npm install
node --test                        # 113 unit tests
cd .. && python3 -m pytest tests/ -q # 145 regression tests
python3 tests/local_install/test_local_install.py   # clone-and-run gate
python3 tests/test_fast_scan_parity.py             # scanner parity
```

CI runs the clone-and-run test on Linux, macOS, and Windows.

See `CONTRIBUTING.md` and `docs/PARTNER-API.md`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node not found` | The setup script installs it for you. If it couldn't, it prints the exact command for your OS — run it, then re-run setup |
| `npm not found` | It ships with Node.js — reinstall Node.js |
| `python not found` | Optional. Only the `hivv` CLI needs it: `sudo apt-get install -y python3` |
| `no local model server found` | Start llama.cpp / ollama, or add a provider key |
| `PostgreSQL client is not installed` | Only needed for `./setup.sh --db`. Local-first mode needs no database |
| gateway won't start | check `$HIVV_DATA_DIR/logs/hivv-local.log` |
| port already in use | `--port 3020` |
| want the old behaviour (DB required) | `./setup.sh --db` |
