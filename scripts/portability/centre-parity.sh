#!/usr/bin/env bash
# scripts/portability/centre-parity.sh — can these two boxes serve the
# SAME hub?
#
# Running a second centre is easy. Running a second centre that does not
# CORRUPT the first is not, and the difference is four 0600 files.
#
# The gateway's secrets live next to the code, not in the repository:
#
#   api/.session-secret   signs session cookies
#   api/.control-token    authorises the control endpoints
#   api/.encryption-key   encrypts data at rest
#   api/.db-password      reaches the database
#
# They are deliberately not in git. That is the right call, and it is also
# why a second centre fails in a way that looks like something else: a
# session signed by the old centre is REJECTED by the new one, so every
# user is "mysteriously logged out" — which reads as a bug in the gateway
# rather than a missing file.
#
# This tool fingerprints those files and compares two centres. It never
# prints a secret, only whether two centres agree.
#
# Usage:
#   scripts/portability/centre-parity.sh --report FILE   # write this centre's report
#   scripts/portability/centre-parity.sh --against FILE   # compare this centre to FILE
#
# Read-only. It changes nothing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/lib/deps.sh
if [ -f "$REPO_ROOT/scripts/lib/deps.sh" ]; then
    . "$REPO_ROOT/scripts/lib/deps.sh"
else
    echo "ERROR: scripts/lib/deps.sh not found. Run from the hivv repository." >&2
    exit 1
fi
: "${D_RST:=}" "${D_BLU:=}" "${D_YLW:=}" "${D_GRN:=}"

REPORT_OUT=""
AGAINST=""
CHECK=0
MODE="centre"
BEE="either"

usage() {
    cat <<'EOF'
usage: centre-parity.sh --report FILE [--check] [--mode MODE] [--bee same|different]
       centre-parity.sh --against FILE [--mode MODE] [--bee same|different]

  --report FILE   write this centre's parity report to FILE
  --against FILE  compare this centre against a report written elsewhere
  --check         with --report, exit non-zero if a required secret is missing

  --mode MODE     which kind of deployment this is:
                    centre   the full hivv.org centre (database, TLS, operator
                             secrets). Two of these are ONE site: their
                             secrets MUST match.
                    home     a self-hosted local-first install. Two of these
                             are TWO independent sites: their identities and
                             hub credentials MUST differ.
                    node     a node-only box: no gateway, no database, no
                             TLS. Only the node's own state matters.
  --bee same|different
                  what you intend the bee identity to do:
                    same       one bee, one place at a time (failover)
                    different  two independent bees (capacity)
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --report) shift; REPORT_OUT="${1:-}" ;;
        --against) shift; AGAINST="${1:-}" ;;
        --check) CHECK=1 ;;
        --mode) shift; MODE="${1:-centre}" ;;
        --bee) shift; BEE="${1:-either}" ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

case "$MODE" in
    centre|home|node) ;;
    *) echo "centre-parity: unknown mode: $MODE (centre|home|node)" >&2; exit 2 ;;
esac
case "$BEE" in
    same|different|either) ;;
    *) echo "centre-parity: --bee must be same, different or either" >&2; exit 2 ;;
esac

if [ -z "$REPORT_OUT" ] && [ -z "$AGAINST" ]; then
    usage >&2
    exit 2
fi

hash_of() {
    # hash_of <string-on-stdin>
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | cut -c1-12
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | cut -c1-12
    else
        cksum | tr -d ' ' | cut -c1-12
    fi
}

fingerprint() {
    # fingerprint <path> — a stable 12-hex digest, or "absent".
    if [ ! -f "$1" ]; then
        printf 'absent'
        return 1
    fi
    hash_of < "$1"
}

value_fingerprint() {
    # value_fingerprint <value> — the same, for a value already in memory.
    if [ -z "${1:-}" ]; then
        printf 'absent'
        return 1
    fi
    printf '%s' "$1" | hash_of
}

# The four operator files, and the environment override for each.
# In api/ecosystem.config.js the ENVIRONMENT wins, so it is checked first.
secret_fp() {
    # secret_fp <env-var> <file-relative-to-repo>
    if [ -n "${!1:-}" ]; then
        value_fingerprint "${!1}"
        return 0
    fi
    fingerprint "$REPO_ROOT/$2"
}

SESSION_FP="$(secret_fp HIVV_SESSION_SECRET api/.session-secret)"
CONTROL_FP="$(secret_fp HIVV_CONTROL_TOKEN api/.control-token)"
ENCRYPT_FP="$(secret_fp HIVV_ENCRYPTION_KEY api/.encryption-key)"
DBPASS_FP="$(secret_fp HIVV_DB_PASSWORD api/.db-password)"
DBHOST="${DB_HOST:-localhost}"
DBPORT="${DB_PORT:-5432}"
DBNAME="${DB_NAME:-hivv}"
PUBLIC_URL="${HIVV_PUBLIC_URL:-https://hivv.org}"
HUB_KEY_FP="$(fingerprint "${HOME}/.config/hivv/auth.json")"
BEE_FP="$(fingerprint "${HOME}/.local/share/hivv/identity/ed25519.key")"
DATA_DIR="${HIVV_DATA_DIR:-${HOME}/.local/share/hivv}"
# The orchestrator's roster. LOCAL, and it does not travel — see the note
# the comparison prints.
NODES_FP="$(fingerprint "$REPO_ROOT/api/data/nodes.json")"

# json_get <file> <key> — the report is flat, with simple string values.
json_get() {
    grep -F "\"$2\": \"" "$1" 2>/dev/null | head -1 |
        # The order matters: strip the comma BEFORE the quote. The other
        # way round leaves the quote behind on every value.
        sed -e 's/^[^:]*: *"//' -e 's/,$//' -e 's/"$//'
}

emit() {
    printf '  "%s": "%s",\n' "$1" "${2:-}"
}

build_report() {
    printf '{\n'
    emit "centre.host" "$(hostname 2>/dev/null || echo unknown)"
    emit "centre.generated" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    emit "session.secret" "$SESSION_FP"
    emit "control.token" "$CONTROL_FP"
    emit "encryption.key" "$ENCRYPT_FP"
    emit "db.password" "$DBPASS_FP"
    emit "db.host" "$DBHOST"
    emit "db.port" "$DBPORT"
    emit "db.name" "$DBNAME"
    emit "public.url" "$PUBLIC_URL"
    emit "hub.auth" "$HUB_KEY_FP"
    emit "bee.identity" "$BEE_FP"
    emit "data.dir" "$DATA_DIR"
    # The LAST entry has no trailing comma: the report is JSON and a
    # strict parser rejects a trailing one. The KwaaiNet-side inventory
    # emits the same shape.
    printf '  "orchestrator.nodes": "%s"\n' "$NODES_FP"
    printf '}\n'
}

if [ -n "$REPORT_OUT" ]; then
    build_report > "$REPORT_OUT"
    printf '%s==>%s wrote %s\n' "$D_BLU" "$D_RST" "$REPORT_OUT"
    _missing=0
    for pair in "session.secret:$SESSION_FP" "control.token:$CONTROL_FP" \
                "encryption.key:$ENCRYPT_FP" "db.password:$DBPASS_FP"; do
        _name="${pair%%:*}"
        _val="${pair#*:}"
        if [ "$_val" = "absent" ]; then
            printf '%s!%s %s: ABSENT on this centre\n' "$D_YLW" "$D_RST" "$_name"
            _missing=1
        fi
    done
    if [ "$_missing" -eq 0 ]; then
        printf '%s all four operator secrets are present\n' "$D_GRN"
    elif [ "$CHECK" -eq 1 ]; then
        exit 1
    fi
    exit 0
fi

# ── compare ────────────────────────────────────────────────────────────────
if [ ! -f "$AGAINST" ]; then
    echo "centre-parity: no such report: $AGAINST" >&2
    exit 2
fi

MINE="$(mktemp)"
trap 'rm -f "$MINE"' EXIT
build_report > "$MINE"

FAILURES=0
WARNINGS=0

printf '%s==>%s parity: this centre vs %s\n\n' "$D_BLU" "$D_RST" "$(json_get "$AGAINST" centre.host)"

compare_must() {
    # compare_must <key> <label> <why>
    _key="$1"; _label="$2"; _why="$3"
    _a="$(json_get "$MINE" "$_key")"
    _b="$(json_get "$AGAINST" "$_key")"
    if [ "$_a" = "absent" ] || [ "$_b" = "absent" ]; then
        printf '  %s[warn]%s %-18s absent on one side (%s / %s)\n' "$D_YLW" "$D_RST" "$_label" "$_a" "$_b"
        WARNINGS=$((WARNINGS + 1))
    elif [ "$_a" = "$_b" ]; then
        printf '  %s[ ok ]%s %-18s matches\n' "$D_GRN" "$D_RST" "$_label"
    else
        printf '  %s[FAIL]%s %-18s DIFFERS — %s\n' "$D_RED" "$D_RST" "$_label" "$_why"
        FAILURES=$((FAILURES + 1))
    fi
}

compare_should() {
    # compare_should <key> <label>
    _key="$1"; _label="$2"
    _a="$(json_get "$MINE" "$_key")"
    _b="$(json_get "$AGAINST" "$_key")"
    if [ "$_a" = "$_b" ]; then
        printf '  %s[ ok ]%s %-18s matches\n' "$D_GRN" "$D_RST" "$_label"
    else
        printf '  %s[warn]%s %-18s differs (%s / %s)\n' "$D_YLW" "$D_RST" "$_label" "$_a" "$_b"
        WARNINGS=$((WARNINGS + 1))
    fi
}

compare_must_diff() {
    # compare_must_diff <key> <label> <why> — the two MUST be different.
    _key="$1"; _label="$2"; _why="$3"
    _a="$(json_get "$MINE" "$_key")"
    _b="$(json_get "$AGAINST" "$_key")"
    if [ "$_a" = "absent" ] || [ "$_b" = "absent" ]; then
        printf '  %s[warn]%s %-18s absent on one side (%s / %s)\n' "$D_YLW" "$D_RST" "$_label" "$_a" "$_b"
        WARNINGS=$((WARNINGS + 1))
    elif [ "$_a" != "$_b" ]; then
        printf '  %s[ ok ]%s %-18s differs (correct here)\n' "$D_GRN" "$D_RST" "$_label"
    else
        printf '  %s[FAIL]%s %-18s is the SAME — %s\n' "$D_RED" "$D_RST" "$_label" "$_why"
        FAILURES=$((FAILURES + 1))
    fi
}

# The rule set depends on what kind of deployment this is.
#
#   centre  two of these are ONE site. The operator secrets MUST match,
#           or the second centre rejects the first one's sessions.
#   home    two of these are TWO sites. The identities and hub credentials
#           MUST differ, or the hub sees one bee in two places.
#   node    a node-only box. Only its own state matters; there is nothing
#           to be interchangeable WITH.
if [ "$MODE" = "centre" ]; then
    compare_must session.secret "session secret" "a cookie signed by one centre is REJECTED by the other"
    compare_must control.token "control token" "the control endpoints reject the other centre"
    compare_must encryption.key "encryption key" "the two centres cannot read each other's data"
    compare_must db.password "db password" "the two centres reach different databases"
    echo
    compare_should db.host "database host"
    compare_should db.port "database port"
    compare_should db.name "database name"
    compare_should public.url "public url"
    compare_should hub.auth "hub credentials"
elif [ "$MODE" = "home" ]; then
    compare_must_diff hub.auth "hub credentials" "the hub sees one bee in two places"
    compare_must_diff bee.identity "bee identity" "the two bees are the same bee"
    compare_must_diff session.secret "session secret" "a shared secret means a shared sign-in"
    echo
    compare_should db.host "database host"
    compare_should public.url "public url"
else
    printf '  [info] node mode: this box has no gateway to be interchangeable with.\n'
    compare_should bee.identity "bee identity"
fi
echo

_beeb="$(json_get "$MINE" bee.identity)"
_beet="$(json_get "$AGAINST" bee.identity)"
if [ "$_beeb" = "$_beet" ] && [ "$_beeb" != "absent" ] && [ "$MODE" != "home" ]; then
    case "$BEE" in
        different)
            printf '  %s[FAIL]%s bee identity    SAME on both — one bee in two places\n' "$D_RED" "$D_RST"
            printf '         Stop one before starting the other, or give one a fresh identity.\n'
            FAILURES=$((FAILURES + 1))
            ;;
        *)
            printf '  %s[warn]%s bee identity    SAME on both — one bee in two places\n' "$D_YLW" "$D_RST"
            printf '         Stop one before starting the other, or give one a fresh identity.\n'
            WARNINGS=$((WARNINGS + 1))
            ;;
    esac
elif [ "$_beeb" != "absent" ] && [ "$_beet" != "absent" ]; then
    printf '  %s[ ok ]%s bee identity    differs — two independent bees\n' "$D_GRN" "$D_RST"
fi

echo
printf '  [info] orchestrator.nodes is LOCAL and does not travel:\n'
printf '         %s (this centre) vs %s (other centre)\n' \
    "$(json_get "$MINE" orchestrator.nodes)" "$(json_get "$AGAINST" orchestrator.nodes)"
printf '         Two centres keep two rosters. See docs/DUAL-CENTRE.md.\n'
echo

if [ "$FAILURES" -gt 0 ]; then
    printf '%sVERDICT: NOT interchangeable — %d blocking difference(s).%s\n' "$D_RED" "$FAILURES" "$D_RST"
    exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
    printf '%sVERDICT: compatible, with %d warning(s).%s\n' "$D_YLW" "$WARNINGS" "$D_RST"
    exit 0
fi
printf '%sVERDICT: interchangeable.%s\n' "$D_GRN" "$D_RST"
