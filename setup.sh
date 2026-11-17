#!/bin/bash
# HIVV.org AI Gateway v2.0 - Setup Script
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() { echo -e "${BLUE}[STEP]${NC} $1"; }
print_success() { echo -e "${GREEN}[OK]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/api"
PUBLIC_DIR="$SCRIPT_DIR/public_html"

echo "========================================"
echo "  HIVV.org AI Gateway v2.0 Setup"
echo "========================================"
echo ""

# Check if running as correct user
if [ "$(id -u)" -eq 0 ]; then
    print_warning "Running as root. Some operations may need the web server user."
fi

# Step 1: Check Node.js
print_step "Checking Node.js..."
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi
NODE_VERSION=$(node --version)
print_success "Node.js $NODE_VERSION found"

# Step 2: Check PostgreSQL
print_step "Checking PostgreSQL..."
if ! command -v psql &> /dev/null; then
    print_error "PostgreSQL client is not installed."
    exit 1
fi

DB_NAME="${DB_NAME:-hivv}"
DB_USER="${DB_USER:-hivv}"
DB_HOST="${DB_HOST:-localhost}"
DB_PASSWORD="${HIVV_DB_PASSWORD:-REDACTED_DEFAULT_DB_PASSWORD}"

print_step "Testing database connection..."
if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" &> /dev/null; then
    print_success "Database connection OK"
else
    print_warning "Database connection failed. Will attempt migration anyway."
fi

# Step 3: Run Database Migrations
print_step "Running database migrations..."

# Migration 1: Main schema (may fail on some items if already exist - that's OK)
print_step "Running migration 001_initial_schema.sql..."
if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$API_DIR/migrations/001_initial_schema.sql" &> /tmp/migration1.log; then
    print_success "Migration 1 completed"
else
    print_warning "Migration 1 had issues (some tables may already exist)"
    grep -i error /tmp/migration1.log | head -5 || true
fi

# Migration 2: Anonymous sessions
print_step "Running migration 002_anonymous_sessions.sql..."
if [ -f "$API_DIR/migrations/002_anonymous_sessions.sql" ]; then
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$API_DIR/migrations/002_anonymous_sessions.sql" &> /tmp/migration2.log; then
        print_success "Migration 2 completed"
    else
        print_warning "Migration 2 had issues"
        grep -i error /tmp/migration2.log | head -5 || true
    fi
fi

# Step 4: Install/Update npm dependencies
print_step "Installing dependencies..."
cd "$API_DIR"
if [ -f "package.json" ]; then
    npm install --silent 2>&1 | tail -5
    print_success "Dependencies installed"
else
    print_error "package.json not found"
    exit 1
fi

# Step 5: Check PM2
print_step "Checking PM2..."
if ! command -v pm2 &> /dev/null; then
    print_warning "PM2 not found. Installing globally..."
    npm install -g pm2 --silent
fi
print_success "PM2 available"

# Step 6: Stop existing instance
print_step "Stopping existing server..."
pm2 stop hivv-ai-gateway 2>/dev/null || true
pm2 delete hivv-ai-gateway 2>/dev/null || true
print_success "Stopped previous instance"

# Step 7: Start server
print_step "Starting AI Gateway server..."
export NODE_ENV=production
export PORT=3011
export DB_HOST="${DB_HOST}"
export DB_PORT="${DB_PORT:-5432}"
export DB_NAME="$DB_NAME"
export DB_USER="$DB_USER"
export HIVV_DB_PASSWORD="$DB_PASSWORD"
export HIVV_SESSION_SECRET="${HIVV_SESSION_SECRET:-$(openssl rand -hex 32)}"

pm2 start ecosystem.config.js --env production

sleep 2

# Step 8: Verify server is running
print_step "Verifying server..."
sleep 3

if curl -s http://localhost:3011/api/health | grep -q "healthy"; then
    print_success "Server is healthy and running!"
else
    print_warning "Server may still be starting. Check: pm2 status"
fi

# Step 9: Show status
echo ""
echo "========================================"
echo "  Server Status"
echo "========================================"
pm2 status hivv-ai-gateway
echo ""

# Step 10: Show URLs
echo "========================================"
echo "  Access Points"
echo "========================================"
echo -e "  ${GREEN}Main Site:${NC}     http://localhost:3011/"
echo -e "  ${GREEN}Admin Panel:${NC}   http://localhost:3011/admin.html"
echo -e "  ${GREEN}API Health:${NC}    http://localhost:3011/api/health"
echo -e "  ${GREEN}OpenAPI Spec:${NC}  http://localhost:3011/v1"
echo ""

# Step 11: Create admin user if none exists
print_step "Checking for admin user..."
ADMIN_EXISTS=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM users WHERE role IN ('admin', 'owner')" 2>/dev/null || echo "0")
ADMIN_EXISTS=$(echo "$ADMIN_EXISTS" | tr -d ' ')

if [ "$ADMIN_EXISTS" -eq "0" ]; then
    echo ""
    echo "========================================"
    echo "  Create Admin User"
    echo "========================================"
    read -p "  Enter admin username: " ADMIN_USER
    read -s -p "  Enter admin password: " ADMIN_PASS
    echo ""

    if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ]; then
        # Use node to hash password
        HASH=$(node -e "
            const bcrypt = require('bcryptjs');
            bcrypt.hash('$ADMIN_PASS', 12).then(h => console.log(h)).catch(e => console.error(e));
        " 2>/dev/null)

        if [ -n "$HASH" ]; then
            PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "
                INSERT INTO users (username, password_hash, display_name, role)
                VALUES ('$ADMIN_USER', '$HASH', '$ADMIN_USER', 'admin')
            " 2>&1 && print_success "Admin user '$ADMIN_USER' created!" || print_warning "Could not create admin user. Check if users table has correct schema."
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
echo "  1. Open http://localhost:3011/admin.html"
echo "  2. Login with your admin credentials"
echo "  3. Add your AI API keys in Keys section"
echo "  4. Configure user quotas in Users section"
echo ""
echo "To view logs: pm2 logs hivv-ai-gateway"
echo "To restart:   pm2 restart hivv-ai-gateway"
echo ""
