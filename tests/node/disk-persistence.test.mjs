/** Real Node temp-directory IO; NOT browser FS Access or guest ABI evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
require('../../js/porthole-linker.js');require('../../js/vfs.js');require('../../vfs-persist.js');require('../../shims/registry.js');
const P=globalThis.Porthole;
class TestDisk {
 constructor(root){this.root=root;this.isMapped=true;}
 file(input){return path.join(this.root,...P.VFSUtils.normalizePath(input).segments.map(x=>x.toLowerCase()));}
 async readFile(input){try{return new Uint8Array(await fs.readFile(this.file(input))).buffer;}catch(e){if(e.code==='ENOENT')e.code='NOT_FOUND';throw e;}}
 async writeFile(input,bytes){const file=this.file(input);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,new Uint8Array(bytes));return {persistent:true};}
 getInfo(){return {persistent:true,kind:'node-test-disk'};}
}
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'porthole-persist-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const session=()=>{const vfs=new P.VFSPersistence({vfs:new TestDisk(root)});return {vfs,reg:new P.Registry.Advapi32Shim({vfs})};};return {root,session};}
test('artificial Roblox binary token and DWORD survive fresh JS stores on real disk',async t=>{
 const {session}=await setup(t),first=session(),token=Uint8Array.from({length:128},(_,i)=>i);
 const key=await first.reg.RegCreateKeyExW('HKCU','Software\\Roblox\\Client');assert.equal(key.status,0);
 assert.equal(await first.reg.RegSetValueExW(key.handle,'AuthToken',3,token),0);assert.equal(await first.reg.RegSetValueExW(key.handle,'UserId',4,12345),0);await first.reg.RegFlushKey(key.handle);first.reg.RegCloseKey(key.handle);await first.vfs.flush();
 const second=session(),open=await second.reg.RegOpenKeyExW('HKCU','Software\\Roblox\\Client');assert.equal(open.status,0);assert.deepEqual((await second.reg.RegQueryValueExW(open.handle,'AuthToken')).data,token);assert.equal((await second.reg.RegQueryValueExW(open.handle,'UserId')).data,12345);
});
test('synthetic Adobe preferences persist, without claiming ICM implementation',async t=>{
 const {session}=await setup(t),first=session();const key=await first.reg.RegCreateKeyExW('HKCU','Software\\Adobe\\Photoshop');
 assert.equal(await first.reg.RegSetValueExW(key.handle,'ICMProfile',1,'synthetic-sRGB.icc'),0);assert.equal(await first.reg.RegSetValueExW(key.handle,'Preferences',3,new Uint8Array([1,2,3])),0);await first.reg.RegFlushKey(key.handle);await first.vfs.flush();
 const second=session(),open=await second.reg.RegOpenKeyExW('HKCU','Software\\Adobe\\Photoshop');assert.equal((await second.reg.RegQueryValueExW(open.handle,'ICMProfile')).data,'synthetic-sRGB.icc');assert.deepEqual((await second.reg.RegQueryValueExW(open.handle,'Preferences')).data,new Uint8Array([1,2,3]));
});
test('JS installer-like disk writes and install metadata reload (not NSIS execution)',async t=>{
 const {root,session}=await setup(t),first=session();await first.vfs.writeFile('C:\\Program Files\\TestApp\\test.txt','synthetic data');await first.vfs.writeFile('C:\\Program Files\\TestApp\\uninstall.exe',new Uint8Array());
 const key=await first.reg.RegCreateKeyExW('HKLM','Software\\TestApp');assert.equal(await first.reg.RegSetValueExW(key.handle,'InstallPath',1,'C:\\Program Files\\TestApp'),0);await first.reg.RegFlushKey(key.handle);await first.vfs.flush();
 const second=session();assert.equal(new TextDecoder().decode(await second.vfs.readFile('C:\\Program Files\\TestApp\\test.txt')),'synthetic data');assert.equal((await fs.stat(path.join(root,'program files/testapp/uninstall.exe'))).size,0);
 const open=await second.reg.RegOpenKeyExW('HKLM','Software\\TestApp');assert.equal((await second.reg.RegQueryValueExW(open.handle,'InstallPath')).data,'C:\\Program Files\\TestApp');
});
