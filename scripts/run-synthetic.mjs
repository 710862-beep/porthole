import fs from 'node:fs';
import http from 'node:http';
import { GuestNetwork } from './guest-network.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createSyntheticDisk, verifySyntheticOutputs } from './synthetic-disk.mjs';
import { sanitizeEvidence } from '../ci/autofix.mjs';
const names=['thread-validation','input-test','network-test','registry-test','installer-test'];
if(process.argv[2]==='--worker') {
  const name=process.argv[3]; if(!names.includes(name)) throw new Error('Unknown fixture');
  const bytes=fs.readFileSync(`tests/synthetic/${name}.exe`);
  const item={name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),logs:[]};
  let disk,server,networkBridge;let requestSeen=false;let port;
  try {
    const require=createRequire(import.meta.url); require('../js/vfs.js'); require('../js/porthole-linker.js'); require('../js/retrowin32-backend.js'); require('../shims/registry.js'); require('../shims/guest-registry.js');
    const wasmBytes=fs.readFileSync(process.env.PORTHOLE_WASM || 'vendor/retrowin32/retrowin32.wasm');
    item.backendSha256=crypto.createHash('sha256').update(wasmBytes).digest('hex');
    const backend=new globalThis.Porthole.Retrowin32Backend({wasmBytes, ...(process.env.PORTHOLE_GLUE?{moduleURL:pathToFileURL(path.resolve(process.env.PORTHOLE_GLUE)).href}:{}),tracer:{log(scope,message,kind){if(item.logs.length<100)item.logs.push({scope,kind,message:sanitizeEvidence(String(message))});}}});
    disk=await createSyntheticDisk(globalThis.Porthole.VFSUtils.normalizePath);
    const registryBridge=new globalThis.Porthole.GuestRegistryBridge(new globalThis.Porthole.Registry.RegistryStore({vfs:disk.vfs}));
    if(name==='network-test') {
      server=http.createServer((req,res)=>{requestSeen=req.method==='GET'&&req.url==='/'&&req.headers.host==='localhost';res.writeHead(200,{'Content-Type':'text/plain'});res.end('PORTHOLE_NETWORK_OK');});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});port=server.address().port;
      networkBridge=new GuestNetwork({allowedAddresses:['127.0.0.1']});
    }
    const proc=await backend.createProcess({vfs:disk.vfs,registryBridge,networkBridge,...(port?{commandLine:`network-test.exe ${port}`} :{}),path:`C:\\Synthetic\\${name}.exe`,bytes,preload:false});
    if(name==='input-test'){proc.injectKey(16,true);for(const [dx,dy] of [[10,5],[-5,15],[20,-10]])proc.injectRawInput(dx,dy);}
    proc.start(); const result=await proc.done;
    item.result={status:result.status,exitCode:result.exitCode,error:result.error,instructions:result.instructions,stdout:sanitizeEvidence(proc.output),volatileWrites:result.volatileWrites,flushError:result.flushError};
    item.status=result.status==='exited' && result.exitCode===0 && !result.flushError && proc.output.includes('SUCCESS')?'PASS':'GUEST_FAILURE';
    if(name==='thread-validation' && result.status==='exited' && proc.output.split('WORKER_DONE').length-1!==3) item.status='INCOMPLETE_THREAD_EXECUTION';
    if(item.status==='PASS') item.hostEvidence=await verifySyntheticOutputs(name,disk,globalThis.Porthole.Registry.RegistryStore);
    if(name==='network-test' && item.status==='PASS') {if(!requestSeen || networkBridge.evidence.connections!==1 || !proc.output.includes('PORTHOLE_NETWORK_OK'))item.status='NETWORK_NOT_VALIDATED';else item.guestContract={kind:'real-node-loopback-http',requestSeen,...networkBridge.evidence};}
    if(name==='thread-validation' && item.status==='PASS') item.guestContract={workers:3,loopsPerWorker:10,tlsAssertions:30,completedMarkers:3};
    if(name==='input-test' && item.status==='PASS') {if(proc.output.split('RAW_DELTA_VERIFIED').length-1!==3)item.status='INPUT_NOT_VALIDATED';else item.guestContract={kind:'synthetic-injected-raw-input',events:3,deltas:[[10,5],[-5,15],[20,-10]],physicalInputValidated:false};} // Never credit a headless run as physical input.
  }catch(e){item.status='LOAD_OR_BACKEND_FAILURE';item.error=sanitizeEvidence(e.message);}
  finally {if(networkBridge)networkBridge.close();if(server)await new Promise(resolve=>server.close(resolve));if(disk)await disk.close();}
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
