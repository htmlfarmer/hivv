#!/usr/bin/env python3
"""
bridge-canary.py — the standing health check for the kwaai <-> hivv.org bridge.

Designed for cron (hourly). READ-ONLY against remote hives: it checks the
manifest doors, confirms our registry still lists the peer, and records a
latency sample. No inference traffic by default (CHAT=1 opts in, budget-gated).

Writes:
  logs/bridge-canary.jsonl     append-only history (study this)
  public_html/bridge-status.json  tiny static file the website reads (cheap)

Exit: 0 healthy, 1 unhealthy (cron-friendly).
"""
import json, os, time, urllib.request, datetime, statistics

VHOST = "/var/www/vhosts/hivv.org"
HIST = os.path.join(VHOST, "logs", "bridge-canary.jsonl")
PUB = os.path.join(VHOST, "public_html", "bridge-status.json")
PEERS_LOCAL = "http://127.0.0.1:3011/api/bridge/peers"

# The doors, in protocol order (branded -> standard -> git-hosted fallback).
DOORS = [
    "https://raw.githubusercontent.com/Kwaai-AI-Lab/KwaaiNet/main/docs/bridge/hivv.json",
    "https://kwaai.ai/.bridge/hivv.json",
    "https://kwaai.ai/.well-known/hivv.json",
]

def now(): return datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"

def get(url, timeout=8):
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "hivv-bridge-canary/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read(65536)
    return body, round((time.time() - t0) * 1000)

def main():
    result = {"ts": now(), "kind": "canary", "checks": {}}

    # 1. manifest doors (first hit wins)
    manifest = None
    for url in DOORS:
        try:
            body, ms = get(url)
            m = json.loads(body)
            if str(m.get("protocol", "")).startswith("open-hive"):
                manifest, result["checks"]["manifest"] = m, {"ok": True, "door": url, "ms": ms}
                break
        except Exception as e:
            result["checks"]["manifest"] = {"ok": False, "door": url, "error": str(e)[:160]}
    result["checks"]["hive_name"] = manifest.get("hive") if manifest else None

    # 2. does OUR registry still list them (public view)?
    try:
        body, ms = get(PEERS_LOCAL, timeout=5)
        peers = json.loads(body).get("peers", [])
        listed = any(p.get("remote_hive") == "kwaai.ai" for p in peers)
        result["checks"]["listed"] = {"ok": listed, "ms": ms, "peers": len(peers)}
    except Exception as e:
        result["checks"]["listed"] = {"ok": False, "error": str(e)[:160]}

    healthy = bool(result["checks"].get("manifest", {}).get("ok")) and result["checks"].get("listed", {}).get("ok", False)
    result["healthy"] = healthy

    os.makedirs(os.path.dirname(HIST), exist_ok=True)
    with open(HIST, "a") as f:
        f.write(json.dumps(result) + "\n")

    # roll up the public status file from recent history (cheap: one read)
    try:
        rows = [json.loads(l) for l in open(HIST) if l.strip()]
        rows = [r for r in rows if r.get("kind") == "canary"][-500:]
        last24 = [r for r in rows if r.get("ts", "") >= (datetime.datetime.utcnow() - datetime.timedelta(hours=24)).isoformat(timespec="seconds")]
        up = round(100.0 * sum(1 for r in last24 if r.get("healthy")) / len(last24), 1) if last24 else None
        lat = [c.get("ms") for r in rows[-100:] for c in [r.get("checks", {}).get("manifest", {})] if isinstance(c, dict) and c.get("ms")]
        pub = {
            "bridge": "kwaai <-> hivv.org",
            "updated_at": now(),
            "healthy": healthy,
            "uptime_24h_percent": up,
            "manifest_ms_p50": int(statistics.median(lat)) if lat else None,
            "last": rows[-1] if rows else None,
            "history": "/bridge-canary.jsonl" if os.path.exists(os.path.join(VHOST, "public_html")) else None,
        }
        with open(PUB, "w") as f:
            json.dump(pub, f, indent=1)
    except Exception:
        pass

    print(json.dumps(result, indent=1))
    return 0 if healthy else 1

if __name__ == "__main__":
    raise SystemExit(main())
