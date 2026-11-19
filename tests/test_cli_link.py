"""Tests for `hivv link` / `hivv unlink` — WHICH copy runs, chosen explicitly.

THE PROBLEM (it bites in both orders)
  curl-install → later `git clone`: `hivv` keeps running the INSTALLED copy;
    the clone sits inert and ROTS — edits do nothing, silently.
  `git clone` → later curl-install: the installer overwrites the active copy
    with the hub version; the clone's work vanishes from the path that
    matters.
Two copies of the truth, and nothing says which one is live.

THE RULE pinned here: one active copy, chosen explicitly, always visible.
A clone SHOULD be primary for someone who cloned (a clone is an intent to
modify) — but by saying so (`hivv link`), never by accident.

Also pinned: the installers must NEVER write through a link. `cp src dst`
with dst a symlink FOLLOWS it — so an install would overwrite the clone
the user linked. That is a data-loss bug, and it is exactly the class of
bug `hivv update` was already fixed for (2026-11-18: never touch source).
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
PUBLIC_DIR = REPO / "public_html"
DEPS_SH = REPO / "scripts" / "lib" / "deps.sh"

spec = importlib.util.spec_from_file_location("hivv_cli", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli"] = hivv
spec.loader.exec_module(hivv)


def make_prefix(tmp_path, with_link_to: Path | None = None):
    """A fake install: <tmp>/prefix/{bin/hivv, lib/hivv/hivv-cli.py}.

    Optionally pre-linked to a target. Returns the prefix.
    """
    prefix = tmp_path / "prefix"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "lib" / "hivv").mkdir(parents=True)
    shutil.copy2(PUBLIC_DIR / "hivv", prefix / "bin" / "hivv")
    (prefix / "bin" / "hivv").chmod(0o755)
    client = prefix / "lib" / "hivv" / "hivv-cli.py"
    if with_link_to is not None:
        client.symlink_to(with_link_to)
    else:
        shutil.copy2(CLI_PATH, client)
        client.chmod(0o755)
    return prefix


def run(prefix, *args, state_dir=None, cwd=None):
    """Run the CLI through the FAKE wrapper with PATH pointing at it —
    so _installed_client_path() resolves to the fake prefix, not the
    real install on this machine."""
    env = dict(os.environ)
    env["PATH"] = f"{prefix / 'bin'}{os.pathsep}{env.get('PATH', '')}"
    env["HIVV_STATE_DIR"] = str(state_dir or (prefix / "state"))
    # the wrapper execs python3 on its client — the fake prefix's copy
    return subprocess.run([str(prefix / "bin" / "hivv"), *args],
                          capture_output=True, text=True, env=env,
                          cwd=str(cwd or prefix), timeout=120)


def load_via(path: Path) -> object:
    """Import the CLI module with __file__ = `path` (a symlink path counts)."""
    s = importlib.util.spec_from_file_location("hivv_cli_via_" + path.name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


class TestInstalledClientPath:
    def test_prefers_the_wrapper_derived_path(self, tmp_path, monkeypatch):
        prefix = make_prefix(tmp_path)
        monkeypatch.setenv("PATH", f"{prefix / 'bin'}{os.pathsep}" + os.environ.get("PATH", ""))
        got = hivv._installed_client_path()
        assert got == prefix / "lib" / "hivv" / "hivv-cli.py", (
            "the target must be where the WRAPPER looks, not INSTALL_DIR"
        )

    def test_none_when_no_install(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PATH", str(tmp_path / "empty"))
        monkeypatch.setattr(hivv, "INSTALL_DIR", tmp_path / "nope")
        assert hivv._installed_client_path() is None


class TestActiveCliInfo:
    def test_plain_install_reads_as_installed(self, tmp_path):
        prefix = make_prefix(tmp_path)
        m = load_via(prefix / "lib" / "hivv" / "hivv-cli.py")
        info = m._active_cli_info()
        assert info["is_link"] is False
        assert info["origin"] == "installed"

    def test_link_reads_as_clone_link(self, tmp_path):
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / "hivv-cli.py").write_text(CLI_PATH.read_text())
        (clone / ".git").mkdir()          # a worktree marker
        link = tmp_path / "prefix-link"
        link.mkdir()
        (link / "hivv-cli.py").symlink_to(clone / "hivv-cli.py")
        m = load_via(link / "hivv-cli.py")
        info = m._active_cli_info()
        assert info["is_link"] is True
        assert info["origin"] == "clone-link"
        assert "clone link" in info["display"]

    def test_running_from_a_source_tree_says_so(self, tmp_path):
        tree = tmp_path / "tree"
        (tree / ".git").mkdir(parents=True)
        (tree / "hivv-cli.py").write_text(CLI_PATH.read_text())
        m = load_via(tree / "hivv-cli.py")
        info = m._active_cli_info()
        assert info["origin"] == "source-tree"
        assert "source tree" in info["display"]


class TestDevModeViaLink:
    def test_running_through_a_link_is_dev_mode(self, tmp_path):
        """git pull is the update path, so the auto-updater must stand
        aside — otherwise it fights the source-tree guard every 5 minutes."""
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / "hivv-cli.py").write_text(CLI_PATH.read_text())
        (clone / ".git").mkdir()
        link = tmp_path / "l"
        link.mkdir()
        (link / "hivv-cli.py").symlink_to(clone / "hivv-cli.py")
        m = load_via(link / "hivv-cli.py")
        monkey_free = m._is_dev_mode()
        assert monkey_free is True, "a linked client must be dev mode"


class TestLinkCommand:
    def test_registered(self):
        assert hivv.COMMANDS.get("link") is not None
        assert hivv.COMMANDS.get("unlink") is not None

    def test_link_creates_the_symlink(self, tmp_path):
        prefix = make_prefix(tmp_path)
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / ".git").mkdir()
        shutil.copy2(CLI_PATH, clone / "hivv-cli.py")
        r = run(prefix, "link", str(clone / "hivv-cli.py"),
                state_dir=tmp_path / "state")
        assert r.returncode == 0, r.stderr + r.stdout
        client = prefix / "lib" / "hivv" / "hivv-cli.py"
        assert client.is_symlink(), "link must replace the installed copy"
        assert client.resolve() == (clone / "hivv-cli.py").resolve()

    def test_link_records_state(self, tmp_path):
        prefix = make_prefix(tmp_path)
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / ".git").mkdir()
        shutil.copy2(CLI_PATH, clone / "hivv-cli.py")
        state = tmp_path / "state"
        run(prefix, "link", str(clone / "hivv-cli.py"), state_dir=state)
        st = hivv.json.loads((state / "state.json").read_text())
        assert st.get("cli_link"), "the link must be recorded so status can warn"

    def test_link_is_idempotent(self, tmp_path):
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / ".git").mkdir()
        shutil.copy2(CLI_PATH, clone / "hivv-cli.py")
        prefix = make_prefix(tmp_path, with_link_to=clone / "hivv-cli.py")
        r = run(prefix, "link", str(clone / "hivv-cli.py"),
                state_dir=tmp_path / "state")
        assert r.returncode == 0
        assert "already linked" in r.stdout

    def test_link_refuses_a_broken_target(self, tmp_path):
        """A bad link bricks EVERY hivv command (the wrapper execs it)."""
        prefix = make_prefix(tmp_path)
        bad = tmp_path / "bad.py"
        bad.write_text("def oops(:\n")
        r = run(prefix, "link", str(bad), state_dir=tmp_path / "state")
        assert r.returncode != 0
        assert "does not compile" in (r.stdout + r.stderr)
        client = prefix / "lib" / "hivv" / "hivv-cli.py"
        assert not client.is_symlink(), "the existing copy must be untouched"

    def test_link_without_an_install_explains_itself(self, tmp_path):
        empty = tmp_path / "emptybin"
        empty.mkdir()
        env = dict(os.environ)
        env["PATH"] = str(empty)
        env["HIVV_STATE_DIR"] = str(tmp_path / "state")
        # INSTALL_DIR also must not exist → _installed_client_path() is None
        env["HIVV_INSTALL_DIR"] = str(tmp_path / "noinstall")
        clone = tmp_path / "clone"
        clone.mkdir()
        shutil.copy2(CLI_PATH, clone / "hivv-cli.py")
        r = subprocess.run([sys.executable, str(CLI_PATH), "link",
                            str(clone / "hivv-cli.py")],
                           capture_output=True, text=True, env=env, timeout=60)
        assert r.returncode != 0
        assert "no install found" in (r.stdout + r.stderr)

    def test_wrapper_runs_the_linked_clone(self, tmp_path):
        """End to end: after link, the wrapper executes the CLONE's bytes."""
        prefix = make_prefix(tmp_path)
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / ".git").mkdir()
        # a recognizable client: prints a marker and exits.
        # Shebang REQUIRED — the wrapper's cli_is_healthy() checks the first
        # line for `#!...python` and re-downloads (breaking the link) if absent.
        (clone / "hivv-cli.py").write_text(
            "#!/usr/bin/env python3\nimport sys\nprint('FROM-THE-CLONE')\nsys.exit(0)\n")
        (clone / "hivv-cli.py").chmod(0o755)
        r = run(prefix, "link", str(clone / "hivv-cli.py"),
                state_dir=tmp_path / "state")
        assert r.returncode == 0, r.stderr + r.stdout
        r2 = run(prefix, "--version", state_dir=tmp_path / "state")
        assert "FROM-THE-CLONE" in r2.stdout, (
            f"the wrapper must exec the linked clone: {r2.stdout!r}"
        )


class TestUnlinkCommand:
    def test_unlink_freezes_into_a_real_file(self, tmp_path):
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / ".git").mkdir()
        shutil.copy2(CLI_PATH, clone / "hivv-cli.py")
        prefix = make_prefix(tmp_path, with_link_to=clone / "hivv-cli.py")
        state = tmp_path / "state"
        r = run(prefix, "unlink", state_dir=state)
        assert r.returncode == 0, r.stderr + r.stdout
        client = prefix / "lib" / "hivv" / "hivv-cli.py"
        assert not client.is_symlink(), "unlink must replace the link with a file"
        assert client.read_bytes() == (clone / "hivv-cli.py").read_bytes(), (
            "the frozen copy must hold exactly what was running"
        )
        st = hivv.json.loads((state / "state.json").read_text())
        assert "cli_link" not in st, "the recorded link must be cleared"

    def test_unlink_on_a_real_file_is_a_noop(self, tmp_path):
        prefix = make_prefix(tmp_path)
        r = run(prefix, "unlink", state_dir=tmp_path / "state")
        assert r.returncode == 0
        assert "not linked" in r.stdout
        assert (prefix / "lib" / "hivv" / "hivv-cli.py").is_file()

    def test_link_then_unlink_roundtrip(self, tmp_path):
        prefix = make_prefix(tmp_path)
        clone = tmp_path / "clone"
        clone.mkdir()
        (clone / ".git").mkdir()
        shutil.copy2(CLI_PATH, clone / "hivv-cli.py")
        state = tmp_path / "state"
        assert run(prefix, "link", str(clone / "hivv-cli.py"),
                   state_dir=state).returncode == 0
        client = prefix / "lib" / "hivv" / "hivv-cli.py"
        assert client.is_symlink()
        assert run(prefix, "unlink", state_dir=state).returncode == 0
        assert client.is_file() and not client.is_symlink()


class TestInstallersNeverWriteThroughALink:
    """`cp src dst` with dst a symlink FOLLOWS it — an install would
    overwrite the clone the user linked. Data loss; pinned on all three."""

    def test_deps_sh_keeps_an_existing_link(self, tmp_path):
        prefix = tmp_path / "prefix"
        target = tmp_path / "their-clone.py"
        target.write_text("# THEIR CLONE — must survive an install\n")
        client = prefix / "lib" / "hivv"
        client.mkdir(parents=True)
        (client / "hivv-cli.py").symlink_to(target)
        (prefix / "bin").mkdir()
        r = subprocess.run(
            ["bash", "-c",
             f'source "{DEPS_SH}"; d_install_cli "{prefix}" 0 "{PUBLIC_DIR}"'],
            capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        link = prefix / "lib" / "hivv" / "hivv-cli.py"
        assert link.is_symlink(), "the install must NOT replace the link"
        assert target.read_text().startswith("# THEIR CLONE"), (
            "the install wrote THROUGH the link into the user's clone"
        )
        assert "kept your clone link" in r.stderr, (
            "the install must SAY it kept the link, not silently skip"
        )

    def test_deps_sh_still_installs_without_a_link(self, tmp_path):
        prefix = tmp_path / "prefix"
        r = subprocess.run(
            ["bash", "-c",
             f'source "{DEPS_SH}"; d_install_cli "{prefix}" 0 "{PUBLIC_DIR}"'],
            capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        assert (prefix / "lib" / "hivv" / "hivv-cli.py").is_file()

    def test_install_hivv_sh_guards_dl(self):
        """The curl installer's dl() must refuse to write through a link."""
        src = (PUBLIC_DIR / "install-hivv.sh").read_text()
        assert "-L \"$out\"" in src, "dl() must test for a symlink"
        assert "kept existing link" in src

    def test_ps1_guards_copy(self):
        src = (REPO / "scripts" / "setup-local.ps1").read_text()
        assert "Test-Path -PathType Link" in src, (
            "the PowerShell installer must check for a link too"
        )
