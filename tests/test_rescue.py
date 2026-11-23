"""Tests for public_html/rescue — the ONE emergency command.

THE FAILURE THIS EXISTS FOR (wahi, 2026-11-21..23)
---------------------------------------------------
A root-owned system install + a regular user with no sudo = a box where
  * hivv update        died on Permission denied (.bak), 7 attempts
  * hivv how are you   died downloading hivv-tools.py
  * after a SUCCESSFUL user-local reinstall the box was STILL stuck:
    the shell kept resolving 'hivv' to the old /usr/local copy (PATH
    order + bash's command cache) and the agent kept running the old
    code for 23 more hours, because nothing replaced the live process.
Recovery took a long multi-step command nobody should have to rebuild
from a chat log.

Rescue = one memorable line, curl -sSL hivv.org/rescue | bash:
  * detects the wall (install dir not writable by this user)
  * repairs via the installer (--mode=user — NO sudo assumed)
  * fixes THIS shell's PATH + clears the stale command hash
  * repairs the agent unit (doctor --fix) and RESTARTS the agent
  * verifies the result and says whether the box self-heals now

The E2E runs the REAL rescue piped exactly as a user would, against a
FIXTURE hub (HIVV_HUB=file://…) carrying a fake installer — fully
offline, no tty interaction, no real systemd. The wall is real: a
0555 install dir, exactly wahi's.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
RESCUE = REPO / "public_html" / "rescue"
INSTALLER = REPO / "public_html" / "install-hivv.sh"

FAKE_INSTALLER = '''#!/usr/bin/env bash
# FIXTURE installer — simulates a successful user-local install.
# (Piped to bash, so it cannot locate sibling files; payload is inline.)
set -u
echo "  ✓ user-local install — just for you (files in $HOME/.local, no sudo needed)"
mkdir -p "$HOME/.local/bin" "$HOME/.local/lib/hivv"
cat > "$HOME/.local/lib/hivv/hivv-cli.py" <<'FIXCLI'
#!/usr/bin/env python3
import sys
if "--version" in sys.argv:
    print("0.2.fixture99"); sys.exit(0)
sys.exit(0)
FIXCLI
cat > "$HOME/.local/bin/hivv" <<'FIXWRAP'
#!/usr/bin/env bash
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SELF_DIR/../lib/hivv/hivv-cli.py" "$@"
FIXWRAP
chmod +x "$HOME/.local/bin/hivv" "$HOME/.local/lib/hivv/hivv-cli.py"
exit 0
'''


def _bash_syntax(path: Path) -> str:
    r = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
    return r.stderr


class TestScriptContracts:
    def test_both_scripts_parse(self):
        assert _bash_syntax(RESCUE) == "", _bash_syntax(RESCUE)
        assert _bash_syntax(INSTALLER) == "", _bash_syntax(INSTALLER)

    def test_rescue_is_pipe_safe(self):
        """No interactive reads — a piped rescue must never block."""
        body = "\n".join(l for l in RESCUE.read_text().splitlines()
                         if not l.lstrip().startswith("#"))
        for line in body.splitlines():
            if line.strip().startswith("read "):
                assert "</dev/tty" in line and "||" in line, (
                    f"unguarded read blocks a pipe: {line}"
                )

    def test_rescue_covers_the_whole_chain(self):
        src = RESCUE.read_text()
        for must in ("--mode=user",          # no sudo assumed
                     "hash -r",              # the stale-cache trap (wahi)
                     "doctor --fix",         # repair the agent unit
                     "systemctl --user restart",  # replace the live old agent
                     "! -w ",                # the wall detection
                     "HIVV_HUB",             # offline/self-host override
                     "user-local — self-healing"):
            assert must in src, f"rescue is missing: {must!r}"

    def test_installer_never_defers_the_service_on_auto_switch(self):
        """The auto-switch branch used to set WITH_SERVICE=0, deferring the
        service to a manual doctor --fix — wahi got files but no live agent
        handoff. user mode and auto-switch must behave alike: service ALWAYS
        (the installer's own rethink note says so). --no-service still
        opts out explicitly."""
        src = INSTALLER.read_text()
        assert src.count("WITH_SERVICE=1") >= 3, (
            "system mode, user mode AND the no-sudo auto-switch must all "
            "install the service"
        )
        assert "lands files in" in src  # the comment documenting why

    def test_installer_replaces_a_running_old_agent(self):
        """enable --now does NOT restart a RUNNING service — the old agent
        would keep executing the old copy forever (wahi: 23h)."""
        src = INSTALLER.read_text()
        assert "was_active=1" in src
        assert "systemctl --user restart" in src

    def test_installer_warns_when_an_older_hivv_shadows(self):
        """After a user-local install the shell may still resolve the OLD
        /usr/local copy — the exact post-install trap on wahi."""
        src = INSTALLER.read_text()
        assert "OLDER copy" in src
        assert "hash -r" in src
        assert 'export PATH="' in src

    def test_both_honor_hivv_hub_override(self):
        assert "HIVV_HUB:-https://hivv.org" in RESCUE.read_text()
        assert "HIVV_HUB:-https://hivv.org" in INSTALLER.read_text()


def _load_cli():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "hivv_cli_rcmd", REPO / "public_html" / "hivv-cli.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules["hivv_cli_rcmd"] = m
    spec.loader.exec_module(m)
    return m


class TestUserInstallCmdPointsAtRescue:
    """The tip/doctor command IS the rescue line — short enough to
    remember, and rescue exists at the path it names."""

    def test_command_is_the_short_rescue_line(self):
        m = _load_cli()
        assert m.USER_INSTALL_CMD == "curl -sSL https://hivv.org/rescue | bash"
        assert "\\" not in m.USER_INSTALL_CMD, "must be pasteable as-is"
        assert RESCUE.exists() and RESCUE.stat().st_size > 1000


class TestRescueEndToEnd:
    """The REAL rescue, piped exactly as a user runs it, against a fixture
    hub — fully offline. The wall is real: a 0555 install dir."""

    @pytest.fixture
    def stage(self, tmp_path):
        # fixture hub: real rescue + fake installer
        hub = tmp_path / "hub"
        hub.mkdir()
        shutil.copy2(RESCUE, hub / "rescue")
        (hub / "install-hivv.sh").write_text(FAKE_INSTALLER)
        # the wall: a system-style install the user cannot write
        wall = tmp_path / "wall"
        (wall / "bin").mkdir(parents=True)
        (wall / "lib" / "hivv").mkdir(parents=True)
        shutil.copy2(REPO / "public_html" / "hivv",
                     wall / "bin" / "hivv")
        (wall / "lib" / "hivv" / "hivv-cli.py").write_text(
            "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n")
        (wall / "lib" / "hivv").chmod(0o555)
        # fake systemctl: records the call, does nothing
        fbin = tmp_path / "fakebin"
        fbin.mkdir()
        slog = tmp_path / "systemctl.log"
        shim = fbin / "systemctl"
        shim.write_text('#!/bin/sh\necho "$@" >> "' + str(slog) + '"\nexit 1\n')
        shim.chmod(0o755)
        home = tmp_path / "home"
        home.mkdir()
        yield {
            "hub": hub, "wall": wall, "home": home,
            "fakebin": fbin, "slog": slog,
        }
        (wall / "lib" / "hivv").chmod(0o700)   # let tmp cleanup work

    def test_repair_end_to_end(self, stage):
        env = dict(os.environ)
        env["HOME"] = str(stage["home"])
        env["PATH"] = os.pathsep.join([
            str(stage["wall"] / "bin"),
            str(stage["fakebin"]),
            "/usr/bin", "/bin",
        ])
        env["HIVV_HUB"] = stage["hub"].as_uri()   # file://…
        env.pop("XDG_CONFIG_HOME", None)
        cmd = 'curl -fsSL "' + stage["hub"].as_uri() + '/rescue" | bash'
        r = subprocess.run(["bash", "-c", cmd], env=env,
                           capture_output=True, text=True, timeout=180)
        out = r.stdout + r.stderr
        assert r.returncode == 0, out[-3000:]
        # 1. the wall was DETECTED
        assert "NOT writable" in out, "wall not detected:\n" + out[-2000:]
        # 2. the repair landed user-local
        client = stage["home"] / ".local" / "lib" / "hivv" / "hivv-cli.py"
        assert client.exists(), "the fake installer should have landed the client"
        # 3. THIS shell now resolves the new copy + declares self-healing
        assert "user-local — self-healing" in out, out[-1500:]
        # 4. the agent restart was ATTEMPTED (shim records it; nothing real ran)
        slog = stage["slog"].read_text()
        assert "restart" in slog and "hivv-agent" in slog, slog
        # 5. future shells get the PATH fix
        profile = stage["home"] / ".profile"
        assert profile.exists() and ".local/bin" in profile.read_text()
        # 6. exit clean and the message tells the user what is next
        assert "hivv status" in out
