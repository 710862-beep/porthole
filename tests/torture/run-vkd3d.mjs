#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEmulator } from '../wine64/run-wine64.mjs';
const reportPath=process.argv.includes('--report')?process.argv[process.argv.indexOf('--report')+1]:'artifacts/torture/vkd3d-report.json';
const manifest=JSON.parse(fs.readFileSync('tests/assets/torture/MANIFEST.json','utf8'));
const entry=manifest.binaries.find(b=>b.suite==='vkd3d-proton');
const binding=await loadEmulator(process.env.PORTHOLE_X64_WASM_DIR||'vendor/porthole-x64-wasm');
const report={version:1,kind:'vkd3d-proton-internal',status:'NOT_RUN',sourceRevision:entry?.sourceRevision,tests:[]};
if(!entry||!binding.available)report.error=binding.reason||'vkd3d-proton fixture not built';
else{
 report.wasmSha256=binding.wasmSha256;
 const all=fs.readFileSync(entry.path,'utf8'); // enumerate names from upstream header, not a synthetic list
 const names=[...fs.readFileSync('tests/upstream/vkd3d-proton/tests/d3d12_tests.h','utf8').matchAll(/^decl_test\((\w+)\)/gm)].map(m=>m[1]);
 const selected=names.filter(n=>/root_signature|descriptor|pipeline|pso/.test(n));
 for(const name of selected){
  const emu=new binding.module.BrowserX64Emulator(4096);emu.vfs_mkdir('C:\\Game');emu.vfs_insert(`C:\\Game\\${entry.name}`,new Uint8Array(fs.readFileSync(entry.path)));
  emu.set_command_line(entry.name);for(const[k,v]of Object.entries({...entry.env,VKD3D_TEST_MATCH:name}))emu.set_environment_variable(k,v);
  emu.enable_api_audit(100000);const audit=[];const start=Date.now();let terminal=null;
  const item={name,status:'NOT_RUN',sha256:entry.sha256};report.tests.push(item);
  try{emu.load_pe(new Uint8Array(fs.readFileSync(entry.path)));
   for(let n=0;n<400&&Date.now()-start<120000;n++){const s=emu.run_slice(250000);const a=emu.take_api_audit();if(a)audit.push(...a.split('\n').filter(Boolean).map(JSON.parse));if(s==='next')continue;if(s.startsWith('page-fault:')){emu.supply_page(BigInt(Number(s.slice(11))),new Uint8Array(4096));continue;}terminal=s;break;}
   item.console=emu.take_console();item.terminal=terminal;item.instructions=Number(emu.instructions_executed());item.apiAudit=audit;item.faultSnapshot=emu.fault_snapshot();
   const m=/(\d+) tests executed \((\d+) failures, (\d+) successful todo, (\d+) skipped/.exec(item.console);
   item.summary=m?{executed:+m[1],failures:+m[2],todoSuccesses:+m[3],skipped:+m[4]}:null;
   item.status=terminal==='exit:0'&&m&&+m[1]>0&&+m[2]===0&&+m[3]===0?'PASS':terminal?.startsWith('fault:')?'GUEST_FAULT':!terminal?'TIMEOUT':'FAIL';
  }catch(e){item.status='BACKEND_ERROR';item.error=String(e);}
  fs.mkdirSync('artifacts/torture/vkd3d',{recursive:true});fs.writeFileSync(`artifacts/torture/vkd3d/${name}.json`,JSON.stringify(item,null,2)+'\n');
 }
 report.status=report.tests.length&&report.tests.every(t=>t.status==='PASS')?'PASS':'FAIL';
}
fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');process.exitCode=report.status==='PASS'?0:report.status==='NOT_RUN'?2:1;
