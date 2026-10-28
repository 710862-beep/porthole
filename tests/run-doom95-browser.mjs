// Real Chromium DOM/Canvas, not a fake renderer. A startup window is NOT gameplay.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import {chromium} from 'playwright';import {createRequire} from 'node:module';
createRequire(import.meta.url)('../shims/api-logger.js');
const root=process.cwd();const server=http.createServer((req,res)=>{
 try{const uri=decodeURIComponent(new URL(req.url,'http://test').pathname);const allowed=uri==='/tests/doom95-browser.html'||uri==='/tests/assets/games/doom95.exe'||uri.startsWith('/js/')||uri.startsWith('/artifacts/wasm-candidate/');if(!allowed||uri.split('/').some(part=>part.startsWith('.'))){res.writeHead(403).end();return;}const file=path.resolve(root,'.'+uri);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}const bytes=fs.readFileSync(file);res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':/\.(m?js)$/.test(file)?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(bytes);}catch{res.writeHead(404).end();}
});
let browser;try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/tests/doom95-browser.html`);
 const wasm=process.env.PORTHOLE_WASM||'artifacts/wasm-candidate/retrowin32.wasm';const glue=process.env.PORTHOLE_GLUE||'artifacts/wasm-candidate/glue.mjs';
 const result=await page.evaluate(async({wasm,glue})=>{
  const logs=[];const backend=new Porthole.Retrowin32Backend({wasmURL:'/'+wasm,moduleURL:new URL('/'+glue,location.href).href,tracer:{log(scope,message,kind){logs.push({scope,message:String(message),kind});if(logs.length>200)logs.shift();}}});let proc;
  try{const bytes=new Uint8Array(await (await fetch('/tests/assets/games/doom95.exe')).arrayBuffer());proc=await backend.createProcess({path:'C:\\Tests\\doom95.exe',bytes,preload:false,document});proc.start();let timer;const end=await Promise.race([proc.done,new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout'}),5000);})]);clearTimeout(timer);const snapshot={...end,apiTrace:proc.guestApiTail.slice(),windows:proc.windows.length,presents:proc.presents,executionAttempted:proc.started};if(!proc.finished)await proc.stop('Bounded original game probe');return {...snapshot,logs};}catch(error){return {status:'BACKEND_FAILURE',error:error.message,logs,apiTrace:proc?.guestApiTail||[],executionAttempted:proc?.started||false};}
 },{wasm,glue});
 const logger=new Porthole.ApiLogger();const diagnostic=logger.ingestCrash(result.error||'');if(!diagnostic.last20.length)logger.ingestTail(result.apiTrace||[]);
 const blockedControl=result.logs?.find(item=>item.message.includes('UNSUPPORTED_WINDOW_CLASS'));
 const report={...result,unsupportedControl:blockedControl?.message||null,status:result.status==='exited'&&result.exitCode===0?'PASS':'BACKEND_FAILURE',...diagnostic,lastApi:logger.getLastCall(),last20:logger.getLog(),environment:'real-headless-chromium',gameplayValidated:false};
 fs.writeFileSync('artifacts/doom95-browser.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='PASS'?0:1;
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
