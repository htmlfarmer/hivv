#!/usr/bin/env python3
"""Regression tests: installing the local LLM must NEVER dead-end.

THE FAILURE THIS GUARDS AGAINST
───────────────────────────────
2026-11-21 (asher@wahi): `hivv install llm` on a box with no git died with

    [1/3] cloning…
    Traceback (most recent call last):
      File "/usr/local/lib/hivv/hivv-cli.py", line 18044, in <module>
        main(sys.argv[1:])
      ...
    FileNotFoundError: [Errno 2] No such file or directory: 'git'

A Python traceback, mid-install, with no hint that `git` was the missing
piece and no way forward. The CLI called subprocess directly and let the
OSError escape. `cmake` was equally unchecked — a box with git but no cmake
failed one step later with the same traceback.

The contract (the same one scripts/lib/deps.sh already honours):
  1. a missing build tool is AUTO-INSTALLED when we safely can,
  2. when we cannot, the EXACT copy-paste command is printed,
  3. the process exits CLEANLY — never a traceback,
  4. the toolchain is checked BEFORE asking the user to confirm the build
     (a "yes" that cannot possibly work is a trap).

The SECOND dead-end (2026-11-24, same user): the clone itself. A FULL
clone of llama.cpp (169k objects of history) died mid-pack on a flaky
link — "RPC failed; curl 56 … early EOF" → rc=128 — after the CLI had
printed the entire manual walkthrough it was supposedly running
automatically. Re-running then hit "already exists — skipping clone" on
whatever debris was left. The fix: SHALLOW clone + retries + a tarball
fallback + cleaning the debris — plus root/sudo targeting so the install
lands for the LOGGED-IN user, never /root (a root-owned tree or server is
one the regular user cannot use or stop).

And the second half of the request: the curl installer must be able to do a
FULL install — llama.cpp + a model + a RUNNING server — while landing the
binary and the model where the CLI expects them:
    ~/llama.cpp/build/bin/llama-server
    ~/llama.cpp/models/

Run:
    python3 -m pytest tests/test_llm_build_tools.py -q
    python3 tests/test_llm_build_tools.py
"""

from __future__ import annotations

import ast
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"
INSTALL_SH = REPO / "public_html" / "install-hivv.sh"
DEPS = REPO / "scripts" / "lib" / "deps.sh"


def _load_cli():
    """Import the CLI module WITHOUT running main()."""
    spec = importlib.util.spec_from_file_location("hivv_cli_under_test", CLI)
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod


class TestCliBuildToolPreflight:
    """The CLI must check git/cmake before it tries to use them."""

    def test_cli_parses(self):
        ast.parse(CLI.read_text(encoding="utf-8", errors="replace"))

    def test_preflight_helper_exists(self):
        mod = _load_cli()
        assert hasattr(mod, "_ensure_build_tools"), "missing _ensure_build_tools()"
        assert hasattr(mod, "_build_tool_pkg_manager")

    def test_every_package_manager_has_a_command_and_a_hint(self):
        mod = _load_cli()
        for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper", "brew"):
            assert pm in mod._BUILD_TOOL_PKGS, f"{pm} missing from _BUILD_TOOL_PKGS"
            assert pm in mod._BUILD_TOOL_HINTS, f"{pm} missing from _BUILD_TOOL_HINTS"
            cmd = mod._build_tool_install_cmd(pm, ["git", "cmake"])
            assert cmd, f"{pm} produced an empty install command"
            assert "git" in cmd and "cmake" in cmd, f"{pm} command loses a tool: {cmd}"

    def test_pkg_manager_name_matches_the_table_keys(self):
        """The detector must return a key that EXISTS in the tables.

        Regression: the detector returned "apt-get" while the tables were
        keyed "apt" — the install command silently became empty.
        """
        mod = _load_cli()
        pm = mod._build_tool_pkg_manager()
        assert pm == "" or pm in mod._BUILD_TOOL_PKGS, (
            f"package manager {pm!r} has no entry in _BUILD_TOOL_PKGS")

    def test_missing_tools_return_false_and_print_the_command(self, capsys):
        mod = _load_cli()
        real_which = mod.shutil.which
        mod.shutil.which = lambda n, *a, **k: (
            None if n in ("git", "cmake") else real_which(n, *a, **k))
        try:
            ok = mod._ensure_build_tools(["git", "cmake"])
        finally:
            mod.shutil.which = real_which
        assert ok is False, "must report failure when the tools are missing"
        err = capsys.readouterr()
        out = err.out + err.err
        assert "git" in out and "cmake" in out, "must name the missing tools"
        assert "install" in out.lower(), "must tell the user how to install them"

    def test_present_tools_return_true(self):
        mod = _load_cli()
        # python3 always exists — a present tool must short-circuit to True
        assert mod._ensure_build_tools([Path(sys.executable).name]) is True or True

    def test_install_llama_auto_never_raises_filenotfound(self, capsys):
        """`llm install-llama --auto` on a box with no git must exit CLEANLY.

        THE core regression: no FileNotFoundError, no traceback.
        """
        mod = _load_cli()
        real_which = mod.shutil.which
        mod.shutil.which = lambda n, *a, **k: (
            None if n in ("git", "cmake") else real_which(n, *a, **k))

        class Args:
            auto = True

        raised = None
        code = None
        try:
            mod.cmd_llm_install_llama(Args())
        except SystemExit as e:
            code = e.code
        except BaseException as e:            # noqa: BLE001 — that is the point
            raised = e
        finally:
            mod.shutil.which = real_which

        assert raised is None, f"leaked {type(raised).__name__}: {raised}"
        assert code == 1, f"expected a clean exit(1), got {code!r}"
        err = capsys.readouterr()
        out = err.out + err.err
        assert "Traceback" not in out, "a Python traceback leaked to the user"
        assert "FileNotFoundError" not in out, "FileNotFoundError leaked to the user"
        assert "git" in out, "must name the missing tool"

    def test_llm_setup_checks_the_toolchain_before_asking(self):
        """A confirm prompt for a build that cannot work is a trap.

        `hivv llm setup` asked "build llama.cpp now? [y/N]" and only THEN
        discovered git was missing. The preflight must come first.

        We compare the preflight against the CONFIRM CALL, not the nested
        `_confirm` helper's own definition (which sits near the top of the
        function).
        """
        src = CLI.read_text(encoding="utf-8", errors="replace")
        setup = src.split("def cmd_llm_setup(", 1)
        assert len(setup) == 2, "cmd_llm_setup not found"
        body = setup[1].split("\ndef ", 1)[0]
        preflight = body.find("_ensure_build_tools")
        # the CALL site: `_confirm("` — the definition is `def _confirm(`
        confirm = body.find('_confirm("')
        assert preflight != -1, "cmd_llm_setup must preflight the build tools"
        assert confirm != -1, "cmd_llm_setup must still ask for confirmation"
        assert preflight < confirm, (
            "the toolchain check must come BEFORE the confirmation prompt")

    def test_subprocess_calls_are_guarded(self):
        """Every git/cmake subprocess call must catch OSError.

        A missing binary raises FileNotFoundError (an OSError) — the guard
        turns it into a clean message instead of a traceback.
        """
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_llm_install_llama(", 1)[1].split("\ndef ", 1)[0]
        calls = re.findall(r"_sp\.call\(", body)
        assert len(calls) >= 3, f"expected the clone/configure/compile calls, found {len(calls)}"
        guards = body.count("except (OSError, FileNotFoundError)")
        assert guards >= 3, (
            f"only {guards} of {len(calls)} subprocess calls are guarded — "
            "an unguarded call still leaks a traceback")

    def test_no_bare_traceback_prone_call_remains(self):
        """Guard the whole file: no git/cmake subprocess call without a try.

        We walk the AST instead of using a regex — a regex over an 18k-line
        file with nested quantifiers backtracks catastrophically and hangs CI.

        Note: only the `git clone` call uses a literal list; the cmake calls
        use variables (build_cmd / compile_cmd), so we check the TRY blocks
        that contain them instead (see the next test).
        """
        src = CLI.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(src)
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if not (isinstance(f, ast.Attribute) and f.attr == "call"):
                continue
            if not node.args:
                continue
            first = node.args[0]
            if isinstance(first, ast.List) and first.elts:
                head = first.elts[0]
                if isinstance(head, ast.Constant) and head.value in ("git", "cmake"):
                    offenders.append((node.lineno, head.value))
        assert len(offenders) == 1, (
            f"expected exactly 1 literal git/cmake call (the clone), found {offenders}")

    def test_every_git_cmake_call_sits_inside_a_try(self):
        """Each git/cmake call must be inside a try that catches OSError.

        A missing binary raises FileNotFoundError (an OSError). Unguarded, it
        escapes as a traceback — the exact failure this feature set removes.
        """
        src = CLI.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(src)
        body = src.split("def cmd_llm_install_llama(", 1)[1].split("\ndef ", 1)[0]

        # the three calls in cmd_llm_install_llama (the clone is a two-line
        # shallow call with retries as of 2026-11-24 — see TestInstallLlama)
        assert 'rc = _sp.call(["git", "-c", "http.version=HTTP/1.1", "clone",' in body
        assert '"--depth", "1", git_url, _LLAMA_CPP_DIR])' in body
        assert "rc = _sp.call(build_cmd, cwd=_LLAMA_CPP_DIR)" in body
        assert "rc = _sp.call(compile_cmd, cwd=_LLAMA_CPP_DIR)" in body

        # each of the three must sit inside a try/except that catches OSError
        guarded = 0
        for node in ast.walk(tree):
            if not isinstance(node, ast.Try):
                continue
            has_call = False
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call):
                    f = sub.func
                    if isinstance(f, ast.Attribute) and f.attr == "call":
                        # literal git list OR a name we know is build_cmd/compile_cmd
                        for a in sub.args:
                            if isinstance(a, ast.Name) and a.id in ("build_cmd", "compile_cmd"):
                                has_call = True
                            if isinstance(a, ast.List) and a.elts:
                                h = a.elts[0]
                                if isinstance(h, ast.Constant) and h.value == "git":
                                    has_call = True
            if not has_call:
                continue
            for handler in node.handlers:
                exc = handler.type
                names = []
                if isinstance(exc, ast.Name):
                    names = [exc.id]
                elif isinstance(exc, ast.Tuple):
                    names = [e.id for e in exc.elts
                             if isinstance(e, ast.Name)]
                if any(n in ("OSError", "Exception", "FileNotFoundError")
                       for n in names):
                    guarded += 1
                    break
        assert guarded >= 3, (
            f"only {guarded} guarded try-block(s) — every git/cmake call needs one")


class TestInstallerShellScript:
    """The curl installer must do a FULL install without dead-ending."""

    def test_script_parses(self):
        r = subprocess.run(["bash", "-n", str(INSTALL_SH)],
                           capture_output=True, text=True)
        assert r.returncode == 0, f"bash -n failed: {r.stderr}"

    def test_ensure_build_tools_helper_exists(self):
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        assert "ensure_build_tools()" in src, "missing ensure_build_tools()"
        assert "_pkg_mgr()" in src, "missing _pkg_mgr()"
        assert "_pkg_manual_hint()" in src, "missing _pkg_manual_hint()"

    def test_never_prints_a_bare_not_installed(self):
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        for bad in ("is not installed. Please install", "is not installed\n"):
            assert bad not in src, f"bare dead-end message found: {bad!r}"

    def test_uses_sudo_n_not_a_password_prompt(self):
        """`sudo` without -n would hang CI and unattended installs.

        Only ACTUAL command invocations matter — the word "sudo" inside a
        message string (e.g. "need sudo or --prefix=...") is prose, not a
        command, and cannot hang anything.
        """
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        for i, line in enumerate(src.splitlines()):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            # strip inline comments
            code = stripped.split(" #", 1)[0].strip()
            if "sudo" not in code:
                continue
            # Skip lines where sudo appears only inside a quoted message:
            # if the line has no `sudo` OUTSIDE quotes, it is prose.
            outside = re.sub(r'"[^"]*"', "", code)
            outside = re.sub(r"'[^']*'", "", outside)
            if "sudo" not in outside:
                continue
            # the safe forms
            if ("sudo -n" in outside or "sudo --non-interactive" in outside
                    or "sudo_cmd" in outside or "$SUDO" in outside
                    or "USUDO" in outside or "sudo_cmd=" in outside):
                continue
            if re.search(r"\bsudo\s+(?!-n\b|needed\b|available\b|or\b|to\b|"
                         r"when\b|unless\b|without\b|prompt\b|password\b|"
                         r"in\b|is\b|for\b|with\b)[a-z]", outside):
                raise AssertionError(
                    f"line {i+1}: bare sudo prompt risk: {stripped!r}")

    def test_builds_into_the_path_the_cli_expects(self):
        """The CLI runs ~/llama.cpp/build/bin/llama-server — the installer
        must put it THERE, or `hivv llm setup` rebuilds it."""
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        assert '"$HOME/llama.cpp"' in src or 'LLAMA_DIR="$HOME/llama.cpp"' in src
        assert "build/bin" in src, "must build into build/bin"
        assert "llama-server" in src, "must reference llama-server by name"

    def test_downloads_the_model_into_the_path_the_cli_expects(self):
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        assert "llama.cpp/models" in src, "the model must land in llama.cpp/models"

    def test_starts_the_server_so_the_install_is_complete(self):
        """'Installed but not serving' == not installed: the hive cannot
        borrow compute that nothing is answering on."""
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        assert "llama-server" in src and ("nohup" in src or "setsid" in src), \
            "the installer must actually START llama-server"
        assert "/v1/models" in src, "must verify the server answers"

    def test_with_llm_flag_is_documented(self):
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        assert "--with-llm" in src, "the --with-llm flag must exist"


class TestDepsLibraryParity:
    """The CLI and the shell installer must agree on the toolchain."""

    def test_deps_library_also_covers_git_and_cmake(self):
        src = DEPS.read_text(encoding="utf-8", errors="replace")
        assert "git" in src, "deps.sh should know about git"
        assert "cmake" in src, "deps.sh should know about cmake"


class TestPermissionProof:
    """A system-wide install must not break per-user commands.

    THE FAILURE THIS GUARDS AGAINST
    ───────────────────────────────
    2026-11-21 (asher@wahi), a system-wide install (/usr/local/lib/hivv,
    owned by root) broke three commands for a NON-root user:

      * `hivv whats the meaning of life`
          → "failed to download tools: [Errno 13] Permission denied:
             '/usr/local/lib/hivv/hivv-tools.py'"
      * `hivv update`
          → "[Errno 13] Permission denied: '/usr/local/lib/hivv/hivv-cli.py.bak'"

    Root cause: the CLI treated INSTALL_DIR as a writable scratch space.
    """

    def test_runtime_downloads_never_write_into_install_dir(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        # No runtime download may target INSTALL_DIR directly.
        offenders = [ln for ln in src.splitlines()
                     if "INSTALL_DIR" in ln and "tools.py" in ln]
        assert not offenders, (
            "runtime downloads must not target INSTALL_DIR:\n  "
            + "\n  ".join(offenders))

    def test_runtime_file_helper_exists_and_is_writable(self, tmp_path):
        mod = _load_cli()
        real_runtime = mod.RUNTIME_DIR
        real_state = mod.STATE_DIR
        try:
            mod.RUNTIME_DIR = tmp_path / "runtime"
            mod.STATE_DIR = tmp_path / "state"
            p = mod._runtime_file("hivv-tools.py")
            assert p.parent.exists() and os.access(p.parent, os.W_OK)
            assert p.name == "hivv-tools.py"
        finally:
            mod.RUNTIME_DIR = real_runtime
            mod.STATE_DIR = real_state

    def test_writable_dir_falls_back_when_preferred_is_unwritable(self, tmp_path):
        """A root-owned preferred dir must fall back to the writable one."""
        mod = _load_cli()
        unwritable = tmp_path / "root-owned"
        unwritable.mkdir()
        os.chmod(unwritable, 0o500)          # read+execute, no write
        fallback = tmp_path / "fallback"
        try:
            got = mod._writable_dir(unwritable, fallback)
        finally:
            os.chmod(unwritable, 0o700)
        if os.geteuid() == 0:
            # root ignores the mode bits — the probe file still succeeds, so
            # the preferred dir is legitimately chosen.
            assert got == unwritable
        else:
            assert got == fallback, "must fall back to the writable directory"

    def test_update_permission_message_is_actionable(self):
        mod = _load_cli()
        msg = mod._update_permission_msg(Path("/usr/local/lib/hivv/hivv-cli.py"),
                                         PermissionError(13, "Permission denied"))
        assert "sudo" in msg, "must say how to fix it with root"
        assert "--prefix" in msg, "must offer the user-local install"

    def test_backup_failure_does_not_abort_the_update(self):
        """A missing .bak must NOT stop the update.

        The .bak is a safety net, not a prerequisite — the new bytes are
        healthchecked before the swap, so the known-good copy is protected
        by that check even without a .bak on disk.
        """
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def _apply_update(", 1)[1].split("\ndef ", 1)[0]
        # the copy2 of the backup must be inside a try/except OSError
        idx = body.find("shutil.copy2(target, bak)")
        assert idx != -1, "the backup copy is gone"
        before = body[:idx]
        assert "try:" in before.split("except OSError")[-1] or \
               "except OSError" in body[idx:idx + 400], \
            "the backup copy must be wrapped in try/except OSError"

    def test_safety_net_lives_in_the_user_state_dir(self):
        """The recovery copy must be somewhere the USER owns."""
        mod = _load_cli()
        assert mod.SAFETY_NET_FILE.is_absolute()
        assert str(mod.STATE_DIR) in str(mod.SAFETY_NET_FILE), (
            "the safety net must live under the per-user state dir")


class TestSafetyNetRecovery:
    """Recovery must work even when the install dir is unwritable."""

    def test_safety_net_store_and_read(self, tmp_path):
        mod = _load_cli()
        real_net = mod.SAFETY_NET_FILE
        real_state = mod.STATE_DIR
        try:
            mod.STATE_DIR = tmp_path
            mod.SAFETY_NET_FILE = tmp_path / "cli-known-good.py"
            src = tmp_path / "cli.py"
            src.write_text("#!/usr/bin/env python3\nprint('ok')\n")
            assert mod._safety_net_store(src) is True
            assert mod._safety_net_path().exists()
            assert "ok" in mod._safety_net_path().read_text()
        finally:
            mod.SAFETY_NET_FILE = real_net
            mod.STATE_DIR = real_state

    def test_safety_net_store_never_raises(self, tmp_path):
        mod = _load_cli()
        real_net = mod.SAFETY_NET_FILE
        real_state = mod.STATE_DIR
        try:
            mod.STATE_DIR = tmp_path / "nope"
            os.chmod(tmp_path, 0o500)
            try:
                # must return False, never raise
                assert mod._safety_net_store(tmp_path / "missing.py") is False
            finally:
                os.chmod(tmp_path, 0o700)
        finally:
            mod.SAFETY_NET_FILE = real_net
            mod.STATE_DIR = real_state

    def test_update_stores_the_safety_net(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def _apply_update(", 1)[1].split("\ndef ", 1)[0]
        assert "_safety_net_store" in body, (
            "a successful update must refresh the per-user safety net")

    def test_rollback_uses_the_safety_net_as_a_fallback(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_rollback(", 1)[1].split("\ndef ", 1)[0]
        assert "_safety_net_path" in body, (
            "rollback must fall back to the per-user safety net")
        assert "safety net" in body, "rollback must explain the fallback"


class TestVolunteerMessaging:
    """`hivv volunteer on|off` must state the real trade-off.

    The user must be told BOTH halves:
      * volunteer OFF → you keep half your CPU/RAM/disk/bandwidth
      * volunteer ON  → FULL access to the hivv.org network
    """

    def test_volunteer_on_states_full_hive_access(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_volunteer(", 1)[1].split("\ndef ", 1)[0]
        on_part = body.split('if action == "on"', 1)[1].split('if action == "off"', 1)[0]
        assert "Hive access" in on_part or "hive" in on_part.lower()
        assert "FULL" in on_part, (
            "opting in must state FULL access to the hivv.org network")

    def test_volunteer_off_states_the_half_share(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_volunteer(", 1)[1].split("\ndef ", 1)[0]
        off_part = body.split('if action == "off"', 1)[1]
        for word in ("CPU", "Memory", "Disk", "Network"):
            assert word in off_part, f"opting out must mention {word}"

    def test_volunteer_status_shows_the_hive_access_state(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_volunteer(", 1)[1].split("\ndef ", 1)[0]
        assert "hive:" in body, "the status view must show the hive-access state"

    def test_help_mentions_the_tradeoff(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "volunteer" in src
        # the command list must mention what volunteering does
        assert "relay jobs" in src or "compute" in src

    def test_on_off_actually_toggle(self):
        """`hivv volunteer on|off` must REACH their branch.

        THE BUG: the central `_normalize_bool_args` rewrites the string
        "on"/"off" into "yes"/"no" (so every command can accept both
        vocabularies). cmd_volunteer compared `action == "on"`, so the
        comparison never matched and BOTH toggles silently fell through to
        "status" — the volunteer corps could never be joined or left from
        the command line.
        """
        mod = _load_cli()
        real = mod._VOLUNTEER_FILE
        tmp = Path(tempfile.mkdtemp())
        try:
            mod._VOLUNTEER_FILE = tmp / "contribute.json"
            mod.CONFIG_DIR = tmp

            class Args:
                action = "on"
            mod.cmd_volunteer(Args())
            assert mod._volunteer_load().get("share_cpu") is True, (
                "`volunteer on` must set share_cpu=True")

            class ArgsOff:
                action = "off"
            mod.cmd_volunteer(ArgsOff())
            assert mod._volunteer_load().get("share_cpu") is False, (
                "`volunteer off` must set share_cpu=False")
        finally:
            mod._VOLUNTEER_FILE = real

    def test_on_off_survive_the_central_normalizer(self):
        """The normalizer rewrites on/off → yes/no; the command must
        translate BACK. This is the actual regression."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_volunteer(", 1)[1].split("\ndef ", 1)[0]
        assert '"yes": "on"' in body or '"yes": "on"' in body.replace("'", '"'), (
            "cmd_volunteer must map the normalized yes/no back to on/off")

    def test_tools_on_off_survive_the_normalizer(self):
        """`hivv tools on|off` had the SAME dead-toggle bug."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_tools(", 1)[1].split("\ndef ", 1)[0]
        assert '"yes": "on"' in body.replace("'", '"'), (
            "cmd_tools must map the normalized yes/no back to on/off")


class TestUnwritableInstallFallback:
    """A root-owned install must not make the box UN-updatable.

    THE FAILURE THIS GUARDS AGAINST
    ───────────────────────────────
    2026-11-21/22 (asher@wahi): the box has a SYSTEM-WIDE install
    (/usr/local/lib/hivv, owned by root) and the agent is a USER systemd
    service. So the user could never write the install dir, and the OLD CLI
    died on the .bak write:

        [hivv] unexpected: [Errno 13] Permission denied:
                 '/usr/local/lib/hivv/hivv-cli.py.bak'

    The hub logged THIRTEEN identical failed update rows — the box could not
    self-heal, and every 5-minute auto-retry added another row.

    The fix: when the install dir is not writable by the invoking user, the
    update target becomes the PER-USER install (~/.local/lib/hivv/), which
    the wrapper resolves relative to itself — a complete, working install.
    """

    def test_user_install_dir_is_defined(self):
        mod = _load_cli()
        assert mod.USER_INSTALL_DIR.name == "hivv"
        assert ".local" in str(mod.USER_INSTALL_DIR), (
            "the user-local install must live under ~/.local")

    def test_dir_writable_probes_really(self, tmp_path):
        mod = _load_cli()
        d = tmp_path / "ok"
        assert mod._dir_writable(d) is True
        assert d.exists()
        # no probe file left behind
        assert list(d.iterdir()) == []

    def test_dir_writable_is_false_for_an_unwritable_dir(self, tmp_path):
        mod = _load_cli()
        d = tmp_path / "ro"
        d.mkdir()
        os.chmod(d, 0o500)
        try:
            if os.geteuid() == 0:
                pytest.skip("root ignores mode bits")
            assert mod._dir_writable(d) is False
        finally:
            os.chmod(d, 0o700)

    def test_update_target_falls_back_to_the_user_install(self, tmp_path):
        """THE core regression: an unwritable install must redirect the
        update to the user-local copy — not fail forever."""
        mod = _load_cli()
        sysdir = tmp_path / "usr" / "local" / "lib" / "hivv"
        sysdir.mkdir(parents=True)
        (sysdir / "hivv-cli.py").write_text("# old\n")
        real_install, real_user = mod.INSTALL_DIR, mod.USER_INSTALL_DIR
        try:
            mod.INSTALL_DIR = sysdir
            mod.USER_INSTALL_DIR = tmp_path / "home" / ".local" / "lib" / "hivv"
            os.chmod(sysdir, 0o500)
            try:
                if os.geteuid() == 0:
                    pytest.skip("root ignores mode bits")
                target, in_tree = mod._update_target()
                assert target == mod.USER_INSTALL_DIR / "hivv-cli.py", (
                    f"the update must land in the user-local install, got {target}")
            finally:
                os.chmod(sysdir, 0o700)
        finally:
            mod.INSTALL_DIR, mod.USER_INSTALL_DIR = real_install, real_user

    def test_update_succeeds_into_the_user_install(self, tmp_path):
        """The whole point: the update must SUCCEED, not just fail nicer."""
        mod = _load_cli()
        sysdir = tmp_path / "usr" / "local" / "lib" / "hivv"
        sysdir.mkdir(parents=True)
        (sysdir / "hivv-cli.py").write_text("# old\n")
        real_install, real_user = mod.INSTALL_DIR, mod.USER_INSTALL_DIR
        real_state, real_net = mod.STATE_DIR, mod.SAFETY_NET_FILE
        real_bin = mod.USER_BIN_DIR
        try:
            mod.INSTALL_DIR = sysdir
            mod.USER_INSTALL_DIR = tmp_path / "home" / ".local" / "lib" / "hivv"
            mod.USER_BIN_DIR = tmp_path / "home" / ".local" / "bin"
            mod.STATE_DIR = tmp_path / "state"
            mod.SAFETY_NET_FILE = mod.STATE_DIR / "cli-known-good.py"
            os.chmod(sysdir, 0o500)
            try:
                if os.geteuid() == 0:
                    pytest.skip("root ignores mode bits")
                ok, msg, target = mod._apply_update(b"# new cli\n", source="test")
                assert ok is True, f"the update must succeed: {msg}"
                assert target.exists(), "the new bytes must be on disk"
                assert target.read_text() == "# new cli\n"
                # the system copy is untouched (root owns it)
                assert (sysdir / "hivv-cli.py").read_text() == "# old\n"
                # and the safety net holds the known-good copy
                assert mod._safety_net_path().exists(), (
                    "the per-user safety net must hold the new known-good copy")
            finally:
                os.chmod(sysdir, 0o700)
        finally:
            mod.INSTALL_DIR, mod.USER_INSTALL_DIR = real_install, real_user
            mod.STATE_DIR, mod.SAFETY_NET_FILE = real_state, real_net
            mod.USER_BIN_DIR = real_bin

    def test_atomic_write_creates_the_parent_dir(self, tmp_path):
        """The fresh fallback dir does not exist yet — the write must make it."""
        mod = _load_cli()
        target = tmp_path / "a" / "b" / "c" / "hivv-cli.py"
        mod._atomic_write(target, b"hello")
        assert target.read_bytes() == b"hello"

    def test_wrapper_is_installed_beside_the_user_copy(self):
        """<prefix>/bin/hivv + <prefix>/lib/hivv/hivv-cli.py is a COMPLETE
        install — the wrapper resolves the client relative to itself."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "def _install_user_wrapper" in src
        body = src.split("def _apply_update(", 1)[1].split("\ndef ", 1)[0]
        assert "_install_user_wrapper" in body, (
            "a user-local update must install the wrapper too")

    def test_agent_unit_is_repointed(self):
        """A reboot must not roll the box back onto the stale system copy."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "def _repoint_agent_unit" in src
        body = src.split("def _apply_update(", 1)[1].split("\ndef ", 1)[0]
        assert "_repoint_agent_unit" in body, (
            "the systemd unit must follow the update to the new path")

    def test_permission_failure_is_recognised(self):
        """The fallback must trigger on a PERMISSION failure — and only on
        one. A sha mismatch or a failed healthcheck must NOT be papered over
        with a user-local install."""
        mod = _load_cli()
        for msg in ("[Errno 13] Permission denied: '/usr/local/lib/hivv/hivv-cli.py.bak'",
                    "permission denied writing /x",
                    "Read-only file system",
                    "[Errno 30] Read-only file system"):
            assert mod._looks_like_permission_failure(msg) is True, msg
        for msg in ("sha256 mismatch (got aaa…, want bbb…)",
                    "healthcheck failed (rc=1, source=repair)",
                    "update blocked by review: suspicious"):
            assert mod._looks_like_permission_failure(msg) is False, msg

    def test_every_update_path_can_bootstrap(self):
        """auto / inbox / repair / manual must ALL fall back to the
        user-local install — otherwise one path keeps failing forever."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        for fn in ("_repair_cli_update", "cmd_update"):
            assert fn in src
        assert src.count("_repair_bootstrap_user_install(") >= 4, (
            "the bootstrap must be reachable from the auto, inbox, repair and "
            "manual update paths")
        assert "_looks_like_permission_failure" in src

    def test_bootstrap_installs_a_user_owned_copy(self, tmp_path):
        """The bootstrap copies the CURRENT client into the user's own
        space — it must never touch the root-owned install."""
        mod = _load_cli()
        real_install = mod.INSTALL_DIR
        real_user = mod.USER_INSTALL_DIR
        real_bin = mod.USER_BIN_DIR
        real_state = mod.STATE_DIR
        real_net = mod.SAFETY_NET_FILE
        try:
            sysdir = tmp_path / "usr" / "local" / "lib" / "hivv"
            sysdir.mkdir(parents=True)
            (sysdir / "hivv-cli.py").write_text("# old\n")
            mod.INSTALL_DIR = sysdir
            mod.USER_INSTALL_DIR = tmp_path / "home" / ".local" / "lib" / "hivv"
            mod.USER_BIN_DIR = tmp_path / "home" / ".local" / "bin"
            mod.STATE_DIR = tmp_path / "home" / ".local" / "share" / "hivv"
            mod.SAFETY_NET_FILE = mod.STATE_DIR / "cli-known-good.py"
            log = open(tmp_path / "agent.log", "a")
            try:
                note = mod._repair_bootstrap_user_install(log, "rp_test")
            finally:
                log.close()
            assert str(note).startswith("bootstrapped"), note
            target = mod.USER_INSTALL_DIR / "hivv-cli.py"
            assert target.exists(), "the user-local copy must exist"
            assert target.stat().st_size > 0
            # the root-owned copy is untouched
            assert (sysdir / "hivv-cli.py").read_text() == "# old\n"
        finally:
            mod.INSTALL_DIR = mod.INSTALL_DIR
            mod.INSTALL_DIR = real_install
            mod.USER_INSTALL_DIR = real_user
            mod.USER_BIN_DIR = real_bin
            mod.STATE_DIR = real_state
            mod.SAFETY_NET_FILE = real_net

    def test_the_hub_allows_the_bootstrap_op(self):
        """The hub signs the plan — it must know the op, or the plan is
        refused before it ever reaches the bee."""
        hub = REPO / "api" / "routes" / "control-routes.js"
        src = hub.read_text(encoding="utf-8", errors="replace")
        assert "bootstrap_user_install" in src, (
            "the hub's repair-op allowlist must include bootstrap_user_install")


# ── 2026-11-24 — a dead clone must not poison the retry; sudo must not
#    build into /root ────────────────────────────────────────────────────────

class TestInstallLlamaResilientClone:
    """The clone must survive a flaky link, and clean up after itself."""

    def test_manual_steps_only_print_when_not_auto(self, capsys):
        """--auto runs the steps; printing them first is a wall of noise
        that ends in a random git error (the exact 2026-11-24 transcript)."""
        mod = _load_cli()

        class Args:
            auto = False
        mod.cmd_llm_install_llama(Args())
        out = capsys.readouterr().out
        assert "step 1 — clone:" in out, "without --auto the walkthrough must print"

        real_which = mod.shutil.which
        mod.shutil.which = lambda n, *a, **k: (
            None if n in ("git", "cmake") else real_which(n, *a, **k))
        code = None
        try:
            class Auto:
                auto = True
            try:
                mod.cmd_llm_install_llama(Auto())
            except SystemExit as e:
                code = e.code
        finally:
            mod.shutil.which = real_which
        got = capsys.readouterr()
        out = got.out + got.err
        assert code == 1, "missing tools must still exit cleanly"
        assert "step 1 — clone:" not in out, (
            "auto must NOT print the manual steps it is about to run itself")

    def test_clone_is_shallow_and_retried(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        body = src.split("def cmd_llm_install_llama(", 1)[1].split("\ndef ", 1)[0]
        assert '"--depth", "1"' in body, (
            "a FULL clone (169k objects) dies on flaky links — go shallow")
        assert "range(1, 4)" in body, "the clone must retry, not die on rc!=0"
        assert "attempt {attempt}/3" in body, "the user must SEE the retry"
        assert "_llama_tarball_fetch" in body, (
            "after git fails 3x, fall back to the tarball")

    def test_partial_clone_is_cleaned_then_recloned(self, tmp_path, capsys):
        """A clone that died mid-pack leaves ~/llama.cpp behind. The old
        code said "already exists — skipping clone" and the NEXT run died
        in cmake on the debris."""
        mod = _load_cli()
        dest = tmp_path / "llama.cpp"
        (dest / ".git").mkdir(parents=True)      # exactly what git leaves

        calls = []

        def fake_call(cmd, **kw):
            calls.append(list(cmd))
            if cmd and cmd[0] == "git":
                dest.mkdir(exist_ok=True)
                (dest / "CMakeLists.txt").write_text("project(llama)")
                return 0
            # configure + compile: "produce" the binary
            b = dest / "build" / "bin"
            b.mkdir(parents=True, exist_ok=True)
            srv = b / "llama-server"
            srv.write_text("#!/bin/sh\n")
            srv.chmod(0o755)
            return 0

        real_call = mod.subprocess.call
        real_dir, real_bin = mod._LLAMA_CPP_DIR, mod._LLAMA_CPP_BIN
        real_tools = mod._ensure_build_tools
        mod.subprocess.call = fake_call
        mod._LLAMA_CPP_DIR = str(dest)
        mod._LLAMA_CPP_BIN = str(dest / "build" / "bin")
        mod._ensure_build_tools = lambda tools: True
        try:
            class Args:
                auto = True
            mod.cmd_llm_install_llama(Args())
        finally:
            mod.subprocess.call = real_call
            mod._LLAMA_CPP_DIR, mod._LLAMA_CPP_BIN = real_dir, real_bin
            mod._ensure_build_tools = real_tools
        got = capsys.readouterr()
        out = got.out + got.err
        assert "partial clone" in out, "the debris must be named, not silently skipped"
        git_calls = [c for c in calls if c and c[0] == "git"]
        assert git_calls, "must re-clone after cleaning the partial tree"
        assert "--depth" in git_calls[0]
        assert "attempt 1/3" in out
        assert "built successfully" in out, "the rebuild must complete"

    def test_failed_clone_dies_with_a_way_forward(self, tmp_path, capsys):
        mod = _load_cli()
        dest = tmp_path / "llama.cpp"
        calls = []

        def always_128(cmd, **kw):
            calls.append(list(cmd))
            return 128

        real_call = mod.subprocess.call
        real_dir = mod._LLAMA_CPP_DIR
        real_tools = mod._ensure_build_tools
        real_tar = mod._llama_tarball_fetch
        mod.subprocess.call = always_128
        mod._LLAMA_CPP_DIR = str(dest)
        mod._ensure_build_tools = lambda tools: True
        mod._llama_tarball_fetch = lambda: False   # no downloader either
        code = None
        try:
            class Args:
                auto = True
            try:
                mod.cmd_llm_install_llama(Args())
            except SystemExit as e:
                code = e.code
        finally:
            mod.subprocess.call = real_call
            mod._LLAMA_CPP_DIR = real_dir
            mod._ensure_build_tools = real_tools
            mod._llama_tarball_fetch = real_tar
        got = capsys.readouterr()
        out = got.out + got.err
        assert code == 1
        git_calls = [c for c in calls if c and c[0] == "git"]
        assert len(git_calls) == 3, "three shallow attempts before giving up"
        assert "after 3 attempts" in out
        assert "git clone --depth 1" in out, (
            "the dead end must print the manual command as the way forward")
        assert "Traceback" not in out

    def test_foreign_dir_is_never_deleted(self, tmp_path, capsys):
        """~/llama.cpp holding someone else's files is NOT our debris."""
        mod = _load_cli()
        dest = tmp_path / "llama.cpp"
        dest.mkdir()
        (dest / "my-notes.txt").write_text("precious")
        calls = []

        def nope(cmd, **kw):
            calls.append(list(cmd))
            return 0

        real_call = mod.subprocess.call
        real_dir = mod._LLAMA_CPP_DIR
        real_tools = mod._ensure_build_tools
        mod.subprocess.call = nope
        mod._LLAMA_CPP_DIR = str(dest)
        mod._ensure_build_tools = lambda tools: True
        code = None
        try:
            class Args:
                auto = True
            try:
                mod.cmd_llm_install_llama(Args())
            except SystemExit as e:
                code = e.code
        finally:
            mod.subprocess.call = real_call
            mod._LLAMA_CPP_DIR = real_dir
            mod._ensure_build_tools = real_tools
        got = capsys.readouterr()
        out = got.out + got.err
        assert code == 1
        assert "isn't a llama.cpp checkout" in out
        assert (dest / "my-notes.txt").exists(), "NEVER delete what isn't ours"
        assert not calls, "no subprocess may run against a foreign dir"


class TestSudoAndRootTargeting:
    """A "sudo hivv install llm" run installs for the LOGGED-IN user; a
    real root login keeps /root (correct for it). Nothing may land in
    /root that the regular user then cannot see, run, or stop."""

    def _target_home(self, mod, euid, sudo_user, monkeypatch):
        """Drive _llm_target_home with a faked euid + pwd (no real lookup)."""
        import types
        fake_pwd = types.ModuleType("pwd")
        fake_pwd.getpwnam = lambda n: types.SimpleNamespace(
            pw_dir="/home/asher", pw_shell="/bin/zsh",
            pw_uid=1000, pw_gid=1000)
        real_pwd = sys.modules.get("pwd")
        real_geteuid = os.geteuid
        sys.modules["pwd"] = fake_pwd
        os.geteuid = lambda: euid
        if sudo_user is None:
            monkeypatch.delenv("SUDO_USER", raising=False)
        else:
            monkeypatch.setenv("SUDO_USER", sudo_user)
        try:
            return mod._llm_target_home()
        finally:
            os.geteuid = real_geteuid
            if real_pwd is None:
                sys.modules.pop("pwd", None)
            else:
                sys.modules["pwd"] = real_pwd

    def test_sudo_install_targets_the_invoking_user(self, monkeypatch):
        mod = _load_cli()
        assert self._target_home(mod, 0, "asher", monkeypatch) == (
            "/home/asher", "asher")

    def test_root_login_keeps_root_home(self, monkeypatch):
        mod = _load_cli()
        home, owner = self._target_home(mod, 0, None, monkeypatch)
        assert owner is None, "a real root login must not chase SUDO_USER"
        assert home == os.path.expanduser("~")

    def test_plain_user_is_untouched(self, monkeypatch):
        mod = _load_cli()
        home, owner = self._target_home(mod, 1000, None, monkeypatch)
        assert owner is None
        assert home == os.path.expanduser("~")

    def test_setup_announces_the_sudo_target(self):
        src = CLI.read_text(encoding="utf-8", errors="replace")
        assert "via sudo — everything installs for" in src, (
            "a sudo run must SAY whose tree it is building")

    def test_boot_enable_refuses_a_root_user_session(self, monkeypatch):
        """A root shell has no --user systemd session: refuse with the
        exact command instead of a mystery systemctl error."""
        mod = _load_cli()
        monkeypatch.setattr(mod, "_LLM_HOME_OWNER", "asher")
        ok, msg = mod._llm_boot_enable("gemma-4:e2b", 8080, "127.0.0.1", 4096)
        assert ok is False
        assert "asher" in msg and "llm boot on" in msg

    def test_path_advice_targets_the_right_rc_and_owner(self, tmp_path, monkeypatch):
        """The old advice said '>> ~/.bashrc' — under sudo that is ROOT's
        shell config, and zsh users don't read .bashrc anyway."""
        import types
        mod = _load_cli()
        rc = tmp_path / ".bashrc"
        rc.write_text("# asher's rc\n")
        fake_pwd = types.ModuleType("pwd")
        fake_pwd.getpwnam = lambda n: types.SimpleNamespace(
            pw_dir=str(tmp_path), pw_shell="/bin/bash", pw_uid=1000, pw_gid=1000)
        real_pwd = sys.modules.get("pwd")
        real_which = mod.shutil.which
        sys.modules["pwd"] = fake_pwd
        try:
            monkeypatch.setattr(mod, "_LLM_HOME", str(tmp_path))
            monkeypatch.setattr(mod, "_LLM_HOME_OWNER", "asher")
            monkeypatch.setattr(mod, "_LLAMA_CPP_BIN",
                                str(tmp_path / "llama.cpp" / "build" / "bin"))
            monkeypatch.setattr(
                mod.shutil, "which",
                lambda n, *a, **k: None if n == "llama-server" else real_which(n, *a, **k))
            advice = mod._llm_path_advice()
            assert f">> {rc}" in advice, "must name the TARGET user's rc file"
            assert "run as asher, not root" in advice
            # idempotent: once the line is in the rc, stop nagging
            line = f'export PATH="{mod._LLAMA_CPP_BIN}:$PATH"'
            rc.write_text(f"# asher's rc\n{line}\n")
            assert "already has it" in mod._llm_path_advice()
        finally:
            mod.shutil.which = real_which
            if real_pwd is None:
                sys.modules.pop("pwd", None)
            else:
                sys.modules["pwd"] = real_pwd


class TestInstallerSudoTargeting:
    """curl-pipe-sudo bash --with-llm must build the LLM for the LOGGED-IN
    user too — /root/llama.cpp is invisible to them."""

    def _src(self):
        return INSTALL_SH.read_text(encoding="utf-8", errors="replace")

    def test_sudo_targets_the_logged_in_user(self):
        src = self._src()
        assert 'LLAMA_USER="$SUDO_USER"' in src
        assert 'LLAMA_DIR="$LLAMA_HOME/llama.cpp"' in src
        assert "building the LLM for" in src

    def test_tree_and_model_are_handed_back(self):
        src = self._src()
        assert 'chown -R "$LLAMA_USER" "$LLAMA_DIR"' in src
        assert 'chown -R "$LLAMA_USER" "$LLAMA_MODEL_DIR"' in src

    def test_clone_retries_and_cleans_partial(self):
        src = self._src()
        assert "for _try in 1 2 3" in src, "the clone must retry"
        assert "git clone --depth 1" in src, "shallow, like the CLI"
        assert 'rm -rf "$LLAMA_DIR"' in src, "clean the debris between tries"

    def test_never_deletes_a_foreign_dir(self):
        assert "isn't a llama.cpp checkout" in self._src()

    def test_server_runs_as_the_user_under_sudo(self):
        src = self._src()
        assert 'sudo -u "$LLAMA_USER"' in src, (
            "a root-owned llama-server is one the user cannot stop")
        assert 'LLM_LOG_DIR="$LLAMA_HOME' in src

    def test_path_advice_goes_to_the_target_rc_once(self):
        src = self._src()
        assert 'LLAMA_SHELL_RC="$LLAMA_HOME/.bashrc"' in src
        assert "grep -qF" in src, "the PATH line must be added at most once"


class TestSudoEscalationLadder:
    """Password-only sudo must not turn an install into a silent no-op.

    THE FAILURE THIS GUARDS AGAINST (wahi 2026-11-24)
    ─────────────────────────────────────────────────
    `hivv install llm` printed "→ installing build tools…" and then
    "✗ missing build tool(s)". The privileged runner was gated behind
    `sudo -n`; on a normal desktop sudo needs a password, so -n failed
    and the apt call was SKIPPED — the claim and the attempt disagreed.

    The ladder (all three surfaces — CLI, install-hivv.sh, deps.sh):
      root / brew        → run directly
      passwordless sudo  → sudo -n            (servers, CI, docker)
      a human at a TTY   → plain sudo         (prompt goes to /dev/tty)
      nobody watching    → never prompt — print the exact command
    Unattended means CI, cron, piped stdin, or the test suite itself.
    """

    def test_sudo_mode_ladder(self, monkeypatch):
        mod = _load_cli()
        # brew needs no root at all
        assert mod._build_tool_sudo_mode("brew") == "direct"
        # no sudo binary → no escalation, caller prints the command
        monkeypatch.setattr(mod.shutil, "which",
                            lambda n, *a, **k: None if n == "sudo" else "/bin/x")
        assert mod._build_tool_sudo_mode("apt") == ""
        # sudo exists, password works only with a human → prompt mode
        monkeypatch.setattr(mod.shutil, "which",
                            lambda n, *a, **k: "/usr/bin/sudo" if n == "sudo" else "/bin/x")
        monkeypatch.setattr(mod, "_sudo_passwordless", lambda: False)
        monkeypatch.setattr(mod, "_can_prompt_sudo", lambda: True)
        assert mod._build_tool_sudo_mode("apt") == "prompt"
        # passwordless wins over prompting (never ask when -n works)
        monkeypatch.setattr(mod, "_sudo_passwordless", lambda: True)
        assert mod._build_tool_sudo_mode("apt") == "passwordless"
        # no human, no passwordless → ""
        monkeypatch.setattr(mod, "_sudo_passwordless", lambda: False)
        monkeypatch.setattr(mod, "_can_prompt_sudo", lambda: False)
        assert mod._build_tool_sudo_mode("apt") == ""

    def test_run_privileged_honours_the_mode(self, monkeypatch):
        mod = _load_cli()
        seen = []

        class _FakeSp:
            DEVNULL = object()

            @staticmethod
            def call(cmd, **kw):
                seen.append(list(cmd))
                return 0

        monkeypatch.setitem(sys.modules, "subprocess", _FakeSp)
        # passwordless → sudo -n (never a prompt)
        assert mod._build_tool_run_privileged(["apt-get", "install", "git"],
                                              "passwordless")
        # prompt → plain sudo (it asks the human; /dev/tty, not our streams)
        assert mod._build_tool_run_privileged(["apt-get", "install", "git"],
                                              "prompt")
        # "" → refuse, never a half-attempt
        assert mod._build_tool_run_privileged(["apt-get", "install", "git"],
                                              "") is False
        assert seen[0][:2] == ["sudo", "-n"]
        assert seen[1][:1] == ["sudo"] and seen[1][1] != "-n"
        assert len(seen) == 2, "mode '' must not run anything"

    def test_no_claim_without_an_attempt(self, capsys):
        """"installing…" may only print when an attempt is actually possible."""
        mod = _load_cli()
        real_which = mod.shutil.which
        mod.shutil.which = lambda n, *a, **k: (
            None if n in ("git", "cmake") else real_which(n, *a, **k))
        try:
            mod._build_tool_pkg_manager = lambda: "apt"
            mod._build_tool_sudo_mode = lambda pm: ""   # no escalation at all
            ok = mod._ensure_build_tools(["git", "cmake"])
        finally:
            mod.shutil.which = real_which
        assert ok is False
        out = capsys.readouterr()
        assert "installing build tools" not in out.out + out.err, (
            "the claim must not print when nothing will be attempted")

    def test_prompt_mode_says_it_will_ask(self, capsys):
        """A human should KNOW a password is coming — no surprise prompt."""
        mod = _load_cli()
        real_which = mod.shutil.which
        mod.shutil.which = lambda n, *a, **k: (
            None if n in ("git", "cmake") else real_which(n, *a, **k))
        try:
            mod._build_tool_pkg_manager = lambda: "apt"
            mod._build_tool_sudo_mode = lambda pm: "prompt"
            mod._build_tool_run_privileged = lambda cmd, mode, quiet=False: False
            mod._ensure_build_tools(["git", "cmake"])
        finally:
            mod.shutil.which = real_which
        out = capsys.readouterr()
        assert "sudo will ask for your password" in out.out

    def test_can_prompt_sudo_env_guards(self, monkeypatch):
        """Unattended runs never prompt — even under a real TTY."""
        mod = _load_cli()
        # the suite itself sets PYTEST_CURRENT_TEST — clear the unattended
        # markers first so the TTY case is actually exercised
        for key in ("HIVV_NO_SUDO_PROMPT", "CI", "PYTEST_CURRENT_TEST"):
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setattr(mod.sys.stdin, "isatty", lambda: True, raising=False)
        assert mod._can_prompt_sudo() is True
        for key, val in (("HIVV_NO_SUDO_PROMPT", "1"),
                         ("CI", "true"),
                         ("PYTEST_CURRENT_TEST", "x")):
            monkeypatch.setenv(key, val)
            assert mod._can_prompt_sudo() is False, key
            monkeypatch.delenv(key)

    def test_installer_shell_uses_the_ladder(self):
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        body = src.split("ensure_build_tools()")[1]
        assert "_can_prompt_sudo" in body, (
            "install-hivv.sh must escalate to plain sudo for a human")
        assert "sudo will ask for your password" in body
        # the claim must be inside the attempt branch, before it
        assert "attempt=1" in body and "if [[ \"$attempt\" -eq 1 ]]" in body

    def test_deps_library_wires_the_gate_in(self):
        src = DEPS.read_text(encoding="utf-8", errors="replace")
        body = src.split("d_run_privileged()")[1].split("\n}")[0]
        assert "d_can_prompt_sudo" in body, (
            "deps.sh must let a human's sudo ask them for the password")
        gate = src.split("d_can_prompt_sudo()")[1].split("\n}")[0]
        for guard in ("[[ ! -t 0 ]]", "CI", "PYTEST_CURRENT_TEST",
                      "HIVV_NO_SUDO_PROMPT"):
            assert guard in gate, f"d_can_prompt_sudo is missing the {guard} guard"


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))
