"""API-only artifact transport: unreferenced Git blobs, never a commit/ref update.
Normal Actions artifacts remain authoritative and are uploaded separately. This
fallback avoids blocked Azure redirects; it publishes only candidate/test files.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess

paths = [Path('artifacts/wasm-candidate') / name for name in
         ('retrowin32.wasm', 'glue.mjs', 'SHA256SUMS', 'integrity.json', 'LICENSE.Wine', 'ATTRIBUTION.md', 'SOURCE_COMMIT', 'corresponding-source.tar.gz')]
paths += sorted(Path('artifacts').glob('*.json'))
paths += [Path('artifacts/rebuild-wasm.log')]
manifest = {'sourceSha': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'], 'files': []}
for path in paths:
    if not path.is_file():
        continue
    data = path.read_bytes()
    if len(data) > 20 * 1024 * 1024:
        raise ValueError(f'Refusing unexpectedly large diagnostic: {path}')
    payload = json.dumps({'encoding': 'base64', 'content': base64.b64encode(data).decode()})
    result = subprocess.run(['gh', 'api', '--method', 'POST',
        f"repos/{os.environ['GITHUB_REPOSITORY']}/git/blobs", '--input', '-'],
        input=payload, text=True, check=True, capture_output=True)
    blob = json.loads(result.stdout)
    manifest['files'].append({'path': str(path), 'blob': blob['sha'],
                             'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
Path('artifacts/api-transfer.json').write_text(json.dumps(manifest, indent=2) + '\n')
# Small, structured annotation; downloaders must verify source SHA and hashes.
print('::notice title=Porthole API transfer::' + json.dumps(manifest, separators=(',', ':')))
