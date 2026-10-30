#!/usr/bin/env python3
"""Emit GitHub Actions annotations for compiler errors so failures are readable through the
Checks API when artifact/log downloads are blocked (restricted egress environments)."""
import re
import sys
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")
HEADER = re.compile(r"^\s*(error(\[\w+\])?|warning):\s*(.*)$")
NOTE = re.compile(r"^\s*-->\s+(\S+):(\d+):(\d+)\s*$")
CARET = re.compile(r"^\s*\|\s*\^+.*(expected .*|missing .*|found .*)$")
TESTFAIL = re.compile(r"(^test .* FAILED|^---- .* stdout ----|panicked at|assertion .* failed|^left:|^right:|failures:$)")


def main(paths):
    emitted = 0
    for raw in paths:
        path = Path(raw)
        if not path.is_file():
            continue
        lines = [ANSI.sub("", line) for line in path.read_text(encoding="utf-8", errors="replace").splitlines()]
        for line in lines:
            if TESTFAIL.search(line):
                print(f"::error file={raw}::{line.strip()[:900]}")
                emitted += 1
        i = 0
        while i < len(lines):
            header = HEADER.match(lines[i])
            if not header or not header.group(1).startswith("error"):
                i += 1
                continue
            location = None
            detail = None
            for j in range(i + 1, min(i + 8, len(lines))):
                note = NOTE.match(lines[j])
                if note:
                    location = f"{note.group(1)}:{note.group(2)}"
                    continue
                caret = CARET.match(lines[j])
                if caret:
                    detail = caret.group(1).strip()
                    break
            message = header.group(3).strip() or "compiler error"
            if detail:
                message += f" ({detail})"
            target = location or raw
            print(f"::error file={target}::{message[:900]}")
            emitted += 1
            if emitted >= 100:
                print("::error::(annotations truncated at 100 diagnostics)")
                return
            i += 1
    if emitted == 0:
        print(f"::error::No compiler diagnostics found in {', '.join(paths)}")


if __name__ == "__main__":
    main(sys.argv[1:])
