"""Tests for the `hivv nodes` table: it must FIT the terminal, and the
hive TOTALS row must be right.

Why this matters
----------------
`hivv nodes` used to print a 12-column table ~186 characters wide. In any
terminal narrower than that the output wrapped into unreadable mush, and
the columns that wrapped were the ones that matter (cores, RAM, GPU). The
table now measures the real terminal width and drops the least important
columns until it fits.

The TOTALS row answers the question the per-bee rows cannot: how big is
this hive and how fast is it running right now. It is easy to get subtly
wrong — counting a stale bee's RAM as live capacity, for instance — so it
is pinned here.

Pure formatting + pure arithmetic: no network, no hub.
"""
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli"] = hivv
spec.loader.exec_module(hivv)

ANSI = re.compile(r"\033\[[0-9;]*[A-Za-z]")


def _gateway_up() -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen("http://localhost:3011/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def vis(s: str) -> int:
    """Visible width (ANSI escapes are not width)."""
    return len(ANSI.sub("", s))


def node(name="bee", status="online", tps=0.0, mem_total=8192, mem_used=4096,
         phys=4, threads=8, gpu_mem=4096, gpu_used=0, models=1, tokens=0):
    return {
        "id": name, "name": name, "status": status, "version": "0.2.abc12345",
        "local_models": [{"model": f"{name}-model", "provider": "llama.cpp:8080"}] * models,
        "system": {"cpus": threads, "cpu_physical": phys, "arch": "x86_64"},
        "metrics": {"mem_total_mb": mem_total, "mem_used_mb": mem_used,
                    "mem_percent": int(mem_used * 100 / max(1, mem_total))},
        "gpus": ([{"name": "Test GPU", "mem_total_mb": gpu_mem,
                   "mem_used_mb": gpu_used, "util_pct": 0}] if gpu_mem else []),
        "stats": {"tokens_per_sec": tps, "total_tokens_processed": tokens},
        "quality_score": None,
    }


class TestTermWidth:
    def test_defaults_when_no_tty(self, monkeypatch):
        monkeypatch.delenv("HIVV_COLUMNS", raising=False)
        monkeypatch.delenv("COLUMNS", raising=False)
        monkeypatch.setattr(hivv.shutil if hasattr(hivv, "shutil") else __import__("shutil"),
                            "get_terminal_size", lambda fallback=(100, 24): os_size(fallback))
        w = hivv._term_width()
        assert 40 <= w <= 400

    def test_env_override_wins(self, monkeypatch):
        monkeypatch.setenv("HIVV_COLUMNS", "77")
        assert hivv._term_width() == 77

    def test_absurd_override_is_clamped(self, monkeypatch):
        monkeypatch.setenv("HIVV_COLUMNS", "99999")
        assert hivv._term_width() <= 400

    def test_tiny_override_is_clamped(self, monkeypatch):
        monkeypatch.setenv("HIVV_COLUMNS", "5")
        assert hivv._term_width() >= 40


def os_size(fallback):
    class S:
        columns = fallback[0]
        lines = fallback[1]
    return S()


class TestTruncation:
    def test_short_string_untouched(self):
        assert hivv._trunc("hello", 10) == "hello"

    def test_long_string_truncated_to_visible_width(self):
        out = hivv._trunc("abcdefghijklmnop", 8)
        assert vis(out) <= 8
        assert out.endswith("…")

    def test_ansi_is_not_counted_as_width(self):
        coloured = "\033[32mabcdefghij\033[0m"
        out = hivv._trunc(coloured, 6)
        # 5 visible chars + the ellipsis = 6
        assert vis(out) <= 6

    def test_colour_is_reclosed(self):
        coloured = "\033[32mabcdefghij\033[0m"
        out = hivv._trunc(coloured, 6)
        assert out.endswith("\033[0m"), "a truncated cell must not leak colour"

    def test_zero_width(self):
        assert hivv._trunc("abc", 0) == ""


class TestWrapText:
    def test_wraps_at_width(self):
        lines = hivv._wrap_text("aaa bbb ccc ddd eee", 7)
        assert all(len(l) <= 7 for l in lines)
        assert " ".join(lines) == "aaa bbb ccc ddd eee"

    def test_long_word_is_not_chopped(self):
        lines = hivv._wrap_text("short https://example.com/a/very/long/path", 10)
        assert any("https://example.com/a/very/long/path" in l for l in lines)

    def test_empty(self):
        assert hivv._wrap_text("", 10) == [""]


class TestFitTable:
    def test_wide_table_drops_columns(self, monkeypatch):
        monkeypatch.setenv("HIVV_COLUMNS", "30")
        headers = ["A", "B", "C", "D", "E"]
        rows = [["a" * 10, "b" * 10, "c" * 10, "d" * 10, "e" * 10]]
        heads, out = hivv._fit_table(headers, rows, [10] * 5)
        assert len(heads) < 5, "a too-wide table must drop columns"
        assert len(heads) == len(out[0]), "header and row must stay aligned"

    def test_narrow_table_keeps_everything(self, monkeypatch):
        monkeypatch.setenv("HIVV_COLUMNS", "200")
        headers = ["A", "B", "C"]
        rows = [["a", "b", "c"]]
        heads, out = hivv._fit_table(headers, rows, [10, 10, 10])
        assert len(heads) == 3

    def test_always_keeps_at_least_one_column(self, monkeypatch):
        monkeypatch.setenv("HIVV_COLUMNS", "40")
        headers = ["A" * 50, "B" * 50]
        rows = [["x" * 50, "y" * 50]]
        heads, out = hivv._fit_table(headers, rows, [50, 50])
        assert len(heads) >= 1
        assert len(out[0]) == len(heads)

    def test_empty_rows(self):
        heads, out = hivv._fit_table(["A", "B"], [], [5, 5])
        assert len(heads) == 2
        assert out == []


class TestHiveTotals:
    def test_sums_tps(self):
        nodes = [node(name="a", tps=10.5), node(name="b", tps=4.5)]
        t = hivv._hive_totals(nodes, {})
        assert t["tps"] == pytest.approx(15.0)

    def test_counts_bees_and_online(self):
        nodes = [node(name="a"), node(name="b"), node(name="c", status="offline")]
        t = hivv._hive_totals(nodes, {})
        assert t["bees"] == 3
        assert t["online"] == 2

    def test_quarantined_bee_counts_as_registered_capacity(self):
        """The hub counts a quarantined bee as online (status !== 'offline').

        The totals row must agree with the hub's own number, or the hive
        looks smaller than the hub says it is."""
        nodes = [node(name="a"), node(name="q", status="quarantined")]
        t = hivv._hive_totals(nodes, {})
        assert t["online"] == 2

    def test_offline_bee_ram_is_excluded(self):
        """A bee that has not heartbeated contributes NO live capacity.

        Counting its RAM would make the hive look bigger than it is."""
        nodes = [node(name="a", mem_total=8192), node(name="dead", status="offline",
                                                      mem_total=65536)]
        t = hivv._hive_totals(nodes, {})
        assert t["ram_total_mb"] == 8192

    def test_sums_cores_and_threads(self):
        nodes = [node(name="a", phys=8, threads=16), node(name="b", phys=4, threads=8)]
        t = hivv._hive_totals(nodes, {})
        assert t["cores"] == 12
        assert t["threads"] == 24

    def test_sums_ram(self):
        nodes = [node(name="a", mem_total=8192, mem_used=4096),
                 node(name="b", mem_total=8192, mem_used=1024)]
        t = hivv._hive_totals(nodes, {})
        assert t["ram_total_mb"] == 16384
        assert t["ram_used_mb"] == 5120

    def test_sums_gpu_memory_and_count(self):
        nodes = [node(name="a", gpu_mem=4096, gpu_used=2048),
                 node(name="b", gpu_mem=8192, gpu_used=0)]
        t = hivv._hive_totals(nodes, {})
        assert t["gpu_count"] == 2
        assert t["gpu_mem_total_mb"] == 12288
        assert t["gpu_mem_used_mb"] == 2048

    def test_average_ping(self):
        pings = {"a": 10, "b": 20, "c": 60}
        nodes = [node(name="a"), node(name="b"), node(name="c")]
        t = hivv._hive_totals(nodes, pings)
        assert t["avg_ping"] == pytest.approx(30.0)
        assert t["ping_n"] == 3

    def test_no_pings_gives_none_not_zero(self):
        t = hivv._hive_totals([node(name="a")], {})
        assert t["avg_ping"] is None

    def test_counts_models(self):
        nodes = [node(name="a", models=2), node(name="b", models=1)]
        t = hivv._hive_totals(nodes, {})
        assert t["models"] == 3

    def test_empty_node_list(self):
        t = hivv._hive_totals([], {})
        assert t["bees"] == 0
        assert t["tps"] == 0.0

    def test_non_numeric_tps_is_ignored(self):
        n = node(name="a")
        n["stats"]["tokens_per_sec"] = "not-a-number"
        t = hivv._hive_totals([n], {})
        assert t["tps"] == 0.0

    def test_missing_metrics_do_not_crash(self):
        n = {"id": "x", "name": "x", "status": "online"}
        t = hivv._hive_totals([n], {})
        assert t["bees"] == 1
        assert t["ram_total_mb"] == 0


class TestBuiltColumn:
    """VERSION is a content hash — equality, not a date. The BUILT column
    answers the human question ('is that from last week?') with the
    author date of the commit that shipped that exact hash (2026-11-23)."""

    def test_headers_and_widths_include_built(self):
        src = CLI_PATH.read_text()
        assert '"BUILT"' in src, "the nodes table needs the BUILT column"
        # width16 = 'YYYY-MM-DD HH:MM'
        assert "IDEAL = [16, 9, 12, 16," in src

    def test_row_carries_version_date(self):
        src = CLI_PATH.read_text()
        assert 'n.get("version_date")' in src, (
            "the row must read version_date from the payload"
        )

    def test_payload_provides_version_date(self):
        src = (REPO / "api" / "routes" / "control-routes.js").read_text()
        assert "version_date" in src
        assert "version-date" in src, "must use the git-backed helper"

    def test_helper_exists_and_parses(self):
        r = subprocess.run(["node", "--check",
                            str(REPO / "api" / "lib" / "version-date.js")],
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr

    @pytest.mark.skipif(not _gateway_up(), reason="gateway not running")
    def test_live_payload_has_wellformed_dates(self):
        import urllib.request
        with urllib.request.urlopen(
                "http://localhost:3011/api/control/nodes", timeout=10) as r:
            data = json.loads(r.read().decode())
        pat = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
        for n in data.get("nodes", []):
            vd_ = n.get("version_date")
            if vd_ is None:
                continue          # uncommitted or unknown → table shows '—'
            assert pat.match(vd_), f"bad date {vd_!r} for {n.get('name')}"
        # NO ">=1 dated node" assertion: bees auto-update from the WORKTREE
        # the hub serves, so "every version uncommitted" is the NORMAL steady
        # state — it failed exactly that way on 2026-11-25 with all six bees
        # tracking uncommitted work. The map's health is pinned
        # deterministically by test_git_map_resolves_a_known_commit below.

    def test_git_map_resolves_a_known_commit(self):
        """The map machinery itself: a KNOWN committed blob → a date;
        an unknown sha → null. Deterministic — no fleet dependence.

        (The live test above used to require >=1 dated node, but bees follow
        the served worktree, so a fully-uncommitted fleet is valid state.)
        """
        rev = subprocess.run(
            ["git", "log", "--format=%H", "-1", "--", "public_html/hivv-cli.py"],
            cwd=str(REPO), capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        assert rev, "no commits touch the CLI file?"
        blob = subprocess.run(
            ["git", "cat-file", "blob", f"{rev}:public_html/hivv-cli.py"],
            cwd=str(REPO), capture_output=True, timeout=60,
        ).stdout
        assert blob, "could not read the committed blob"
        sha8 = hashlib.sha256(blob).hexdigest()[:8]
        node_script = (
            "const vd = require(process.env.VDF);\n"
            "const d = vd.forVersion(process.env.VSHA);\n"
            "const u = vd.forVersion('deadbeef');\n"
            "if (!/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/.test(d || '')) "
            "{ console.error('bad date:', d); process.exit(1); }\n"
            "if (u !== null) { console.error('unknown sha must be null:', u); process.exit(1); }\n"
            "console.log('ok', d);\n"
        )
        r = subprocess.run(
            ["node", "-e", node_script],
            env=dict(os.environ,
                     VDF=str(REPO / "api" / "lib" / "version-date.js"),
                     VSHA=sha8),
            capture_output=True, text=True, timeout=90,
        )
        assert r.returncode == 0, r.stdout + r.stderr
        assert "ok" in r.stdout, r.stdout
