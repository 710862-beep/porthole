#!/usr/bin/env python3
"""Surface the x86-64 Wine conformance report through Checks annotations.

Artifact and log downloads are blocked in restricted-egress environments, so the report is
mirrored line-by-line into annotations, which remain readable over the Checks API.
"""
import json
import sys
from pathlib import Path


def main(argv):
    path = Path(argv[0] if argv else "artifacts/wine64-report.json")
    if not path.is_file():
        print(f"::error::Relatório ausente: {path}")
        return
    report = json.loads(path.read_text())
    print(f"::error title=x86-64 Wine conformance::status={report.get('status')} wasm={str(report.get('wasmSha256'))[:16]}")
    for test in report.get("tests", []):
        level = "::error" if test.get("status") != "PASS" else "::notice"
        header = (
            f"{test.get('name')} {test.get('status')} "
            f"exit={test.get('exitCode')} insn={test.get('instructions')} "
            f"faults={test.get('pageFaults')} failures={test.get('failures')}"
        )
        print(f"{level} title=x86-64 conformance::{header}")
        if test.get("error"):
            print(f"{level} title=x86-64 conformance::{test.get('name')}: {str(test['error'])[:800]}")
        console = (test.get("console") or "").splitlines()
        interesting = [l for l in console if "Test failed" in l or "unhandled exception" in l or "tests executed" in l]
        if not interesting and console:
            interesting = console[-6:]
        for line in interesting[:12]:
            print(f"{level} title={test.get('name')} guest stdout::{line.strip()[:700]}")
    summary = report.get("summary") or {}
    print(f"::error title=x86-64 conformance summary::passed={summary.get('passed')} failed={summary.get('failed')} faults={summary.get('faults')} timeouts={summary.get('timeouts')}")


if __name__ == "__main__":
    main(sys.argv[1:])
