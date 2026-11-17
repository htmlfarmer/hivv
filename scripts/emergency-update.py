#!/usr/bin/env python3
"""Network-wide emergency CLI update for the hivv hive.

Pushes a hub-SIGNED `cli_update --force` repair plan into every ONLINE bee's
inbox — no per-box SSH/login, no `hivv upgrade --force` on each machine.

Each bee independently verifies the plan (HMAC with its own node secret,
ttl, one-shot id, op allowlist), then downloads the hub's CLI and applies it.
sha256 verification + healthcheck still apply on the bee; ONLY the LLM review
gate is bypassed — this script is the operator's explicit override, recorded
in hivv_upgrade_reviews as a forced apply.

usage:
  scripts/emergency-update.py "reason text"
  scripts/emergency-update.py --node yalla --node masjid
  scripts/emergency-update.py --dry-run            # show targets only

Watch the outcome:
  hivv upgrades                      (review outcomes across the hive)
  psql -c "SELECT node_id, action, verdict, left(to_sha256,12), reason,
                  created_at FROM hivv_upgrade_reviews
           ORDER BY created_at DESC LIMIT 10"
Plans land on each bee's next heartbeat (~60s) or instantly if its inbox
long-poll is connected. Exit codes: 0 all queued · 1 partial · 2 no targets.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HUB_LOCAL = "http://127.0.0.1:3011"
CLI = Path(__file__).resolve().parents[1] / "public_html" / "hivv-cli.py"


def _targets(nodes: list, only: list = None) -> list:
    """Pick push targets: ONLINE bees (a stale/offline bee can't receive an
    inbox plan anyway), optionally filtered by --node names/ids."""
    only = set(only or [])
    out = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        name = str(n.get("name") or n.get("id") or "")
        if not name:
            continue
        if only and name not in only:
            continue
        if str(n.get("status") or "") != "online":
            continue
        out.append(name)
    return out


def main(argv: list) -> int:
    args = list(argv)
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    only = []
    while "--node" in args:
        i = args.index("--node")
        if i + 1 >= len(args):
            print("emergency-update: --node needs a name", file=sys.stderr)
            return 2
        only.append(args[i + 1])
        del args[i:i + 2]
    reason = " ".join(args).strip() or (
        f"emergency network update {time.strftime('%Y-%m-%d %H:%M %Z')}")

    try:
        req = urllib.request.Request(
            f"{HUB_LOCAL}/api/control/nodes",
            headers={"user-agent": "hivv-emergency-update"})
        with urllib.request.urlopen(req, timeout=10) as r:
            nodes = json.loads(r.read() or b"{}").get("nodes", [])
    except Exception as e:
        print(f"emergency-update: cannot read node list from {HUB_LOCAL}: {e}",
              file=sys.stderr)
        return 2

    targets = _targets(nodes, only)
    skipped = [str(n.get("name") or n.get("id"))
               for n in nodes if isinstance(n, dict)
               and str(n.get("status") or "") != "online"]
    if not targets:
        print("emergency-update: no ONLINE bees to push to"
              + (f" (offline/stale: {', '.join(skipped)})" if skipped else ""))
        return 2

    print(f"emergency-update — {len(targets)} online bee(s), "
          f"reason: {reason[:80]}")
    queued = failed = 0
    for name in targets:
        if dry:
            print(f"  [dry-run] would push cli_update --force to {name}")
            queued += 1
            continue
        try:
            p = subprocess.run(
                [sys.executable, str(CLI), "repair", name,
                 "--op", "cli_update", "--force",
                 "--reason", reason[:200], "--ttl", "600"],
                capture_output=True, text=True, timeout=60)
            out = (p.stdout or "") + (p.stderr or "")
            if p.returncode == 0:
                queued += 1
                plan = ""
                for tok in out.split():
                    if tok.startswith("rp_"):
                        plan = tok
                        break
                print(f"  ✓ {name}  queued {plan or '(plan)'}")
            else:
                failed += 1
                print(f"  ✗ {name}  {out.strip().splitlines()[-1] if out.strip() else 'failed'}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {name}  {e}")

    print(f"\n{queued} queued, {failed} failed"
          + (f", {len(skipped)} offline/stale skipped ({', '.join(skipped)})"
             if skipped and not only else ""))
    if not dry and queued:
        print("  outcome: hivv upgrades   ·   bees apply within ~1 min "
              "(sha256 + healthcheck still enforced)")
    return 0 if failed == 0 and queued else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
