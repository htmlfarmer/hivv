#!/usr/bin/env bash
# secretz-hivv — scan the ENTIRE hivv.org deployment for leaked secrets.
# Layers: (1) repo code+history via the house scanner, (2) helpz secretz over
# the public surface + ops scripts, (3) raw runtime stores (logs/backups/nohup).
# Exit 0 = clean, 1 = findings. Safe to cron.
set -uo pipefail
VHOST=/var/www/vhosts/hivv.org
FAIL=0

echo "=== [1/3] repo code + git history (scan_secrets.py) ==="
(cd "$VHOST" && python3 scripts/scan_secrets.py) || FAIL=1

echo
echo "=== [2/3] public surface + ops scripts (helpz secretz --code) ==="
SEC_FAIL=0
for d in "$VHOST/public_html" "$VHOST/scripts"; do
  [ -d "$d" ] || continue
  OUT=$(~/helpz/secretz --code "$d" --no-color 2>&1)
  CRIT=$(printf '%s\n' "$OUT" | sed -n 's/.*summary: \([0-9]*\) critical.*/\1/p' | head -1)
  CRIT=${CRIT:-0}
  BROKEN=$(printf '%s\n' "$OUT" | grep -c '^grep:' || true)
  printf '%s\n' "$OUT" | grep -vE 'node_modules|\.git/' | tail -40
  echo "  -> $d: $CRIT critical, $BROKEN broken patterns (secretz tool bug: some checks silently skipped)"
  # Loud, not green: secretz exits 0 even with criticals, so count them
  # ourselves. A finding here means REVIEW, not rotation — today's 14 were
  # all false positives (form fields, docs placeholders, help text).
  [ "$CRIT" -gt 0 ] && SEC_FAIL=1
done
[ "$SEC_FAIL" -eq 0 ] || FAIL=1

echo
echo "=== [3/3] runtime stores: logs, backups, nohup ==="
HITS=$(grep -RInE '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|X-Auth-Signature: [A-Za-z0-9+/=]{40,}|auth_token"?: *"[A-Za-z0-9]{32,})' \
  "$VHOST/logs" "$VHOST/backups" "$VHOST/nohup.out" 2>/dev/null | head -20)
if [ -n "$HITS" ]; then echo "$HITS"; FAIL=1; else echo "clean ✓"; fi

echo
if [ $FAIL -eq 0 ]; then echo "VERDICT: clean ✓"; else echo "VERDICT: findings above — rotate what looks real (never silence a leak to make this pass)"; fi
exit $FAIL
