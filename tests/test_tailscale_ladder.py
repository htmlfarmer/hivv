#!/usr/bin/env python3
"""Regression tests: the tailscale SETUP LADDER and the firewall honesty.

THE QUESTION THIS ANSWERS (asked 2026-11-27)
──────────────────────────────────────────────
"can we make sure we remind the user to do after each step of installing
tailscale? everything also tailscale doesn't seem to be working.."

Two bugs were tangled together in that report, and both are pinned here.

  1. THE CRASH. `hivv firewall --apply --mode tailscale` died with
     NameError: name '_r' is not defined — at
         content = _r(f"cat {s} 2>/dev/null").stdout
     `_r` is a lambda that OTHER functions bind locally (cmd_up,
     _run_health_checks, cmd_doctor, cmd_test…). cmd_firewall binds
     `_run`. The glob loop that reads startup scripts called `_r` and
     killed the ONE command that turns the tailscale mode on. Tailscale
     itself was fine on yalla (100.64.244.93, serving 8080) — the CLI
     crashed before it could apply anything.

  2. THE LIE BEHIND THE CRASH. Even with the NameError fixed,
     `ufw status` needs ROOT. A normal user's run leaves stdout EMPTY
     (the "You need to be root" ERROR goes to stderr), so:
       * fw_tool stayed None  ->  "no firewall detected"
       * closed_ports stayed []  ->  "All LLM ports already have firewall
         rules." over rules nobody had written
       * the apply loop iterated nothing  ->  nothing applied
       * and the final line still said  "firewall configured!"
     Three claims, zero rules. `_ufw_status_text()` now escalates
     (plain -> sudo -n -> sudo at a TTY) and returns None when it truly
     cannot read — and None is reported as UNKNOWN, never as "no rules".

  3. THE REMINDER. Installing tailscale is four steps plus a final
     cross-machine check, but every hint in the CLI printed ONE line of
     it. So a user who had just run `sudo tailscale up` and seen
     "Success." had no idea the firewall rule was a SEPARATE step.
     `_print_tailscale_ladder()` prints the whole ladder, marks the
     first unfinished step, and names what to run — then what to run
     AFTER that.

TESTING NOTE: cmd_firewall does a LOCAL `import subprocess` inside its
own body, which shadows any module-level patch of `mod.subprocess`.
So these tests patch the REAL subprocess module (monkeypatch restores it)
and patch `shutil.which` the same way.

Run:
    python3 -m pytest tests/test_tailscale_ladder.py -q
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import importlib.util
import io
import json
import re
import subprocess as real_subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CLI = REPO / "public_html" / "hivv-cli.py"


def _load_cli(name: str = "hivv_cli_ladder"):
    spec = importlib.util.spec_from_file_location(name, CLI)
    mod = importlib.util.module_from_spec(spec)
    old = sys.argv
    sys.argv = ["hivv"]
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    finally:
        sys.argv = old
    return mod


def _strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


def _ladder(mod, progress) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod._print_tailscale_ladder(progress)
    return _strip_ansi(buf.getvalue())


class _R:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def _fake_run_factory(routes):
    """Build a subprocess.run stand-in from {substring: result-or-None}.

    An unmatched command returns rc=1 with an empty body — the shape a
    real, permission-denied, non-root shell produces.
    """
    def fake_run(cmd, *a, **k):
        s = cmd if isinstance(cmd, str) else " ".join(str(x) for x in cmd)
        for key, res in routes.items():
            if key in s:
                return res if isinstance(res, _R) else _R(0, res)
        return _R(1, "", "denied")
    return fake_run


def _wire(monkeypatch, mod, routes, *, which=None, **module_patches):
    """Patch subprocess.run for REAL (local imports shadow mod.subprocess),
    plus shutil.which and any module-level helper the test needs."""
    monkeypatch.setattr(real_subprocess, "run", _fake_run_factory(routes))
    if which is not None:
        monkeypatch.setattr(mod.shutil, "which", which)
    for k, v in module_patches.items():
        monkeypatch.setattr(mod, k, v)


_ROUTES = {
    "ss -tlnp": _R(0, 'LISTEN 0 512 0.0.0.0:8080 0.0.0.0:* '
                      'users:(("llama-server",pid=1,fd=26))\n'),
    "tailscale ip": _R(0, "100.64.244.93\n"),
    "tailscale status": _R(0, json.dumps({"BackendState": "Running", "Peer": {}})),
    "hostname -I": _R(0, "192.168.1.209\n"),
    "cat /home": _R(0, "#!/bin/bash\nllama-server -m x.gguf --port 8080\n"),
}


# ── 1. the reported NameError ──────────────────────────────────────────────
def _binds(fn, name: str) -> bool:
    """True when THIS function gives `name` a local binding."""
    args = getattr(fn, "args", None)
    if args is not None:
        allargs = (list(getattr(args, "posonlyargs", [])) + list(args.args)
                   + list(getattr(args, "kwonlyargs", [])))
        if any(a.arg == name for a in allargs):
            return True
        for a in (args.vararg, args.kwarg):
            if a is not None and a.arg == name:
                return True
    for n in ast.walk(fn):
        if isinstance(n, ast.Name) and n.id == name and isinstance(n.ctx, ast.Store):
            return True
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            if any((al.asname or al.name.split(".")[0]) == name for al in n.names):
                return True
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if n.name == name:
                return True
        if isinstance(n, (ast.Global, ast.Nonlocal)) and name in n.names:
            return True
        if isinstance(n, ast.ExceptHandler) and n.name == name:
            return True
    return False


class TestNoUnboundR:
    """The exact crash: a function calling `_r` it never binds.

    `_r` is not a module-level name anywhere in the CLI — every user
    defines its own. So any load of `_r` inside a function that neither
    binds it nor receives it as a parameter is a NameError waiting for
    the code path that reaches it.
    """

    def test_no_function_loads_an_unbound_r(self):
        tree = ast.parse(CLI.read_text(encoding="utf-8"))
        offenders = []

        class V(ast.NodeVisitor):
            def __init__(self):
                self.stack = []

            def visit_FunctionDef(self, node):
                self.stack.append(node)
                self.generic_visit(node)
                self.stack.pop()

            visit_AsyncFunctionDef = visit_FunctionDef

            def visit_Name(self, node):
                if node.id == "_r" and isinstance(node.ctx, ast.Load):
                    if not any(_binds(f, "_r") for f in self.stack):
                        where = self.stack[-1].name if self.stack else "<module>"
                        offenders.append((node.lineno, where))
                self.generic_visit(node)

        V().visit(tree)
        assert not offenders, (
            "these sites call _r without binding it — NameError on that path: "
            + repr(offenders)
        )

    def test_cmd_firewall_does_not_raise(self, monkeypatch, capsys):
        """End-to-end: run cmd_firewall on a box with a startup script.

        The glob loop is the line that crashed, and it only runs when a
        start-*.sh exists — which is exactly why the bug survived until
        yalla, where /home/asher/llama.cpp/servers/start-llama.sh does.
        Patch glob so the loop ALWAYS runs, or the test would pass while
        the crash is still in there.
        """
        mod = _load_cli()
        monkeypatch.setattr(
            mod, "_detect_local_ai",
            lambda: [{"port": 8080, "model": "gemma.gguf", "provider": "llama.cpp"}])
        monkeypatch.setattr("glob.glob",
                            lambda pat: ["/home/asher/llama.cpp/servers/start-llama.sh"])
        _wire(monkeypatch, mod, _ROUTES,
              which=lambda n: None,
              _ufw_status_text=lambda **kw: None)

        mod.cmd_firewall(argparse.Namespace(apply=False, mode="lan"))
        out = _strip_ansi(capsys.readouterr().out)
        assert "startup script found" in out, (
            "the glob loop should have run — the test would be vacuous otherwise")


# ── 2. the step ladder ─────────────────────────────────────────────────────
class TestTailscaleLadder:
    """Every hint must show the WHOLE sequence and name the next step."""

    def test_ladder_is_four_ordered_steps_with_commands(self):
        mod = _load_cli()
        assert len(mod._TAILSCALE_STEPS) == 4
        for label, cmd in mod._TAILSCALE_STEPS:
            assert label and cmd, "every step needs a label AND a command"
        joined = " ".join(c for _, c in mod._TAILSCALE_STEPS)
        assert joined.index("hivv install tailscale") < joined.index("tailscale up")
        assert joined.index("tailscale up") < joined.index("tailscale ip -4")
        assert joined.index("tailscale ip -4") < joined.index("firewall --apply")

    def test_final_check_is_not_counted_as_a_step(self):
        """The cross-machine check can never read True from this box.

        Counting it would pin the ladder at N-1 forever and cry wolf on
        every run, so it is shown only as the "then:" line once the four
        real steps are done.
        """
        mod = _load_cli()
        assert len(mod._tailscale_progress()) == len(mod._TAILSCALE_STEPS)
        out = _ladder(mod, [True] * len(mod._TAILSCALE_STEPS))
        assert "then" in out and mod._TAILSCALE_FINAL[1] in out
        assert "next:" not in out, "nothing left to do — do not invent a next step"

    def test_first_unfinished_step_is_marked_and_named(self):
        mod = _load_cli()
        out = _ladder(mod, [True, True, False, False])
        assert "next:" in out
        assert "tailscale ip -4" in out
        assert "hivv install tailscale" not in out.split("next:")[1]

    def test_unknown_is_not_shown_as_not_done(self):
        """None means 'cannot tell from here' — never render it as a gap."""
        mod = _load_cli()
        out = _ladder(mod, [True, True, True, None])
        assert "next:" in out and "firewall --apply" in out
        assert "needs root to confirm" in out

    def test_nothing_done_points_at_the_install(self):
        mod = _load_cli()
        out = _ladder(mod, [False] * 4)
        assert out.split("next:")[1].strip().startswith("hivv install tailscale")

    def test_every_step_line_is_followed_by_its_command(self):
        """A marker with no command under it is a dead end."""
        mod = _load_cli()
        out = _ladder(mod, [False] * 4)
        for _, cmd in mod._TAILSCALE_STEPS:
            assert cmd in out

    def test_progress_is_all_false_when_tailscale_is_absent(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(mod.shutil, "which", lambda n: None)
        assert mod._tailscale_progress() == [False] * len(mod._TAILSCALE_STEPS)

    def test_progress_reads_a_running_install(self, monkeypatch):
        mod = _load_cli()
        _wire(monkeypatch, mod,
              {"tailscale status": _R(0, json.dumps({"BackendState": "Running"})),
               "ip -4": _R(0, "100.64.244.93\n")},
              which=lambda n: "/usr/bin/" + n,
              _ufw_status_text=lambda **kw: "Status: active\n100.64.0.0/10 ALLOW IN Anywhere")
        assert mod._tailscale_progress() == [True, True, True, True]


# ── 3. ufw needs root — say UNKNOWN, never "no rules" ──────────────────────
class TestUfwHonesty:
    """An empty stdout from a non-root ufw is not an empty firewall."""

    def test_unreadable_status_is_none_not_empty_string(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(real_subprocess, "run",
                            lambda *a, **k: _R(1, "", "ERROR: You need to be root"))
        assert mod._ufw_status_text() is None, (
            "an unreadable status must be None so callers can tell "
            "'unknown' from 'no rules'")

    def test_readable_status_is_returned(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(real_subprocess, "run",
                            lambda *a, **k: _R(0, "Status: active\n"))
        monkeypatch.setattr(mod.shutil, "which", lambda n: "/usr/bin/" + n)
        assert "active" in mod._ufw_status_text()

    def test_port_match_is_anchored_not_a_substring(self):
        """The old check was `f"{port}" in text` — port 80 matched 8080."""
        mod = _load_cli()
        text = "8080/tcp                  ALLOW IN    Anywhere"
        assert mod._ufw_port_open(text, 8080) is True
        assert mod._ufw_port_open(text, 80) is False, "80 must not match 8080"
        assert mod._ufw_port_open(text, 808) is False
        assert mod._ufw_port_open("", 8080) is False

    def test_cmd_firewall_needs_root_to_read_and_says_so(self, monkeypatch, capsys):
        mod = _load_cli()
        monkeypatch.setattr(
            mod, "_detect_local_ai",
            lambda: [{"port": 8080, "model": "gemma.gguf", "provider": "llama.cpp"}])
        _wire(monkeypatch, mod, _ROUTES,
              which=lambda n: "/usr/sbin/ufw" if n == "ufw" else None,
              _ufw_status_text=lambda **kw: None)

        mod.cmd_firewall(argparse.Namespace(apply=False, mode="lan"))
        out = _strip_ansi(capsys.readouterr().out)
        assert "All LLM ports already have firewall rules" not in out, (
            "unreadable rules must never be reported as present")
        assert "need root to read" in out or "assuming none are set" in out


# ── 4. --apply must not claim success it did not achieve ───────────────────
class TestApplyHonesty:
    def test_fw_root_prefix_returns_none_without_a_way_to_root(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(mod.shutil, "which", lambda n: None)
        monkeypatch.setattr(mod, "_sudo_passwordless", lambda: False)
        monkeypatch.setattr(mod, "_can_prompt_sudo", lambda: False)
        assert mod._fw_root_prefix() is None

    def test_fw_root_prefix_prefers_passwordless(self, monkeypatch):
        mod = _load_cli()
        monkeypatch.setattr(mod.shutil, "which", lambda n: "/usr/bin/sudo")
        monkeypatch.setattr(mod, "_sudo_passwordless", lambda: True)
        assert mod._fw_root_prefix() == "sudo -n "

    def test_fw_run_gives_a_prompting_sudo_a_real_budget(self, monkeypatch):
        """A password prompt must not be killed by the generic 10s timeout.

        Found live on yalla 2026-11-27: cmd_firewall ran
        `sudo ufw allow ...` through the 10s _run lambda while sudo was
        still waiting for the human to type, and the whole report died on
        subprocess.TimeoutExpired. _fw_run must (a) allow ~90s when the
        prefix is a prompting sudo, and (b) turn a timeout into a normal
        failure line rather than letting it propagate.
        """
        mod = _load_cli()
        seen = {}

        def exploding(cmd, **kw):
            seen.update(kw)
            raise real_subprocess.TimeoutExpired(cmd, kw.get("timeout", 0))

        monkeypatch.setattr(real_subprocess, "run", exploding)
        rc, err = mod._fw_run("ufw allow 8080/tcp", prefix="sudo ")
        assert seen["timeout"] >= 60, "a prompting sudo needs a human-sized budget"
        assert rc == 1 and "timed out" in err, (
            "a timeout must become a failure line, not a traceback")

    def test_fw_run_without_root_never_spawns(self, monkeypatch):
        mod = _load_cli()

        def boom(*a, **k):
            raise AssertionError("should not run anything without root")

        monkeypatch.setattr(real_subprocess, "run", boom)
        assert mod._fw_run("ufw allow 8080/tcp", prefix=None) == (
            1, "no root available")

    def test_manual_rules_are_printed_and_success_is_withheld(self, monkeypatch, capsys):
        """No root -> print the commands, and never say 'configured!'."""
        mod = _load_cli()
        monkeypatch.setattr(
            mod, "_detect_local_ai",
            lambda: [{"port": 8080, "model": "gemma.gguf", "provider": "llama.cpp"}])
        _wire(monkeypatch, mod, _ROUTES,
              which=lambda n: "/usr/sbin/ufw" if n == "ufw" else None,
              _ufw_status_text=lambda **kw: None,
              _fw_root_prefix=lambda **kw: None,
              _firewall_active=lambda: True)

        mod.cmd_firewall(argparse.Namespace(apply=True, mode="tailscale"))
        out = _strip_ansi(capsys.readouterr().out)
        assert "sudo ufw allow from 100.64.0.0/10" in out, (
            "with no root the exact command must be handed over")
        assert "NOT applied" in out
        assert "firewall NOT configured" in out
        claimed = out.replace("firewall NOT configured", "")
        assert "firewall configured!" not in claimed, (
            "a run that applied nothing must not claim success")

    def test_ladder_follows_a_successful_tailscale_apply(self, monkeypatch, capsys):
        mod = _load_cli()
        monkeypatch.setattr(
            mod, "_detect_local_ai",
            lambda: [{"port": 8080, "model": "gemma.gguf", "provider": "llama.cpp"}])
        routes = dict(_ROUTES)
        routes["ufw allow"] = _R(0, "")          # root: every rule lands
        _wire(monkeypatch, mod, routes,
              which=lambda n: "/usr/sbin/ufw" if n == "ufw" else None,
              _ufw_status_text=lambda **kw: "Status: active\n100.64.0.0/10 ALLOW IN Anywhere",
              _fw_root_prefix=lambda **kw: "sudo -n ",
              _firewall_active=lambda: True)

        mod.cmd_firewall(argparse.Namespace(apply=True, mode="tailscale"))
        out = _strip_ansi(capsys.readouterr().out)
        assert "firewall configured!" in out
        # the reminder after the step: what to do NEXT, and after that
        assert "next:" in out or "then" in out
        assert "hivv reach" in out


# ── 5. the ladder is actually wired into the surfaces ──────────────────────
class TestLadderIsWired:
    """A helper nobody calls is not a reminder."""

    def test_firewall_doctor_and_health_checks_all_print_it(self):
        src = CLI.read_text(encoding="utf-8")
        tree = ast.parse(src)

        def body(fn_name):
            for n in ast.walk(tree):
                if isinstance(n, ast.FunctionDef) and n.name == fn_name:
                    return ast.get_source_segment(src, n) or ""
            raise AssertionError(f"{fn_name} not found")

        # cmd_security is a thin wrapper over _security_scan(); the vpn
        # line and the install advice live in cmd_doctor.
        for fn in ("cmd_firewall", "_run_health_checks", "cmd_doctor"):
            assert "_print_tailscale_ladder" in body(fn), (
                f"{fn} must show the ladder, not a single install line")

    def test_no_single_line_install_advice_is_left_behind(self):
        """The old three-liners are what stranded the user."""
        src = CLI.read_text(encoding="utf-8")
        assert 'print(f"     then:    sudo tailscale up")' not in src
        assert 'print(f"     secure:  {APP} firewall --apply --mode tailscale")' not in src


class TestStepOneIsTheDoorThatWorks:
    """Step 1 must be `hivv install tailscale`, never the raw curl.

    The official installer cases only on ID= from /etc/os-release and
    exits 1 on any distro it has never heard of — BOSS GNU/Linux (ID=boss,
    a Debian 12 wearing an unfamiliar ID) printed "Couldn't determine what
    kind of Linux is running" and installed NOTHING. Pointing a user at
    that command is pointing them at a dead end, and four of our hints
    used to do exactly that.
    """

    def test_step_one_is_our_three_tier_door(self):
        mod = _load_cli()
        step1 = mod._TAILSCALE_STEPS[0][1]
        assert "hivv install tailscale" in step1

    def test_step_one_never_names_the_raw_official_curl(self):
        mod = _load_cli()
        step1 = mod._TAILSCALE_STEPS[0][1]
        assert "tailscale.com/install.sh" not in step1, (
            "the official installer exits 1 on distros it does not know")

    def test_the_cli_door_reaches_the_installer_script(self):
        """The command must dispatch to a REAL command, not fall through
        to the smart-default CHAT (which replies helpfully and installs
        nothing — the worst failure, because it looks like success)."""
        src = CLI.read_text(encoding="utf-8")
        assert '"install tailscale"' in src or "'install tailscale'" in src
        assert "install-tailscale.sh" in src
# ── 6. the installer shows the same ladder ────────────────────────────────
INSTALLER = REPO / "public_html" / "install-hivv.sh"


class TestInstallerLadder:
    """install-hivv.sh is the actual "installing tailscale" path.

    It printed two lines — "run: sudo tailscale up" / "then: hivv
    firewall ..." — and stopped, skipping the auth URL you must OPEN and
    the address check entirely. Same gap, second surface.
    """

    def test_installer_defines_the_ladder(self):
        src = INSTALLER.read_text(encoding="utf-8")
        assert "_ts_ladder()" in src and "_ts_next_step()" in src

    @staticmethod
    def _ladder_body() -> str:
        """Just the _ts_ladder() function — the whole file also mentions
        these commands in unrelated warn messages, so ordering asserts
        must be scoped to the ladder itself."""
        src = INSTALLER.read_text(encoding="utf-8")
        start = src.index("_ts_ladder() {")
        end = src.index("\n}", start) + 2
        return src[start:end]

    def test_installer_ladder_is_the_same_four_steps(self):
        body = self._ladder_body()
        assert body.index("install.sh | sh") < body.index("sudo tailscale up")
        assert body.index("sudo tailscale up") < body.index("tailscale ip -4")
        assert body.index("tailscale ip -4") < body.index(
            "hivv firewall --apply --mode tailscale")

    def test_installer_marks_the_next_step_not_just_the_current(self):
        """'do this NEXT' is the whole point — a finished step must name
        what follows it, or the user stops at the one they just ran."""
        src = INSTALLER.read_text(encoding="utf-8")
        assert "do this NEXT" in src
        assert "then OPEN the URL it prints" in src, (
            "the auth URL is the step the old two-liner never mentioned")

    def test_installer_calls_the_ladder_after_install_and_when_inactive(self):
        src = INSTALLER.read_text(encoding="utf-8")
        assert "_ts_ladder 2" in src, "after installing, point at step 2"
        # the already-up branch derives its step, so a configured box is
        # told it is done instead of being nagged to redo step 4
        assert '_ts_ladder "$(_ts_next_step)"' in src, (
            "when already up, derive what is actually left")
        # the old two-liner is gone
        assert "then: %shivv firewall --apply --mode tailscale" not in src

    def test_ladder_is_defined_before_it_is_called(self):
        """bash resolves functions at CALL time, but a helper defined
        after the only exit path that needs it would still be a landmine.
        experiment() runs and exits before the definitions."""
        src = INSTALLER.read_text(encoding="utf-8")
        assert src.index("_ts_ladder() {") < src.index("_ts_ladder 2")
        assert src.index("_ts_next_step() {") < src.index("_ts_ladder() {")

    def test_installer_is_valid_shell(self):
        import subprocess
        r = subprocess.run(["bash", "-n", str(INSTALLER)],
                           capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr

    def _next_step_with(self, monkeypatch, *, tailscale=None, ufw=None):
        """Run the real _ts_next_step with fake binaries on PATH.

        The step number is DERIVED, not hardcoded — a box that already
        opened the port must read 5 (done) instead of being nagged to redo
        step 4 forever. That only holds if the derivation is actually
        exercised, so: fake tailscale, fake ufw, real shell.
        """
        import os as _os
        import subprocess
        import tempfile
        d = tempfile.mkdtemp(prefix="tsladder-")
        if tailscale is not None:
            p = Path(d) / "tailscale"
            p.write_text("#!/bin/sh\n" + tailscale + "\n")
            p.chmod(0o755)
        if ufw is not None:
            p = Path(d) / "ufw"
            p.write_text("#!/bin/sh\n" + ufw + "\n")
            p.chmod(0o755)
        env = dict(_os.environ)
        env["PATH"] = d + ":" + env.get("PATH", "")
        script = (
            'GRN=""; RST=""; YLW=""; DIM=""; BLD="";\n'
            'eval "$(sed -n "/^_ts_next_step()/,/^}/p" "$1")"\n'
            'printf "%s" "$(_ts_next_step)"\n'
        )
        r = subprocess.run(["bash", "-c", script, "_", str(INSTALLER)],
                           capture_output=True, text=True, env=env, timeout=60)
        assert r.returncode == 0, r.stderr
        return r.stdout.strip()

    def test_step_one_when_tailscale_is_absent(self, monkeypatch):
        assert self._next_step_with(monkeypatch, tailscale=None) == "1"

    def test_step_two_when_installed_but_not_logged_in(self, monkeypatch):
        # `tailscale ip -4` fails -> not logged in yet
        assert self._next_step_with(
            monkeypatch, tailscale='echo "not logged in" >&2; exit 1') == "2"

    def test_step_four_when_up_but_port_rule_unconfirmed(self, monkeypatch):
        # logged in with an address, but ufw cannot confirm the rule
        assert self._next_step_with(
            monkeypatch,
            tailscale='case "$*" in *ip*) echo 100.64.244.93;; *) exit 0;; esac',
            ufw='echo "ERROR: You need to be root" >&2; exit 1') == "4"

    def test_step_five_only_when_the_rule_is_actually_read(self, monkeypatch):
        """The one case that must NOT nag: rule confirmed present."""
        assert self._next_step_with(
            monkeypatch,
            tailscale='case "$*" in *ip*) echo 100.64.244.93;; *) exit 0;; esac',
            ufw='printf "Status: active\\n100.64.0.0/10 ALLOW IN Anywhere\\n"') == "5"
