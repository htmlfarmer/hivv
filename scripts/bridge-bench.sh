#!/usr/bin/env bash
# bridge-bench.sh — latency benchmark across the bridge (KwaaiNet -> HIVV direction
# is exercised from a KwaaiNet box; this measures HIVV-side + manifest-side numbers).
#
# HOUSE RULES (load safety):
#   N <= 20 calls, serial, >= 10s spacing, max_tokens capped. Never concurrent.
# Usage: bridge-bench.sh [n]   (default 6)
set -uo pipefail
N="${1:-6}"
[ "$N" -gt 20 ] && N=20
# The repo's own location, wherever it was cloned.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${HIVV_LOG_DIR:-$ROOT/logs}/bridge-bench.jsonl"
declare -a MS
echo "bridge-bench: $N serial calls, >=10s apart"
for i in $(seq 1 "$N"); do
  T0=$(date +%s.%N)
  CODE=$(curl -sS -m 45 -o /tmp/opencode/hivv/bench_body.json -w '%{http_code}' \
    https://hivv.org/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"model":"auto","max_tokens":8,"messages":[{"role":"user","content":"Say OK"}]}')
  T1=$(date +%s.%N)
  MS[$i]=$(awk "BEGIN{printf \"%.0f\", ($T1-$T0)*1000}")
  echo "  call $i: ${MS[$i]}ms http=$CODE"
  [ "$i" -lt "$N" ] && sleep 10
done
python3 - "$N" "${MS[@]}" <<'PY' | tee -a "$OUT"
import json, sys, datetime, statistics
n = int(sys.argv[1]); vals = [int(x) for x in sys.argv[2:2+n] if x]
vals.sort()
row = {"ts": datetime.datetime.utcnow().isoformat(timespec="seconds")+"Z",
       "kind": "bench", "n": n, "min": vals[0], "p50": int(statistics.median(vals)),
       "max": vals[-1], "avg": int(statistics.mean(vals))}
print(json.dumps(row))
PY
