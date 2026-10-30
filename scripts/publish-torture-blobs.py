"""Publish bounded torture evidence as unreferenced Git blobs; never update a ref.

Payloads are gzip-compressed before base64 so large raw JSON/JSONL reports do not hit the
Git blob API size limit or lose the whole manifest because one pretty-printed audit is big.
The manifest pins both the original bytes and the transported blob for verification.
"""
import base64, gzip, hashlib, json, os, subprocess
from pathlib import Path

root = Path('artifacts/torture')
files = []
total = 0
MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_BLOB = 90 * 1024 * 1024

def post_blob(data: bytes):
    payload = json.dumps({'encoding': 'base64', 'content': base64.b64encode(data).decode()})
    r = subprocess.run(
        ['gh', 'api', '--method', 'POST', f"repos/{os.environ['GITHUB_REPOSITORY']}/git/blobs", '--input', '-'],
        input=payload, text=True, capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f'gh blob POST failed ({r.returncode}): {r.stderr or r.stdout}')
    return json.loads(r.stdout)['sha']

for p in sorted(root.rglob('*')):
    if not p.is_file() or p.name == 'api-transfer.json':
        continue
    data = p.read_bytes()
    total += len(data)
    if len(data) > MAX_FILE or total > MAX_TOTAL:
        raise ValueError(f'Evidence too large: {p} ({len(data)} bytes, total {total})')
    compressed = gzip.compress(data, compresslevel=6, mtime=0)
    if len(compressed) > MAX_BLOB:
        raise ValueError(f'Compressed evidence blob too large: {p} ({len(compressed)} bytes)')
    blob = post_blob(compressed)
    files.append({
        'path': str(p),
        'blob': blob,
        'encoding': 'gzip',
        'blobBytes': len(compressed),
        'blobSha256': hashlib.sha256(compressed).hexdigest(),
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })

manifest = {
    'sourceSha': os.environ['GITHUB_SHA'],
    'runId': os.environ['GITHUB_RUN_ID'],
    'job': os.environ.get('GITHUB_JOB', 'torture'),
    'files': files,
}
data = json.dumps(manifest, separators=(',', ':')).encode()
manifest_blob = post_blob(data)
pointer = {
    'manifestBlob': manifest_blob,
    'bytes': len(data),
    'sha256': hashlib.sha256(data).hexdigest(),
    'job': manifest['job'],
}
print('::notice title=Porthole torture transfer::' + json.dumps(pointer, separators=(',', ':')))
