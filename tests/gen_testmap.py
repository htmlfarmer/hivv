#!/usr/bin/env python3
"""gen_testmap.py — build the source → tests map.

THE QUESTION THIS ANSWERS
    "I edited <file>. Which tests do I have to run?"
Today the answer is "all of them" (~100s) or tribal knowledge. This
generator makes it a LOOKUP: every source file → the test files that
exercise it, committed as tests/TESTMAP.json (machine) + TESTMAP.md
(human), consumed by `hivv tests-for <file>`.

HOW IT WORKS — static analysis, no execution
Running every test under coverage would give ground truth but costs
minutes per regeneration and needs the whole environment. Instead this
parses the TEST FILES themselves for the ways they reference sources:

  Python tests
    * Path-assignment chains:  CLI_PATH = REPO / "public_html" / "hivv-cli.py"
    * Plain literals that name a repo file: "scripts/scan_secrets.py"
    * importlib spec_from_file_location(..., <that constant>)
  JS tests
    * require('../lib/fast-scan') → resolved relative to the test file

Two honest limits, both stated in the output:
  * a test that reaches a file only through a runtime-computed path is
    invisible to this (the map UNDER-claims, never over-claims — safe
    direction: the fallback advice is "run the full suite")
  * a test that only READS a file as text (source-assertion canaries) is
    covered, because those references are literals too

Determinism: sorted keys, no timestamps — the freshness test compares a
regenerated map against the committed one byte for byte.

Run:  python3 tests/gen_testmap.py
      hivv tests-for --refresh <file>
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT_JSON = REPO / "tests" / "TESTMAP.json"
OUT_MD = REPO / "tests" / "TESTMAP.md"

# Top-level entries that can be source files we care about.
_TOP = ("public_html", "api", "scripts", "docs", "sdk", "packaging")
# A literal that looks like a repo-relative source file.
_PATH_RE = re.compile(
    r"(?<![\w/-])((?:%s)/[\w][\w./-]*\.(?:py|js|mjs|cjs|sh|ps1|md|html|css|json|ya?ml))" % "|".join(_TOP)
)
# Exact root-level files worth mapping.
_ROOT_RE = re.compile(r"(?<![\w/-])(setup\.sh|restart\.sh|status\.sh|AGENTS\.md|README\.md)(?![\w.])")
# Never map these — they are tests, caches or vendored.
_SKIP_PREFIX = ("tests/", "api/tests/", "node_modules/", ".git/",
                "__pycache__/", ".pytest_cache/", "ONE-EARTH-AUDIT/")
_SKIP_SUFFIX = (".pyc", ".min.js")


def _norm(rel: str) -> str | None:
    """Normalise a candidate repo-relative path, or None if unmappable."""
    rel = rel.lstrip("./")
    if not rel or rel.startswith(_SKIP_PREFIX) or rel.endswith(_SKIP_SUFFIX):
        return None
    if any(part in ("__pycache__", ".git", "node_modules") for part in rel.split("/")):
        return None
    return rel


def _chain_to_path(node: ast.AST, consts: dict[str, str]) -> str | None:
    """Resolve `REPO / "a" / "b.py"` style BinOp chains to a repo path."""
    parts: list[str] = []
    cur = node
    while isinstance(cur, ast.BinOp) and isinstance(cur.op, ast.Div):
        if isinstance(cur.right, ast.Constant) and isinstance(cur.right.value, str):
            parts.append(cur.right.value)
        else:
            return None
        cur = cur.left
    if isinstance(cur, ast.Name) and cur.id in consts:
        # a chain rooted at a KNOWN repo root constant (REPO / CLI_PATH …)
        root = consts[cur.id]
        if root is None:
            return None
        parts.append(root)
        parts.reverse()
        return "/".join(p for p in parts if p)
    return None


def _py_test_sources(path: Path) -> set[str]:
    """Every source file a Python test file references."""
    out: set[str] = set()
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return out

    # module-level constants that hold a repo-relative path or a root
    consts: dict[str, str | None] = {}

    def note(name: str, value: str | None) -> None:
        consts[name] = value

    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for tgt in node.targets:
            if not isinstance(tgt, ast.Name):
                continue
            v = node.value
            # A repo-ROOT constant: `REPO = Path(__file__).resolve().parents[1]`
            # or `ROOT = Path(__file__).resolve().parent.parent`.
            #
            # Both were missed for a while: `.parents[1]` parses as a
            # SUBSCRIPT (not a Call), and `.parent.parent` is neither — so
            # every `REPO / ...` chain failed to resolve and the map
            # under-claimed the CLI by ~9 test files. Any node whose
            # unparsed form ENDS in a root-walk counts, but only for
            # CONSTANT-STYLE names (REPO/ROOT/…): `tmp_path / "a"` style
            # walks of a scratch tree must not become fake repo roots.
            src = ast.unparse(v)
            if (tgt.id.isupper() or re.match(r"^(REPO|ROOT|HERE|BASE)", tgt.id)) and \
                    re.search(r"(parents\[[12]\]|\.parent\.parent)\s*$", src):
                note(tgt.id, "")
                continue
            # CLI_PATH = REPO / "public_html" / "hivv-cli.py"
            resolved = _chain_to_path(v, consts)
            if resolved is not None:
                note(tgt.id, resolved)
                continue
            # PLAIN = "scripts/scan_secrets.py"
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                m = _PATH_RE.search(v.value) or _ROOT_RE.search(v.value)
                if m:
                    note(tgt.id, m.group(1))
                elif v.value in ("", None):
                    note(tgt.id, "")

    # 1. every Path-chain / constant assignment that resolves to a file
    for value in consts.values():
        if value:
            n = _norm(value)
            if n:
                out.add(n)

    # 2. every string literal that names a repo file (covers prose mentions
    #    like "pinned by tests/…", docstrings, assertion messages)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            for m in _PATH_RE.finditer(node.value):
                n = _norm(m.group(1))
                if n:
                    out.add(n)
            for m in _ROOT_RE.finditer(node.value):
                n = _norm(m.group(1))
                if n:
                    out.add(n)

    return out


def _js_test_sources(path: Path) -> set[str]:
    """Every source file a node:test file requires (relative requires only)."""
    out: set[str] = set()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for m in re.finditer(r"""require\(\s*['"](\.[^'"]+)['"]\s*\)""", text):
        rel = m.group(1)
        # resolve relative to the test file
        base = (path.parent / rel).resolve()
        for cand in (base, base.with_suffix(".js"), base.with_suffix(".mjs"),
                     base / "index.js"):
            try:
                cand.relative_to(REPO)
            except ValueError:
                continue
            if cand.is_file():
                n = _norm(str(cand.relative_to(REPO)))
                if n:
                    out.add(n)
                break
    return out


def build() -> dict:
    sources: dict[str, set[str]] = {}
    tests: dict[str, set[str]] = {}

    for tf in sorted((REPO / "tests").glob("test_*.py")):
        rel = str(tf.relative_to(REPO))
        refs = _py_test_sources(tf)
        tests[rel] = refs
        for r in refs:
            sources.setdefault(r, set()).add(rel)

    api_tests = REPO / "api" / "tests"
    if api_tests.is_dir():
        for tf in sorted(api_tests.glob("*.test.js")):
            rel = str(tf.relative_to(REPO))
            refs = _js_test_sources(tf)
            tests[rel] = refs
            for r in refs:
                sources.setdefault(r, set()).add(rel)

    return {
        "sources": {k: sorted(v) for k, v in sorted(sources.items())},
        "tests": {k: sorted(v) for k, v in sorted(tests.items())},
    }


def untested_code_files(mapping: dict) -> list[str]:
    """Code files NO test references — the honest 'what's uncovered' list."""
    out = []
    for pat in ("*.py", "*.js", "*.sh", "*.ps1"):
        for f in sorted(REPO.rglob(pat)):
            try:
                rel = str(f.relative_to(REPO))
            except ValueError:
                continue
            n = _norm(rel)
            if n is None or n.startswith("tests/"):
                continue
            if n not in mapping["sources"]:
                out.append(n)
    return out


def render_md(mapping: dict) -> str:
    L: list[str] = []
    L.append("# TESTMAP — which tests to run when you edit a file")
    L.append("")
    L.append("Generated by `python3 tests/gen_testmap.py` (static analysis — no test is run).")
    L.append("Consumed by `hivv tests-for <file>` / `hivv tests-for --diff`.")
    L.append("Freshness is enforced by `tests/test_testmap.py`: regenerate when it fails.")
    L.append("")
    L.append("Full suite, always: `hivv verify` (or `python3 -m pytest tests/ -q` + `cd api && node --test`).")
    L.append("")
    L.append("## source → tests")
    L.append("")
    L.append("| source | covers |")
    L.append("|---|---|")
    for src, tsts in mapping["sources"].items():
        L.append(f"| `{src}` | {', '.join('`%s`' % t for t in tsts)} |")
    L.append("")
    L.append("## tests → sources")
    L.append("")
    L.append("| test file | exercises |")
    L.append("|---|---|")
    for tst, srcs in mapping["tests"].items():
        if srcs:
            L.append(f"| `{tst}` | {', '.join('`%s`' % s for s in srcs)} |")
        else:
            L.append(f"| `{tst}` | *(no static source reference — part of the full suite)* |")
    L.append("")
    L.append("## code files no test references")
    L.append("")
    L.append("Editing one of these has no dedicated test — the full suite is your gate.")
    L.append("")
    for f in untested_code_files(mapping):
        L.append(f"- `{f}`")
    L.append("")
    return "\n".join(L)


def main() -> int:
    mapping = build()
    OUT_JSON.write_text(json.dumps(mapping, indent=1, sort_keys=True) + "\n",
                        encoding="utf-8")
    OUT_MD.write_text(render_md(mapping), encoding="utf-8")
    print(f"wrote {OUT_JSON.relative_to(REPO)} "
          f"({len(mapping['sources'])} sources, {len(mapping['tests'])} test files)")
    print(f"wrote {OUT_MD.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
