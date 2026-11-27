#!/usr/bin/env python3
"""Run everything, then say WHOSE breakage it is.

WHY THIS EXISTS
---------------
With several agents working the same tree at once, "the suite is red" is not
a useful sentence. Three different things look identical in a summary line:

  1. the tree is broken by COMMITTED work (someone shipped a bug);
  2. the tree is broken by IN-FLIGHT work (a file mid-edit, a test half-written);
  3. the tree is fine and the test is flaky (it passes on a re-run).

Only (1) needs action now. (2) resolves itself when that agent finishes. (3)
must not be chased at all. A plain pass/fail count cannot tell them apart, so
people re-run the suite, argue about whose fault it is, and learn nothing.

WHAT IT DOES
------------
  * runs node --test, pytest and the secret scanner
  * for every failure, asks git: is the failing TEST file tracked and clean?
    are the source files under it tracked and clean?
  * prints one line per failure, attributed:
      IN-FLIGHT   the test file itself is uncommitted or modified
      COMMITTED   the test is clean, so the source under it moved
      FLAKY?      no source change is recorded at all -- re-run before believing it
  * ends with a verdict: GREEN, or what needs a human

USAGE
-----
  python3 scripts/test-attribution.py            # full run
  python3 scripts/test-attribution.py --quick    # node only
  python3 scripts/test-attribution.py --json     # machine-readable

The verdict is what to act on. The per-failure lines are what to read.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sh(cmd, timeout=1800, cwd=None):
    try:
        p = subprocess.run(cmd, cwd=cwd or REPO, capture_output=True, text=True,
                           timeout=timeout, errors="replace")
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT after %ss" % timeout
    except Exception as e:
        return 1, "could not run %s: %s" % (" ".join(cmd), e)


def git(*args):
    rc, out = sh(["git", *args], timeout=120)
    return out if rc == 0 else ""


# ---- what is in flight ----------------------------------------------------

def working_set():
    """(tracked-but-modified, untracked) paths, relative to the repo root."""
    out = git("status", "--porcelain", "--untracked-files=all")
    modified, untracked = set(), set()
    for line in out.splitlines():
        if len(line) < 4:
            continue
        code, path = line[:2], line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        if "??" in code:
            untracked.add(path)
        else:
            modified.add(path)
    return modified, untracked


def is_clean(path, modified, untracked):
    return path not in modified and path not in untracked


# ---- running --------------------------------------------------------------

# node's failure SUMMARY is the only place that names the FILE:
#     test at tests/foo.test.js:108:1
#     a bee whose heartbeat expired is NOT counted as online
NODE_FAIL = re.compile(
    r"^test at (\S+?):\d+:\d+\n\s*✖\s+(.+?)\s*$", re.M)

# pytest names the file and the test in one token.
PYTEST_FAIL = re.compile(r"^FAILED\s+(\S+)", re.M)


def run_node():
    # node --test discovers tests/ relative to CWD, and they live in api/tests.
    #
    # --test-timeout is NOT optional. node defaults to 0 (never), and the
    # full suite runs ~40 files in parallel against one gateway and a
    # handful of ports; a file that waits on a contended resource waits
    # FOREVER, and the whole run hangs with it. Measured: without this
    # the suite never finished; with it, 540 tests completed.
    rc, out = sh(["node", "--test", "--test-timeout=60000",
                  "--test-concurrency=4"],
                 timeout=1800, cwd=os.path.join(REPO, "api"))
    return rc, NODE_FAIL.findall(out), out


def run_pytest():
    rc, out = sh([sys.executable, "-m", "pytest", "tests/", "-q",
                  "--tb=no", "-p", "no:cacheprovider"], timeout=2400)
    return rc, PYTEST_FAIL.findall(out), out


def run_scanner():
    rc, out = sh([sys.executable, "scripts/scan_secrets.py"], timeout=600)
    # the scanner prints "  <name>  <file>:<line>" under a BLOCK/WARN heading
    findings = []
    severity = None
    for line in out.splitlines():
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if "BLOCK" in plain and "finding" not in plain.lower():
            severity = "BLOCK"
            continue
        if "WARN" in plain and "review" in plain.lower():
            severity = "WARN"
            continue
        if severity:
            m = re.match(r"\s*(\S.*?)\s{2,}(\S+):(\d+)\s*$", plain)
            if m:
                findings.append("%s  %s:%s" % (severity, m.group(2), m.group(3)))
    return rc, findings


# ---- attribution ----------------------------------------------------------

def attribute(rows, modified, untracked):
    out = []
    for path, name in rows:
        # node gives us "tests/foo.test.js"; pytest gives "tests/foo.py::T::t"
        head = path.split("::")[0].strip()
        if head.startswith("tests/") or head.startswith("api/tests/"):
            head = head[4:] if head.startswith("api/") else head
        row = {"test_file": head, "failure": name, "verdict": "?", "why": ""}

        if head in untracked:
            row["verdict"] = "IN-FLIGHT"
            row["why"] = "the test file itself is uncommitted (mid-write)"
        elif head in modified:
            row["verdict"] = "IN-FLIGHT"
            row["why"] = "the test file itself has uncommitted edits"
        else:
            touched = sorted(p for p in (modified | untracked)
                             if p.endswith((".js", ".py", ".sql"))
                             and "/tests/" not in p and not p.startswith("tests/"))
            if touched:
                row["verdict"] = "COMMITTED"
                row["why"] = "source changed: " + ", ".join(touched[:4])
                if len(touched) > 4:
                    row["why"] += " (+%d more)" % (len(touched) - 4)
            else:
                row["verdict"] = "FLAKY?"
                row["why"] = "no source change recorded - re-run before believing it"
        out.append(row)
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="node only; skip pytest")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    started = time.time()
    modified, untracked = working_set()
    dirty = modified | untracked
    res = {"in_flight_files": sorted(dirty)}

    node_rc, node_fail, _ = run_node()
    res["node"] = {"rc": node_rc, "failures": node_fail}

    py_fail, sc_find = [], []
    if not args.quick:
        py_rc, py_fail, _ = run_pytest()
        res["pytest"] = {"rc": py_rc, "failures": py_fail}
        sc_rc, sc_find = run_scanner()
        res["scanner"] = {"rc": sc_rc, "findings": sc_find}

    rows = attribute(node_fail + py_fail, modified, untracked)
    res["attributed"] = rows

    counts = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    res["counts"] = counts

    if args.json:
        print(json.dumps(res, indent=2))
        return 0 if (not rows and not sc_find) else 1

    mins = (time.time() - started) / 60
    print()
    print("=" * 74)
    print("TEST REPORT   (%.1f min)" % mins)
    print("=" * 74)
    print("tree : %d modified, %d uncommitted/untracked" % (len(modified), len(untracked)))
    print("node : %s   %d failure(s)" % ("ok" if node_rc == 0 else "FAIL", len(node_fail)))
    if not args.quick:
        print("pytest : %s   %d failure(s)" % ("ok" if res["pytest"]["rc"] == 0 else "FAIL", len(py_fail)))
        print("scanner: %s   %d blocking finding(s)" % ("ok" if res["scanner"]["rc"] == 0 else "BLOCK", len(sc_find)))

    if not rows and not sc_find:
        print()
        print("VERDICT: GREEN")
        print("=" * 74)
        return 0

    if rows:
        print()
        print("failures, by whose work they are:")
        for r in rows:
            print("  [%-9s] %s" % (r["verdict"], r["failure"][:92]))
            print("             %s   <%s>" % (r["why"][:96], r["test_file"]))
    if sc_find:
        print()
        print("  [SCANNER ] blocking finding(s):")
        for f in sc_find[:8]:
            print("             %s" % f)

    print()
    committed = counts.get("COMMITTED", 0)
    inflight = counts.get("IN-FLIGHT", 0)
    flaky = counts.get("FLAKY?", 0)
    if committed:
        print("VERDICT: RED - %d failure(s) from COMMITTED work. Action needed." % committed)
    elif inflight:
        print("VERDICT: RED, but from IN-FLIGHT work (%d). It should clear when the" % inflight)
        print("         agents editing those files finish. Not your bug yet.")
    elif flaky:
        print("VERDICT: RED, but every failure is FLAKY - no source change is recorded.")
        print("         Re-run before believing any of it.")
    else:
        print("VERDICT: RED - see the scanner finding(s) above.")
    print()
    print("files in flight: %s" % (", ".join(sorted(dirty)[:8]) or "none"))
    if len(dirty) > 8:
        print("                 ... and %d more" % (len(dirty) - 8))
    print("=" * 74)
    return 0 if (not rows and not sc_find) else 1


if __name__ == "__main__":
    sys.exit(main())
