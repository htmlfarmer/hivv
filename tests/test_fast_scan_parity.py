#!/usr/bin/env python3
"""Cross-implementation parity for the deterministic fast scanner.

HIVV has TWO implementations of the same deterministic rules:

  * api/lib/fast-scan.js     — the gateway's (Node) implementation
  * public_html/hivv-cli.py   — the CLI's pure-stdlib standalone fallback

They MUST agree, because a partner may screen a file with either one and get
different answers. This test drives both and compares the parts that are
supposed to be identical: the verdict, the risk score/level, the hard
findings, and the secret findings.

Run:
    python3 tests/test_fast_scan_parity.py
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"
NODE_SCAN = ROOT / "api" / "lib" / "fast-scan.js"

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> bool:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32mPASS\033[0m  {name}")
    else:
        FAIL += 1
        print(f"  \033[31mFAIL\033[0m  {name}  {detail}")
    return bool(cond)


def load_cli():
    spec = importlib.util.spec_from_file_location("hivv_cli", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def node_scan(code: str) -> dict:
    """Run the Node implementation and return its JSON result."""
    script = (
        f"const s=require({json.dumps(str(NODE_SCAN))});"
        f"process.stdout.write(JSON.stringify(s.fastScan({json.dumps(code)},{{language:'python'}})));"
    )
    p = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[:400])
    return json.loads(p.stdout)


CASES = [
    ("clean", 'print("hello")\n'),
    ("print-many", "print(1)\nprint(2)\nprint(3)\n"),
    ("os-system", 'import os\nos.system("echo hi")\n'),
    ("subprocess", 'import subprocess\nsubprocess.run(["ls", "-l"])\n'),
    ("shell-true", 'import subprocess\nsubprocess.run("ls", shell=True)\n'),
    ("eval", "eval(user_input)\n"),
    ("file-write", 'open("out.txt", "w").write("x")\n'),
    ("file-read", 'open("data.csv").read()\n'),
    ("network", 'import requests\nrequests.get("https://example.com/a")\n'),
    ("credential-path", 'open("/etc/passwd").read()\n'),
    ("secret", 'KEY = "AKIAIOSFODNN7EXAMPLE"\n'),
    ("destructive", 'import shutil\nshutil.rmtree("/tmp/x")\n'),
    ("child-process", "const { exec } = require('child_process');\nexec('ls');\n"),
]


def main() -> int:
    print("\n== fast-scan parity: Node gateway vs pure-stdlib CLI ==")
    cli = load_cli()

    for label, code in CASES:
        try:
            node = node_scan(code)
        except Exception as e:
            check(f"{label}: node scan ran", False, str(e))
            continue
        py = cli._local_fast_scan(code, "python")
        if py is None:
            check(f"{label}: python scan ran", False, "returned None")
            continue

        check(f"{label}: verdict agrees", node["verdict"] == py["verdict"],
              f"node={node['verdict']} py={py['verdict']}")
        check(f"{label}: risk score agrees",
              node["risks"]["score"] == py["risks"]["score"],
              f"node={node['risks']['score']} py={py['risks']['score']}")
        check(f"{label}: risk level agrees",
              node["risks"]["level"] == py["risks"]["level"],
              f"node={node['risks']['level']} py={py['risks']['level']}")
        check(f"{label}: source hash agrees",
              node["source_sha256"] == py["source_sha256"])
        check(f"{label}: byte count agrees",
              node["size"]["bytes"] == py["size"]["bytes"])
        check(f"{label}: line count agrees",
              node["size"]["lines"] == py["size"]["lines"])

        node_hard = sorted(h["id"] for h in node["hard_findings"])
        py_hard = sorted(h["id"] for h in py["hard_findings"])
        check(f"{label}: hard findings agree", node_hard == py_hard,
              f"node={node_hard} py={py_hard}")

        node_secrets = sorted(s["id"] for s in node["secret_findings"])
        py_secrets = sorted(s["id"] for s in py["secret_findings"])
        check(f"{label}: secret findings agree", node_secrets == py_secrets,
              f"node={node_secrets} py={py_secrets}")

        # The CLI must NEVER print or return a secret value.
        check(f"{label}: no secret value leaked", "AKIAIOSFODNN7EXAMPLE" not in json.dumps(py)
              or label != "secret")

    print("\n== the CLI never approves anything ==")
    for label, code in CASES:
        py = cli._local_fast_scan(code, "python")
        if py and py["verdict"] == "safe":
            # 'safe' is only allowed when there is no hard finding and no secret.
            check(f"{label}: safe implies no hard findings",
                  not py["hard_findings"] and not py["secret_findings"])

    print(f"\n\033[1m{PASS} passed, {FAIL} failed\033[0m")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
