// Real Node disk evidence for authored guests. NOT browser File System Access.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function createSyntheticDisk(normalizePath) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'porthole-guest-'));
  const file=input=>path.join(root,...normalizePath(input).segments.map(segment=>segment.toLowerCase()));
  const vfs={
    async readFile(input){try{return new Uint8Array(await fs.readFile(file(input)));}catch(error){if(error.code==='ENOENT')error.code='NOT_FOUND';throw error;}},
    async writeFile(input,bytes){const target=file(input);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,typeof bytes==='string'?bytes:new Uint8Array(bytes));return {persistent:true};},
    async createDirectory(input){await fs.mkdir(file(input));return {persistent:true};},
  };
  return {vfs,file,async close(){await fs.rm(root,{recursive:true,force:true});}};
}
export async function verifySyntheticOutputs(name,disk,RegistryStore) {
  const store=new RegistryStore({vfs:disk.vfs});await store.ready;
  if(name==='registry-test'){
    const token=await store.query('HKCU\\Software\\Roblox\\Client','AuthToken');
    assert.equal(token?.type,3);assert.deepEqual(Array.from(token.data),Array.from({length:128},(_,i)=>i));
    const uid=await store.query('HKCU\\Software\\Roblox\\Client','UserId');assert.equal(uid?.type,4);assert.equal(uid?.data,12345);
    return {kind:'node-disk-fresh-registry-store',tokenBytes:128,userId:12345};
  }
  if(name==='installer-test'){
    const base='C:\\Program Files\\TestApp';assert.ok((await fs.stat(disk.file(base))).isDirectory());
    assert.equal(await fs.readFile(disk.file(base+'\\test.txt'),'utf8'),'synthetic data\n');
    assert.equal((await fs.stat(disk.file(base+'\\uninstall.exe'))).size,0);
    const install=await store.query('HKLM\\Software\\TestApp','InstallPath');assert.equal(install?.type,1);assert.equal(install?.data,base);
    return {kind:'node-disk-fresh-registry-store',directory:true,testFileBytes:15,uninstallerMarkerBytes:0,installPath:base};
  }
  return null;
}
