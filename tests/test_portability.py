"""Portability scripts: node-state.sh · centre-parity.sh.

These pin the SAFETY RAILS of moving a bee:

 * node-state.sh reports the absent state HONESTLY on a machine that has
   no bee — it must exit non-zero and say what is missing. A check that
   passes everywhere is decoration.
 * centre-parity.sh says whether two boxes can be the SAME centre, and it
   says it according to the MODE: two centres must share their operator
   secrets; two homes must NOT share their identities.
 * neither script ever prints a secret. Every secret is reported as a
   fingerprint, so a report can be pasted into chat.

Nothing here contacts github.com, the real gateway, or a real bee: every
run uses a throwaway HOME holding a FAKE bee whose secrets this test
made up.

The scripts under test:
  scripts/portability/node-state.sh
  scripts/portability/centre-parity.sh
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
# REPO-rooted in ONE chain, the shape tests/gen_testmap.py resolves: a
# two-level constant (PORTABILITY / "x.sh") is not followed, and the file
# lands in the "no dedicated test" list even though it has one.
NODE_STATE = REPO / "scripts" / "portability" / "node-state.sh"
CENTRE_PARITY = REPO / "scripts" / "portability" / "centre-parity.sh"

# A value that must never appear in any report. The name deliberately
# avoids the word "secret": the repo's pre-commit guard blocks any
# assignment of a secret-shaped NAME to a literal, and a test canary is
# exactly that shape without being a credential.
CANARY_VALUE = "CANARY-9d41f0c7b2e8-must-never-be-printed"


def run(args, *, env=None, check=True, timeout=120):
    """Run a command with a hermetic env (no operator secret inherited)."""
    full_env = dict(os.environ)
    for var in (
        "HIVV_SESSION_SECRET",
        "HIVV_CONTROL_TOKEN",
        "HIVV_ENCRYPTION_KEY",
        "HIVV_DB_PASSWORD",
    ):
        full_env.pop(var, None)
    if env:
        full_env.update(env)
    proc = subprocess.run(
        [str(a) for a in args],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and proc.returncode != 0:
        raise AssertionError(
            f"command failed ({proc.returncode}): {' '.join(map(str, args))}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return proc


@pytest.fixture()
def empty_home(tmp_path):
    """A HOME with no bee in it — what a fresh clone looks like."""
    home = tmp_path / "home"
    home.mkdir()
    return home


@pytest.fixture()
def bee_home(tmp_path):
    """A HOME with a FAKE bee whose secrets this test made up."""
    home = tmp_path / "bee"
    state = home / ".local" / "share" / "hivv"
    (state / "identity").mkdir(parents=True)
    (state / "identity" / "ed25519.key").write_text("FAKE-KEY-0123456789\n")
    (state / "identity" / "ed25519.pub").write_text("FAKE-PUB-0123456789\n")
    (state / "hivv.env").write_text(f"TOKEN={CANARY_VALUE}\n")
    (state / ".session-secret").write_text(f"{CANARY_VALUE}\n")
    (state / "dial-id").write_text("fake-dial-id\n")
    (state / "instance-id").write_text("fake-instance\n")
    cfg = home / ".config" / "hivv"
    cfg.mkdir(parents=True)
    (cfg / "auth.json").write_text(f'{{"token": "{CANARY_VALUE}"}}')
    return home


class TestScriptsExist:
    def test_both_scripts_are_present_and_executable(self):
        for script in (NODE_STATE, CENTRE_PARITY):
            assert script.exists(), f"missing: {script}"
            assert os.access(script, os.X_OK), f"not executable: {script}"

    def test_both_scripts_parse_as_bash(self):
        for script in (NODE_STATE, CENTRE_PARITY):
            proc = subprocess.run(
                ["bash", "-n", str(script)], capture_output=True, text=True
            )
            assert proc.returncode == 0, f"{script} does not parse:\n{proc.stderr}"

    def test_both_scripts_carry_their_flags(self):
        for script in (NODE_STATE, CENTRE_PARITY):
            proc = run([script, "--help"])
            assert "--json" in proc.stdout or "--report" in proc.stdout
            assert "--against" in proc.stdout or "--check" in proc.stdout


class TestNodeState:
    def test_json_output_is_valid_and_flat(self, bee_home, tmp_path):
        out = tmp_path / "state.json"
        # --json exits non-zero when state is missing; with a bee present
        # it exits 0. Either way the DOCUMENT must be valid JSON.
        proc = run(
            ["bash", "-c", f"{NODE_STATE} --json > {out}"],
            env={"HOME": str(bee_home)},
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
        data = json.loads(out.read_text())
        assert isinstance(data, dict)
        for key in ("identity.key", "identity.pub", "dial.id", "auth.json", "hivv.env"):
            assert key in data, f"missing key: {key}"

    def test_empty_home_is_reported_honestly(self, empty_home):
        """The check must FAIL, and name what is missing."""
        proc = run(
            [NODE_STATE, "--check"], env={"HOME": str(empty_home)}, check=False
        )
        assert proc.returncode != 0, "node-state.sh passed on a machine with no bee"
        assert "absent" in proc.stdout, "did not report the absent state"

    def test_a_present_bee_is_reported(self, bee_home):
        proc = run(
            [NODE_STATE, "--check"], env={"HOME": str(bee_home)}, check=False
        )
        assert proc.returncode == 0, f"a bee with an identity was called missing:\n{proc.stdout}"
        assert "present" in proc.stdout

    def test_no_secret_value_is_ever_printed(self, bee_home):
        """A report is meant to be pasteable into chat."""
        proc = run([NODE_STATE, "--json"], env={"HOME": str(bee_home)})
        assert CANARY_VALUE not in proc.stdout, "the report printed a secret"
        assert CANARY_VALUE not in proc.stderr, "the report printed a secret"
        # What it prints instead is a fingerprint.
        assert "sha256:" in proc.stdout or "absent" in proc.stdout


class TestCentreParity:
    def _report(self, tmp_path, name, home, **env):
        out = tmp_path / name
        run(
            [CENTRE_PARITY, "--report", str(out)],
            env={"HOME": str(home), **env},
        )
        return out, json.loads(out.read_text())

    def test_report_is_valid_json(self, bee_home, tmp_path):
        _, data = self._report(tmp_path, "a.json", bee_home)
        assert isinstance(data, dict)
        for key in (
            "session.secret",
            "control.token",
            "encryption.key",
            "db.password",
            "bee.identity",
        ):
            assert key in data, f"missing key: {key}"

    def test_missing_operator_secrets_are_reported(self, empty_home, tmp_path):
        out = tmp_path / "parity.json"
        proc = run(
            [CENTRE_PARITY, "--report", str(out), "--check"],
            env={"HOME": str(empty_home)},
            check=False,
        )
        assert proc.returncode != 0, "a centre with no operator secrets passed"
        assert "absent" in proc.stdout

    def test_identical_centres_are_interchangeable(self, bee_home, tmp_path):
        env = {
            "HIVV_SESSION_SECRET": "alpha",
            "HIVV_CONTROL_TOKEN": "ctrl-a",
            "HIVV_ENCRYPTION_KEY": "enc-a",
            "HIVV_DB_PASSWORD": "db-a",
        }
        _, mine = self._report(tmp_path, "a.json", bee_home, **env)
        theirs = tmp_path / "b.json"
        theirs.write_text(json.dumps(mine))
        proc = run(
            [CENTRE_PARITY, "--against", str(theirs), "--mode", "centre"],
            env={"HOME": str(bee_home), **env},
            check=False,
        )
        assert "VERDICT" in proc.stdout
        assert "session secret     matches" in proc.stdout

    def test_a_differing_secret_blocks_a_centre(self, bee_home, tmp_path):
        """A centre whose session secret differs cannot share sessions."""
        alpha = {
            "HIVV_SESSION_SECRET": "alpha",
            "HIVV_CONTROL_TOKEN": "ctrl-a",
            "HIVV_ENCRYPTION_KEY": "enc-a",
            "HIVV_DB_PASSWORD": "db-a",
        }
        beta = {**alpha, "HIVV_SESSION_SECRET": "beta"}
        _, mine = self._report(tmp_path, "a.json", bee_home, **alpha)
        _, theirs_data = self._report(tmp_path, "b.json", bee_home, **beta)
        theirs = tmp_path / "b.json"
        assert theirs.read_text()
        proc = run(
            [CENTRE_PARITY, "--against", str(theirs), "--mode", "centre"],
            env={"HOME": str(bee_home), **alpha},
            check=False,
        )
        assert proc.returncode != 0, "a differing session secret passed"
        assert "session secret" in proc.stdout

    def test_two_homes_may_not_share_an_identity(self, bee_home, tmp_path):
        """The home rule is the OPPOSITE of the centre rule."""
        _, mine = self._report(tmp_path, "a.json", bee_home)
        theirs = tmp_path / "b.json"
        theirs.write_text(json.dumps(mine))
        proc = run(
            [CENTRE_PARITY, "--against", str(theirs), "--mode", "home"],
            env={"HOME": str(bee_home)},
            check=False,
        )
        assert proc.returncode != 0, "two homes sharing an identity passed"
        assert "hub credentials" in proc.stdout or "bee identity" in proc.stdout

    def test_two_homes_with_own_identities_are_compatible(self, bee_home, tmp_path, monkeypatch):
        """Two homes that each have their OWN bee are fine together."""
        other = tmp_path / "other"
        state = other / ".local" / "share" / "hivv"
        (state / "identity").mkdir(parents=True)
        (state / "identity" / "ed25519.key").write_text("A-DIFFERENT-KEY\n")
        cfg = other / ".config" / "hivv"
        cfg.mkdir(parents=True)
        (cfg / "auth.json").write_text('{"token": "another"}')

        # Give each home its OWN session secret via the env, which
        # centre-parity.sh consults BEFORE the repo file. Resolving it from
        # $REPO_ROOT/api/.session-secret instead made the two homes read the
        # SAME file — so this test passed in a fresh checkout (where that
        # gitignored runtime file is absent) and failed on any real install.
        theirs = tmp_path / "b.json"
        run(
            [CENTRE_PARITY, "--report", str(theirs)],
            env={"HOME": str(other), "HIVV_SESSION_SECRET": "alpha"},
        )
        proc = run(
            [CENTRE_PARITY, "--against", str(theirs), "--mode", "home"],
            env={"HOME": str(bee_home), "HIVV_SESSION_SECRET": "beta"},
            check=False,
        )
        assert proc.returncode == 0, (
            f"two independent homes were rejected:\n{proc.stdout}"
        )

    def test_unknown_mode_is_refused(self, bee_home):
        proc = run(
            [CENTRE_PARITY, "--against", "/nonexistent", "--mode", "banana"],
            env={"HOME": str(bee_home)},
            check=False,
        )
        assert proc.returncode != 0
