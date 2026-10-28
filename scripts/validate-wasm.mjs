import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir=path.resolve(process.argv[2]||'artifacts/wasm-candidate');
const wasm=fs.readFileSync(path.join(dir,'retrowin32.wasm'));
const glue=fs.readFileSync(path.join(dir,'glue.mjs'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(wasm.length<=1048576)throw Error(`Candidate unexpectedly small: ${wasm.length} bytes`);
if(!wasm.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])))throw Error('Invalid Wasm magic/version');
const sums=new Map(fs.readFileSync(path.join(dir,'SHA256SUMS'),'utf8').trim().split('\n').map(line=>{
 const match=line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);if(!match)throw Error('Malformed SHA256SUMS');return [path.basename(match[2]),match[1]];
}));
if(sums.get('retrowin32.wasm')!==hash(wasm)||sums.get('glue.mjs')!==hash(glue))throw Error('Wasm/glue checksum mismatch');
const module=await WebAssembly.compile(wasm);
const report={status:'INTEGRITY_VALIDATED_NOT_COMPATIBILITY',bytes:wasm.length,wasmSha256:hash(wasm),glueSha256:hash(glue),exports:WebAssembly.Module.exports(module).length,imports:WebAssembly.Module.imports(module).length};
console.log(JSON.stringify(report,null,2));
fs.writeFileSync(path.join(dir,'integrity.json'),JSON.stringify(report,null,2)+'\n');
