/** Promotion decision only; never copies an unvalidated binary over vendor. */
import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
let sourceEvidence=true;
if(process.argv.includes('--remote')){
 sourceEvidence=false;
 try{const sha=process.env.GITHUB_SHA;if(!/^[0-9a-f]{40}$/.test(sha||''))throw Error('Expected exact GITHUB_SHA');
 const runs=JSON.parse(execFileSync('gh',['run','list','--workflow','rust-wasm-candidate.yml','--commit',sha,'--limit','1','--json','databaseId,headSha,status'],{encoding:'utf8'}));const run=runs[0];if(!run||run.headSha!==sha)throw Error('No candidate run for this source');
 if(run.status!=='completed')spawnSync('gh',['run','watch',String(run.databaseId),'--exit-status','--interval','10'],{stdio:'inherit',timeout:1800000});
 const meta=JSON.parse(execFileSync('gh',['run','view',String(run.databaseId),'--json','status,headSha'],{encoding:'utf8'}));if(meta.status!=='completed'||meta.headSha!==sha)throw Error('Candidate not completed for this source');
 execFileSync('python3',['scripts/download-ci-blobs.py',String(run.databaseId)],{stdio:'inherit',timeout:180000});
 for(const name of ['validation-report.json','gameplay-validation.json','controls-browser.json'])fs.copyFileSync(`artifacts/remote/${run.databaseId}/test-results/${name}`,`artifacts/${name}`);
 sourceEvidence=true;
 }catch(error){console.error('Candidate evidence unavailable:',error.message);}
}
const read=file=>{try{return JSON.parse(fs.readFileSync('artifacts/'+file));}catch{return null;}};
const aggregate=read('validation-report.json'),gameplay=read('gameplay-validation.json'),controls=read('controls-browser.json');
const checks={sourceEvidence,compatibility:aggregate?.promotable===true,gameplay:gameplay?.passed===true,commonControls:controls?.status==='PASS'&&controls?.pixelsValidated===true};
const report={promotable:Object.values(checks).every(Boolean),promoted:false,checks};
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/promotion-check.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.promotable?0:1;
