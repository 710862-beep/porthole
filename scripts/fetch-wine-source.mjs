import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function fetchWine(root='vendor/wine-source') {
 const sha=fs.readFileSync('docs/wine-commit.txt','utf8').trim();
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid pinned Wine SHA');
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 if(!fs.existsSync(root)){
  fs.mkdirSync(root,{recursive:true});git('init');git('remote','add','origin','https://github.com/wine-mirror/wine.git');
  git('fetch','--depth','1','origin',sha);git('checkout','--detach','FETCH_HEAD');
 }
 if(git('rev-parse','HEAD')!==sha)throw Error('Wine checkout differs from pinned SHA; refusing to overwrite');
 if(git('status','--porcelain'))throw Error('Wine checkout has local changes');
 for(const f of ['dlls/user32/dialog.c','dlls/user32/win.c','include/winuser.h','COPYING.LIB'])if(!fs.statSync(path.join(root,f)).isFile())throw Error(`Missing Wine file ${f}`);
 if(!fs.readFileSync('LICENSE.Wine').equals(fs.readFileSync(path.join(root,'COPYING.LIB'))))throw Error('LICENSE.Wine differs from pinned upstream');
 console.log(`Wine source VERIFIED ${sha}`);return sha;
}
if(process.argv[1]===fileURLToPath(import.meta.url))fetchWine();
