"""Location independence — the repo must work from ANY clone path.

WHY THIS FILE EXISTS
--------------------
The code was moving to a new GitHub repo (and, with it, to whatever
directory it gets cloned into). The API LIBRARY was already portable —
every path derives from `__dirname` — but the OUTER layer was pinned to
/var/www/vhosts/hivv.org:

    api/ecosystem.config.js    PM2 cwd + log paths
    api/server.js              the uncaught-exception log
    scripts/*.sh, *.py         the ops scripts
    public_html/hivv-cli.py    the control-token fallback

A hardcoded path is not a warning, it is a BREAK: the moment the repo is
cloned somewhere else, PM2 starts the wrong directory, the ops scripts
watch the wrong directory, and the CLI looks for a control token that is
not there.

THE RULE
--------
No shipped code may name the deployment path. The only allowed literal is
in the scanner's own PATTERN (it has to recognise the shape) and in
comments that are explicitly marked as examples.

This is a STATIC check: no network, no database, no HOME writes.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# The shape we refuse to see in shipped code.
VHOST_PATH = re.compile(r"/var/www/vhosts/[a-z0-9.\-]+")

# Where a literal path may legitimately appear:
#   * the scanner's own pattern table (it must recognise the shape)
#   * comments marked as examples (prose, not code)
#   * the one deliberate last-resort fallback in the blnq cross-check
ALLOWED = {
    "scripts/scan_secrets.py",
    "api/tests/interop.test.js",
}

# Files that are allowed to name a path because they are ABOUT paths.
SKIP_PREFIX = ("docs/", "ONE-EARTH-AUDIT/", "backups/", "logs/")

# Directories that ship as code.
CODE_DIRS = ("api", "scripts", "public_html")
CODE_SUFFIXES = (".js", ".cjs", ".mjs", ".py", ".sh", ".bash", ".ps1", ".json")


def _code_files() -> list[Path]:
    out: list[Path] = []
    for d in CODE_DIRS:
        root = REPO / d
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix not in CODE_SUFFIXES:
                continue
            rel = str(p.relative_to(REPO))
            if rel.startswith(SKIP_PREFIX) or "node_modules" in rel:
                continue
            out.append(p)
    return sorted(out)


def _comment_lines(src: str) -> set[int]:
    """Line numbers that are comments (so a prose example is not a bug)."""
    out: set[int] = set()
    for i, line in enumerate(src.splitlines(), 1):
        s = line.strip()
        if s.startswith("#") or s.startswith("//") or s.startswith("*") or s.startswith("--"):
            out.add(i)
        # A trailing comment on a code line still counts as prose for the
        # path shape, but the LINE may carry real code too — so only a
        # line that is ENTIRELY a comment is exempt.
    return out


class TestNoHardcodedDeploymentPaths:
    def test_no_shipped_code_names_the_deployment_path(self):
        offenders: list[str] = []
        for path in _code_files():
            rel = str(path.relative_to(REPO))
            if rel in ALLOWED:
                continue
            try:
                src = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            comments = _comment_lines(src)
            for i, line in enumerate(src.splitlines(), 1):
                if i in comments:
                    continue
                if VHOST_PATH.search(line):
                    offenders.append(f"{rel}:{i}")
        assert not offenders, (
            "shipped code must not name the deployment path — the repo moves:\n  "
            + "\n  ".join(offenders)
        )

    def test_the_pm2_config_derives_its_own_location(self):
        src = (REPO / "api" / "ecosystem.config.js").read_text(encoding="utf-8")
        assert "__dirname" in src, "the PM2 cwd must be derived, not written down"
        assert "ROOT_DIR" in src
        assert "HIVV_LOG_DIR" in src, "an operator must be able to move the logs"

    def test_the_gateway_error_log_is_derived(self):
        src = (REPO / "api" / "server.js").read_text(encoding="utf-8")
        assert VHOST_PATH.search(src) is None
        # the log lands next to the repo
        assert "'logs'" in src or '"logs"' in src

    def test_the_cli_finds_its_own_control_token(self):
        src = (REPO / "public_html" / "hivv-cli.py").read_text(encoding="utf-8")
        assert VHOST_PATH.search(src) is None
        assert ".control-token" in src

    def test_the_ops_scripts_find_their_own_repo(self):
        for rel in ("scripts/health-watchdog.sh", "scripts/secretz-hivv.sh",
                    "scripts/bridge-bench.sh"):
            src = (REPO / rel).read_text(encoding="utf-8")
            assert VHOST_PATH.search(src) is None, f"{rel} names the deployment path"
            assert "BASH_SOURCE" in src, f"{rel} must find its own location"

    def test_the_python_ops_scripts_find_their_own_repo(self):
        for rel in ("scripts/audit.py", "scripts/bridge-canary.py"):
            src = (REPO / rel).read_text(encoding="utf-8")
            assert VHOST_PATH.search(src) is None, f"{rel} names the deployment path"
            assert "__file__" in src, f"{rel} must find its own location"

    def test_the_blnq_cross_check_skips_instead_of_hardcoding(self):
        """The one deliberate exception — and it must SKIP, not fail."""
        src = (REPO / "api" / "tests" / "interop.test.js").read_text(encoding="utf-8")
        assert "HIVV_BLNQ_ROOT" in src, "the sibling repo must be overridable"
        assert "t.skip" in src, "a checkout without the sibling must SKIP, not fail"
        # the fallback candidate is allowed, but only as a LAST resort
        assert "candidates.push(" in src

    def test_there_is_no_stale_duplicate_pm2_config(self):
        """Two PM2 configs = two sources of truth; one was stale and held a
        hardcoded path AND a hardcoded database password."""
        assert not (REPO / "api" / "ecosystem.config.json").exists(), (
            "api/ecosystem.config.json is a stale duplicate of ecosystem.config.js "
            "— it cannot derive its own path (JSON has no __dirname) and it held a "
            "hardcoded db password. Delete it, do not fix it."
        )


class TestMigrationNumbering:
    def test_migrations_are_contiguous(self):
        files = sorted((REPO / "api" / "migrations").glob("*.sql"))
        nums = sorted(int(f.name.split("_", 1)[0]) for f in files)
        # a historical duplicate 015 exists — tolerated, it is not ours to fix
        present = set(nums)
        gaps = [n for n in range(min(present), max(present) + 1) if n not in present]
        assert not gaps, f"migration numbers have gaps: {gaps}"
