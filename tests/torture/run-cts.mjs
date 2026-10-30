#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
import { fileURLToPath } from 'node:url';import {loadEmulator} from '../wine64/run-wine64.mjs';
const reportPath=process.argv.includes('--report')?process.argv[process.argv.indexOf('--report')+1]:'artifacts/torture/cts-report.json';
const m=JSON.parse(fs.readFileSync('tests/assets/torture/MANIFEST.json','utf8'));const e=m.binaries.find(b=>b.suite==='vk-gl-cts');const b=await loadEmulator(process.env.PORTHOLE_X64_WASM_DIR||'vendor/porthole-x64-wasm');
const r={version:1,kind:'dEQP-VK',status:'NOT_RUN',tests:[]};
if(!e||!b.available)r.error=b.reason||'deqp-vk.exe not built';else{
 const emu=new b.module.BrowserX64Emulator(16384);emu.vfs_mkdir('C:\\Game');emu.vfs_insert(`C:\\Game\\${e.name}`,new Uint8Array(fs.readFileSync(e.path)));emu.set_command_line([e.name,...e.args].join(' '));emu.enable_api_audit(100000);const audit=[];let terminal=null;const start=Date.now();const t={name:'info+api',sha256:e.sha256,sourceRevision:e.sourceRevision,status:'NOT_RUN'};r.tests.push(t);
 try{t.load=JSON.parse(emu.load_pe(new Uint8Array(fs.readFileSync(e.path))));for(let n=0;n<2000&&Date.now()-start<600000;n++){const s=emu.run_slice(250000);const a=emu.take_api_audit();if(a)audit.push(...a.split('\n').filter(Boolean).map(JSON.parse));if(s==='next')continue;if(s.startsWith('page-fault:')){emu.supply_page(BigInt(Number(s.slice(11))),new Uint8Array(4096));continue;}terminal=s;break;}
 t.console=emu.take_console();t.terminal=terminal;t.instructions=Number(emu.instructions_executed());t.faultSnapshot=emu.fault_snapshot();t.apiAuditCount=audit.length;t.apiAudit=audit.slice(-500);t.qpa=emu.vfs_read('C:\\Game\\cts.qpa');
 const rawDir=path.join(path.dirname(reportPath),'cts');fs.mkdirSync(rawDir,{recursive:true});fs.writeFileSync(path.join(rawDir,`${t.name}.api.jsonl`),audit.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const results=[...t.console.matchAll(/Test case .*?: (Pass|Fail|NotSupported|InternalError|QualityWarning|CompatibilityWarning|ResourceError|Timeout)/g)];t.results=results.map(x=>x[1]);t.status=terminal==='exit:0'&&results.length>0&&results.every(x=>x[1]==='Pass')?'PASS':terminal?.startsWith('fault:')?'GUEST_FAULT':!terminal?'TIMEOUT':'FAIL';
 }catch(err){t.status='BACKEND_ERROR';t.error=String(err);}
 r.status=r.tests.every(t=>t.status==='PASS')?'PASS':'FAIL';
}
fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(r,null,2)+'\n');process.exitCode=r.status==='PASS'?0:r.status==='NOT_RUN'?2:1;
