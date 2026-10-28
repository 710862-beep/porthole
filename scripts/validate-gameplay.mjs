/** Fail-closed gameplay evidence evaluation. Presents alone never prove a game loop. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function validateGameplay(report={}) {
 const m=report.gameplayMeasurements||{};
 const frames=Array.isArray(m.frames)?m.frames:[];
 const valid=frames.filter(f=>Number.isFinite(f.timeMs)&&f.timeMs>=0&&f.timeMs<=5000&&/^[0-9a-f]{8}$/.test(f.hash||''));
 let changes=0;for(let i=1;i<valid.length;i++)if(valid[i].hash!==valid[i-1].hash)changes++;
 const guestReads=Array.isArray(m.guestKeyReads)?m.guestKeyReads:[];
 const inputProcessed=guestReads.some(r=>r.key===m.injectedKey&&r.state!==0&&r.afterInjection===true);
 // This witness must come from calibrated guest instrumentation, not an RAF/timer hook.
 // Current runner deliberately supplies none until DOOM's actual loop is identified.
 const loop=m.loopEvidence;
 const gameLoopRunning=loop?.kind==='verified-doom-loop-pc'&&loop.peSha256===report.sha256&&/^[0-9a-f]{64}$/.test(loop.peSha256||'')&&Number.isInteger(loop.pc)&&loop.pc>0&&Array.isArray(loop.samples)&&loop.samples.length>=100&&loop.samples.every((s,i)=>Number.isFinite(s.timeMs)&&s.timeMs>=0&&s.timeMs<=5000&&s.pc===loop.pc&&(i===0||s.instructions>loop.samples[i-1].instructions));
 const checks={windowCreated:report.windows>0,observationComplete:m.durationMs>=5000&&m.durationMs<=5500,presentsMade:valid.length,framesRendered:valid.length,changedFrames:changes,inputProcessed,gameLoopRunning:Boolean(gameLoopRunning),noBackendFailure:!report.error&&!report.causalImport,realBrowser:report.environment==='real-headless-chromium'};
 const passed=checks.windowCreated&&checks.observationComplete&&checks.presentsMade>=100&&checks.framesRendered>=100&&changes>=99&&inputProcessed&&gameLoopRunning&&checks.noBackendFailure&&checks.realBrowser;
 return {passed:Boolean(passed),checks,kind:'measured-gameplay-not-startup',message:passed?'Gameplay functional':'Gameplay not functional or evidence incomplete'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 let report;try{report=JSON.parse(fs.readFileSync(process.argv[2]||'artifacts/doom95-browser.json'));}catch{report={};}
 const result=validateGameplay(report);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/gameplay-validation.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));process.exitCode=result.passed?0:1;
}
