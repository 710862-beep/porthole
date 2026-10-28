"""Retrieve CI payloads over api.github.com and verify source/Git/SHA256 hashes."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def api(endpoint, *args):
    return json.loads(subprocess.check_output(['gh', 'api', endpoint, *args], text=True))


def download(run):
    if not re.fullmatch(r'\d+', run):
        raise ValueError('Expected numeric Actions run ID')
    repo = subprocess.check_output(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], text=True).strip()
    metadata = api(f'repos/{repo}/actions/runs/{run}')
    jobs = api(f'repos/{repo}/actions/runs/{run}/jobs')
    annotations = []
    for job in jobs['jobs']:
        page = 1
        while True:
            batch = api(job['check_run_url'] + f'/annotations?per_page=100&page={page}')
            annotations.extend(batch)
            if len(batch) < 100:
                break
            page += 1
    root = Path('artifacts/remote') / run
    root.mkdir(parents=True, exist_ok=True)
    (root / 'annotations.json').write_text(json.dumps(annotations, indent=2) + '\n')
    (root / 'run.json').write_text(json.dumps(metadata, indent=2) + '\n')
    manifests = [json.loads(a['message']) for a in annotations if a.get('title') == 'Porthole API transfer']
    if len(manifests) != 1:
        raise ValueError('No unique API transfer manifest; annotations saved for diagnosis')
    manifest = manifests[0]
    if manifest['sourceSha'] != metadata['head_sha'] or str(manifest['runId']) != run:
        raise ValueError('Transfer manifest source/run mismatch')
    for item in manifest['files']:
        path = Path(item['path'])
        if path.is_absolute() or '..' in path.parts or path.parts[0] != 'artifacts':
            raise ValueError('Unsafe transfer path')
        if not re.fullmatch(r'[0-9a-f]{40}', item['blob']):
            raise ValueError('Invalid Git blob ID')
        blob = api(f"repos/{repo}/git/blobs/{item['blob']}")
        if blob['encoding'] != 'base64':
            raise ValueError('Unexpected blob encoding')
        data = base64.b64decode(blob['content'])
        git_hash = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if git_hash != item['blob'] or len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Transfer integrity mismatch')
        rel = path.relative_to('artifacts')
        target = root / ('retrowin32-candidate-wasm' if rel.parts[0] == 'wasm-candidate' else 'test-results')
        target /= Path(*rel.parts[1:]) if rel.parts[0] == 'wasm-candidate' else rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f'VERIFIED {target}: {len(data)} bytes SHA256={item["sha256"]}')
    (root / 'api-transfer.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return root


if __name__ == '__main__':
    download(sys.argv[1])
