#!/usr/bin/env python3
"""The preview must not touch production.

The preview exists because the only place to SEE a change was production:
/var/www/vhosts/hivv.org is simultaneously the deploy target and a working
tree, and deploy.sh refuses a dirty or non-main one. So the only ways to see
a change were to edit production directly (forbidden) or to deploy it (which
is the thing you wanted to preview first).

A preview that needed a database would either use production is — and a
preview that can write to production data is not a preview — or need its own.
So it runs LOCAL-FIRST, with no database at all.

Run:
    python3 tests/test_fleet_preview.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  \033[32mPASS\033[0m  " + name)
    else:
        FAIL += 1
        print("  \033[31mFAIL\033[0m  " + name + "  " + detail)
    return bool(cond)


def load_cli():
    spec = importlib.util.spec_from_file_location("hivv_preview_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main():
    mod = load_cli()

    with tempfile.TemporaryDirectory(prefix="hivv-preview-") as td:
        os.environ["HIVV_CONFIG_DIR"] = td
        mod.CONFIG_DIR = Path(td)
        root = Path(td) / "preview"
        mod._preview_root = lambda: root

        check("no state file means no preview",
              mod._preview_running() is None)

        root.mkdir(parents=True, exist_ok=True)
        (root / "state.json").write_text(json.dumps({
            "branch": "main", "port": 0, "pid": 0,
            "tree": "/tmp/x", "data_dir": "/tmp/y",
            "started": "2026-01-01T00:00:00Z",
        }))
        check("a state file with a dead port is not running",
              mod._preview_running() is None)

        d = mod._preview_data("my-branch")
        check("the preview data dir is under preview-data",
              "preview-data" in str(d), str(d))
        prod = str(Path.home() / ".local" / "share" / "hivv")
        check("the preview data dir is not production is",
              str(d) != prod, str(d))
        check("the preview data dir is per-branch",
              "my-branch" in str(d), str(d))
        check("two branches get two data dirs",
              mod._preview_data("a") != mod._preview_data("b"), "")

        check("an odd branch name is made safe",
              "/" not in mod._safe_name("feat/weird/../name"),
              mod._safe_name("feat/weird/../name"))
        check("a long branch name is truncated",
              len(mod._safe_name("x" * 300)) <= 60, "")

    src = CLI.read_text(encoding="utf-8", errors="replace")
    check("the preview sets HIVV_DB_REQUIRED=0",
          'env["HIVV_DB_REQUIRED"] = "0"' in src)
    check("the preview sets its own data dir",
          'env["HIVV_DATA_DIR"] = str(data_dir)' in src)
    check("the preview sets its own port",
          'env["HIVV_PORT"] = str(port)' in src)
    check("the preview checks the branch out as a worktree",
          '"worktree", "add", "--detach"' in src)
    check("the preview removes its worktree on stop",
          '"worktree", "remove"' in src and '"worktree", "prune"' in src)

    print("")
    print("  %d passed, %d failed" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
