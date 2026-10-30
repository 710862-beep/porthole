"""Publish bounded torture evidence as unreferenced Git blobs; never update a ref."""
import base64,hashlib,json,os,subprocess
from pathlib import Path
root=Path('artifacts/torture'); files=[]; total=0
for p in sorted(root.rglob('*')):
 if not p.is_file() or p.name=='api-transfer.json': continue
 data=p.read_bytes(); total+=len(data)
 if len(data)>16*1024*1024 or total>64*1024*1024: raise ValueError(f'Evidence too large: {p}')
 payload=json.dumps({'encoding':'base64','content':base64.b64encode(data).decode()})
 r=subprocess.run(['gh','api','--method','POST',f"repos/{os.environ['GITHUB_REPOSITORY']}/git/blobs",'--input','-'],input=payload,text=True,capture_output=True,check=True)
 files.append({'path':str(p),'blob':json.loads(r.stdout)['sha'],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
manifest={'sourceSha':os.environ['GITHUB_SHA'],'runId':os.environ['GITHUB_RUN_ID'],'job':os.environ.get('GITHUB_JOB','torture'),'files':files}
data=json.dumps(manifest,separators=(',',':')).encode();payload=json.dumps({'encoding':'base64','content':base64.b64encode(data).decode()})
r=subprocess.run(['gh','api','--method','POST',f"repos/{os.environ['GITHUB_REPOSITORY']}/git/blobs",'--input','-'],input=payload,text=True,capture_output=True,check=True)
pointer={'manifestBlob':json.loads(r.stdout)['sha'],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'job':manifest['job']}
print('::notice title=Porthole torture transfer::'+json.dumps(pointer,separators=(',',':')))
