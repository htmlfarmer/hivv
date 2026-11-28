"""CI must run the ONE-LINE installers on every OS we ship them for.

`local-install.yml` proves the CLONE path (setup-local from a git checkout).
Before this file, NEITHER installer a visitor actually pastes had ever been
executed by CI — not `curl | bash`, not `iwr | iex` — and
`install-hivv.ps1` was not a trigger anywhere, so a PR could rewrite it and
no runner would notice. (The Windows tab's "+LLM" command shipped calling a
function that does not exist in the installer; nothing caught it.)

Laws pinned here:
  1. the workflow exists, parses, and triggers on every file the installers
     are made of — including itself
  2. all THREE OSes run: ubuntu + macos (sh) and windows (ps1)
  3. the hub at RUN time is THIS checkout (127.0.0.1), never production —
     a PR must be tested against its own files
  4. nothing joins the hive: --no-service / -NoService, because a CI runner
     registering as a bee against the real hub would be a phantom node
  5. both jobs assert the POINT of an installer: `hivv --version` runs
  6. timeouts are set — a hanging installer burns GitHub's 6-hour default
  7. install-hivv.ps1 carries the HIVV_HUB override (parity with the .sh)
"""
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "installers.yml"


def _load():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _runs(job) -> str:
    """Every run: script in a job, joined — assertions read the code."""
    return "\n".join(
        str(step.get("run", ""))
        for step in job.get("steps", [])
    )


class TestTheWorkflowExistsAndTriggers:
    def test_file_exists_and_parses(self):
        assert WORKFLOW.is_file(), "the installer CI gate does not exist"
        assert _load()["jobs"], "workflow parsed with no jobs"

    def test_triggers_on_every_installer_input(self):
        on = _load().get("on") or _load().get(True)  # YAML reads 'on' as True
        expected = {
            "public_html/install-hivv.sh",
            "public_html/install-hivv.ps1",
            "public_html/hivv",        # the bash wrapper the sh installer drops
            "public_html/hivv.cmd",    # the wrapper the ps1 downloads
            "public_html/hivv-cli.py", # the client both wrappers exec
            ".github/workflows/installers.yml",
        }
        for event in ("push", "pull_request"):
            paths = set(on[event]["paths"])
            missing = expected - paths
            assert not missing, f"{event} trigger misses: {sorted(missing)}"

    def test_manual_dispatch_is_available(self):
        on = _load().get("on") or _load().get(True)
        assert "workflow_dispatch" in on


class TestEveryOsRuns:
    def test_unix_matrix_covers_linux_and_macos(self):
        oses = _load()["jobs"]["unix"]["strategy"]["matrix"]["os"]
        assert "ubuntu-latest" in oses
        assert "macos-latest" in oses

    def test_windows_job_exists(self):
        assert _load()["jobs"]["windows"]["runs-on"] == "windows-latest"

    def test_the_sh_job_runs_the_sh_installer(self):
        run = _runs(_load()["jobs"]["unix"])
        assert "install-hivv.sh" in run
        # piped, like the visitor's line — not bash ./file (different code
        # path: stdin is not a TTY, which is what CI actually is)
        assert "curl -sSf http://127.0.0.1:8123/install-hivv.sh" in run

    def test_the_windows_job_runs_the_ps1_installer(self):
        run = _runs(_load()["jobs"]["windows"])
        assert "install-hivv.ps1" in run
        assert "Invoke-WebRequest" in run, "download the way a visitor does"
        assert "[scriptblock]::Create" in run, (
            "the documented flags form — plain 'iwr | iex' cannot take flags")


class TestTheHubIsThisCheckout:
    """A PR is tested against ITS OWN files, never production."""

    def test_unix_job_overrides_the_hub(self):
        run = _runs(_load()["jobs"]["unix"])
        assert "HIVV_HUB=http://127.0.0.1:8123" in run

    def test_windows_job_overrides_the_hub(self):
        run = _runs(_load()["jobs"]["windows"])
        assert "$env:HIVV_HUB = 'http://127.0.0.1:8123'" in run

    def test_no_job_points_the_hub_at_production(self):
        for name, job in _load()["jobs"].items():
            assert "HIVV_HUB=https://hivv.org" not in _runs(job), (
                f"{name} would test against production, not the PR")

    def test_the_ps1_honours_the_override(self):
        # the workflow is only meaningful if the installer reads the env
        ps1 = (REPO / "public_html" / "install-hivv.ps1").read_text(encoding="utf-8")
        assert "$env:HIVV_HUB" in ps1, (
            "install-hivv.ps1 hard-codes the hub — CI could only ever test "
            "production's copy, never the PR's")

    def test_the_sh_still_honours_the_override(self):
        sh = (REPO / "public_html" / "install-hivv.sh").read_text(encoding="utf-8")
        assert 'HUB="${HIVV_HUB:-https://hivv.org}"' in sh


class TestNothingJoinsTheHive:
    """A CI runner must never register as a bee against the real hub."""

    def test_unix_job_disables_the_service(self):
        run = _runs(_load()["jobs"]["unix"])
        assert "--no-service" in run
        assert "--no-llm" in run, "no model downloads in CI"
        assert "--no-git" in run, "no contributor-tools prompt in CI"
        assert "--yes" in run, "every prompt must be answered"

    def test_windows_job_disables_the_service(self):
        run = _runs(_load()["jobs"]["windows"])
        assert "-NoService" in run
        assert "-NoLlm" in run
        assert "-Yes" in run

    def test_the_windows_flags_are_the_installers_real_switches(self):
        # a typo'd flag would be a param error at RUN time — pin them
        # against the installer's own declared parameters
        ps1 = (REPO / "public_html" / "install-hivv.ps1").read_text(encoding="utf-8")
        for flag in ("-Yes", "-NoLlm", "-NoService"):
            assert flag in ps1, f"the workflow passes {flag} but the ps1 lacks it"


class TestThePointAndTheGuardrails:
    def test_unix_asserts_hivv_runs(self):
        run = _runs(_load()["jobs"]["unix"])
        assert '"$HOME/.local/bin/hivv" --version' in run

    def test_windows_asserts_hivv_runs(self):
        run = _runs(_load()["jobs"]["windows"])
        assert "hivv --version" in run
        assert "$LASTEXITCODE" in run, "a failed wrapper must fail the job"

    def test_windows_asserts_path_persisted_to_the_registry(self):
        # the visitor's NEXT terminal reads PATH from the registry, not from
        # this session — asserting the session would prove nothing durable
        run = _runs(_load()["jobs"]["windows"])
        assert "GetEnvironmentVariable('Path', 'User')" in run

    def test_unix_asserts_path_wired_for_future_shells(self):
        run = _runs(_load()["jobs"]["unix"])
        assert 'grep -q "$HOME/.local/bin"' in run

    def test_both_jobs_have_timeouts(self):
        for name, job in _load()["jobs"].items():
            assert job.get("timeout-minutes"), (
                f"{name} has no timeout — a hung installer burns 6 hours")

    def test_every_step_is_pinned_to_a_committed_action(self):
        # actions/checkout@v4 style — a floating tag is how CI silently
        # changes behaviour under you
        for name, job in _load()["jobs"].items():
            for step in job.get("steps", []):
                if "uses" in step:
                    assert "@" in step["uses"], f"{name}: unpinned action"


class TestTheLessonsRunOneTaught:
    """Both real failures of the first GitHub run, pinned so they stay fixed."""

    def test_windows_downloads_to_a_file_not_a_byte_array(self):
        # python's http.server serves .ps1 as application/octet-stream, so
        # (iwr ...).Content comes back as a BYTE ARRAY — scriptblock::Create
        # received "35 32 105 110 ..." (ASCII codes) and refused to parse.
        # Run 1 died exactly there; -OutFile + Get-Content -Raw is a string,
        # always.
        run = _runs(_load()["jobs"]["windows"])
        assert "-OutFile" in run, "download to a file — .Content is bytes"
        assert "Get-Content -Raw" in run, "read it as a string before Create"
        # code lines only — the comments are ALLOWED (and required) to say
        # ".Content" while explaining the byte-array trap
        code = "\n".join(
            line for line in run.splitlines()
            if not line.strip().startswith("#")
        )
        assert ".Content" not in code, (
            "no bare .Content into scriptblock::Create — it is a byte array")

    def test_unix_rc_grep_only_reads_existing_files(self):
        # grep over TWO rc files where one does not exist exits 2 (an ERROR,
        # not "no match"), and set -e turns that into a red job. Run 1: ubuntu
        # died here, macOS passed (both its files existed).
        run = _runs(_load()["jobs"]["unix"])
        assert 'if [ -f "$f" ]' in run, "only grep files that exist"
        assert '[ -n "$rcs" ] && grep' in run, "never grep an empty list (stdin hang)"

    def test_unix_asserts_the_effect_not_one_mechanism(self):
        # Run 2: ubuntu runners already have .local/bin on PATH, so the
        # installer CORRECTLY wrote no rc line (NEEDS_PATH=0) — and my
        # assertion demanded one, failing a healthy install. The contract is
        # the EFFECT: hivv resolves from PATH, or its line is in an rc.
        run = _runs(_load()["jobs"]["unix"])
        assert "command -v hivv" in run, "the already-on-PATH case"
        assert 'grep -q "$HOME/.local/bin"' in run, "the rc-written case"
        assert "neither on PATH nor written to any shell rc" in run, (
            "and both failing must fail the job, loudly")
