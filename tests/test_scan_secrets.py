"""Regression tests for the pre-push secret scanner (scripts/scan_secrets.py).

The scanner is the LAST gate before a commit reaches GitHub. Two failure
modes matter and they pull in opposite directions:

  1. A FALSE NEGATIVE — a real literal secret slips through and is pushed.
     Unacceptable: the whole point of the scanner is that a human never has
     to remember to look.

  2. A FALSE POSITIVE — a safe pattern (an env-var READ) is flagged. The
     scanner exits non-zero on ANY warning, so a false positive BLOCKS the
     push. The workaround people reach for is the bypass flag, and a
     bypassable gate is no gate at all. This repo lived with exactly that:
     `HIVV_CONTROL_TOKEN: process.env.HIVV_CONTROL_TOKEN` — the SAFEST
     line in the codebase — was flagged as "hivv control token", so every
     push needed SECRET_GUARD_OK=1.

These tests pin BOTH directions so neither can regress.
"""
import importlib.util
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCANNER = REPO / "scripts" / "scan_secrets.py"

spec = importlib.util.spec_from_file_location("scan_secrets", SCANNER)
scan = importlib.util.module_from_spec(spec)
sys.modules["scan_secrets"] = scan
spec.loader.exec_module(scan)


def match(kind, text):
    """Run one pattern against `text`; return the match or None."""
    for name, pattern, sev in scan.PATTERNS:
        if name == kind:
            m = re.search(pattern, text)
            return m
    raise AssertionError(f"pattern {kind!r} not found in PATTERNS")


class TestControlToken:
    """The control token: a literal is a leak, an env-var read is not."""

    def test_env_var_read_is_not_flagged(self):
        """The line the gateway actually ships must be clean."""
        line = ("      HIVV_CONTROL_TOKEN: process.env.HIVV_CONTROL_TOKEN || "
                "(function () { return require('fs').readFileSync("
                "__dirname + '/.control-token', 'utf8').trim() || ''; })(),")
        assert match("hivv control token", line) is None, (
            "an env-var READ must not be reported as a leaked control token — "
            "it is the pattern the gateway ships and it BLOCKS every push"
        )

    def test_literal_control_token_is_flagged(self):
        """A real literal must still be caught."""
        # Built at runtime: a literal secret written into this file would be
        # flagged by the very scanner this module tests (and rightly so).
        line = "      HIVV_CONTROL_TOKEN: '" + ("a" * 32) + "',"
        assert match("hivv control token", line) is not None, (
            "a literal control token MUST be flagged"
        )

    def test_bare_literal_control_token_is_flagged(self):
        line = "  HIVV_CONTROL_TOKEN=" + ("a" * 32)
        assert match("hivv control token", line) is not None


class TestDonorSalt:
    def test_env_var_read_is_not_flagged(self):
        line = "  HIVV_DONOR_SALT: process.env.HIVV_DONOR_SALT || 'default'"
        assert match("hivv donor salt", line) is None

    def test_literal_is_flagged(self):
        line = "  HIVV_DONOR_SALT: '" + ("z" * 32) + "'"
        assert match("hivv donor salt", line) is not None


class TestStillCatchesRealSecrets:
    """Fixing the false positive must NOT weaken the real detections."""

    @pytest.mark.parametrize("kind,sample", [
        ("hivv session secret", "HIVV_SESSION_SECRET: " + "a" * 40),
        ("hivv encryption key", "HIVV_ENCRYPTION_KEY: " + "b" * 64),
        ("hivv scan key", "HIVV_SCAN_KEY: " + "c" * 32),
        ("Anthropic key", "sk-ant-" + "x" * 30),
        ("OpenAI-style key", "sk-" + "y" * 24),
        ("GitHub token", "ghp_" + "z" * 36),
        ("private key", "-----BEGIN RSA PRIVATE KEY-----" + "A" * 60 +
         "-----END"),
        ("AWS access key", "AKIA" + "1234567890ABCDEF"),
        ("Stripe key", "sk_live_" + "q" * 24),
    ])
    def test_real_secret_is_detected(self, kind, sample):
        assert match(kind, sample) is not None, (
            f"{kind!r} must still detect a real secret"
        )

    def test_severity_of_control_token_stays_warn(self):
        """It is a WARN, not a BLOCK — but a WARN still blocks the push."""
        sev = {n: s for n, p, s in scan.PATTERNS}["hivv control token"]
        assert sev == "WARN"


class TestShippedFilesAreClean:
    """The repo's own tree must scan clean — the scanner dogfoods itself."""

    def test_ecosystem_config_env_reads_are_clean(self):
        src = (REPO / "api" / "ecosystem.config.js").read_text()
        assert match("hivv control token", src) is None
        assert match("hivv session secret", src) is None
        assert match("hivv encryption key", src) is None

    def test_scanner_exits_zero_on_the_repo(self):
        """A clean tree must exit 0, or the hook blocks every push."""
        import subprocess
        r = subprocess.run([sys.executable, str(SCANNER)],
                           capture_output=True, text=True, cwd=REPO)
        assert r.returncode == 0, (
            "the scanner must exit 0 on its own repo:\n" + r.stdout[-3000:]
        )
