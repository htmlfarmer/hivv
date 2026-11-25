"""Repo workflow scripts: deploy.sh · sync-mirrors.sh · MOVES.md.

These pin the SAFETY RAILS of the single-repo workflow (MOVES.md,
2026-11-25 — hivvz folded back into hivv):

 * deploy refuses a foreign origin, a STALE hivvz origin, a non-main branch
   and a dirty tree — all BEFORE any fetch/pm2 touch;
 * sync-mirrors refuses a foreign origin, and regenerates the WEBSITE
   projection (hivv.org) from LOCAL bare repos standing in for GitHub
   (fully offline);
 * the scripts exist, are executable, strict-bash, and carry their flags;
 * MOVES.md / AGENTS.md / CONTRIBUTING.md document the topology.

The scripts `cd` to their OWN parent — so every fixture runs a COPY installed
inside the fixture repo. Nothing here contacts github.com or the real gateway.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "scripts"
DEPLOY = SCRIPTS / "deploy.sh"
SYNC = SCRIPTS / "sync-mirrors.sh"


def run(args, cwd, *, env=None, check=True):
    """Run a command with a hermetic env (no DB password inherited)."""
    full_env = dict(os.environ)
    full_env.pop("HIVV_DB_PASSWORD", None)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        [str(a) for a in args], cwd=str(cwd), env=full_env,
        capture_output=True, text=True, timeout=120,
    )
    if check and proc.returncode != 0:
        raise AssertionError(
            f"command failed ({proc.returncode}): {' '.join(map(str, args))}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return proc


def git(cwd, *args, check=True):
    return run(["git", *args], cwd, check=check)


def init_repo(path: Path, branch: str = "main") -> Path:
    """Fresh repo, identity set locally, global hooks bypassed (hermetic)."""
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-b", branch)
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "user.name", "Repo Scripts Test")
    git(path, "config", "core.hooksPath", "/dev/null")
    return path


def clone_repo(src: Path, dst: Path) -> Path:
    run(["git", "clone", str(src), str(dst)], dst.parent)
    git(dst, "config", "user.email", "test@example.invalid")
    git(dst, "config", "user.name", "Repo Scripts Test")
    git(dst, "config", "core.hooksPath", "/dev/null")
    return dst


def install_script(repo: Path, script: Path) -> Path:
    """The scripts cd to their own parent — run a COPY inside the fixture."""
    (repo / "scripts").mkdir(exist_ok=True)
    dest = repo / "scripts" / script.name
    shutil.copy(script, dest)
    dest.chmod(0o755)
    return dest


def commit_file(repo: Path, rel: str, content: str, msg: str = "add") -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", msg)


# ── static pins ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("script", [DEPLOY, SYNC])
def test_script_exists_executable_strict_bash(script):
    assert script.is_file(), f"{script} missing"
    assert os.access(script, os.X_OK), f"{script} not executable"
    text = script.read_text(encoding="utf-8")
    assert text.startswith("#!/usr/bin/env bash"), "wrong shebang"
    assert "set -euo pipefail" in text, "must fail fast"
    assert "--help" in text, "must document itself"


def test_deploy_flags_and_rails_present():
    text = DEPLOY.read_text(encoding="utf-8")
    assert "--dry-run" in text and "--fast" in text
    assert "merge --ff-only" in text, "deploy must never diverge"
    assert "htmlfarmer/hivv.git" in text, "origin rail pins the canonical repo"
    assert "git status --porcelain" in text, "dirty-tree rail"
    assert "api/health" in text, "health poll"
    assert "rollback" in text, "automatic rollback"


def test_sync_flags_and_safety_present():
    text = SYNC.read_text(encoding="utf-8")
    assert "--dry-run" in text
    assert "htmlfarmer/hivv.git" in text, "origin rail pins the canonical repo"
    assert "--force-with-lease" in text, "projection must lease, not blind-force"
    assert "GIT_INDEX_FILE" in text, "must not disturb the shared index"
    assert "subtree split" in text, "website projection source"
    assert "htmlfarmer/hivv.org.git" in text, "projection remote"
    # no blind --force anywhere outside a lease
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        assert "--force-with-lease" in stripped or "--force " not in stripped, (
            f"blind --force found: {line}"
        )


def test_moves_md_documents_topology():
    text = (REPO / "MOVES.md").read_text(encoding="utf-8")
    # the canonical repo + the fold-up entry
    assert "htmlfarmer/hivv.git" in text
    assert "ARCHIVED" in text, "the hivvz fold-up must be recorded"
    assert "sync-mirrors" in text and "deploy.sh" in text
    assert "2026-11-25" in text, "the topology entries must be dated"
    assert "nohup.out" in text, "pending cleanups belong here"


def test_agents_and_contributing_document_the_workflow():
    agents = (REPO / "AGENTS.md").read_text(encoding="utf-8")
    assert "Repository topology" in agents
    assert "htmlfarmer/hivv.git" in agents, "canonical clone URL"
    assert "ARCHIVED" in agents, "the hivvz archive must be documented"
    contrib = (REPO / "CONTRIBUTING.md").read_text(encoding="utf-8")
    assert "Repository topology" in contrib
    assert "htmlfarmer/hivv.git" in contrib
    assert "scripts/deploy.sh" in contrib


def test_gitignore_covers_db_password():
    text = (REPO / ".gitignore").read_text(encoding="utf-8")
    assert ".db-password" in text, (
        "setup.sh writes the DB password to the repo root — must be ignored"
    )


def test_secret_guard_suppresses_blnq_test_vector():
    text = (REPO / ".secret-guard-suppress").read_text(encoding="utf-8")
    assert "api/tests/interop\\.test\\.js" in text, (
        "the blnq HMAC test vector must stay path-suppressed or pushes break"
    )


# ── deploy rails (offline: rails fire before any fetch) ─────────────────────

def test_deploy_refuses_foreign_origin(tmp_path):
    repo = init_repo(tmp_path / "work")
    commit_file(repo, "x.txt", "hi")
    git(repo, "remote", "add", "origin", "https://github.com/evil/evil.git")
    script = install_script(repo, DEPLOY)
    proc = run([script], repo, check=False)
    assert proc.returncode != 0
    assert "REFUSED" in proc.stderr and "htmlfarmer/hivv.git" in proc.stderr


def test_deploy_refuses_stale_hivvz_origin(tmp_path):
    # a machine that never ran the MOVES.md set-url one-liner must be told
    # exactly what to run — pushing to the ARCHIVED repo would fail anyway
    repo = init_repo(tmp_path / "work")
    commit_file(repo, "x.txt", "hi")
    git(repo, "remote", "add", "origin", "git@github.com:htmlfarmer/hivvz.git")
    script = install_script(repo, DEPLOY)
    proc = run([script], repo, check=False)
    assert proc.returncode != 0
    assert "REFUSED" in proc.stderr
    assert "git remote set-url origin git@github.com:htmlfarmer/hivv.git" in proc.stderr


def test_deploy_refuses_wrong_branch(tmp_path):
    repo = init_repo(tmp_path / "work")
    commit_file(repo, "x.txt", "hi")
    git(repo, "remote", "add", "origin", "git@github.com:htmlfarmer/hivv.git")
    git(repo, "checkout", "-b", "feat/x")
    script = install_script(repo, DEPLOY)
    proc = run([script], repo, check=False)
    assert proc.returncode != 0
    assert "REFUSED" in proc.stderr and "main" in proc.stderr


def test_deploy_refuses_dirty_tree(tmp_path):
    # origin URL passes rail 1 but is never contacted: the dirty rail fires
    # before the fetch.
    repo = init_repo(tmp_path / "work")
    commit_file(repo, "x.txt", "hi")
    git(repo, "remote", "add", "origin", "git@github.com:htmlfarmer/hivv.git")
    (repo / "uncommitted.txt").write_text("work in progress", encoding="utf-8")
    script = install_script(repo, DEPLOY)
    proc = run([script], repo, check=False)
    assert proc.returncode != 0
    assert "REFUSED" in proc.stderr
    assert "uncommitted" in proc.stderr
    # nothing was fetched or merged
    assert "fetching" not in proc.stdout


def test_deploy_help_lists_flags():
    # --help exits during argument parsing, before any git/network work
    proc = run([DEPLOY, "--help"], REPO)
    assert "--dry-run" in proc.stdout and "--fast" in proc.stdout


# ── sync-mirrors end-to-end (LOCAL bare repos stand in for GitHub) ──────────

@pytest.fixture()
def mirror_sandbox(tmp_path):
    """origin + hivv.org as local bare repos; a work clone on main.

    The origin path deliberately contains 'htmlfarmer/hivv.git' so the
    script's origin rail passes — while everything stays on the local
    filesystem. hivv.org starts with GitHub's real placeholder
    ('Initial commit'), so the first sync exercises the same
    force-with-lease path it takes in production.
    """
    origin_dir = tmp_path / "htmlfarmer"
    origin_dir.mkdir()

    # canonical repo with a website + gateway + license
    seed = init_repo(tmp_path / "seed")
    run(["git", "init", "--bare", "-b", "main", str(origin_dir / "hivv.git")], tmp_path)
    git(seed, "remote", "add", "origin", str(origin_dir / "hivv.git"))
    commit_file(seed, "public_html/index.html", "<html><body>site</body></html>", "site")
    commit_file(seed, "public_html/css/site.css", "body{color:#000}", "css")
    commit_file(seed, "api/server.js", "console.log('gateway')", "api")
    commit_file(seed, "LICENSE", "GPL-3.0", "license")
    commit_file(seed, "README.md", "# hivvz", "readme")
    git(seed, "push", "origin", "main")

    # work clone = what sync-mirrors runs in
    work = clone_repo(origin_dir / "hivv.git", tmp_path / "work")

    # website-projection target WITH GitHub's placeholder commit
    run(["git", "init", "--bare", "-b", "main", str(tmp_path / "hivv.org.git")], tmp_path)
    site_seed = init_repo(tmp_path / "site-seed")
    git(site_seed, "remote", "add", "origin", str(tmp_path / "hivv.org.git"))
    commit_file(site_seed, "LICENSE", "GPL-3.0", "Initial commit")
    commit_file(site_seed, "README.md", "hivv.org main website", "Initial commit")
    git(site_seed, "push", "origin", "main")
    git(work, "remote", "add", "hivv-org", str(tmp_path / "hivv.org.git"))

    script = install_script(work, SYNC)
    return {"work": work, "script": script, "seed": seed, "origin": origin_dir,
            "hivv_org": tmp_path / "hivv.org.git"}


def test_sync_refuses_foreign_origin(tmp_path):
    repo = init_repo(tmp_path / "work")
    commit_file(repo, "x.txt", "hi")
    git(repo, "remote", "add", "origin", "https://github.com/evil/evil.git")
    script = install_script(repo, SYNC)
    proc = run([script], repo, check=False)
    assert proc.returncode != 0
    assert "REFUSED" in proc.stderr and "htmlfarmer/hivv.git" in proc.stderr


def test_sync_generates_website_projection(mirror_sandbox):
    work = mirror_sandbox["work"]
    proc = run([mirror_sandbox["script"]], work)
    assert "sync-mirrors: done." in proc.stdout

    # website projection: public_html at the ROOT + generated README + LICENSE,
    # and NO api/ (that is not the website)
    site_files = git(mirror_sandbox["hivv_org"], "ls-tree", "-r", "--name-only", "main").stdout
    assert "index.html" in site_files, "public_html must be at the repo root"
    assert "css/site.css" in site_files
    assert "README.md" in site_files and "LICENSE" in site_files
    assert "api/server.js" not in site_files, "projection must not carry the gateway"
    assert "public_html/" not in site_files, "prefix must be stripped"
    readme = git(mirror_sandbox["hivv_org"], "show", "main:README.md").stdout
    assert "GENERATED MIRROR" in readme and "htmlfarmer/hivv" in readme
    # GitHub's placeholder is gone from main (documented in MOVES.md)
    subjects = git(mirror_sandbox["hivv_org"], "log", "--format=%s", "main").stdout
    assert "Initial commit" not in subjects.splitlines()[:1]


def test_sync_is_idempotent(mirror_sandbox):
    work = mirror_sandbox["work"]
    run([mirror_sandbox["script"]], work)
    site1 = git(mirror_sandbox["hivv_org"], "rev-parse", "main").stdout.strip()

    proc = run([mirror_sandbox["script"]], work)
    assert "already in sync" in proc.stdout, "second run must be a no-op"
    site2 = git(mirror_sandbox["hivv_org"], "rev-parse", "main").stdout.strip()
    assert site1 == site2, "projection must not churn empty commits"


def test_sync_reflects_new_website_commits(mirror_sandbox):
    work = mirror_sandbox["work"]
    origin = mirror_sandbox["seed"]
    run([mirror_sandbox["script"]], work)

    commit_file(origin, "public_html/index.html", "<html>v2</html>", "site v2")
    git(origin, "push", "origin", "main")
    git(work, "fetch", "origin")

    run([mirror_sandbox["script"]], work)
    content = git(mirror_sandbox["hivv_org"], "show", "main:index.html").stdout
    assert "v2" in content, "projection must pick up new commits"
