import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { sanitizeEvidence } from '../ci/autofix.mjs';
const names=['thread-validation','input-test','network-test','registry-test','installer-test'];
if(process.argv[2]==='--worker') {
  const name=process.argv[3]; if(!names.includes(name)) throw new Error('Unknown fixture');
  const bytes=fs.readFileSync(`tests/synthetic/${name}.exe`);
  const item={name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),logs:[]};
  try {
    const require=createRequire(import.meta.url); require('../js/vfs.js'); require('../js/porthole-linker.js'); require('../js/retrowin32-backend.js'); require('../shims/registry.js'); require('../shims/guest-registry.js');
    const wasmBytes=fs.readFileSync(process.env.PORTHOLE_WASM || 'vendor/retrowin32/retrowin32.wasm');
    item.backendSha256=crypto.createHash('sha256').update(wasmBytes).digest('hex');
    const backend=new globalThis.Porthole.Retrowin32Backend({wasmBytes, ...(process.env.PORTHOLE_GLUE?{moduleURL:pathToFileURL(path.resolve(process.env.PORTHOLE_GLUE)).href}:{}),tracer:{log(scope,message,kind){if(item.logs.length<100)item.logs.push({scope,kind,message:sanitizeEvidence(String(message))});}}});
    const overlay=new Map();
    const registryVFS={ async readFile(file){if(!overlay.has(file))throw Object.assign(new Error('not found'),{code:'NOT_FOUND'});return overlay.get(file);}, async writeFile(file,data){overlay.set(file,new TextEncoder().encode(data));return {persistent:false};} };
    const registryBridge=new globalThis.Porthole.GuestRegistryBridge(new globalThis.Porthole.Registry.RegistryStore({vfs:registryVFS}));
    const proc=await backend.createProcess({registryBridge,path:`C:\\Synthetic\\${name}.exe`,bytes,preload:false});
    proc.start(); const result=await proc.done;
    item.result={status:result.status,exitCode:result.exitCode,error:result.error,instructions:result.instructions,stdout:sanitizeEvidence(proc.output),volatileWrites:result.volatileWrites,flushError:result.flushError};
    item.status=result.status==='exited' && result.exitCode===0 && !result.flushError && proc.output.includes('SUCCESS')?'PASS':'GUEST_FAILURE';
    if(name==='thread-validation' && result.status==='exited' && proc.output.split('WORKER_DONE').length-1!==3) item.status='INCOMPLETE_THREAD_EXECUTION';
    if(name==='input-test' && item.status==='PASS') item.status='INPUT_NOT_VALIDATED'; // Never credit a headless run as physical input.
  }catch(e){item.status='LOAD_OR_BACKEND_FAILURE';item.error=sanitizeEvidence(e.message);}
  console.log(JSON.stringify(item));
} else {
  const selected=process.argv.slice(2); const tests=selected.length?selected:names;
  if(tests.some(n=>!names.includes(n))) throw new Error('Unknown fixture name');
  const report={kind:'synthetic-pe32-guest-execution',tests:[]};
  for(const name of tests){
    const run=spawnSync(process.execPath,[import.meta.filename,'--worker',name],{encoding:'utf8',timeout:15000,maxBuffer:1048576});
    let item;try{item=JSON.parse(run.stdout.trim());}catch{item={name,status:run.error?.code==='ETIMEDOUT'?'TIMEOUT':'HARNESS_FAILURE',error:run.error?.message||run.stderr};}
    report.tests.push(item);console.log(`${name}: ${item.status}`);
  }
  fs.mkdirSync('artifacts',{recursive:true});
  fs.writeFileSync(`artifacts/synthetic-${process.env.PORTHOLE_WASM?'candidate-':''}${selected.length===1?selected[0]:'all'}.json`,JSON.stringify(report,null,2)+'\n');
  process.exitCode=report.tests.every(t=>t.status==='PASS')?0:1;
}
