"""Download torture evidence through api.github.com, verifying run/source/Git/SHA256.

Supports both legacy raw blobs and the current gzip transport. Never follows Actions
artifact ZIP redirects to non-allowlisted storage hosts.
"""
import base64, gzip, hashlib, json, subprocess, sys
from pathlib import Path

if len(sys.argv) < 2:
    raise SystemExit('usage: download-torture-blobs.py RUN_ID [JOB ...]')
run = sys.argv[1]
wanted = set(sys.argv[2:])
repo = '710862-beep/porthole'

def api(ep):
    return json.loads(subprocess.check_output(['gh', 'api', ep], text=True))

def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()

meta = api(f'repos/{repo}/actions/runs/{run}')
jobs = api(f'repos/{repo}/actions/runs/{run}/jobs?per_page=100')
annotations = []
for j in jobs['jobs']:
    url = j['check_run_url'].split('api.github.com/')[-1]
    annotations += api(url + '/annotations?per_page=100')
pointers = []
for a in annotations:
    if a.get('title') == 'Porthole torture transfer':
        ptr = json.loads(a['message'])
        if not wanted or ptr.get('job') in wanted:
            pointers.append(ptr)

root = Path('artifacts/remote') / run
root.mkdir(parents=True, exist_ok=True)
by_job = {}
for ptr in pointers:
    b = api(f"repos/{repo}/git/blobs/{ptr['manifestBlob']}")
    data = base64.b64decode(b['content'])
    assert len(data) == ptr['bytes'] and hashlib.sha256(data).hexdigest() == ptr['sha256']
    m = json.loads(data)
    assert m['sourceSha'] == meta['head_sha'] and str(m['runId']) == run
    slot = by_job.setdefault(m['job'], {})
    for f in m['files']:
        slot[f['path']] = f

seen = set()
for job, files in by_job.items():
    seen.add(job)
    for f in files.values():
        p = Path(f['path'].replace('\\', '/'))
        assert not p.is_absolute() and '..' not in p.parts and p.parts[:2] == ('artifacts', 'torture')
        b = api(f"repos/{repo}/git/blobs/{f['blob']}")
        transported = base64.b64decode(b['content'])
        assert git_blob_sha(transported) == f['blob']
        if f.get('encoding') == 'gzip':
            assert len(transported) == f['blobBytes']
            assert hashlib.sha256(transported).hexdigest() == f['blobSha256']
            data = gzip.decompress(transported)
        else:
            data = transported
        assert len(data) == f['bytes'] and hashlib.sha256(data).hexdigest() == f['sha256']
        out = root / job / p
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print('VERIFIED', out, len(data))
(root / 'run.json').write_text(json.dumps(meta, indent=2) + '\n')
if not seen:
    raise SystemExit('No torture transfer manifests found')
