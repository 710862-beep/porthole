"""Regenerate source-only adaptation patch against a verified local upstream tree.
Usage: python3 scripts/refresh-core-patch.py artifacts/retrowin32-baseline
The caller must acquire/verify the baseline archive using PROVENANCE.json first.
"""
import difflib,hashlib,json,pathlib,sys,subprocess
base=pathlib.Path(sys.argv[1]);root=pathlib.Path('rust/retrowin32');meta_path=pathlib.Path('rust/PROVENANCE.json');meta=json.loads(meta_path.read_text());names=set(meta['modifiedFiles']);names.update(str(pathlib.Path(p).relative_to(root)) for p in subprocess.check_output(['git','ls-files','--',str(root)],text=True).splitlines())
chunks=[];changed=[]
for name in sorted(names):
 old=base/name;new=root/name
 if not old.is_file() and not new.is_file():continue
 raw_a=old.read_bytes()if old.exists()else b'';raw_b=new.read_bytes()if new.exists()else b''
 if raw_a==raw_b:continue
 a=raw_a.decode().splitlines(True);b=raw_b.decode().splitlines(True)
 changed.append(name)
 chunks.extend(difflib.unified_diff(a,b,fromfile='a/'+name if old.exists()else'/dev/null',tofile='b/'+name if new.exists()else'/dev/null'))
patch=pathlib.Path('rust/patches/porthole-core.patch');patch.write_text(''.join(chunks));meta['modifiedFiles']=changed;meta['patchSha256']=hashlib.sha256(patch.read_bytes()).hexdigest();meta['upstreamLicense']='Apache-2.0';meta['license']='Apache-2.0 upstream; derived Wine sections/files LGPL-2.1-or-later';meta['wine']={'repository':'https://github.com/wine-mirror/wine','commit':pathlib.Path('docs/wine-commit.txt').read_text().strip(),'license':'LGPL-2.1-or-later','derivedFiles':['win32/src/winapi/user32/'+x+'.rs'for x in ['dialog_template','dialog_helpers','updown']],'additionalDerivedSections':['win32/src/winapi/advapi32.rs: GetUserNameA/W','win32/src/winapi/kernel32/env.rs','win32/src/winapi/kernel32/nls.rs: WideCharToMultiByte','win32/src/winapi/kernel32/file.rs: current-directory APIs','win32/src/winapi/kernel32/time.rs: timezone conversion','win32/src/winapi/user32/window.rs: EnableWindow/IsWindowEnabled','win32/src/winapi/kernel32/mutex.rs and mutex integration in sync/init/misc','win32/src/winapi/dplay.rs','win32/src/winapi/user32/controls.rs: combo insert/search/item-data cases','win32/src/winapi/user32/placement.rs','win32/src/winapi/winmm/midi.rs'],'notices':'vendor/ATTRIBUTION.md; LICENSE.Wine','status':'PARTIAL_ADAPTATION_NOT_FULL_WINE'};meta_path.write_text(json.dumps(meta,indent=2)+'\n');print(len(changed),'patched files')
