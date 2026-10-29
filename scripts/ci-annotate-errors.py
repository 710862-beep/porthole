#!/usr/bin/env python3
"""Emit GitHub Actions annotations for compiler errors so failures are readable through the
Checks API when artifact/log downloads are blocked (restricted egress environments)."""
import re
import sys
from pathlib import Path

PATTERN = re.compile(
    r"(^error(\[|:)|^warning: unused|cannot find|no method|no field|expected|mismatched|"
    r"-->\s*\S+\.rs:\d+|trait bound|unresolved import|missing `)"
)


def main(paths):
    emitted = 0
    for raw in paths:
        path = Path(raw)
        if not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in lines:
            if not PATTERN.search(line):
                continue
            message = line.strip()[:900]
            print(f"::error file={raw}::{message}")
            emitted += 1
            if emitted >= 80:
                print(f"::error file={raw}::(annotations truncated at 80 lines; full log in artifacts)")
                return
    if emitted == 0:
        print(f"::error::No compiler diagnostics found in {', '.join(paths)}")
    return


if __name__ == "__main__":
    main(sys.argv[1:])
