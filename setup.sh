#!/usr/bin/env bash
# HIVV.org AI Gateway v2.0 — Setup Script
#
# Two modes:
#   • LOCAL-FIRST (default)  — no PostgreSQL, no secrets, no internet.
#                              Runs on http://127.0.0.1:3011 out of the box.
#   • HOSTED (--db)           — full gateway with PostgreSQL + PM2 + admin user.
#
# This script installs what it can and always tells you the exact command to
# type when it can't. It never just says "not installed" and dies.
#
# Usage:
#   ./setup.sh                 # local-first (recommended)
#   ./setup.sh --db            # hosted mode with PostgreSQL
#   ./setup.sh --check         # check only, change nothing
#   ./setup.sh --with-llm      # also offer to install a local model server
#   ./setup.sh --help

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/api"
PUBLIC_DIR="$SCRIPT_DIR/public_html"

# shellcheck source=scripts/lib/deps.sh
. "$SCRIPT_DIR/scripts/lib/deps.sh"

RED="$D_RED"; GREEN="$D_GRN"; YELLOW="$D_YLW"; BLUE="$D_BLU"; NC="$D_RST"
BOLD="$D_BLD"; DIM="$D_DIM"

MODE="local"          # local | hosted
CHECK_ONLY=0
WITH_LLM=0
ASSUME_YES=0
PORT="${HIVV_PORT:-3011}"

print_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }
print_success(){ echo -e "${GREEN}[OK]${NC} $1"; }
print_warning(){ echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error()  { echo -e "${RED}[ERROR]${NC} $1"; }
print_hint()   { echo -e "    ${BLUE}\$ ${NC}$1"; }

usage() {
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --db|--hosted|--postgres) MODE="hosted"; shift ;;
        --local|--local-first)    MODE="local"; shift ;;
        --check)                  CHECK_ONLY=1; shift ;;
        --with-llm)               WITH_LLM=1; shift ;;
        --yes|-y)                 ASSUME_YES=1; shift ;;
        --port)                   PORT="$2"; shift 2 ;;
        --port=*)                 PORT="${1#*=}"; shift ;;
        -h|--help)                usage ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; usage ;;
    esac
done

echo "========================================"
echo "  HIVV.org AI Gateway v2.0 Setup"
echo "========================================"
echo ""

detect_platform
d_print_platform_summary

# ── STEP 0: install scope — user-local or system-wide? ──────────────────
# ASK. Do not silently pick one. A user-local install needs no password and
# touches nothing outside $HOME; a system-wide install helps every user on
# the machine and sets up a boot-time service. Both are legitimate — so the
# person decides, and we tell them exactly what each one means.
INSTALL_SCOPE="user"
if [[ "$MODE" == "hosted" ]]; then
    # hosted mode already implies a system service
    INSTALL_SCOPE="system"
elif [[ "$CHECK_ONLY" -eq 0 ]] && [[ "$(id -u 2>/dev/null || echo 0)" -ne 0 ]]; then
    echo "  ${BOLD}Where should HIVV be installed?${NC}"
    echo ""
    echo "    ${BOLD}1) Just for me${NC} (recommended to start)"
    echo "       · lives in ~/.local/share/hivv — nothing else on this computer changes"
    echo "       · no password needed, nothing to undo"
    echo "       · starts on login"
    echo ""
    echo "    ${BOLD}2) System-wide${NC} (for everyone on this machine)"
    echo "       · lives in /usr/local — every user gets the 'hivv' command"
    echo "       · runs as a boot-time service, even with nobody logged in"
    echo "       · asks for your sudo password"
    echo ""
    SCOPE_CHOICE="$(d_ask_choice "Choose an install scope" "Just for me (no password)|System-wide (asks for your password)" 1)"
    if [[ "$SCOPE_CHOICE" == "2" ]]; then
        INSTALL_SCOPE="system"
    fi
    echo ""
    if [[ "$INSTALL_SCOPE" == "system" ]] && ! d_can_escalate; then
        if d_can_prompt_sudo; then
            print_step "Requesting administrator access…"
            if sudo -v; then
                D_SUDO="sudo"
                print_success "Administrator access granted"
            else
                print_warning "Administrator access was declined — continuing with a user-local install"
                INSTALL_SCOPE="user"
            fi
        else
            print_warning "System-wide needs administrator access — continuing with a user-local install"
            INSTALL_SCOPE="user"
        fi
        echo ""
    fi
fi

if [[ "$INSTALL_SCOPE" == "system" ]]; then
    print_success "Install scope: system-wide (all users on this machine)"
else
    print_success "Install scope: just for you ($HOME)"
fi
echo ""

# ── STEP 1: Node.js (the one hard requirement) ──────────────────────────
print_step "Checking Node.js..."
if ! d_install_node; then
    echo ""
    print_error "Node.js 18+ is required and could not be installed automatically."
    echo ""
    echo "  Pick whichever fits your machine, then run this script again:"
    echo ""
    d_node_manual_hint
    echo ""
    echo "  After installing, verify with:  node --version"
    echo "  Then re-run:                   bash ./setup.sh"
    echo ""
    exit 1
fi
print_success "Node.js $(node --version) ready"

print_step "Checking npm..."
if command -v npm >/dev/null 2>&1; then
    print_success "npm $(npm --version) ready"
else
    print_warning "npm not found — it ships with Node.js. Try reinstalling Node.js."
fi

# ── STEP 2: Python (optional — the hivv CLI needs it) ──────────────────
print_step "Checking Python (optional — needed for the hivv CLI)..."
if d_install_python; then
    print_success "Python ready"
else
    print_warning "Python unavailable — the gateway still works, only the 'hivv' CLI is missing."
fi

# ── STEP 3: local model server — ASK, don't just print instructions ─────
print_step "Probing for local model servers..."
FOUND_MODELS=0
for p in 8080 8081 8082 8090 11434 1234 5000 8000; do
    if command -v curl >/dev/null 2>&1; then
        if curl -fsS --max-time 1 "http://127.0.0.1:$p/v1/models" >/dev/null 2>&1 \
           || curl -fsS --max-time 1 "http://127.0.0.1:$p/api/tags" >/dev/null 2>&1; then
            print_success "model server on 127.0.0.1:$p"
            FOUND_MODELS=1
        fi
    fi
done

if [[ "$FOUND_MODELS" -eq 0 ]]; then
    print_warning "No local model server found — the gateway runs, but it has no brain yet."
    echo ""
    echo "  A local model is what makes this machine useful to the hive."
    echo "  It stays on your computer — open weights, no big-tech, no API bill."
    echo ""

    # Offer the install. Skipped in --check mode (nothing may change).
    if [[ "$CHECK_ONLY" -eq 0 ]] && [[ "$MODE" == "local" ]]; then
        LLM_CHOICE="$(d_ask_choice \
            "Install a local AI model?" \
            "Yes — install llama.cpp + a recommended open model (best fit for this CPU, ~1-2GB)|Yes — install Ollama instead (simpler, one session at a time)|No — I'll add a cloud API key later (no local model)" \
            3)"
        case "$LLM_CHOICE" in
            1)
                print_step "Installing llama.cpp + a recommended model..."
                if command -v hivv >/dev/null 2>&1; then
                    hivv llm setup --yes && print_success "Local model installed" \
                        || print_warning "llama.cpp setup did not finish — retry with: hivv llm setup"
                elif [ -f "$PUBLIC_DIR/hivv-cli.py" ]; then
                    python3 "$PUBLIC_DIR/hivv-cli.py" llm setup --yes && print_success "Local model installed" \
                        || print_warning "llama.cpp setup did not finish — retry with: python3 public_html/hivv-cli.py llm setup"
                else
                    print_warning "hivv CLI not found — install a model manually:"
                    print_hint "curl -fsSL https://ollama.com/install.sh | sh"
                fi
                ;;
            2)
                print_step "Installing Ollama..."
                case "$D_PKG" in
                    apt)    d_run_privileged apt-get update >/dev/null 2>&1 || true
                            d_run_privileged apt-get install -y ollama >/dev/null 2>&1 ;;
                    dnf)    d_run_privileged dnf install -y ollama >/dev/null 2>&1 ;;
                    yum)    d_run_privileged yum install -y ollama >/dev/null 2>&1 ;;
                    pacman) d_run_privileged pacman -S --noconfirm ollama >/dev/null 2>&1 ;;
                    apk)    d_run_privileged apk add --no-cache ollama >/dev/null 2>&1 ;;
                    brew)   brew install ollama >/dev/null 2>&1 ;;
                    *)      curl -fsSL https://ollama.com/install.sh | sh >/dev/null 2>&1 || true ;;
                esac
                if command -v ollama >/dev/null 2>&1; then
                    print_success "Ollama installed"
                    print_hint "ollama serve    # start it, then: ollama pull gemma3:4b"
                else
                    print_warning "Ollama install did not finish — retry with: curl -fsSL https://ollama.com/install.sh | sh"
                fi
                ;;
            3)
                echo "  Skipped — you can add one any time:"
                print_hint "hivv llm setup                 # local model"
                print_hint "hivv add openai <your-key>     # or a cloud provider"
                ;;
        esac
        echo ""
    else
        echo "  Install one with:"
        case "$D_OS" in
            Linux)
                case "$D_PKG" in
                    apt)    print_hint "sudo apt-get install -y ollama && ollama serve" ;;
                    dnf)    print_hint "sudo dnf install -y ollama && ollama serve" ;;
                    pacman) print_hint "sudo pacman -S --noconfirm ollama && ollama serve" ;;
                    apk)    print_hint "sudo apk add ollama && ollama serve" ;;
                    brew)   print_hint "brew install ollama && ollama serve" ;;
                    *)      print_hint "curl -fsSL https://ollama.com/install.sh | sh" ;;
                esac
                ;;
            Darwin)   print_hint "brew install ollama && ollama serve" ;;
            windows)  print_hint "winget install Ollama.Ollama" ;;
            *)        print_hint "curl -fsSL https://ollama.com/install.sh | sh" ;;
        esac
        echo "    Or download llama.cpp: https://github.com/ggerganov/llama.cpp/releases"
    fi
fi

# ── STEP 4: database — OPTIONAL ─────────────────────────────────────────
print_step "Checking PostgreSQL (optional)..."
DB_NAME="${DB_NAME:-hivv}"
DB_USER="${DB_USER:-hivv}"
DB_HOST="${DB_HOST:-localhost}"
DB_PASSWORD=""
DB_PASSWORD_SET=0

if [[ "$MODE" == "hosted" ]]; then
    if ! d_install_postgres; then
        echo ""
        print_error "Hosted mode needs PostgreSQL. Install it with one of:"
        echo ""
        case "$D_PKG" in
            apt)    print_hint "sudo apt-get install -y postgresql postgresql-client" ;;
            dnf)    print_hint "sudo dnf install -y postgresql" ;;
            yum)    print_hint "sudo yum install -y postgresql" ;;
            pacman) print_hint "sudo pacman -S --noconfirm postgresql" ;;
            apk)    print_hint "sudo apk add postgresql postgresql-client" ;;
            zypper) print_hint "sudo zypper install -y postgresql" ;;
            brew)   print_hint "brew install postgresql@16 && brew services start postgresql@16" ;;
            *)      print_hint "install PostgreSQL from https://www.postgresql.org/download/" ;;
        esac
        echo ""
        echo "  …or skip the database entirely and run local-first:"
        print_hint "bash ./setup.sh"
        echo ""
        exit 1
    fi

    # Generate (never hardcode) a DB password and persist it 0600.
    DB_PW_FILE="$SCRIPT_DIR/.db-password"
    if [ -n "${HIVV_DB_PASSWORD:-}" ]; then
        DB_PASSWORD="$HIVV_DB_PASSWORD"
    elif [ -f "$DB_PW_FILE" ]; then
        DB_PASSWORD="$(cat "$DB_PW_FILE")"
    elif command -v openssl >/dev/null 2>&1; then
        DB_PASSWORD="$(openssl rand -hex 24)"
        printf '%s' "$DB_PASSWORD" > "$DB_PW_FILE"
        chmod 600 "$DB_PW_FILE"
        print_warning "Generated a DB password into $DB_PW_FILE (mode 0600)"
    else
        print_error "HIVV_DB_PASSWORD is not set and openssl is unavailable to generate one."
        print_hint "export HIVV_DB_PASSWORD=\$(openssl rand -hex 24)"
        exit 1
    fi

    print_step "Testing database connection..."
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" &> /dev/null; then
        print_success "Database connection OK"
    else
        print_warning "Database connection failed (role/db may not exist yet). Trying to create it..."
        if command -v sudo >/dev/null 2>&1 || [ "$(id -u)" -eq 0 ]; then
            if [ "$(id -u)" -eq 0 ]; then
                su - postgres -c "psql -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD' SUPERUSER;\"" &>/dev/null || true
                su - postgres -c "psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\"" &>/dev/null || true
            else
                sudo -n su - postgres -c "psql -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD' SUPERUSER;\"" &>/dev/null || true
                sudo -n su - postgres -c "psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\"" &>/dev/null || true
            fi
        fi
        if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" &> /dev/null; then
            print_success "Database role + database created"
        else
            print_warning "Still cannot connect. Migrations may fail — continuing."
            echo "    Fix it with:"
            print_hint "sudo -u postgres psql -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD' SUPERUSER;\""
            print_hint "sudo -u postgres psql -c \"CREATE DATABASE $DB_NAME OWNER $DB_USER;\""
        fi
    fi

    # ── migrations ────────────────────────────────────────────────────
    print_step "Running database migrations..."
    if [ -d "$API_DIR/migrations" ]; then
        for mig in "$API_DIR/migrations"/*.sql; do
            [ -e "$mig" ] || continue
            mlog="$(mktemp)"
            if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$mig" &> "$mlog"; then
                print_success "$(basename "$mig")"
            else
                print_warning "$(basename "$mig") had issues (some items may already exist)"
                grep -i error "$mlog" | head -3 || true
            fi
            rm -f "$mlog"
        done
    fi
else
    print_success "Skipping PostgreSQL — local-first mode needs no database"
fi

# ── STEP 5: npm dependencies ────────────────────────────────────────────
print_step "Installing API dependencies..."
cd "$API_DIR" || exit 1
if [ -f "package.json" ]; then
    if [ -f "package-lock.json" ]; then
        npm ci --silent --no-audit --no-fund 2>/dev/null || npm install --silent --no-audit --no-fund
    else
        npm install --silent --no-audit --no-fund
    fi
    if [ -d "node_modules" ]; then
        print_success "Dependencies installed"
    else
        print_error "npm install failed"
        echo "    Try manually:"
        print_hint "cd api && npm install"
        exit 1
    fi
else
    print_error "package.json not found in $API_DIR"
    exit 1
fi

# ── STEP 6: local-first environment (no DB, no secrets) ─────────────────
DATA_DIR="${HIVV_DATA_DIR:-}"
if [ -z "$DATA_DIR" ]; then
    case "$D_OS" in
        windows) DATA_DIR="${LOCALAPPDATA:-$HOME/AppData/Local}/hivv" ;;
        Darwin)  DATA_DIR="$HOME/Library/Application Support/hivv" ;;
        *)       DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/hivv" ;;
    esac
fi

if [[ "$MODE" == "local" ]]; then
    print_step "Preparing local-first data directory..."
    if mkdir -p "$DATA_DIR" "$DATA_DIR/keys" "$DATA_DIR/logs" 2>/dev/null; then
        chmod 700 "$DATA_DIR" 2>/dev/null || true
        ENV_FILE="$DATA_DIR/hivv.env"
        if [ -f "$ENV_FILE" ]; then
            print_success "$ENV_FILE (kept — your settings are preserved)"
        else
            {
                echo "# HIVV local-first environment (generated $(date -u +%Y-%m-%dT%H:%M:%SZ))"
                echo "HIVV_MODE=local"
                echo "HIVV_DB_REQUIRED=0"
                echo "HIVV_DATA_DIR=$DATA_DIR"
                echo "HIVV_PORT=$PORT"
                echo "HIVV_HIVE_JOIN=0"
                echo "HIVV_HIVE_URL=https://hivv.org"
                echo "HIVV_SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
                echo "NODE_ENV=production"
            } > "$ENV_FILE"
            chmod 600 "$ENV_FILE" 2>/dev/null || true
            print_success "$ENV_FILE (created)"
        fi
    else
        print_warning "Could not create $DATA_DIR — falling back to a temp dir"
        DATA_DIR="$(mktemp -d)"
        mkdir -p "$DATA_DIR/keys" "$DATA_DIR/logs"
    fi

    if [[ "$CHECK_ONLY" -eq 1 ]]; then
        print_success "Check complete — nothing was started or changed"
        exit 0
    fi

    # ── start local-first gateway ─────────────────────────────────────
    print_step "Starting the local gateway..."
    LOG="$DATA_DIR/logs/hivv-local.log"
    set -a
    # shellcheck disable=SC1090
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    set +a
    export PORT
    nohup node server.js > "$LOG" 2>&1 &
    GW_PID=$!
    echo "$GW_PID" > "$DATA_DIR/hivv.pid"
    sleep 3

    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        print_success "Gateway is healthy on http://127.0.0.1:$PORT"
    else
        print_warning "Gateway did not come up — see $LOG"
        tail -20 "$LOG" 2>/dev/null || true
        exit 1
    fi

    echo ""
    echo "========================================"
    echo "  Access Points"
    echo "========================================"
    echo -e "  ${GREEN}Main Site:${NC}     http://127.0.0.1:$PORT/"
    echo -e "  ${GREEN}Health:${NC}        http://127.0.0.1:$PORT/api/health"
    echo -e "  ${GREEN}OpenAPI:${NC}       http://127.0.0.1:$PORT/v1"
    echo -e "  ${GREEN}Partner API:${NC}   http://127.0.0.1:$PORT/api/partner/manifest"
    echo ""
    echo "  Logs:   $LOG"
    echo "  Stop:   kill \$(cat '$DATA_DIR/hivv.pid')"
    echo ""

    # ── join the global hive? ─────────────────────────────────────────
    # The gateway above is LOCAL — it does NOT register this machine as a
    # hive node. That needs the CLI agent (`hivv start`), which registers with
    # the hub. So we ASK and actually do it, instead of printing a README line
    # the user has to follow by hand.
    JOIN_HIVE=0
    if [[ "$CHECK_ONLY" -eq 0 ]]; then
        echo ""
        echo "  ${BOLD}Join the global hive?${NC}"
        echo "    Your computer becomes a bee — it shares spare CPU/GPU with the"
        echo "    network and can serve AI requests. You can opt out any time:"
        echo "    hivv volunteer off"
        echo ""
        if d_ask_yesno "Join the hive now?" "y"; then
            JOIN_HIVE=1
        fi
        echo ""
    fi

    if [[ "$JOIN_HIVE" -eq 1 ]]; then
        print_step "Installing the hivv node agent..."
        HIVV_JOINED=0

        # The node agent lives in the CLI (`hivv start`), which registers with
        # the hub. Make sure a usable CLI exists:
        #   1. the `hivv` wrapper on PATH
        #   2. the CLI in this clone (works, but is not on PATH)
        #   3. neither → install the CLI from the hub
        HIVV_CLI=""
        if command -v hivv >/dev/null 2>&1; then
            HIVV_CLI="hivv"
        elif [ -f "$PUBLIC_DIR/hivv-cli.py" ] && command -v python3 >/dev/null 2>&1; then
            HIVV_CLI="python3 $PUBLIC_DIR/hivv-cli.py"
        else
            print_step "Fetching the hivv CLI..."
            if curl -fsSL --connect-timeout 15 --max-time 90 https://hivv.org/hivv-cli.py \
                 -o "$DATA_DIR/hivv-cli.py" 2>/dev/null && [ -s "$DATA_DIR/hivv-cli.py" ]; then
                chmod 0755 "$DATA_DIR/hivv-cli.py"
                HIVV_CLI="python3 $DATA_DIR/hivv-cli.py"
                print_success "CLI downloaded to $DATA_DIR/hivv-cli.py"
            fi
        fi

        if [ -n "$HIVV_CLI" ]; then
            # shellcheck disable=SC2086
            $HIVV_CLI start && HIVV_JOINED=1
        fi

        if [[ "$HIVV_JOINED" -eq 1 ]]; then
            print_success "You're in the hive 🐝 — this machine is now a node"
            sleep 3   # let the agent heartbeat once so the hub has it
            echo ""
            echo "  See the whole network:  hivv nodes"
            echo "  Talk to the hive:      hivv chat \"hello\""
            echo "  Opt out of sharing:    hivv volunteer off"
            echo ""
        else
            print_warning "The agent did not start — try manually: hivv start"
            echo "  (install the CLI first: curl -sSL https://hivv.org/install-hivv.sh | bash)"
            echo ""
        fi
    else
        echo "  ${DIM}Not joining the hive (local-only). To join later:${NC}"
        print_hint "hivv start            # registers this machine as a bee"
        print_hint "hivv nodes            # see the network"
        echo ""
    fi
    exit 0
fi

# ── HOSTED MODE from here on ────────────────────────────────────────────
if [[ "$CHECK_ONLY" -eq 1 ]]; then
    print_success "Check complete — nothing was started or changed"
    exit 0
fi

print_step "Checking PM2..."
if ! d_install_pm2; then
    print_error "PM2 is required for hosted mode"
    print_hint "npm install -g pm2"
    exit 1
fi

print_step "Stopping existing instance..."
pm2 stop hivv-ai-gateway 2>/dev/null || true
pm2 delete hivv-ai-gateway 2>/dev/null || true
print_success "Stopped previous instance"

print_step "Starting AI Gateway server..."
export NODE_ENV=production
export PORT="$PORT"
export DB_HOST="${DB_HOST}"
export DB_PORT="${DB_PORT:-5432}"
export DB_NAME="$DB_NAME"
export DB_USER="$DB_USER"
export HIVV_DB_PASSWORD="$DB_PASSWORD"
if [ -z "${HIVV_SESSION_SECRET:-}" ]; then
    if command -v openssl >/dev/null 2>&1; then
        HIVV_SESSION_SECRET="$(openssl rand -hex 32)"
    else
        HIVV_SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    fi
fi
export HIVV_SESSION_SECRET

cd "$API_DIR" || exit 1
pm2 start ecosystem.config.js --env production

sleep 2
print_step "Verifying server..."
sleep 3

if curl -s "http://127.0.0.1:$PORT/api/health" | grep -q "healthy"; then
    print_success "Server is healthy and running!"
else
    print_warning "Server may still be starting. Check: pm2 status"
    print_hint "pm2 logs hivv-ai-gateway --lines 50"
fi

echo ""
echo "========================================"
echo "  Server Status"
echo "========================================"
pm2 status hivv-ai-gateway
echo ""

echo "========================================"
echo "  Access Points"
echo "========================================"
echo -e "  ${GREEN}Main Site:${NC}     http://localhost:$PORT/"
echo -e "  ${GREEN}Admin Panel:${NC}   http://localhost:$PORT/admin.html"
echo -e "  ${GREEN}API Health:${NC}    http://localhost:$PORT/api/health"
echo -e "  ${GREEN}OpenAPI Spec:${NC}  http://localhost:$PORT/v1"
echo ""

# ── admin user ──────────────────────────────────────────────────────────
print_step "Checking for admin user..."
ADMIN_EXISTS=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM users WHERE role IN ('admin', 'owner')" 2>/dev/null || echo "0")
ADMIN_EXISTS=$(echo "$ADMIN_EXISTS" | tr -d ' ')

if [ "$ADMIN_EXISTS" -eq "0" ]; then
    echo ""
    echo "========================================"
    echo "  Create Admin User"
    echo "========================================"
    if [ -t 0 ]; then
        read -p "  Enter admin username: " ADMIN_USER
        read -s -p "  Enter admin password: " ADMIN_PASS
        echo ""
    else
        ADMIN_USER="admin"
        ADMIN_PASS="$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')"
        echo "  Non-interactive — generated credentials:"
        echo "    username: $ADMIN_USER"
        echo "    password: $ADMIN_PASS"
        echo "  (change it after your first login)"
    fi

    if [ -n "${ADMIN_USER:-}" ] && [ -n "${ADMIN_PASS:-}" ]; then
        HASH=$(node -e "
            const bcrypt = require('bcryptjs');
            bcrypt.hash(process.argv[1], 12).then(h => console.log(h)).catch(e => console.error(e));
        " "$ADMIN_PASS" 2>/dev/null)

        if [ -n "$HASH" ]; then
            PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c \
                "INSERT INTO users (username, password_hash, display_name, role)
                 VALUES ('$ADMIN_USER', '$HASH', '$ADMIN_USER', 'admin')" 2>&1 \
                && print_success "Admin user '$ADMIN_USER' created!" \
                || print_warning "Could not create admin user. Check the users table schema."
        else
            print_warning "Could not generate password hash"
        fi
    else
        print_warning "Skipped admin user creation"
    fi
else
    print_success "Admin user already exists"
fi

echo ""
echo "========================================"
echo -e "  ${GREEN}Setup Complete!${NC}"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Open http://localhost:$PORT/admin.html"
echo "  2. Login with your admin credentials"
echo "  3. Add your AI API keys in Keys section"
echo "  4. Configure user quotas in Users section"
echo ""
echo "To view logs: pm2 logs hivv-ai-gateway"
echo "To restart:   pm2 restart hivv-ai-gateway"
echo ""
