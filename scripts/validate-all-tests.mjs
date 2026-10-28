/** Compatibility gate; documented failures stay failures, never promotion credit. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function evaluate({synthetic,doom,integrity,regression}) {
 const checks=[];const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
 const names=['thread-validation','input-test','network-test','registry-test','installer-test'];const tests=synthetic?.tests||[];
 check('exactly five distinct required PEs',tests.length===5 && new Set(tests.map(t=>t.name)).size===5 && names.every(n=>tests.some(t=>t.name===n)));
 for(const name of names){const t=tests.find(t=>t.name===name);check(name+' guest exit and flush',t?.status==='PASS' && t.result?.status==='exited' && t.result?.exitCode===0 && !t.result?.flushError && t.backendSha256===integrity?.wasmSha256);}
 const by=name=>tests.find(t=>t.name===name)||{};
 const thread=by('thread-validation');check('three workers and ten loops',thread.guestContract?.workers===3 && thread.guestContract?.loopsPerWorker===10 && thread.result?.stdout?.split('WORKER_DONE').length-1===3);
 const input=by('input-test');check('exact signed injected mouse deltas (NOT physical)',input.guestContract?.kind==='synthetic-injected-raw-input' && input.guestContract?.events===3 && input.guestContract?.physicalInputValidated===false && JSON.stringify(input.guestContract?.deltas)==='[[10,5],[-5,15],[20,-10]]');
 const network=by('network-test');check('real request and response through guest sockets',network.guestContract?.kind==='real-node-loopback-http' && network.guestContract?.requestSeen && network.guestContract?.connections===1 && network.guestContract?.sentBytes>0 && network.guestContract?.receivedBytes>0 && /^HTTP\/1\.[01] 200/.test(network.result?.stdout||'') && network.result.stdout.includes('PORTHOLE_NETWORK_OK'));
 const registry=by('registry-test').hostEvidence;check('registry disk reread',registry?.kind==='node-disk-fresh-registry-store' && registry.tokenBytes===128 && registry.userId===12345);
 const installer=by('installer-test').hostEvidence;check('installer directory/file/metadata disk reread',installer?.kind==='node-disk-fresh-registry-store' && installer.directory===true && installer.testFileBytes===15 && installer.uninstallerMarkerBytes===0 && installer.installPath==='C:\\Program Files\\TestApp');
 check('compiled Wasm and initialized binding',integrity?.status==='INTEGRITY_VALIDATED_NOT_COMPATIBILITY' && integrity.bindingInitialized===true);
 check('JS/DOM and syntax regressions',regression?.passed===true);
 check('DOOM95 actually passed without null import',doom?.status==='PASS' && doom.gameplayValidated===true && doom.executionAttempted===true && doom.exitCode===0 && !doom.causalImport);
 return {status:checks.every(c=>c.pass)?'ALL_GATES_PASSED':'COMPATIBILITY_GATES_FAILED',promotable:checks.every(c=>c.pass),checks};
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const dir=process.argv[2]||'artifacts';const read=file=>{try{return JSON.parse(fs.readFileSync(path.join(dir,file)));}catch{return null;}};
 const result=evaluate({synthetic:read('synthetic-candidate-all.json'),doom:read('doom95-browser.json')||read('doom95-diagnostics.json'),integrity:read('wasm-candidate/integrity.json'),regression:read('candidate-regressions.json')});
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'validation-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));process.exitCode=result.promotable?0:1;
}
