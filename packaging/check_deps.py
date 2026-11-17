#!/usr/bin/env python3
"""packaging/check_deps.py — the binary contract:
hivv-cli.py must import ONLY the Python standard library, so PyInstaller
can freeze it into a single self-contained binary. CI runs this first.

Usage: python3 packaging/check_deps.py [path/to/hivv-cli.py]
"""
import ast
import sys

CLI = sys.argv[1] if len(sys.argv) > 1 else "public_html/hivv-cli.py"

if not hasattr(sys, "stdlib_module_names"):
    print("FAIL: needs Python 3.10+ for stdlib_module_names")
    sys.exit(1)
stdlib = set(sys.stdlib_module_names)

# modules that are stdlib but sometimes missing from stdlib_module_names
EXTRA_OK = {"__future__", "encodings", "importlib", "pkgutil", "ctypes", "wx", "wincrypt"}

tree = ast.parse(open(CLI, encoding="utf-8").read(), CLI)
mods = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for a in node.names:
            mods.add(a.name.split(".")[0])
    elif isinstance(node, ast.ImportFrom):
        if node.module and node.level == 0:
            mods.add(node.module.split(".")[0])

bad = sorted(m for m in mods if m not in stdlib and m not in EXTRA_OK and not m.startswith("_"))
if bad:
    print(f"FAIL: non-stdlib imports in {CLI}: {', '.join(bad)}")
    print("      binaries must stay stdlib-only — or update the CI build with the deps.")
    sys.exit(1)
print(f"OK: {CLI} imports only stdlib ({len(mods)} distinct roots)")
