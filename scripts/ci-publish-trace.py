#!/usr/bin/env python3
"""Publish a text trace from CI through the Checks API.

Log and artifact downloads are blocked in restricted-egress sandboxes, but a check run's
`output.summary` / `output.text` fields are readable over the Checks API and hold up to 65 535
characters each. This script uploads a trace file to a dedicated check run named
`porthole-x64-trace` so the whole guest trace can be read back with:

    gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
      --jq '.check_runs[] | select(.name=="porthole-x64-trace") | .id'

    gh api repos/<owner>/<repo>/check-runs/<id> --jq '.output.text'

If the token cannot create check runs, the last few lines are still exported as workflow-command
annotations so nothing is lost.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"


def post(url, token, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "porthole-ci",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main(argv):
    path = argv[0] if argv else "trace.log"
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except FileNotFoundError:
        print(f"::error::trace file missing: {path}")
        return

    lines = text.splitlines()
    # Character-based split so the beginning of the trace is never truncated away.
    summary = text[:60000]
    rest = text[60000:124000]

    # Always mirror the tail through annotations (works with actions/runner workflow commands).
    for line in lines[-18:]:
        print(f"::notice title=x64-trace::{line[:900]}")

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    sha = os.environ.get("GITHUB_SHA")
    if not token or not repo or not sha:
        print("::warning::no token/repo/sha; only annotations were published")
        return

    body = {
        "name": "porthole-x64-trace",
        "head_sha": sha,
        "status": "completed",
        "conclusion": "neutral",
        "output": {
            "title": f"x86-64 guest trace ({len(lines)} lines)",
            "summary": summary or "(empty)",
            "text": rest or "(nothing beyond the summary window)",
        },
    }
    try:
        created = post(f"{API}/repos/{repo}/check-runs", token, body)
        print(f"::notice::published trace to check run {created.get('id')}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:400]
        print(f"::warning::check-run publish failed ({exc.code}): {detail}")


if __name__ == "__main__":
    main(sys.argv[1:])
