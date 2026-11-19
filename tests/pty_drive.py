#!/usr/bin/env python3
"""Drive an interactive script through a pty and answer its prompts.

Used to test the setup scripts' NEW interactive prompts (install scope, local
LLM, join the hive) the way a real person would experience them — the prompts
only appear when stdin is a TTY, so a plain subprocess pipe would skip them.

Answers are matched against the prompt TEXT (not a timer), so the test is
deterministic and cannot drift out of order.

STDOUT and STDERR are kept SEPARATE: `d_ask_choice` prints its menu to
stderr and only the index to stdout, and that split is exactly what one of
the tests asserts. Merging them would hide the very bug being tested.

Usage:
    python3 tests/pty_drive.py "bash ./setup.sh" "choice:1" "choice:3" "yes:n"

Each answer is "substring-to-match:reply". The driver waits until the
accumulated output contains the substring, then sends the reply.
"""
from __future__ import annotations

import os
import pty
import re
import select
import subprocess
import sys
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def clean(b: bytes) -> str:
    return ANSI.sub("", b.decode("utf-8", "replace"))


def drive(argv: list[str], answers: list[str], timeout: int = 600):
    """Run argv with a PTY on stdin (so prompts fire) but a PIPE on stdout.

    stdin must be a TTY — that is what makes `[[ -t 0 ]]` true and the
    prompts appear. stdout stays a pipe so we can tell the script's STDOUT
    (the chosen index) apart from its STDERR (the menu it printed). The
    child's stderr is redirected into the same pipe; the "===STDERR==="
    marker below separates the two streams.
    """
    master, slave = pty.openpty()
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()

    proc = subprocess.Popen(
        argv,
        stdin=slave,
        stdout=out_w,
        stderr=err_w,
        close_fds=True,
        env={**os.environ, "TERM": "xterm", "COLUMNS": "100", "LINES": "40"},
    )
    os.close(slave)
    os.close(out_w)
    os.close(err_w)

    pending = list(answers)
    out = b""
    err = b""
    last_out = time.time()
    matched: set[str] = set()

    while True:
        watch = [f for f in (master, out_r, err_r) if f is not None]
        if not watch:
            break
        r, _, _ = select.select(watch, [], [], 0.2)
        if r:
            if out_r is not None and out_r in r:
                try:
                    chunk = os.read(out_r, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    out_r = None
                else:
                    out += chunk
                    last_out = time.time()
                    continue
            if err_r is not None and err_r in r:
                try:
                    chunk = os.read(err_r, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    err_r = None
                else:
                    err += chunk
                    last_out = time.time()
                    continue
            if master is not None and master in r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    master = None
                else:
                    # The pty ECHOes what we type — keep it out of the
                    # streams so an answer never looks like script output.
                    last_out = time.time()
                    continue
        else:
            if pending:
                text = clean(out) + clean(err)
                for i, (pat, reply) in enumerate(pending):
                    if pat in text and pat not in matched:
                        matched.add(pat)
                        pending.pop(i)
                        if master is not None:
                            os.write(master, (reply + "\n").encode())
                        time.sleep(0.3)
                        break
            if proc.poll() is not None and out_r is None and err_r is None:
                break
            if time.time() - last_out > 45:
                break

    # Drain the tail, then wait for the process to actually exit.
    deadline = time.time() + 20
    while proc.poll() is None and time.time() < deadline:
        watch = [f for f in (out_r, err_r) if f is not None]
        if not watch:
            break
        r, _, _ = select.select(watch, [], [], 0.2)
        if r:
            if out_r is not None and out_r in r:
                try:
                    chunk = os.read(out_r, 65536)
                except OSError:
                    break
                if not chunk:
                    out_r = None
                else:
                    out += chunk
            elif err_r is not None and err_r in r:
                try:
                    chunk = os.read(err_r, 65536)
                except OSError:
                    break
                if not chunk:
                    err_r = None
                else:
                    err += chunk
        else:
            time.sleep(0.2)

    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    for fd in (master, out_r, err_r):
        if fd is not None:
            os.close(fd)
    return proc.returncode or 0, clean(out), clean(err)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    answers = []
    for a in sys.argv[2:]:
        if ":" not in a:
            print(f"bad answer spec {a!r} (want 'match:reply')")
            return 2
        pat, reply = a.split(":", 1)
        answers.append((pat, reply))
    rc, out, err = drive(["bash", "-lc", cmd], answers)
    print("===STDOUT===")
    print(out)
    print("===STDERR===")
    print(err)
    print("===END===")
    return rc


if __name__ == "__main__":
    sys.exit(main())
