#!/usr/bin/env python3
"""fleet-probe.py — print this box's fleet status as JSON.

Self-contained on purpose. The fleet has to work on a box whose hivv CLI
is an OLD version, or one the running agent keeps restoring — and the
first time a fleet was stood up, the CLI was overwritten by hand and the
agent's own update path put the old one back an hour later.

So the fleet does not ask the CLI. It asks THIS: one file, no imports
beyond the standard library, no dependency on what else is installed.

Written to ~/.local/share/hivv/fleet-probe.py by 'hivv fleet up'.
"""
import hashlib
import json
import os
import socket
import subprocess
import time
from pathlib import Path

HOME = Path.home()
STATE = HOME / ".local" / "share" / "hivv"


def run(cmd, timeout=20):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception:
        return 1, ""


def port_open(port):
    try:
        with socket.socket() as s:
            s.settimeout(1.5)
            return s.connect_ex(("127.0.0.1", int(port))) == 0
    except Exception:
        return False


def yaml_value(cfg, key):
    try:
        for line in Path(cfg).read_text(errors="replace").splitlines():
            if line.startswith(key + ":"):
                return line.split(":", 1)[1].strip().strip('"')
    except Exception:
        pass
    return ""


def nodes():
    out = []
    homes = []
    env_home = os.environ.get("KWAAINET_HOME")
    if env_home:
        homes.append(Path(env_home).expanduser())
    try:
        homes += sorted(HOME.glob(".kwaainet*"), reverse=True)
    except Exception:
        pass
    seen = set()
    for h in homes:
        key = str(h)
        if key in seen or not h.is_dir():
            continue
        seen.add(key)
        idf = h / "identity.key"
        if not idf.exists():
            continue
        try:
            ident = hashlib.sha256(idf.read_bytes()).hexdigest()[:12]
        except Exception:
            ident = ""
        port = yaml_value(h / "config.yaml", "port")
        peer = ""
        for name in ("node.log", "kwaainet.log"):
            try:
                # The WHOLE file: the peer id is logged ONCE at startup, so a
                # busy node's log has pushed it past any "last N lines".
                for line in reversed((h / "logs" / name).read_text(errors="replace").splitlines()):
                    if "Peer ID:" in line:
                        peer = line.split("Peer ID:")[-1].strip().split()[0]
                        break
            except Exception:
                continue
            if peer:
                break
        out.append({"home": str(h), "identity": ident, "port": port,
                    "peer_id": peer, "up": bool(port) and port_open(port)})
    return out


def agent_running():
    try:
        pid = int((STATE / "agent.pid").read_text().strip())
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def gateway():
    if not shutil_which("pm2"):
        return None
    rc, out = run(["pm2", "jlist"], timeout=30)
    try:
        apps = json.loads(out or "[]")
    except Exception:
        return None
    for p in apps:
        if "gateway" in (p.get("name") or ""):
            env = p.get("pm2_env") or {}
            up = env.get("pm_uptime")
            return {"name": p.get("name"), "cwd": env.get("pm_cwd"),
                    "uptime_s": int(time.time() - up / 1000) if up else 0}
    return None


def shutil_which(cmd):
    """Find a command, PATH first and then the usual hiding places.

    pm2 is the reason this exists. It lives in the user's npm global
    directory, which is on an interactive shell's PATH and NOT on a
    non-interactive ssh's. So over ssh the probe found no pm2, no gateway,
    no production tree — and a deploy check that quietly believed a dirty
    tree was clean.
    """
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if d and os.access(os.path.join(d, cmd), os.X_OK):
            return os.path.join(d, cmd)
    home = Path.home()
    for extra in ("bin/pm2", "npm-global/bin/pm2", ".npm-global/bin/pm2",
                  ".local/bin/pm2", ".nvm/current/bin/pm2"):
        cand = home / extra
        if cand.exists() and os.access(cand, os.X_OK):
            return str(cand)
    try:
        for v in sorted((home / ".nvm" / "versions" / "node").glob("*/bin/pm2")):
            if os.access(v, os.X_OK):
                return str(v)
    except Exception:
        pass
    for extra in ("/usr/local/bin/pm2", "/usr/bin/pm2", "/opt/homebrew/bin/pm2"):
        if os.access(extra, os.X_OK):
            return extra
    return None


def git_state():
    cands = []
    gw = gateway()
    if gw and gw.get("cwd"):
        cands.append(Path(gw["cwd"]).parent)
    cands += [HOME / "work" / "hivv", HOME / "hivv"]
    for c in cands:
        if not (c / ".git").exists():
            continue
        rc, branch = run(["git", "-C", str(c), "branch", "--show-current"])
        rc, dirty = run(["git", "-C", str(c), "status", "--porcelain"], timeout=30)
        rc, head = run(["git", "-C", str(c), "log", "-1", "--format=%h %cr"])
        return {"path": str(c), "branch": branch.strip(),
                "dirty": len([x for x in dirty.splitlines() if x.strip()]),
                "head": head.strip()}
    return None


def deployed():
    gw = gateway()
    if not gw or not gw.get("cwd"):
        return ""
    rc, out = run(["git", "-C", gw["cwd"], "log", "-1", "--format=%h"])
    return out.strip()


print(json.dumps({
    "host": socket.gethostname(),
    "reachable": True,
    "agent_running": agent_running(),
    "nodes": nodes(),
    "gateway": gateway(),
    "git": git_state(),
    "deployed": deployed(),
}, indent=2, default=str))
