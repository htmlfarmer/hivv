#!/usr/bin/env bash
# scripts/setup-local.sh — clone-and-run setup for a SELF-HOSTED HIVV.
#
# This is the "git clone https://github.com/htmlfarmer/hivv && run" path.
# It installs the API dependencies, creates a local data directory, and starts
# the gateway in LOCAL-FIRST mode:
#
#   * NO PostgreSQL required
#   * NO internet required after the clone
#   * Local models on 8080/8090/11434/1234 are discovered automatically
#   * The public hive is contacted ONLY if you pass --join-hive
#
# Usage:
#   ./scripts/setup-local.sh                 # set up and run
#   ./scripts/setup-local.sh --check         # validate only, change nothing
#   ./scripts/setup-local.sh --join-hive     # also register with hivv.org
#   ./scripts/setup-local.sh --port 3011     # use a different port
#   ./scripts/setup-local.sh --no-start      # install, don't start
#   ./scripts/setup-local.sh --no-auto       # don't auto-install missing deps
#
# Works on: Linux, macOS, WSL, Git-Bash/MSYS. On native Windows use
# scripts/setup-local.ps1 (PowerShell).
#
# Missing dependencies (Node.js, Python) are installed automatically when
# possible. When they can't be, the exact command to type is printed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$REPO_ROOT/api"
DATA_DIR="${HIVV_DATA_DIR:-}"
PORT="${HIVV_PORT:-3011}"
JOIN_HIVE=0
START=1
CHECK_ONLY=0
QUIET=0
AUTO_DEPS=1

# shellcheck source=lib/deps.sh
. "$REPO_ROOT/scripts/lib/deps.sh"

if [[ -t 1 ]]; then
    RST=$'\033[0m'; BLD=$'\033[1m'; DIM=$'\033[2m'
    GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLU=$'\033[34m'; HIVE=$'\033[38;5;214m'
else
    RST=""; BLD=""; DIM=""; GRN=""; RED=""; YLW=""; BLU=""; HIVE=""
fi

step()  { printf '%s==>%s %s%s%s\n' "$BLU" "$RST" "$BLD" "$1" "$RST"; }
ok()    { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YLW" "$RST" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
info()  { printf '  %s→%s %s\n' "$DIM" "$RST" "$1"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --join-hive) JOIN_HIVE=1; shift ;;
        --no-start)  START=0; shift ;;
        --check)     CHECK_ONLY=1; shift ;;
        --quiet)     QUIET=1; shift ;;
        --no-auto)   AUTO_DEPS=0; shift ;;
        --port)      PORT="$2"; shift 2 ;;
        --data-dir)  DATA_DIR="$2"; shift 2 ;;
        -h|--help)   sed -n '2,24p' "$0"; exit 0 ;;
        *) fail "unknown option: $1"; exit 2 ;;
    esac
done

banner() {
    printf '\n%s%s' "$HIVE" "$BLD"
    cat <<'BANNER'
  ██╗  ██╗██╗██╗   ██╗██╗   ██╗
  ██║  ██║██║██║   ██║██║   ██║
  ███████║██║██║   ██║██║   ██║
  ██╔══██║██║╚██╗ ██╔╝╚██╗ ██╔╝
  ██║  ██║██║ ╚████╔╝  ╚████╔╝
  ╚═╝  ╚═╝╚═╝  ╚═══╝    ╚═══╝
BANNER
    printf '%s' "$RST"
    printf '\n  %sHIVE — a distributed AI network (at home and around the world)%s\n\n' "$DIM" "$RST"
}

banner

# ── 1. platform detection ────────────────────────────────────────────────
step "Checking platform"
detect_platform
ARCH="$D_ARCH"
case "$D_OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    windows) PLATFORM="windows-bash" ;;
    *) PLATFORM="unknown" ;;
esac
ok "$PLATFORM ($D_OS/$ARCH, pkg manager: $D_PKG)"

# ── 2. node ──────────────────────────────────────────────────────────────
step "Checking Node.js"
DEP_FLAG=""
[[ "$AUTO_DEPS" -eq 0 ]] && DEP_FLAG="--no-auto"
if d_install_node $DEP_FLAG; then
    ok "node $(node --version)"
else
    fail "node 18+ is required — HIVV cannot start without it"
    exit 1
fi

if command -v npm >/dev/null 2>&1; then
    ok "npm $(npm --version)"
else
    fail "npm not found — it ships with Node.js"
    exit 1
fi

# ── 3. python (for the CLI) ──────────────────────────────────────────────
step "Checking Python"
if d_install_python $DEP_FLAG; then
    ok "python ready"
else
    warn "python 3.8+ not available — the hive CLI will not run (the API still will)"
fi

# ── 4. local model servers ───────────────────────────────────────────────
step "Probing for local model servers"
FOUND_MODELS=0
for port in 8080 8081 8082 8090 11434 1234 5000 8000; do
    if command -v curl >/dev/null 2>&1; then
        if curl -fsS --max-time 1 "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1 \
           || curl -fsS --max-time 1 "http://127.0.0.1:$port/api/tags" >/dev/null 2>&1; then
            ok "model server on 127.0.0.1:$port"
            FOUND_MODELS=1
        fi
    fi
done
[[ "$FOUND_MODELS" -eq 1 ]] || warn "no local model server found — install llama.cpp or ollama (see README)"

# ── 5. data directory ────────────────────────────────────────────────────
if [[ -z "$DATA_DIR" ]]; then
    case "$PLATFORM" in
        windows-bash) DATA_DIR="${LOCALAPPDATA:-$HOME/AppData/Local}/hivv" ;;
        macos)        DATA_DIR="$HOME/Library/Application Support/hivv" ;;
        *)            DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/hivv" ;;
    esac
fi
step "Preparing local data directory"
if mkdir -p "$DATA_DIR" "$DATA_DIR/keys" "$DATA_DIR/logs" 2>/dev/null; then
    chmod 700 "$DATA_DIR" 2>/dev/null || true
    ok "$DATA_DIR"
else
    fail "cannot create $DATA_DIR"
    exit 1
fi

# ── 6. dependencies ──────────────────────────────────────────────────────
step "Installing API dependencies"
cd "$API_DIR"
if [[ -f package-lock.json ]]; then
    npm ci --silent --no-audit --no-fund 2>/dev/null || npm install --silent --no-audit --no-fund
else
    npm install --silent --no-audit --no-fund
fi
if [[ -d node_modules ]]; then
    ok "node_modules ready"
else
    fail "npm install failed"
    exit 1
fi

# ── 7. environment file ──────────────────────────────────────────────────
ENV_FILE="$DATA_DIR/hivv.env"
step "Writing environment"
if [[ -f "$ENV_FILE" ]]; then
    ok "$ENV_FILE (kept — your settings are preserved)"
else
    {
        echo "# HIVV local-first environment (generated $(date -u +%Y-%m-%dT%H:%M:%SZ))"
        echo "HIVV_MODE=local"
        echo "HIVV_DB_REQUIRED=0"
        echo "HIVV_DATA_DIR=$DATA_DIR"
        echo "HIVV_PORT=$PORT"
        echo "HIVV_HIVE_JOIN=$JOIN_HIVE"
        echo "HIVV_HIVE_URL=https://hivv.org"
        echo "# HIVV_SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
        echo "NODE_ENV=production"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    ok "$ENV_FILE (created)"
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
    step "Check complete — nothing was started"
    exit 0
fi

# ── 8. start ─────────────────────────────────────────────────────────────
if [[ "$START" -eq 0 ]]; then
    step "Setup complete (not started)"
    info "start it with: HIVV_DATA_DIR='$DATA_DIR' HIVV_PORT=$PORT node api/server.js"
    exit 0
fi

step "Starting the local gateway"
LOG="$DATA_DIR/logs/hivv-local.log"
cd "$API_DIR"
set -a
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"
set +a
export PORT
nohup node server.js > "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$DATA_DIR/hivv.pid"
sleep 3

if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ok "gateway is healthy on http://127.0.0.1:$PORT"
    info "health : http://127.0.0.1:$PORT/api/health"
    info "partner: http://127.0.0.1:$PORT/api/partner/manifest"
    info "openai : http://127.0.0.1:$PORT/v1"
    info "logs   : $LOG"
    info "stop   : kill \$(cat '$DATA_DIR/hivv.pid')"
    echo ""

    # ── put the `hivv` COMMAND on PATH ─────────────────────────────────
    # A clone holds a working CLI, but NOT on PATH — `hivv chat` said
    # "command not found" right after a successful setup, while the next
    # lines told the user to run `hivv chat`. Install the standard layout:
    #     ~/.local/bin/hivv              ← wrapper
    #     ~/.local/lib/hivv/hivv-cli.py   ← client
    # In that layout `hivv update` updates the INSTALLED copy instead of
    # overwriting the source tree it was run from.
    step "Installing the hivv command"
    CLI_PREFIX="$HOME/.local"
    if CLI_BIN_PATH="$(d_install_cli "$CLI_PREFIX" 0 "$REPO_ROOT/public_html")"; then
        ok "hivv installed → $CLI_BIN_PATH"
        case ":$PATH:" in
            *":$CLI_PREFIX/bin:"*) ;;
            *)
                export PATH="$CLI_PREFIX/bin:$PATH"
                d_ensure_path "$CLI_PREFIX/bin" >/dev/null
                ok "Added $CLI_PREFIX/bin to PATH (this shell + your rc file)"
                ;;
        esac
        command -v hivv >/dev/null 2>&1 \
            && ok "'hivv' resolves → $(command -v hivv)" \
            || warn "'hivv' is not on PATH in this shell — run: export PATH=\"$CLI_PREFIX/bin:\$PATH\""
    else
        warn "could not install the hivv command — you can still run it from the clone:"
        info "python3 $REPO_ROOT/public_html/hivv-cli.py chat \"hello\""
    fi
    echo ""

    # ── join the global hive? ─────────────────────────────────────────
    # The gateway is LOCAL — it does NOT register this machine as a hive
    # node. That needs the CLI agent (`hivv start`), which registers with
    # the hub. So ASK and actually do it.
    JOIN_NOW="$JOIN_HIVE"
    if [[ "$JOIN_HIVE" -eq 0 && "$CHECK_ONLY" -eq 0 ]]; then
        echo "  ${BLD}Join the global hive?${RST}"
        echo "    Your computer becomes a bee — it shares spare CPU/GPU with the"
        echo "    network and can serve AI requests. Opt out any time:"
        echo "    hivv volunteer off"
        echo ""
        if d_ask_yesno "Join the hive now?" "y"; then
            JOIN_NOW=1
        fi
        echo ""
    fi

    if [[ "$JOIN_NOW" -eq 1 ]]; then
        step "Installing the hivv node agent"
        JOINED=0
        HIVV_CLI=""
        if command -v hivv >/dev/null 2>&1; then
            HIVV_CLI="hivv"
        elif [ -f "$REPO_ROOT/public_html/hivv-cli.py" ] && command -v python3 >/dev/null 2>&1; then
            HIVV_CLI="python3 $REPO_ROOT/public_html/hivv-cli.py"
        elif command -v curl >/dev/null 2>&1; then
            if curl -fsSL --connect-timeout 15 --max-time 90 https://hivv.org/hivv-cli.py \
                 -o "$DATA_DIR/hivv-cli.py" 2>/dev/null && [ -s "$DATA_DIR/hivv-cli.py" ]; then
                chmod 0755 "$DATA_DIR/hivv-cli.py"
                HIVV_CLI="python3 $DATA_DIR/hivv-cli.py"
                ok "CLI downloaded to $DATA_DIR/hivv-cli.py"
            fi
        fi
        if [ -n "$HIVV_CLI" ]; then
            # shellcheck disable=SC2086
            $HIVV_CLI start && JOINED=1
        fi
        if [[ "$JOINED" -eq 1 ]]; then
            ok "you're in the hive 🐝 — this machine is now a node"
            sleep 3
            info "network : hivv nodes"
            info "talk    : hivv chat \"hello\""
            info "opt out : hivv volunteer off"
        else
            warn "the agent did not start — try: hivv start"
            warn "install the CLI first: curl -sSL https://hivv.org/install-hivv.sh | bash"
        fi
    else
        info "running local-only (not registered as a hive node)"
        info "to join later: hivv start"
    fi
else
    fail "gateway did not come up — see $LOG"
    tail -20 "$LOG" || true
    exit 1
fi

# ── contributor tools (optional) ─────────────────────────────────────────
# HIVV's source is open and AI agents are welcome to change it. git + gh are
# NOT needed to RUN the hive — only to CONTRIBUTE to it. So this is asked,
# and the default answer is "no": most people came here to run a network,
# not to edit one. (Already installed? 'hivv contribute' sets this up later.)
if [[ "$CHECK_ONLY" -eq 0 ]]; then
    if d_have_git && d_have_gh; then
        ok "contributor tools present (git, gh)"
    else
        echo "  ${BLD}Contribute to HIVV's source?${RST}"
        echo "    HIVV is open source and AI agents are welcome to change it."
        echo "    git + the GitHub CLI let you branch, commit and open a pull request."
        echo "    Neither is needed to run the hive. You can also do it later with:"
        echo "    hivv contribute"
        echo ""
        if d_ask_yesno "Install git and the GitHub CLI now?" "n"; then
            if d_install_dev_tools; then
                ok "git + gh ready — see CONTRIBUTING.md for the agent workflow"
            else
                warn "could not install them automatically — the exact command is above"
            fi
        else
            info "skipped — install later with: hivv contribute"
        fi
        echo ""
    fi
fi
