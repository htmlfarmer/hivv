"""Tests for the TESTMAP — the source → tests lookup.

WHY THIS EXISTS
"I edited <file>. Which tests do I run?" — until now the answer was
"all of them" (100s) or tribal knowledge. The map (tests/TESTMAP.json +
TESTMAP.md, built by static analysis in tests/gen_testmap.py, consumed by
`hivv tests-for`) turns it into a lookup.

THE FRESHNESS CONTRACT (the whole point)
A map that silently goes stale is worse than no map: it answers with
confidence and is wrong. So the committed map is compared byte-for-byte
against a fresh regeneration — add a test file, change a reference, and
this suite fails with "run python3 tests/gen_testmap.py". The map rots
loudly or not at all.

Also pinned: the map UNDER-claims by design (static analysis cannot see
runtime-computed paths), so unmapped files must always fall back to "run
the full suite" advice — never a false "you're covered".
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
GEN_PATH = REPO / "tests" / "gen_testmap.py"
MAP_JSON = REPO / "tests" / "TESTMAP.json"
MAP_MD = REPO / "tests" / "TESTMAP.md"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


gen = _load("gen_testmap", GEN_PATH)
cli_spec = importlib.util.spec_from_file_location("hivv_cli_tm", CLI_PATH)
hivv = importlib.util.module_from_spec(cli_spec)
sys.modules["hivv_cli_tm"] = hivv
cli_spec.loader.exec_module(hivv)


class TestMapIsFresh:
    def test_committed_json_matches_regeneration(self):
        """THE contract: add a test or a reference without regenerating → red."""
        fresh = json.dumps(gen.build(), indent=1, sort_keys=True) + "\n"
        committed = MAP_JSON.read_text(encoding="utf-8")
        assert committed == fresh, (
            "tests/TESTMAP.json is STALE — regenerate it:\n"
            "    python3 tests/gen_testmap.py\n"
            "(or: hivv tests-for --refresh <any file>)"
        )

    def test_committed_markdown_matches_regeneration(self):
        fresh = gen.render_md(gen.build())
        committed = MAP_MD.read_text(encoding="utf-8")
        assert committed == fresh, (
            "tests/TESTMAP.md is STALE — regenerate it:\n"
            "    python3 tests/gen_testmap.py"
        )


class TestMapIntegrity:
    def test_every_test_file_is_listed(self):
        mapping = json.loads(MAP_JSON.read_text())
        for tf in sorted((REPO / "tests").glob("test_*.py")):
            rel = str(tf.relative_to(REPO))
            assert rel in mapping["tests"], (
                f"{rel} missing from the map — regenerate"
            )
        api_tests = REPO / "api" / "tests"
        if api_tests.is_dir():
            for tf in sorted(api_tests.glob("*.test.js")):
                rel = str(tf.relative_to(REPO))
                assert rel in mapping["tests"], (
                    f"{rel} missing from the map — regenerate"
                )

    def test_every_mapped_source_exists(self):
        """No dead references: a file the map points at must be real."""
        mapping = json.loads(MAP_JSON.read_text())
        for src in mapping["sources"]:
            assert (REPO / src).exists(), (
                f"the map references {src}, which no longer exists — regenerate"
            )

    def test_the_cli_is_mapped_to_many_tests(self):
        """A canary against extractor collapse: the most-tested file in the
        repo must map to a real pile of tests. If this drops to ~1, the
        extractor broke (it has: root-marker detection once missed every
        `REPO / ...` chain and under-claimed 15 files as 2)."""
        mapping = json.loads(MAP_JSON.read_text())
        hits = mapping["sources"].get("public_html/hivv-cli.py", [])
        assert len(hits) >= 10, (
            f"hivv-cli.py maps to only {len(hits)} test file(s) — "
            f"the extractor probably broke; regenerate and inspect"
        )

    def test_known_pairing_is_present(self):
        """Spot-check two pairings a human knows are true."""
        mapping = json.loads(MAP_JSON.read_text())
        assert "tests/test_rollback.py" in mapping["sources"]["public_html/hivv-cli.py"]
        assert "tests/test_setup_scripts.py" in mapping["sources"]["scripts/lib/deps.sh"]


class TestGeneratorIsDeterministic:
    def test_two_builds_are_identical(self):
        """Determinism is what makes the byte-for-byte freshness check
        meaningful — a timestamp or set-iteration order would make it
        fail randomly and train people to ignore it."""
        a = json.dumps(gen.build(), indent=1, sort_keys=True)
        b = json.dumps(gen.build(), indent=1, sort_keys=True)
        assert a == b


class TestTestsForCommand:
    def test_registered(self):
        assert hivv.COMMANDS.get("tests-for") is not None

    def test_parser_forms(self):
        p = hivv.build_parser()
        assert p.parse_args(["tests-for", "a.py", "b.py"]).paths == ["a.py", "b.py"]
        assert p.parse_args(["tests-for", "--diff"]).diff == ""
        assert p.parse_args(["tests-for", "--diff", "origin/main"]).diff == "origin/main"
        assert p.parse_args(["tests-for", "--refresh", "--strict"]).refresh is True

    def test_lookup_finds_the_cli_tests(self, monkeypatch, capsys):
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: REPO)
        per, missing = hivv._tests_for_paths(["public_html/hivv-cli.py"])
        assert missing == []
        assert "tests/test_rollback.py" in per["public_html/hivv-cli.py"]

    def test_lookup_accepts_absolute_paths(self, monkeypatch):
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: REPO)
        per, missing = hivv._tests_for_paths([str(CLI_PATH)])
        assert missing == []
        assert per

    def test_directory_reference_covers_files_inside(self, monkeypatch):
        """A test that references `public_html/` (globs it) covers a file
        inside — reported via the annotation, never silently.

        The query path is ASSEMBLED at runtime: any full-path literal in
        this file gets mapped by the generator (it did — "public_html/
        index.html" became an exact match because THIS test mentions it),
        which would bypass the ancestor branch being tested."""
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: REPO)
        mapping = json.loads(MAP_JSON.read_text())
        if "public_html" not in mapping["sources"]:
            pytest.skip("no directory-level reference in this map revision")
        q = str(Path("public_html") / ("synth" + "-file.css"))   # never a literal
        per, missing = hivv._tests_for_paths([q])
        assert missing == []
        assert any("via public_html/" in s for s in per[q]), (
            f"expected an ancestor-directory hit for {q}, got {per}"
        )

    def test_unknown_file_falls_back_to_full_suite(self, capsys, monkeypatch):
        """An unmapped file must NEVER read as 'covered' — the honest
        answer is 'run everything'."""
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: REPO)
        # LICENSE: no test references it (not a mapped top-level dir or root file)
        per, missing = hivv._tests_for_paths(["LICENSE"])
        assert "LICENSE" in missing, "an unmapped file must be reported"
        assert "LICENSE" not in per

    def test_run_command_has_no_display_annotations(self, monkeypatch, capsys):
        """The ' (via dir/)' annotation is display-only; if it leaked into
        the pytest line the command would be invalid shell."""
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: REPO)
        import argparse
        try:
            hivv.cmd_tests_for(argparse.Namespace(
                paths=["public_html/chat/app.js"], diff=None,
                refresh=False, strict=False))
        except SystemExit:
            pass
        out = capsys.readouterr().out
        for line in out.splitlines():
            if "pytest" in line:
                assert "(via" not in line, (
                    f"annotation leaked into the run command: {line!r}"
                )
                assert "pytest" in line

    def test_missing_map_self_builds(self, tmp_path, monkeypatch):
        """A missing map must not brick the command — first run builds it."""
        fake = tmp_path / "repo"
        (fake / "tests").mkdir(parents=True)
        (fake / ".git").mkdir()
        monkeypatch.setattr(hivv, "_find_repo_root", lambda: fake)
        mapping = hivv._load_testmap()
        assert isinstance(mapping, dict)
        # self-built or {} — never an exception
