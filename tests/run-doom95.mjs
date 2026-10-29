// Dedicated original PE probe: never treats a documented crash as a PASS.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
createRequire(import.meta.url)('../shims/api-logger.js');
const run=spawnSync(process.execPath,['scripts/probe-test-assets.mjs'],{env:{...process.env,PORTHOLE_PROBE_ONLY:'doom95.exe'},encoding:'utf8',timeout:30000,maxBuffer:4194304});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
const probe=JSON.parse(fs.readFileSync('artifacts/doom95-candidate.json'));const item=probe.tests[0];
const logger=new globalThis.Porthole.ApiLogger();const diagnostic=logger.ingestCrash(item?.error||run.error?.message||'No DOOM95 PE in manifest');
if(!diagnostic.last20.length && item?.apiTrace){logger.ingestTail(item.apiTrace);diagnostic.last20=logger.getLog();diagnostic.lastApi=logger.getLastCall();}
console.log('[CRASH]',item?.error||'none');console.log('[CAUSAL_IMPORT]',diagnostic.causalImport);console.log('[LAST20_API]',JSON.stringify(diagnostic.last20));
fs.writeFileSync('artifacts/doom95-diagnostics.json',JSON.stringify({status:item?.status||'ACQUISITION_FAILED',sha256:item?.sha256,exitCode:item?.exitCode??null,executionAttempted:item?.executionAttempted===true,windows:item?.windows??0,presents:item?.presents??0,...diagnostic},null,2)+'\n');
process.exitCode=run.status===0 && item?.status==='PASS'?0:1;
