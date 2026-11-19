#!/usr/bin/env python3
"""Pre-push secret scanner for the HIVV repository.

Ported from blnq.org's scanner (which itself is excellent): two things get
scanned, because they leak in two different ways:

  A) the WORKING SET — everything `git add -A` would stage. .gitignore guards
     this, so this pass proves the guards actually hold.
  B) git HISTORY — every blob ever committed. A secret committed in 2024 and
     deleted in 2025 is still fully public once the repo is pushed, and no
     .gitignore rule can reach it.

Findings are reported as file:line + the PATTERN that matched, never the value —
printing a live credential into a report (or a chat log) is itself a leak.

Run:  python3 scripts/scan_secrets.py
      python3 scripts/scan_secrets.py --history-only
Exit: 0 = clean, 1 = findings to review.

Install as a git hook (runs automatically on commit):
    ln -sf ../../scripts/scan_secrets.py .git/hooks/pre-commit
"""
from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── patterns ───────────────────────────────────────────────────────────────
# (name, regex, severity)   severity: BLOCK = do not push, WARN = review
#
# Key-block rules require the base64 BODY and the END marker, not just the
# header. Two reasons: (1) a header line alone is not a credential, and
# (2) a detector must not match its own pattern text — requiring the body
# is what stops this file from flagging the very line that defines these
# regexes.
PATTERNS = [
    ("private key",            r"-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\sA-Za-z0-9+/=]{40,}?-----END", "BLOCK"),
    ("PGP key block",          r"-----BEGIN PGP PRIVATE KEY BLOCK-----[\sA-Za-z0-9+/=]{40,}?-----END PGP PRIVATE KEY BLOCK", "BLOCK"),
    ("AWS access key",         r"\bAKIA[0-9A-Z]{16}\b", "BLOCK"),
    ("AWS secret key",         r"(?i)\baws_secret_access_key[ \t]*[=:][ \t]*['\"]?[A-Za-z0-9/+=]{30,}", "BLOCK"),
    ("OpenAI-style key",       r"\bsk-[A-Za-z0-9][A-Za-z0-9\-_]{18,}", "BLOCK"),
    ("Anthropic key",          r"\bsk-ant-[A-Za-z0-9\-_]{20,}", "BLOCK"),
    ("Google API key",         r"\bAIza[0-9A-Za-z_\-]{35}\b", "BLOCK"),
    ("GitHub token",           r"\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}", "BLOCK"),
    ("GitLab token",           r"\bglpat-[A-Za-z0-9_\-]{20,}", "BLOCK"),
    ("Slack token",            r"\bxox[baprs]-[A-Za-z0-9\-]{10,}", "BLOCK"),
    ("Slack webhook",          r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+", "BLOCK"),
    ("SendGrid key",           r"\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}", "BLOCK"),
    ("Stripe key",             r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}", "BLOCK"),
    ("Twilio key",             r"\bAC[0-9a-fA-F]{32}\b", "BLOCK"),
    ("Discord token",          r"[MN][A-Za-z0-9_\-]{23,}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27,}", "BLOCK"),
    ("JWT",                    r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", "WARN"),
    ("connection string pwd",  r"(?i)\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqp)://[^\s:/@]+:[^\s@/]{3,}@", "BLOCK"),
    ("assigned password",      r"(?i)(?:password|passwd|pwd)[ \t]*[=:][ \t]*['\"][^'\"\s]{4,}['\"]", "BLOCK"),
    ("assigned secret/token",  r"(?i)(?:secret|api_key|apikey|api[_-]key|access[_-]token|auth[_-]token|private[_-]key)[ \t]*[=:][ \t]*['\"][^'\"\s]{6,}['\"]", "BLOCK"),
    ("hardcoded bearer",       r"(?i)\bBearer\s+[A-Za-z0-9._\-]{24,}", "BLOCK"),
    # HIVV-specific: the env vars that carry real material.
    ("hivv session secret",    r"HIVV_SESSION_SECRET[ \t]*[=:][ \t]*['\"]?[0-9a-f]{32,}", "BLOCK"),
    ("hivv encryption key",    r"HIVV_ENCRYPTION_KEY[ \t]*[=:][ \t]*['\"]?[0-9a-f]{64}", "BLOCK"),
    # A control token / donor salt is only a LEAK when a LITERAL value is
    # committed. `HIVV_CONTROL_TOKEN: process.env.HIVV_CONTROL_TOKEN || …` is
    # an env-var READ — the safe pattern the gateway actually ships (since
    # 553c1fe "never ship runtime secrets in the repository"). The old regex
    # matched `process.env.HIVV_CONTROL_TOKEN` as a 30+ char literal, so the
    # scanner failed-closed on the SAFEST line in the repo and every push
    # needed a manual bypass — which trains people to bypass the scanner.
    # These match a literal (quoted or bare) and explicitly NOT `process.env`.
    ("hivv control token",     r"HIVV_CONTROL_TOKEN[ \t]*[=:][ \t]*(?!process\.env\b)(?!require\b)['\"]?[A-Za-z0-9][^\s'\"]{15,}", "WARN"),
    ("hivv scan key",          r"HIVV_SCAN_KEY[ \t]*[=:][ \t]*['\"]?[0-9a-f]{32,}", "BLOCK"),
    ("hivv donor salt",        r"HIVV_DONOR_SALT[ \t]*[=:][ \t]*(?!process\.env\b)(?!require\b)['\"]?[A-Za-z0-9][^\s'\"]{15,}", "WARN"),
    ("ed25519 hex seed (32B)", r"(?i)\b[0-9a-f]{64}\b(?=[^\n]{0,40}(?:seed|priv|secret))", "WARN"),
]

# Host / infra layout — not credentials, but publishes the box's map to anyone.
NOISE_PATTERNS = [
    ("private RFC1918 IP",  r"\b192\.168\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"),
    ("vhost absolute path", r"/var/www/vhosts/[a-z0-9.\-]+"),
]

BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
              ".ttf", ".eot", ".zip", ".gz", ".tar", ".pdf", ".bin", ".pyc"}


def _blank_prose(text: str) -> str:
    """Replace comments and docstrings with spaces, preserving byte offsets.

    A MENTION of a credential in documentation is not a credential: the usage
    line inside a module docstring (`Run: HIVV_SESSION_SECRET=... python3 x.py`)
    is instruction, not a leaked value.

    Ordinary string literals are deliberately left ALONE. `password = "hunter2"`
    IS the secret, and blanking strings would blind the scanner to precisely
    the thing it exists to find. Only `#` comments and triple-quoted blocks are
    removed; a `#` inside an ordinary string is consumed as part of that
    string, so `"http://x/#frag"` does not truncate the line.

    Offsets are preserved (blanked, not deleted) so reported line numbers
    still point at the original file.
    """
    out = list(text)
    n = len(text)
    i = 0

    def blank(a: int, b: int) -> None:
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = text[i]
        if c == "#":
            j = i
            while j < n and text[j] != "\n":
                j += 1
            blank(i, j)
            i = j
        elif c in "\"'":
            q = c
            if text.startswith(q * 3, i):          # docstring / block literal
                end = text.find(q * 3, i + 3)
                stop = n if end == -1 else end + 3
                blank(i, stop)
                i = stop
            else:                                  # ordinary literal: keep it
                i += 1
                while i < n and text[i] != q:
                    if text[i] == "\\":
                        i += 1
                    if i < n and text[i] == "\n":
                        break
                    i += 1
                i += 1
        else:
            i += 1
    return "".join(out)


def _load_ignore():
    """Read .secret-guard-ignore.

    Two forms are supported:

      `file:line`   — the original form. EXACT match. It rots the moment a
                      line above it is added or removed: the entry stops
                      applying, the finding reappears, and the push is
                      blocked with nothing to say the ignore list went
                      stale. (That is exactly how `api/ecosystem.config.js:29`
                      became `:47` and silently rotted.)
      `file:glob`   — a GLOB on the line number, e.g. `api/ecosystem.config.js:*`
                      or `api/ecosystem.config.js:2*`. Survives line drift,
                      which is what a moving file needs.

    Every entry is a place a real secret could hide, so keep it short: the
    scanner checks this BEFORE reporting, so a test fixture does not drown
    the signal — but a NEW real leak is never in here.
    """
    p = ROOT / ".secret-guard-ignore"
    if not p.exists():
        return set(), set()
    exact, globs = set(), []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if ":" not in line:
            continue
        src, _, spec = line.rpartition(":")
        # Distinguish a `file:line` entry from a bare REGEX (which belongs to
        # the GENERIC machine-wide hook and lives in .secret-guard-suppress).
        #
        # A repo-relative path may or may not contain a slash:
        #   setup.sh:66            ← no slash, still a file:line entry
        #   api/server.js:2919     ← slash, file:line entry
        #   process\.env\.HIVV_…   ← a regex, not a file:line entry
        # The tell is the SPEC: a file:line entry's spec is a line number
        # (or a glob of digits). A regex spec is anything else.
        #
        # Order matters: a GLOB spec ("2*", "*") also looks digit-ish, so the
        # glob test has to come first.
        # A path may or may not contain a slash (setup.sh, .secret-guard-…),
        # so the glob branch must not require one — the SPEC is what tells a
        # file:glob entry apart from a bare regex.
        if any(ch in spec for ch in "*?["):
            globs.append((src, spec))
        elif spec.isdigit():
            exact.add(line)
        # anything else is a bare regex → belongs to the generic hook, not here
    return exact, globs


_IGNORE, _IGNORE_GLOBS = _load_ignore()


def _ignored(source: str, lineno: int) -> bool:
    if f"{source}:{lineno}" in _IGNORE:
        return True
    for src, spec in _IGNORE_GLOBS:
        if src == source and fnmatch.fnmatchcase(str(lineno), spec):
            return True
    return False


def scan_text(text: str, source: str):
    """Yield (severity, kind, lineno, source) for every match."""
    code_only = _blank_prose(text)
    for kind, rx, sev in PATTERNS:
        for m in re.finditer(rx, code_only):
            lineno = text.count("\n", 0, m.start()) + 1
            if _ignored(source, lineno):
                break  # known fixture — skip silently
            yield sev, kind, lineno, source
            break  # one finding per kind per file is enough to act on
    if source.endswith(("AGENTS.md", "CLAUDE.md", "SITE-NOTES.md", "PORTMAP.md",
                       "README.md", "CONTRIBUTING.md")):
        return  # already ignored; don't drown the signal
    for kind, rx in NOISE_PATTERNS:
        m = re.search(rx, text)
        if m:
            lineno = text.count("\n", 0, m.start()) + 1
            if _ignored(source, lineno):
                continue
            yield "NOISE", kind, lineno, source


def committed_files() -> list[str]:
    """Everything git would stage, as INDIVIDUAL FILES.

    `git status --porcelain` collapses a wholly-untracked directory into one
    entry (`?? api/lib/`), which a naive is_file() filter then discards —
    silently excluding every file inside it. `git ls-files --others
    --exclude-standard` returns real paths and honours .gitignore, which is
    precisely the contract we need to test.
    """
    def git(args: list[str]) -> list[str]:
        r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
        return [l for l in r.stdout.splitlines() if l.strip()]

    tracked = git(["ls-files"])
    untracked = git(["ls-files", "--others", "--exclude-standard"])
    modified = [ln[3:].strip().split(" -> ")[-1]
                for ln in subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                                         capture_output=True, text=True).stdout.splitlines()
                if ln[:2] in (" M", "M ", "A ", "MM")]
    return sorted({f for f in tracked + untracked + modified
                   if f and not f.endswith("/") and not (ROOT / f).is_dir()})


def read(p: Path) -> str | None:
    if p.suffix.lower() in BINARY_EXT:
        return None
    try:
        return p.read_text(encoding="utf-8", errors="strict")
    except Exception:
        try:
            return p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None


def scan_history():
    """Every blob ever committed. .gitignore cannot help here."""
    shas = subprocess.run(["git", "rev-list", "--objects", "--all"], cwd=ROOT,
                          capture_output=True, text=True).stdout.splitlines()
    seen, findings = set(), []
    for entry in shas:
        parts = entry.split(" ", 1)
        sha = parts[0]
        name = parts[1] if len(parts) > 1 else ""
        if sha in seen:
            continue
        seen.add(sha)
        cat = subprocess.run(["git", "cat-file", "-p", sha], cwd=ROOT,
                             capture_output=True)
        if cat.returncode != 0 or len(cat.stdout) > 2_000_000:
            continue
        try:
            text = cat.stdout.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for sev, kind, lineno, _ in scan_text(text, name):
            findings.append((sev, kind, name or sha[:8], lineno))
    return findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--history-only", action="store_true",
                    help="skip the working set, scan only git history")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    blocks, warns, noise = [], [], []
    files = [] if args.history_only else committed_files()

    if not args.history_only:
        for rel in files:
            p = ROOT / rel
            if not p.is_file():
                continue
            text = read(p)
            if not text:
                continue
            for sev, kind, lineno, src in scan_text(text, rel):
                (blocks if sev == "BLOCK" else warns if sev == "WARN" else noise).append(
                    (kind, src, lineno))

    hist = [] if args.history_only or not (ROOT / ".git").exists() else scan_history()
    # History findings are (sev, kind, name, lineno); strip the severity so the
    # shared report() helper can unpack them as (kind, src, lineno).
    hblocks = [(k, s, n) for sev, k, s, n in hist if sev == "BLOCK"]
    hwarns = [(k, s, n) for sev, k, s, n in hist if sev == "WARN"]

    if args.json:
        import json
        print(json.dumps({
            "working_set": {"files": len(files), "block": len(blocks),
                            "warn": len(warns), "noise": len(noise)},
            "history": {"block": len(hblocks), "warn": len(hwarns)},
            "block_findings": [{"kind": k, "file": f, "line": l} for k, f, l in blocks + hblocks],
            "warn_findings": [{"kind": k, "file": f, "line": l} for k, f, l in warns + hwarns],
        }, indent=2))
        return 1 if (blocks or hblocks or warns or hwarns) else 0

    print("=" * 74)
    print("HIVV PRE-PUSH SECRET SCAN")
    print("=" * 74)

    if not args.history_only:
        print(f"\nA) working set — {len(files)} file(s) git would stage\n")

    def report(title, items, marker, colour):
        print(f"  {marker} {title}: {len(items)}")
        for kind, src, lineno in items:
            print(f"      \x1b[{colour}m{kind}\x1b[0m  {src}:{lineno}")
        if not items:
            print("      (none)")

    report("BLOCK — do not push until resolved", blocks, "✗", "31")
    report("WARN — review these", warns, "!", "33")
    report("NOISE — infra layout (already gitignored where sensitive)", noise, "·", "36")

    if not args.history_only and (ROOT / ".git").exists():
        ncommits = len(subprocess.run(["git", "rev-list", "--all"], cwd=ROOT,
                                      capture_output=True, text=True).stdout.split())
        print(f"\nB) git history — {ncommits} commit(s)\n")
        report("BLOCK — secrets in history", hblocks, "✗", "31")
        report("WARN — review in history", hwarns, "!", "33")

    total = len(blocks) + len(hblocks)
    print("\n" + "=" * 74)
    if total:
        print(f"\x1b[1m\x1b[31m{total} BLOCKING finding(s) — do not push.\x1b[0m")
        return 1
    if warns or hwarns:
        print(f"\x1b[1m\x1b[33m{len(warns) + len(hwarns)} warning(s) — review before pushing.\x1b[0m")
        return 1
    print("\x1b[1m\x1b[32mCLEAN — no blocking or warning findings.\x1b[0m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
