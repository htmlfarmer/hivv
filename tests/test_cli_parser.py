#!/usr/bin/env python3
"""Regression tests for the CLI argument parser.

The failure this guards against: a duplicate top-level subparser makes
`build_parser()` throw, which makes EVERY command fail — including
`hivv update`, which is how the CLI would normally fix itself. A parser bug
therefore bricks the CLI with no self-repair path.

These tests:
  1. Assert no duplicate top-level subparsers exist.
  2. Assert `build_parser()` completes without raising.
  3. Assert every registered command name has a parser (and vice versa).
  4. Assert the self-heal path exists and is reachable.

Run:
    python3 tests/test_cli_parser.py
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "public_html" / "hivv-cli.py"

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
    spec = importlib.util.spec_from_file_location("hivv_cli_parser_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    print("\n== HIVV CLI parser regression tests ==")
    src = CLI.read_text(encoding="utf-8", errors="replace")

    # ── 1. no duplicate top-level subparsers ─────────────────────────
    print("\n== 1. no duplicate top-level subparsers ==")
    # Top-level: `sub.add_parser("name"` at indentation level 4.
    # Nested (e.g. `sp_llm.add_parser("status")`) is a different namespace.
    # \bsub\. matches both `    sub.add_parser(` and `    sp = sub.add_parser(`
    top_level = re.findall(r'\bsub\.add_parser\("([^"]+)"', src, re.M)
    dupes = {n for n in top_level if top_level.count(n) > 1}
    check("no duplicate top-level subparsers", not dupes,
          f"dupes: {sorted(dupes)}")
    check("top-level subparsers exist", len(top_level) > 40,
          f"found {len(top_level)}")

    # ── 2. build_parser() completes ───────────────────────────────────
    print("\n== 2. build_parser() completes without raising ==")
    try:
        mod = load_cli()
        parser = mod.build_parser()
        check("build_parser() returns a parser", parser is not None)
    except Exception as e:
        check("build_parser() returns a parser", False,
              f"{type(e).__name__}: {e}")
        mod = None

    if mod is not None:
        # ── 3. every registered command has a parser ────────────────────
        print("\n== 3. COMMANDS and parsers agree ==")
        commands = set(getattr(mod, "COMMANDS", {}).keys())
        # COMMANDS contains internal names (_agent) and aliases; the parser
        # only needs the ones users type.
        check("COMMANDS is not empty", len(commands) > 30,
              f"found {len(commands)}")

        # Every top-level subparser name should be dispatchable.
        unparsered = [n for n in top_level
                      if n not in commands and n not in ("llm",)]
        check("every subparser has a COMMANDS entry", not unparsered,
              f"unparsered: {unparsered[:10]}")

        # Aliases mapped BEFORE parse_args (like upgrade→update,
        # capability→cap) don't need their own parser — main() rewrites
        # argv first. Find them by the `if cmd_name == "x":` pattern.
        pre_mapped = set(re.findall(r'if cmd_name == "([^"]+)":\s*\n\s*cmd_name = "([^"]+)"', src))
        alias_targets = {a for a, _ in pre_mapped} | {t for _, t in pre_mapped}
        # Dotted names (llm install-llama) share their parent's parser.
        top_level_cmds = {n for n in commands
                          if " " not in n and "_" not in n
                          and n not in alias_targets}
        missing = [n for n in top_level_cmds if n not in top_level]
        check("top-level commands have parsers", not missing,
              f"missing: {missing[:10]}")

    # ── 4. the self-heal path exists ──────────────────────────────────
    print("\n== 4. self-heal path ==")
    check("main() wraps build_parser in try/except",
          "except (SystemExit, Exception) as parse_err" in src
          and "_self_heal_from_parse_error" in src)
    check("_self_heal_from_parse_error is defined",
          "def _self_heal_from_parse_error" in src)
    check("self-heal offers a curl repair command",
          "curl -fsSL" in src and "-o" in src)
    check("self-heal refuses to overwrite with an HTML page",
          "returned HTML" in src or "<!doctype" in src.lower())
    check("self-heal mentions the git clone fallback",
          "git clone https://github.com/htmlfarmer/hivv.git" in src)
    check("self-heal offers --yes for one-shot repair",
          "--yes" in src)

    # ── 5. the specific regression ────────────────────────────────────
    print("\n== 5. the regression that bricked yalla ==")
    check("`tools` is registered exactly once as a top-level subparser",
          top_level.count("tools") == 1,
          f"count={top_level.count('tools')}")
    check("the capability-discovery command is named `capabilities`",
          '"capabilities"' in src and "cmd_capabilities" in src)
    check("the local tools-server command keeps the name `tools`",
          'add_parser("tools"' in src)

    print(f"\n\033[1m{PASS} passed, {FAIL} failed\033[0m")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
