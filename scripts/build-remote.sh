#!/usr/bin/env bash
# Requires an already committed/pushed session branch. Never switches branches,
# stages files, promotes Wasm, or hides CI failure behind a download success.
set -euo pipefail
cd "$(dirname "$0")/.."
branch=arena/6a52f3cb-porthole
[[ "$(git branch --show-current)" == "$branch" ]] || { echo 'Wrong session branch'; exit 1; }
if [[ "${1:-}" == '--run' ]]; then
  run="$2"
else
  gh workflow run rust-wasm-candidate.yml --ref "$branch"
  echo 'Dispatch submitted. Use gh run list --branch arena/6a52f3cb-porthole, then pass --run <ID>.'
  exit 0
fi
status=0
gh run watch "$run" --exit-status || status=$?
mkdir -p "artifacts/remote/$run"
gh run view "$run" --json databaseId,headSha,headBranch,status,conclusion,url > "artifacts/remote/$run/run.json"
gh run view "$run" --log > "artifacts/remote/$run/run.log"
gh run download "$run" --dir "artifacts/remote/$run" || { echo 'No downloadable artifacts; inspect run log/annotations.'; exit 1; }
if [[ -f "artifacts/remote/$run/retrowin32-candidate-wasm/retrowin32.wasm" ]]; then
  node scripts/validate-wasm.mjs "artifacts/remote/$run/retrowin32-candidate-wasm"
fi
exit "$status"
