"""Download torture evidence through api.github.com, verifying run/source/Git/SHA256."""
import base64,hashlib,json,re,subprocess,sys
from pathlib import Path
run=sys.argv[1];repo='710862-beep/porthole'
def api(ep):return json.loads(subprocess.check_output(['gh','api',ep],text=True))
meta=api(f'repos/{repo}/actions/runs/{run}');jobs=api(f'repos/{repo}/actions/runs/{run}/jobs?per_page=100')
annotations=[]
for j in jobs['jobs']:
 url=j['check_run_url'].split('api.github.com/')[-1]
 annotations+=api(url+'/annotations?per_page=100')
pointers=[]
for a in annotations:
 if a.get('title')=='Porthole torture transfer':pointers.append(json.loads(a['message']))
root=Path('artifacts/remote')/run;root.mkdir(parents=True,exist_ok=True)
seen=set()
for ptr in pointers:
 if ptr['job'] in seen:continue
 seen.add(ptr['job'])
 b=api(f"repos/{repo}/git/blobs/{ptr['manifestBlob']}");data=base64.b64decode(b['content'])
 assert len(data)==ptr['bytes'] and hashlib.sha256(data).hexdigest()==ptr['sha256']
 m=json.loads(data);assert m['sourceSha']==meta['head_sha'] and str(m['runId'])==run
 for f in m['files']:
  p=Path(f['path']);assert not p.is_absolute() and '..' not in p.parts and p.parts[:2]==('artifacts','torture')
  b=api(f"repos/{repo}/git/blobs/{f['blob']}");data=base64.b64decode(b['content'])
  assert len(data)==f['bytes'] and hashlib.sha256(data).hexdigest()==f['sha256']
  assert hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()==f['blob']
  out=root/p;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data);print('VERIFIED',out,len(data))
(root/'run.json').write_text(json.dumps(meta,indent=2)+'\n')
if not seen:raise SystemExit('No torture transfer manifests found')
