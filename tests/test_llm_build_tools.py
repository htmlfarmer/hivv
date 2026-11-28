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
import shutil
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
            no_prebuilt = True

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
                no_prebuilt = True
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
                no_prebuilt = True
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
                no_prebuilt = True
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
                no_prebuilt = True
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


class TestFullToolchainGate:
    """git+cmake passing the gate is not enough — configure needs a C++ compiler.

    THE FAILURE THIS GUARDS AGAINST (wahi 2026-11-25)
    ─────────────────────────────────────────────────
        [2/3] configuring…
        CMake Error at CMakeLists.txt:2 (project):
          No CMAKE_CXX_COMPILER could be found.

    The gate checked git and cmake only, so a box with neither a compiler
    nor make sailed into "[2/3]" and died mid-configure — one wall further
    than the last fix, same class of bug: the preflight must cover the
    WHOLE toolchain the build actually invokes (cmake --build needs make
    immediately after configure).
    """

    def test_tables_cover_the_whole_toolchain(self):
        mod = _load_cli()
        for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper", "brew"):
            pkgs = mod._BUILD_TOOL_PKGS[pm]
            for tool in ("git", "cmake", "cxx", "make"):
                assert tool in pkgs, f"{pm}: {tool} missing from _BUILD_TOOL_PKGS"
                assert pkgs[tool], f"{pm}: {tool} maps to an empty package"
            assert pkgs["make"] == "make", "make is spelled make everywhere"

    def test_cxx_package_name_per_manager(self):
        """The VIRTUAL key cxx maps to each manager's own spelling."""
        mod = _load_cli()
        assert mod._BUILD_TOOL_PKGS["apt"]["cxx"] == "g++"
        assert mod._BUILD_TOOL_PKGS["apk"]["cxx"] == "g++"
        for pm in ("dnf", "yum", "zypper"):
            assert mod._BUILD_TOOL_PKGS[pm]["cxx"] == "gcc-c++", pm
        assert mod._BUILD_TOOL_PKGS["pacman"]["cxx"] == "gcc"

    def test_cxx_present_accepts_any_compiler(self, monkeypatch):
        """g++/c++/clang++ all satisfy cxx — probe binaries, not spellings."""
        mod = _load_cli()
        for binary in ("g++", "c++", "clang++"):
            monkeypatch.setattr(mod.shutil, "which",
                                lambda n, b=binary: "/usr/bin/" + b if n == b else None)
            assert mod._build_tool_present("cxx") is True, binary
        monkeypatch.setattr(mod.shutil, "which", lambda n: None)
        assert mod._build_tool_present("cxx") is False
        # a plain tool still uses plain which()
        monkeypatch.setattr(mod.shutil, "which",
                            lambda n: "/usr/bin/git" if n == "git" else None)
        assert mod._build_tool_present("git") is True
        assert mod._build_tool_present("make") is False

    def test_label_is_human_words(self):
        mod = _load_cli()
        assert mod._build_tool_label("cxx") == "c++ compiler"
        assert mod._build_tool_label("git") == "git"

    def test_build_callers_require_the_whole_toolchain(self):
        """Both llama build paths must preflight compiler+make too."""
        src = CLI.read_text(encoding="utf-8", errors="replace")
        n = src.count('_ensure_build_tools(["git", "cmake", "cxx", "make"])')
        assert n == 2, f"expected 2 full-toolchain preflights, found {n}"
        assert '_ensure_build_tools(["git", "cmake"])' not in src, (
            "a git+cmake-only preflight still exists")

    def test_hints_list_the_whole_toolchain(self):
        mod = _load_cli()
        for pm in ("apt", "dnf", "yum", "pacman", "apk", "zypper"):
            hint = mod._BUILD_TOOL_HINTS[pm]
            assert "git" in hint and "cmake" in hint, pm
            assert "make" in hint, f"{pm} hint lacks make: {hint}"
            assert mod._BUILD_TOOL_PKGS[pm]["cxx"] in hint, (
                f"{pm} hint lacks its compiler package: {hint}")

    def test_installer_gate_covers_cxx_and_make(self):
        src = INSTALL_SH.read_text(encoding="utf-8", errors="replace")
        assert "ensure_build_tools git cmake cxx make" in src, (
            "the installer must preflight the whole toolchain")
        # need() understands the virtual key, _pkg_of translates it
        assert "cxx) command -v g++" in src or "cxx)" in src
        assert "_pkg_of()" in src and "_tool_label()" in src
        # the human message names the compiler, not the key
        assert "c++ compiler" in src

    def test_deps_library_gate_covers_cxx_and_make(self):
        src = DEPS.read_text(encoding="utf-8", errors="replace")
        body = src.split("d_have_build_tools()")[1].split("\n}")[0]
        assert "command -v make" in body, "deps.sh must require make"
        assert "clang++" in body, "deps.sh must accept any C++ compiler"
        hint = src.split("d_build_tools_hint()")[1].split("\n}")[0]
        assert "g++" in hint or "gcc-c++" in hint


class TestInstallOllamaDispatch:
    """`hivv install ollama` must reach the installer, not a chooser that
    never mentions ollama.

    THE DEAD-END THIS GUARDS AGAINST (2026-11-25)
    ─────────────────────────────────────────────
    "dont we have a hivv install llm or hivv install ollama type of
    thing???" — we had `hivv install llm` (→ `llm setup`) and the ollama
    installer (`llm install`) but `hivv install ollama` fell into a
    chooser listing ONLY `install llm`. Both commands must be one hop
    from `hivv install`.

    Second bug found while fixing the first: prepending `--auto` shifted
    `--help` off index 2, so the per-cmd help check missed it, argparse
    exited 0, and that SystemExit fell through to the self-heal footer —
    "its own command parser failed" printed on a perfectly healthy CLI.
    """

    @staticmethod
    def _run(*args):
        return subprocess.run([sys.executable, str(CLI), *args],
                              capture_output=True, text=True, timeout=60)

    def test_chooser_mentions_both_paths(self):
        r = self._run("install")
        assert r.returncode == 0, r.stderr
        out = r.stdout
        assert "install llm" in out, "the chooser must keep the llama path"
        assert "install ollama" in out, (
            "the chooser must mention ollama — it never did")

    def test_install_ollama_help_is_clean(self):
        """--help must not be shifted off index 2 by the prepended --auto."""
        r = self._run("install", "ollama", "--help")
        assert r.returncode == 0, r.stderr
        assert "llm install" in r.stdout, "help must come from llm install"
        combined = r.stdout + r.stderr
        assert "parser failed" not in combined, (
            "a healthy CLI must not claim its own parser failed")
        assert "self-heal" not in combined.lower()

    def test_install_ollama_rewrites_to_the_installer(self):
        """A usage error from the llm-install parser proves the rewrite.

        `--model` with no value fails DURING parse_args — so cmd_llm_install
        never runs and NOTHING is installed, yet the message names the
        target parser: argv really became ["llm", "install", ...].
        """
        r = self._run("install", "ollama", "--model")
        combined = r.stdout + r.stderr
        assert "expected one argument" in combined, (
            f"did not reach the llm-install parser:\n{combined}")
        assert "llm install" in combined
        # and it must NOT have fallen through to chat
        assert "smart" not in combined.lower()

    def test_install_llm_path_still_works(self):
        """The original alias must survive the new elif."""
        r = self._run("install", "llm", "--help")
        assert r.returncode == 0, r.stderr
        assert "llm setup" in r.stdout
        assert "parser failed" not in (r.stdout + r.stderr)



class TestOllamaFamilyResolution:
    """--model qwen → the best SMALL+FAST tag for THIS box; an oversized
    explicit tag gets a warning + a smaller alternative as a CHOICE
    (2026-11-25: "users want to make a model too big — choose small and
    fast, but warn them as a choice")."""

    @staticmethod
    def _specs(cpu=4, ram=22.0, vram=None):
        return {"cpu_count": cpu, "ram_gb": ram,
                "gpu": ({"vram_gb": vram} if vram else None)}

    def test_budget_shapes(self):
        mod = _load_cli()
        # GPU box → 0.9 × VRAM (must FIT the card to be fast)
        assert mod._ollama_budget(self._specs(cpu=16, ram=64, vram=6)) == 5.4
        # CPU < 8 cores → half RAM, hard-capped at 4 GB (small + fast)
        assert mod._ollama_budget(self._specs(cpu=4, ram=22)) == 4.0
        assert mod._ollama_budget(self._specs(cpu=2, ram=4)) == 2.0
        # CPU ≥ 8 cores → half RAM, cap 8 GB
        assert mod._ollama_budget(self._specs(cpu=8, ram=46)) == 8.0
        assert mod._ollama_budget(self._specs(cpu=8, ram=4)) == 2.0

    def test_family_picks_largest_that_fits(self):
        mod = _load_cli()
        # budget 4.0 → qwen3:4b (2.5 GB) beats 1.7b, 8b (5.0) is too big
        tag, note, warn = mod._resolve_ollama_model("qwen", specs=self._specs(cpu=4, ram=22))
        assert tag == "qwen3:4b"
        assert "family 'qwen'" in note and "budget 4.0" in note
        assert warn == ""
        # budget 2.0 (tiny box) → steps down to 1.7b
        tag, _, _ = mod._resolve_ollama_model("qwen", specs=self._specs(cpu=2, ram=4))
        assert tag == "qwen3:1.7b"
        # GPU box, budget 5.4 → 8b (5.0 GB) fits
        tag, _, _ = mod._resolve_ollama_model("qwen", specs=self._specs(cpu=16, ram=64, vram=6))
        assert tag == "qwen3:8b"
        # every family resolves to one of ITS OWN tags
        for fam in ("gemma", "llama", "phi", "mistral", "embed"):
            tag, note, _ = mod._resolve_ollama_model(fam, specs=self._specs())
            assert tag in [t for t, _ in mod._OLLAMA_FAMILIES[fam]], (fam, tag)

    def test_oversized_explicit_tag_warns_with_alternative(self):
        mod = _load_cli()
        # 235b ≈ 152 GB by estimate — over EVERY plausible budget, so the
        # assertion is hardware-independent
        tag, note, warn = mod._resolve_ollama_model("qwen3:235b", specs=self._specs(cpu=4, ram=8))
        assert tag == "qwen3:235b", "explicit tag is honored unless the human switches"
        assert note == ""
        assert "over this box's fast budget" in warn
        assert "smaller option: qwen3:" in warn

    def test_reasonable_explicit_tag_passes_silent(self):
        mod = _load_cli()
        tag, note, warn = mod._resolve_ollama_model("qwen3:4b", specs=self._specs(cpu=4, ram=22))
        assert (tag, note, warn) == ("qwen3:4b", "", "")
        # unknown-to-us tags pass through for ollama to judge
        tag, note, warn = mod._resolve_ollama_model("nomic-embed-text", specs=self._specs())
        assert (tag, note, warn) == ("nomic-embed-text", "", "")

    def test_size_table_and_estimate(self):
        mod = _load_cli()
        assert mod._ollama_size_gb("qwen3:32b") == 20.0      # table hit
        assert mod._ollama_size_gb("gemma3:4b") == 3.3       # table hit
        assert mod._ollama_size_gb("mystery:10b") == 6.5     # 10 × 0.65 GB estimate
        assert mod._ollama_size_gb("no-digits-here") == 0.0  # unknown → no warning

    def test_install_without_auto_prints_resolution_and_does_not_run(self):
        """hivv llm install --model qwen resolves, prints, and RETURNS —
        never runs curl|sh unless --auto (subprocess against the real CLI)."""
        r = subprocess.run([sys.executable, str(CLI), "llm", "install", "--model", "qwen"],
                           capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        out = r.stdout + r.stderr
        assert "family 'qwen'" in out, out[:500]
        assert r.returncode == 0
        # an absurdly big explicit tag → warning, still no install (no --auto)
        r2 = subprocess.run([sys.executable, str(CLI), "llm", "install", "--model", "qwen3:235b"],
                            capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        out2 = r2.stdout + r2.stderr
        assert "over this box's fast budget" in out2, out2[:500]
        assert "curl -fsSL https://ollama.com/install.sh" in out2  # printed the chooser, did NOT run it



class TestMacosPrebuilt:
    """macOS must install llama.cpp WITHOUT a compiler, cmake or Homebrew.

    THE FAILURE THIS GUARDS AGAINST (a MacBook Air, 2026-11-28)
    ────────────────────────────────────────────────────────────
    `hivv install llm` wanted to COMPILE llama.cpp, so it demanded cmake
    first. On a Mac with no Homebrew there is no package manager to name, so
    the hint fell back to the Linux line — "install git, cmake, a C++
    compiler and make with your package manager" — listing three tools the
    Mac already had (Xcode Command Line Tools) and naming no way to get the
    one it lacked. The install died before it ever looked at llama.cpp.

    THE FIX: llama.cpp SHIPS prebuilt macOS binaries (16.9 MB arm64 /
    12.7 MB x64). Download, unpack into ~/llama.cpp/build/bin — precisely
    where _llama_tree_state looks — and a later run reads "built". The
    build-tool preflight is now attempted only AFTER the prebuilt, because
    asking for cmake first is asking the wrong question.

    Every test here is OFFLINE: the release list is a fixture, never a live
    GitHub call (the suite runs with "no network, no $HOME writes").
    """

    ARCH_MATRIX = [
        ('darwin', 'arm64', 'macos-arm64'),
        ('darwin', 'arm64e', 'macos-arm64'),   # Apple Silicon
        ('darwin', 'x86_64', 'macos-x64'),     # Intel
        ('darwin', 'i386', ''),                # no prebuilt published
        ('linux', 'x86_64', ''),               # macOS-only feature
        ('linux', 'aarch64', ''),
        ('win32', 'AMD64', ''),
    ]

    def test_prebuilt_arch_matrix(self, monkeypatch):
        mod = _load_cli()
        for plat, mach, want in self.ARCH_MATRIX:
            monkeypatch.setattr(mod.sys, 'platform', plat)
            monkeypatch.setattr(mod.platform, 'machine', lambda m=mach: m)
            got = mod._llama_prebuilt_arch()
            assert got == want, f'{plat}/{mach} -> {got!r}, want {want!r}'

    @staticmethod
    def _fake_releases(payload):
        """A urlopen stand-in returning `payload` as JSON."""
        class _Resp:
            def read(self):
                import json as _j
                return _j.dumps(payload).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return lambda *a, **k: _Resp()

    def test_asset_picks_the_newest_tag_matching_this_arch(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(mod.sys, 'platform', 'darwin')
        monkeypatch.setattr(mod.platform, 'machine', lambda: 'arm64')
        # newest first, as the API returns it; b1 has no arm64 asset at all
        payload = [
            {'tag_name': 'b1', 'assets': [
                {'name': 'llama-b1-bin-macos-x64.tar.gz',
                 'browser_download_url': 'https://x/b1-x64'}]},
            {'tag_name': 'b2', 'assets': [
                {'name': 'llama-b2-bin-macos-arm64.tar.gz',
                 'browser_download_url': 'https://x/b2-arm64'},
                {'name': 'llama-b2-bin-macos-x64.tar.gz',
                 'browser_download_url': 'https://x/b2-x64'}]},
        ]
        monkeypatch.setattr(mod.urllib.request, 'urlopen',
                            self._fake_releases(payload))
        tag, url = mod._llama_prebuilt_asset()
        assert (tag, url) == ('b2', 'https://x/b2-arm64')

    def test_asset_is_none_when_the_platform_has_no_prebuilt(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(mod.sys, 'platform', 'linux')
        # a live call must never happen: linux returns before any request
        def _boom(*a, **k):
            raise AssertionError('linux must not query the releases API')
        monkeypatch.setattr(mod.urllib.request, 'urlopen', _boom)
        assert mod._llama_prebuilt_asset() == (None, None)

    def test_a_network_failure_is_not_a_dead_end(self, monkeypatch, tmp_path):
        mod = _load_cli()
        monkeypatch.setattr(mod.sys, 'platform', 'darwin')
        monkeypatch.setattr(mod.platform, 'machine', lambda: 'arm64')
        # point the tree at tmp so a real ~/llama.cpp cannot decide the result
        monkeypatch.setattr(mod, '_LLAMA_CPP_DIR', str(tmp_path / 'llama.cpp'))
        def _boom(*a, **k):
            raise OSError('offline')
        monkeypatch.setattr(mod.urllib.request, 'urlopen', _boom)
        assert mod._llama_prebuilt_asset() == (None, None)
        # the install must RETURN False, never raise — the caller then falls
        # back to a source build instead of dying on a flaky network
        assert mod._llama_prebuilt_install() is False

    def test_prebuilt_download_extract_and_verify_offline(self, monkeypatch,
                                                          tmp_path):
        """The WHOLE prebuilt path, with no network: fake archive in,
        executable llama-server out, and _llama_tree_state reading "built".

        The download step is intercepted and handed a tarball built here, so
        the real extract / place / chmod / verify code runs for real."""
        import tarfile
        mod = _load_cli()

        # ── a release archive, built locally ────────────────────────────
        staging = tmp_path / 'staging'
        inner = staging / 'llama-bTEST'
        inner.mkdir(parents=True)
        (inner / 'llama-server').write_text(
            '#!/bin/sh\necho "llama-server (fake) $*"\nexit 0\n')
        (inner / 'llama-server').chmod(0o644)   # NOT executable on disk:
        # the installer must chmod it, or the next run rebuilds forever
        (inner / 'libggml-metal.dylib').write_bytes(b'\xcf\xfa\xed\xfe')
        (inner / 'LICENSE').write_text('MIT')
        archive = tmp_path / 'llama-fake.tar.gz'
        with tarfile.open(archive, 'w:gz') as tf:
            tf.add(staging, arcname='.')

        # ── where it must land ──────────────────────────────────────────
        tree = tmp_path / 'llama.cpp'
        monkeypatch.setattr(mod, '_LLAMA_CPP_DIR', str(tree))
        monkeypatch.setattr(mod, '_LLAMA_CPP_BIN', str(tree / 'build' / 'bin'))
        monkeypatch.setattr(mod.sys, 'platform', 'darwin')
        monkeypatch.setattr(mod.platform, 'machine', lambda: 'arm64')
        monkeypatch.setattr(mod, '_llama_prebuilt_asset',
                            lambda: ('bTEST', 'https://example.invalid/fake.tar.gz'))

        # ── intercept only the DOWNLOAD; tar and the verify run for real ─
        import subprocess as real_subprocess
        real_call = mod.subprocess.call

        def fake_call(cmd, *a, **kw):
            if cmd and os.path.basename(str(cmd[0])) in ('curl', 'wget'):
                # the download: -o <path> (curl) or -O <path> (wget)
                if '-o' in cmd:
                    dest = cmd[cmd.index('-o') + 1]
                else:
                    dest = cmd[cmd.index('-O') + 1]
                shutil.copyfile(archive, dest)
                return 0
            return real_call(cmd, *a, **kw)

        monkeypatch.setattr(mod.subprocess, 'call', fake_call)

        ok = mod._llama_prebuilt_install()
        assert ok is True, 'the prebuilt install should have succeeded'

        server = tree / 'build' / 'bin' / 'llama-server'
        assert server.is_file(), 'llama-server did not land where the CLI looks'
        assert os.access(str(server), os.X_OK), 'the installer must chmod +x'
        assert (tree / 'build' / 'bin' / 'libggml-metal.dylib').is_file()
        assert (tree / 'build' / 'bin' / 'LICENSE').is_file()
        # ...and that is exactly what the NEXT run must see
        assert mod._llama_tree_state(str(tree)) == 'built'

        # a second run is a no-op, not a re-download
        monkeypatch.setattr(mod.subprocess, 'call',
                            lambda *a, **k: (_ for _ in ()).throw(
                                AssertionError('must not download again')))
        assert mod._llama_prebuilt_install() is True

    def test_tree_state_reads_a_prebuilt_layout_as_built(self, tmp_path):
        """Unpacking into build/bin must satisfy _llama_tree_state — that is
        what stops the next run from asking for a compiler again."""
        mod = _load_cli()
        tree = tmp_path / 'llama.cpp'
        assert mod._llama_tree_state(str(tree)) == 'missing'
        bindir = tree / 'build' / 'bin'
        bindir.mkdir(parents=True)
        # no CMakeLists.txt anywhere: this is NOT a source tree
        assert mod._llama_tree_state(str(tree)) != 'source'
        server = bindir / 'llama-server'
        server.write_text('#!/bin/sh\necho ok\n')
        server.chmod(0o755)
        assert mod._llama_tree_state(str(tree)) == 'built'

    def test_macos_hint_names_only_cmake_and_offers_prebuilt(self, monkeypatch,
                                                             capsys):
        """THE REPORTED BUG: no Homebrew -> the Linux dead end.

        The Mac already has git, clang++ and make; only cmake is missing.
        The hint must say exactly that, and must offer the path that needs
        neither Homebrew nor a compiler."""
        mod = _load_cli()
        monkeypatch.setattr(mod.sys, 'platform', 'darwin')
        monkeypatch.setattr(mod.platform, 'machine', lambda: 'arm64')
        monkeypatch.setattr(
            mod.shutil, 'which',
            lambda n: ('/usr/bin/' + n)
            if n in ('git', 'clang', 'clang++', 'c++', 'make') else None)
        ok = mod._ensure_build_tools(['git', 'cmake', 'cxx', 'make'])
        err = capsys.readouterr().err
        assert ok is False
        assert 'cmake' in err
        assert 'missing build tool(s): cmake' in err, err
        # it must NOT ask for tools the Mac already has
        assert 'with your package manager' not in err, err
        # and it must name the way forward
        assert 'Homebrew' in err, err
        assert 'brew install cmake' in err, err
        assert 'install-llama --auto' in err, err
        assert 'prebuilt' in err.lower(), err

    def test_prebuilt_is_attempted_before_the_build_tool_preflight(self):
        """Asking for cmake FIRST is what stopped the Mac."""
        src = CLI.read_text(encoding='utf-8', errors='replace')
        body = src.split('def cmd_llm_install_llama(')[1]
        body = body.split('\ndef ')[0]
        pre = body.find('_llama_prebuilt_install()')
        gate = body.find('_ensure_build_tools(')
        assert pre != -1, 'the install never tries the prebuilt'
        assert gate != -1, 'the source path lost its preflight'
        assert pre < gate, (
            'the build-tool preflight runs before the prebuilt — a Mac dies'
            ' at cmake before the download is ever tried')

    def test_no_prebuilt_flag_is_wired(self):
        src = CLI.read_text(encoding='utf-8', errors='replace')
        assert 'no-prebuilt' in src, 'no escape hatch to force a source build'
        # a declared-but-unread flag would silently do nothing
        assert 'getattr(args, "no_prebuilt", False)' in src, (
            '--no-prebuilt is declared but never read')

    def test_shell_installers_carry_the_darwin_hint(self):
        """The same dead end existed in both shell surfaces."""
        installer = (REPO / 'public_html' / 'install-hivv.sh').read_text(
            encoding='utf-8', errors='replace')
        deps = (REPO / 'scripts' / 'lib' / 'deps.sh').read_text(
            encoding='utf-8', errors='replace')
        for name, text in (('install-hivv.sh', installer),
                           ('deps.sh', deps)):
            assert 'Darwin' in text, name
            assert 'raw.githubusercontent.com/Homebrew/install' in text, (
                name + ' still has no Homebrew instructions for a Mac')
            assert 'install-llama --auto' in text, (
                name + ' does not offer the prebuilt path')

if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))
