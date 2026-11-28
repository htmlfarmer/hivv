#!/usr/bin/env bash
# scripts/portability/node-state.sh — what state does this bee hold, and
# can it be moved to another machine?
#
# The bee's identity and configuration live in the user's home, not in the
# repository:
#
#   ~/.config/hivv/       auth.json, contribute.json
#   ~/.local/share/hivv/  identity/ed25519.key, hivv.env, instance-id,
#                         dial-id, approvals.json, state.json, tiles/
#
# A clone of this repository brings the CODE and none of that. So when a
# bee moves to another machine — or onto a new disk — the question is
# always the same two:
#
#   1. what exactly has to be copied?
#   2. how do I know the right thing arrived?
#
# This script answers both. It reports every piece of state, and for the
# secret ones it reports a FINGERPRINT rather than the value, so two
# reports can be compared to prove the same identity moved — and the
# comparison is safe to paste into chat.
#
# Read-only. It changes nothing on the machine it describes.
#
# Usage:
#   scripts/portability/node-state.sh              # human-readable
#   scripts/portability/node-state.sh --json       # machine-readable
#   scripts/portability/node-state.sh --check      # exit non-zero if a
#                                                  # required piece is missing
#
# Bash 3.2 compatible — macOS ships bash 3.2, and the machine you are
# moving TO is the one you have not set up yet.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/deps.sh
if [ -f "$REPO_ROOT/scripts/lib/deps.sh" ]; then
    . "$REPO_ROOT/scripts/lib/deps.sh"
else
    echo "ERROR: scripts/lib/deps.sh not found. Run from the hivv repository." >&2
    exit 1
fi

# deps.sh names its colours D_*. Default them here so 'set -u' cannot take
# the script down on a machine where the library did not set them.
: "${D_RST:=}" "${D_BLU:=}" "${D_YLW:=}" "${D_GRN:=}" "${D_RED:=}"

JSON=0
CHECK=0
SHARD_API_PORT="${HIVV_SHARD_API_PORT:-18090}"
LOCAL_LLM_PORT="${HIVV_LOCAL_LLM_PORT:-8090}"
DIAL_PORT="${HIVV_DIAL_PORT:-3911}"

usage() {
    cat <<'EOF'
usage: node-state.sh [--json] [--check]

  --json    emit JSON (flat, dotted keys) instead of text
  --check   exit non-zero when a required piece of state is missing
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --json) JSON=1 ;;
        --check) CHECK=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [ "$JSON" -eq 1 ] && ! command -v python3 >/dev/null 2>&1; then
    echo "node-state: --json needs python3" >&2
    exit 2
fi

CFG_DIR="${HOME}/.config/hivv"
STATE_DIR="${HOME}/.local/share/hivv"
LIB_DIR="${HOME}/.local/lib/hivv"

MISSING=0
JSON_TMP=""
if [ "$JSON" -eq 1 ]; then
    JSON_TMP="$(mktemp)"
    trap 'rm -f "$JSON_TMP"' EXIT
fi

emit() {
    # emit <key> <value>
    if [ "$JSON" -eq 1 ]; then
        python3 -c 'import json,sys; sys.stdout.write("  %s: %s,\n" % (json.dumps(sys.argv[1]), json.dumps(sys.argv[2])))' \
            "$1" "${2:-}" >> "$JSON_TMP"
    else
        printf '  %-26s %s\n' "$1" "${2:-}"
    fi
}

# A secret is reported as "set, sha256:<12 hex>" — never as its value.
fingerprint() {
    if [ ! -f "$1" ]; then
        printf 'absent'
        return 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" 2>/dev/null | cut -c1-12
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" 2>/dev/null | cut -c1-12
    else
        cksum "$1" 2>/dev/null | tr -d ' ' | cut -c1-12
    fi
}

present() {
    # present <label> <path> <required>
    _label="$1"
    _path="$2"
    _required="${3:-0}"
    if [ -e "$_path" ]; then
        emit "$_label" "present"
        return 0
    fi
    emit "$_label" "absent"
    if [ "$_required" -eq 1 ]; then
        MISSING=1
    fi
    return 1
}

port_open() {
    _port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${_port}$"
        return $?
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${_port}$"
        return $?
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$_port" -sTCP:LISTEN >/dev/null 2>&1
        return $?
    fi
    return 1
}

section() {
    [ "$JSON" -eq 1 ] && return 0
    printf '%s==>%s %s\n' "$D_BLU" "$D_RST" "$1"
}

section "machine"
emit "machine.host" "$(hostname 2>/dev/null || echo unknown)"
emit "machine.os" "$(uname -s 2>/dev/null || echo unknown)"
emit "machine.arch" "$(uname -m 2>/dev/null || echo unknown)"

section "install"
present "cli.wrapper" "${HOME}/.local/bin/hivv"
present "cli.client" "${LIB_DIR}/hivv-cli.py"
present "config.dir" "$CFG_DIR"
present "state.dir" "$STATE_DIR"

section "identity"
# The identity IS the bee. A bee whose key did not travel is a new bee
# with a new identity, and the hub sees a stranger.
if [ -f "${STATE_DIR}/identity/ed25519.pub" ]; then
    emit "identity.pub" "$(tr -d '\n' < "${STATE_DIR}/identity/ed25519.pub")"
else
    emit "identity.pub" "absent"
    MISSING=1
fi
emit "identity.key" "$(fingerprint "${STATE_DIR}/identity/ed25519.key")"
emit "identity.key_bytes" "$(wc -c < "${STATE_DIR}/identity/ed25519.key" 2>/dev/null | tr -d ' ' || echo 0)"
# The dial id is the bee's address on the network.
emit "dial.id" "$(cat "${STATE_DIR}/dial-id" 2>/dev/null || echo absent)"
emit "instance.id" "$(cat "${STATE_DIR}/instance-id" 2>/dev/null || echo absent)"

section "credentials (fingerprints, never values)"
emit "auth.json" "$(fingerprint "${CFG_DIR}/auth.json")"
emit "hivv.env" "$(fingerprint "${STATE_DIR}/hivv.env")"
emit "session.secret" "$(fingerprint "${STATE_DIR}/.session-secret")"

section "state"
present "approvals.json" "${STATE_DIR}/approvals.json"
present "state.json" "${STATE_DIR}/state.json"
present "known-good.json" "${STATE_DIR}/known-good.json"
present "tiles.dir" "${STATE_DIR}/tiles"

section "services"
if command -v systemctl >/dev/null 2>&1; then
    for unit in hivv-agent.service hivv-dial.service; do
        _en="$(systemctl --user is-enabled "$unit" 2>/dev/null || echo unknown)"
        _ac="$(systemctl --user is-active "$unit" 2>/dev/null || echo unknown)"
        emit "service.${unit}" "$_en, $_ac"
    done
else
    emit "service.systemd" "not available on this platform"
fi

section "local doors"
# The KwaaiNet shard api is the network-backed door: it resolves a covering
# block chain through the DHT per request, so an answer can come from any
# node serving the model. The local llama server is the fallback.
if port_open "$SHARD_API_PORT"; then
    emit "door.shard_api" "listening on $SHARD_API_PORT"
else
    emit "door.shard_api" "closed on $SHARD_API_PORT"
fi
if port_open "$LOCAL_LLM_PORT"; then
    emit "door.local_llm" "listening on $LOCAL_LLM_PORT"
else
    emit "door.local_llm" "closed on $LOCAL_LLM_PORT"
fi
if port_open "$DIAL_PORT"; then
    emit "door.dial" "listening on $DIAL_PORT"
else
    emit "door.dial" "closed on $DIAL_PORT"
fi

if [ "$JSON" -eq 1 ]; then
    printf '{\n'
    sed -e '$ s/,$//' "$JSON_TMP"
    printf '}\n'
    exit $MISSING
fi

if [ "$MISSING" -eq 1 ]; then
    printf '%s!%s some required state is missing — see the lines marked absent above\n' "$D_YLW" "$D_RST"
    if [ "$CHECK" -eq 1 ]; then
        exit 1
    fi
fi
exit 0
