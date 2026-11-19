#!/usr/bin/env python3
"""Regression tests: the `hivv` COMMAND must exist, and `hivv update` must
never overwrite a source tree.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
2026-11-18: a person ran `./setup.sh`, then `hivv update`, then `hivv chat`.

  * `hivv chat` → "command not found". The clone held a working CLI, but
    NOTHING ever put the COMMAND on PATH — and the script's own next-step
    text said "hivv chat", so it read like it was installed.
  * `hivv update` → silently REPLACED the repo's own `public_html/hivv-cli.py`
    with the copy served by the hub, dirtying `git status` and destroying the
    working copy. The update target fell back to "the file I am executing"
    whenever no install prefix existed — inside a clone that IS the source.

Both are pinned here:

  1. the setup scripts install the standard layout
     <prefix>/bin/hivv  +  <prefix>/lib/hivv/hivv-cli.py
     and that layout is the CONTRACT (the wrapper resolves the client
     relative to itself; the client derives INSTALL_DIR the same way), so
     `hivv update` then updates the INSTALLED copy, never a checkout;
  2. an update that would land on a git-tracked file is REFUSED, with
     --force as the explicit override.

Plus the crash that hid the repair path: `hivv doctor --fix` died with
`UnboundLocalError: cannot access local variable 'tempfile'` because a
nested `import tempfile` in ONE branch made the name local to the whole
function — and the branch that needed it never ran (no ollama on the box).
The command that repairs a broken install could not repair it.

And its sequel (yalla 2026-11-18): `hivv doctor` itself crashed with
`UnboundLocalError: cannot access local variable 'platform'` — cmd_doctor
re-imported `platform` LATER in the function (firewall section), making the
name function-local for the whole function, so the earlier
`platform.system()` use in the resilience section died. Module-level
`import platform` already existed; the fix is to never re-import it.

Run:
    python3 -m pytest tests/test_cli_install.py -q
    python3 tests/test_cli_install.py
"""

from __future__ import annotations

import ast
import re
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DEPS = REPO / "scripts" / "lib" / "deps.sh"
SETUP = REPO / "setup.sh"
SETUP_LOCAL = REPO / "scripts" / "setup-local.sh"
SETUP_PS1 = REPO / "scripts" / "setup-local.ps1"
PUBLIC_DIR = REPO / "public_html"
CLI_PATH = PUBLIC_DIR / "hivv-cli.py"
WRAPPER = PUBLIC_DIR / "hivv"

# Isolate the CLI's state before importing it (the module resolves
# STATE_DIR/CONFIG_DIR at import time). The hub points at a dead port so a
# stray request fails fast instead of touching production.
os.environ["HIVV_STATE_DIR"] = tempfile.mkdtemp(prefix="hivv-test-state-")
os.environ["HIVV_HUB"] = "http://127.0.0.1:1"

_spec = importlib.util.spec_from_file_location("hivv_cli_install", str(CLI_PATH))
hivv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hivv)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def bash(script: str, timeout: int = 120) -> subprocess.CompletedProcess:
    """Run a snippet with scripts/lib/deps.sh sourced."""
    return subprocess.run(
        ["bash", "-c", f'. "{DEPS}"\ndetect_platform\n{script}'],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# ── 1. the layout contract ───────────────────────────────────────────────
class TestInstallLayout:
    """<prefix>/bin/hivv + <prefix>/lib/hivv/hivv-cli.py — and nothing else.

    The layout is not cosmetic:
      * the wrapper resolves CLIENT_FILE as <prefix>/lib/hivv/hivv-cli.py,
        relative to ITSELF;
      * hivv-cli.py derives INSTALL_DIR from its own location and BIN_DIR
        from that — which is what makes `hivv update` write to the
        INSTALLED copy instead of whatever file happens to be executing.
    """

    def test_install_cli_creates_the_layout(self, tmp_path):
        prefix = tmp_path / "prefix"
        r = bash(f'd_install_cli "{prefix}" 0 "{PUBLIC_DIR}"')
        assert r.returncode == 0, r.stderr
        client = prefix / "lib" / "hivv" / "hivv-cli.py"
        wrapper = prefix / "bin" / "hivv"
        assert client.exists(), f"client missing at {client}"
        assert wrapper.exists(), f"wrapper missing at {wrapper}"
        assert os.access(client, os.X_OK), "client must be executable"
        assert os.access(wrapper, os.X_OK), "wrapper must be executable"

    def test_installed_wrapper_resolves_its_own_client(self, tmp_path):
        """The wrapper must find the client NEXT TO ITSELF, not in a clone."""
        prefix = tmp_path / "prefix"
        bash(f'd_install_cli "{prefix}" 0 "{PUBLIC_DIR}"')
        wrapper = prefix / "bin" / "hivv"
        r = subprocess.run([str(wrapper), "--version"],
                           capture_output=True, text=True, timeout=90)
        assert r.returncode == 0, f"installed wrapper failed: {r.stderr[-300:]}"
        # --version prints the bare version string — a version-shaped answer
        # proves the wrapper found AND ran the client next to itself.
        assert re.search(r"\d+\.\d+\.\w+", r.stdout), (
            f"the installed wrapper did not run its own client: {r.stdout!r}"
        )

    def test_installed_client_derives_the_same_install_dir(self, tmp_path):
        """hivv-cli.py at <prefix>/lib/hivv/ must resolve INSTALL_DIR to
        itself — that is what stops `hivv update` from writing anywhere else.
        """
        prefix = tmp_path / "prefix"
        bash(f'd_install_cli "{prefix}" 0 "{PUBLIC_DIR}"')
        client = prefix / "lib" / "hivv" / "hivv-cli.py"
        code = (
            "import importlib.util,sys;"
            f"s=importlib.util.spec_from_file_location('c','{client}');"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            "print('INSTALL_DIR='+str(m.INSTALL_DIR));"
            "print('BIN_DIR='+str(m.BIN_DIR))"
        )
        env = dict(os.environ)
        env["HIVV_STATE_DIR"] = tempfile.mkdtemp(prefix="hivv-test-state-")
        r = subprocess.run([sys.executable, "-c", code],
                           capture_output=True, text=True, timeout=90, env=env)
        assert r.returncode == 0, r.stderr[-400:]
        out = r.stdout
        assert f"INSTALL_DIR={prefix / 'lib' / 'hivv'}" in out, out
        assert f"BIN_DIR={prefix / 'bin'}" in out, out

    def test_install_cli_refuses_a_missing_source(self, tmp_path):
        r = bash(f'd_install_cli "{tmp_path / "p"}" 0 "{tmp_path / "nope"}"')
        assert r.returncode != 0, "must fail when the source files are missing"


# ── 2. the setup scripts put the COMMAND on PATH ────────────────────────
class TestSetupInstallsTheCommand:
    """A clone without `hivv` on PATH is a dead end the scripts must not
    leave behind — they used to print "hivv chat ..." as the next step
    while `hivv` did not exist."""

    def test_bash_setup_scripts_install_the_cli(self):
        for script in (SETUP, SETUP_LOCAL):
            blob = read(script)
            assert "d_install_cli" in blob, (
                f"{script.name} must install the hivv command, not just the clone copy"
            )

    def test_windows_setup_installs_the_cli(self):
        blob = read(SETUP_PS1)
        assert "hivv.cmd" in blob, "the Windows setup must install the wrapper"
        assert "hivv-cli.py" in blob, "the Windows setup must install the client"

    def test_setup_scripts_use_the_contract_layout(self):
        deps = read(DEPS)
        assert "lib/$APP" in deps or "lib/hivv" in deps, (
            "the client must land in <prefix>/lib/hivv — the wrapper resolves it there"
        )
        assert "$prefix/bin" in deps or "$prefix/bin/" in deps, (
            "the wrapper must land in <prefix>/bin"
        )

    def test_setup_does_not_only_offer_the_hub_install(self):
        """The old dead end: "install the CLI first: curl … | bash".
        The clone ALREADY has the CLI — it must be installed from there."""
        for script in (SETUP, SETUP_LOCAL):
            blob = read(script)
            assert "d_install_cli" in blob, (
                f"{script.name} still sends people to the hub for a CLI the clone has"
            )


# ── 3. an update must never land on a source tree ───────────────────────
class TestUpdateNeverOverwritesSource:
    """`hivv update` fell back to "the file I am executing" when no install
    prefix existed. Inside a clone that IS the user's source."""

    def test_git_worktree_is_detected(self, tmp_path):
        repo = tmp_path / "repo"
        (repo / "sub").mkdir(parents=True)
        (repo / ".git").mkdir()
        target = repo / "sub" / "hivv-cli.py"
        target.write_text("# x\n")
        assert hivv._in_git_worktree(target) is True

    def test_plain_directory_is_not_a_worktree(self, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()
        target = plain / "hivv-cli.py"
        target.write_text("# x\n")
        assert hivv._in_git_worktree(target) is False

    def test_git_worktree_file_marker_is_detected(self, tmp_path):
        """Worktrees and submodules use a .git FILE, not a directory."""
        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / ".git").write_text("gitdir: /elsewhere/.git/worktrees/x\n")
        target = repo / "hivv-cli.py"
        target.write_text("# x\n")
        assert hivv._in_git_worktree(target) is True

    def test_apply_update_refuses_a_git_tracked_target(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / ".git").mkdir()
        target = repo / "hivv-cli.py"
        target.write_text("# original\n")
        old_install = hivv.INSTALL_DIR
        old_force = hivv._UPDATE_FORCE
        try:
            hivv.INSTALL_DIR = repo          # the update would land here
            hivv._UPDATE_FORCE = False
            ok, msg, path = hivv._apply_update(b"# replaced\n")
        finally:
            hivv.INSTALL_DIR = old_install
            hivv._UPDATE_FORCE = old_force
        assert ok is False, "an update must not overwrite a git source file"
        assert "git" in msg.lower(), f"the refusal must explain itself: {msg}"
        assert target.read_text() == "# original\n", "the source file was modified"

    def test_apply_update_writes_outside_a_worktree(self, tmp_path):
        target_dir = tmp_path / "lib" / "hivv"
        target_dir.mkdir(parents=True)
        target = target_dir / "hivv-cli.py"
        target.write_text("# original\n")
        old_install = hivv.INSTALL_DIR
        old_force = hivv._UPDATE_FORCE
        try:
            hivv.INSTALL_DIR = target_dir
            hivv._UPDATE_FORCE = False
            ok, msg, path = hivv._apply_update(b"# replaced\n")
        finally:
            hivv.INSTALL_DIR = old_install
            hivv._UPDATE_FORCE = old_force
        assert ok is True, f"a normal install must update: {msg}"
        assert target.read_text() == "# replaced\n"

    def test_force_overrides_the_source_guard(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        (repo / ".git").mkdir()
        target = repo / "hivv-cli.py"
        target.write_text("# original\n")
        old_install = hivv.INSTALL_DIR
        old_force = hivv._UPDATE_FORCE
        try:
            hivv.INSTALL_DIR = repo
            hivv._UPDATE_FORCE = True
            ok, msg, path = hivv._apply_update(b"# replaced\n")
        finally:
            hivv.INSTALL_DIR = old_install
            hivv._UPDATE_FORCE = old_force
        assert ok is True, f"--force must override the guard: {msg}"
        assert target.read_text() == "# replaced\n"

    def test_cli_source_is_not_a_git_worktree_target(self):
        """Sanity: the shipped CLI in a checkout IS detected as source — that
        is why `hivv update` from a clone is refused."""
        assert hivv._in_git_worktree(CLI_PATH) is True, (
            "the repo's own CLI must be recognised as a source file"
        )


# ── 4. `hivv doctor --fix` must not crash ───────────────────────────────
class TestDoctorFixDoesNotCrash:
    """`hivv doctor --fix` died with
    `UnboundLocalError: cannot access local variable 'tempfile'`.

    A nested `import tempfile` in ONE branch made the name local to the
    WHOLE function, so the other branch — which needs it — hit an unbound
    local. The branch that bound it only runs when ollama is installed, so
    on a box WITHOUT ollama the repair command always crashed. The command
    that repairs a broken install could not repair it.
    """

    def _function_node(self, name: str) -> ast.FunctionDef:
        tree = ast.parse(read(CLI_PATH))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
        raise AssertionError(f"{name} not found in {CLI_PATH}")

    def test_tempfile_is_imported_at_function_scope(self):
        fn = self._function_node("cmd_doctor")
        direct = [n for n in fn.body
                  if isinstance(n, ast.Import)
                  and any(a.name.split(".")[0] == "tempfile" for a in n.names)]
        assert direct, (
            "cmd_doctor must import tempfile in the function body — a nested "
            "import leaves the name unbound on the other branches"
        )

    def test_shadowed_module_imports_are_gone(self):
        """`urllib` is imported at MODULE level. A function-level
        `import urllib.request` makes `urllib` a LOCAL of that function —
        and any path that runs before the import hits UnboundLocalError.

        _do_chat: the import sat in the DIRECT-node branch, so the
        hub-fallback path (no direct node could answer) crashed.
        cmd_call: the import sat in the LOCAL-tools branch, so the
        hive-routing path crashed.

        A local that a nested closure captures lives in co_cellvars, not
        co_varnames — both must be checked, or the bug hides.
        """
        for fn_name in ("_do_chat", "cmd_call"):
            fn = getattr(hivv, fn_name)
            code = fn.__code__
            shadowed = ("urllib" in code.co_varnames
                        or "urllib" in code.co_cellvars)
            assert not shadowed, (
                f"{fn_name} shadows the module-level urllib (as a local/cell) — "
                "a path that runs before the import raises UnboundLocalError"
            )
        assert hasattr(hivv.urllib, "request"), "urllib.request must be module-level"

    def test_no_conditional_import_is_used_outside_its_block(self):
        """General guard for the whole bug class.

        A name imported inside a CONDITIONAL block (if/for/while/with) may
        never be bound — and if it is used where that block does not
        dominate, the reference raises UnboundLocalError. The classic
        instance: `import tempfile` in one branch of `hivv doctor --fix`,
        used in a different branch — the repair command crashed whenever
        the binding branch was skipped.
        """
        tree = ast.parse(read(CLI_PATH))
        offenders = []

        def own_scope(fn):
            """Nodes that belong to fn's OWN scope.

            A nested def/lambda has its own scope — an import inside it
            binds a name THERE, not in fn. Walking the whole tree would
            wrongly blame the outer function for the inner one's import.
            """
            stack = list(fn.body)
            while stack:
                node = stack.pop()
                yield node
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef,
                                          ast.ClassDef, ast.Lambda)):
                        continue
                    stack.append(child)

        def ancestors(node, fn):
            """All enclosing nodes of `node` up to (and excluding) `fn`."""
            out, cur = [], node
            while cur is not None and cur is not fn:
                out.append(cur)
                cur = getattr(cur, "_parent", None)
            return out

        for fn in ast.walk(tree):
            if not isinstance(fn, ast.FunctionDef):
                continue
            # parent links, so we can ask "is this block an ancestor?"
            for parent in ast.walk(fn):
                for child in ast.iter_child_nodes(parent):
                    child._parent = parent

            own = list(own_scope(fn))

            exempt = set()
            for node in own:
                if isinstance(node, (ast.Global, ast.Nonlocal)):
                    exempt.update(node.names)

            imports = {}   # name -> [(lineno, node, nearest_conditional)]
            for node in own:
                if isinstance(node, ast.Import):
                    for a in node.names:
                        nm = (a.asname or a.name).split(".")[0]
                        if nm in exempt:
                            continue
                        cond = None
                        for anc in ancestors(node, fn):
                            if isinstance(anc, (ast.If, ast.For, ast.While,
                                                ast.With)):
                                cond = anc
                                break
                        imports.setdefault(nm, []).append((node.lineno, node, cond))

            for use in own:
                if not (isinstance(use, ast.Name) and isinstance(use.ctx, ast.Load)):
                    continue
                nm = use.id
                if nm not in imports:
                    continue
                prior = [i for i in imports[nm] if i[0] < use.lineno]
                if not prior:
                    continue          # no local binding yet → global/builtin
                lineno, inode, cond = max(prior, key=lambda i: i[0])
                if cond is None:
                    continue          # unconditional import → always bound
                if cond in ancestors(use, fn):
                    continue          # the import dominates this use → fine
                offenders.append((fn.name, nm, use.lineno, lineno))

        unique = sorted(set(offenders))
        assert not unique, (
            "a name imported only inside a conditional block but used where "
            "that block does not dominate → UnboundLocalError: " + repr(unique)
        )

    def test_platform_is_not_shadowed_in_cmd_doctor(self):
        """`hivv doctor` crashed in its OWN resilience section:

        `UnboundLocalError: cannot access local variable 'platform'`
        at `if platform.system() == "Linux"` — cmd_doctor re-imported
        `platform` LATER in the function (firewall section), which makes the
        name function-local for the WHOLE function, so the earlier use dies
        before the binding ever runs (yalla 2026-11-18). The conditional
        guard above misses this: an UNCONDITIONAL import after the use has
        no conditional ancestor to complain about — the bug is the ORDER.
        Module-level `import platform` already exists; never re-import it.
        """
        code = hivv.cmd_doctor.__code__
        shadowed = ("platform" in code.co_varnames
                    or "platform" in code.co_cellvars)
        assert not shadowed, (
            "cmd_doctor binds `platform` locally — a use before that binding "
            "raises UnboundLocalError and kills the whole report"
        )
        assert hasattr(hivv, "platform"), "module-level import platform must stand"

    def test_no_use_of_module_name_before_local_binding(self):
        """Whole-file guard for the ORDER half of the bug class.

        The conditional test above catches 'import in one branch, use in
        another'. This catches the other shape: a function that binds a name
        ANYWHERE locally (import/assign) but USES a module-level name of
        that kind EARLIER — Python makes the name local for the whole
        function, so the earlier use raises UnboundLocalError on every path.
        cmd_doctor/platform was exactly this (use at 10559, import at 10677).
        """
        tree = ast.parse(read(CLI_PATH))
        mod_names: set[str] = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                for x in node.names:
                    mod_names.add((x.asname or x.name).split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                for x in node.names:
                    mod_names.add((x.asname or x.name).split(".")[0])

        def own_scope(fn):
            stack = list(fn.body)
            while stack:
                n = stack.pop()
                yield n
                for c in ast.iter_child_nodes(n):
                    if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef,
                                      ast.ClassDef, ast.Lambda)):
                        continue
                    stack.append(c)

        def bound_names(node) -> set[str]:
            out: set[str] = set()
            if isinstance(node, ast.Import):
                for a in node.names:
                    out.add((a.asname or a.name).split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                for a in node.names:
                    out.add((a.asname or a.name).split(".")[0])
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                ts = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in ts:
                    for x in ast.walk(t):
                        if isinstance(x, ast.Name) and isinstance(x.ctx, (ast.Store, ast.Del)):
                            out.add(x.id)
            elif isinstance(node, ast.For):
                for x in ast.walk(node.target):
                    if isinstance(x, ast.Name):
                        out.add(x.id)
            elif isinstance(node, ast.With):
                for it in node.items:
                    if it.optional_vars:
                        for x in ast.walk(it.optional_vars):
                            if isinstance(x, ast.Name):
                                out.add(x.id)
            elif isinstance(node, ast.ExceptHandler) and node.name:
                out.add(node.name)
            elif isinstance(node, ast.NamedExpr):
                for x in ast.walk(node.target):
                    if isinstance(x, ast.Name):
                        out.add(x.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                out.add(node.name)
            return out

        offenders = []
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            own = list(own_scope(fn))
            exempt: set[str] = set()
            for n in own:
                if isinstance(n, (ast.Global, ast.Nonlocal)):
                    exempt.update(n.names)
            argnames = {a.arg for a in
                        fn.args.args + fn.args.kwonlyargs + fn.args.posonlyargs}
            if fn.args.vararg:
                argnames.add(fn.args.vararg.arg)
            if fn.args.kwarg:
                argnames.add(fn.args.kwarg.arg)
            first_bind: dict[str, int] = {}
            for n in own:
                for nm in bound_names(n):
                    if nm in exempt or nm in argnames:
                        continue
                    if nm not in first_bind or n.lineno < first_bind[nm]:
                        first_bind[nm] = n.lineno
            if not first_bind:
                continue
            for parent in ast.walk(fn):
                for child in ast.iter_child_nodes(parent):
                    child._parent = parent
            for n in own:
                if not (isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)):
                    continue
                # comprehension vars live in a hidden scope — skip their bodies
                cur, in_comp = n, False
                while cur is not fn:
                    if isinstance(cur, ast.comprehension):
                        in_comp = True
                        break
                    cur = getattr(cur, "_parent", None)
                if in_comp:
                    continue
                nm = n.id
                if nm in first_bind and nm in mod_names and n.lineno < first_bind[nm]:
                    offenders.append((fn.name, nm, n.lineno, first_bind[nm]))
        unique = sorted(set(offenders))
        assert not unique, (
            "module-level name bound locally AFTER a use → UnboundLocalError "
            "on that path: " + repr(unique)
        )


if __name__ == "__main__":
    print("\nHIVV — CLI install / source-protection regression tests\n")
    rc = 0
    for cls_name in ("TestInstallLayout", "TestSetupInstallsTheCommand",
                     "TestUpdateNeverOverwritesSource",
                     "TestDoctorFixDoesNotCrash"):
        cls = globals()[cls_name]
        for meth in sorted(m for m in dir(cls) if m.startswith("test_")):
            inst = cls()
            fn = getattr(inst, meth)
            kwargs = {}
            if "tmp_path" in fn.__code__.co_varnames[:fn.__code__.co_argcount]:
                kwargs["tmp_path"] = Path(tempfile.mkdtemp(prefix="hivv-t-"))
            try:
                fn(**kwargs)
                print(f"  \033[32mPASS\033[0m  {cls_name}.{meth}")
            except AssertionError as exc:
                rc = 1
                print(f"  \033[31mFAIL\033[0m  {cls_name}.{meth}  {exc}")
    print(f"\n  exit {rc}\n")
    sys.exit(rc)
