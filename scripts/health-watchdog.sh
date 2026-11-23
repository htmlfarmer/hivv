#!/bin/bash
# =============================================================================
# hivv gateway health watchdog — restart a DEAD or WEDGED gateway automatically.
#
# WHY THIS EXISTS (2026-11-22 incident):
#   At 00:00:38 the gateway's pg pool wedged (0 sockets to Postgres, waiters
#   queued forever). Every DB-backed route hung — including /api/health —
#   while pm2 saw the process alive and reported "online". The site was down
#   for 10 HOURS because nothing could distinguish "process running" from
#   "process answering".
#
# This closes that gap: probe the health endpoint (which now has its own 3s
# deadline), and after 2 consecutive failures restart via pm2. The in-process
# pool timeouts (connectionTimeoutMillis / statement_timeout) make the failure
# VISIBLE to this probe instead of invisible-hang.
#
# Cron (every minute):
#   * * * * * /var/www/vhosts/hivv.org/scripts/health-watchdog.sh
#
# State file keeps the consecutive-failure count so one blip never restarts
# anything; only 2 in a row (~2 min down) triggers remediation. Cooldown of
# 10 min between restarts prevents restart-loops when Postgres itself is down
# (restarting the gateway cannot fix a dead database).
# =============================================================================
set -uo pipefail

HEALTH_URL="${HIVV_HEALTH_URL:-http://127.0.0.1:3011/api/health}"
TIMEOUT_S="${HIVV_HEALTH_TIMEOUT:-8}"
FAIL_THRESHOLD="${HIVV_HEALTH_FAILS:-2}"
COOLDOWN_S=600
# An EXPLICITLY-set PM2_BIN is trusted as-is — it is the caller's choice
# (tests inject /bin/true; an operator may point at a specific pm2). Only
# the DEFAULT gets validated: resolving the default unconditionally could
# erase an explicit override, and on the macOS runner that is exactly what
# happened — the dead-endpoint test set PM2_BIN=/bin/true, the script
# re-resolved it to empty ("pm2 not found") and logged CRITICAL instead of
# issuing the restart (CI, 2026-11-23).
if [ -z "${PM2_BIN:-}" ]; then
    PM2_BIN="$HOME/.local/bin/pm2"
    [ -x "$PM2_BIN" ] || PM2_BIN="$(command -v pm2 || true)"
fi
STATE_DIR="${HIVV_WATCHDOG_STATE:-/var/www/vhosts/hivv.org/logs}"
LOG="$STATE_DIR/health-watchdog.log"
COUNT_FILE="$STATE_DIR/.health-watchdog-fails"
LAST_RESTART_FILE="$STATE_DIR/.health-watchdog-last-restart"

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# Trim the log so it can never grow unbounded (keep last 500 lines).
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 1000 ]; then
    tail -500 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# --- probe: any HTTP answer counts as "up"; only 000/timeout is "down" ------
# A 503 is a conscious answer (db down, but the process is serving) — the
# gateway self-reports; restarting it would not help. 000 = hung or dead.
#
# `|| code=000` (NOT `|| echo 000`): curl already prints 000 from -w on a
# failed transfer, so appending echo would make code="000\n000", which never
# equals "000" — a dead gateway would read as healthy. The assignment's exit
# status is curl's, so the fallback only fires when curl produced nothing.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_S" "$HEALTH_URL" 2>/dev/null)" || code=000
code="$(printf '%s' "$code" | tr -d '[:space:]')"   # belt & braces: one token
[ -n "$code" ] || code=000

if [ "$code" != "000" ]; then
    if [ -f "$COUNT_FILE" ]; then
        prev="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
        [ "$prev" != "0" ] && log "recovered after $prev failed probe(s) (HTTP $code)"
    fi
    rm -f "$COUNT_FILE"
    exit 0
fi

fails=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" >"$COUNT_FILE"
log "probe $fails/$FAIL_THRESHOLD failed (HTTP 000) for $HEALTH_URL"

[ "$fails" -lt "$FAIL_THRESHOLD" ] && exit 0

# --- cooldown: don't thrash when the root cause isn't the gateway ----------
now="$(date +%s)"
if [ -f "$LAST_RESTART_FILE" ]; then
    last="$(cat "$LAST_RESTART_FILE" 2>/dev/null || echo 0)"
    if [ $(( now - last )) -lt "$COOLDOWN_S" ]; then
        log "gateway still down but inside ${COOLDOWN_S}s restart cooldown — waiting (Postgres may be the real problem)"
        exit 0
    fi
fi

# --- remediate --------------------------------------------------------------
if [ -z "$PM2_BIN" ]; then
    log "CRITICAL: gateway down $fails times but pm2 not found — manual restart needed"
    exit 1
fi

log "gateway unresponsive for $fails consecutive probes — restarting hivv-ai-gateway via pm2"
if "$PM2_BIN" restart hivv-ai-gateway >>"$LOG" 2>&1; then
    echo "$now" >"$LAST_RESTART_FILE"
    echo 0 >"$COUNT_FILE"
    log "restart issued — probing again in the next cron tick"
else
    log "CRITICAL: pm2 restart FAILED (exit $?) — manual intervention required"
    exit 1
fi
