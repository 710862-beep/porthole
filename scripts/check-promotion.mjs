/** Promotion decision only; never copies an unvalidated binary over vendor. */
import fs from 'node:fs';
const read=file=>{try{return JSON.parse(fs.readFileSync('artifacts/'+file));}catch{return null;}};
const aggregate=read('validation-report.json'),gameplay=read('gameplay-validation.json'),controls=read('controls-browser.json');
const checks={compatibility:aggregate?.promotable===true,gameplay:gameplay?.passed===true,commonControls:controls?.status==='PASS'&&controls?.pixelsValidated===true};
const report={promotable:Object.values(checks).every(Boolean),promoted:false,checks};
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/promotion-check.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.promotable?0:1;
