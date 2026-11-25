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
import subprocess
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


def _read_pushed_content(path: Path) -> str:
    """A test file's PUSHED bytes: the git INDEX version when tracked.

    A map generated from a DIRTY working tree embeds edits that are not
    in the commit — CI then regenerates from the checkout and calls the
    committed map stale (b3b735a: the map carried a colleague's
    unstaged test edits). The index is exactly what git commit would
    contain, so index content == pushed content == what CI regenerates
    from. Untracked files fall back to disk (they are excluded from the
    map anyway by _tracked)."""
    rel = str(path.relative_to(REPO))
    try:
        r = subprocess.run(["git", "show", ":" + rel], cwd=str(REPO),
                           capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and r.stdout:
            return r.stdout
    except Exception:
        pass
    return path.read_text(encoding="utf-8", errors="replace")


def _py_test_sources(path: Path) -> set[str]:
    """Every source file a Python test file references."""
    out: set[str] = set()
    try:
        tree = ast.parse(_read_pushed_content(path))
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
        text = _read_pushed_content(path)
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


def _tracked(paths: list[Path]) -> list[Path]:
    """Only GIT-TRACKED test files enter the map.

    The map must describe the tree that GETS PUSHED, not whatever happens
    to sit on this disk: a colleague's untracked work-in-progress test
    would be mapped, absent from the pushed checkout, and CI's freshness
    check would fail on a file nobody shipped. When they commit it, it
    becomes tracked, the map goes stale, and the freshness test nudges a
    regeneration — the workflow working as intended.
    """
    try:
        r = subprocess.run(["git", "ls-files", "--", "tests", "api/tests"],
                           cwd=str(REPO), capture_output=True, text=True,
                           timeout=15)
        if r.returncode != 0:
            return paths
        tracked = {ln.strip() for ln in r.stdout.splitlines() if ln.strip()}
        return [f for f in paths if str(f.relative_to(REPO)) in tracked]
    except Exception:
        return paths


def build() -> dict:
    sources: dict[str, set[str]] = {}
    tests: dict[str, set[str]] = {}

    py_tests = _tracked(sorted((REPO / "tests").glob("test_*.py")))
    for tf in py_tests:
        rel = str(tf.relative_to(REPO))
        refs = _py_test_sources(tf)
        tests[rel] = refs
        for r in refs:
            sources.setdefault(r, set()).add(rel)

    api_tests = REPO / "api" / "tests"
    if api_tests.is_dir():
        for tf in _tracked(sorted(api_tests.glob("*.test.js"))):
            rel = str(tf.relative_to(REPO))
            refs = _js_test_sources(tf)
            tests[rel] = refs
            for r in refs:
                sources.setdefault(r, set()).add(rel)

    # Only map sources that EXIST: an example path inside an assertion
    # ("api/x.js" in a scanner test) is prose, not a reference — mapping it
    # made the integrity check fail on a file nobody ever shipped.
    def _exists(rel: str) -> bool:
        return (REPO / rel).exists()

    return {
        "sources": {k: sorted(v) for k, v in sorted(sources.items()) if _exists(k)},
        "tests": {k: sorted(v) for k, v in sorted(tests.items()) if _exists(k)},
    }


def _tracked_files() -> list[str]:
    """The files a COMMIT would contain — the git INDEX.

    The map is a function of the COMMIT, not of whatever happens to be lying
    around in the working tree. The JSON half already read the index (see
    _read_pushed_content); this list now does too, so the two halves of the
    map cannot disagree.
    """
    try:
        r = subprocess.run(["git", "ls-files"], cwd=str(REPO),
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and r.stdout.strip():
            return sorted(x for x in r.stdout.splitlines() if x.strip())
    except Exception:
        pass
    # Not a git checkout (an archive, a tarball): fall back to the disk.
    out = []
    for pat in ("*.py", "*.js", "*.sh", "*.ps1"):
        for f in REPO.rglob(pat):
            try:
                out.append(str(f.relative_to(REPO)))
            except ValueError:
                continue
    return sorted(out)


def untested_code_files(mapping: dict) -> list[str]:
    """Code files NO test references — the honest 'what's uncovered' list."""
    out = []
    for rel in _tracked_files():
        if not rel.endswith((".py", ".js", ".sh", ".ps1")):
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
